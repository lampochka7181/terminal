#!/usr/bin/env node
/**
 * Load Test Runner
 *
 * Authenticates 50 wallets, picks an active market, and submits
 * signed $5 market orders at 7 tx/s through the real HTTP API.
 *
 * Usage:
 *   pnpm --filter @degen/loadtest run
 *   # or from repo root:
 *   npx tsx apps/loadtest/src/run.ts
 *
 * Optional args:
 *   --orders 500        Total orders to submit (default: unlimited until Ctrl+C)
 *   --duration 60       Duration in seconds (default: 60)
 *   --rate 7            Orders per second (default: from env/7)
 */

import { config } from './config.js';
import { loadWallets, type LoadedWallet } from './wallet.js';
import { authenticateAll } from './auth.js';
import { submitMarketOrder, fetchOpenMarkets, type Market, type OrderResult } from './order.js';
import { RateLimiter } from './rate-limiter.js';

// ─── Parse CLI args ─────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let totalOrders = Infinity;
  let durationSec = 60;
  let rate = config.ratePerSec;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--orders' && args[i + 1]) totalOrders = parseInt(args[++i]);
    if (args[i] === '--duration' && args[i + 1]) durationSec = parseInt(args[++i]);
    if (args[i] === '--rate' && args[i + 1]) rate = parseInt(args[++i]);
  }

  return { totalOrders, durationSec, rate };
}

// ─── Metrics ────────────────────────────────────────────────────────────────

interface Metrics {
  submitted: number;
  succeeded: number;
  failed: number;
  totalFills: number;
  latencies: number[];
  errors: string[];
  startTime: number;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function printMetrics(m: Metrics, final: boolean = false) {
  const elapsed = (Date.now() - m.startTime) / 1000;
  const rate = m.submitted / Math.max(elapsed, 0.1);
  const label = final ? 'FINAL' : 'LIVE';

  console.log('');
  console.log(`── ${label} METRICS (${elapsed.toFixed(1)}s elapsed) ──`);
  console.log(`  Orders:     ${m.submitted} submitted, ${m.succeeded} ok, ${m.failed} failed`);
  console.log(`  Rate:       ${rate.toFixed(1)} orders/sec`);
  console.log(`  Fills:      ${m.totalFills}`);

  if (m.latencies.length > 0) {
    const avg = m.latencies.reduce((a, b) => a + b, 0) / m.latencies.length;
    console.log(`  Latency:    p50=${percentile(m.latencies, 50)}ms  p95=${percentile(m.latencies, 95)}ms  p99=${percentile(m.latencies, 99)}ms  avg=${avg.toFixed(0)}ms`);
  }

  if (m.errors.length > 0) {
    const unique = [...new Set(m.errors.slice(-5))];
    console.log(`  Errors (last ${unique.length}):`);
    for (const e of unique) {
      console.log(`    - ${e.slice(0, 120)}`);
    }
  }

  if (final) {
    console.log('');
    const successRate = m.submitted > 0 ? ((m.succeeded / m.submitted) * 100).toFixed(1) : '0';
    const fillRate = m.succeeded > 0 ? (m.totalFills / m.succeeded).toFixed(2) : '0';
    console.log(`  Success rate:     ${successRate}%`);
    console.log(`  Avg fills/order:  ${fillRate}`);
    console.log(`  Total duration:   ${elapsed.toFixed(1)}s`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { totalOrders, durationSec, rate } = parseArgs();

  console.log('');
  console.log('==========================================================');
  console.log('  LOAD TEST');
  console.log('==========================================================');
  console.log(`  API:          ${config.apiUrl}`);
  console.log(`  Rate:         ${rate} orders/sec`);
  console.log(`  Duration:     ${durationSec}s`);
  console.log(`  Max orders:   ${totalOrders === Infinity ? 'unlimited' : totalOrders}`);
  console.log(`  $/order:      $${config.dollarPerOrder}`);
  console.log('==========================================================');

  // Step 1: Load wallets
  console.log('\n-- Step 1: Loading wallets --');
  const wallets = loadWallets();
  if (wallets.length === 0) {
    console.error('No wallets found. Run setup first: pnpm --filter @degen/loadtest setup');
    process.exit(1);
  }

  // Step 2: Authenticate all wallets
  console.log(`\n-- Step 2: Authenticating ${wallets.length} wallets --`);
  const tokens = await authenticateAll(wallets, config.apiUrl);
  if (tokens.size === 0) {
    console.error('No wallets authenticated. Is the API running?');
    process.exit(1);
  }

  // Build array of authenticated wallets, splitting the cohort 50/50 by
  // outcome. The split key is the wallet's ORIGINAL index in `wallets`, not
  // its position in `authedWallets`, so a few auth failures don't lopsidedly
  // tilt the YES/NO distribution. First half buys YES, second half buys NO.
  const half = Math.ceil(wallets.length / 2);
  const authedWallets: { wallet: LoadedWallet; jwt: string; outcome: 'yes' | 'no' }[] = [];
  let yesCount = 0;
  let noCount = 0;
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const jwt = tokens.get(w.pubkey);
    if (!jwt) continue;
    const outcome: 'yes' | 'no' = i < half ? 'yes' : 'no';
    authedWallets.push({ wallet: w, jwt, outcome });
    if (outcome === 'yes') yesCount++; else noCount++;
  }
  console.log(`  ${authedWallets.length} wallets ready for orders (${yesCount} YES, ${noCount} NO)`);

  // Step 3: Select active market (refreshed throughout the test)
  console.log('\n-- Step 3: Selecting active market --');

  async function selectActiveMarket(verbose: boolean = false): Promise<Market | null> {
    const allMarkets = await fetchOpenMarkets(config.apiUrl);
    const now = Date.now();
    // Must have strike price set (activated) AND at least 30s remaining
    const viable = allMarkets.filter(m => m.strike > 0 && m.expiry - now > 30_000);

    if (verbose) {
      console.log(`  All ${allMarkets.length} open markets:`);
      for (const m of allMarkets) {
        const remaining = Math.round((m.expiry - now) / 1000);
        const activated = m.strike > 0;
        const hasLiquidity = m.yesPrice !== null && m.yesPrice > 0;
        const viable30 = m.expiry - now > 30_000;
        const flags = [
          activated ? '✅ activated' : '❌ strike=0',
          viable30 ? `${remaining}s left` : '❌ expiring',
          hasLiquidity ? `yes=${m.yesPrice}` : '❌ no quotes',
        ].join(', ');
        console.log(`    ${m.asset}-${m.timeframe} id=${m.id.slice(0, 8)} strike=${m.strike} addr=${m.address.slice(0, 16)}... [${flags}]`);
      }
      console.log(`  Filtered to ${viable.length} viable (strike>0 + >30s remaining)`);
    }

    if (viable.length === 0) return null;

    // Further prefer markets WITH liquidity (yesPrice set = MM is quoting)
    const withLiquidity = viable.filter(m => m.yesPrice !== null && m.yesPrice > 0);
    const pool = withLiquidity.length > 0 ? withLiquidity : viable;

    // Prefer BTC 5m, then any BTC, then anything
    return pool.find(m => m.asset === 'BTC' && m.timeframe === '5m')
      || pool.find(m => m.asset === 'BTC')
      || pool[0];
  }

  // Wait for an active market (activated markets may not exist yet during cycle transitions)
  let market: Market | null = null;
  const marketWaitDeadline = Date.now() + 120_000; // wait up to 2 minutes
  let firstAttempt = true;
  while (!market && Date.now() < marketWaitDeadline) {
    market = await selectActiveMarket(firstAttempt);
    firstAttempt = false;
    if (!market) {
      const waitSec = Math.round((marketWaitDeadline - Date.now()) / 1000);
      console.log(`  ⏳ No active market yet (waiting for keeper to activate). Retrying... (${waitSec}s remaining)`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  if (!market) {
    console.error('No viable market found after 2 minutes. Is the backend running?');
    process.exit(1);
  }
  let marketExpiry = market.expiry;
  let lastMarketRefresh = Date.now();
  const MARKET_REFRESH_INTERVAL = 10_000; // Re-check market every 10s
  const MARKET_MIN_REMAINING = 15_000;    // Refresh if <15s remaining

  console.log(`  >> Selected: ${market.asset}-${market.timeframe} id=${market.id} addr=${market.address} expires in ${Math.round((marketExpiry - Date.now()) / 1000)}s`);

  // Step 4: Run the load test
  console.log(`\n-- Step 4: Submitting orders at ${rate}/s --`);
  console.log('  Press Ctrl+C to stop early\n');

  const limiter = new RateLimiter(rate);
  const metrics: Metrics = {
    submitted: 0,
    succeeded: 0,
    failed: 0,
    totalFills: 0,
    latencies: [],
    errors: [],
    startTime: Date.now(),
  };

  const deadline = Date.now() + durationSec * 1000;
  let orderIndex = 0;
  let running = true;
  let metricsInterval: ReturnType<typeof setInterval>;

  // Print metrics every 5 seconds
  metricsInterval = setInterval(() => {
    if (running) printMetrics(metrics);
  }, 5000);

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    running = false;
    console.log('\n\n  Stopping...');
  });

  // In-flight tracking for concurrency
  const maxInFlight = Math.min(rate * 3, 50);
  const inFlight = new Set<Promise<void>>();

  while (running && orderIndex < totalOrders && Date.now() < deadline) {
    // ── Refresh market if expiring soon or on schedule ──
    const timeToExpiry = marketExpiry - Date.now();
    const timeSinceRefresh = Date.now() - lastMarketRefresh;
    if (timeToExpiry < MARKET_MIN_REMAINING || timeSinceRefresh > MARKET_REFRESH_INTERVAL) {
      // Wait for in-flight to drain before switching markets
      if (inFlight.size > 0 && timeToExpiry < MARKET_MIN_REMAINING) {
        await Promise.allSettled([...inFlight]);
      }
      const newMarket = await selectActiveMarket(false);
      lastMarketRefresh = Date.now();
      if (newMarket) {
        if (newMarket.id !== market!.id) {
          console.log(`  🔄 Market switch: ${newMarket.asset}-${newMarket.timeframe} id=${newMarket.id.slice(0, 8)} addr=${newMarket.address.slice(0, 16)}... expires ${Math.round((newMarket.expiry - Date.now()) / 1000)}s`);
        }
        market = newMarket;
        marketExpiry = newMarket.expiry;
      } else if (timeToExpiry < MARKET_MIN_REMAINING) {
        // No market available — wait for keeper to activate the next one
        console.log('  ⏳ Market expired, waiting for next activated market...');
        let waitedMs = 0;
        while (!newMarket && waitedMs < 60_000 && running && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 3000));
          waitedMs += 3000;
          const retry = await selectActiveMarket(false);
          if (retry) {
            market = retry;
            marketExpiry = retry.expiry;
            console.log(`  🔄 New market: ${retry.asset}-${retry.timeframe} id=${retry.id.slice(0, 8)} expires ${Math.round((retry.expiry - Date.now()) / 1000)}s`);
            break;
          }
        }
        if (!market || marketExpiry - Date.now() < MARKET_MIN_REMAINING) continue;
      }
    }

    // Wait for rate limiter
    await limiter.acquire();

    if (!running || Date.now() >= deadline) break;

    // Wait if too many in-flight
    while (inFlight.size >= maxInFlight) {
      await Promise.race([...inFlight]);
    }

    // Pick wallet round-robin (carries its assigned YES/NO outcome)
    const { wallet, jwt, outcome } = authedWallets[orderIndex % authedWallets.length];
    const idx = orderIndex++;
    const currentMarket = market!;

    const promise = submitMarketOrder(
      wallet.keypair, jwt, currentMarket, config.dollarPerOrder, config.apiUrl, idx, outcome,
    ).then((result: OrderResult) => {
      metrics.submitted++;
      if (result.success) {
        metrics.succeeded++;
        metrics.totalFills += result.fills;
      } else {
        metrics.failed++;
        if (metrics.errors.length < 100) {
          metrics.errors.push(result.error || 'unknown');
        }
      }
      metrics.latencies.push(result.latencyMs);
    }).finally(() => {
      inFlight.delete(promise);
    });

    inFlight.add(promise);
  }

  // Wait for remaining in-flight orders
  if (inFlight.size > 0) {
    console.log(`  Waiting for ${inFlight.size} in-flight orders to complete...`);
    await Promise.allSettled([...inFlight]);
  }

  running = false;
  clearInterval(metricsInterval);

  // Final report
  printMetrics(metrics, true);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
