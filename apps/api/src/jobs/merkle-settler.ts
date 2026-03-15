import { eq, and, inArray, sql } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import { db, markets, positions, settlements, trades, users } from '../db/index.js';
import { positionService } from '../services/position.service.js';
import { marketService } from '../services/market.service.js';
import { anchorClient, getYesMintPda, getNoMintPda, fetchMarketV2OnChainState } from '../lib/anchor-client.js';
import { syncMarketStatusFromChain } from '../lib/chain-sync.js';
import { buildMerkleTree, createSettlementLeaf, verifyMerkleProof, verifyCompactBridgeProof, type SettlementLeaf, type MerkleTree } from '../lib/merkle-tree.js';
import { broadcastUserSettlement } from '../lib/broadcasts.js';
import { onchainSubmitQueue } from '../queue/queues.js';
import { tryAdvisoryLock, releaseAdvisoryLock } from '../lib/advisory-lock.js';
import { logger, logEvents } from '../lib/logger.js';

/**
 * Merkle Settler Job (V2 — Parallel via BullMQ + Relayer Pool)
 *
 * Settlement pipeline:
 *   1. Snapshot winners from DB
 *   2. Build merkle tree
 *   3. Post merkle root on-chain (RESOLVED → SETTLING)
 *   4. Create settlement_jobs rows (one per batch of 15 recipients)
 *   5. Enqueue each batch to BullMQ onchain-submit queue
 *   6. Wait for all batches to complete (checked each cycle)
 *   7. Burn remaining share tokens (PermanentDelegate) → supply = 0
 *   8. Finalize market on-chain (SETTLING → SETTLED, close mints + vault + PDA)
 *   9. Sync DB
 *
 * With 5 relayers, a market with 100 positions (7 batches of 15)
 * settles in ~2 rounds instead of 7 sequential transactions.
 */

// Concurrency guard — one market at a time
const processingMarkets = new Set<string>();

// Track consecutive failures per market to avoid infinite retry loops
const marketFailureCount = new Map<string, number>();
const MAX_SETTLEMENT_FAILURES = 10; // After 10 failed cycles, mark as SETTLEMENT_FAILED

/**
 * M-05: Convert a decimal string (e.g. "10.500000") to integer microUSDC (bigint)
 * without floating-point intermediate, avoiding precision loss.
 *
 * Examples:
 *   "10.5"      → 10_500_000n
 *   "0.001"     → 1_000n
 *   "100"       → 100_000_000n
 *   "1.123456"  → 1_123_456n
 *   "1.1234567" → 1_123_457n (rounded)
 */
function decimalToMicroUsdc(value: string): bigint {
  const trimmed = value.trim();
  const dotIdx = trimmed.indexOf('.');
  if (dotIdx === -1) {
    // No decimal point — whole number
    return BigInt(trimmed) * 1_000_000n;
  }
  const intPart = trimmed.slice(0, dotIdx) || '0';
  let fracPart = trimmed.slice(dotIdx + 1);
  if (fracPart.length > 7) {
    // Take 7 digits for rounding, then truncate to 6
    const seventh = parseInt(fracPart[6], 10);
    fracPart = fracPart.slice(0, 6);
    let micro = BigInt(intPart) * 1_000_000n + BigInt(fracPart);
    if (seventh >= 5) micro += 1n;
    return micro;
  }
  // Pad to 6 decimals
  fracPart = fracPart.padEnd(6, '0');
  return BigInt(intPart) * 1_000_000n + BigInt(fracPart);
}

// In-memory state for markets being settled
interface SettlingState {
  leaves: Array<{ recipient: InstanceType<typeof PublicKey>; amount: bigint; positionId: string; userId: string | null }>;
  tree: MerkleTree;
  totalAmount: bigint;
  batchesCreated: boolean;
  totalBatches: number;
  batchSignatures: string[];
  rootPosted?: boolean; // Set by combined resolve+postMerkleRoot to skip redundant postMerkleRoot call
}
const settlingState = new Map<string, SettlingState>();

function previewSettlementLeaves(state: SettlingState, limit: number = 5): string[] {
  return state.leaves.slice(0, limit).map((leaf) =>
    `${leaf.recipient.toBase58().slice(0, 8)}:${leaf.amount.toString()}`
  );
}

function rebuildSettlementTree(state: SettlingState): void {
  state.leaves = state.leaves.filter((leaf) => leaf.amount > 0n);
  const treeLeaves: SettlementLeaf[] = state.leaves.map((leaf) => ({
    recipient: leaf.recipient,
    amount: leaf.amount,
  }));
  state.tree = buildMerkleTree(treeLeaves);
  state.totalAmount = state.leaves.reduce((sum, leaf) => sum + leaf.amount, 0n);
}

function reconcileSmallSettlementDrift(state: SettlingState, targetTotal: bigint): boolean {
  if (state.leaves.length === 0 || state.totalAmount === targetTotal) {
    return false;
  }

  const diff = targetTotal - state.totalAmount;
  if (diff > 0n) {
    // Tiny undercount from DB rounding: top up winners so total matches chain exactly.
    state.leaves[0].amount += diff;
    rebuildSettlementTree(state);
    return true;
  }

  let remaining = -diff;
  for (const leaf of state.leaves) {
    if (remaining === 0n) break;
    const reduction = remaining > leaf.amount ? leaf.amount : remaining;
    leaf.amount -= reduction;
    remaining -= reduction;
  }

  rebuildSettlementTree(state);
  return true;
}

async function logSettlementDriftDiagnostics(params: {
  marketId: string;
  marketPubkey: string;
  marketStatus: string;
  marketOutcome: string | null;
  winnerOutcome: 'YES' | 'NO';
  state: SettlingState;
  reason: string;
  onChainOpenInterest?: bigint;
  driftLamports?: bigint;
  attempt?: number;
}): Promise<void> {
  try {
    const marketRow = await db.execute(sql`
      SELECT
        status,
        outcome,
        COALESCE(open_interest, '0')::text AS open_interest,
        COALESCE(total_volume, '0')::text AS total_volume
      FROM markets
      WHERE id = ${params.marketId}::uuid
      LIMIT 1
    `);

    const positionSummary = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total_positions,
        COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open_positions,
        COALESCE(SUM(yes_shares::numeric), 0)::text AS yes_shares_sum,
        COALESCE(SUM(no_shares::numeric), 0)::text AS no_shares_sum,
        COALESCE(SUM(total_cost::numeric), 0)::text AS total_cost_sum,
        COALESCE(SUM(
          CASE
            WHEN ${params.winnerOutcome} = 'YES' THEN yes_shares::numeric
            ELSE no_shares::numeric
          END
        ), 0)::text AS winning_shares_sum
      FROM positions
      WHERE market_id = ${params.marketId}::uuid
    `);

    const tradeSummary = await db.execute(sql`
      SELECT
        tx_status,
        COUNT(*)::int AS trade_count,
        COALESCE(SUM(size::numeric), 0)::text AS size_sum,
        COALESCE(SUM(maker_notional::numeric + taker_notional::numeric), 0)::text AS collateral_sum,
        COALESCE(SUM(taker_fee::numeric), 0)::text AS taker_fee_sum
      FROM trades
      WHERE market_id = ${params.marketId}::uuid
      GROUP BY tx_status
      ORDER BY tx_status
    `);

    const unconfirmedTrades = await db.execute(sql`
      SELECT
        id,
        maker_order_id,
        taker_order_id,
        tx_status,
        tx_signature,
        error_code,
        COALESCE(size::numeric, 0)::text AS size,
        COALESCE(maker_notional::numeric + taker_notional::numeric, 0)::text AS collateral,
        COALESCE(taker_fee::numeric, 0)::text AS taker_fee,
        executed_at,
        confirmed_at
      FROM trades
      WHERE market_id = ${params.marketId}::uuid
        AND (tx_status != 'CONFIRMED' OR confirmed_at IS NULL)
      ORDER BY executed_at DESC
      LIMIT 10
    `);

    logger.warn(
      {
        reason: params.reason,
        marketId: params.marketId,
        marketPubkey: params.marketPubkey,
        marketStatus: params.marketStatus,
        marketOutcome: params.marketOutcome,
        winnerOutcome: params.winnerOutcome,
        attempt: params.attempt ?? null,
        onChainOpenInterest: params.onChainOpenInterest?.toString() ?? null,
        proposedSettlementTotal: params.state.totalAmount.toString(),
        driftLamports: params.driftLamports?.toString() ?? null,
        settlementLeaves: params.state.leaves.length,
        settlementLeafPreview: previewSettlementLeaves(params.state),
        dbMarket: marketRow.rows?.[0] ?? null,
        dbPositions: positionSummary.rows?.[0] ?? null,
        dbTradesByStatus: tradeSummary.rows ?? [],
        dbUnconfirmedTrades: unconfirmedTrades.rows ?? [],
      },
      '[MerkleSettler] Drift diagnostics'
    );
  } catch (diagErr: any) {
    logger.warn(`[MerkleSettler] Drift diagnostics failed: ${diagErr.message}`);
  }
}

async function reversePositionForSettlementRepair(
  userId: string,
  marketId: string,
  outcome: 'YES' | 'NO',
  shares: number,
  cost: number,
  wasBuy: boolean,
): Promise<void> {
  const userPositions = await db
    .select()
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.marketId, marketId)))
    .limit(1);

  if (userPositions.length === 0) {
    return;
  }

  const pos = userPositions[0];
  const isYes = outcome === 'YES';

  if (wasBuy) {
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
      if (newShares <= 0) updates.avgEntryYes = '0';
    } else {
      updates.noShares = newShares.toString();
      if (newShares <= 0) updates.avgEntryNo = '0';
    }

    await db.update(positions).set(updates).where(eq(positions.id, pos.id));
    return;
  }

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

async function repairLegacyFailedTradePositions(marketId: string): Promise<number> {
  const staleFailedTrades = await db
    .select({
      id: trades.id,
      marketId: trades.marketId,
      makerUserId: trades.makerUserId,
      takerUserId: trades.takerUserId,
      takerSide: trades.takerSide,
      takerOutcome: trades.takerOutcome,
      makerOutcome: trades.makerOutcome,
      size: trades.size,
      takerPrice: trades.takerPrice,
      makerPrice: trades.makerPrice,
    })
    .from(trades)
    .where(and(
      eq(trades.marketId, marketId),
      eq(trades.txStatus, 'FAILED'),
      sql`${trades.errorCode} IS NULL`,
    ));

  if (staleFailedTrades.length === 0) {
    return 0;
  }

  for (const trade of staleFailedTrades) {
    const size = parseFloat(trade.size || '0');
    if (size <= 0 || !trade.marketId) {
      continue;
    }

    const takerPrice = parseFloat(trade.takerPrice || '0');
    const makerPrice = parseFloat(trade.makerPrice || '0');
    const takerIsBuy = trade.takerSide === 'BID';

    if (trade.takerUserId) {
      await reversePositionForSettlementRepair(
        trade.takerUserId,
        trade.marketId,
        (trade.takerOutcome as 'YES' | 'NO') || 'YES',
        size,
        size * takerPrice,
        takerIsBuy,
      );
    }

    if (trade.makerUserId) {
      await reversePositionForSettlementRepair(
        trade.makerUserId,
        trade.marketId,
        (trade.makerOutcome as 'YES' | 'NO') || 'YES',
        size,
        size * makerPrice,
        true,
      );
    }
  }

  await db
    .update(trades)
    .set({
      errorCode: 'SETTLEMENT_POSITION_REPAIR',
      txSignature: null,
    })
    .where(and(
      eq(trades.marketId, marketId),
      eq(trades.txStatus, 'FAILED'),
      sql`${trades.errorCode} IS NULL`,
    ));

  logger.warn(`[MerkleSettler] Repaired ${staleFailedTrades.length} legacy failed trade position(s) before settlement`);
  return staleFailedTrades.length;
}

export async function merkleSettlerJob(): Promise<void> {
  if (!anchorClient.isReady()) {
    return;
  }

  const resolvedMarkets = await db
    .select()
    .from(markets)
    .where(eq(markets.status, 'RESOLVED'));

  for (const market of resolvedMarkets) {
    if (processingMarkets.has(market.id)) continue;

    const hasDbVolume = parseFloat(market.totalVolume || '0') > 0;
    const hasPreSeededState = settlingState.has(market.id);
    if (!hasDbVolume && !hasPreSeededState) {
      // Zero-trade markets: skip merkle settlement, mark as SETTLED so market-closer
      // picks them up and closes on-chain accounts to recover rent (~0.009 SOL each)
      logger.info(`[MerkleSettler] Marking zero-trade market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) as SETTLED for cleanup`);
      await marketService.markSettled(market.id);
      continue;
    }

    // SYNCHRONOUS add — close the TOCTOU race window before any await.
    // Previously, `add()` was after `await tryAdvisoryLock()`, allowing multiple
    // concurrent calls to pass the `has()` check before any reached `add()`.
    processingMarkets.add(market.id);
    try {
      // M-04: Acquire DB advisory lock (multi-instance safe)
      const lockAcquired = await tryAdvisoryLock('settle', market.id);
      if (!lockAcquired) continue; // Another instance is settling this market (finally still runs)
      try {
        await processMarketSettlement(market);
      } catch (err: any) {
        logger.error(`[MerkleSettler] Failed for market ${market.id} (${market.asset}-${market.timeframe}): ${err.message}`);
      } finally {
        await releaseAdvisoryLock('settle', market.id);
      }
    } finally {
      processingMarkets.delete(market.id);
    }
  }
}

/**
 * Pre-seed the settling state from already-fetched settlement data.
 * Called from market-resolver DURING the resolve TX (parallel prep) so the
 * merkle tree is ready the instant the resolve TX confirms — saves ~300ms
 * of DB queries that buildSettlementState would otherwise do.
 */
export function preSeedSettlingState(
  marketId: string,
  outcome: 'YES' | 'NO',
  positions: Array<{ id: string; userId: string | null; yesShares: string | null; noShares: string | null }>,
  walletMap: Map<string, string | null>,
): boolean {
  if (settlingState.has(marketId)) return false;

  const leaves: SettlingState['leaves'] = [];
  for (const position of positions) {
    const winningSharesStr = outcome === 'YES'
      ? (position.yesShares || '0')
      : (position.noShares || '0');

    // M-05: Integer arithmetic for microUSDC conversion
    const amount = decimalToMicroUsdc(winningSharesStr);
    if (amount <= 0n) continue;

    const wallet = position.userId ? walletMap.get(position.userId) : null;
    if (!wallet) continue;

    leaves.push({ recipient: new PublicKey(wallet), amount, positionId: position.id, userId: position.userId });
  }

  if (leaves.length === 0) return false;

  const treeLeaves: SettlementLeaf[] = leaves.map(l => ({ recipient: l.recipient, amount: l.amount }));
  const tree = buildMerkleTree(treeLeaves);
  const totalAmount = leaves.reduce((sum, l) => sum + l.amount, 0n);

  settlingState.set(marketId, { leaves, tree, totalAmount, batchesCreated: false, totalBatches: 0, batchSignatures: [] });
  logger.info(`[MerkleSettler] Pre-seeded merkle tree: ${leaves.length} leaves, totalAmount=${totalAmount}, root=${Buffer.from(tree.root).toString('hex').slice(0, 16)}...`);
  return true;
}

/**
 * Get the pre-seeded merkle tree info for the combined resolve+postMerkleRoot instruction.
 * Returns null if no state is pre-seeded for this market.
 */
export function getPreSeededMerkleData(marketId: string): {
  merkleRoot: Uint8Array;
  totalAmount: bigint;
  totalSettlements: number;
} | null {
  const state = settlingState.get(marketId);
  if (!state) return null;
  return {
    merkleRoot: state.tree.root,
    totalAmount: state.totalAmount,
    totalSettlements: state.leaves.length,
  };
}

/**
 * Mark that the merkle root was already posted on-chain (via combined instruction).
 * processMarketSettlement will skip the separate postMerkleRoot call.
 */
export function markRootPosted(marketId: string): void {
  const state = settlingState.get(marketId);
  if (state) {
    state.rootPosted = true;
  }
}

/**
 * Invalidate pre-seeded settling state for a market.
 * Called when the combined resolve+postMerkleRoot fails (e.g., settlement
 * amount exceeds open_interest due to pending match TXs).
 */
export function invalidateSettlingState(marketId: string): void {
  settlingState.delete(marketId);
}

/**
 * Direct trigger for merkle settlement — called from market-resolver and
 * onchain-submit worker to eliminate polling gaps.
 * Safe to call multiple times: idempotent pipeline + processingMarkets guard.
 *
 * @param marketId    Market UUID
 * @param marketObj   Optional pre-fetched market row (avoids a DB round-trip when caller already has it)
 */
export async function triggerMerkleSettlement(
  marketId: string,
  marketObj?: typeof markets.$inferSelect,
): Promise<void> {
  if (!anchorClient.isReady()) return;
  if (processingMarkets.has(marketId)) return;

  // SYNCHRONOUS add — close the TOCTOU race window before any await.
  // Previously, `add()` was after `await tryAdvisoryLock()`, allowing the
  // worker completion callback + periodic merkleSettlerJob to both pass `has()`
  // before either reached `add()`, causing duplicate settlement pipeline runs.
  processingMarkets.add(marketId);

  try {
    // Always fetch fresh from DB for the totalVolume check — the passed marketObj
    // may have stale totalVolume=0 from getById cache (30s TTL). This caused markets
    // with actual trades to be incorrectly marked as "zero-trade" and skip settlement.
    const market = (await db.select().from(markets).where(eq(markets.id, marketId)).limit(1))[0];
    if (!market || market.status !== 'RESOLVED') return;

    // Check both DB totalVolume AND pre-seeded settling state (defense-in-depth).
    // The settling state is pre-built from positions during resolve, so it's reliable
    // even if totalVolume hasn't been flushed to DB yet (write-behind race).
    const hasDbVolume = parseFloat(market.totalVolume || '0') > 0;
    const hasPreSeededState = settlingState.has(marketId);
    if (!hasDbVolume && !hasPreSeededState) {
      // Truly zero-trade market: mark as SETTLED for cleanup
      logger.info(`[MerkleSettler] Marking zero-trade market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) as SETTLED for cleanup`);
      await marketService.markSettled(market.id);
      return;
    }

    // M-04: Acquire DB advisory lock (multi-instance safe)
    const lockAcquired = await tryAdvisoryLock('settle', marketId);
    if (!lockAcquired) return;
    try {
      await processMarketSettlement(market);
    } catch (err: any) {
      logger.error(`[MerkleSettler] Triggered settlement failed for ${marketId}: ${err.message}`);
    } finally {
      await releaseAdvisoryLock('settle', marketId);
    }
  } finally {
    processingMarkets.delete(marketId);
  }
}

async function processMarketSettlement(market: typeof markets.$inferSelect): Promise<void> {
  const marketId = market.id;
  const marketPubkey = market.pubkey;
  const outcome = market.outcome as 'YES' | 'NO';

  if (!outcome || (outcome !== 'YES' && outcome !== 'NO')) {
    logger.warn(`[MerkleSettler] Market ${marketId} has no valid outcome, skipping`);
    return;
  }

  const settlementStartMs = Date.now();
  logger.info(`[MerkleSettler] Processing market ${marketId} (${market.asset}-${market.timeframe}), outcome=${outcome}`);

  // Step 1: Build settlement state
  let state = settlingState.get(marketId);
  if (!state) {
    const built = await buildSettlementState(market, outcome);
    if (!built) {
      await marketService.markSettled(marketId);
      logEvents.marketSettled({
        marketId, asset: market.asset, timeframe: market.timeframe,
        positionsSettled: 0, totalPayout: 0,
      });
      return;
    }
    state = built;
    settlingState.set(marketId, state);
  }

  // Step 2: Validate settlement amount against on-chain open_interest, then post merkle root
  //
  // The matching engine updates DB positions IMMEDIATELY when orders match, but
  // on-chain match TXs go through BullMQ and may still be pending. Once the market
  // resolves on-chain, pending match TXs will FAIL (market no longer Open), and the
  // db-sync worker reverses those positions. We must wait for this to happen.
  if (!state.rootPosted) {
    try {
      const chainState = await fetchMarketV2OnChainState(
        anchorClient.getConnection(),
        new PublicKey(marketPubkey),
      );
      if (chainState) {
        const onChainOI = chainState.openInterest;
        if (state.totalAmount !== onChainOI) {
          const PRECISION_DRIFT_THRESHOLD = 1000n; // 1000 lamports = $0.001

          if (state.totalAmount > onChainOI) {
            const repairedTradeCount = await repairLegacyFailedTradePositions(marketId);
            if (repairedTradeCount > 0) {
              settlingState.delete(marketId);
              const rebuiltAfterRepair = await buildSettlementState(market, outcome);
              if (!rebuiltAfterRepair) {
                await marketService.markSettled(marketId);
                marketFailureCount.delete(marketId);
                return;
              }

              state = rebuiltAfterRepair;
              settlingState.set(marketId, state);

              if (state.totalAmount <= onChainOI) {
                logger.warn(
                  `[MerkleSettler] Settlement drift resolved after repairing ${repairedTradeCount} legacy failed trade(s): ` +
                  `totalAmount=${state.totalAmount}, onChainOpenInterest=${onChainOI}`
                );
                marketFailureCount.delete(marketId);
              }
            }
          }

          if (state.totalAmount !== onChainOI) {
            const drift = state.totalAmount - onChainOI;
            const absDrift = drift < 0n ? -drift : drift;

            if (absDrift <= PRECISION_DRIFT_THRESHOLD) {
              const beforeAdjust = state.totalAmount;
              await logSettlementDriftDiagnostics({
                marketId,
                marketPubkey,
                marketStatus: market.status,
                marketOutcome: market.outcome,
                winnerOutcome: outcome,
                state,
                reason: drift < 0n ? 'pre_post_root_precision_top_up' : 'pre_post_root_precision_cap',
                onChainOpenInterest: onChainOI,
                driftLamports: drift,
              });
              reconcileSmallSettlementDrift(state, onChainOI);
              settlingState.set(marketId, state);
              marketFailureCount.delete(marketId);
              logger.warn(
                `[MerkleSettler] Reconciled small settlement drift to exact on-chain open_interest: ` +
                `before=${beforeAdjust}, after=${state.totalAmount}, drift=${drift}`
              );
            }

            if (state.totalAmount === onChainOI) {
              // Precision drift has been reconciled in-memory; continue to postMerkleRoot.
            } else if (state.totalAmount > onChainOI) {
              const count = (marketFailureCount.get(marketId) || 0) + 1;
              marketFailureCount.set(marketId, count);

            // Small drift (<1000 lamports / $0.001) is precision rounding from
            // float→integer aggregation and will NEVER self-resolve. Cap immediately.
            // Larger drift may be from pending match TXs that haven't been reversed
            // yet — give them 2 cycles to propagate before capping.
            const isSmallDrift = drift <= PRECISION_DRIFT_THRESHOLD;
            const shouldCap = isSmallDrift || count >= 3;

            if (!shouldCap) {
              await logSettlementDriftDiagnostics({
                marketId,
                marketPubkey,
                marketStatus: market.status,
                marketOutcome: market.outcome,
                winnerOutcome: outcome,
                state,
                reason: 'pre_post_root_drift_waiting_for_reversal',
                onChainOpenInterest: onChainOI,
                driftLamports: drift,
                attempt: count,
              });
              logger.warn(
                `[MerkleSettler] totalAmount=${state.totalAmount} > on-chain open_interest=${onChainOI} ` +
                `(drift=${drift}, attempt ${count}/3). Waiting for pending TX reversals.`
              );
              // Invalidate pre-seeded state so next cycle rebuilds from fresh DB
              settlingState.delete(marketId);
              return;
            }

            // Cap to on-chain open_interest (the authoritative USDC vault balance)
            await logSettlementDriftDiagnostics({
              marketId,
              marketPubkey,
              marketStatus: market.status,
              marketOutcome: market.outcome,
              winnerOutcome: outcome,
              state,
              reason: isSmallDrift ? 'pre_post_root_precision_cap' : 'pre_post_root_persistent_drift_cap',
              onChainOpenInterest: onChainOI,
              driftLamports: drift,
              attempt: count,
            });
            logger.warn(
              `[MerkleSettler] Capping settlement to on-chain open_interest: ` +
              `drift=${drift} lamports${isSmallDrift ? ' (precision rounding)' : ` (persisted after ${count} attempts)`}`
            );

            // Invalidate and rebuild from fresh DB state
            settlingState.delete(marketId);
            const rebuilt = await buildSettlementState(market, outcome);
            if (!rebuilt) {
              await marketService.markSettled(marketId);
              marketFailureCount.delete(marketId);
              return;
            }
            // Scale each leaf proportionally to fit on-chain open_interest
            if (rebuilt.totalAmount > onChainOI) {
              const scale = Number(onChainOI) / Number(rebuilt.totalAmount);
              for (const leaf of rebuilt.leaves) {
                leaf.amount = BigInt(Math.floor(Number(leaf.amount) * scale));
              }
              rebuilt.totalAmount = rebuilt.leaves.reduce((s, l) => s + l.amount, 0n);
              // Rebuild merkle tree with adjusted amounts
              const treeLeaves: SettlementLeaf[] = rebuilt.leaves.map(l => ({ recipient: l.recipient, amount: l.amount }));
              rebuilt.tree = buildMerkleTree(treeLeaves);
              logger.info(`[MerkleSettler] Capped totalAmount to ${rebuilt.totalAmount} (scale=${scale.toFixed(8)}, drift was ${drift} lamports)`);
            }
            state = rebuilt;
            settlingState.set(marketId, state);
            marketFailureCount.delete(marketId);
            } else {
              await logSettlementDriftDiagnostics({
                marketId,
                marketPubkey,
                marketStatus: market.status,
                marketOutcome: market.outcome,
                winnerOutcome: outcome,
                state,
                reason: 'pre_post_root_underfunded_settlement_state',
                onChainOpenInterest: onChainOI,
                driftLamports: drift,
              });
              logger.warn(
                `[MerkleSettler] Settlement total is below on-chain open_interest by ${absDrift} lamports. ` +
                `This is larger than expected precision drift; waiting for rebuild.`
              );
              settlingState.delete(marketId);
              return;
            }
          }
        }
      }
    } catch (err: any) {
      logger.warn(`[MerkleSettler] Could not fetch on-chain market state: ${err.message}`);
      // Continue anyway — the postMerkleRoot call will fail with a clearer error if needed
    }
  }

  if (state.rootPosted) {
    logger.info(`[MerkleSettler] Merkle root already posted via combined instruction for ${market.asset}-${market.timeframe}, skipping to batch creation`);
    marketFailureCount.delete(marketId);
  } else try {
    const sig = await anchorClient.postMerkleRoot({
      marketPubkey,
      merkleRoot: state.tree.root,
      totalAmount: state.totalAmount,
      totalSettlements: state.leaves.length,
    });
    logger.info(`[MerkleSettler] Merkle root posted for ${market.asset}-${market.timeframe}: ${sig}`);
    marketFailureCount.delete(marketId);
    // Skip syncMarketStatusFromChain — the TX just confirmed so we know the
    // on-chain state is SETTLING. DB stays RESOLVED until finalize. (~300ms saved)
  } catch (err: any) {
    const msg = err.message || '';
    if (msg.includes('MerkleRootAlreadySet') || msg.includes('already in use') || msg.includes('MarketNotSettling')) {
      logger.debug(`[MerkleSettler] Merkle root already posted for ${marketId}, continuing`);
      marketFailureCount.delete(marketId);
    } else if (msg.includes('MarketNotResolved') || msg.includes('0x177a')) {
      // Market is NOT resolved on-chain yet — can't post merkle root.
      const count = (marketFailureCount.get(marketId) || 0) + 1;
      marketFailureCount.set(marketId, count);
      if (count >= MAX_SETTLEMENT_FAILURES) {
        logger.error(`[MerkleSettler] Market ${marketId} (${market.asset}-${market.timeframe}) not resolved on-chain after ${count} attempts — marking as SETTLEMENT_FAILED`);
        await marketService.markSettlementFailed(marketId);
        settlingState.delete(marketId);
        marketFailureCount.delete(marketId);
      } else {
        logger.warn(`[MerkleSettler] Market ${marketId} not resolved on-chain (attempt ${count}/${MAX_SETTLEMENT_FAILURES}), will retry next cycle`);
      }
      return;
    } else if (
      msg.includes('InvalidSettlementAmount') ||
      msg.includes('0x17ab') ||
      msg.includes('6059')
    ) {
      // Hit despite pre-check — race between fetch and TX, or chain state changed.
      // Invalidate and retry; the pre-check logic on next cycle will cap immediately
      // for small drifts or after 3 cycles for larger ones.
      const chainState = await fetchMarketV2OnChainState(
        anchorClient.getConnection(),
        new PublicKey(marketPubkey),
      ).catch(() => null);
      await logSettlementDriftDiagnostics({
        marketId,
        marketPubkey,
        marketStatus: market.status,
        marketOutcome: market.outcome,
        winnerOutcome: outcome,
        state,
        reason: 'post_merkle_root_invalid_settlement_amount',
        onChainOpenInterest: chainState?.openInterest,
        driftLamports: chainState ? state.totalAmount - chainState.openInterest : undefined,
      });
      logger.warn(`[MerkleSettler] InvalidSettlementAmount despite pre-check. Invalidating state for rebuild with cap.`);
      settlingState.delete(marketId);
      // Don't reset failure count — let the pre-check cap logic use it
      return;
    } else {
      throw err;
    }
  }

  // Step 3: Create settlement_jobs and enqueue to BullMQ (parallel!)
  //
  // V3 compact batching: instead of per-leaf full proofs, we group consecutive
  // leaves into subtree-aligned batches with a single shared bridge proof.
  // This saves ~4-8x TX space, allowing 8-16 settlements per TX vs 1-2 in V2.
  //
  // Fallback to V2 for tiny trees where compact batching doesn't help.

  const TX_LIMIT = 1232;
  const FIXED_OVERHEAD = 425;  // sig + header + blockhash + 6 fixed accounts + ix framing + discriminator
  const PER_ENTRY_OVERHEAD = 44;  // amount(8) + ATA account key(32) + createATA dedup(~4)

  const treeDepth = Math.ceil(Math.log2(Math.max(state.leaves.length, 2)));
  const paddedCount = state.tree.paddedSize;

  /**
   * Find optimal subtree size (largest power-of-2 that fits in TX).
   * Returns 0 to signal V2 fallback when compact batching doesn't help.
   */
  function getOptimalSubtreeSize(depth: number): number {
    for (const k of [16, 8, 4]) {
      const bridgeDepth = depth - Math.log2(k);
      if (bridgeDepth < 0) continue;
      const txSize = FIXED_OVERHEAD + bridgeDepth * 32 + k * PER_ENTRY_OVERHEAD;
      if (txSize <= TX_LIMIT - 52) return k; // 52-byte safety margin
    }
    return 0; // V2 fallback
  }

  const subtreeSize = getOptimalSubtreeSize(treeDepth);
  const useV3 = subtreeSize > 0 && state.leaves.length > 2 && state.leaves.length <= 8192;

  if (!state.batchesCreated) {
    if (useV3) {
      // ── V3 Compact Batch Settlement ──
      const totalSubtrees = paddedCount / subtreeSize;
      let batchIdx = 0;

      for (let i = 0; i < totalSubtrees; i++) {
        const startIndex = i * subtreeSize;
        const realCount = Math.min(subtreeSize, state.leaves.length - startIndex);
        if (realCount <= 0) continue; // skip all-padding subtrees

        const batchLeaves = state.leaves.slice(startIndex, startIndex + realCount);
        const bridgeProof = state.tree.getSubtreeBridgeProof(startIndex, subtreeSize);

        // Local verification before submission
        const leafHashes = batchLeaves.map(l =>
          createSettlementLeaf(l.recipient, l.amount)
        );
        if (!verifyCompactBridgeProof(leafHashes, bridgeProof, state.tree.root, startIndex, subtreeSize)) {
          throw new Error(`[MerkleSettler] V3 local bridge proof verification failed for subtree at index ${startIndex}`);
        }

        // Insert settlement_job row
        await db.execute(sql`
          INSERT INTO settlement_jobs (market_id, batch_index, recipients, amounts, proofs, status)
          VALUES (
            ${marketId}::uuid,
            ${batchIdx},
            ${JSON.stringify(batchLeaves.map(l => l.recipient.toBase58()))}::jsonb,
            ${JSON.stringify(batchLeaves.map(l => l.amount.toString()))}::jsonb,
            ${JSON.stringify({ version: 'v3', startIndex, subtreeSize, bridgeProof: bridgeProof.map(p => Buffer.from(p).toString('hex')) })}::jsonb,
            'PENDING'
          )
          ON CONFLICT (market_id, batch_index) DO NOTHING
        `);

        // Enqueue as V3 batch-settle job
        const jobId = `batch-settle-v3-${marketId}-${batchIdx}`;
        await onchainSubmitQueue.add('batch-settle-v3', {
          type: 'batch-settle-v3' as const,
          idempotencyKey: jobId,
          payload: {
            marketPubkey,
            bitmapChunkIndex: Math.floor(startIndex / 8192),
            startIndex,
            subtreeSize,
            settlements: batchLeaves.map(l => ({
              recipient: l.recipient.toBase58(),
              amount: l.amount.toString(),
            })),
            bridgeProof: bridgeProof.map(p => Buffer.from(p).toString('hex')),
            marketId,
            batchIndex: batchIdx,
          },
        }, { jobId }).catch(err => {
          logger.error(`[MerkleSettler] Failed to enqueue V3 batch ${batchIdx}: ${err.message}`);
        });

        batchIdx++;
      }

      state.totalBatches = batchIdx;
      state.batchesCreated = true;
      logger.info(`[MerkleSettler] V3: ${batchIdx} compact batches (subtreeSize=${subtreeSize}) enqueued for ${state.leaves.length} settlements`);
    } else {
      // ── V2 Fallback (small trees) ──
      const proofDepth = treeDepth;
      const entrySize = 52 + proofDepth * 32;
      const PER_ENTRY_ACCOUNTS_OVERHEAD = 80;
      const effectiveEntrySize = entrySize + PER_ENTRY_ACCOUNTS_OVERHEAD;
      const batchSize = Math.min(15, Math.max(1, Math.floor((TX_LIMIT - FIXED_OVERHEAD) / effectiveEntrySize)));
      let totalBatches = 0;

      logger.info(`[MerkleSettler] V2 fallback: chunk-aware batching (batchSize=${batchSize}) for ${state.leaves.length} settlements`);

      for (let start = 0, batchIdx = 0; start < state.leaves.length; batchIdx++) {
        const chunkBoundary = (Math.floor(start / 8192) + 1) * 8192;
        const end = Math.min(start + batchSize, state.leaves.length, chunkBoundary);
        const batchLeaves = state.leaves.slice(start, end);

        const batchSettlements = batchLeaves.map((leaf, i) => {
          const leafIndex = start + i;
          const proof = state!.tree.getProof(leafIndex);

          const leafHash = createSettlementLeaf(leaf.recipient, leaf.amount);
          if (!verifyMerkleProof(proof, state!.tree.root, leafHash, leafIndex)) {
            throw new Error(`[MerkleSettler] Local proof verification failed for leaf ${leafIndex}`);
          }

          return {
            recipient: leaf.recipient.toBase58(),
            amount: leaf.amount.toString(),
            index: leafIndex,
            proof: proof.map(p => Buffer.from(p).toString('hex')),
          };
        });

        await db.execute(sql`
          INSERT INTO settlement_jobs (market_id, batch_index, recipients, amounts, proofs, status)
          VALUES (
            ${marketId}::uuid,
            ${batchIdx},
            ${JSON.stringify(batchSettlements.map(s => s.recipient))}::jsonb,
            ${JSON.stringify(batchSettlements.map(s => s.amount))}::jsonb,
            ${JSON.stringify(batchSettlements.map(s => ({ index: s.index, proof: s.proof })))}::jsonb,
            'PENDING'
          )
          ON CONFLICT (market_id, batch_index) DO NOTHING
        `);

        const jobId = `batch-settle-${marketId}-${batchIdx}`;
        await onchainSubmitQueue.add('batch-settle', {
          type: 'batch-settle' as const,
          idempotencyKey: jobId,
          payload: {
            marketPubkey,
            bitmapChunkIndex: Math.floor(start / 8192),
            settlements: batchSettlements.map(s => ({
              recipient: s.recipient,
              amount: s.amount,
              index: s.index,
              proof: s.proof,
            })),
            marketId,
            batchIndex: batchIdx,
          },
        }, { jobId }).catch(err => {
          logger.error(`[MerkleSettler] Failed to enqueue batch ${batchIdx}: ${err.message}`);
        });

        totalBatches++;
        start = end;
      }

      state.totalBatches = totalBatches;
      state.batchesCreated = true;
      logger.info(`[MerkleSettler] ${totalBatches} V2 settlement batches enqueued`);
    }
  }

  // Step 4: Check if all batches are completed
  const pendingBatches = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM settlement_jobs
    WHERE market_id = ${marketId}::uuid AND status NOT IN ('COMPLETED')
  `);

  const pendingCount = (pendingBatches.rows?.[0] as any)?.cnt || 0;

  if (pendingCount > 0) {
    // Also check for batches that were settled on-chain but not updated in DB
    // (e.g., if the worker processed them but the DB update failed)
    const submittedBatches = await db.execute(sql`
      SELECT batch_index, tx_signature
      FROM settlement_jobs
      WHERE market_id = ${marketId}::uuid AND status = 'SUBMITTED'
    `);

    for (const row of (submittedBatches.rows || []) as any[]) {
      if (row.tx_signature) {
        // Mark as completed if we have a signature
        await db.execute(sql`
          UPDATE settlement_jobs
          SET status = 'COMPLETED', completed_at = NOW()
          WHERE market_id = ${marketId}::uuid AND batch_index = ${row.batch_index}
        `);
      }
    }

    // Re-check
    const stillPending = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM settlement_jobs
      WHERE market_id = ${marketId}::uuid AND status NOT IN ('COMPLETED')
    `);

    if (((stillPending.rows?.[0] as any)?.cnt || 0) > 0) {
      logger.info(`[MerkleSettler] ${(stillPending.rows?.[0] as any)?.cnt} batches still pending for ${marketId}`);
      return; // Will retry on next cycle
    }
  }

  // Collect batch signatures
  const completedBatches = await db.execute(sql`
    SELECT tx_signature FROM settlement_jobs
    WHERE market_id = ${marketId}::uuid AND status = 'COMPLETED'
    ORDER BY batch_index
  `);
  state.batchSignatures = (completedBatches.rows || []).map((r: any) => r.tx_signature).filter(Boolean);

  logger.info(`[MerkleSettler] All ${state.totalBatches} batches completed for ${marketId}`);

  // Step 5: Sync settlements to DB immediately (user-facing — don't wait for cleanup)
  await syncSettlementToDb(market, state, outcome);

  // Step 6: Burn remaining share tokens — BLOCKING to ensure mint supply = 0
  // If mints have supply > 0, finalize_market_v2 can't close them, leaking ~0.003 SOL each.
  const marketPk = new PublicKey(marketPubkey);
  const yesMint = getYesMintPda(marketPk);
  const noMint = getNoMintPda(marketPk);

  let burnSuccess = true;
  try {
    const allPositions = await positionService.getPositionsForSettlement(marketId);
    const userIds = [...new Set(allPositions.map(p => p.userId).filter(Boolean) as string[])];
    const userWallets = userIds.length > 0
      ? await db.select({ id: users.id, walletAddress: users.walletAddress })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];

    const shareAtas: string[] = [];
    for (const user of userWallets) {
      const wallet = new PublicKey(user.walletAddress);
      const yesAta = await getAssociatedTokenAddress(yesMint, wallet, false, TOKEN_2022_PROGRAM_ID);
      const noAta = await getAssociatedTokenAddress(noMint, wallet, false, TOKEN_2022_PROGRAM_ID);
      shareAtas.push(yesAta.toBase58(), noAta.toBase58());
    }

    if (shareAtas.length > 0) {
      const BURN_BATCH_SIZE = 20;
      const MAX_BURN_RETRIES = 2;
      for (let i = 0; i < shareAtas.length; i += BURN_BATCH_SIZE) {
        const batch = shareAtas.slice(i, i + BURN_BATCH_SIZE);
        let burned = false;
        for (let attempt = 0; attempt <= MAX_BURN_RETRIES; attempt++) {
          try {
            const sig = await anchorClient.burnRemainingSharesV2({
              marketPubkey,
              yesMint: yesMint.toBase58(),
              noMint: noMint.toBase58(),
              userShareAtas: batch,
            });
            logger.info(`[MerkleSettler] Burned shares batch ${Math.floor(i / BURN_BATCH_SIZE) + 1}: ${sig}`);
            burned = true;
            break;
          } catch (burnErr: any) {
            const msg = burnErr.message || '';
            // AccountNotFound = ATA doesn't exist (user never received shares or already burned) — safe to skip
            if (msg.includes('AccountNotFound') || msg.includes('could not find account')) {
              logger.debug(`[MerkleSettler] Burn batch ${Math.floor(i / BURN_BATCH_SIZE) + 1}: some ATAs not found (already burned), continuing`);
              burned = true;
              break;
            }
            if (attempt < MAX_BURN_RETRIES) {
              logger.warn(`[MerkleSettler] Burn batch ${Math.floor(i / BURN_BATCH_SIZE) + 1} attempt ${attempt + 1} failed: ${msg}, retrying...`);
              await new Promise(r => setTimeout(r, 1000)); // 1s backoff
            } else {
              logger.error(`[MerkleSettler] Burn batch ${Math.floor(i / BURN_BATCH_SIZE) + 1} failed after ${MAX_BURN_RETRIES + 1} attempts: ${msg}`);
              burnSuccess = false;
            }
          }
        }
      }
    }
  } catch (err: any) {
    logger.error(`[MerkleSettler] Share burn step failed: ${err.message}`);
    burnSuccess = false;
  }

  if (!burnSuccess) {
    logger.warn(`[MerkleSettler] Some burn batches failed for ${marketId} — finalize will skip mint closure for affected mints (rent leak ~0.003 SOL per unclosed mint)`);
  }

  // Step 8: Finalize market on-chain
  try {
    const sig = await anchorClient.finalizeMarketV2({
      marketPubkey,
      yesMint: yesMint.toBase58(),
      noMint: noMint.toBase58(),
    });
    logger.info(`[MerkleSettler] Market finalized: ${sig}`);
  } catch (err: any) {
    const msg = err.message || '';
    if (msg.includes('SettlementNotComplete')) {
      logger.warn(`[MerkleSettler] Settlement not yet complete for ${marketId}, will retry`);
      return;
    }
    if (!msg.includes('MarketNotSettling')) {
      throw err;
    }
  }

  // Step 9: Mark market settled + archived (after on-chain cleanup)
  await syncMarketStatusFromChain(marketId, marketPubkey, 'RESOLVED');
  await marketService.markSettled(market.id);
  await marketService.markArchived(market.id);

  // Cleanup
  settlingState.delete(marketId);

  // Clean up settlement_jobs rows
  await db.execute(sql`
    DELETE FROM settlement_jobs WHERE market_id = ${marketId}::uuid
  `);

  const settlementElapsedMs = Date.now() - settlementStartMs;
  logger.info(`[MerkleSettler] Market ${market.asset}-${market.timeframe} fully settled [${settlementElapsedMs}ms total]`);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function buildSettlementState(
  market: typeof markets.$inferSelect,
  outcome: 'YES' | 'NO',
): Promise<SettlingState | null> {
  const openPositions = await positionService.getPositionsForSettlement(market.id);
  if (openPositions.length === 0) return null;

  const userIds = [...new Set(openPositions.map(p => p.userId).filter(Boolean) as string[])];
  const userWallets = userIds.length > 0
    ? await db.select({ id: users.id, walletAddress: users.walletAddress })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const walletMap = new Map(userWallets.map(u => [u.id, u.walletAddress]));

  const leaves: SettlingState['leaves'] = [];
  for (const position of openPositions) {
    const winningSharesStr = outcome === 'YES'
      ? (position.yesShares || '0')
      : (position.noShares || '0');

    // M-05: Use integer arithmetic instead of parseFloat to avoid precision loss
    const amount = decimalToMicroUsdc(winningSharesStr);
    if (amount <= 0n) continue;

    const wallet = position.userId ? walletMap.get(position.userId) : null;
    if (!wallet) {
      logger.warn(`[MerkleSettler] No wallet for user ${position.userId}, position ${position.id}`);
      continue;
    }

    leaves.push({
      recipient: new PublicKey(wallet),
      amount,
      positionId: position.id,
      userId: position.userId,
    });
  }

  if (leaves.length === 0) return null;

  const treeLeaves: SettlementLeaf[] = leaves.map(l => ({
    recipient: l.recipient,
    amount: l.amount,
  }));
  const tree = buildMerkleTree(treeLeaves);
  const totalAmount = leaves.reduce((sum, l) => sum + l.amount, 0n);

  logger.info(`[MerkleSettler] Built merkle tree: ${leaves.length} leaves, totalAmount=${totalAmount}, root=${Buffer.from(tree.root).toString('hex').slice(0, 16)}...`);

  return {
    leaves,
    tree,
    totalAmount,
    batchesCreated: false,
    totalBatches: 0,
    batchSignatures: [],
  };
}

async function syncSettlementToDb(
  market: typeof markets.$inferSelect,
  state: SettlingState,
  outcome: 'YES' | 'NO',
): Promise<void> {
  // Defense-in-depth: if settlements already exist for this market, skip entirely.
  // This guards against duplicate runs that bypassed the processingMarkets guard
  // (e.g., TOCTOU race or advisory lock reentrance on the same DB connection).
  const existingCheck = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM settlements WHERE market_id = ${market.id}::uuid
  `);
  if (((existingCheck.rows?.[0] as any)?.cnt || 0) > 0) {
    logger.warn(`[MerkleSettler] Settlements already exist for market ${market.id} — skipping duplicate sync`);
    return;
  }

  const lastSig = state.batchSignatures[state.batchSignatures.length - 1] || null;
  const allPositions = await positionService.getPositionsForSettlement(market.id);

  for (const position of allPositions) {
    // M-05: Use integer microUSDC for payout calculation, then convert to human-readable
    const winningSharesStr = outcome === 'YES'
      ? (position.yesShares || '0')
      : (position.noShares || '0');
    const payoutMicro = decimalToMicroUsdc(winningSharesStr);
    const winningShares = Number(payoutMicro) / 1_000_000;
    const payout = winningShares; // $1.00 per share
    const totalCost = parseFloat(position.totalCost || '0');
    const profit = payout - totalCost;

    await db.insert(settlements).values({
      positionId: position.id,
      userId: position.userId,
      marketId: market.id,
      outcome,
      winningShares: winningShares.toString(),
      payoutAmount: payout.toString(),
      profit: profit.toString(),
      txSignature: lastSig,
      txStatus: 'CONFIRMED',
      confirmedAt: new Date(),
    }).onConflictDoNothing();

    await positionService.settlePosition(position.id, payout);

    if (position.userId) {
      broadcastUserSettlement(position.userId, {
        marketId: market.id,
        outcome,
        size: winningShares,
        payout,
      });
    }

    logEvents.positionSettled({
      positionId: position.id,
      userId: position.userId || '',
      marketId: market.id,
      asset: market.asset,
      timeframe: market.timeframe,
      outcome,
      winningShares,
      payout,
      profit,
    });
  }

  const totalPayout = state.leaves.reduce((sum, l) => sum + Number(l.amount) / 1_000_000, 0);
  logEvents.marketSettled({
    marketId: market.id,
    asset: market.asset,
    timeframe: market.timeframe,
    positionsSettled: allPositions.length,
    totalPayout,
  });
}
