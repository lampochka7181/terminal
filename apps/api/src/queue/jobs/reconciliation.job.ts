/**
 * Reconciliation Job
 *
 * Runs every 60s as a keeper job. Finds trades with txStatus = 'PENDING'
 * older than 2 minutes and reconciles them:
 *   - If the signature is confirmed on-chain → update DB to CONFIRMED
 *   - If the signature is not found on-chain  → re-enqueue to onchain-submit
 *
 * This ensures no trades are permanently lost if the process crashes after
 * matching but before on-chain submission completes.
 */

import { db, trades } from '../../db/index.js';
import { eq, and, lt, isNull, or, like } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { onchainSubmitQueue } from '../queues.js';
import { anchorClient } from '../../lib/anchor-client.js';

const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

export async function reconciliationJob(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  // Find stale PENDING trades (no confirmed signature, older than 2 min)
  const staleTrades = await db
    .select({
      id: trades.id,
      makerOrderId: trades.makerOrderId,
      takerOrderId: trades.takerOrderId,
      txSignature: trades.txSignature,
      txStatus: trades.txStatus,
    })
    .from(trades)
    .where(
      and(
        eq(trades.txStatus, 'PENDING'),
        lt(trades.executedAt, cutoff),
      ),
    )
    .limit(50); // Process in batches

  if (staleTrades.length === 0) return;

  logger.info(`[RECONCILE] Found ${staleTrades.length} stale PENDING trades`);

  for (const trade of staleTrades) {
    try {
      const sig = trade.txSignature;

      // If we have a signature, check if it's actually confirmed on-chain
      if (sig && !sig.startsWith('sim_') && anchorClient.isReady()) {
        const confirmed = await checkOnchainConfirmation(sig);

        if (confirmed) {
          // It was confirmed! Update DB to CONFIRMED
          await db.update(trades).set({
            txStatus: 'CONFIRMED',
            confirmedAt: new Date(),
          }).where(eq(trades.id, trade.id));

          logger.info(`[RECONCILE] Trade ${trade.id} was confirmed on-chain: ${sig}`);
          continue;
        }
      }

      // Not confirmed — re-enqueue for on-chain submission
      const idempotencyKey = `reconcile-${trade.id}-${Date.now()}`;

      logger.info(`[RECONCILE] Re-enqueueing trade ${trade.id} (sig=${sig?.slice(0, 16) || 'none'})`);

      // Re-enqueue to BullMQ for on-chain submission
      // The worker needs the trade's match params — fetch from the trade record
      await onchainSubmitQueue.add('match', {
        type: 'match' as const,
        idempotencyKey,
        payload: {
          tradeId: trade.id,
          makerOrderId: trade.makerOrderId,
          takerOrderId: trade.takerOrderId,
          // The onchain-submit worker will use these IDs to look up full params
          // For reconciliation, we re-enqueue with what we have
        },
      }, {
        jobId: idempotencyKey,
      }).catch((err: any) => {
        logger.error(`[RECONCILE] Failed to enqueue trade ${trade.id}: ${err.message}`);
      });

      // Mark as re-queued to prevent re-processing on next cycle
      await db.update(trades).set({
        txSignature: `requeued_${Date.now()}`,
      }).where(eq(trades.id, trade.id));

    } catch (err: any) {
      logger.error(`[RECONCILE] Error processing trade ${trade.id}: ${err.message}`);
    }
  }
}

/**
 * Check if a transaction signature is confirmed on-chain via RPC.
 */
async function checkOnchainConfirmation(signature: string): Promise<boolean> {
  try {
    const connection = anchorClient.getConnection?.();
    if (!connection) return false;

    const result = await connection.getSignatureStatus(signature);
    if (result?.value?.confirmationStatus === 'confirmed' || result?.value?.confirmationStatus === 'finalized') {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
