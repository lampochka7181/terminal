#!/usr/bin/env node
/**
 * Performance Log Analyzer
 *
 * Parses the API log files after a performance test and reports:
 *   - Order matching stats (count, latency)
 *   - On-chain match success/failure rates and timing
 *   - Settlement timing (merkle root → batch settle → finalize)
 *   - End-to-end pipeline timing
 *
 * Usage: node scripts/analyze-perf-logs.mjs [logDir]
 *   Default logDir: apps/api/logs
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, resolve } from 'path';

const logDir = resolve(process.argv[2] || join(process.cwd(), 'apps', 'api', 'logs'));

console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║        📊 PERFORMANCE LOG ANALYSIS                   ║');
console.log('╠══════════════════════════════════════════════════════╣');
console.log(`║  Log dir: ${logDir.slice(-45).padEnd(45)}║`);
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');

// ─── Collect all log files recursively ──────────────────────────────────────

function findLogFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findLogFiles(full));
    } else if (entry.name.endsWith('.log')) {
      files.push(full);
    }
  }
  return files;
}

const logFiles = findLogFiles(logDir);
console.log(`Found ${logFiles.length} log files\n`);

if (logFiles.length === 0) {
  console.log('No log files found. Run a test first with PERF_TEST_MODE=true.');
  process.exit(0);
}

// ─── Parse logs ─────────────────────────────────────────────────────────────

const events = {
  ordersPlaced: [],      // { time, orderId, marketId, size, price }
  matchJobs: [],         // { time, jobId, attempt }
  matchSuccess: [],      // { time, jobId, signature, durationMs }
  matchFailed: [],       // { time, jobId, error }
  marketsResolved: [],   // { time, marketId, outcome }
  merkleRootPosted: [],  // { time, marketId, signature }
  batchSettleSuccess: [],// { time, jobId, signature, durationMs }
  marketsSettled: [],    // { time, marketId, positions, payout, durationMs }
  settlementFailed: [],  // { time, marketId, reason }
  perfProgress: [],      // { time, submitted, total, rate, fills }
};

for (const file of logFiles) {
  const content = readFileSync(file, 'utf8');
  
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    
    try {
      const log = JSON.parse(line);
      const msg = log.msg || '';
      const time = log.time ? new Date(log.time) : null;
      
      // Order placed
      if (msg.includes('ORDER PLACED:')) {
        events.ordersPlaced.push({ time, msg });
      }
      
      // Match job processing
      if (msg.includes('[QUEUE:onchain] Processing match job:')) {
        const match = msg.match(/Processing match job: (.+?) \(attempt (\d+)\)/);
        if (match) events.matchJobs.push({ time, jobId: match[1], attempt: parseInt(match[2]) });
      }
      
      // Match success
      if (msg.includes('[QUEUE:onchain] match success:')) {
        const durationMatch = msg.match(/\[(\d+)ms\]/);
        events.matchSuccess.push({ 
          time, 
          msg, 
          durationMs: durationMatch ? parseInt(durationMatch[1]) : null 
        });
      }
      
      // Batch settle success
      if (msg.includes('[QUEUE:onchain] batch-settle success:')) {
        const durationMatch = msg.match(/\[(\d+)ms\]/);
        events.batchSettleSuccess.push({ 
          time, 
          msg, 
          durationMs: durationMatch ? parseInt(durationMatch[1]) : null 
        });
      }
      
      // Match failed
      if (msg.includes('[QUEUE:onchain] Job') && msg.includes('failed:')) {
        events.matchFailed.push({ time, msg });
      }
      
      // Market resolved
      if (msg.includes('MARKET RESOLVED:')) {
        events.marketsResolved.push({ time, msg });
      }
      
      // Merkle root posted
      if (msg.includes('Merkle root posted for')) {
        events.merkleRootPosted.push({ time, msg });
      }
      
      // Market settled
      if (msg.includes('MARKET SETTLED:') || msg.includes('fully settled')) {
        const durationMatch = msg.match(/\[(\d+)ms total\]/);
        events.marketsSettled.push({ 
          time, 
          msg, 
          durationMs: durationMatch ? parseInt(durationMatch[1]) : null 
        });
      }
      
      // Settlement failed
      if (msg.includes('SETTLEMENT FAILED')) {
        events.settlementFailed.push({ time, msg });
      }
      
      // Perf test progress
      if (msg.includes('[PERF] Progress:') || msg.includes('[PERF] Test') && msg.includes('COMPLETE')) {
        events.perfProgress.push({ time, msg });
      }
    } catch {
      // Skip non-JSON lines (e.g., pino-pretty output)
      // Try regex on raw text
      if (line.includes('ORDER PLACED:')) events.ordersPlaced.push({ time: null, msg: line });
      if (line.includes('match success:')) events.matchSuccess.push({ time: null, msg: line, durationMs: null });
      if (line.includes('MARKET SETTLED:') || line.includes('fully settled')) events.marketsSettled.push({ time: null, msg: line, durationMs: null });
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════');
console.log('  📋 SUMMARY');
console.log('═══════════════════════════════════════════════════');
console.log(`  Orders placed:         ${events.ordersPlaced.length}`);
console.log(`  Match jobs started:    ${events.matchJobs.length}`);
console.log(`  Match success:         ${events.matchSuccess.length}`);
console.log(`  Match failed:          ${events.matchFailed.length}`);
console.log(`  Markets resolved:      ${events.marketsResolved.length}`);
console.log(`  Merkle roots posted:   ${events.merkleRootPosted.length}`);
console.log(`  Batch settles OK:      ${events.batchSettleSuccess.length}`);
console.log(`  Markets settled:       ${events.marketsSettled.length}`);
console.log(`  Settlement failures:   ${events.settlementFailed.length}`);
console.log('');

// On-chain match timing
const matchDurations = events.matchSuccess.map(e => e.durationMs).filter(Boolean);
if (matchDurations.length > 0) {
  matchDurations.sort((a, b) => a - b);
  console.log('═══════════════════════════════════════════════════');
  console.log('  ⏱️  ON-CHAIN MATCH TIMING');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Count:   ${matchDurations.length}`);
  console.log(`  p50:     ${percentile(matchDurations, 50)}ms`);
  console.log(`  p95:     ${percentile(matchDurations, 95)}ms`);
  console.log(`  p99:     ${percentile(matchDurations, 99)}ms`);
  console.log(`  avg:     ${Math.round(matchDurations.reduce((a, b) => a + b, 0) / matchDurations.length)}ms`);
  console.log(`  min:     ${matchDurations[0]}ms`);
  console.log(`  max:     ${matchDurations[matchDurations.length - 1]}ms`);
  console.log('');
}

// Settlement timing
const settleDurations = events.marketsSettled.map(e => e.durationMs).filter(Boolean);
if (settleDurations.length > 0) {
  settleDurations.sort((a, b) => a - b);
  console.log('═══════════════════════════════════════════════════');
  console.log('  ⏱️  SETTLEMENT TIMING (resolve → settled)');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Count:   ${settleDurations.length}`);
  console.log(`  p50:     ${percentile(settleDurations, 50)}ms`);
  console.log(`  p95:     ${percentile(settleDurations, 95)}ms`);
  console.log(`  avg:     ${Math.round(settleDurations.reduce((a, b) => a + b, 0) / settleDurations.length)}ms`);
  console.log(`  min:     ${settleDurations[0]}ms`);
  console.log(`  max:     ${settleDurations[settleDurations.length - 1]}ms`);
  console.log('');
}

// Errors
if (events.matchFailed.length > 0) {
  console.log('═══════════════════════════════════════════════════');
  console.log('  ❌ MATCH FAILURES');
  console.log('═══════════════════════════════════════════════════');
  for (const e of events.matchFailed.slice(0, 20)) {
    console.log(`  ${e.msg.slice(0, 100)}`);
  }
  if (events.matchFailed.length > 20) {
    console.log(`  ... and ${events.matchFailed.length - 20} more`);
  }
  console.log('');
}

if (events.settlementFailed.length > 0) {
  console.log('═══════════════════════════════════════════════════');
  console.log('  ❌ SETTLEMENT FAILURES');
  console.log('═══════════════════════════════════════════════════');
  for (const e of events.settlementFailed) {
    console.log(`  ${e.msg.slice(0, 100)}`);
  }
  console.log('');
}

// Success rate
const matchRate = events.matchJobs.length > 0 
  ? ((events.matchSuccess.length / events.matchJobs.length) * 100).toFixed(1) 
  : 'N/A';
console.log('═══════════════════════════════════════════════════');
console.log('  📈 SUCCESS RATES');
console.log('═══════════════════════════════════════════════════');
console.log(`  On-chain match rate:   ${matchRate}%`);
console.log(`  Settlement rate:       ${events.marketsResolved.length > 0 ? ((events.marketsSettled.length / events.marketsResolved.length) * 100).toFixed(1) : 'N/A'}%`);
console.log('');

// Perf test progress
if (events.perfProgress.length > 0) {
  console.log('═══════════════════════════════════════════════════');
  console.log('  🏎️  PERF TEST PROGRESS');
  console.log('═══════════════════════════════════════════════════');
  for (const e of events.perfProgress) {
    console.log(`  ${e.msg}`);
  }
  console.log('');
}

function percentile(arr, p) {
  const idx = Math.ceil((p / 100) * arr.length) - 1;
  return arr[Math.max(0, idx)];
}
