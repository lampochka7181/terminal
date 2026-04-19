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
// Strict UUID format check (8-4-4-4-12 hex). The matching service generates a
// non-UUID synthetic tradeId for one of its on-chain submission paths
// (`<takerOrderId>-<timestamp>`), and passing that into a `WHERE id = $1::uuid`
// clause makes Postgres throw `invalid input syntax for type uuid` — which
// previously bubbled out of the inner SELECT, was swallowed by the function-
// level try/catch, and skipped the takerOrderId fallback entirely. The result
// was that every duplicate-clientOrderId-failure (the loser of the dual-enqueue
// race) left its optimistic position update unreversed → phantom drift.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

async function reversePositionForFailedTrade(
  tradeId?: string,
  makerOrderId?: string,
  takerOrderId?: string
): Promise<{ affectedUserIds: string[]; marketAddress?: string }> {
  const result: { affectedUserIds: string[]; marketAddress?: string } = { affectedUserIds: [] };
  try {
    // Find the trade record(s) to get details for reversal.
    // Each lookup is wrapped so any single failure (invalid UUID, transient
    // DB error) doesn't abort the whole reversal — we want to fall through
    // to alternative identifiers and only give up after exhausting them.
    let tradeRecords: any[] = [];

    if (isUuid(tradeId)) {
      try {
        tradeRecords = await db.select().from(trades).where(eq(trades.id, tradeId));
      } catch (lookupErr: any) {
        logger.warn(`[QUEUE:db-sync] tradeId lookup failed (${tradeId}): ${lookupErr.message}`);
      }
    } else if (tradeId) {
      // Caller passed a synthetic non-UUID tradeId. Don't even attempt the
      // lookup — fall through to takerOrderId. This is the common case for
      // the executeFillsOnChain submission path.
      logger.debug(`[QUEUE:db-sync] Skipping non-UUID tradeId lookup: ${tradeId}`);
    }

    // If no trade found by ID, try by order IDs.
    if (tradeRecords.length === 0 && takerOrderId && takerOrderId !== 'pending') {
      try {
        tradeRecords = await db.select().from(trades).where(eq(trades.takerOrderId, takerOrderId));
      } catch (lookupErr: any) {
        logger.warn(`[QUEUE:db-sync] takerOrderId lookup failed (${takerOrderId}): ${lookupErr.message}`);
      }
    }

    // Last resort: makerOrderId. Less reliable because a single maker order
    // can be matched against many trades, but better than silently dropping.
    if (
      tradeRecords.length === 0 &&
      makerOrderId &&
      !makerOrderId.startsWith('mm_synth_') &&
      !makerOrderId.startsWith('mm_bailout_') &&
      !makerOrderId.startsWith('aggregated-mm-')
    ) {
      try {
        tradeRecords = await db.select().from(trades).where(eq(trades.makerOrderId, makerOrderId));
      } catch (lookupErr: any) {
        logger.warn(`[QUEUE:db-sync] makerOrderId lookup failed (${makerOrderId}): ${lookupErr.message}`);
      }
    }

    if (tradeRecords.length === 0) {
      // Elevated to WARN — silently skipping reversal is what produced the
      // 6.59 USDC phantom drift seen on 2026-04-18. This message is the only
      // signal that a position was inflated without being reversed.
      logger.warn(
        `[QUEUE:db-sync] No trade found for position reversal — phantom position likely. ` +
        `tradeId=${tradeId} makerOrderId=${makerOrderId} takerOrderId=${takerOrderId}`
      );
      return result;
    }

    for (const trade of tradeRecords) {
      // Skip if already reversed by a prior db-sync failure pass.
      // Some earlier failure paths stamp txStatus=FAILED before db-sync runs;
      // those trades still need one reversal pass, so only skip when an
      // errorCode is already present.
      if (trade.txStatus === 'FAILED' && trade.errorCode) {
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
        // Maker always acquires makerOutcome tokens, in both opening and closing trades:
        //   - Opening trade (taker BID): taker buys takerOutcome, maker acquires complementOutcome
        //   - Closing trade (taker ASK): taker sells, maker buys takerOutcome (same outcome)
        // In both cases the maker's position was incremented, so reversal must subtract.
        // Bug was: makerIsBuying = takerSide === 'ASK' treated opening-trade makers as sellers,
        // causing reversal to ADD shares instead of subtract → double phantom position.
        const makerIsBuying = true;
        await reverseUserPosition(
          trade.makerUserId,
          trade.marketId,
          makerOutcome,
          size,
          size * makerPrice,
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
 * Reverse a single user's position update — atomic, concurrency-safe.
 *
 * Buy reversal: subtract shares, reduce total cost.
 * Sell reversal: add shares back, undo realized PnL.
 *
 * Both operations are expressed as single SQL UPDATE statements that read
 * from the DB's live values (`positions.*`) rather than a JS-cached snapshot.
 * Under concurrent writes (e.g., reversal racing with a new fill's
 * `updateAfterTrade`, or two reversals for adjacent failed trades), this
 * serializes correctly at the primary-key row lock. The previous
 * SELECT→compute→UPDATE pattern lost updates under the same load that
 * produced ~0.1% position undercounts in perf testing.
 */
async function reverseUserPosition(
  userId: string,
  marketId: string,
  outcome: string,
  shares: number,
  cost: number,
  wasBuy: boolean
): Promise<void> {
  const isYes = outcome === 'YES';
  const sharesStr = shares.toString();
  const costStr = cost.toString();

  if (wasBuy) {
    // Reverse a buy: subtract shares and proportional total_cost. When the
    // reversal zeroes the side, also reset its avgEntry (no basis remains).
    if (isYes) {
      await db.execute(sql`
        UPDATE positions SET
          yes_shares    = GREATEST(0::numeric, positions.yes_shares - ${sharesStr}::numeric),
          total_cost    = GREATEST(0::numeric, positions.total_cost - ${costStr}::numeric),
          avg_entry_yes = CASE
            WHEN (positions.yes_shares - ${sharesStr}::numeric) <= 0 THEN 0::numeric
            ELSE positions.avg_entry_yes
          END,
          updated_at    = NOW()
        WHERE user_id = ${userId}::uuid AND market_id = ${marketId}::uuid
      `);
    } else {
      await db.execute(sql`
        UPDATE positions SET
          no_shares     = GREATEST(0::numeric, positions.no_shares - ${sharesStr}::numeric),
          total_cost    = GREATEST(0::numeric, positions.total_cost - ${costStr}::numeric),
          avg_entry_no  = CASE
            WHEN (positions.no_shares - ${sharesStr}::numeric) <= 0 THEN 0::numeric
            ELSE positions.avg_entry_no
          END,
          updated_at    = NOW()
        WHERE user_id = ${userId}::uuid AND market_id = ${marketId}::uuid
      `);
    }
  } else {
    // Reverse a sell: add shares back, restore cost basis (avg_entry * shares
    // of the added side), undo the realized PnL the original sell booked.
    if (isYes) {
      await db.execute(sql`
        UPDATE positions SET
          yes_shares    = positions.yes_shares + ${sharesStr}::numeric,
          total_cost    = positions.total_cost + positions.avg_entry_yes * ${sharesStr}::numeric,
          realized_pnl  = positions.realized_pnl
                          - (${costStr}::numeric - positions.avg_entry_yes * ${sharesStr}::numeric),
          updated_at    = NOW()
        WHERE user_id = ${userId}::uuid AND market_id = ${marketId}::uuid
      `);
    } else {
      await db.execute(sql`
        UPDATE positions SET
          no_shares     = positions.no_shares + ${sharesStr}::numeric,
          total_cost    = positions.total_cost + positions.avg_entry_no * ${sharesStr}::numeric,
          realized_pnl  = positions.realized_pnl
                          - (${costStr}::numeric - positions.avg_entry_no * ${sharesStr}::numeric),
          updated_at    = NOW()
        WHERE user_id = ${userId}::uuid AND market_id = ${marketId}::uuid
      `);
    }
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
  } else if (status === 'PENDING' && txSignature) {
    updateData.txSignature = txSignature;
    updateData.confirmedAt = null;
  } else if (status === 'FAILED') {
    updateData.txSignature = null;
    if (errorCode) {
      updateData.errorCode = errorCode;
    }
  }

  try {
    let updated = false;

    // Update by trade ID (most reliable). Gate on isUuid: same reason as the
    // reversal lookup — synthetic non-UUID tradeIds from executeFillsOnChain
    // would throw `invalid input syntax for type uuid` on this query and
    // abort the whole try block before the order-id fallbacks could run.
    if (isUuid(tradeId)) {
      await db.update(trades).set(updateData).where(eq(trades.id, tradeId));
      updated = true;
    }

    // Also update by order IDs (for matching trades)
    if (makerOrderId && !makerOrderId.startsWith('mm_synth_') && !makerOrderId.startsWith('mm_bailout_') && !makerOrderId.startsWith('aggregated-mm-')) {
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
