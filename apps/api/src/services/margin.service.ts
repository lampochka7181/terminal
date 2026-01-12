import { eq, and, sql, lt, lte } from 'drizzle-orm';
import { 
  db, 
  marginAccounts, 
  liquidations, 
  marginTransactions,
  positions,
  markets,
  type MarginAccount, 
  type NewMarginAccount,
  type Liquidation,
  type NewLiquidation,
  type Position,
  type Market,
} from '../db/index.js';
import { userService } from './user.service.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { lendingService } from './lending.service.js';

/**
 * Leverage/Margin calculation utilities
 */
export const leverageCalc = {
  /**
   * Calculate initial margin required for a leveraged position
   * Initial Margin = Total Position / Leverage
   * 
   * Example: 5x leverage on $100 position = $20 margin, $80 loan
   */
  initialMarginRequired(totalPosition: number, leverage: number): number {
    return totalPosition / leverage;
  },
  
  /**
   * Calculate loan amount for a leveraged position
   * Loan = Total Position - Initial Margin
   */
  loanAmount(totalPosition: number, leverage: number): number {
    const margin = this.initialMarginRequired(totalPosition, leverage);
    return totalPosition - margin;
  },
  
  /**
   * Calculate liquidation price for a YES position (long)
   * 
   * Margin Ratio = Equity / Position Value
   * Equity = (Price × Shares) - Loan
   * 
   * Liquidation when: Margin Ratio < Maintenance Margin
   * => (Price × Shares - Loan) / (Price × Shares) < Maint%
   * => Price × Shares × (1 - Maint%) < Loan
   * => Price < Loan / (Shares × (1 - Maint%))
   */
  liquidationPriceYes(
    shares: number,
    _entryPrice: number, // Kept for API compatibility
    loanAmount: number,
    maintenanceMarginPct: number = config.leverage.maintenanceMarginPct
  ): number {
    if (shares <= 0 || loanAmount <= 0) return 0;
    
    const liqPrice = loanAmount / (shares * (1 - maintenanceMarginPct));
    
    // Liquidation price can't be below 0.01 or above 0.99
    return Math.max(0.01, Math.min(0.99, liqPrice));
  },
  
  /**
   * Calculate liquidation price for a NO position
   * Returns the NO PRICE at which liquidation occurs (not the YES price!)
   * 
   * For NO: Position Value = NO_Price × Shares = (1 - YES Price) × Shares
   * Equity = Position Value - Loan = NO_Price × Shares - Loan
   * 
   * Liquidation when equity/position_value < maintenance margin:
   * => (NO_Price × Shares - Loan) / (NO_Price × Shares) < Maint%
   * => NO_Price × Shares × (1 - Maint%) < Loan
   * => NO_Price < Loan / (Shares × (1 - Maint%))
   * 
   * This is the same formula as YES positions - liquidation occurs when
   * the position's price drops to this level.
   */
  liquidationPriceNo(
    shares: number,
    _entryPrice: number, // Kept for API compatibility
    loanAmount: number,
    maintenanceMarginPct: number = config.leverage.maintenanceMarginPct
  ): number {
    if (shares <= 0 || loanAmount <= 0) return 0;
    
    // The NO liquidation price is where NO drops to (same formula as YES)
    const noLiqPrice = loanAmount / (shares * (1 - maintenanceMarginPct));
    
    // Liquidation price can't be below 0.01 or above 0.99
    return Math.max(0.01, Math.min(0.99, noLiqPrice));
  },
  
  /**
   * Calculate current equity for a margin position
   */
  currentEquity(
    side: 'YES' | 'NO',
    shares: number,
    currentPrice: number,
    loanAmount: number
  ): number {
    if (side === 'YES') {
      return (currentPrice * shares) - loanAmount;
    } else {
      return ((1 - currentPrice) * shares) - loanAmount;
    }
  },
  
  /**
   * Calculate margin ratio (equity / position value)
   */
  marginRatio(
    side: 'YES' | 'NO',
    shares: number,
    currentPrice: number,
    loanAmount: number
  ): number {
    const equity = this.currentEquity(side, shares, currentPrice, loanAmount);
    const positionValue = side === 'YES' ? currentPrice * shares : (1 - currentPrice) * shares;
    return positionValue > 0 ? equity / positionValue : 0;
  },
  
  /**
   * Check if position should be liquidated
   * @param currentPrice - Current YES price from orderbook
   * @param liquidationPrice - Liquidation price in the SAME units as the position
   *                          (YES price for YES positions, NO price for NO positions)
   */
  shouldLiquidate(
    side: 'YES' | 'NO',
    shares: number,
    currentPrice: number, // This is YES price from orderbook
    liquidationPrice: number
  ): boolean {
    if (side === 'YES') {
      // YES positions liquidate when YES price drops to/below liquidation price
      return currentPrice <= liquidationPrice;
    } else {
      // NO positions liquidate when NO price drops to/below liquidation price
      // NO price = 1 - YES price
      const currentNoPrice = 1 - currentPrice;
      return currentNoPrice <= liquidationPrice;
    }
  },
  
  /**
   * Calculate new liquidation price after adding margin
   */
  newLiquidationPriceAfterMarginAdd(
    side: 'YES' | 'NO',
    shares: number,
    entryPrice: number,
    currentLoan: number,
    marginToAdd: number
  ): { newLoan: number; newLiqPrice: number } {
    // Adding margin reduces the loan
    const newLoan = Math.max(0, currentLoan - marginToAdd);
    
    const newLiqPrice = side === 'YES'
      ? this.liquidationPriceYes(shares, entryPrice, newLoan)
      : this.liquidationPriceNo(shares, entryPrice, newLoan);
    
    return { newLoan, newLiqPrice };
  },
};

/**
 * Margin Account Service
 * 
 * Manages leveraged positions including:
 * - Creating margin accounts
 * - Calculating liquidation prices
 * - Adding/withdrawing margin
 * - Finding positions to liquidate
 */
export class MarginService {
  
  /**
   * Create a new margin account for a leveraged position
   */
  async createMarginAccount(params: {
    userId: string;
    positionId: string;
    marketId: string;
    side: 'YES' | 'NO';
    shares: number;
    entryPrice: number;
    leverage: number;
    marginDeposited: number;
    loanAmount: number;
  }): Promise<MarginAccount> {
    const { userId, positionId, marketId, side, shares, entryPrice, leverage, marginDeposited, loanAmount } = params;
    
    // Validate leverage
    if (leverage < config.leverage.minLeverage || leverage > config.leverage.maxLeverage) {
      throw new Error(`Leverage must be between ${config.leverage.minLeverage}x and ${config.leverage.maxLeverage}x`);
    }
    
    // Validate minimum margin
    if (marginDeposited < config.leverage.minMarginUsd) {
      throw new Error(`Minimum margin is $${config.leverage.minMarginUsd}`);
    }
    
    // Check if lending pool can provide the loan
    const loanCheck = await lendingService.canMakeLoan(loanAmount, userId);
    if (!loanCheck.canLoan) {
      throw new Error(loanCheck.reason || 'Cannot make loan');
    }
    
    // Calculate liquidation price
    const liquidationPrice = side === 'YES'
      ? leverageCalc.liquidationPriceYes(shares, entryPrice, loanAmount)
      : leverageCalc.liquidationPriceNo(shares, entryPrice, loanAmount);
    
    // Create margin account
    const [account] = await db
      .insert(marginAccounts)
      .values({
        userId,
        positionId,
        marketId,
        side,
        shares: shares.toString(),
        entryPrice: entryPrice.toString(),
        marginDeposited: marginDeposited.toString(),
        loanAmount: loanAmount.toString(),
        leverage: leverage.toString(),
        liquidationPrice: liquidationPrice.toString(),
        status: 'OPEN',
      })
      .returning();
    
    // Record loan in lending pool
    await lendingService.recordLoan(loanAmount);
    
    logger.info(`Created margin account: ${account.id} - ${leverage}x ${side} @ $${entryPrice}, liq=$${liquidationPrice.toFixed(4)}`);
    
    return account;
  }
  
  /**
   * Get margin account by ID
   */
  async getById(id: string): Promise<MarginAccount | null> {
    const result = await db
      .select()
      .from(marginAccounts)
      .where(eq(marginAccounts.id, id))
      .limit(1);
    
    return result[0] || null;
  }
  
  /**
   * Get margin account for a position
   */
  async getByPositionId(positionId: string): Promise<MarginAccount | null> {
    const result = await db
      .select()
      .from(marginAccounts)
      .where(eq(marginAccounts.positionId, positionId))
      .limit(1);
    
    return result[0] || null;
  }
  
  /**
   * Get all open margin accounts for a user
   */
  async getUserMarginAccounts(userId: string): Promise<(MarginAccount & { market?: Market })[]> {
    const result = await db
      .select({
        account: marginAccounts,
        market: markets,
      })
      .from(marginAccounts)
      .leftJoin(markets, eq(marginAccounts.marketId, markets.id))
      .where(and(
        eq(marginAccounts.userId, userId),
        eq(marginAccounts.status, 'OPEN')
      ));
    
    return result.map(r => ({
      ...r.account,
      market: r.market || undefined,
    }));
  }
  
  /**
   * Add margin to a position (reduces loan, improves liquidation price)
   */
  async addMargin(marginAccountId: string, amount: number): Promise<{
    newLoan: number;
    newLiqPrice: number;
  }> {
    const account = await this.getById(marginAccountId);
    if (!account) {
      throw new Error('Margin account not found');
    }
    
    if (account.status !== 'OPEN') {
      throw new Error('Cannot add margin to closed account');
    }
    
    const currentLoan = parseFloat(account.loanAmount);
    const shares = parseFloat(account.shares);
    const entryPrice = parseFloat(account.entryPrice);
    const side = account.side as 'YES' | 'NO';
    
    // Calculate new loan and liquidation price
    const { newLoan, newLiqPrice } = leverageCalc.newLiquidationPriceAfterMarginAdd(
      side,
      shares,
      entryPrice,
      currentLoan,
      amount
    );
    
    // Update margin account
    await db
      .update(marginAccounts)
      .set({
        marginDeposited: sql`${marginAccounts.marginDeposited} + ${amount}`,
        loanAmount: newLoan.toString(),
        liquidationPrice: newLiqPrice.toString(),
        leverage: (shares * entryPrice / (parseFloat(account.marginDeposited) + amount)).toString(),
        updatedAt: new Date(),
      })
      .where(eq(marginAccounts.id, marginAccountId));
    
    // Record repayment if loan reduced
    const loanReduction = currentLoan - newLoan;
    if (loanReduction > 0) {
      await lendingService.recordRepayment(loanReduction);
    }
    
    // Record transaction
    await db.insert(marginTransactions).values({
      marginAccountId,
      userId: account.userId,
      type: 'DEPOSIT',
      amount: amount.toString(),
      loanBefore: currentLoan.toString(),
      loanAfter: newLoan.toString(),
      liqPriceBefore: account.liquidationPrice,
      liqPriceAfter: newLiqPrice.toString(),
    });
    
    logger.info(`Added $${amount} margin to account ${marginAccountId}. Loan: $${currentLoan} → $${newLoan}, Liq: $${account.liquidationPrice} → $${newLiqPrice.toFixed(4)}`);
    
    return { newLoan, newLiqPrice };
  }
  
  /**
   * Find all margin accounts that should be liquidated
   * 
   * This queries for YES positions where current price ≤ liquidation price
   * and NO positions where current price ≥ liquidation price
   */
  async findAccountsToLiquidate(currentPrices: Map<string, number>): Promise<{
    account: MarginAccount;
    market: Market;
    currentPrice: number;
  }[]> {
    // Get all open margin accounts with their markets
    const accounts = await db
      .select({
        account: marginAccounts,
        market: markets,
      })
      .from(marginAccounts)
      .innerJoin(markets, eq(marginAccounts.marketId, markets.id))
      .where(and(
        eq(marginAccounts.status, 'OPEN'),
        eq(markets.status, 'OPEN')
      ));
    
    const toLiquidate: { account: MarginAccount; market: Market; currentPrice: number }[] = [];
    
    for (const { account, market } of accounts) {
      // Get current price for this market
      const currentPrice = currentPrices.get(market.id) 
        || parseFloat(market.yesPrice || '0.5');
      
      const liquidationPrice = parseFloat(account.liquidationPrice);
      const side = account.side as 'YES' | 'NO';
      
      if (leverageCalc.shouldLiquidate(side, parseFloat(account.shares), currentPrice, liquidationPrice)) {
        toLiquidate.push({ account, market, currentPrice });
      }
    }
    
    return toLiquidate;
  }
  
  /**
   * Execute liquidation for a margin account
   * Returns the liquidation record
   */
  async liquidate(
    marginAccountId: string,
    triggerPrice: number,
    executionPrice: number
  ): Promise<Liquidation> {
    const account = await this.getById(marginAccountId);
    if (!account) {
      throw new Error('Margin account not found');
    }
    
    if (account.status !== 'OPEN') {
      throw new Error('Account already liquidated or closed');
    }
    
    const shares = parseFloat(account.shares);
    const loanAmount = parseFloat(account.loanAmount);
    const marginDeposited = parseFloat(account.marginDeposited);
    const side = account.side as 'YES' | 'NO';
    
    // Calculate liquidation proceeds
    // For YES: we sell shares at execution price
    // For NO: we sell shares, receiving (1 - execution price)
    const proceeds = side === 'YES'
      ? shares * executionPrice
      : shares * (1 - executionPrice);
    
    // Calculate penalty (2% of position value)
    const positionValue = shares * parseFloat(account.entryPrice);
    const penalty = positionValue * config.leverage.liquidationPenaltyPct;
    
    // Calculate what's returned to user
    // Order: 1) Repay loan, 2) Take penalty, 3) Return remainder to user
    const afterLoanRepaid = proceeds - loanAmount;
    const returnedToUser = Math.max(0, afterLoanRepaid - penalty);
    const actualPenalty = Math.min(penalty, Math.max(0, afterLoanRepaid));
    
    // Calculate bad debt (if proceeds don't cover loan)
    const badDebt = Math.max(0, loanAmount - proceeds);
    
    // Create liquidation record
    const [liquidation] = await db
      .insert(liquidations)
      .values({
        marginAccountId,
        userId: account.userId,
        marketId: account.marketId,
        triggerPrice: triggerPrice.toString(),
        executionPrice: executionPrice.toString(),
        sharesLiquidated: shares.toString(),
        proceeds: proceeds.toString(),
        loanRepaid: Math.min(loanAmount, proceeds).toString(),
        penalty: actualPenalty.toString(),
        returnedToUser: returnedToUser.toString(),
        badDebt: badDebt.toString(),
      })
      .returning();
    
    // Update margin account status
    await db
      .update(marginAccounts)
      .set({
        status: 'LIQUIDATED',
        updatedAt: new Date(),
      })
      .where(eq(marginAccounts.id, marginAccountId));
    
    // Close the position (zero out the shares)
    if (account.positionId) {
      const updateData = side === 'YES' 
        ? { yesShares: '0', status: 'SETTLED', settledAt: new Date(), updatedAt: new Date() }
        : { noShares: '0', status: 'SETTLED', settledAt: new Date(), updatedAt: new Date() };
      
      await db
        .update(positions)
        .set(updateData)
        .where(eq(positions.id, account.positionId));
      
      logger.info(`Closed position ${account.positionId} after liquidation`);
    }
    
    // Record loan repayment
    const loanRepaid = Math.min(loanAmount, proceeds);
    if (loanRepaid > 0) {
      await lendingService.recordRepayment(loanRepaid);
    }
    
    // Record penalty to insurance fund
    if (actualPenalty > 0) {
      await lendingService.recordPenalty(actualPenalty);
    }
    
    // Handle bad debt
    if (badDebt > 0) {
      logger.warn(`Liquidation resulted in bad debt: $${badDebt.toFixed(2)}`);
      // Try to cover from insurance fund
      const covered = await lendingService.coverBadDebt(badDebt);
      if (!covered) {
        logger.error(`Insurance fund insufficient to cover bad debt: $${badDebt.toFixed(2)}`);
      }
    }
    
    // Transfer remaining funds back to user
    if (returnedToUser > 0) {
      // Get user's wallet address
      const user = await userService.findById(account.userId);
      if (user?.walletAddress) {
        const transferSig = await lendingService.transferToUser(user.walletAddress, returnedToUser);
        if (transferSig) {
          logger.info(`✅ Liquidation: Transferred $${returnedToUser.toFixed(2)} back to user ${user.walletAddress.slice(0, 8)}: ${transferSig}`);
        } else {
          logger.error(`❌ Liquidation: Failed to transfer $${returnedToUser.toFixed(2)} back to user ${user.walletAddress.slice(0, 8)}`);
        }
      } else {
        logger.error(`❌ Liquidation: Could not find wallet for user ${account.userId} to return $${returnedToUser.toFixed(2)}`);
      }
    }
    
    logger.info(`Liquidated account ${marginAccountId}: proceeds=$${proceeds.toFixed(2)}, loan=$${loanAmount.toFixed(2)}, penalty=$${actualPenalty.toFixed(2)}, returnedToUser=$${returnedToUser.toFixed(2)}, badDebt=$${badDebt.toFixed(2)}`);
    
    return liquidation;
  }
  
  /**
   * Close margin account (when position is manually closed or market settles)
   */
  async closeAccount(marginAccountId: string): Promise<void> {
    const account = await this.getById(marginAccountId);
    if (!account) {
      throw new Error('Margin account not found');
    }
    
    if (account.status !== 'OPEN') {
      return; // Already closed
    }
    
    const loanAmount = parseFloat(account.loanAmount);
    
    // Record loan repayment
    if (loanAmount > 0) {
      await lendingService.recordRepayment(loanAmount);
    }
    
    // Update status
    await db
      .update(marginAccounts)
      .set({
        status: 'CLOSED',
        loanAmount: '0',
        updatedAt: new Date(),
      })
      .where(eq(marginAccounts.id, marginAccountId));
    
    logger.info(`Closed margin account ${marginAccountId}`);
  }
  
  /**
   * Get margin account health metrics
   */
  async getAccountHealth(marginAccountId: string, currentPrice: number): Promise<{
    equity: number;
    marginRatio: number;
    distanceToLiq: number;
    distanceToLiqPct: number;
    isAtRisk: boolean;
  }> {
    const account = await this.getById(marginAccountId);
    if (!account) {
      throw new Error('Margin account not found');
    }
    
    const shares = parseFloat(account.shares);
    const loanAmount = parseFloat(account.loanAmount);
    const liquidationPrice = parseFloat(account.liquidationPrice);
    const side = account.side as 'YES' | 'NO';
    
    const equity = leverageCalc.currentEquity(side, shares, currentPrice, loanAmount);
    const marginRatio = leverageCalc.marginRatio(side, shares, currentPrice, loanAmount);
    
    // Distance to liquidation
    const distanceToLiq = side === 'YES'
      ? currentPrice - liquidationPrice
      : liquidationPrice - currentPrice;
    
    const distanceToLiqPct = side === 'YES'
      ? (distanceToLiq / currentPrice) * 100
      : (distanceToLiq / (1 - currentPrice)) * 100;
    
    // Consider "at risk" if within 20% of liquidation
    const isAtRisk = distanceToLiqPct < 20;
    
    return {
      equity,
      marginRatio,
      distanceToLiq,
      distanceToLiqPct,
      isAtRisk,
    };
  }
  
  /**
   * Get user's liquidation history
   */
  async getUserLiquidations(userId: string, limit: number = 50): Promise<Liquidation[]> {
    const result = await db
      .select()
      .from(liquidations)
      .where(eq(liquidations.userId, userId))
      .orderBy(sql`${liquidations.createdAt} DESC`)
      .limit(limit);
    
    return result;
  }
}

export const marginService = new MarginService();

