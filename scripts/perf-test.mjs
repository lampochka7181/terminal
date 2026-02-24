#!/usr/bin/env node
/**
 * Performance Test Client
 *
 * Triggers a performance test against the local API server.
 * Usage: node scripts/perf-test.mjs [orderCount] [durationSec] [dollarPerOrder]
 *
 * Example: node scripts/perf-test.mjs 2000 120 25
 *   → 2000 orders over 120s, $25 each
 *
 * Prerequisites:
 *   - API running with PERF_TEST_MODE=true
 *   - At least one active market
 *   - MM bot running (provides liquidity)
 */

const API_BASE = process.env.API_URL || 'http://localhost:4000';

const orderCount = parseInt(process.argv[2] || '2000');
const durationSec = parseInt(process.argv[3] || '120');
const dollarPerOrder = parseFloat(process.argv[4] || '25');

console.log('');
console.log('╔══════════════════════════════════════════════╗');
console.log('║      🏎️  DEGEN TERMINAL PERF TEST            ║');
console.log('╠══════════════════════════════════════════════╣');
console.log(`║  Orders:    ${String(orderCount).padEnd(33)}║`);
console.log(`║  Duration:  ${String(durationSec + 's').padEnd(33)}║`);
console.log(`║  $/order:   $${String(dollarPerOrder).padEnd(32)}║`);
console.log(`║  API:       ${API_BASE.padEnd(33)}║`);
console.log('╚══════════════════════════════════════════════╝');
console.log('');

async function main() {
  // 1. Start the test
  console.log('🚀 Starting performance test...');
  const startResp = await fetch(`${API_BASE}/perf/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderCount,
      durationMs: durationSec * 1000,
      dollarPerOrder,
      marketId: 'auto',
    }),
  });

  if (!startResp.ok) {
    const err = await startResp.text();
    console.error(`❌ Failed to start test: ${startResp.status} ${err}`);
    process.exit(1);
  }

  const startData = await startResp.json();
  const testId = startData.testId;
  console.log(`✅ Test started: ${testId}`);
  console.log(`   ${startData.message}`);
  console.log('');

  // 2. Poll for status
  const pollInterval = 5000; // 5 seconds
  let lastProgress = '';
  let done = false;

  while (!done) {
    await sleep(pollInterval);

    try {
      const statusResp = await fetch(`${API_BASE}/perf/status/${testId}`);
      if (!statusResp.ok) {
        console.error(`⚠️  Status check failed: ${statusResp.status}`);
        continue;
      }

      const status = await statusResp.json();
      const progress = status.progress;

      if (progress !== lastProgress) {
        const bar = progressBar(status.metrics.ordersSubmitted, orderCount, 30);
        console.log(`  ${bar} ${progress} | ${status.metrics.ordersPerSecond}/s | fills: ${status.metrics.fillsTotal} | failed: ${status.metrics.ordersFailed}`);
        lastProgress = progress;
      }

      if (status.status === 'completed' || status.status === 'failed') {
        done = true;
        console.log('');
        printResults(status);
      }
    } catch (err) {
      console.error(`⚠️  Poll error: ${err.message}`);
    }
  }
}

function printResults(status) {
  const m = status.metrics;
  console.log('╔══════════════════════════════════════════════╗');
  console.log(`║  ${status.status === 'completed' ? '✅ TEST COMPLETED' : '❌ TEST FAILED'}                            ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Duration:       ${status.elapsed.padEnd(28)}║`);
  console.log(`║  Orders/sec:     ${String(m.ordersPerSecond).padEnd(28)}║`);
  console.log(`║  Submitted:      ${String(m.ordersSubmitted).padEnd(28)}║`);
  console.log(`║  Matched:        ${String(m.ordersMatched).padEnd(28)}║`);
  console.log(`║  Failed:         ${String(m.ordersFailed).padEnd(28)}║`);
  console.log(`║  Total fills:    ${String(m.fillsTotal).padEnd(28)}║`);
  console.log('╠══════════════════════════════════════════════╣');

  if (m.latency) {
    console.log('║  End-to-end latency (ms):                    ║');
    console.log(`║    p50:  ${String(m.latency.p50 + 'ms').padEnd(37)}║`);
    console.log(`║    p95:  ${String(m.latency.p95 + 'ms').padEnd(37)}║`);
    console.log(`║    p99:  ${String(m.latency.p99 + 'ms').padEnd(37)}║`);
    console.log(`║    avg:  ${String(m.latency.avg + 'ms').padEnd(37)}║`);
    console.log(`║    min:  ${String(m.latency.min + 'ms').padEnd(37)}║`);
    console.log(`║    max:  ${String(m.latency.max + 'ms').padEnd(37)}║`);
  }

  if (m.matchLatency) {
    console.log('║  Match engine latency (ms):                  ║');
    console.log(`║    p50:  ${String(m.matchLatency.p50 + 'ms').padEnd(37)}║`);
    console.log(`║    p95:  ${String(m.matchLatency.p95 + 'ms').padEnd(37)}║`);
    console.log(`║    avg:  ${String(m.matchLatency.avg + 'ms').padEnd(37)}║`);
  }

  console.log('╚══════════════════════════════════════════════╝');

  if (m.recentErrors && m.recentErrors.length > 0) {
    console.log('');
    console.log('⚠️  Recent errors:');
    for (const err of m.recentErrors) {
      console.log(`   - ${err}`);
    }
  }
}

function progressBar(current, total, width) {
  const pct = Math.min(current / total, 1);
  const filled = Math.round(width * pct);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${(pct * 100).toFixed(0)}%`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
