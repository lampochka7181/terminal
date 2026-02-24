/**
 * Database Sync Worker
 *
 * Persists on-chain transaction results to Postgres.
 * Idempotent: uses trade IDs as natural dedup keys.
 *
 * Concurrency: 50.
 */

import { Worker, Job } from 'bullmq';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { db, trades } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import type { DbSyncJobData } from '../queues.js';

function redisOpts() {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    maxRetriesPerRequest: null as null,
  };
}

async function processJob(job: Job<DbSyncJobData>): Promise<void> {
  const { tradeId, makerOrderId, takerOrderId, txSignature, status, errorCode } = job.data;

  logger.debug(`[QUEUE:db-sync] Syncing trade status: sig=${txSignature?.slice(0, 16)}... status=${status}`);

  const updateData: Record<string, any> = {
    txStatus: status,
  };

  if (status === 'CONFIRMED' && txSignature) {
    updateData.txSignature = txSignature;
    updateData.confirmedAt = new Date();
  } else if (status === 'FAILED') {
    updateData.txSignature = null;
    // Store error info if needed (could add a column later)
  }

  try {
    let updated = false;

    // Update by trade ID (most reliable)
    if (tradeId) {
      await db.update(trades).set(updateData).where(eq(trades.id, tradeId));
      updated = true;
    }

    // Also update by order IDs (for matching trades)
    if (makerOrderId && !makerOrderId.startsWith('mm_synth_') && !makerOrderId.startsWith('aggregated-mm-')) {
      await db.update(trades).set(updateData).where(eq(trades.makerOrderId, makerOrderId));
      updated = true;
    }

    if (takerOrderId && takerOrderId !== 'pending' && !takerOrderId.startsWith('mm_synth_')) {
      await db.update(trades).set(updateData).where(eq(trades.takerOrderId, takerOrderId));
      updated = true;
    }

    if (!updated) {
      logger.warn(`[QUEUE:db-sync] No identifier to update trade: tradeId=${tradeId}, maker=${makerOrderId}, taker=${takerOrderId}`);
    }
  } catch (err: any) {
    logger.error(`[QUEUE:db-sync] Failed to sync trade: ${err.message}`);
    throw err; // Rethrow for BullMQ retry
  }
}

export function startDbSyncWorker(): Worker {
  const worker = new Worker('db-sync', processJob, {
    connection: redisOpts(),
    concurrency: 20,
  });

  worker.on('failed', (job, err) => {
    logger.warn(`[QUEUE:db-sync] Job ${job?.id} failed: ${err.message}`);
  });

  worker.on('error', (err) => {
    logger.error(`[QUEUE:db-sync] Worker error: ${err.message}`);
  });

  logger.info('[QUEUE:db-sync] Worker started (concurrency=20)');
  return worker;
}
