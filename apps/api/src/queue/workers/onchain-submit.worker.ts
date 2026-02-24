/**
 * On-chain Submit Worker
 *
 * Processes on-chain transaction submissions (matches, closes, settlements).
 * Replaces fire-and-forget calls with durable, retryable execution.
 *
 * Concurrency: 20 (can be tuned; must stay under Solana RPC rate limits).
 * Retries: 3 with exponential backoff.
 */

import { Worker, Job } from 'bullmq';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { transactionService } from '../../services/transaction.service.js';
import { relayerPoolService } from '../../services/relayer-pool.service.js';
import { marketService } from '../../services/market.service.js';
import { anchorClient } from '../../lib/anchor-client.js';
import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import { dbSyncQueue } from '../queues.js';
import type { OnchainSubmitJobData, DbSyncJobData } from '../queues.js';

// In-memory cache for market status checks (avoid DB query per on-chain job)
const marketStatusCache = new Map<string, { status: string; fetchedAt: number }>();
const MARKET_STATUS_CACHE_TTL_MS = 5_000; // 5 seconds

async function getCachedMarketStatus(pubkey: string): Promise<{ status: string } | null> {
  const cached = marketStatusCache.get(pubkey);
  if (cached && Date.now() - cached.fetchedAt < MARKET_STATUS_CACHE_TTL_MS) {
    return { status: cached.status };
  }
  try {
    const market = await marketService.getByPubkey(pubkey);
    if (market) {
      marketStatusCache.set(pubkey, { status: market.status, fetchedAt: Date.now() });
      return { status: market.status };
    }
  } catch {
    // If DB query fails, return null to allow the TX to proceed
  }
  return null;
}

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

/**
 * Execute a batch-settle job: call batchSettleV2 and update settlement_jobs table.
 */
async function executeBatchSettle(payload: Record<string, any>): Promise<{ success: boolean; signature?: string; error?: string; errorCode?: string }> {
  const { marketPubkey, bitmapChunkIndex, settlements: batchSettlements, marketId, batchIndex } = payload;

  try {
    // Mark as SUBMITTED
    await db.execute(sql`
      UPDATE settlement_jobs
      SET status = 'SUBMITTED', attempts = attempts + 1
      WHERE market_id = ${marketId}::uuid AND batch_index = ${batchIndex}
    `);

    // Convert JSON-safe strings back to BigInt/Buffer for on-chain call
    const deserializedSettlements = batchSettlements.map((s: any) => ({
      recipient: s.recipient,
      amount: BigInt(s.amount),
      index: s.index,
      proof: s.proof.map((p: string) => Buffer.from(p, 'hex')),
    }));

    const sig = await anchorClient.batchSettleV2({
      marketPubkey,
      bitmapChunkIndex: bitmapChunkIndex || 0,
      settlements: deserializedSettlements,
    });

    // Mark as COMPLETED
    await db.execute(sql`
      UPDATE settlement_jobs
      SET status = 'COMPLETED', tx_signature = ${sig}, completed_at = NOW()
      WHERE market_id = ${marketId}::uuid AND batch_index = ${batchIndex}
    `);

    return { success: true, signature: sig };
  } catch (err: any) {
    const msg = err.message || '';

    if (msg.includes('AlreadyClaimed')) {
      // Already settled — mark as completed
      await db.execute(sql`
        UPDATE settlement_jobs
        SET status = 'COMPLETED', completed_at = NOW()
        WHERE market_id = ${marketId}::uuid AND batch_index = ${batchIndex}
      `);
      return { success: true, signature: 'already_claimed' };
    }

    // Mark as FAILED
    await db.execute(sql`
      UPDATE settlement_jobs
      SET status = 'FAILED', error_message = ${msg}
      WHERE market_id = ${marketId}::uuid AND batch_index = ${batchIndex}
    `);

    return { success: false, error: msg };
  }
}

async function processJob(job: Job<OnchainSubmitJobData>): Promise<void> {
  const { type, idempotencyKey, payload } = job.data;

  const jobStartMs = Date.now();
  logger.info(`[QUEUE:onchain] Processing ${type} job: ${idempotencyKey} (attempt ${job.attemptsMade + 1})`);

  // Try to acquire a relayer from the pool (falls back to default relayer if pool is empty)
  const acquired = await relayerPoolService.acquireRelayer().catch(() => null);
  const relayerPubkey = acquired?.pubkey;

  let result: { success: boolean; signature?: string; error?: string; errorCode?: string };

  // Pre-flight check: skip match/close jobs if market is no longer OPEN
  // Uses in-memory cache (5s TTL) to avoid DB pressure during sustained load
  if (type === 'match' || type === 'close') {
    try {
      const marketPubkey = (payload as any).marketPubkey;
      if (marketPubkey) {
        const market = await getCachedMarketStatus(marketPubkey);
        if (market && market.status !== 'OPEN') {
          logger.warn(`[QUEUE:onchain] Skipping ${type} job — market ${market.status}: ${idempotencyKey}`);
          // Enqueue DB sync to mark as failed
          const syncData: DbSyncJobData = {
            tradeId: (payload as any).tradeId,
            makerOrderId: (payload as any).makerOrderId,
            takerOrderId: (payload as any).takerOrderId,
            txSignature: '',
            status: 'FAILED',
            errorCode: 'MARKET_CLOSED',
          };
          await dbSyncQueue.add('db-sync', syncData, {
            jobId: `dbsync-skip-${idempotencyKey}`,
          });
          if (relayerPubkey) {
            await relayerPoolService.releaseRelayer(relayerPubkey, false).catch(() => {});
          }
          return;
        }
      }
    } catch (err: any) {
      // Non-fatal: proceed with the TX if we can't check market status
      logger.debug(`[QUEUE:onchain] Market status pre-check failed (non-fatal): ${err.message}`);
    }
  }

  try {
    switch (type) {
      case 'match':
        result = await transactionService.executeMatch(payload as any);
        break;
      case 'close':
        result = await transactionService.executeClose(payload as any);
        break;
      case 'settle':
        result = await transactionService.executeSettlement(payload as any);
        break;
      case 'batch-settle':
        result = await executeBatchSettle(payload);
        break;
      default:
        throw new Error(`Unknown job type: ${type}`);
    }
  } catch (err: any) {
    // Release relayer on exception
    if (relayerPubkey) {
      await relayerPoolService.releaseRelayer(relayerPubkey, false).catch(() => {});
    }
    throw err;
  }

  // Release the relayer
  if (relayerPubkey) {
    await relayerPoolService.releaseRelayer(relayerPubkey, result.success).catch(() => {});
  }

  if (result.success) {
    const onchainMs = Date.now() - jobStartMs;
    logger.info(`[QUEUE:onchain] ${type} success: ${result.signature} (${idempotencyKey}) [${onchainMs}ms]`);

    // Enqueue DB sync job to persist the result
    if (type === 'match' || type === 'close') {
      const syncData: DbSyncJobData = {
        tradeId: payload.tradeId,
        makerOrderId: payload.makerOrderId,
        takerOrderId: payload.takerOrderId,
        txSignature: result.signature || '',
        status: 'CONFIRMED',
      };
      await dbSyncQueue.add('db-sync', syncData, {
        jobId: `dbsync-${idempotencyKey}`,
      });
    }
  } else {
    // Check if this is a permanent error that should not be retried
    const permanentCodes = ['INSUFFICIENT_FUNDS', 'INSUFFICIENT_SHARES', 'FEE_TOO_LOW',
      'POSITION_LIMIT', 'MARKET_CLOSED', 'INVALID_SIGNATURE', 'SELF_TRADE', 'ACCOUNT_NOT_FOUND'];

    if (result.errorCode && permanentCodes.includes(result.errorCode)) {
      logger.warn(`[QUEUE:onchain] Permanent failure for ${idempotencyKey}: ${result.errorCode}`);

      // Enqueue DB sync to mark as failed
      const syncData: DbSyncJobData = {
        tradeId: payload.tradeId,
        makerOrderId: payload.makerOrderId,
        takerOrderId: payload.takerOrderId,
        txSignature: '',
        status: 'FAILED',
        errorCode: result.errorCode,
      };
      await dbSyncQueue.add('db-sync', syncData, {
        jobId: `dbsync-fail-${idempotencyKey}`,
      });

      // Don't throw — permanent failures should not be retried
      return;
    }

    // Transient error — throw to trigger BullMQ retry
    throw new Error(`${type} failed: ${result.error} (${result.errorCode || 'UNKNOWN'})`);
  }
}

export function startOnchainSubmitWorker(): Worker {
  // TX throughput depends on the sending method:
  // - Standard sendTransaction: 5 tx/sec (Helius Dev plan limit)
  // - Helius Sender: 15 tx/sec (dual-routed via Jito, free, no credits)
  // - Multiple RPC endpoints: add throughput (but free Solana RPC is limited)
  // NOTE: Use anchorClient.isSenderEnabled (not config) because Sender auto-disables on devnet
  const useSender = anchorClient.isSenderEnabled;
  const extraRpcCount = [config.solanaRpcUrl2, config.solanaRpcUrl3].filter(Boolean).length;
  const baseTxPerSec = useSender ? 15 : 5;
  // Free Solana public RPC only adds ~2 tx/s (4 RPC/s total limit shared between send+confirm)
  // Paid RPCs (Alchemy, QuickNode) add ~5 tx/s each
  const extraTxPerSec = extraRpcCount * 2;
  const ratePerSec = baseTxPerSec + extraTxPerSec;

  // Concurrency = max in-flight jobs. Each job holds a slot for ~10-15s on devnet (confirmation time).
  // Too high → confirmation polling overwhelms RPC rate limits (each active job polls ~0.5 RPC/s).
  // Formula: ratePerSec × avgConfirmTimeSec, capped conservatively.
  // With 7 tx/s and ~10s confirm time, we need ~70 slots. But polling overhead limits us to ~40.
  const concurrency = Math.min(ratePerSec * 5, 50);  // Cap at 50 to limit confirmation polling load

  const worker = new Worker('onchain-submit', processJob, {
    connection: redisOpts(),
    concurrency,
    limiter: {
      // Use 1-second window to prevent bursts that trigger 429s.
      // Previously used 10s window which allowed 100 jobs to start instantly → RPC flood.
      max: ratePerSec,
      duration: 1_000,
    },
  });

  worker.on('failed', (job, err) => {
    logger.warn(`[QUEUE:onchain] Job ${job?.id} failed: ${err.message}`);
  });

  worker.on('error', (err) => {
    logger.error(`[QUEUE:onchain] Worker error: ${err.message}`);
  });

  const rpcCount = 1 + extraRpcCount;
  const sendMethod = useSender ? 'Helius Sender' : 'standard sendTransaction';
  logger.info(`[QUEUE:onchain] Worker started (concurrency=${concurrency}, rate=${ratePerSec}/s, ${rpcCount} RPC(s), ${sendMethod})`);
  return worker;
}
