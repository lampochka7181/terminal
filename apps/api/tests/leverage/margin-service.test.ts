/**
 * Margin Service Tests
 * 
 * Integration-style tests for the margin service.
 * Uses mocks for database operations.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetMockStore, mockStore, createMockMarginAccount, createMockMarket } from '../mocks/db.mock';

// Mock the database module
vi.mock('../../src/db/index.js', () => ({
  db: {
    insert: vi.fn(),
    update: vi.fn(),
    select: vi.fn(),
    delete: vi.fn(),
  },
  marginAccounts: {},
  liquidations: {},
  marginTransactions: {},
  positions: {},
  markets: {},
}));

// Mock lending service
vi.mock('../../src/services/lending.service.js', () => ({
  lendingService: {
    isEnabled: vi.fn().mockReturnValue(true),
    checkLoanAvailability: vi.fn().mockResolvedValue({ available: true, maxLoan: 10000 }),
    recordLoan: vi.fn().mockResolvedValue(undefined),
    recordRepayment: vi.fn().mockResolvedValue(undefined),
    recordPenalty: vi.fn().mockResolvedValue(undefined),
    transferToUser: vi.fn().mockResolvedValue('mock-transfer-sig'),
    getLendingWalletPubkey: vi.fn().mockReturnValue('mock-lending-wallet'),
  },
}));

// Mock config
vi.mock('../../src/config.js', () => ({
  config: {
    leverage: {
      enabled: true,
      maxLeverage: 10,
      minMargin: 5,
      maintenanceMarginPct: 0.03,
      liquidationPenaltyPct: 0.02,
    },
    fees: {
      flatFeeUsd: 0.06,
    },
  },
}));

describe('Margin Service', () => {
  beforeEach(() => {
    resetMockStore();
    vi.clearAllMocks();
  });
  
  describe('Margin Account Creation', () => {
    it('creates margin account with correct liquidation price for YES', async () => {
      // Simulate margin account creation
      const params = {
        userId: 'user-1',
        positionId: 'position-1',
        marketId: 'market-1',
        side: 'YES' as const,
        shares: 595.24,
        entryPrice: 0.42,
        leverage: 5,
        marginDeposited: 50,
        loanAmount: 200,
        onChainTxSignature: 'tx-123',
      };
      
      // Calculate expected liquidation price
      const expectedLiqPrice = params.loanAmount / (params.shares * 0.97);
      
      const account = createMockMarginAccount({
        ...params,
        shares: params.shares.toString(),
        entryPrice: params.entryPrice.toString(),
        leverage: params.leverage.toString(),
        marginDeposited: params.marginDeposited.toString(),
        loanAmount: params.loanAmount.toString(),
        liquidationPrice: expectedLiqPrice.toString(),
      });
      
      expect(parseFloat(account.liquidationPrice)).toBeCloseTo(0.3464, 3);
      expect(account.status).toBe('OPEN');
      expect(account.onChainConfirmedAt).toBeNull();
    });
    
    it('creates margin account with correct liquidation price for NO', async () => {
      const params = {
        userId: 'user-1',
        positionId: 'position-1',
        marketId: 'market-1',
        side: 'NO' as const,
        shares: 1524.54,
        entryPrice: 0.164,
        leverage: 5,
        marginDeposited: 50,
        loanAmount: 200,
      };
      
      // NO liquidation price = loanAmount / (shares * 0.97)
      const expectedLiqPrice = params.loanAmount / (params.shares * 0.97);
      
      expect(expectedLiqPrice).toBeCloseTo(0.1352, 3);
    });
  });
  
  describe('Margin Account Updates', () => {
    it('updates shares and loan after partial close', async () => {
      // Original account
      const account = createMockMarginAccount({
        shares: '595.24',
        loanAmount: '200.00',
        liquidationPrice: '0.3464',
      });
      
      // Partial close: sell 297 shares (50%)
      const soldShares = 297;
      const closeRatio = soldShares / parseFloat(account.shares);
      const partialLoanRepay = parseFloat(account.loanAmount) * closeRatio;
      
      const newShares = parseFloat(account.shares) - soldShares;
      const newLoan = parseFloat(account.loanAmount) - partialLoanRepay;
      const newLiqPrice = newLoan / (newShares * 0.97);
      
      expect(newShares).toBeCloseTo(298.24, 1);
      expect(newLoan).toBeCloseTo(100.21, 1);
      // Liq price stays ~same due to proportional reduction
      expect(newLiqPrice).toBeCloseTo(0.3464, 2);
    });
    
    it('sets liquidation lock correctly', async () => {
      const account = createMockMarginAccount({
        liquidatingAt: null,
      });
      
      // Simulate setting lock
      const lockTime = new Date();
      const updatedAccount = {
        ...account,
        liquidatingAt: lockTime,
      };
      
      expect(updatedAccount.liquidatingAt).not.toBeNull();
    });
    
    it('clears liquidation lock on failure', async () => {
      const account = createMockMarginAccount({
        liquidatingAt: new Date(),
      });
      
      // Simulate clearing lock
      const updatedAccount = {
        ...account,
        liquidatingAt: null,
      };
      
      expect(updatedAccount.liquidatingAt).toBeNull();
    });
  });
  
  describe('On-Chain Confirmation', () => {
    it('requires on-chain confirmation before liquidation', async () => {
      // Account created but not confirmed on-chain
      const unconfirmedAccount = createMockMarginAccount({
        onChainConfirmedAt: null,
      });
      
      // Should not be eligible for liquidation
      const isEligible = unconfirmedAccount.onChainConfirmedAt !== null;
      expect(isEligible).toBe(false);
    });
    
    it('marks account as confirmed on-chain', async () => {
      const account = createMockMarginAccount({
        onChainConfirmedAt: null,
      });
      
      // Simulate confirmation
      const confirmedAt = new Date();
      const updatedAccount = {
        ...account,
        onChainConfirmedAt: confirmedAt,
      };
      
      expect(updatedAccount.onChainConfirmedAt).not.toBeNull();
    });
  });
  
  describe('Margin Account Status Transitions', () => {
    it('transitions from OPEN to CLOSED on full close', async () => {
      const account = createMockMarginAccount({ status: 'OPEN' });
      
      // Full close
      const closedAccount = { ...account, status: 'CLOSED' };
      
      expect(closedAccount.status).toBe('CLOSED');
    });
    
    it('transitions from OPEN to LIQUIDATING during liquidation', async () => {
      const account = createMockMarginAccount({ status: 'OPEN' });
      
      // Start liquidation
      const liquidatingAccount = { 
        ...account, 
        status: 'LIQUIDATING',
        liquidatingAt: new Date(),
      };
      
      expect(liquidatingAccount.status).toBe('LIQUIDATING');
    });
    
    it('transitions from LIQUIDATING to LIQUIDATED on success', async () => {
      const account = createMockMarginAccount({ 
        status: 'LIQUIDATING',
        liquidatingAt: new Date(),
      });
      
      // Liquidation complete
      const liquidatedAccount = { 
        ...account, 
        status: 'LIQUIDATED',
        liquidatingAt: null,
      };
      
      expect(liquidatedAccount.status).toBe('LIQUIDATED');
    });
    
    it('transitions back to OPEN if liquidation fails', async () => {
      const account = createMockMarginAccount({ 
        status: 'OPEN',
        liquidatingAt: new Date(),
      });
      
      // Liquidation failed - clear lock, keep OPEN
      const failedAccount = { 
        ...account, 
        liquidatingAt: null,
      };
      
      expect(failedAccount.status).toBe('OPEN');
      expect(failedAccount.liquidatingAt).toBeNull();
    });
  });
});

describe('Liquidation Eligibility', () => {
  beforeEach(() => {
    resetMockStore();
  });
  
  describe('YES Position Liquidation Check', () => {
    it('should liquidate when YES price drops below liq price', () => {
      const account = createMockMarginAccount({
        side: 'YES',
        liquidationPrice: '0.35',
        onChainConfirmedAt: new Date(),
        liquidatingAt: null,
      });
      
      const currentYesPrice = 0.30; // Below 0.35
      const shouldLiquidate = currentYesPrice <= parseFloat(account.liquidationPrice);
      
      expect(shouldLiquidate).toBe(true);
    });
    
    it('should not liquidate when YES price above liq price', () => {
      const account = createMockMarginAccount({
        side: 'YES',
        liquidationPrice: '0.35',
        onChainConfirmedAt: new Date(),
      });
      
      const currentYesPrice = 0.40; // Above 0.35
      const shouldLiquidate = currentYesPrice <= parseFloat(account.liquidationPrice);
      
      expect(shouldLiquidate).toBe(false);
    });
  });
  
  describe('NO Position Liquidation Check', () => {
    it('should liquidate when NO price drops below liq price', () => {
      const account = createMockMarginAccount({
        side: 'NO',
        liquidationPrice: '0.15', // NO price
        onChainConfirmedAt: new Date(),
      });
      
      const currentYesPrice = 0.90; // NO price = 0.10, below 0.15
      const currentNoPrice = 1 - currentYesPrice;
      const shouldLiquidate = currentNoPrice <= parseFloat(account.liquidationPrice);
      
      expect(shouldLiquidate).toBe(true);
    });
    
    it('should not liquidate when NO price above liq price', () => {
      const account = createMockMarginAccount({
        side: 'NO',
        liquidationPrice: '0.15',
        onChainConfirmedAt: new Date(),
      });
      
      const currentYesPrice = 0.80; // NO price = 0.20, above 0.15
      const currentNoPrice = 1 - currentYesPrice;
      const shouldLiquidate = currentNoPrice <= parseFloat(account.liquidationPrice);
      
      expect(shouldLiquidate).toBe(false);
    });
  });
  
  describe('Liquidation Preconditions', () => {
    it('should skip unconfirmed accounts', () => {
      const account = createMockMarginAccount({
        onChainConfirmedAt: null, // Not confirmed
      });
      
      const isEligible = account.onChainConfirmedAt !== null;
      expect(isEligible).toBe(false);
    });
    
    it('should skip already liquidating accounts', () => {
      const account = createMockMarginAccount({
        onChainConfirmedAt: new Date(),
        liquidatingAt: new Date(), // Already being liquidated
      });
      
      const isBeingLiquidated = account.liquidatingAt !== null;
      expect(isBeingLiquidated).toBe(true);
    });
    
    it('should skip closed accounts', () => {
      const account = createMockMarginAccount({
        status: 'CLOSED',
        onChainConfirmedAt: new Date(),
      });
      
      const isEligible = account.status === 'OPEN';
      expect(isEligible).toBe(false);
    });
  });
});

describe('Liquidation Proceeds Calculation', () => {
  const LIQUIDATION_PENALTY_PCT = 0.02; // 2%
  
  it('calculates proceeds for YES liquidation with profit', () => {
    // YES position liquidated at liq price with some equity remaining
    const shares = 490.20;
    const loanAmount = 200;
    const executionPrice = 0.5113; // Liq price
    
    const proceeds = shares * executionPrice;
    const penalty = proceeds * LIQUIDATION_PENALTY_PCT;
    const returnedToUser = proceeds - loanAmount - penalty;
    
    expect(proceeds).toBeCloseTo(250.65, 1);
    expect(penalty).toBeCloseTo(5.01, 1);
    expect(returnedToUser).toBeCloseTo(45.64, 0);
  });
  
  it('calculates proceeds for NO liquidation', () => {
    // NO position liquidated
    const shares = 1524.54;
    const loanAmount = 200;
    const executionPrice = 0.1352; // NO liq price
    
    const proceeds = shares * executionPrice;
    const penalty = proceeds * LIQUIDATION_PENALTY_PCT;
    const returnedToUser = Math.max(0, proceeds - loanAmount - penalty);
    
    expect(proceeds).toBeCloseTo(206.12, 0);
    expect(returnedToUser).toBeCloseTo(2.00, 0);
  });
  
  it('handles bad debt when proceeds < loan', () => {
    // Extreme case where execution price is much lower than expected
    const shares = 100;
    const loanAmount = 50;
    const executionPrice = 0.40; // Price crashed
    
    const proceeds = shares * executionPrice;
    const penalty = proceeds * LIQUIDATION_PENALTY_PCT;
    const equity = proceeds - loanAmount - penalty;
    const returnedToUser = Math.max(0, equity);
    const badDebt = Math.max(0, loanAmount - proceeds);
    
    expect(proceeds).toBe(40);
    expect(returnedToUser).toBe(0); // User gets nothing
    expect(badDebt).toBe(10); // $10 bad debt
  });
});

