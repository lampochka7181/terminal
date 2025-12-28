import { eq, and, sql } from 'drizzle-orm';
import { db, positions, markets, settlements, type Position, type NewPosition } from '../db/index.js';
import { logger } from '../lib/logger.js';

export interface PositionWithMarket extends Position {
  market?: {
    pubkey: string;
    asset: string;
    timeframe: string;
    strikePrice: string;
    expiryAt: Date;
    status: string | null;
    yesPrice: string | null;
    noPrice: string | null;
  };
}

export class PositionService {
  /**
   * Get all positions for a user
   */
  async getUserPositions(userId: string, status?: 'OPEN' | 'SETTLED'): Promise<PositionWithMarket[]> {
    let query = db
      .select({
        position: positions,
        market: {
          pubkey: markets.pubkey,
          asset: markets.asset,
          timeframe: markets.timeframe,
          strikePrice: markets.strikePrice,
          expiryAt: markets.expiryAt,
          status: markets.status,
          yesPrice: markets.yesPrice,
          noPrice: markets.noPrice,
        },
      })
      .from(positions)
      .leftJoin(markets, eq(positions.marketId, markets.id))
      .where(eq(positions.userId, userId));
    
    if (status) {
      query = query.where(and(eq(positions.userId, userId), eq(positions.status, status))) as typeof query;
    }
    
    const result = await query;
    
    return result.map((r) => ({
      ...r.position,
      market: r.market || undefined,
    }));
  }

  /**
   * Get a specific position
   */
  async getPosition(userId: string, marketId: string): Promise<Position | null> {
    const result = await db
      .select()
      .from(positions)
      .where(and(eq(positions.userId, userId), eq(positions.marketId, marketId)))
      .limit(1);
    
    return result[0] || null;
  }

  /**
   * Get or create position for user in market
   */
  async getOrCreate(userId: string, marketId: string): Promise<Position> {
    const existing = await this.getPosition(userId, marketId);
    if (existing) {
      return existing;
    }
    
    const [position] = await db
      .insert(positions)
      .values({
        userId,
        marketId,
        yesShares: '0',
        noShares: '0',
        totalCost: '0',
        realizedPnl: '0',
        status: 'OPEN',
      })
      .returning();
    
    return position;
  }

  /**
   * Update position after a trade
   * 
   * @param isBuy - true if buying/acquiring shares, false if selling existing shares
   * @param cost - For buys: total cost paid. For sells: proceeds received.
   */
  async updateAfterTrade(
    userId: string,
    marketId: string,
    outcome: 'YES' | 'NO',
    shares: number,
    cost: number,
    isBuy: boolean
  ): Promise<void> {
    const position = await this.getOrCreate(userId, marketId);
    
    // Truncate shares to 6 decimal places to match on-chain precision
    // On-chain stores shares as u64 with 6 decimals (e.g., 1.5 shares = 1_500_000)
    // Using Math.floor ensures DB matches exactly what's credited on-chain
    const truncateToOnChainPrecision = (n: number) => Math.floor(n * 1_000_000) / 1_000_000;
    const sharesToAdd = truncateToOnChainPrecision(shares);
    
    const currentYes = parseFloat(position.yesShares || '0');
    const currentNo = parseFloat(position.noShares || '0');
    const currentCost = parseFloat(position.totalCost || '0');
    const currentAvgYes = parseFloat(position.avgEntryYes || '0');
    const currentAvgNo = parseFloat(position.avgEntryNo || '0');
    const currentRealizedPnl = parseFloat(position.realizedPnl || '0');
    
    let newYes = currentYes;
    let newNo = currentNo;
    let newCost = currentCost;
    let newAvgYes = currentAvgYes;
    let newAvgNo = currentAvgNo;
    let newRealizedPnl = currentRealizedPnl;
    
    if (isBuy) {
      // BUYING: Add shares and increase cost basis
      if (outcome === 'YES') {
        const avgPrice = cost / sharesToAdd;
        newAvgYes = currentYes > 0 
          ? (currentYes * currentAvgYes + sharesToAdd * avgPrice) / (currentYes + sharesToAdd)
          : avgPrice;
        newYes = truncateToOnChainPrecision(currentYes + sharesToAdd);
      } else {
        const avgPrice = cost / sharesToAdd;
        newAvgNo = currentNo > 0
          ? (currentNo * currentAvgNo + sharesToAdd * avgPrice) / (currentNo + sharesToAdd)
          : avgPrice;
        newNo = truncateToOnChainPrecision(currentNo + sharesToAdd);
      }
      newCost = currentCost + cost;
    } else {
      // SELLING: Reduce shares and calculate realized PnL
      if (outcome === 'YES') {
        // Calculate realized PnL: proceeds - cost basis for sold shares
        const costBasisSold = currentAvgYes * sharesToAdd;
        const realizedPnL = cost - costBasisSold;  // cost is actually proceeds when selling
        newRealizedPnl = currentRealizedPnl + realizedPnL;
        newYes = truncateToOnChainPrecision(Math.max(0, currentYes - sharesToAdd));
        // Reduce total cost by the cost basis of sold shares
        newCost = Math.max(0, currentCost - costBasisSold);
        // Average entry stays the same for remaining shares
      } else {
        // Calculate realized PnL for NO shares
        const costBasisSold = currentAvgNo * sharesToAdd;
        const realizedPnL = cost - costBasisSold;
        newRealizedPnl = currentRealizedPnl + realizedPnL;
        newNo = truncateToOnChainPrecision(Math.max(0, currentNo - sharesToAdd));
        newCost = Math.max(0, currentCost - costBasisSold);
      }
    }
    
    await db
      .update(positions)
      .set({
        yesShares: newYes.toString(),
        noShares: newNo.toString(),
        totalCost: newCost.toString(),
        avgEntryYes: newAvgYes.toString(),
        avgEntryNo: newAvgNo.toString(),
        realizedPnl: newRealizedPnl.toString(),
        updatedAt: new Date(),
      })
      .where(eq(positions.id, position.id));
  }

  /**
   * Get positions for settlement (all open positions in a resolved market)
   */
  async getPositionsForSettlement(marketId: string): Promise<Position[]> {
    const result = await db
      .select()
      .from(positions)
      .where(and(eq(positions.marketId, marketId), eq(positions.status, 'OPEN')));
    
    return result;
  }

  /**
   * Settle a position
   */
  async settlePosition(
    positionId: string,
    payout: number
  ): Promise<void> {
    await db
      .update(positions)
      .set({
        status: 'SETTLED',
        payout: payout.toString(),
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(positions.id, positionId));
  }

  /**
   * Get user settlements history
   */
  async getUserSettlements(userId: string, limit: number = 50) {
    const result = await db
      .select({
        settlement: settlements,
        market: {
          pubkey: markets.pubkey,
          asset: markets.asset,
          timeframe: markets.timeframe,
        },
      })
      .from(settlements)
      .leftJoin(markets, eq(settlements.marketId, markets.id))
      .where(eq(settlements.userId, userId))
      .orderBy(sql`${settlements.createdAt} DESC`)
      .limit(limit);
    
    return result;
  }
}

export const positionService = new PositionService();





