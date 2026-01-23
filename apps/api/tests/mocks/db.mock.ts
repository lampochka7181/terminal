/**
 * Database Mocks
 * 
 * Mock implementations for database operations in tests.
 */

import { vi } from 'vitest';

// In-memory stores for mock data
export const mockStore = {
  marginAccounts: new Map<string, any>(),
  positions: new Map<string, any>(),
  markets: new Map<string, any>(),
  liquidations: new Map<string, any>(),
  lendingPool: {
    totalDeposits: 1000000,
    availableLiquidity: 1000000,
    totalLoaned: 0,
  },
  insuranceFund: {
    balance: 10000,
  },
};

// Reset all stores
export function resetMockStore() {
  mockStore.marginAccounts.clear();
  mockStore.positions.clear();
  mockStore.markets.clear();
  mockStore.liquidations.clear();
  mockStore.lendingPool = {
    totalDeposits: 1000000,
    availableLiquidity: 1000000,
    totalLoaned: 0,
  };
  mockStore.insuranceFund = {
    balance: 10000,
  };
}

// Mock database functions
export const mockDb = {
  insert: vi.fn().mockImplementation((table) => ({
    values: vi.fn().mockImplementation((data) => ({
      returning: vi.fn().mockImplementation(() => {
        const id = `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        // Store in appropriate mock store based on table
        return Promise.resolve([record]);
      }),
    })),
  })),
  
  update: vi.fn().mockImplementation((table) => ({
    set: vi.fn().mockImplementation((data) => ({
      where: vi.fn().mockImplementation(() => ({
        returning: vi.fn().mockResolvedValue([data]),
      })),
    })),
  })),
  
  select: vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => ({
        limit: vi.fn().mockResolvedValue([]),
      })),
    })),
  })),
  
  delete: vi.fn().mockImplementation((table) => ({
    where: vi.fn().mockResolvedValue([]),
  })),
};

// Helper to create test fixtures
export function createMockMarginAccount(overrides: Partial<any> = {}) {
  const defaults = {
    id: `margin-${Date.now()}`,
    userId: 'test-user-id',
    positionId: 'test-position-id',
    marketId: 'test-market-id',
    side: 'YES',
    shares: '100',
    entryPrice: '0.50',
    leverage: '5.00',
    marginDeposited: '10.00',
    loanAmount: '40.00',
    liquidationPrice: '0.4123',
    status: 'OPEN',
    onChainTxSignature: 'mock-tx-sig',
    onChainConfirmedAt: null, // Not confirmed by default
    liquidatingAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  return { ...defaults, ...overrides };
}

export function createMockPosition(overrides: Partial<any> = {}) {
  const defaults = {
    id: `position-${Date.now()}`,
    userId: 'test-user-id',
    marketId: 'test-market-id',
    yesShares: '0',
    noShares: '0',
    avgEntryYes: '0',
    avgEntryNo: '0',
    totalCostYes: '0',
    totalCostNo: '0',
    status: 'OPEN',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  return { ...defaults, ...overrides };
}

export function createMockMarket(overrides: Partial<any> = {}) {
  const defaults = {
    id: `market-${Date.now()}`,
    pubkey: 'mock-market-pubkey',
    asset: 'BTC',
    timeframe: '5m',
    strikePrice: '90000',
    status: 'TRADING',
    expiryAt: new Date(Date.now() + 300000), // 5 min from now
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  return { ...defaults, ...overrides };
}

