/**
 * Database Sync Worker
 *
 * Persists on-chain transaction results to Postgres.
 * Idempotent: uses trade IDs as natural dedup keys.
 *
 * When marking trades as FAILED, also reverses position updates
 * that were optimistically applied during off-chain matching.
 *
 * Concurrency: 20.
 */

import { Worker, Job } from 'bullmq';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { db, trades, positions } from '../../db/index.js';
import { eq, and, or, sql } from 'drizzle-orm';
import type { DbSyncJobData } from '../queues.js';
import { wsEventsQueue } from '../queues.js';

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
 * Reverse position updates for a failed trade.
 *
 * When a trade is matched off-chain, positions are optimistically updated
 * before the on-chain TX confirms. If the TX fails, we need to undo those
 * position changes so the user's shares reflect reality.
 */
async function reversePositionForFailedTrade(
  tradeId?: string,
  makerOrderId?: string,
  takerOrderId?: string
): Promise<{ affectedUserIds: string[]; marketAddress?: string }> {
  const result: { affectedUserIds: string[]; marketAddress?: string } = { affectedUserIds: [] };
  try {
    // Find the trade record(s) to get details for reversal
    let tradeRecords: any[] = [];

    if (tradeId) {
      const result = await db.select().from(trades).where(eq(trades.id, tradeId));
      tradeRecords = result;
    }

    // If no trade found by ID, try by order IDs
    if (tradeRecords.length === 0 && takerOrderId && takerOrderId !== 'pending') {
      const result = await db.select().from(trades).where(eq(trades.takerOrderId, takerOrderId));
      tradeRecords = result;
    }

    if (tradeRecords.length === 0) {
      logger.debug(`[QUEUE:db-sync] No trade found for position reversal (tradeId=${tradeId})`);
      return result;
    }

    for (const trade of tradeRecords) {
      // Skip if already reversed (txStatus was already FAILED before this run)
      if (trade.txStatus === 'FAILED') {
        logger.debug(`[QUEUE:db-sync] Trade ${trade.id} already FAILED, skipping reversal`);
        continue;
      }

      const size = parseFloat(trade.size || '0');
      if (size <= 0) continue;

      const takerSide = trade.takerSide; // 'BID' or 'ASK'
      const takerOutcome = trade.takerOutcome; // 'YES' or 'NO'
      const makerOutcome = trade.makerOutcome;
      const takerPrice = parseFloat(trade.takerPrice || '0');
      const makerPrice = parseFloat(trade.makerPrice || '0');

      // Reverse for taker
      if (trade.takerUserId && trade.marketId) {
        const takerIsBuying = takerSide === 'BID';
        await reverseUserPosition(
          trade.takerUserId,
          trade.marketId,
          takerOutcome,
          size,
          takerIsBuying ? size * takerPrice : size * takerPrice, // cost/proceeds
          takerIsBuying
        );
        result.affectedUserIds.push(trade.takerUserId);
      }

      // Reverse for maker
      if (trade.makerUserId && trade.marketId) {
        const makerIsBuying = takerSide === 'ASK'; // maker buys when taker sells
        await reverseUserPosition(
          trade.makerUserId,
          trade.marketId,
          makerOutcome,
          size,
          makerIsBuying ? size * makerPrice : size * makerPrice,
          makerIsBuying
        );
        result.affectedUserIds.push(trade.makerUserId);
      }

      // Track market for WS notification
      if (trade.marketId) {
        result.marketAddress = trade.marketId;
      }

      logger.info(`[QUEUE:db-sync] Reversed position for failed trade ${trade.id} (${size} shares)`);
    }
  } catch (err: any) {
    // Non-fatal: position may be slightly off until reconciliation
    logger.error(`[QUEUE:db-sync] Position reversal failed: ${err.message}`);
  }
  return result;
}

/**
 * Reverse a single user's position update.
 * Buy reversal: subtract shares, reduce total cost
 * Sell reversal: add shares back, undo realized PnL
 */
async function reverseUserPosition(
  userId: string,
  marketId: string,
  outcome: string,
  shares: number,
  cost: number,
  wasBuy: boolean
): Promise<void> {
  const userPositions = await db
    .select()
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.marketId, marketId)))
    .limit(1);

  if (userPositions.length === 0) return;

  const pos = userPositions[0];
  const isYes = outcome === 'YES';

  if (wasBuy) {
    // Reverse a buy: subtract shares and cost
    const currentShares = parseFloat(isYes ? pos.yesShares || '0' : pos.noShares || '0');
    const newShares = Math.max(0, currentShares - shares);
    const currentCost = parseFloat(pos.totalCost || '0');
    const newCost = Math.max(0, currentCost - cost);

    const updates: Record<string, any> = {
      totalCost: newCost.toString(),
      updatedAt: new Date(),
    };

    if (isYes) {
      updates.yesShares = newShares.toString();
      // Recalculate avgEntry if shares remain, otherwise reset
      if (newShares <= 0) updates.avgEntryYes = '0';
    } else {
      updates.noShares = newShares.toString();
      if (newShares <= 0) updates.avgEntryNo = '0';
    }

    await db.update(positions).set(updates).where(eq(positions.id, pos.id));
  } else {
    // Reverse a sell: add shares back, undo realized PnL
    const currentShares = parseFloat(isYes ? pos.yesShares || '0' : pos.noShares || '0');
    const newShares = currentShares + shares;
    const avgEntry = parseFloat(isYes ? pos.avgEntryYes || '0' : pos.avgEntryNo || '0');
    const costBasis = avgEntry * shares;
    const realizedPnl = cost - costBasis;
    const currentRealizedPnl = parseFloat(pos.realizedPnl || '0');

    const updates: Record<string, any> = {
      realizedPnl: (currentRealizedPnl - realizedPnl).toString(),
      totalCost: (parseFloat(pos.totalCost || '0') + costBasis).toString(),
      updatedAt: new Date(),
    };

    if (isYes) {
      updates.yesShares = newShares.toString();
    } else {
      updates.noShares = newShares.toString();
    }

    await db.update(positions).set(updates).where(eq(positions.id, pos.id));
  }
}

async function processJob(job: Job<DbSyncJobData>): Promise<void> {
  const { tradeId, makerOrderId, takerOrderId, txSignature, status, errorCode } = job.data;

  logger.debug(`[QUEUE:db-sync] Syncing trade status: sig=${txSignature?.slice(0, 16)}... status=${status}`);

  // If marking as FAILED, reverse the optimistic position update FIRST
  let reversal: { affectedUserIds: string[]; marketAddress?: string } = { affectedUserIds: [] };
  if (status === 'FAILED') {
    reversal = await reversePositionForFailedTrade(tradeId, makerOrderId, takerOrderId);
  }

  const updateData: Record<string, any> = {
    txStatus: status,
  };

  if (status === 'CONFIRMED' && txSignature) {
    updateData.txSignature = txSignature;
    updateData.confirmedAt = new Date();
  } else if (status === 'FAILED') {
    updateData.txSignature = null;
    if (errorCode) {
      updateData.errorCode = errorCode;
    }
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

    if (status === 'FAILED') {
      logger.warn(`[QUEUE:db-sync] Trade marked FAILED (${errorCode || 'UNKNOWN'}): tradeId=${tradeId}, maker=${makerOrderId}, taker=${takerOrderId}`);

      // Push WebSocket notification to affected users so frontend removes phantom positions
      for (const userId of reversal.affectedUserIds) {
        try {
          await wsEventsQueue.add('ws-events', {
            channel: 'user',
            eventType: 'trade_failed',
            data: {
              userId,
              tradeId: tradeId || '',
              marketAddress: reversal.marketAddress || '',
              errorCode: errorCode || 'UNKNOWN',
            },
          }, {
            jobId: `ws-trade-failed-${tradeId || takerOrderId}-${userId}`,
          });
        } catch (wsErr: any) {
          logger.debug(`[QUEUE:db-sync] Failed to enqueue trade_failed WS event: ${wsErr.message}`);
        }
      }
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
