/**
 * Performance Test Routes
 *
 * Only available when PERF_TEST_MODE=true.
 * 
 * Two test modes:
 *   /start          — Redis-only matching test (no DB, no on-chain)
 *   /full-pipeline  — Full pipeline test (matching → DB → on-chain → settlement)
 *
 * Supports multi-user testing: loads test wallets from scripts/test-wallets.json
 */

import { FastifyInstance } from 'fastify';
import { matchingService } from '../services/matching.service.js';
import { marketService } from '../services/market.service.js';
import { userService } from '../services/user.service.js';
import { positionService } from '../services/position.service.js';
import { orderbookService } from '../services/orderbook.service.js';
import { mmBotV2 } from '../bot/mm-bot-v2.js';
import { stopKeeperJobs } from '../jobs/index.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { markets, settlements, users } from '../db/schema.js';
import { redis, RedisKeys } from '../db/redis.js';
import { drainAllQueues } from '../queue/queues.js';
import { writeBehindService } from '../services/write-behind.service.js';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { priceFeedService } from '../services/price-feed.service.js';
import { anchorClient, getMarketV2Pda } from '../lib/anchor-client.js';
import { deriveMarketPda } from '../jobs/market-creator.js';
import { positionSettlerJob } from '../jobs/position-settler.js';
import { PublicKey } from '@solana/web3.js';

// ─── In-memory test state ────────────────────────────────────────────────────

interface PerfTestState {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'monitoring';
  startedAt: number;
  completedAt?: number;
  config: { orderCount: number; durationMs: number; dollarPerOrder: number; marketId: string };
  metrics: {
    ordersSubmitted: number;
    ordersMatched: number;
    ordersFailed: number;
    fillsTotal: number;
    latencies: number[];           // ms per order (API → match complete)
    matchLatencies: number[];      // ms per order (match engine only)
    errors: string[];
  };
}

interface FullPipelineState extends PerfTestState {
  mode: 'full-pipeline';
  marketExpiry: number;     // Unix timestamp of market expiry
  orderIds: string[];       // DB order IDs for tracking
  userWallets: Map<string, string>; // userId → walletAddress
  timeline: {
    orderSubmissionStart: number;
    orderSubmissionEnd?: number;
    marketClosed?: number;
    settlementStart?: number;
    settlementEnd?: number;
    perUserPayout: Map<string, number>; // userId → payout timestamp
  };
  onChainMetrics: {
    confirmed: number;
    failed: number;
    pending: number;
    avgConfirmTimeMs: number;
  };
}

const activeTests = new Map<string, PerfTestState | FullPipelineState>();

// ─── Wallet loader ───────────────────────────────────────────────────────────

interface TestWallet {
  pubkey: string;
  secretKey: string;
}

function loadTestWallets(): TestWallet[] {
  const paths = [
    resolve(process.cwd(), 'scripts', 'test-wallets.json'),
    resolve(process.cwd(), '..', '..', 'scripts', 'test-wallets.json'),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf8'));
        logger.info(`[PERF] Loaded ${data.length} test wallets from ${p}`);
        return data;
      } catch (err: any) {
        logger.warn(`[PERF] Failed to parse ${p}: ${err.message}`);
      }
    }
  }

  logger.warn('[PERF] No test-wallets.json found');
  return [];
}

// ─── Route Registration ──────────────────────────────────────────────────────

export async function perfRoutes(app: FastifyInstance) {
  if (!config.perfTestMode) {
    return;
  }

  const testWallets = loadTestWallets();
  logger.info(`[PERF] Performance test routes enabled (${testWallets.length} wallets)`);

  // ─── POST /start — Redis-only matching test ──────────────────────────
  app.post('/start', async (request, reply) => {
    const body = request.body as any;
    const orderCount = body.orderCount || 2000;
    const durationMs = body.durationMs || 120_000;
    const dollarPerOrder = body.dollarPerOrder || 25;

    const walletAddresses = testWallets.length > 0
      ? testWallets.map(w => w.pubkey)
      : [body.walletAddress || 'perf-test-default-wallet'];

    // Resolve wallet addresses to user UUIDs (required for position tracking)
    const userIds: string[] = [];
    for (const walletAddr of walletAddresses) {
      const user = await userService.getOrCreate(walletAddr);
      userIds.push(user.id);
    }
    logger.info(`[PERF] Resolved ${userIds.length} user UUIDs from wallet addresses`);

    // Find active market
    let marketId = body.marketId;
    if (!marketId || marketId === 'auto') {
      const activeMarkets = await db.select().from(markets).where(eq(markets.status, 'OPEN')).limit(20);
      if (activeMarkets.length === 0) {
        return reply.code(400).send({ error: 'No active markets found.' });
      }
      const btc5m = activeMarkets.find(m => m.asset === 'BTC' && m.timeframe === '5m' && parseFloat(m.strikePrice) > 0);
      const anyActivated = activeMarkets.find(m => parseFloat(m.strikePrice) > 0);
      const market = btc5m || anyActivated || activeMarkets[0];
      marketId = market.id;
    }

    const market = await marketService.getById(marketId);
    if (!market) return reply.code(404).send({ error: `Market ${marketId} not found` });

    const testId = `perf-redis-${Date.now()}`;
    const state: PerfTestState = {
      id: testId, status: 'running', startedAt: Date.now(),
      config: { orderCount, durationMs, dollarPerOrder, marketId },
      metrics: { ordersSubmitted: 0, ordersMatched: 0, ordersFailed: 0, fillsTotal: 0, latencies: [], matchLatencies: [], errors: [] },
    };
    activeTests.set(testId, state);

    // Stop MM bot + keepers for clean Redis-only test
    await mmBotV2.stop();
    stopKeeperJobs();
    await seedOrderbookForPerfTest(marketId);

    runRedisOnlyPerfTest(state, userIds, market).catch(err => {
      state.status = 'failed';
      state.metrics.errors.push(err.message);
    });

    return reply.send({ testId, status: 'running', config: state.config, users: userIds.length });
  });

  // ─── POST /full-pipeline — Full E2E test ─────────────────────────────
  app.post('/full-pipeline', async (request, reply) => {
    const body = request.body as any;
    const orderCount = body.orderCount || 200;
    const durationMs = body.durationMs || 60_000;     // 1 minute default
    const dollarPerOrder = body.dollarPerOrder || 25;
    const concurrency = Math.min(body.concurrency || 50, 500); // high concurrency OK with write-behind
    const preferredTimeframe = body.preferredTimeframe || '5m';
    const pacePerSec = body.pacePerSec || 0; // 0 = burst mode, >0 = sustained pacing (orders/sec)

    if (testWallets.length === 0) {
      return reply.code(400).send({ error: 'No test wallets found. Run: node scripts/setup-full-pipeline-test.mjs' });
    }

    // Step 0: Drain stale BullMQ jobs from previous test runs
    logger.info(`[PERF:FULL] Draining stale BullMQ jobs from previous runs...`);
    try {
      const { drained } = await drainAllQueues();
      const total = Object.values(drained).reduce((a, b) => a + b, 0);
      if (total > 0) {
        logger.info(`[PERF:FULL] Drained ${total} stale jobs: ${JSON.stringify(drained)}`);
      } else {
        logger.info(`[PERF:FULL] Queues already clean`);
      }
    } catch (err: any) {
      logger.warn(`[PERF:FULL] Queue drain failed (non-fatal): ${err.message}`);
    }

    // Step 1: Batch-register test users in DB with minimal queries
    logger.info(`[PERF:FULL] Batch-registering ${testWallets.length} test wallets as DB users...`);
    const userMap = new Map<string, string>();  // walletAddress → userId
    const walletMap = new Map<string, string>(); // userId → walletAddress

    try {
      const walletAddresses = testWallets.map(w => w.pubkey);

      // Single INSERT with ON CONFLICT (upsert-style, returns all rows)
      const values = testWallets.map(w => ({ walletAddress: w.pubkey }));
      await db.insert(users)
        .values(values)
        .onConflictDoNothing({ target: users.walletAddress });

      // Fetch all user IDs in one query
      const allUsers = await db.select({ id: users.id, walletAddress: users.walletAddress })
        .from(users)
        .where(inArray(users.walletAddress, walletAddresses));

      for (const row of allUsers) {
        userMap.set(row.walletAddress, row.id);
        walletMap.set(row.id, row.walletAddress);
      }
      logger.info(`[PERF:FULL] Batch-registered ${userMap.size} users in 2 queries`);
    } catch (err: any) {
      logger.warn(`[PERF:FULL] Batch registration failed, falling back to sequential: ${err.message}`);
      for (const w of testWallets) {
        try {
          const user = await userService.getOrCreate(w.pubkey);
          userMap.set(w.pubkey, user.id);
          walletMap.set(user.id, w.pubkey);
        } catch (err2: any) {
          logger.warn(`[PERF:FULL] Failed to register user ${w.pubkey.slice(0, 12)}: ${err2.message}`);
        }
      }
      logger.info(`[PERF:FULL] Sequential fallback registered ${userMap.size} users`);
    }

    if (userMap.size === 0) {
      return reply.code(500).send({ error: 'Failed to register any test users in DB' });
    }

    // Step 2: Find an active market matching preferred timeframe
    let marketId = body.marketId;
    if (!marketId || marketId === 'auto') {
      const activeMarkets = await db.select().from(markets).where(eq(markets.status, 'OPEN')).limit(50);
      if (activeMarkets.length === 0) {
        return reply.code(400).send({ error: 'No active markets. Start the server and wait for markets to open.' });
      }
      // Priority: BTC with preferred timeframe → BTC any timeframe → any activated market
      const btcPreferred = activeMarkets.find(m => m.asset === 'BTC' && m.timeframe === preferredTimeframe && parseFloat(m.strikePrice) > 0);
      const btc5m = activeMarkets.find(m => m.asset === 'BTC' && m.timeframe === '5m' && parseFloat(m.strikePrice) > 0);
      const anyActivated = activeMarkets.find(m => parseFloat(m.strikePrice) > 0);
      const market = btcPreferred || btc5m || anyActivated || activeMarkets[0];
      marketId = market.id;
      logger.info(`[PERF:FULL] Selected market: ${market.asset}-${market.timeframe} strike=${market.strikePrice} id=${market.id} expiry=${market.expiryAt}`);
    }

    const market = await marketService.getById(marketId);
    if (!market) return reply.code(404).send({ error: `Market ${marketId} not found` });

    // Verify market has time remaining for orders + on-chain execution
    const expiryTs = new Date(market.expiryAt).getTime();
    const remainingMs = expiryTs - Date.now();
    if (remainingMs < 60_000) {
      return reply.code(400).send({
        error: `Market expires in ${Math.round(remainingMs / 1000)}s — need at least 60s. Wait for next market.`,
      });
    }

    const testId = `perf-full-${Date.now()}`;
    const state: FullPipelineState = {
      id: testId,
      status: 'running',
      startedAt: Date.now(),
      mode: 'full-pipeline',
      config: { orderCount, durationMs, dollarPerOrder, marketId },
      metrics: { ordersSubmitted: 0, ordersMatched: 0, ordersFailed: 0, fillsTotal: 0, latencies: [], matchLatencies: [], errors: [] },
      marketExpiry: expiryTs,
      orderIds: [],
      userWallets: walletMap,
      timeline: {
        orderSubmissionStart: Date.now(),
        perUserPayout: new Map(),
      },
      onChainMetrics: { confirmed: 0, failed: 0, pending: 0, avgConfirmTimeMs: 0 },
    };
    activeTests.set(testId, state);

    // NOTE: MM bot + keepers stay running for full pipeline!
    // The MM bot provides natural liquidity — no synthetic seeding needed
    logger.info(`[PERF:FULL] Starting full pipeline test: ${orderCount} orders, $${dollarPerOrder} each, market expiry in ${Math.round(remainingMs / 1000)}s`);

    // Fire the test in background
    runFullPipelineTest(state, testWallets, userMap, market, concurrency, pacePerSec).catch(err => {
      state.status = 'failed';
      state.metrics.errors.push(err.message);
      logger.error(`[PERF:FULL] Test ${testId} failed: ${err.message}`);
    });

    return reply.send({
      testId,
      status: 'running',
      mode: 'full-pipeline',
      config: { ...state.config, concurrency, preferredTimeframe },
      users: userMap.size,
      marketExpiresIn: `${Math.round(remainingMs / 1000)}s`,
      pacePerSec: pacePerSec || 'burst',
      message: pacePerSec
        ? `Submitting ${orderCount} orders at ${pacePerSec}/s from ${userMap.size} users. Market expires in ${Math.round(remainingMs / 1000)}s.`
        : `Submitting ${orderCount} orders (${concurrency}x parallel burst) from ${userMap.size} users. Market expires in ${Math.round(remainingMs / 1000)}s.`,
    });
  });

  // ─── GET /status/:testId — check test progress ──────────────────────
  app.get('/status/:testId', async (request, reply) => {
    const { testId } = request.params as any;
    const state = activeTests.get(testId);
    if (!state) return reply.code(404).send({ error: 'Test not found' });

    const elapsed = (state.completedAt || Date.now()) - state.startedAt;
    const lats = state.metrics.latencies;
    const matchLats = state.metrics.matchLatencies;

    const base: any = {
      testId: state.id,
      status: state.status,
      elapsed: `${(elapsed / 1000).toFixed(1)}s`,
      config: state.config,
      progress: `${state.metrics.ordersSubmitted}/${state.config.orderCount}`,
      metrics: {
        ordersSubmitted: state.metrics.ordersSubmitted,
        ordersMatched: state.metrics.ordersMatched,
        ordersFailed: state.metrics.ordersFailed,
        fillsTotal: state.metrics.fillsTotal,
        ordersPerSecond: elapsed > 0 ? (state.metrics.ordersSubmitted / (elapsed / 1000)).toFixed(1) : '0',
        latency: lats.length > 0 ? {
          p50: percentile(lats, 50).toFixed(0),
          p95: percentile(lats, 95).toFixed(0),
          p99: percentile(lats, 99).toFixed(0),
          avg: (lats.reduce((a, b) => a + b, 0) / lats.length).toFixed(0),
        } : null,
        matchLatency: matchLats.length > 0 ? {
          p50: percentile(matchLats, 50).toFixed(0),
          p95: percentile(matchLats, 95).toFixed(0),
          avg: (matchLats.reduce((a, b) => a + b, 0) / matchLats.length).toFixed(0),
        } : null,
        recentErrors: state.metrics.errors.slice(-10),
      },
      writeBehind: writeBehindService.getStats(),
    };

    // Add full-pipeline specific metrics
    if ('mode' in state && state.mode === 'full-pipeline') {
      const fp = state as FullPipelineState;
      base.mode = 'full-pipeline';
      base.onChainMetrics = {
        ...fp.onChainMetrics,
        minConfirmTimeMs: (fp.onChainMetrics as any).minConfirmTimeMs || 0,
        maxConfirmTimeMs: (fp.onChainMetrics as any).maxConfirmTimeMs || 0,
        p50ConfirmTimeMs: (fp.onChainMetrics as any).p50ConfirmTimeMs || 0,
        p95ConfirmTimeMs: (fp.onChainMetrics as any).p95ConfirmTimeMs || 0,
      };
      base.timeline = {
        orderSubmissionStart: new Date(fp.timeline.orderSubmissionStart).toISOString(),
        orderSubmissionEnd: fp.timeline.orderSubmissionEnd ? new Date(fp.timeline.orderSubmissionEnd).toISOString() : null,
        marketClosed: fp.timeline.marketClosed ? new Date(fp.timeline.marketClosed).toISOString() : null,
        settlementStart: fp.timeline.settlementStart ? new Date(fp.timeline.settlementStart).toISOString() : null,
        settlementEnd: fp.timeline.settlementEnd ? new Date(fp.timeline.settlementEnd).toISOString() : null,
        marketExpiresIn: `${Math.max(0, Math.round((fp.marketExpiry - Date.now()) / 1000))}s`,
      };

      // Per-user payout timing
      if (fp.timeline.perUserPayout.size > 0 && fp.timeline.settlementStart) {
        const payoutTimes = Array.from(fp.timeline.perUserPayout.values()).map(t => t - fp.timeline.settlementStart!);
        base.perUserPayoutMs = {
          count: payoutTimes.length,
          min: Math.min(...payoutTimes).toFixed(0),
          max: Math.max(...payoutTimes).toFixed(0),
          avg: (payoutTimes.reduce((a, b) => a + b, 0) / payoutTimes.length).toFixed(0),
          p50: percentile(payoutTimes, 50).toFixed(0),
          p95: percentile(payoutTimes, 95).toFixed(0),
        };
      }
    }

    return reply.send(base);
  });

  // ─── POST /create-test-market — Create a controlled test market ───────
  app.post('/create-test-market', async (request, reply) => {
    const body = request.body as any;
    const durationMinutes = body.durationMinutes || 10;  // Default 10 minutes
    const asset = body.asset || 'BTC';
    const timeframe = body.timeframe || '5m';
    const strikePrice = body.strikePrice || 0;  // 0 = use current price

    logger.info(`[PERF] Creating controlled test market: ${asset}-${timeframe}, duration=${durationMinutes}m`);

    try {
      // Get current price if strikePrice not provided
      let finalStrike = strikePrice;
      if (finalStrike === 0) {
        const priceData = await priceFeedService.getPrice(asset);
        finalStrike = priceData?.price || 50000;
      }

      // Create expiry timestamp
      const expiryAt = new Date(Date.now() + durationMinutes * 60 * 1000);
      const expiryTs = Math.floor(expiryAt.getTime() / 1000);

      let marketPubkey: string;
      let yesMint: string | undefined;
      let noMint: string | undefined;

      if (config.useV2 && anchorClient.isReady()) {
        // V2: Create on-chain market with tokenized shares
        const result = await anchorClient.initializeMarketV2({
          asset,
          timeframe,
          strikePrice: finalStrike,
          expiryTs,
        });
        marketPubkey = getMarketV2Pda(asset, timeframe, expiryTs).toBase58();
        yesMint = result.yesMint;
        noMint = result.noMint;
        logger.info(`[PERF] Created V2 on-chain market: ${marketPubkey.slice(0, 16)}...`);
      } else if (anchorClient.isReady()) {
        // V1: Create on-chain market
        await anchorClient.initializeMarket({
          asset,
          timeframe,
          strikePrice: finalStrike,
          expiryTs,
        });
        marketPubkey = deriveMarketPda(asset, timeframe, expiryTs);
        logger.info(`[PERF] Created V1 on-chain market: ${marketPubkey.slice(0, 16)}...`);
      } else {
        // No on-chain - create DB-only market for testing
        marketPubkey = `test-market-${Date.now()}`;
        logger.warn(`[PERF] Anchor client not ready - creating DB-only test market`);
      }

      // Create in DB
      const market = await marketService.create({
        pubkey: marketPubkey,
        asset: asset as any,
        timeframe: timeframe as any,
        strikePrice: finalStrike.toString(),
        expiryAt,
        status: 'OPEN',
      });

      // Start MM bot for this market if not already running
      await mmBotV2.start();

      // Force immediate market sync so MM discovers and quotes the new market NOW
      // (bypasses 10-second cache that would otherwise delay liquidity)
      await mmBotV2.forceMarketSync();
      logger.info(`[PERF] MM bot synced — should now be quoting ${market.id.slice(0, 8)}...`);

      return reply.send({
        success: true,
        market: {
          id: market.id,
          pubkey: marketPubkey,
          asset,
          timeframe,
          strikePrice: finalStrike,
          expiryAt: expiryAt.toISOString(),
          durationMinutes,
          yesMint,
          noMint,
        },
        message: `Test market created. Use POST /perf/close-market/${market.id} to close it.`,
      });
    } catch (err: any) {
      logger.error(`[PERF] Failed to create test market: ${err.message}`);
      return reply.code(500).send({ error: err.message });
    }
  });

  // ─── POST /close-market/:marketId — Manually close a test market ─────
  app.post('/close-market/:marketId', async (request, reply) => {
    const { marketId } = request.params as any;
    const body = request.body as any;
    const outcome = body.outcome || 'YES';  // Default outcome if not specified

    logger.info(`[PERF] Manually closing market ${marketId} with outcome=${outcome}`);

    try {
      const market = await marketService.getById(marketId);
      if (!market) {
        return reply.code(404).send({ error: 'Market not found' });
      }

      if (market.status !== 'OPEN') {
        return reply.code(400).send({ error: `Market is not OPEN (status: ${market.status})` });
      }

      // Get final price for resolution
      const priceData = await priceFeedService.getPrice(market.asset);
      const finalPrice = priceData?.price || parseFloat(market.strikePrice);

      // 1. Close market (stop trading)
      await marketService.updateStatus(marketId, 'CLOSED');
      logger.info(`[PERF] Market closed in DB`);

      // 2. Close on-chain if available
      if (config.useV2 && anchorClient.isReady()) {
        try {
          // For V2, we need yes/no mints - fetch from on-chain
          const marketAccount = await anchorClient.getConnection().getAccountInfo(new PublicKey(market.pubkey));
          if (marketAccount) {
            await anchorClient.closeMarketV2({
              marketPubkey: market.pubkey,
              yesMint: 'pending', // Will be fetched from on-chain
              noMint: 'pending',
            });
            logger.info(`[PERF] Market closed on-chain (V2)`);
          }
        } catch (err: any) {
          logger.warn(`[PERF] Failed to close market on-chain: ${err.message}`);
        }
      }

      return reply.send({
        success: true,
        marketId,
        status: 'CLOSED',
        finalPrice,
        message: `Market closed. Use POST /perf/resolve-market/${marketId} to resolve it, or POST /perf/settle-market/${marketId} to settle.`,
      });
    } catch (err: any) {
      logger.error(`[PERF] Failed to close market: ${err.message}`);
      return reply.code(500).send({ error: err.message });
    }
  });

  // ─── POST /resolve-market/:marketId — Manually resolve market outcome ──
  app.post('/resolve-market/:marketId', async (request, reply) => {
    const { marketId } = request.params as any;
    const body = request.body as any;

    // Allow specifying outcome directly, or use finalPrice to determine it
    const outcome = body.outcome as 'YES' | 'NO' | undefined;
    const finalPrice = body.finalPrice as number | undefined;

    logger.info(`[PERF] Manually resolving market ${marketId}: outcome=${outcome}, finalPrice=${finalPrice}`);

    try {
      const market = await marketService.getById(marketId);
      if (!market) {
        return reply.code(404).send({ error: 'Market not found' });
      }

      if (market.status !== 'CLOSED') {
        return reply.code(400).send({ error: `Market must be CLOSED first (status: ${market.status})` });
      }

      // Determine outcome
      let resolvedOutcome: 'YES' | 'NO';
      let resolvedPrice: number;

      if (outcome) {
        resolvedOutcome = outcome;
        resolvedPrice = finalPrice || parseFloat(market.strikePrice);
      } else if (finalPrice !== undefined) {
        resolvedPrice = finalPrice;
        resolvedOutcome = finalPrice >= parseFloat(market.strikePrice) ? 'YES' : 'NO';
      } else {
        // Get current price
        const currentPriceData = await priceFeedService.getPrice(market.asset);
        resolvedPrice = currentPriceData?.price || parseFloat(market.strikePrice);
        resolvedOutcome = resolvedPrice >= parseFloat(market.strikePrice) ? 'YES' : 'NO';
      }

      // Update market in DB
      await db.update(markets)
        .set({
          status: 'RESOLVED',
          outcome: resolvedOutcome,
          finalPrice: resolvedPrice.toString(),
          resolvedAt: new Date(),
        })
        .where(eq(markets.id, marketId));

      logger.info(`[PERF] Market resolved: outcome=${resolvedOutcome}, finalPrice=${resolvedPrice}`);

      if (config.useV2 && anchorClient.isReady()) {
        try {
          await anchorClient.resolveMarketV2({
            marketPubkey: market.pubkey,
            finalPrice: resolvedPrice,
          });
          logger.info(`[PERF] Market resolved on-chain (V2)`);
        } catch (err: any) {
          logger.warn(`[PERF] Failed to resolve market on-chain: ${err.message}`);
        }
      }

      return reply.send({
        success: true,
        marketId,
        status: 'RESOLVED',
        outcome: resolvedOutcome,
        finalPrice: resolvedPrice,
        message: `Market resolved. Use POST /perf/settle-market/${marketId} to trigger settlement.`,
      });
    } catch (err: any) {
      logger.error(`[PERF] Failed to resolve market: ${err.message}`);
      return reply.code(500).send({ error: err.message });
    }
  });

  // ─── POST /settle-market/:marketId — Manually trigger settlement ──────
  app.post('/settle-market/:marketId', async (request, reply) => {
    const { marketId } = request.params as any;

    logger.info(`[PERF] Manually triggering settlement for market ${marketId}`);

    try {
      const market = await marketService.getById(marketId);
      if (!market) {
        return reply.code(404).send({ error: 'Market not found' });
      }

      if (market.status !== 'RESOLVED') {
        return reply.code(400).send({ error: `Market must be RESOLVED first (status: ${market.status})` });
      }

      // Run settlement
      const startTime = Date.now();
      await positionSettlerJob();
      const elapsed = Date.now() - startTime;

      // Check final status
      const updatedMarket = await marketService.getById(marketId);

      return reply.send({
        success: true,
        marketId,
        status: updatedMarket?.status || 'UNKNOWN',
        settlementTimeMs: elapsed,
        message: `Settlement triggered. Market status: ${updatedMarket?.status}`,
      });
    } catch (err: any) {
      logger.error(`[PERF] Failed to trigger settlement: ${err.message}`);
      return reply.code(500).send({ error: err.message });
    }
  });

  // ─── GET /test-market-status/:marketId — Get test market status ───────
  app.get('/test-market-status/:marketId', async (request, reply) => {
    const { marketId } = request.params as any;

    try {
      const market = await marketService.getById(marketId);
      if (!market) {
        return reply.code(404).send({ error: 'Market not found' });
      }

      // Get order/trade counts
      const orderCount = await orderbookService.getOrderCount(marketId);
      const tradeStats = await db.execute(sql`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE tx_status = 'CONFIRMED') as confirmed,
          COUNT(*) FILTER (WHERE tx_status = 'FAILED') as failed,
          COUNT(*) FILTER (WHERE tx_status IS NULL OR tx_status = 'PENDING') as pending
        FROM trades
        WHERE market_id = ${marketId}::uuid
      `);

      const stats = (tradeStats.rows?.[0] as any) || {};

      return reply.send({
        market: {
          id: market.id,
          pubkey: market.pubkey,
          asset: market.asset,
          timeframe: market.timeframe,
          strikePrice: market.strikePrice,
          finalPrice: market.finalPrice,
          status: market.status,
          outcome: market.outcome,
          expiryAt: market.expiryAt,
          remainingMs: Math.max(0, new Date(market.expiryAt).getTime() - Date.now()),
        },
        orders: orderCount,
        trades: {
          total: parseInt(stats.total || '0'),
          confirmed: parseInt(stats.confirmed || '0'),
          failed: parseInt(stats.failed || '0'),
          pending: parseInt(stats.pending || '0'),
        },
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ─── POST /order — single order (no auth, Redis-only) ────────────────
  app.post('/order', async (request, reply) => {
    const body = request.body as any;
    const t0 = Date.now();
    const walletAddress = body.walletAddress || 'perf-test-default';

    try {
      const result = await matchingService.matchMarketOrderByDollar({
        marketId: body.marketId,
        userId: walletAddress,
        side: 'BID',
        outcome: body.outcome?.toUpperCase() || 'YES',
        dollarAmount: body.dollarAmount || 25,
        maxPrice: 0.99,
        clientOrderId: Date.now(),
        expiresAt: Date.now() + 300_000,
        signature: 'perf-test-bypass',
        binaryMessage: '',
      });

      return reply.send({
        success: true,
        latencyMs: Date.now() - t0,
        fills: result.fills.length,
        totalContracts: result.totalContracts,
        totalSpent: result.totalSpent,
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message, latencyMs: Date.now() - t0 });
    }
  });
}

// ─── Full Pipeline Test Runner ───────────────────────────────────────────────

async function runFullPipelineTest(
  state: FullPipelineState,
  testWallets: TestWallet[],
  userMap: Map<string, string>,  // walletAddress → userId
  market: typeof markets.$inferSelect,
  concurrency: number = 1,
  pacePerSec: number = 0,
): Promise<void> {
  const { orderCount, durationMs, dollarPerOrder } = state.config;
  const intervalMs = durationMs / orderCount;
  const walletEntries = Array.from(userMap.entries()); // [walletAddress, userId][]

  // Pause write-behind during submission to eliminate DB contention from matching hot path.
  // All writes accumulate in memory and flush after submission completes.
  if (config.perfTestMode) {
    writeBehindService.pause();
    logger.info(`[PERF:FULL] Write-behind PAUSED for submission phase (zero DB writes during matching)`);
  }

  if (pacePerSec > 0) {
    logger.info(`[PERF:FULL] Phase 1: Submitting ${orderCount} orders ($${dollarPerOrder} each, PACED at ${pacePerSec}/s from ${walletEntries.length} wallets)`);
  } else {
    logger.info(`[PERF:FULL] Phase 1: Submitting ${orderCount} orders ($${dollarPerOrder} each, ${concurrency}x concurrency, NO pacing — max throughput)`);
  }

  // Detailed timing breakdown for bottleneck analysis
  const timingBreakdown = {
    matchingMs: [] as number[],
    totalMs: [] as number[],
    slowOrders: [] as { index: number; totalMs: number; fills: number }[],
  };

  // Helper to submit a single order via the full pipeline
  // processMarketOrderByDollar now uses write-behind (no DB await on hot path)
  const submitOrder = async (i: number): Promise<void> => {
    const t0 = Date.now();
    const [walletAddress, userId] = walletEntries[i % walletEntries.length];

    try {
      const matchStart = Date.now();

      // Use YES BID orders — these match against YES ASK which the MM always quotes.
      // NO BID orders match against YES BID, which may not exist at extreme fair values
      // (e.g., YES=0.02 with spread=0.05 → no YES BIDs possible below $0.01 floor).
      const outcome = 'YES' as const;
      const result = await matchingService.processMarketOrderByDollar({
        marketId: state.config.marketId,
        userId,
        side: 'BID',
        outcome,
        dollarAmount: dollarPerOrder,
        maxPrice: 0.99,
        clientOrderId: Date.now() + i,
        expiresAt: Date.now() + 300_000,
        signature: `perf-${userId.slice(0, 8)}`,
        binaryMessage: '',
      });

      const matchEnd = Date.now();
      const matchingTime = matchEnd - matchStart;
      const totalTime = matchEnd - t0;

      state.metrics.ordersSubmitted++;
      if (result.fills.length > 0) state.metrics.ordersMatched++;
      state.metrics.fillsTotal += result.fills.length;
      state.metrics.latencies.push(totalTime);
      state.metrics.matchLatencies.push(matchingTime);

      // Track timing breakdown
      timingBreakdown.matchingMs.push(matchingTime);
      timingBreakdown.totalMs.push(totalTime);

      // Track slow orders (> 500ms) for debugging
      if (totalTime > 500 && timingBreakdown.slowOrders.length < 20) {
        timingBreakdown.slowOrders.push({ index: i, totalMs: totalTime, fills: result.fills.length });
      }

      if (result.orderId && result.orderId !== 'cancelled') {
        state.orderIds.push(result.orderId);
      }
    } catch (err: any) {
      state.metrics.ordersSubmitted++;
      state.metrics.ordersFailed++;
      state.metrics.latencies.push(Date.now() - t0);
      if (state.metrics.errors.length < 50) {
        state.metrics.errors.push(`Order ${i} (${walletAddress.slice(0, 8)}): ${err.message}`);
      }
    }
  };

  if (pacePerSec > 0) {
    // ── Paced mode: submit orders at a steady rate (e.g. 8/s) ──
    //
    // FIXED: Previous version fired promises without awaiting, causing massive backlog.
    // Now we track in-flight orders and maintain a sliding window of concurrent requests.
    //
    // Strategy: Keep up to `maxConcurrent` orders in flight at once, starting a new one
    // as soon as one completes. This maintains the target rate while respecting system capacity.

    const maxConcurrent = Math.min(pacePerSec * 2, 50); // Allow 2x target rate in flight
    const targetIntervalMs = 1000 / pacePerSec; // Time between order starts
    let orderIndex = 0;
    const marketExpiryMs = state.marketExpiry;
    const submitDeadline = marketExpiryMs - 30_000;

    // Track in-flight orders
    const inFlight = new Set<Promise<void>>();
    let lastLogTime = 0;

    logger.info(`[PERF:FULL] Paced submission: target ${pacePerSec}/s, max ${maxConcurrent} concurrent, deadline ${Math.round((submitDeadline - Date.now()) / 1000)}s`);

    const startSubmission = Date.now();

    while (orderIndex < orderCount && Date.now() < submitDeadline) {
      const loopStart = Date.now();

      // Wait if we're at max concurrency
      while (inFlight.size >= maxConcurrent && Date.now() < submitDeadline) {
        await Promise.race([...inFlight]);
      }

      if (Date.now() >= submitDeadline) break;

      // Start a new order
      const idx = orderIndex++;
      const orderPromise = submitOrder(idx).finally(() => {
        inFlight.delete(orderPromise);
      });
      inFlight.add(orderPromise);

      // Pace: wait until next order should start
      const elapsed = Date.now() - startSubmission;
      const expectedOrdersStarted = Math.floor(elapsed / targetIntervalMs);
      if (orderIndex > expectedOrdersStarted + 1) {
        // We're ahead of pace, slow down
        const waitMs = (orderIndex - expectedOrdersStarted) * targetIntervalMs - (elapsed % targetIntervalMs);
        if (waitMs > 0) await sleep(Math.min(waitMs, 100));
      }

      // Log progress every 5 seconds
      if (Date.now() - lastLogTime >= 5000) {
        lastLogTime = Date.now();
        const submitted = state.metrics.ordersSubmitted;
        const elapsedSec = (Date.now() - state.timeline.orderSubmissionStart) / 1000;
        const actualRate = submitted / elapsedSec;
        const pending = inFlight.size;
        logger.info(`[PERF:FULL] Progress: ${submitted}/${orderCount} submitted (${actualRate.toFixed(1)}/s), ${pending} in-flight, ${state.metrics.fillsTotal} fills, ${state.metrics.ordersFailed} failed`);
      }
    }

    // Wait for all in-flight orders to complete
    if (inFlight.size > 0) {
      logger.info(`[PERF:FULL] Waiting for ${inFlight.size} in-flight orders to complete...`);
      await Promise.allSettled([...inFlight]);
    }

    if (orderIndex < orderCount) {
      logger.info(`[PERF:FULL] Stopped at ${orderIndex}/${orderCount} orders (market deadline reached)`);
    }

  } else {
    // ── Burst mode: Submit ALL orders at max throughput ──
    const BATCH_SIZE = Math.max(concurrency, 50);

    for (let batch = 0; batch < orderCount; batch += BATCH_SIZE) {
      const batchSize = Math.min(BATCH_SIZE, orderCount - batch);

      const promises: Promise<void>[] = [];
      for (let j = 0; j < batchSize; j++) {
        promises.push(submitOrder(batch + j));
      }
      await Promise.allSettled(promises);

      const submitted = state.metrics.ordersSubmitted;
      const elapsed = Date.now() - state.startedAt;
      const rate = submitted / (elapsed / 1000);
      
      if (submitted % 200 < BATCH_SIZE || batch + BATCH_SIZE >= orderCount) {
        logger.info(`[PERF:FULL] Progress: ${submitted}/${orderCount} orders (${rate.toFixed(0)}/s), ${state.metrics.fillsTotal} fills, ${state.metrics.ordersFailed} failed`);
      }
    }
  }

  state.timeline.orderSubmissionEnd = Date.now();
  const submissionElapsed = state.timeline.orderSubmissionEnd - state.timeline.orderSubmissionStart;
  const matchRate = state.metrics.ordersSubmitted / (submissionElapsed / 1000);
  logger.info(`[PERF:FULL] Phase 1 complete: ${state.metrics.ordersMatched}/${orderCount} matched in ${(submissionElapsed / 1000).toFixed(1)}s (${matchRate.toFixed(0)} orders/s, ${state.metrics.fillsTotal} fills)`);

  // Resume write-behind and flush all accumulated writes to DB
  logger.info(`[PERF:FULL] Flushing write-behind queue... (${writeBehindService.pendingCount} pending)`);
  if (config.perfTestMode) {
    await writeBehindService.resume();  // Unpauses and drains all accumulated writes
  } else {
    await writeBehindService.flush();
  }
  logger.info(`[PERF:FULL] Write-behind flushed. Stats: ${JSON.stringify(writeBehindService.getStats())}`);

  // NOTE: Keep MM bot running! It provides continuous liquidity for matching.
  // The RPC capacity concern is less important than having orders match.
  // On-chain worker is rate-limited anyway (7 tx/s).

  // ── Phase 2: Monitor on-chain confirmations ──
  state.status = 'monitoring';
  logger.info(`[PERF:FULL] Phase 2: Monitoring on-chain confirmations for ${state.orderIds.length} orders...`);

  const onchainMonitorStart = Date.now();
  let lastLoggedConfirmed = 0;

  // Poll every 2s for on-chain confirmations. Allow 60s past market expiry for in-flight TXs
  // to confirm (devnet P95 confirm time is ~25s, so 60s gives ample buffer).
  while (Date.now() < state.marketExpiry + 60_000) {
    await sleep(2000);

    // Count confirmed trades (trades with non-null tx_signature)
    try {
      const tradeStats = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE tx_signature IS NOT NULL AND tx_status = 'CONFIRMED') AS confirmed,
          COUNT(*) FILTER (WHERE tx_status = 'FAILED') AS failed,
          COUNT(*) FILTER (WHERE tx_signature IS NULL AND (tx_status IS NULL OR tx_status = 'PENDING')) AS pending
        FROM trades
        WHERE market_id = ${state.config.marketId}::uuid
          AND executed_at > ${new Date(state.startedAt).toISOString()}::timestamptz
      `);

      const row = (tradeStats.rows?.[0] as any) || {};
      state.onChainMetrics.confirmed = parseInt(row.confirmed || '0');
      state.onChainMetrics.failed = parseInt(row.failed || '0');
      state.onChainMetrics.pending = parseInt(row.pending || '0');

      // Calculate avg confirmation time (confirmed_at - executed_at) for confirmed trades
      try {
        const confirmTimeResult = await db.execute(sql`
          SELECT
            AVG(EXTRACT(EPOCH FROM (confirmed_at - executed_at)) * 1000)::int AS avg_confirm_ms,
            MIN(EXTRACT(EPOCH FROM (confirmed_at - executed_at)) * 1000)::int AS min_confirm_ms,
            MAX(EXTRACT(EPOCH FROM (confirmed_at - executed_at)) * 1000)::int AS max_confirm_ms,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (confirmed_at - executed_at)) * 1000)::int AS p50_confirm_ms,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (confirmed_at - executed_at)) * 1000)::int AS p95_confirm_ms
          FROM trades
          WHERE market_id = ${state.config.marketId}::uuid
            AND executed_at > ${new Date(state.startedAt).toISOString()}::timestamptz
            AND confirmed_at IS NOT NULL
            AND tx_status = 'CONFIRMED'
        `);
        const ctRow = (confirmTimeResult.rows?.[0] as any) || {};
        state.onChainMetrics.avgConfirmTimeMs = parseInt(ctRow.avg_confirm_ms || '0');
        (state.onChainMetrics as any).minConfirmTimeMs = parseInt(ctRow.min_confirm_ms || '0');
        (state.onChainMetrics as any).maxConfirmTimeMs = parseInt(ctRow.max_confirm_ms || '0');
        (state.onChainMetrics as any).p50ConfirmTimeMs = parseInt(ctRow.p50_confirm_ms || '0');
        (state.onChainMetrics as any).p95ConfirmTimeMs = parseInt(ctRow.p95_confirm_ms || '0');
      } catch { /* column may not exist */ }

      if (state.onChainMetrics.confirmed !== lastLoggedConfirmed) {
        const confirmAvg = state.onChainMetrics.avgConfirmTimeMs ? ` (avg confirm: ${(state.onChainMetrics.avgConfirmTimeMs / 1000).toFixed(1)}s)` : '';
        logger.info(`[PERF:FULL] On-chain: ${state.onChainMetrics.confirmed} confirmed, ${state.onChainMetrics.failed} failed, ${state.onChainMetrics.pending} pending${confirmAvg}`);
        lastLoggedConfirmed = state.onChainMetrics.confirmed;
      }

      // All trades resolved
      if (state.onChainMetrics.pending === 0 && state.onChainMetrics.confirmed + state.onChainMetrics.failed > 0) {
        logger.info(`[PERF:FULL] All on-chain matches resolved in ${((Date.now() - onchainMonitorStart) / 1000).toFixed(1)}s`);
        break;
      }
    } catch (err: any) {
      // trades table might not have tx_status column - try simpler query
      logger.debug(`[PERF:FULL] Trade stats query error: ${err.message}`);
    }

    // Check if market has closed
    const currentMarket = await marketService.getById(state.config.marketId);
    if (currentMarket && currentMarket.status !== 'OPEN') {
      if (!state.timeline.marketClosed) {
        state.timeline.marketClosed = Date.now();
        logger.info(`[PERF:FULL] Market closed at ${new Date().toISOString()}`);
      }
    }
  }

  // ── Phase 3: Monitor settlement ──
  logger.info(`[PERF:FULL] Phase 3: Waiting for market resolution and settlement...`);

  // Wait for market to be resolved + settled (poll every 2s)
  // Timeout = time until market expires + 120s buffer for resolution + settlement
  const timeUntilExpiry = Math.max(0, state.marketExpiry - Date.now());
  const settlementTimeout = Date.now() + timeUntilExpiry + 120_000;
  let settlementStartLogged = false;

  while (Date.now() < settlementTimeout) {
    await sleep(2000);

    const currentMarket = await marketService.getById(state.config.marketId);
    if (!currentMarket) break;

    // Track market close
    if (!state.timeline.marketClosed && currentMarket.status !== 'OPEN') {
      state.timeline.marketClosed = Date.now();
      logger.info(`[PERF:FULL] Market status: ${currentMarket.status}`);
    }

    // Track settlement start
    if (currentMarket.status === 'RESOLVED' && !settlementStartLogged) {
      state.timeline.settlementStart = Date.now();
      settlementStartLogged = true;
      logger.info(`[PERF:FULL] Market RESOLVED (outcome=${currentMarket.outcome}). Settlement starting...`);
    }

    // Check for settlement completion
    if (currentMarket.status === 'SETTLED' || currentMarket.status === 'ARCHIVED') {
      state.timeline.settlementEnd = Date.now();
      logger.info(`[PERF:FULL] Market SETTLED!`);

      // Fetch per-user settlement timing
      try {
        const settlementsData = await db.select()
          .from(settlements)
          .where(eq(settlements.marketId, state.config.marketId));

        for (const s of settlementsData) {
          if (s.userId && s.confirmedAt) {
            state.timeline.perUserPayout.set(s.userId, new Date(s.confirmedAt).getTime());
          }
        }
        logger.info(`[PERF:FULL] ${settlementsData.length} settlement records found`);
      } catch (err: any) {
        logger.warn(`[PERF:FULL] Failed to query settlements: ${err.message}`);
      }

      break;
    }

    // Check for failed settlement
    if (currentMarket.status === 'SETTLEMENT_FAILED') {
      logger.error(`[PERF:FULL] Settlement FAILED for market ${state.config.marketId}`);
      state.metrics.errors.push('Settlement failed on-chain (possibly missing on-chain positions)');
      break;
    }

    logger.debug(`[PERF:FULL] Market status: ${currentMarket.status}, waiting...`);
  }

  // ── Phase 4: Calculate final metrics ──
  state.status = 'completed';
  state.completedAt = Date.now();

  const totalElapsed = state.completedAt - state.startedAt;

  // Calculate settlement timing
  let settlementDuration = 'N/A';
  if (state.timeline.settlementStart && state.timeline.settlementEnd) {
    settlementDuration = `${((state.timeline.settlementEnd - state.timeline.settlementStart) / 1000).toFixed(2)}s`;
  }

  let marketCloseToPayout = 'N/A';
  if (state.timeline.marketClosed && state.timeline.settlementEnd) {
    marketCloseToPayout = `${((state.timeline.settlementEnd - state.timeline.marketClosed) / 1000).toFixed(2)}s`;
  }

  // Per-user payout stats
  let perUserPayoutStats = 'N/A';
  if (state.timeline.perUserPayout.size > 0 && state.timeline.settlementStart) {
    const times = Array.from(state.timeline.perUserPayout.values()).map(t => t - state.timeline.settlementStart!);
    perUserPayoutStats = `${state.timeline.perUserPayout.size} users, avg=${(times.reduce((a, b) => a + b, 0) / times.length / 1000).toFixed(2)}s, max=${(Math.max(...times) / 1000).toFixed(2)}s`;
  }

  logger.info('');
  logger.info('══════════════════════════════════════════════════════════');
  logger.info(`  FULL PIPELINE TEST COMPLETE — ${state.id}`);
  logger.info('══════════════════════════════════════════════════════════');
  logger.info(`  Orders:         ${state.metrics.ordersMatched}/${orderCount} matched (${state.metrics.ordersFailed} failed)`);
  logger.info(`  Fills:          ${state.metrics.fillsTotal}`);
  logger.info(`  Submit rate:    ${(state.metrics.ordersSubmitted / (submissionElapsed / 1000)).toFixed(1)} orders/s`);
  logger.info(`  Match P50:      ${state.metrics.matchLatencies.length > 0 ? percentile(state.metrics.matchLatencies, 50).toFixed(0) : 'N/A'}ms`);
  // On-chain throughput (confirmed TXs / on-chain phase duration)
  const onchainElapsed = (state.timeline.orderSubmissionEnd || state.completedAt!) - state.timeline.orderSubmissionStart;
  const onchainTxPerSec = onchainElapsed > 0 ? (state.onChainMetrics.confirmed / (onchainElapsed / 1000)).toFixed(2) : 'N/A';
  const confirmAvg = state.onChainMetrics.avgConfirmTimeMs ? `${(state.onChainMetrics.avgConfirmTimeMs / 1000).toFixed(1)}s` : 'N/A';
  const confirmP50 = (state.onChainMetrics as any).p50ConfirmTimeMs ? `${((state.onChainMetrics as any).p50ConfirmTimeMs / 1000).toFixed(1)}s` : 'N/A';
  const confirmP95 = (state.onChainMetrics as any).p95ConfirmTimeMs ? `${((state.onChainMetrics as any).p95ConfirmTimeMs / 1000).toFixed(1)}s` : 'N/A';
  const confirmMin = (state.onChainMetrics as any).minConfirmTimeMs ? `${((state.onChainMetrics as any).minConfirmTimeMs / 1000).toFixed(1)}s` : 'N/A';
  const confirmMax = (state.onChainMetrics as any).maxConfirmTimeMs ? `${((state.onChainMetrics as any).maxConfirmTimeMs / 1000).toFixed(1)}s` : 'N/A';

  logger.info(`  On-chain:       ${state.onChainMetrics.confirmed} confirmed, ${state.onChainMetrics.failed} failed`);
  logger.info(`  TX throughput:  ${onchainTxPerSec} confirmed tx/s`);
  logger.info(`  Confirm time:   avg=${confirmAvg}, p50=${confirmP50}, p95=${confirmP95}, min=${confirmMin}, max=${confirmMax}`);
  logger.info(`  Settlement:     ${settlementDuration}`);
  logger.info(`  Market→Payout:  ${marketCloseToPayout}`);
  logger.info(`  Per-user:       ${perUserPayoutStats}`);
  logger.info(`  Total time:     ${(totalElapsed / 1000).toFixed(1)}s`);
  logger.info('──────────────────────────────────────────────────────────');
  logger.info('  BOTTLENECK ANALYSIS:');
  if (timingBreakdown.matchingMs.length > 0) {
    const matchP50 = percentile(timingBreakdown.matchingMs, 50);
    const matchP95 = percentile(timingBreakdown.matchingMs, 95);
    const matchP99 = percentile(timingBreakdown.matchingMs, 99);
    const matchAvg = timingBreakdown.matchingMs.reduce((a, b) => a + b, 0) / timingBreakdown.matchingMs.length;
    logger.info(`  Matching:       avg=${matchAvg.toFixed(0)}ms, p50=${matchP50.toFixed(0)}ms, p95=${matchP95.toFixed(0)}ms, p99=${matchP99.toFixed(0)}ms`);

    // Theoretical max throughput based on latency
    const theoreticalMaxTps = 1000 / matchP50;
    logger.info(`  Theoretical:    ${theoreticalMaxTps.toFixed(1)} orders/s max (based on P50 latency)`);

    // Identify slow orders
    if (timingBreakdown.slowOrders.length > 0) {
      logger.info(`  Slow orders:    ${timingBreakdown.slowOrders.length} orders > 500ms`);
      const slowest = timingBreakdown.slowOrders.sort((a, b) => b.totalMs - a.totalMs).slice(0, 3);
      for (const s of slowest) {
        logger.info(`    - Order ${s.index}: ${s.totalMs}ms (${s.fills} fills)`);
      }
    }
  }
  logger.info('══════════════════════════════════════════════════════════');
  logger.info('');

  // Restart MM bot after test completes (in case it was stopped)
  if (!mmBotV2.getStatus().running) {
    logger.info(`[PERF:FULL] Restarting MM bot after test completion...`);
    await mmBotV2.start();
  }
}

// ─── Redis-only Test Runner ──────────────────────────────────────────────────

async function runRedisOnlyPerfTest(
  state: PerfTestState,
  userIds: string[],
  market: typeof markets.$inferSelect,
): Promise<void> {
  const { orderCount, durationMs, dollarPerOrder } = state.config;
  const intervalMs = durationMs / orderCount;

  // Use full order processing (with on-chain execution) instead of Redis-only matching
  // This creates real positions that can be settled
  const useFullProcessing = true;

  for (let i = 0; i < orderCount; i++) {
    const t0 = Date.now();
    const userId = userIds[i % userIds.length];

    try {
      const matchStart = Date.now();
      let result;

      if (useFullProcessing) {
        // Full processing: match + DB + on-chain execution
        result = await matchingService.processMarketOrderByDollar({
          marketId: market.id,
          userId,
          side: 'BID',
          outcome: 'YES',
          dollarAmount: dollarPerOrder,
          maxPrice: 0.99,
          clientOrderId: Date.now() + i,
          expiresAt: Date.now() + 300_000,
          signature: 'perf-test-bypass',
          binaryMessage: '',
        });
      } else {
        // Redis-only matching (no on-chain, no positions)
        result = await matchingService.matchMarketOrderByDollar({
          marketId: market.id,
          userId,
          side: 'BID',
          outcome: 'YES',
          dollarAmount: dollarPerOrder,
          maxPrice: 0.99,
          clientOrderId: Date.now() + i,
          expiresAt: Date.now() + 300_000,
          signature: 'perf-test-bypass',
          binaryMessage: '',
        });
      }

      state.metrics.ordersSubmitted++;
      if (result.fills.length > 0) state.metrics.ordersMatched++;
      state.metrics.fillsTotal += result.fills.length;
      state.metrics.latencies.push(Date.now() - t0);
      state.metrics.matchLatencies.push(Date.now() - matchStart);

      if (i > 0 && i % 100 === 0) {
        const elapsed = Date.now() - state.startedAt;
        logger.info(`[PERF] Progress: ${state.metrics.ordersSubmitted}/${orderCount} (${(state.metrics.ordersSubmitted / (elapsed / 1000)).toFixed(1)}/s)`);
      }
    } catch (err: any) {
      state.metrics.ordersSubmitted++;
      state.metrics.ordersFailed++;
      state.metrics.latencies.push(Date.now() - t0);
      if (state.metrics.errors.length < 50) state.metrics.errors.push(`Order ${i}: ${err.message}`);
    }

    const elapsed = Date.now() - t0;
    if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
  }

  state.status = 'completed';
  state.completedAt = Date.now();
  const totalElapsed = state.completedAt - state.startedAt;
  logger.info(`[PERF] Full-pipeline test complete: ${state.metrics.ordersMatched}/${orderCount} matched, ${(state.metrics.ordersSubmitted / (totalElapsed / 1000)).toFixed(1)} orders/s`);
}

// ─── Orderbook Seeder (Redis-only test) ──────────────────────────────────────

async function seedOrderbookForPerfTest(marketId: string): Promise<void> {
  const SIZE_PER_LEVEL = 10_000_000;
  const PRICE_MULTIPLIER = 1000000;

  // Register a real DB user for the synthetic MM so fills have a valid UUID counterparty
  const SYNTHETIC_MM_WALLET = 'PerfTestMM1111111111111111111111111111111111';
  const mmUser = await userService.getOrCreate(SYNTHETIC_MM_WALLET);
  const MM_USER_ID = mmUser.id;

  logger.info(`[PERF] Seeding orderbook for market ${marketId} (mm user: ${MM_USER_ID})...`);
  const t0 = Date.now();

  const sides: Array<'ASK' | 'BID'> = ['ASK', 'BID'];
  let count = 0;

  for (const side of sides) {
    const pipe = redis.pipeline();
    const obKey = RedisKeys.orderbook(marketId, 'YES', side);

    for (let priceInt = 2; priceInt <= 98; priceInt++) {
      const price = priceInt / 100;
      const orderId = randomUUID();
      const orderKey = `order:${orderId}`;

      pipe.hset(orderKey, {
        id: orderId, marketId, userId: MM_USER_ID, side, outcome: 'YES',
        price: price.toString(), size: SIZE_PER_LEVEL.toString(),
        remainingSize: SIZE_PER_LEVEL.toString(), createdAt: Date.now().toString(),
      });
      pipe.expire(orderKey, 86400);

      const score = side === 'BID' ? -(price * PRICE_MULTIPLIER) : (price * PRICE_MULTIPLIER);
      pipe.zadd(obKey, score, orderId);
      count++;
    }

    await pipe.exec();
  }

  await redis.incrby(RedisKeys.sequence(marketId), count);
  logger.info(`[PERF] Seeded ${count} orders in ${Date.now() - t0}ms`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
