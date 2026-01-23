/**
 * Market Order Tests
 * 
 * Tests for regular (non-leveraged) market orders.
 * Covers buying YES/NO, selling positions, and fee calculations.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ============================================================
// SIMULATION HELPERS
// ============================================================

interface OrderbookLevel {
  price: number;
  size: number;
}

interface Orderbook {
  bids: OrderbookLevel[]; // Buy orders (sorted high to low)
  asks: OrderbookLevel[]; // Sell orders (sorted low to high)
}

interface Position {
  id: string;
  userId: string;
  marketId: string;
  yesShares: number;
  noShares: number;
  avgEntryYes: number;
  avgEntryNo: number;
  totalCostYes: number;
  totalCostNo: number;
}

interface Fill {
  price: number;
  size: number;
  cost: number;
  fee: number;
}

interface OrderResult {
  fills: Fill[];
  totalSize: number;
  totalCost: number;
  totalFees: number;
  avgPrice: number;
  unfilledAmount: number;
}

// Constants
const FEE_PER_FILL = 0.06; // $0.06 flat fee per fill
const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;

// State
let orderbook: Orderbook;
let positions: Map<string, Position>;
let userBalance: number;

function resetState() {
  orderbook = {
    bids: [],
    asks: [],
  };
  positions = new Map();
  userBalance = 1000;
}

// Create a simple orderbook with MM-style levels
function createMMOrderbook(midPrice: number, spread: number = 0.02, depth: number = 5, sizePerLevel: number = 100) {
  const asks: OrderbookLevel[] = [];
  const bids: OrderbookLevel[] = [];
  
  const halfSpread = spread / 2;
  
  // Create ask levels (above mid)
  for (let i = 0; i < depth; i++) {
    const price = Math.min(MAX_PRICE, midPrice + halfSpread + (i * 0.01));
    asks.push({ price, size: sizePerLevel });
  }
  
  // Create bid levels (below mid)
  for (let i = 0; i < depth; i++) {
    const price = Math.max(MIN_PRICE, midPrice - halfSpread - (i * 0.01));
    bids.push({ price, size: sizePerLevel });
  }
  
  // Sort: asks low to high, bids high to low
  asks.sort((a, b) => a.price - b.price);
  bids.sort((a, b) => b.price - a.price);
  
  orderbook = { bids, asks };
}

// ============================================================
// SIMULATED ORDER EXECUTION
// ============================================================

/**
 * Execute a market buy order
 * Walks the ask side of the orderbook
 */
function executeMarketBuy(
  dollarAmount: number,
  outcome: 'YES' | 'NO',
  maxPrice: number = MAX_PRICE
): OrderResult {
  const fills: Fill[] = [];
  let remainingDollars = dollarAmount;
  let totalSize = 0;
  let totalCost = 0;
  let totalFees = 0;
  
  // For YES: use asks directly
  // For NO: convert YES bids to NO asks (price = 1 - bid price)
  const levels = outcome === 'YES' 
    ? [...orderbook.asks]
    : orderbook.bids.map(b => ({ price: 1 - b.price, size: b.size })).sort((a, b) => a.price - b.price);
  
  for (const level of levels) {
    if (remainingDollars <= 0) break;
    if (level.price > maxPrice) break;
    
    // How many shares can we buy at this level?
    const maxSharesAtPrice = remainingDollars / level.price;
    const sharesToBuy = Math.min(maxSharesAtPrice, level.size);
    const cost = sharesToBuy * level.price;
    const fee = FEE_PER_FILL;
    
    if (cost + fee > remainingDollars) {
      // Adjust for fee
      const adjustedShares = (remainingDollars - fee) / level.price;
      if (adjustedShares > 0) {
        const adjustedCost = adjustedShares * level.price;
        fills.push({ price: level.price, size: adjustedShares, cost: adjustedCost, fee });
        totalSize += adjustedShares;
        totalCost += adjustedCost;
        totalFees += fee;
        remainingDollars = 0;
      }
      break;
    }
    
    fills.push({ price: level.price, size: sharesToBuy, cost, fee });
    totalSize += sharesToBuy;
    totalCost += cost;
    totalFees += fee;
    remainingDollars -= (cost + fee);
    level.size -= sharesToBuy;
  }
  
  const avgPrice = totalSize > 0 ? totalCost / totalSize : 0;
  
  return {
    fills,
    totalSize,
    totalCost,
    totalFees,
    avgPrice,
    unfilledAmount: remainingDollars,
  };
}

/**
 * Execute a market sell order
 * Walks the bid side of the orderbook
 */
function executeMarketSell(
  shares: number,
  outcome: 'YES' | 'NO',
  minPrice: number = MIN_PRICE
): OrderResult {
  const fills: Fill[] = [];
  let remainingShares = shares;
  let totalSize = 0;
  let totalProceeds = 0;
  let totalFees = 0;
  
  // For YES: use bids directly
  // For NO: convert YES asks to NO bids (price = 1 - ask price)
  const levels = outcome === 'YES'
    ? [...orderbook.bids]
    : orderbook.asks.map(a => ({ price: 1 - a.price, size: a.size })).sort((a, b) => b.price - a.price);
  
  for (const level of levels) {
    if (remainingShares <= 0) break;
    if (level.price < minPrice) break;
    
    const sharesToSell = Math.min(remainingShares, level.size);
    const proceeds = sharesToSell * level.price;
    const fee = FEE_PER_FILL;
    
    fills.push({ price: level.price, size: sharesToSell, cost: proceeds, fee });
    totalSize += sharesToSell;
    totalProceeds += proceeds;
    totalFees += fee;
    remainingShares -= sharesToSell;
    level.size -= sharesToSell;
  }
  
  const avgPrice = totalSize > 0 ? totalProceeds / totalSize : 0;
  
  return {
    fills,
    totalSize,
    totalCost: totalProceeds, // For sells, this is proceeds
    totalFees,
    avgPrice,
    unfilledAmount: remainingShares,
  };
}

/**
 * Update position after a buy
 */
function updatePositionAfterBuy(
  userId: string,
  marketId: string,
  outcome: 'YES' | 'NO',
  shares: number,
  avgPrice: number,
  cost: number
): Position {
  const key = `${userId}-${marketId}`;
  let position = positions.get(key);
  
  if (!position) {
    position = {
      id: `pos-${Date.now()}`,
      userId,
      marketId,
      yesShares: 0,
      noShares: 0,
      avgEntryYes: 0,
      avgEntryNo: 0,
      totalCostYes: 0,
      totalCostNo: 0,
    };
  }
  
  if (outcome === 'YES') {
    const newTotalCost = position.totalCostYes + cost;
    const newShares = position.yesShares + shares;
    position.avgEntryYes = newShares > 0 ? newTotalCost / newShares : 0;
    position.yesShares = newShares;
    position.totalCostYes = newTotalCost;
  } else {
    const newTotalCost = position.totalCostNo + cost;
    const newShares = position.noShares + shares;
    position.avgEntryNo = newShares > 0 ? newTotalCost / newShares : 0;
    position.noShares = newShares;
    position.totalCostNo = newTotalCost;
  }
  
  positions.set(key, position);
  return position;
}

/**
 * Update position after a sell
 */
function updatePositionAfterSell(
  userId: string,
  marketId: string,
  outcome: 'YES' | 'NO',
  shares: number
): Position {
  const key = `${userId}-${marketId}`;
  const position = positions.get(key);
  
  if (!position) {
    throw new Error('No position to sell');
  }
  
  if (outcome === 'YES') {
    if (shares > position.yesShares) {
      throw new Error('Insufficient YES shares');
    }
    // Proportionally reduce cost
    const costReduction = (shares / position.yesShares) * position.totalCostYes;
    position.yesShares -= shares;
    position.totalCostYes -= costReduction;
    if (position.yesShares === 0) {
      position.avgEntryYes = 0;
    }
  } else {
    if (shares > position.noShares) {
      throw new Error('Insufficient NO shares');
    }
    const costReduction = (shares / position.noShares) * position.totalCostNo;
    position.noShares -= shares;
    position.totalCostNo -= costReduction;
    if (position.noShares === 0) {
      position.avgEntryNo = 0;
    }
  }
  
  positions.set(key, position);
  return position;
}

/**
 * Calculate P&L for a position
 */
function calculatePnL(position: Position, currentYesPrice: number): { yesPnL: number; noPnL: number; totalPnL: number } {
  const currentNoPrice = 1 - currentYesPrice;
  
  const yesValue = position.yesShares * currentYesPrice;
  const noValue = position.noShares * currentNoPrice;
  
  const yesPnL = yesValue - position.totalCostYes;
  const noPnL = noValue - position.totalCostNo;
  
  return {
    yesPnL,
    noPnL,
    totalPnL: yesPnL + noPnL,
  };
}

// ============================================================
// TEST SUITES
// ============================================================

describe('Market Orders', () => {
  beforeEach(() => {
    resetState();
  });
  
  describe('Market Buy YES', () => {
    it('executes simple market buy YES', () => {
      createMMOrderbook(0.50, 0.02, 5, 100);
      
      const result = executeMarketBuy(50, 'YES');
      
      expect(result.totalSize).toBeGreaterThan(0);
      expect(result.totalCost).toBeLessThanOrEqual(50);
      expect(result.fills.length).toBeGreaterThan(0);
      expect(result.avgPrice).toBeGreaterThan(0.50); // Should be above mid due to spread
    });
    
    it('calculates correct average price across multiple fills', () => {
      // Create orderbook with varying prices
      orderbook = {
        asks: [
          { price: 0.51, size: 50 },
          { price: 0.52, size: 50 },
          { price: 0.53, size: 50 },
        ],
        bids: [],
      };
      
      const result = executeMarketBuy(100, 'YES');
      
      // Should fill across multiple levels
      expect(result.fills.length).toBeGreaterThan(1);
      
      // Average price should be weighted
      const manualAvg = result.fills.reduce((sum, f) => sum + f.price * f.size, 0) / result.totalSize;
      expect(result.avgPrice).toBeCloseTo(manualAvg, 6);
    });
    
    it('respects max price limit', () => {
      createMMOrderbook(0.50, 0.02, 5, 100);
      
      const result = executeMarketBuy(1000, 'YES', 0.52);
      
      // All fills should be at or below max price
      for (const fill of result.fills) {
        expect(fill.price).toBeLessThanOrEqual(0.52);
      }
    });
    
    it('handles insufficient liquidity', () => {
      orderbook = {
        asks: [{ price: 0.50, size: 10 }], // Only 10 shares available
        bids: [],
      };
      
      const result = executeMarketBuy(100, 'YES');
      
      // Should only fill what's available
      expect(result.totalSize).toBeLessThanOrEqual(10);
      expect(result.unfilledAmount).toBeGreaterThan(0);
    });
    
    it('deducts fees per fill', () => {
      orderbook = {
        asks: [
          { price: 0.50, size: 100 },
          { price: 0.51, size: 100 },
        ],
        bids: [],
      };
      
      const result = executeMarketBuy(100, 'YES');
      
      // Each fill should have a fee
      expect(result.totalFees).toBe(result.fills.length * FEE_PER_FILL);
    });
  });
  
  describe('Market Buy NO', () => {
    it('executes market buy NO (matches against YES bids)', () => {
      createMMOrderbook(0.50, 0.02, 5, 100);
      
      const result = executeMarketBuy(50, 'NO');
      
      expect(result.totalSize).toBeGreaterThan(0);
      // NO price = 1 - YES bid price. With mid=0.50 and spread=0.02, YES bid = 0.49, so NO = 0.51
      expect(result.avgPrice).toBeGreaterThan(0.50); // NO price is complement of YES bid
    });
    
    it('converts YES bid prices to NO ask prices correctly', () => {
      // YES bid at 0.48 = NO ask at 0.52
      orderbook = {
        asks: [],
        bids: [{ price: 0.48, size: 100 }],
      };
      
      const result = executeMarketBuy(50, 'NO');
      
      // NO price = 1 - 0.48 = 0.52
      expect(result.avgPrice).toBeCloseTo(0.52, 2);
    });
    
    it('calculates NO shares correctly', () => {
      orderbook = {
        asks: [],
        bids: [{ price: 0.40, size: 100 }], // NO price = 0.60
      };
      
      const result = executeMarketBuy(60, 'NO');
      
      // $60 at NO price $0.60 = 100 shares (minus fees)
      expect(result.totalSize).toBeCloseTo(100 - (result.fills.length * FEE_PER_FILL / 0.60), 0);
    });
  });
  
  describe('Market Sell', () => {
    it('executes market sell YES', () => {
      createMMOrderbook(0.50, 0.02, 5, 100);
      
      // First buy some shares
      const buyResult = executeMarketBuy(50, 'YES');
      const position = updatePositionAfterBuy('user1', 'market1', 'YES', buyResult.totalSize, buyResult.avgPrice, buyResult.totalCost);
      
      // Then sell half
      const sharesToSell = Math.floor(position.yesShares / 2);
      const sellResult = executeMarketSell(sharesToSell, 'YES');
      
      expect(sellResult.totalSize).toBe(sharesToSell);
      expect(sellResult.avgPrice).toBeLessThan(buyResult.avgPrice); // Sell at bid, lower than ask
    });
    
    it('executes market sell NO', () => {
      createMMOrderbook(0.50, 0.02, 5, 100);
      
      // Buy NO shares
      const buyResult = executeMarketBuy(50, 'NO');
      const position = updatePositionAfterBuy('user1', 'market1', 'NO', buyResult.totalSize, buyResult.avgPrice, buyResult.totalCost);
      
      // Sell NO
      const sharesToSell = Math.floor(position.noShares / 2);
      const sellResult = executeMarketSell(sharesToSell, 'NO');
      
      expect(sellResult.totalSize).toBe(sharesToSell);
    });
    
    it('respects min price limit', () => {
      createMMOrderbook(0.50, 0.02, 5, 100);
      
      const sellResult = executeMarketSell(1000, 'YES', 0.48);
      
      // All fills should be at or above min price
      for (const fill of sellResult.fills) {
        expect(fill.price).toBeGreaterThanOrEqual(0.48);
      }
    });
  });
  
  describe('Position Management', () => {
    it('creates new position on first buy', () => {
      createMMOrderbook(0.50);
      
      const result = executeMarketBuy(50, 'YES');
      const position = updatePositionAfterBuy('user1', 'market1', 'YES', result.totalSize, result.avgPrice, result.totalCost);
      
      expect(position.yesShares).toBeCloseTo(result.totalSize, 2);
      expect(position.avgEntryYes).toBeCloseTo(result.avgPrice, 4);
      expect(position.noShares).toBe(0);
    });
    
    it('adds to existing position', () => {
      createMMOrderbook(0.50);
      
      // First buy
      const result1 = executeMarketBuy(50, 'YES');
      updatePositionAfterBuy('user1', 'market1', 'YES', result1.totalSize, result1.avgPrice, result1.totalCost);
      
      // Second buy
      const result2 = executeMarketBuy(50, 'YES');
      const position = updatePositionAfterBuy('user1', 'market1', 'YES', result2.totalSize, result2.avgPrice, result2.totalCost);
      
      expect(position.yesShares).toBeCloseTo(result1.totalSize + result2.totalSize, 2);
      // Average entry should be weighted average
      const expectedAvg = (result1.totalCost + result2.totalCost) / (result1.totalSize + result2.totalSize);
      expect(position.avgEntryYes).toBeCloseTo(expectedAvg, 4);
    });
    
    it('can hold both YES and NO positions', () => {
      createMMOrderbook(0.50);
      
      const yesResult = executeMarketBuy(50, 'YES');
      updatePositionAfterBuy('user1', 'market1', 'YES', yesResult.totalSize, yesResult.avgPrice, yesResult.totalCost);
      
      const noResult = executeMarketBuy(50, 'NO');
      const position = updatePositionAfterBuy('user1', 'market1', 'NO', noResult.totalSize, noResult.avgPrice, noResult.totalCost);
      
      expect(position.yesShares).toBeGreaterThan(0);
      expect(position.noShares).toBeGreaterThan(0);
    });
    
    it('reduces position on sell', () => {
      createMMOrderbook(0.50);
      
      const buyResult = executeMarketBuy(100, 'YES');
      updatePositionAfterBuy('user1', 'market1', 'YES', buyResult.totalSize, buyResult.avgPrice, buyResult.totalCost);
      
      const sharesToSell = 20;
      const position = updatePositionAfterSell('user1', 'market1', 'YES', sharesToSell);
      
      expect(position.yesShares).toBeCloseTo(buyResult.totalSize - sharesToSell, 2);
    });
    
    it('prevents selling more than owned', () => {
      createMMOrderbook(0.50);
      
      const buyResult = executeMarketBuy(50, 'YES');
      updatePositionAfterBuy('user1', 'market1', 'YES', buyResult.totalSize, buyResult.avgPrice, buyResult.totalCost);
      
      expect(() => updatePositionAfterSell('user1', 'market1', 'YES', 10000))
        .toThrow('Insufficient YES shares');
    });
  });
  
  describe('P&L Calculations', () => {
    it('calculates profit when price goes up', () => {
      createMMOrderbook(0.50);
      
      const buyResult = executeMarketBuy(100, 'YES');
      const position = updatePositionAfterBuy('user1', 'market1', 'YES', buyResult.totalSize, buyResult.avgPrice, buyResult.totalCost);
      
      // Price goes up to 0.60
      const pnl = calculatePnL(position, 0.60);
      
      expect(pnl.yesPnL).toBeGreaterThan(0);
    });
    
    it('calculates loss when price goes down', () => {
      createMMOrderbook(0.50);
      
      const buyResult = executeMarketBuy(100, 'YES');
      const position = updatePositionAfterBuy('user1', 'market1', 'YES', buyResult.totalSize, buyResult.avgPrice, buyResult.totalCost);
      
      // Price goes down to 0.40
      const pnl = calculatePnL(position, 0.40);
      
      expect(pnl.yesPnL).toBeLessThan(0);
    });
    
    it('calculates NO position P&L correctly', () => {
      createMMOrderbook(0.50);
      
      const buyResult = executeMarketBuy(100, 'NO');
      const position = updatePositionAfterBuy('user1', 'market1', 'NO', buyResult.totalSize, buyResult.avgPrice, buyResult.totalCost);
      
      // YES price goes up (NO goes down) - loss for NO holder
      const pnl = calculatePnL(position, 0.60);
      
      expect(pnl.noPnL).toBeLessThan(0);
    });
    
    it('calculates hedged position P&L', () => {
      createMMOrderbook(0.50);
      
      // Buy equal amounts of YES and NO
      const yesResult = executeMarketBuy(50, 'YES');
      updatePositionAfterBuy('user1', 'market1', 'YES', yesResult.totalSize, yesResult.avgPrice, yesResult.totalCost);
      
      const noResult = executeMarketBuy(50, 'NO');
      const position = updatePositionAfterBuy('user1', 'market1', 'NO', noResult.totalSize, noResult.avgPrice, noResult.totalCost);
      
      // Price moves - P&L should offset
      const pnl = calculatePnL(position, 0.60);
      
      // Total P&L should be close to the spread cost (negative)
      expect(Math.abs(pnl.totalPnL)).toBeLessThan(yesResult.totalCost + noResult.totalCost);
    });
  });
  
  describe('Fee Calculations', () => {
    it('calculates flat fee per fill', () => {
      orderbook = {
        asks: [
          { price: 0.50, size: 50 },
          { price: 0.51, size: 50 },
          { price: 0.52, size: 50 },
        ],
        bids: [],
      };
      
      const result = executeMarketBuy(100, 'YES');
      
      // Should have multiple fills
      expect(result.fills.length).toBeGreaterThan(1);
      
      // Total fees = fills × fee per fill
      expect(result.totalFees).toBe(result.fills.length * FEE_PER_FILL);
    });
    
    it('fee reduces effective buying power', () => {
      orderbook = {
        asks: [{ price: 0.50, size: 1000 }],
        bids: [],
      };
      
      const amount = 50;
      const result = executeMarketBuy(amount, 'YES');
      
      // Total cost + fees should equal original amount (or slightly less due to rounding)
      expect(result.totalCost + result.totalFees).toBeLessThanOrEqual(amount);
    });
    
    it('sell fees reduce proceeds', () => {
      orderbook = {
        asks: [],
        bids: [{ price: 0.50, size: 1000 }],
      };
      
      const result = executeMarketSell(100, 'YES');
      
      // Net proceeds = gross proceeds - fees
      const netProceeds = result.totalCost - result.totalFees;
      expect(netProceeds).toBeLessThan(result.totalCost);
    });
  });
  
  describe('Edge Cases', () => {
    it('handles empty orderbook', () => {
      orderbook = { asks: [], bids: [] };
      
      const result = executeMarketBuy(100, 'YES');
      
      expect(result.fills.length).toBe(0);
      expect(result.totalSize).toBe(0);
      expect(result.unfilledAmount).toBe(100);
    });
    
    it('handles very small orders', () => {
      createMMOrderbook(0.50);
      
      const result = executeMarketBuy(1, 'YES');
      
      // Should fill but with fee taking significant portion
      expect(result.totalSize).toBeGreaterThan(0);
    });
    
    it('handles price at boundaries (0.01, 0.99)', () => {
      orderbook = {
        asks: [{ price: 0.99, size: 100 }],
        bids: [{ price: 0.01, size: 100 }],
      };
      
      const buyResult = executeMarketBuy(100, 'YES');
      expect(buyResult.avgPrice).toBeCloseTo(0.99, 2);
      
      const sellResult = executeMarketSell(50, 'YES');
      expect(sellResult.avgPrice).toBeCloseTo(0.01, 2);
    });
    
    it('handles large orders that exhaust book', () => {
      orderbook = {
        asks: [
          { price: 0.50, size: 100 },
          { price: 0.51, size: 100 },
        ],
        bids: [],
      };
      
      const result = executeMarketBuy(10000, 'YES');
      
      // Should fill all available and have unfilled remainder
      expect(result.totalSize).toBeCloseTo(200, 0);
      expect(result.unfilledAmount).toBeGreaterThan(0);
    });
  });
});

describe('Order Matching Scenarios', () => {
  beforeEach(() => {
    resetState();
  });
  
  describe('Walk-the-Book Behavior', () => {
    it('fills at best price first', () => {
      // Asks need to be sorted low to high for the simulation
      orderbook = {
        asks: [
          { price: 0.51, size: 100 },
          { price: 0.52, size: 100 },
          { price: 0.53, size: 100 },
        ],
        bids: [],
      };
      
      const result = executeMarketBuy(50, 'YES');
      
      // Should fill at 0.51 (best ask)
      expect(result.fills[0].price).toBe(0.51);
    });
    
    it('fills across multiple levels when needed', () => {
      orderbook = {
        asks: [
          { price: 0.50, size: 30 },
          { price: 0.51, size: 30 },
          { price: 0.52, size: 30 },
        ],
        bids: [],
      };
      
      const result = executeMarketBuy(50, 'YES');
      
      // Should need multiple levels
      expect(result.fills.length).toBeGreaterThan(1);
      
      // Fills should be in price order
      for (let i = 1; i < result.fills.length; i++) {
        expect(result.fills[i].price).toBeGreaterThanOrEqual(result.fills[i-1].price);
      }
    });
  });
  
  describe('Single Orderbook Model', () => {
    it('YES buy matches YES asks', () => {
      orderbook = {
        asks: [{ price: 0.55, size: 100 }],
        bids: [{ price: 0.45, size: 100 }],
      };
      
      const result = executeMarketBuy(50, 'YES');
      
      expect(result.avgPrice).toBeCloseTo(0.55, 2);
    });
    
    it('NO buy matches YES bids (converted)', () => {
      orderbook = {
        asks: [{ price: 0.55, size: 100 }],
        bids: [{ price: 0.45, size: 100 }],
      };
      
      const result = executeMarketBuy(50, 'NO');
      
      // NO price = 1 - YES bid = 1 - 0.45 = 0.55
      expect(result.avgPrice).toBeCloseTo(0.55, 2);
    });
    
    it('YES sell matches YES bids', () => {
      orderbook = {
        asks: [{ price: 0.55, size: 100 }],
        bids: [{ price: 0.45, size: 100 }],
      };
      
      const result = executeMarketSell(50, 'YES');
      
      expect(result.avgPrice).toBeCloseTo(0.45, 2);
    });
    
    it('NO sell matches YES asks (converted)', () => {
      orderbook = {
        asks: [{ price: 0.55, size: 100 }],
        bids: [{ price: 0.45, size: 100 }],
      };
      
      const result = executeMarketSell(50, 'NO');
      
      // NO sell at YES ask = 1 - 0.55 = 0.45
      expect(result.avgPrice).toBeCloseTo(0.45, 2);
    });
  });
});

describe('Real-World Scenarios', () => {
  beforeEach(() => {
    resetState();
  });
  
  it('simulates typical trading session', () => {
    createMMOrderbook(0.50, 0.02, 10, 500);
    
    // User buys YES
    const buy1 = executeMarketBuy(100, 'YES');
    const pos1 = updatePositionAfterBuy('user1', 'market1', 'YES', buy1.totalSize, buy1.avgPrice, buy1.totalCost);
    
    expect(pos1.yesShares).toBeGreaterThan(0);
    const sharesBeforeSell = pos1.yesShares;
    
    // Price moves up, user takes profit (sell half, but at least 1)
    const sellShares = Math.max(1, Math.floor(pos1.yesShares / 2));
    const sell1 = executeMarketSell(sellShares, 'YES');
    
    // Only update position with actually sold shares
    const pos2 = updatePositionAfterSell('user1', 'market1', 'YES', sell1.totalSize);
    
    expect(sell1.totalSize).toBeGreaterThan(0);
    expect(pos2.yesShares).toBeLessThan(sharesBeforeSell);
  });
  
  it('simulates $250 market order at $0.42', () => {
    // Simulate the scenario from manual testing
    orderbook = {
      asks: [
        { price: 0.42, size: 1000 },
      ],
      bids: [],
    };
    
    const result = executeMarketBuy(250, 'YES');
    
    // $250 / $0.42 = ~595 shares (minus fees)
    const expectedShares = (250 - result.totalFees) / 0.42;
    expect(result.totalSize).toBeCloseTo(expectedShares, 0);
    expect(result.avgPrice).toBeCloseTo(0.42, 2);
  });
  
  it('simulates round-trip trade', () => {
    createMMOrderbook(0.50, 0.02, 10, 1000);
    
    const initialBalance = 1000;
    let balance = initialBalance;
    
    // Buy
    const buyResult = executeMarketBuy(100, 'YES');
    balance -= (buyResult.totalCost + buyResult.totalFees);
    const position = updatePositionAfterBuy('user1', 'market1', 'YES', buyResult.totalSize, buyResult.avgPrice, buyResult.totalCost);
    
    // Immediately sell all
    const sellResult = executeMarketSell(position.yesShares, 'YES');
    balance += (sellResult.totalCost - sellResult.totalFees);
    
    // Should have lost money due to spread + fees
    expect(balance).toBeLessThan(initialBalance);
    
    // Calculate loss
    const loss = initialBalance - balance;
    const expectedMinLoss = buyResult.totalFees + sellResult.totalFees; // At minimum, fees
    expect(loss).toBeGreaterThanOrEqual(expectedMinLoss - 1); // -1 for rounding
  });
});

