/**
 * Test Setup
 * 
 * Runs before all tests to configure the test environment.
 */

import { vi } from 'vitest';

// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.JWT_SECRET = 'test-secret';

// Mock logger to suppress output during tests
vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  keeperLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  logEvents: {
    orders: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    markets: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    positions: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

// Global test timeout
vi.setConfig({ testTimeout: 10000 });

