import { eq, and, sql } from 'drizzle-orm';
import { db, positions, markets, settlements, marginAccounts, type Position, type NewPosition } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { lendingService } from './lending.service.js';

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
    
    // Round shares to 6 decimal places to match on-chain precision.
    // On-chain stores shares as u64 with 6 decimals (e.g., 1.5 shares = 1_500_000).
    // Math.round is used instead of Math.floor because values going through
    // float division→multiplication round-trips (e.g., lamports/1e6 then *1e6)
    // can lose up to ~1e-10 precision. Math.floor would truncate 142856.9999999
    // to 142856 instead of 142857. Since all share values are exact multiples
    // of 1e-6, Math.round always gives the correct integer.
    const truncateToOnChainPrecision = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
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
        // Re-open position if adding shares to a settled position
        // This handles the case where user closes a position and opens a new one on the same market
        status: isBuy ? 'OPEN' : position.status,
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
   * Also handles margin accounts - repays loans when leveraged positions settle
   */
  async settlePosition(
    positionId: string,
    payout: number
  ): Promise<void> {
    // Check if this position has a margin account (leveraged position)
    const [marginAccount] = await db
      .select()
      .from(marginAccounts)
      .where(and(
        eq(marginAccounts.positionId, positionId),
        eq(marginAccounts.status, 'OPEN')
      ))
      .limit(1);
    
    // If there's an open margin account, repay the loan
    if (marginAccount) {
      const loanAmount = parseFloat(marginAccount.loanAmount);
      
      if (loanAmount > 0) {
        // Repay the loan from the payout
        await lendingService.recordRepayment(loanAmount);
        logger.info(`Loan repaid on settlement: $${loanAmount.toFixed(2)} for position ${positionId}`);
      }
      
      // Close the margin account
      await db
        .update(marginAccounts)
        .set({
          status: 'CLOSED',
          updatedAt: new Date(),
        })
        .where(eq(marginAccounts.id, marginAccount.id));
      
      logger.info(`Closed margin account ${marginAccount.id} on position settlement`);
    }
    
    // Mark position as settled
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

  /**
   * Mark a position as settled (used when leveraged positions are manually closed)
   * FIX L5: Prevents position-settler from trying to settle already-closed positions
   */
  async markAsSettled(positionId: string, payout: number): Promise<void> {
    await db
      .update(positions)
      .set({
        status: 'SETTLED',
        payout: payout.toString(),
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(positions.id, positionId));
    
    logger.info(`Position ${positionId} marked as SETTLED (manual leveraged close, payout: $${payout.toFixed(2)})`);
  }
}

export const positionService = new PositionService();





