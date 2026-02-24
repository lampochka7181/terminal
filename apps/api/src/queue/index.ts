/**
 * BullMQ Queue Infrastructure
 *
 * Provides durable, retryable async pipelines for:
 *   - On-chain transaction submission (matches, closes, settlements)
 *   - Database sync after on-chain confirmation
 *   - WebSocket event broadcasting
 *
 * Uses the existing Redis connection (ioredis) for zero additional infra cost.
 */

import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { onchainSubmitQueue, dbSyncQueue, wsEventsQueue } from './queues.js';
import { startOnchainSubmitWorker } from './workers/onchain-submit.worker.js';
import { startDbSyncWorker } from './workers/db-sync.worker.js';
import { startWsEventsWorker } from './workers/ws-events.worker.js';
import type { Worker } from 'bullmq';

const workers: Worker[] = [];

/**
 * Start all BullMQ workers.
 * Call this once from the app entry point after Redis is connected.
 */
export async function startQueueWorkers(): Promise<void> {
  logger.info('[QUEUE] Starting BullMQ workers...');

  workers.push(startOnchainSubmitWorker());
  workers.push(startDbSyncWorker());
  workers.push(startWsEventsWorker());

  logger.info(`[QUEUE] ${workers.length} workers started`);
}

/**
 * Gracefully shut down all workers and close queues.
 */
export async function stopQueueWorkers(): Promise<void> {
  logger.info('[QUEUE] Stopping BullMQ workers...');

  await Promise.all(workers.map(w => w.close()));
  await Promise.all([
    onchainSubmitQueue.close(),
    dbSyncQueue.close(),
    wsEventsQueue.close(),
  ]);

  workers.length = 0;
  logger.info('[QUEUE] All workers stopped');
}

export { onchainSubmitQueue, dbSyncQueue, wsEventsQueue } from './queues.js';
