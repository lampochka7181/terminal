/**
 * Leverage Flow Integration Tests
 * 
 * End-to-end tests for the complete leverage trading flow,
 * simulating the actual scenarios we tested manually.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ============================================================
// SIMULATION HELPERS
// ============================================================

interface MarginAccount {
  id: string;
  userId: string;
  side: 'YES' | 'NO';
  shares: number;
  entryPrice: number;
  leverage: number;
  marginDeposited: number;
  loanAmount: number;
  liquidationPrice: number;
  status: 'OPEN' | 'CLOSED' | 'LIQUIDATED';
  onChainConfirmed: boolean;
}

interface LendingPool {
  totalDeposits: number;
  availableLiquidity: number;
  totalLoaned: number;
}

interface InsuranceFund {
  balance: number;
}

// State containers
let marginAccounts: Map<string, MarginAccount>;
let lendingPool: LendingPool;
let insuranceFund: InsuranceFund;
let userBalance: number;
let nextAccountId: number;

const MAINTENANCE_MARGIN_PCT = 0.03;
const LIQUIDATION_PENALTY_PCT = 0.02;
const FEE_PER_FILL = 0.06;

function resetState() {
  marginAccounts = new Map();
  lendingPool = {
    totalDeposits: 1000000,
    availableLiquidity: 1000000,
    totalLoaned: 0,
  };
  insuranceFund = { balance: 10000 };
  userBalance = 1000;
  nextAccountId = 1;
}

function calcLiquidationPrice(shares: number, loanAmount: number): number {
  if (shares <= 0 || loanAmount <= 0) return 0;
  const liqPrice = loanAmount / (shares * (1 - MAINTENANCE_MARGIN_PCT));
  return Math.max(0.01, Math.min(0.99, liqPrice));
}

// ============================================================
// SIMULATED SERVICE FUNCTIONS
// ============================================================

function openLeveragedPosition(params: {
  userId: string;
  side: 'YES' | 'NO';
  totalPosition: number;
  leverage: number;
  entryPrice: number;
  fills: number;
}): MarginAccount {
  const { userId, side, totalPosition, leverage, entryPrice, fills } = params;
  
  const margin = totalPosition / leverage;
  const loan = totalPosition - margin;
  const fee = fills * FEE_PER_FILL;
  const shares = totalPosition / entryPrice;
  const liquidationPrice = calcLiquidationPrice(shares, loan);
  
  // Check user has enough balance
  if (userBalance < margin + fee) {
    throw new Error('Insufficient balance');
  }
  
  // Check lending pool has liquidity
  if (loan > lendingPool.availableLiquidity) {
    throw new Error('Insufficient lending pool liquidity');
  }
  
  // Collect margin + fee from user
  userBalance -= (margin + fee);
  
  // Record loan
  lendingPool.totalLoaned += loan;
  lendingPool.availableLiquidity -= loan;
  
  // Create margin account
  const account: MarginAccount = {
    id: `margin-${nextAccountId++}`,
    userId,
    side,
    shares,
    entryPrice,
    leverage,
    marginDeposited: margin,
    loanAmount: loan,
    liquidationPrice,
    status: 'OPEN',
    onChainConfirmed: true, // Simulate confirmed
  };
  
  marginAccounts.set(account.id, account);
  
  return account;
}

function closeLeveragedPosition(
  accountId: string,
  closePrice: number,
  sharesToClose?: number
): { proceeds: number; userEquity: number; loanRepaid: number } {
  const account = marginAccounts.get(accountId);
  if (!account) throw new Error('Account not found');
  if (account.status !== 'OPEN') throw new Error('Account not open');
  
  const sellShares = sharesToClose || account.shares;
  const isPartialClose = sellShares < account.shares;
  
  // Calculate proceeds
  const proceeds = sellShares * closePrice;
  
  // Calculate loan portion to repay
  const closeRatio = sellShares / account.shares;
  const loanRepaid = account.loanAmount * closeRatio;
  
  // User equity = proceeds - loan portion
  const userEquity = Math.max(0, proceeds - loanRepaid);
  
  // Update lending pool
  lendingPool.totalLoaned -= loanRepaid;
  lendingPool.availableLiquidity += loanRepaid;
  
  // Transfer equity to user
  userBalance += userEquity;
  
  if (isPartialClose) {
    // Update account for remaining position
    account.shares -= sellShares;
    account.loanAmount -= loanRepaid;
    account.liquidationPrice = calcLiquidationPrice(account.shares, account.loanAmount);
  } else {
    // Full close
    account.status = 'CLOSED';
    account.shares = 0;
    account.loanAmount = 0;
  }
  
  return { proceeds, userEquity, loanRepaid };
}

function liquidatePosition(
  accountId: string,
  currentYesPrice: number
): { proceeds: number; returnedToUser: number; penalty: number; badDebt: number } {
  const account = marginAccounts.get(accountId);
  if (!account) throw new Error('Account not found');
  if (account.status !== 'OPEN') throw new Error('Account not open');
  
  // Check liquidation trigger
  let currentPrice: number;
  if (account.side === 'YES') {
    currentPrice = currentYesPrice;
    if (currentPrice > account.liquidationPrice) {
      throw new Error('Not eligible for liquidation');
    }
  } else {
    currentPrice = 1 - currentYesPrice; // NO price
    if (currentPrice > account.liquidationPrice) {
      throw new Error('Not eligible for liquidation');
    }
  }
  
  // Execute at liquidation price (guarantees solvency)
  const executionPrice = account.liquidationPrice;
  const proceeds = account.shares * executionPrice;
  
  // Calculate penalty
  const penalty = proceeds * LIQUIDATION_PENALTY_PCT;
  
  // Calculate returned to user
  const returnedToUser = Math.max(0, proceeds - account.loanAmount - penalty);
  
  // Calculate bad debt (if any)
  const badDebt = Math.max(0, account.loanAmount - proceeds + penalty);
  
  // Update lending pool
  const actualRepayment = Math.min(proceeds - penalty, account.loanAmount);
  lendingPool.totalLoaned -= account.loanAmount;
  lendingPool.availableLiquidity += actualRepayment;
  
  // Record penalty to insurance fund
  insuranceFund.balance += penalty;
  
  // Transfer equity to user
  userBalance += returnedToUser;
  
  // Update account
  account.status = 'LIQUIDATED';
  account.shares = 0;
  account.loanAmount = 0;
  
  return { proceeds, returnedToUser, penalty, badDebt };
}

function settleWinningPosition(
  accountId: string
): { payout: number; userProfit: number; loanRepaid: number } {
  const account = marginAccounts.get(accountId);
  if (!account) throw new Error('Account not found');
  if (account.status !== 'OPEN') throw new Error('Account not open');
  
  // Winning payout = shares * $1
  const payout = account.shares * 1;
  
  // Repay loan
  const loanRepaid = account.loanAmount;
  const userProfit = payout - loanRepaid;
  
  // Update lending pool
  lendingPool.totalLoaned -= loanRepaid;
  lendingPool.availableLiquidity += loanRepaid;
  
  // Transfer profit to user
  userBalance += userProfit;
  
  // Close account
  account.status = 'CLOSED';
  
  return { payout, userProfit, loanRepaid };
}

// ============================================================
// TEST SUITES
// ============================================================

describe('Complete Leverage Flow', () => {
  beforeEach(() => {
    resetState();
  });
  
  describe('Scenario 1.1: Open 5x YES Position', () => {
    it('opens position and calculates correct liquidation price', () => {
      const initialBalance = userBalance;
      
      const account = openLeveragedPosition({
        userId: 'user-1',
        side: 'YES',
        totalPosition: 250,
        leverage: 5,
        entryPrice: 0.42,
        fills: 7, // 7 fills × $0.06 = $0.42 fee
      });
      
      // Verify account
      expect(account.shares).toBeCloseTo(595.24, 1);
      expect(account.marginDeposited).toBe(50);
      expect(account.loanAmount).toBe(200);
      expect(account.liquidationPrice).toBeCloseTo(0.3464, 3);
      
      // Verify user balance deducted
      const expectedDeduction = 50 + (7 * 0.06); // margin + fee
      expect(userBalance).toBeCloseTo(initialBalance - expectedDeduction, 2);
      
      // Verify lending pool
      expect(lendingPool.totalLoaned).toBe(200);
      expect(lendingPool.availableLiquidity).toBe(999800);
    });
  });
  
  describe('Scenario 1.2: Open 10x NO Position', () => {
    it('opens NO position with correct calculations', () => {
      const account = openLeveragedPosition({
        userId: 'user-1',
        side: 'NO',
        totalPosition: 500,
        leverage: 10,
        entryPrice: 0.81, // NO price
        fills: 13,
      });
      
      expect(account.shares).toBeCloseTo(617.28, 1);
      expect(account.marginDeposited).toBe(50);
      expect(account.loanAmount).toBe(450);
      expect(account.liquidationPrice).toBeCloseTo(0.7515, 2);
    });
  });
  
  describe('Scenario 3.1: Full Close with Profit', () => {
    it('closes position and returns correct equity', () => {
      // Open position
      const account = openLeveragedPosition({
        userId: 'user-1',
        side: 'YES',
        totalPosition: 250,
        leverage: 5,
        entryPrice: 0.42,
        fills: 7,
      });
      
      const balanceAfterOpen = userBalance;
      
      // Price goes up, close at $0.48
      const result = closeLeveragedPosition(account.id, 0.48);
      
      // Proceeds = 595.24 * 0.48 = $285.72
      // Loan repaid = $200
      // User equity = $85.72
      expect(result.proceeds).toBeCloseTo(285.72, 0);
      expect(result.loanRepaid).toBe(200);
      expect(result.userEquity).toBeCloseTo(85.72, 0);
      
      // User balance should increase by equity
      expect(userBalance).toBeCloseTo(balanceAfterOpen + result.userEquity, 0);
      
      // Lending pool restored
      expect(lendingPool.totalLoaned).toBe(0);
      
      // Account closed
      expect(marginAccounts.get(account.id)!.status).toBe('CLOSED');
    });
  });
  
  describe('Scenario 3.2: Full Close with Loss', () => {
    it('closes position at loss but repays loan', () => {
      const account = openLeveragedPosition({
        userId: 'user-1',
        side: 'YES',
        totalPosition: 250,
        leverage: 5,
        entryPrice: 0.42,
        fills: 7,
      });
      
      // Price drops, close at $0.38
      const result = closeLeveragedPosition(account.id, 0.38);
      
      // Proceeds = 595.24 * 0.38 = $226.19
      // Loan repaid = $200
      // User equity = $26.19
      expect(result.proceeds).toBeCloseTo(226.19, 0);
      expect(result.loanRepaid).toBe(200);
      expect(result.userEquity).toBeCloseTo(26.19, 0);
      
      // User lost money compared to margin ($50) but loan is repaid
      expect(result.userEquity).toBeLessThan(50);
    });
  });
  
  describe('Scenario 3.3: Partial Close', () => {
    it('partially closes position and updates account correctly', () => {
      const account = openLeveragedPosition({
        userId: 'user-1',
        side: 'YES',
        totalPosition: 250,
        leverage: 5,
        entryPrice: 0.42,
        fills: 7,
      });
      
      const initialShares = account.shares;
      const initialLoan = account.loanAmount;
      
      // Sell 297 shares (~50%)
      const sellShares = 297;
      const result = closeLeveragedPosition(account.id, 0.40, sellShares);
      
      // Proceeds = 297 * 0.40 = $118.80
      // Close ratio = 297 / 595.24 = 0.499
      // Loan repaid = 200 * 0.499 = $99.79
      // User equity = $118.80 - $99.79 = $19.01
      expect(result.proceeds).toBeCloseTo(118.80, 1);
      expect(result.loanRepaid).toBeCloseTo(99.79, 1);
      expect(result.userEquity).toBeCloseTo(19.01, 1);
      
      // Account should be updated
      const updatedAccount = marginAccounts.get(account.id)!;
      expect(updatedAccount.status).toBe('OPEN'); // Still open
      expect(updatedAccount.shares).toBeCloseTo(initialShares - sellShares, 1);
      expect(updatedAccount.loanAmount).toBeCloseTo(initialLoan - result.loanRepaid, 1);
      
      // Liquidation price should stay ~same
      expect(updatedAccount.liquidationPrice).toBeCloseTo(0.3464, 2);
    });
  });
  
  describe('Scenario 4.1: YES Position Liquidation', () => {
    it('liquidates YES position when price drops', () => {
      const account = openLeveragedPosition({
        userId: 'user-1',
        side: 'YES',
        totalPosition: 250,
        leverage: 5,
        entryPrice: 0.51,
        fills: 5,
      });
      
      const balanceAfterOpen = userBalance;
      const liqPrice = account.liquidationPrice;
      
      // Price drops below liquidation
      const currentYesPrice = liqPrice - 0.01;
      const result = liquidatePosition(account.id, currentYesPrice);
      
      // Executed at liq price for solvency
      // Proceeds = shares * liq price
      expect(result.proceeds).toBeGreaterThan(0);
      expect(result.penalty).toBeCloseTo(result.proceeds * 0.02, 2);
      expect(result.returnedToUser).toBeGreaterThanOrEqual(0);
      expect(result.badDebt).toBe(0); // No bad debt when executed at liq price
      
      // User gets some money back
      expect(userBalance).toBeGreaterThan(balanceAfterOpen);
      
      // Insurance fund received penalty
      expect(insuranceFund.balance).toBeGreaterThan(10000);
      
      // Lending pool whole
      expect(lendingPool.totalLoaned).toBe(0);
    });
  });
  
  describe('Scenario 4.2: NO Position Liquidation', () => {
    it('liquidates NO position when NO price drops', () => {
      const account = openLeveragedPosition({
        userId: 'user-1',
        side: 'NO',
        totalPosition: 250,
        leverage: 5,
        entryPrice: 0.164, // NO price
        fills: 41,
      });
      
      const balanceAfterOpen = userBalance;
      
      // YES price goes to 0.91, meaning NO = 0.09 < liq price ~0.135
      const currentYesPrice = 0.91;
      const result = liquidatePosition(account.id, currentYesPrice);
      
      expect(result.proceeds).toBeGreaterThan(0);
      expect(result.returnedToUser).toBeGreaterThanOrEqual(0);
      
      // Account liquidated
      expect(marginAccounts.get(account.id)!.status).toBe('LIQUIDATED');
    });
  });
  
  describe('Scenario 6.1: Settlement WIN', () => {
    it('settles winning position correctly', () => {
      const account = openLeveragedPosition({
        userId: 'user-1',
        side: 'NO',
        totalPosition: 500,
        leverage: 10,
        entryPrice: 0.81,
        fills: 7,
      });
      
      const balanceAfterOpen = userBalance;
      
      // Market resolves NO wins
      const result = settleWinningPosition(account.id);
      
      // Payout = shares * $1
      // ~617 shares * $1 = $617
      expect(result.payout).toBeCloseTo(617.28, 0);
      expect(result.loanRepaid).toBe(450);
      expect(result.userProfit).toBeCloseTo(167.28, 0);
      
      // User profit added
      expect(userBalance).toBeCloseTo(balanceAfterOpen + result.userProfit, 0);
      
      // Lending pool restored
      expect(lendingPool.totalLoaned).toBe(0);
    });
  });
  
  describe('Scenario: Partial Close then Liquidation', () => {
    it('handles partial close followed by liquidation of remaining', () => {
      // 1. Open position
      const account = openLeveragedPosition({
        userId: 'user-1',
        side: 'YES',
        totalPosition: 250,
        leverage: 5,
        entryPrice: 0.42,
        fills: 7,
      });
      
      const balanceAfterOpen = userBalance;
      
      // 2. Partial close at $0.40
      const closeResult = closeLeveragedPosition(account.id, 0.40, 297);
      const balanceAfterPartial = userBalance;
      
      expect(closeResult.userEquity).toBeCloseTo(19.01, 1);
      expect(marginAccounts.get(account.id)!.status).toBe('OPEN');
      
      // 3. Price drops, remaining position liquidated
      const updatedAccount = marginAccounts.get(account.id)!;
      const currentYesPrice = updatedAccount.liquidationPrice - 0.05;
      
      const liqResult = liquidatePosition(account.id, currentYesPrice);
      
      expect(marginAccounts.get(account.id)!.status).toBe('LIQUIDATED');
      
      // User total received = partial equity + liquidation return
      const totalReceived = closeResult.userEquity + liqResult.returnedToUser;
      const totalPaid = 50 + (7 * 0.06); // margin + fee
      const netPnL = totalReceived - totalPaid;
      
      // Should have lost money (price dropped)
      expect(netPnL).toBeLessThan(0);
      
      // But lending pool should be whole
      expect(lendingPool.totalLoaned).toBe(0);
    });
  });
});

describe('Edge Cases', () => {
  beforeEach(() => {
    resetState();
  });
  
  it('prevents opening position with insufficient balance', () => {
    userBalance = 10; // Only $10
    
    expect(() => openLeveragedPosition({
      userId: 'user-1',
      side: 'YES',
      totalPosition: 250, // Would need $50 margin
      leverage: 5,
      entryPrice: 0.50,
      fills: 5,
    })).toThrow('Insufficient balance');
  });
  
  it('prevents loan when pool has insufficient liquidity', () => {
    lendingPool.availableLiquidity = 100; // Only $100 available
    
    expect(() => openLeveragedPosition({
      userId: 'user-1',
      side: 'YES',
      totalPosition: 250, // Would need $200 loan
      leverage: 5,
      entryPrice: 0.50,
      fills: 5,
    })).toThrow('Insufficient lending pool liquidity');
  });
  
  it('prevents liquidation of healthy position', () => {
    const account = openLeveragedPosition({
      userId: 'user-1',
      side: 'YES',
      totalPosition: 250,
      leverage: 5,
      entryPrice: 0.50,
      fills: 5,
    });
    
    // Price is above liquidation
    const currentYesPrice = account.liquidationPrice + 0.10;
    
    expect(() => liquidatePosition(account.id, currentYesPrice))
      .toThrow('Not eligible for liquidation');
  });
  
  it('prevents double close', () => {
    const account = openLeveragedPosition({
      userId: 'user-1',
      side: 'YES',
      totalPosition: 250,
      leverage: 5,
      entryPrice: 0.50,
      fills: 5,
    });
    
    // Close once
    closeLeveragedPosition(account.id, 0.55);
    
    // Try to close again
    expect(() => closeLeveragedPosition(account.id, 0.55))
      .toThrow('Account not open');
  });
});

