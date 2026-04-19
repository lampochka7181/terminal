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
import { triggerMerkleSettlement } from '../../jobs/merkle-settler.js';

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
 * After a batch-settle completes, check if all batches for the market are done.
 * If so, immediately trigger merkle finalization (eliminates ~9s polling gap).
 */
async function checkAndTriggerSettlementCompletion(marketId: string): Promise<void> {
  try {
    const pending = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM settlement_jobs
      WHERE market_id = ${marketId}::uuid AND status NOT IN ('COMPLETED')
    `);
    if (((pending.rows?.[0] as any)?.cnt || 0) === 0) {
      logger.info(`[QUEUE:onchain] All batches complete for ${marketId}, triggering finalization`);
      triggerMerkleSettlement(marketId).catch(err => {
        logger.warn(`[QUEUE:onchain] Merkle trigger failed for ${marketId}: ${(err as Error).message}`);
      });
    }
  } catch (err: any) {
    logger.debug(`[QUEUE:onchain] Completion check failed (non-fatal): ${err.message}`);
  }
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

    if ((bitmapChunkIndex || 0) > 0) {
      try {
        await anchorClient.initSettlementBitmapChunk({
          marketPubkey,
          chunkIndex: bitmapChunkIndex,
        });
      } catch (err: any) {
        if (!String(err.message || '').includes('already in use')) {
          throw err;
        }
      }
    }

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

    // Check if all batches done → trigger finalization immediately
    await checkAndTriggerSettlementCompletion(marketId);

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
      // Check if all batches done → trigger finalization immediately
      await checkAndTriggerSettlementCompletion(marketId);
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

/**
 * Execute a V3 compact batch-settle job: call batchSettleV3 and update settlement_jobs table.
 */
async function executeBatchSettleV3(payload: Record<string, any>): Promise<{ success: boolean; signature?: string; error?: string; errorCode?: string }> {
  const { marketPubkey, bitmapChunkIndex, startIndex, subtreeSize, settlements: batchSettlements, bridgeProof, marketId, batchIndex, lookupTablePubkey } = payload;

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
    }));

    const deserializedBridgeProof = bridgeProof.map((p: string) =>
      new Uint8Array(Buffer.from(p, 'hex'))
    );

    if ((bitmapChunkIndex || 0) > 0) {
      try {
        await anchorClient.initSettlementBitmapChunk({
          marketPubkey,
          chunkIndex: bitmapChunkIndex,
        });
      } catch (err: any) {
        if (!String(err.message || '').includes('already in use')) {
          throw err;
        }
      }
    }

    const sig = await anchorClient.batchSettleV3({
      marketPubkey,
      bitmapChunkIndex: bitmapChunkIndex || 0,
      startIndex,
      subtreeSize,
      settlements: deserializedSettlements,
      bridgeProof: deserializedBridgeProof,
      lookupTablePubkey,
    });

    // Mark as COMPLETED
    await db.execute(sql`
      UPDATE settlement_jobs
      SET status = 'COMPLETED', tx_signature = ${sig}, completed_at = NOW()
      WHERE market_id = ${marketId}::uuid AND batch_index = ${batchIndex}
    `);

    // Check if all batches done → trigger finalization immediately
    await checkAndTriggerSettlementCompletion(marketId);

    return { success: true, signature: sig };
  } catch (err: any) {
    const msg = err.message || '';

    if (msg.includes('AlreadyClaimed')) {
      await db.execute(sql`
        UPDATE settlement_jobs
        SET status = 'COMPLETED', completed_at = NOW()
        WHERE market_id = ${marketId}::uuid AND batch_index = ${batchIndex}
      `);
      await checkAndTriggerSettlementCompletion(marketId);
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

  // Acquire a fee payer from the pool (child wallet → master1 → master2 fallback)
  const acquired = await relayerPoolService.acquireFeePayer().catch(() => null);
  const feePayerPubkey = acquired?.pubkey;

  let result: { success: boolean; signature?: string; pendingConfirmation?: boolean; error?: string; errorCode?: string };

  // Pre-flight check: skip match/close jobs if market is no longer OPEN
  // Uses in-memory cache (5s TTL) to avoid DB pressure during sustained load
  if (type === 'match' || type === 'close') {
    try {
      const marketPubkey = (payload as any).marketPubkey;
      if (marketPubkey) {
        const market = await getCachedMarketStatus(marketPubkey);
        if (market && market.status !== 'OPEN') {
          logger.warn(`[QUEUE:onchain] Skipping ${type} job — market ${market.status}: ${idempotencyKey}`);
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
          if (feePayerPubkey) {
            await relayerPoolService.releaseFeePayer(feePayerPubkey, false, acquired?.isMaster).catch(() => {});
          }
          return;
        }
      }
    } catch (err: any) {
      logger.debug(`[QUEUE:onchain] Market status pre-check failed (non-fatal): ${err.message}`);
    }
  }

  try {
    switch (type) {
      case 'match':
        result = await transactionService.executeMatch({
          ...(payload as any),
          feePayerKeypair: acquired?.keypair,
        });
        break;
      case 'close':
        result = await transactionService.executeClose({
          ...(payload as any),
          feePayerKeypair: acquired?.keypair,
        });
        break;
      case 'settle':
        throw new Error('V1 settlement removed — use batch-settle (merkle) instead');
        break;
      case 'batch-settle':
        result = await executeBatchSettle(payload);
        break;
      case 'batch-settle-v3':
        result = await executeBatchSettleV3(payload);
        break;
      default:
        throw new Error(`Unknown job type: ${type}`);
    }
  } catch (err: any) {
    // Check if failure is due to insufficient SOL on this fee payer
    const isSolError = err.message?.includes('insufficient lamports') ||
                        err.message?.includes('Attempt to debit');

    if (feePayerPubkey) {
      await relayerPoolService.releaseFeePayer(feePayerPubkey, false, acquired?.isMaster).catch(() => {});
    }

    if (isSolError && acquired && !acquired.isMaster) {
      logger.warn(`[QUEUE:onchain] Fee payer ${feePayerPubkey?.slice(0, 8)} out of SOL, will retry with different wallet`);
    }

    throw err;
  }

  // Release the fee payer
  if (feePayerPubkey) {
    await relayerPoolService.releaseFeePayer(feePayerPubkey, result.success, acquired?.isMaster).catch(() => {});
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
        status: result.pendingConfirmation ? 'PENDING' : 'CONFIRMED',
      };
      await dbSyncQueue.add('db-sync', syncData, {
        jobId: `dbsync-${idempotencyKey}`,
      });
    }
  } else {
    // Check if this is a permanent error that should not be retried
    // Note: RPC_RATE_LIMITED / RPC_TIMEOUT are emitted by the transaction
    // service only after it has exhausted its own, longer backpressure
    // retry budget. At that point there's no value in BullMQ piling on
    // another round of retries — we want to mark the trade as FAILED with
    // a distinct code the UI can recognize.
    const permanentCodes = ['INSUFFICIENT_FUNDS', 'INSUFFICIENT_SHARES', 'FEE_TOO_LOW',
      'POSITION_LIMIT', 'MARKET_CLOSED', 'INVALID_SIGNATURE', 'SELF_TRADE', 'ACCOUNT_NOT_FOUND',
      'INSUFFICIENT_LAMPORTS', 'MAX_RETRIES', 'ACCOUNT_DESERIALIZATION', 'ACCOUNT_SERIALIZATION',
      'CONSTRAINT_VIOLATION', 'RPC_RATE_LIMITED', 'RPC_TIMEOUT'];

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

  // Concurrency = max in-flight jobs. Each job holds a slot for the full
  // confirmation window (~10-15s on devnet), so concurrency × per-slot-RPC-cost
  // drives sustained per-method load on the RPC provider.
  //
  // With an HTTP-only Connection (no WS endpoint), each slot polls
  // getSignatureStatuses ~5 req/s, so e.g. 25 slots => 125 req/s on that one
  // method, which trips Helius per-method limits long before the plan's
  // overall tx/s budget. With wsEndpoint configured, confirmation is a single
  // signatureSubscribe per slot and the per-slot cost is near zero.
  //
  // Allow explicit override via RPC_CONFIRM_CONCURRENCY so operators can
  // match their RPC plan without editing code (e.g. set low on Helius Dev,
  // raise on Business once WS is in place).
  const defaultConcurrency = Math.min(ratePerSec * 5, 50);
  const concurrency = config.rpcConfirmConcurrency > 0
    ? config.rpcConfirmConcurrency
    : defaultConcurrency;
  logger.info(
    `[QUEUE:onchain] concurrency=${concurrency} ` +
    `(override=${config.rpcConfirmConcurrency > 0 ? 'yes' : 'no'}, ` +
    `default=${defaultConcurrency}, ratePerSec=${ratePerSec})`
  );

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

  worker.on('failed', async (job, err) => {
    if (!job) {
      logger.warn(`[QUEUE:onchain] Job (unknown) failed: ${err.message}`);
      return;
    }

    const maxAttempts = job.opts?.attempts ?? 5;
    const isFinalFailure = job.attemptsMade >= maxAttempts;
    const { type, idempotencyKey, payload } = job.data;

    logger.warn(`[QUEUE:onchain] Job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${err.message}`);

    // On final BullMQ failure, mark trade as FAILED in DB (safety net)
    if (isFinalFailure && (type === 'match' || type === 'close')) {
      logger.error(`[QUEUE:onchain] FINAL FAILURE for ${type} job ${idempotencyKey} — marking trade as FAILED`);
      try {
        const syncData: DbSyncJobData = {
          tradeId: payload.tradeId,
          makerOrderId: payload.makerOrderId,
          takerOrderId: payload.takerOrderId,
          txSignature: '',
          status: 'FAILED',
          errorCode: 'MAX_RETRIES_EXHAUSTED',
        };
        await dbSyncQueue.add('db-sync', syncData, {
          jobId: `dbsync-exhausted-${idempotencyKey}`,
        });
      } catch (syncErr: any) {
        logger.error(`[QUEUE:onchain] Failed to enqueue db-sync for failed job: ${syncErr.message}`);
      }
    }
  });

  worker.on('error', (err) => {
    logger.error(`[QUEUE:onchain] Worker error: ${err.message}`);
  });

  const rpcCount = 1 + extraRpcCount;
  const sendMethod = useSender ? 'Helius Sender' : 'standard sendTransaction';
  logger.info(`[QUEUE:onchain] Worker started (concurrency=${concurrency}, rate=${ratePerSec}/s, ${rpcCount} RPC(s), ${sendMethod})`);
  return worker;
}
