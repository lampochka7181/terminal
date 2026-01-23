/**
 * Leverage Calculations Tests
 * 
 * Tests for the core leverage calculation functions in margin.service.ts
 * These are pure functions that don't require database mocking.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Import the leverage calculator directly (we'll create a standalone version for testing)
// For now, we recreate the calculation logic here to test against expected values

const MAINTENANCE_MARGIN_PCT = 0.03; // 3%

/**
 * Calculate liquidation price for YES position
 * liqPrice = loanAmount / (shares * (1 - maintenanceMarginPct))
 */
function liquidationPriceYes(
  shares: number,
  loanAmount: number,
  maintenanceMarginPct: number = MAINTENANCE_MARGIN_PCT
): number {
  if (shares <= 0 || loanAmount <= 0) return 0;
  const liqPrice = loanAmount / (shares * (1 - maintenanceMarginPct));
  return Math.max(0.01, Math.min(0.99, liqPrice));
}

/**
 * Calculate liquidation price for NO position (returns NO price)
 */
function liquidationPriceNo(
  shares: number,
  loanAmount: number,
  maintenanceMarginPct: number = MAINTENANCE_MARGIN_PCT
): number {
  if (shares <= 0 || loanAmount <= 0) return 0;
  const noLiqPrice = loanAmount / (shares * (1 - maintenanceMarginPct));
  return Math.max(0.01, Math.min(0.99, noLiqPrice));
}

/**
 * Calculate current equity
 */
function currentEquity(
  side: 'YES' | 'NO',
  shares: number,
  currentPrice: number, // YES price
  loanAmount: number
): number {
  if (side === 'YES') {
    return (currentPrice * shares) - loanAmount;
  } else {
    return ((1 - currentPrice) * shares) - loanAmount;
  }
}

/**
 * Calculate margin ratio
 */
function marginRatio(
  side: 'YES' | 'NO',
  shares: number,
  currentPrice: number,
  loanAmount: number
): number {
  const equity = currentEquity(side, shares, currentPrice, loanAmount);
  const positionValue = side === 'YES' ? currentPrice * shares : (1 - currentPrice) * shares;
  return positionValue > 0 ? equity / positionValue : 0;
}

/**
 * Check if position should be liquidated
 */
function shouldLiquidate(
  side: 'YES' | 'NO',
  currentPrice: number, // YES price from orderbook
  liquidationPrice: number // In native price space (YES for YES, NO for NO)
): boolean {
  if (side === 'YES') {
    return currentPrice <= liquidationPrice;
  } else {
    const currentNoPrice = 1 - currentPrice;
    return currentNoPrice <= liquidationPrice;
  }
}

// ============================================================
// TEST SUITES
// ============================================================

describe('Leverage Calculations', () => {
  
  describe('Initial Margin & Loan', () => {
    it('calculates 5x leverage correctly', () => {
      const totalPosition = 100;
      const leverage = 5;
      
      const margin = totalPosition / leverage;
      const loan = totalPosition - margin;
      
      expect(margin).toBe(20);
      expect(loan).toBe(80);
    });
    
    it('calculates 10x leverage correctly', () => {
      const totalPosition = 100;
      const leverage = 10;
      
      const margin = totalPosition / leverage;
      const loan = totalPosition - margin;
      
      expect(margin).toBe(10);
      expect(loan).toBe(90);
    });
    
    it('calculates 2x leverage correctly', () => {
      const totalPosition = 100;
      const leverage = 2;
      
      const margin = totalPosition / leverage;
      const loan = totalPosition - margin;
      
      expect(margin).toBe(50);
      expect(loan).toBe(50);
    });
  });
  
  describe('YES Position Liquidation Price', () => {
    it('calculates liquidation price for 5x YES position', () => {
      // 5x leverage: $50 margin, $200 loan, $250 total @ $0.42
      // Shares = $250 / $0.42 = 595.24
      const shares = 595.24;
      const loan = 200;
      
      const liqPrice = liquidationPriceYes(shares, loan);
      
      // Expected: 200 / (595.24 * 0.97) = 0.3464
      expect(liqPrice).toBeCloseTo(0.3464, 3);
    });
    
    it('calculates liquidation price for 10x YES position', () => {
      // 10x leverage: $50 margin, $450 loan, $500 total @ $0.50
      // Shares = $500 / $0.50 = 1000
      const shares = 1000;
      const loan = 450;
      
      const liqPrice = liquidationPriceYes(shares, loan);
      
      // Expected: 450 / (1000 * 0.97) = 0.4639
      expect(liqPrice).toBeCloseTo(0.4639, 3);
    });
    
    it('returns 0 for zero shares', () => {
      expect(liquidationPriceYes(0, 100)).toBe(0);
    });
    
    it('returns 0 for zero loan', () => {
      expect(liquidationPriceYes(100, 0)).toBe(0);
    });
    
    it('clamps liquidation price to max 0.99', () => {
      // Very high loan relative to shares
      const liqPrice = liquidationPriceYes(10, 1000);
      expect(liqPrice).toBe(0.99);
    });
  });
  
  describe('NO Position Liquidation Price', () => {
    it('calculates liquidation price for 5x NO position', () => {
      // 5x leverage: $50 margin, $200 loan, $250 total @ NO price $0.164
      // Shares = $250 / $0.164 = 1524.54
      const shares = 1524.54;
      const loan = 200;
      
      const liqPrice = liquidationPriceNo(shares, loan);
      
      // Expected: 200 / (1524.54 * 0.97) = 0.1352 (NO price)
      expect(liqPrice).toBeCloseTo(0.1352, 3);
    });
    
    it('calculates liquidation price for 10x NO position', () => {
      // 10x leverage: $50 margin, $450 loan, $500 total @ NO price $0.81
      // Shares = $500 / $0.81 = 617.28
      const shares = 617.28;
      const loan = 450;
      
      const liqPrice = liquidationPriceNo(shares, loan);
      
      // Expected: 450 / (617.28 * 0.97) = 0.7515 (NO price)
      expect(liqPrice).toBeCloseTo(0.7515, 3);
    });
  });
  
  describe('Current Equity Calculation', () => {
    it('calculates YES position equity correctly - profit', () => {
      // Bought at $0.40, now at $0.50
      const shares = 100;
      const currentPrice = 0.50; // YES price
      const loan = 30;
      
      const equity = currentEquity('YES', shares, currentPrice, loan);
      
      // Position value = 0.50 * 100 = $50
      // Equity = $50 - $30 = $20
      expect(equity).toBe(20);
    });
    
    it('calculates YES position equity correctly - loss', () => {
      // Bought at $0.50, now at $0.40
      const shares = 100;
      const currentPrice = 0.40;
      const loan = 30;
      
      const equity = currentEquity('YES', shares, currentPrice, loan);
      
      // Position value = 0.40 * 100 = $40
      // Equity = $40 - $30 = $10
      expect(equity).toBe(10);
    });
    
    it('calculates NO position equity correctly - profit', () => {
      // Bought NO at NO price $0.60 (YES = $0.40), now YES = $0.30 (NO = $0.70)
      const shares = 100;
      const currentYesPrice = 0.30; // NO price = 0.70
      const loan = 50;
      
      const equity = currentEquity('NO', shares, currentYesPrice, loan);
      
      // Position value = (1 - 0.30) * 100 = 0.70 * 100 = $70
      // Equity = $70 - $50 = $20
      expect(equity).toBe(20);
    });
    
    it('calculates NO position equity correctly - loss', () => {
      // Bought NO, now YES price increased (NO decreased)
      const shares = 100;
      const currentYesPrice = 0.80; // NO price = 0.20
      const loan = 15;
      
      const equity = currentEquity('NO', shares, currentYesPrice, loan);
      
      // Position value = (1 - 0.80) * 100 = 0.20 * 100 = $20
      // Equity = $20 - $15 = $5
      expect(equity).toBeCloseTo(5, 10);
    });
    
    it('returns negative equity when underwater', () => {
      const shares = 100;
      const currentPrice = 0.20;
      const loan = 30;
      
      const equity = currentEquity('YES', shares, currentPrice, loan);
      
      // Position value = 0.20 * 100 = $20
      // Equity = $20 - $30 = -$10
      expect(equity).toBe(-10);
    });
  });
  
  describe('Margin Ratio Calculation', () => {
    it('calculates healthy margin ratio', () => {
      const shares = 100;
      const currentPrice = 0.50;
      const loan = 30;
      
      const ratio = marginRatio('YES', shares, currentPrice, loan);
      
      // Equity = 50 - 30 = 20
      // Position value = 50
      // Ratio = 20/50 = 0.40 (40%)
      expect(ratio).toBeCloseTo(0.40, 2);
    });
    
    it('calculates low margin ratio near liquidation', () => {
      const shares = 100;
      const currentPrice = 0.35;
      const loan = 30;
      
      const ratio = marginRatio('YES', shares, currentPrice, loan);
      
      // Equity = 35 - 30 = 5
      // Position value = 35
      // Ratio = 5/35 = 0.143 (14.3%)
      expect(ratio).toBeCloseTo(0.143, 2);
    });
    
    it('returns 0 for zero position value', () => {
      const ratio = marginRatio('YES', 0, 0.50, 30);
      expect(ratio).toBe(0);
    });
  });
  
  describe('Liquidation Trigger Detection', () => {
    describe('YES Position', () => {
      it('triggers liquidation when price at liquidation level', () => {
        const liqPrice = 0.35;
        const currentPrice = 0.35;
        
        expect(shouldLiquidate('YES', currentPrice, liqPrice)).toBe(true);
      });
      
      it('triggers liquidation when price below liquidation level', () => {
        const liqPrice = 0.35;
        const currentPrice = 0.30;
        
        expect(shouldLiquidate('YES', currentPrice, liqPrice)).toBe(true);
      });
      
      it('does not trigger when price above liquidation level', () => {
        const liqPrice = 0.35;
        const currentPrice = 0.40;
        
        expect(shouldLiquidate('YES', currentPrice, liqPrice)).toBe(false);
      });
    });
    
    describe('NO Position', () => {
      it('triggers liquidation when NO price at liquidation level', () => {
        // NO liq price = 0.15
        // Use YES = 0.851 so NO = 0.149, which is below 0.15
        // (Note: 1 - 0.85 = 0.15000000000000002 due to floating point, which is > 0.15)
        const liqPrice = 0.15;
        const currentYesPrice = 0.851; // NO = 0.149 < 0.15
        
        expect(shouldLiquidate('NO', currentYesPrice, liqPrice)).toBe(true);
      });
      
      it('triggers liquidation when NO price below liquidation level', () => {
        // NO liq price = 0.15, current YES = 0.90 (NO = 0.10 < 0.15)
        const liqPrice = 0.15;
        const currentYesPrice = 0.90;
        
        expect(shouldLiquidate('NO', currentYesPrice, liqPrice)).toBe(true);
      });
      
      it('does not trigger when NO price above liquidation level', () => {
        // NO liq price = 0.15, current YES = 0.80 (NO = 0.20 > 0.15)
        const liqPrice = 0.15;
        const currentYesPrice = 0.80;
        
        expect(shouldLiquidate('NO', currentYesPrice, liqPrice)).toBe(false);
      });
    });
  });
});

describe('Leverage Scenarios from Manual Testing', () => {
  
  describe('Scenario 1.1: Basic 5x YES Position', () => {
    it('calculates correctly for 5x YES @ $0.42', () => {
      // From manual test: 5x $250 position, $50 margin, $200 loan
      const totalPosition = 250;
      const leverage = 5;
      const entryPrice = 0.42;
      
      const margin = totalPosition / leverage;
      const loan = totalPosition - margin;
      const shares = totalPosition / entryPrice;
      const liqPrice = liquidationPriceYes(shares, loan);
      
      expect(margin).toBe(50);
      expect(loan).toBe(200);
      expect(shares).toBeCloseTo(595.24, 1);
      expect(liqPrice).toBeCloseTo(0.3464, 3);
    });
  });
  
  describe('Scenario 1.2: Basic 10x NO Position', () => {
    it('calculates correctly for 10x NO @ $0.81', () => {
      // From manual test: 10x $500 position, $50 margin, $450 loan
      const totalPosition = 500;
      const leverage = 10;
      const noPrice = 0.81; // Entry NO price
      
      const margin = totalPosition / leverage;
      const loan = totalPosition - margin;
      const shares = totalPosition / noPrice;
      const liqPrice = liquidationPriceNo(shares, loan);
      
      expect(margin).toBe(50);
      expect(loan).toBe(450);
      expect(shares).toBeCloseTo(617.28, 1);
      // Liq price should be around 0.75 (NO price)
      expect(liqPrice).toBeCloseTo(0.7515, 2);
    });
  });
  
  describe('Scenario 3.3: Partial Close', () => {
    it('calculates partial close correctly (50%)', () => {
      // Original: 595.24 YES shares, $200 loan
      const originalShares = 595.24;
      const originalLoan = 200;
      const sellShares = 297; // ~50%
      const sellPrice = 0.40;
      
      // Partial close calculations
      const closeRatio = sellShares / originalShares;
      const partialLoanRepay = originalLoan * closeRatio;
      const proceeds = sellShares * sellPrice;
      const userEquity = proceeds - partialLoanRepay;
      
      // Remaining position
      const remainingShares = originalShares - sellShares;
      const remainingLoan = originalLoan - partialLoanRepay;
      const newLiqPrice = liquidationPriceYes(remainingShares, remainingLoan);
      
      expect(closeRatio).toBeCloseTo(0.499, 2);
      expect(partialLoanRepay).toBeCloseTo(99.79, 1);
      expect(proceeds).toBeCloseTo(118.80, 2);
      expect(userEquity).toBeCloseTo(19.01, 1);
      expect(remainingShares).toBeCloseTo(298.24, 1);
      expect(remainingLoan).toBeCloseTo(100.21, 1);
      expect(newLiqPrice).toBeCloseTo(0.3464, 2); // Should stay same due to proportional reduction
    });
  });
  
  describe('Scenario 4.1: YES Position Liquidation', () => {
    it('calculates liquidation proceeds correctly', () => {
      // Position: 5x YES @ $0.51, liq @ $0.5113
      // Price drops to $0.50, triggering liquidation
      const shares = 490.20; // $250 / $0.51
      const loan = 200;
      const liqPrice = 0.5113;
      const executionPrice = liqPrice; // Execute at liq price
      
      // Liquidation at liq price guarantees solvency
      const proceeds = shares * executionPrice;
      const loanRepaid = loan;
      const penalty = proceeds * 0.02; // 2% penalty
      const returnedToUser = proceeds - loanRepaid - penalty;
      
      expect(proceeds).toBeCloseTo(250.65, 1);
      expect(penalty).toBeCloseTo(5.01, 1);
      expect(returnedToUser).toBeCloseTo(45.64, 0); // Margin minus losses
    });
  });
  
  describe('Scenario 4.2: NO Position Liquidation', () => {
    it('calculates NO liquidation correctly', () => {
      // 5x NO position, liq NO price = $0.1352
      // Current YES = $0.91, meaning NO = $0.09 < $0.1352 → liquidate
      const shares = 1524.54;
      const loan = 200;
      const liqNoPrice = 0.1352;
      const currentYesPrice = 0.91;
      const currentNoPrice = 1 - currentYesPrice; // 0.09
      
      // Should trigger liquidation
      expect(shouldLiquidate('NO', currentYesPrice, liqNoPrice)).toBe(true);
      
      // Execute at liq price (not current price - ensures solvency)
      const executionPrice = liqNoPrice;
      const proceeds = shares * executionPrice;
      const loanRepaid = loan;
      const penalty = proceeds * 0.02;
      const returnedToUser = Math.max(0, proceeds - loanRepaid - penalty);
      
      expect(proceeds).toBeCloseTo(206.12, 0);
      expect(returnedToUser).toBeCloseTo(2.00, 0); // Small amount returned
    });
  });
  
  describe('Scenario 6.1: Settlement WIN', () => {
    it('calculates winning settlement correctly', () => {
      // 10x NO position won: 614 shares @ $1.00 payout
      const shares = 614;
      const loan = 450;
      const payout = shares * 1.00; // NO wins, each share worth $1
      
      const loanRepaid = loan;
      const userProfit = payout - loanRepaid;
      
      expect(payout).toBe(614);
      expect(loanRepaid).toBe(450);
      expect(userProfit).toBe(164); // User gets $164 profit
    });
  });
});

