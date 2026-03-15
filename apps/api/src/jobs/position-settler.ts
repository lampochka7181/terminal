import { eq, inArray } from 'drizzle-orm';
import { db, markets, positions, settlements, users } from '../db/index.js';
import { positionService } from '../services/position.service.js';
import { marketService } from '../services/market.service.js';
import { logger, positionLogger, logEvents } from '../lib/logger.js';

/**
 * Position Settler
 * 
 * Settles positions for resolved markets:
 * 1. Find resolved markets that haven't been settled
 * 2. For each position, calculate payout
 * 3. Create settlement records
 * 4. Notify users via WebSocket
 * 
 * Settlement Rules:
 * - If outcome is YES: YES shareholders get $1.00 per share
 * - If outcome is NO: NO shareholders get $1.00 per share
 * - Losers get $0.00
 */

// Track markets being settled to prevent duplicate concurrent settlement
const settlingMarkets = new Set<string>();

/**
 * Pre-fetched settlement data (positions + wallets) for pipelining
 */
export interface SettlementPrepData {
  positions: (typeof positions.$inferSelect)[];
  walletMap: Map<string, string | null>;
  settlementMap: Map<string, typeof settlements.$inferSelect>;
}

/**
 * Pipeline step 1: Fetch positions and wallets WHILE on-chain resolve is pending
 * This can run in parallel with the resolve transaction
 */
export async function prepareSettlementData(marketId: string): Promise<SettlementPrepData | null> {
  // Get all unsettled positions for this market
  const openPositions = await positionService.getPositionsForSettlement(marketId);
  
  if (openPositions.length === 0) {
    return null; // No positions to settle
  }
  
  // Batch fetch user wallets and existing settlements
  const userIds = [...new Set(openPositions.map(p => p.userId).filter(Boolean) as string[])];
  const positionIds = openPositions.map(p => p.id);
  
  const [userWallets, existingSettlements] = await Promise.all([
    userIds.length > 0 
      ? db.select({ id: users.id, walletAddress: users.walletAddress })
          .from(users)
          .where(inArray(users.id, userIds))
      : Promise.resolve([]),
    positionIds.length > 0
      ? db.select()
          .from(settlements)
          .where(inArray(settlements.positionId, positionIds))
      : Promise.resolve([]),
  ]);
  
  return {
    positions: openPositions,
    walletMap: new Map(userWallets.map(u => [u.id, u.walletAddress])),
    settlementMap: new Map(existingSettlements.map(s => [s.positionId, s])),
  };
}

/**
 * Pipeline step 2: Execute settlement with pre-fetched data
 * Called immediately after on-chain resolve completes
 */
export async function settleMarketWithData(
  market: typeof markets.$inferSelect,
  prepData: SettlementPrepData | null
): Promise<void> {
  // Prevent duplicate concurrent settlement
  if (settlingMarkets.has(market.id)) {
    logger.debug(`Market ${market.id} already being settled, skipping`);
    return;
  }
  
  settlingMarkets.add(market.id);
  
  try {
    await settleMarketFast(market, prepData);
  } finally {
    settlingMarkets.delete(market.id);
  }
}

/**
 * Legacy: Settle a specific market immediately (called from resolver for fast UX)
 * Use settleMarketWithData for better performance when market object is available
 */
export async function settleMarketImmediately(marketId: string): Promise<void> {
  // Prevent duplicate concurrent settlement
  if (settlingMarkets.has(marketId)) {
    logger.debug(`Market ${marketId} already being settled, skipping`);
    return;
  }
  
  settlingMarkets.add(marketId);
  
  try {
    const market = await db
      .select()
      .from(markets)
      .where(eq(markets.id, marketId))
      .limit(1);
    
    if (market.length > 0 && market[0].status === 'RESOLVED') {
      await settleMarketFast(market[0], null);
    }
  } finally {
    settlingMarkets.delete(marketId);
  }
}

/**
 * Fast market settlement with optional pre-fetched data.
 * V2 markets use merkle settlement — this function validates and logs,
 * then defers to the merkle settlement pipeline.
 */
async function settleMarketFast(
  market: typeof markets.$inferSelect,
  prepData: SettlementPrepData | null
): Promise<void> {
  if (!market.outcome) {
    logger.warn(`Market ${market.id} has no outcome, skipping settlement`);
    return;
  }
  
  let openPositions: (typeof positions.$inferSelect)[];
  
  if (prepData) {
    openPositions = prepData.positions;
  } else {
    openPositions = await positionService.getPositionsForSettlement(market.id);
  }
  
  if (openPositions.length === 0) {
    await marketService.markSettled(market.id);
    logEvents.marketSettled({
      marketId: market.id,
      asset: market.asset,
      timeframe: market.timeframe,
      positionsSettled: 0,
      totalPayout: 0,
    });
    return;
  }
  
  positionLogger.info(`Settling ${openPositions.length} positions`, {
    marketId: market.id,
    asset: market.asset,
    timeframe: market.timeframe,
    positionCount: openPositions.length,
  });
  
  // V2 markets use merkle settlement (on-chain first, then DB).
  // Market stays RESOLVED — the merkle settlement pipeline handles the full flow.
  logger.info(`[V2] Market ${market.id} (${market.asset}-${market.timeframe}) resolved with ${openPositions.length} positions — awaiting merkle settlement`);
}
