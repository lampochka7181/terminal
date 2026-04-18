/**
 * Database Mocks
 * 
 * Mock implementations for database operations in tests.
 */

import { vi } from 'vitest';

// In-memory stores for mock data
export const mockStore = {
  positions: new Map<string, any>(),
  markets: new Map<string, any>(),
};

// Reset all stores
export function resetMockStore() {
  mockStore.positions.clear();
  mockStore.markets.clear();
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

