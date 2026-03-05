/**
 * BullMQ Queue Definitions
 *
 * Three queues:
 *   onchain-submit  — submits transactions to Solana (concurrency 20, 3 retries)
 *   db-sync         — persists tx results to Postgres (concurrency 50)
 *   ws-events       — fans out WebSocket broadcasts (concurrency 100)
 */

import { Queue } from 'bullmq';
import { config } from '../config.js';

// Shared Redis connection options derived from the project-wide REDIS_URL.
// BullMQ creates its own ioredis instances; we just pass the same config.
function redisOpts() {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    maxRetriesPerRequest: null as null,   // BullMQ requirement
  };
}

// ──────────────────────── Queue instances ────────────────────────

export const onchainSubmitQueue = new Queue('onchain-submit', {
  connection: redisOpts(),
  defaultJobOptions: {
    attempts: 5,  // 5 retries with 10s timeout each = max 50s before giving up
    backoff: { type: 'exponential', delay: 2000 },  // 2s, 4s, 8s, 16s backoff
    removeOnComplete: { count: 500 },  // keep last 500 completed jobs
    removeOnFail: { count: 200 },      // keep last 200 failed jobs
  },
});

export const dbSyncQueue = new Queue('db-sync', {
  connection: redisOpts(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

export const wsEventsQueue = new Queue('ws-events', {
  connection: redisOpts(),
  defaultJobOptions: {
    attempts: 1,           // best-effort – don't retry broadcasts
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
});

// ──────────────────────── Queue cleanup ──────────────────────────

/**
 * Drain all queues — removes waiting/delayed/active jobs.
 * Used before performance tests to ensure a clean slate.
 * Does NOT close the queues — they remain usable after draining.
 */
export async function drainAllQueues(): Promise<{ drained: Record<string, number> }> {
  const queues = [
    { name: 'onchain-submit', queue: onchainSubmitQueue },
    { name: 'db-sync', queue: dbSyncQueue },
    { name: 'ws-events', queue: wsEventsQueue },
  ];

  const drained: Record<string, number> = {};

  for (const { name, queue } of queues) {
    const counts = await queue.getJobCounts('waiting', 'delayed', 'active', 'failed', 'completed');
    const total = (counts.waiting || 0) + (counts.delayed || 0) + (counts.active || 0) + (counts.failed || 0);
    if (total > 0) {
      // Obliterate removes ALL jobs in ALL states (waiting, active, delayed, failed, completed)
      // force=true allows obliterating even when workers are running
      await queue.obliterate({ force: true });
    }
    drained[name] = total;
  }

  return { drained };
}

// ──────────────────────── Job type definitions ──────────────────

export interface OnchainSubmitJobData {
  type: 'match' | 'close' | 'settle' | 'batch-settle' | 'batch-settle-v3';
  idempotencyKey: string;
  payload: Record<string, any>;
}

export interface DbSyncJobData {
  tradeId?: string;
  makerOrderId?: string;
  takerOrderId?: string;
  txSignature: string;
  status: 'CONFIRMED' | 'FAILED';
  errorCode?: string;
}

export interface WsEventsJobData {
  channel: string;
  eventType: string;
  data: Record<string, any>;
}
