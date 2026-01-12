import { config } from '../config.js';

/**
 * Fee Service
 * 
 * Calculates tiered taker fees based on FILL notional value.
 * Fees are charged per fill, not per order (industry standard).
 * 
 * Fee Tiers (configurable via .env):
 * - Tier 1: $0 to tier1Max → flat fee (default $0.02)
 * - Tier 2: tier1Max to tier2Max → tier2Bps (default 5 bps)
 * - Tier 3: tier2Max to tier3Max → tier3Bps (default 4 bps)
 * - Tier 4: tier3Max+ → tier4Bps (default 3 bps)
 * 
 * Maker orders (limit orders) are always free (0 bps).
 */

export interface FeeCalculation {
  fee: number;           // Fee amount in USD
  bps: number;           // Effective basis points
  tier: string;          // Tier name for logging
  isFlat: boolean;       // Whether flat fee was applied
}

/**
 * Calculate taker fee based on notional value
 * 
 * @param notionalValue - The dollar value of the order
 * @returns FeeCalculation with fee amount and metadata
 */
export function calculateTakerFee(notionalValue: number): FeeCalculation {
  const { fees } = config;
  
  // Tier 1: Flat fee for small orders
  if (notionalValue < fees.tier1Max) {
    return {
      fee: fees.flatFeeUsd,
      bps: Math.round((fees.flatFeeUsd / notionalValue) * 10000),
      tier: 'flat',
      isFlat: true,
    };
  }
  
  // Tier 2: tier1Max to tier2Max
  if (notionalValue < fees.tier2Max) {
    const fee = Math.max(
      notionalValue * (fees.tier2Bps / 10000),
      fees.flatFeeUsd  // Never charge less than flat fee
    );
    return {
      fee,
      bps: fees.tier2Bps,
      tier: 'tier2',
      isFlat: fee === fees.flatFeeUsd,
    };
  }
  
  // Tier 3: tier2Max to tier3Max
  if (notionalValue < fees.tier3Max) {
    const fee = notionalValue * (fees.tier3Bps / 10000);
    return {
      fee,
      bps: fees.tier3Bps,
      tier: 'tier3',
      isFlat: false,
    };
  }
  
  // Tier 4: tier3Max+
  const fee = notionalValue * (fees.tier4Bps / 10000);
  return {
    fee,
    bps: fees.tier4Bps,
    tier: 'tier4',
    isFlat: false,
  };
}

/**
 * Calculate maker fee (always 0 for now)
 */
export function calculateMakerFee(_notionalValue: number): FeeCalculation {
  return {
    fee: 0,
    bps: config.makerFeeBps,
    tier: 'maker',
    isFlat: true,
  };
}

/**
 * Get fee for order based on type
 */
export function calculateOrderFee(
  notionalValue: number,
  isTaker: boolean
): FeeCalculation {
  return isTaker 
    ? calculateTakerFee(notionalValue) 
    : calculateMakerFee(notionalValue);
}

/**
 * Validate order meets minimum notional requirements
 */
export function validateOrderMinimum(
  notionalValue: number,
  side: 'buy' | 'sell'
): { valid: boolean; minimum: number; message?: string } {
  const minimum = side === 'buy' ? config.minBuyNotional : config.minSellNotional;
  
  if (notionalValue < minimum) {
    return {
      valid: false,
      minimum,
      message: `Minimum ${side} order is $${minimum.toFixed(2)}`,
    };
  }
  
  return { valid: true, minimum };
}

/**
 * Get current fee configuration (for API responses)
 */
export function getFeeConfig() {
  return {
    makerFeeBps: config.makerFeeBps,
    tiers: [
      { 
        minNotional: 0, 
        maxNotional: config.fees.tier1Max, 
        type: 'flat',
        flatFee: config.fees.flatFeeUsd,
        bps: null,
      },
      { 
        minNotional: config.fees.tier1Max, 
        maxNotional: config.fees.tier2Max, 
        type: 'percentage',
        flatFee: null,
        bps: config.fees.tier2Bps,
      },
      { 
        minNotional: config.fees.tier2Max, 
        maxNotional: config.fees.tier3Max, 
        type: 'percentage',
        flatFee: null,
        bps: config.fees.tier3Bps,
      },
      { 
        minNotional: config.fees.tier3Max, 
        maxNotional: null, 
        type: 'percentage',
        flatFee: null,
        bps: config.fees.tier4Bps,
      },
    ],
    minimums: {
      buy: config.minBuyNotional,
      sell: config.minSellNotional,
    },
  };
}

export const feeService = {
  calculateTakerFee,
  calculateMakerFee,
  calculateOrderFee,
  validateOrderMinimum,
  getFeeConfig,
};

