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
import { redis } from '../db/redis.js';
import { userService } from './user.service.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { lendingService } from './lending.service.js';

// Cache key for liquidation checker short-circuit (must match liquidation-checker.ts)
const OPEN_ACCOUNTS_CACHE_KEY = 'liquidation:has_open_accounts';

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
    const { userId, positionId, marketId, side, entryPrice, leverage, marginDeposited, loanAmount } = params;
    
    // Floor shares to 6 decimal places to match on-chain precision
    // Smart contract uses SHARE_MULTIPLIER = 10^6, so we must floor to avoid
    // "InsufficientShares" errors when trying to sell slightly more than we have
    const shares = Math.floor(params.shares * 1_000_000) / 1_000_000;
    
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

    // Invalidate liquidation checker cache so it starts checking immediately
    try {
      await redis.set(OPEN_ACCOUNTS_CACHE_KEY, '1', 'EX', 10);
    } catch {
      // Ignore Redis errors - non-critical
    }

    logger.info(`Created margin account: ${account.id} - ${leverage}x ${side} @ $${entryPrice}, liq=$${liquidationPrice.toFixed(4)} (pending on-chain confirmation)`);
    
    return account;
  }
  
  /**
   * Set the on-chain transaction signature for a margin account
   * Called after execute_match is submitted
   */
  async setOnChainTxSignature(accountId: string, signature: string): Promise<void> {
    await db
      .update(marginAccounts)
      .set({
        onChainTxSignature: signature,
        updatedAt: new Date(),
      })
      .where(eq(marginAccounts.id, accountId));
    
    logger.debug(`Set on-chain tx signature for margin account ${accountId}: ${signature.slice(0, 8)}...`);
  }
  
  /**
   * Confirm that the on-chain position exists
   * Called after execute_match transaction is confirmed
   */
  async confirmOnChain(accountId: string): Promise<void> {
    await db
      .update(marginAccounts)
      .set({
        onChainConfirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(marginAccounts.id, accountId));
    
    logger.info(`Margin account ${accountId} confirmed on-chain`);
  }
  
  /**
   * Check if a margin account's on-chain position is confirmed
   */
  async isOnChainConfirmed(accountId: string): Promise<boolean> {
    const result = await db
      .select({ onChainConfirmedAt: marginAccounts.onChainConfirmedAt })
      .from(marginAccounts)
      .where(eq(marginAccounts.id, accountId))
      .limit(1);
    
    return result.length > 0 && result[0].onChainConfirmedAt !== null;
  }
  
  /**
   * Set liquidation lock on a margin account (blocks user sells)
   * Call this BEFORE starting on-chain liquidation
   */
  async setLiquidationLock(accountId: string): Promise<boolean> {
    const result = await db
      .update(marginAccounts)
      .set({
        liquidatingAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(marginAccounts.id, accountId),
        eq(marginAccounts.status, 'OPEN')
      ))
      .returning({ id: marginAccounts.id });
    
    if (result.length > 0) {
      logger.info(`Liquidation lock set on margin account ${accountId}`);
      return true;
    }
    return false;
  }
  
  /**
   * Clear liquidation lock (if liquidation fails and needs retry)
   */
  async clearLiquidationLock(accountId: string): Promise<void> {
    await db
      .update(marginAccounts)
      .set({
        liquidatingAt: null,
        updatedAt: new Date(),
      })
      .where(eq(marginAccounts.id, accountId));
    
    logger.info(`Liquidation lock cleared on margin account ${accountId}`);
  }
  
  /**
   * Check if margin account is being liquidated (locked)
   * Returns timestamp if locked, null if not
   */
  async isBeingLiquidated(accountId: string): Promise<Date | null> {
    const result = await db
      .select({ liquidatingAt: marginAccounts.liquidatingAt })
      .from(marginAccounts)
      .where(eq(marginAccounts.id, accountId))
      .limit(1);
    
    return result[0]?.liquidatingAt || null;
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
   * Get margin account by user and market (for confirming after on-chain tx)
   */
  async getByUserAndMarket(userId: string, marketId: string): Promise<MarginAccount | null> {
    const result = await db
      .select()
      .from(marginAccounts)
      .where(and(
        eq(marginAccounts.userId, userId),
        eq(marginAccounts.marketId, marketId),
        eq(marginAccounts.status, 'OPEN')
      ))
      .limit(1);
    
    return result[0] || null;
  }
  
  /**
   * Get OPEN margin account for a position
   * Only returns active margin accounts - ignores closed ones from previous trades
   */
  async getByPositionId(positionId: string): Promise<MarginAccount | null> {
    const result = await db
      .select()
      .from(marginAccounts)
      .where(and(
        eq(marginAccounts.positionId, positionId),
        eq(marginAccounts.status, 'OPEN')
      ))
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
    // executionPrice is already in NATIVE terms for the position side:
    // - YES positions: executionPrice = YES liquidation price
    // - NO positions: executionPrice = NO liquidation price (NOT 1 - YES price!)
    // So proceeds = shares × executionPrice for BOTH sides
    const proceeds = shares * executionPrice;
    
    // Calculate what's returned to user
    // Order: 1) Repay loan, 2) Take penalty from remaining equity, 3) Return remainder
    const afterLoanRepaid = proceeds - loanAmount;
    
    // Calculate penalty as % of REMAINING EQUITY (not position value)
    // This ensures user gets a meaningful return on liquidation
    // Old: penalty = 2% of $500 position = $10 (too much!)
    // New: penalty = 2% of $14 equity = $0.28 (reasonable)
    const penalty = Math.max(0, afterLoanRepaid) * config.leverage.liquidationPenaltyPct;
    
    const returnedToUser = Math.max(0, afterLoanRepaid - penalty);
    const actualPenalty = penalty;
    
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
          
          // Update liquidation record with the equity transfer signature
          // This is the transaction the user cares about (where they received funds)
          await db
            .update(liquidations)
            .set({ txSignature: transferSig })
            .where(eq(liquidations.id, liquidation.id));
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
   * Update margin account after a partial close
   * Recalculates loan and liquidation price based on new share count
   */
  async updateAfterPartialClose(
    marginAccountId: string,
    sharesSold: number,
    loanRepaid: number
  ): Promise<{ newShares: number; newLoan: number; newLiqPrice: number }> {
    const account = await this.getById(marginAccountId);
    if (!account) {
      throw new Error('Margin account not found');
    }
    
    if (account.status !== 'OPEN') {
      throw new Error('Cannot update closed margin account');
    }
    
    const currentShares = parseFloat(account.shares);
    const currentLoan = parseFloat(account.loanAmount);
    const entryPrice = parseFloat(account.entryPrice);
    const side = account.side as 'YES' | 'NO';
    
    // Calculate new values
    // Floor new shares to match on-chain precision
    const newShares = Math.floor((currentShares - sharesSold) * 1_000_000) / 1_000_000;
    const newLoan = Math.max(0, currentLoan - loanRepaid);
    
    if (newShares <= 0) {
      // Full close - just close the account
      await this.closeAccount(marginAccountId);
      return { newShares: 0, newLoan: 0, newLiqPrice: 0 };
    }
    
    // Recalculate liquidation price with new shares/loan
    const newLiqPrice = side === 'YES'
      ? leverageCalc.liquidationPriceYes(newShares, entryPrice, newLoan)
      : leverageCalc.liquidationPriceNo(newShares, entryPrice, newLoan);
    
    // Calculate new leverage (position value / remaining margin)
    // Margin remaining is proportional: original margin * (remaining shares / original shares)
    const originalMargin = parseFloat(account.marginDeposited);
    const marginRemaining = originalMargin * (newShares / currentShares);
    const positionValue = newShares * entryPrice;
    const newLeverage = positionValue / marginRemaining;
    
    // Update the margin account
    await db
      .update(marginAccounts)
      .set({
        shares: newShares.toString(),
        loanAmount: newLoan.toString(),
        liquidationPrice: newLiqPrice.toString(),
        leverage: newLeverage.toFixed(2),
        marginDeposited: marginRemaining.toFixed(6),
        updatedAt: new Date(),
      })
      .where(eq(marginAccounts.id, marginAccountId));
    
    // Note: loanRepaid was already recorded when the partial close happened
    // (in orders.ts via lendingService.recordRepayment)
    
    logger.info(`Updated margin account ${marginAccountId} after partial close: shares ${currentShares.toFixed(2)} → ${newShares.toFixed(2)}, loan $${currentLoan.toFixed(2)} → $${newLoan.toFixed(2)}, liq $${account.liquidationPrice} → $${newLiqPrice.toFixed(4)}`);
    
    return { newShares, newLoan, newLiqPrice };
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

