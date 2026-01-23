import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { config } from '../config.js';
import { mmLogger } from '../lib/logger.js';
import { priceFeedService } from '../services/price-feed.service.js';
import { marketService } from '../services/market.service.js';
import { orderService } from '../services/order.service.js';
import { matchingService } from '../services/matching.service.js';
import { userService } from '../services/user.service.js';
import { positionService } from '../services/position.service.js';
import { anchorClient, getMarketPda } from '../lib/anchor-client.js';
import { broadcastOrderbookUpdate } from '../lib/broadcasts.js';
import { orderbookService } from '../services/orderbook.service.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Market Maker Configuration
 * All parameters are configurable via environment variables
 */
export interface MMConfigV2 {
  // Spread settings
  baseSpread: number;         // Base spread (e.g., 0.04 = 4 cents total)
  minSpread: number;          // Minimum spread (never tighter)
  maxSpread: number;          // Maximum spread (widen in uncertainty)
  
  // Size settings
  baseSize: number;           // Base contracts per level
  maxSize: number;            // Maximum size per level
  minSize: number;            // Minimum size to quote
  levels: number;             // Number of price levels on each side
  levelSpacing: number;       // Price increment between levels (e.g., 0.01)
  
  // Inventory / Delta neutral settings
  maxPositionPerMarket: number;    // Maximum position per outcome
  maxImbalance: number;            // Maximum YES - NO imbalance
  skewFactor: number;              // How aggressively to skew (0.01 - 0.05)
  rebalanceStartPct: number;       // Start aggressive rebalancing (e.g., 0.70 = 70% time elapsed)
  criticalRebalancePct: number;    // Critical rebalancing threshold (e.g., 0.90)
  
  // Time settings
  quoteUpdateMs: number;           // How often to update quotes
  closeBeforeExpiryMs: number;     // Stop quoting this early before expiry
  stopQuotingLoserPct: number;     // Stop quoting losing side when this % time remains
  
  // Volatility
  defaultVolatility: number;       // Default annualized volatility
  volatilityOverrides: Record<string, number>;  // Per-asset overrides
  
  // Assets
  assets: string[];                // Which assets to market make
  
  // WebSocket
  useWebSocket: boolean;           // Use WebSocket for price updates
  wsReconnectMs: number;           // Reconnect interval on disconnect
  
  // === VELOCITY SETTINGS (Phase 1 - V3 Design) ===
  velocity: {
    enabled: boolean;              // Enable velocity-based quote pulling
    windowMs: number;              // Velocity calculation window (default: 3000ms)
    historySize: number;           // Max price history entries to keep
    mediumThresholdPct: number;    // %/sec for MEDIUM urgency (default: 0.001 = 0.1%)
    highThresholdPct: number;      // %/sec for HIGH urgency (default: 0.003 = 0.3%)
    extremeThresholdPct: number;   // %/sec for EXTREME/PULL (default: 0.005 = 0.5%)
    emergencyPullEnabled: boolean; // Enable sub-cycle emergency pulls on extreme velocity
  };
  
  // === AVELLANEDA-STOIKOV SETTINGS (Phase 2 - V3 Design) ===
  avellanedaStoikov: {
    enabled: boolean;              // Use A-S quoting instead of simple spread
    gamma: number;                 // Risk aversion (0.01-0.5, higher = wider spreads)
    k: number;                     // Order arrival intensity (0.1-10, higher = tighter spreads)
    minHalfSpreadX: number;        // Minimum half-spread in x-space
  };
  
  // === BELIEF VOLATILITY CALIBRATION SETTINGS (Phase 3 - V3 Design) ===
  calibration: {
    enabled: boolean;              // Use calibrated σ_b instead of estimate
    windowSeconds: number;         // Rolling window for calibration (default: 300s)
    minSamples: number;            // Minimum samples for valid calibration
    jumpThresholdSigma: number;    // N-sigma threshold to classify as jump (default: 2.5)
    defaultSigmaB: number;         // Fallback σ_b when insufficient data
    maxSigmaB: number;             // Maximum σ_b cap
    minSigmaB: number;             // Minimum σ_b floor
  };
}

// ============================================================================
// VELOCITY TYPES (Phase 1 - V3 Design)
// ============================================================================

export type VelocityUrgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
export type HurtingSide = 'YES' | 'NO' | 'NEITHER';

export interface VelocityState {
  // Raw price velocity
  priceVelocity: number;          // $/second (e.g., -50 = falling $50/sec)
  priceVelocityPct: number;       // %/second (e.g., -0.0005 = -0.05%)
  
  // Fair value velocity  
  fairValueVelocity: number;      // Δp/second (e.g., -0.02 = losing 2 cents/sec)
  
  // Direction relative to strike
  movingAwayFromStrike: boolean;  // true if price diverging from strike
  
  // Which side is getting hurt
  hurtingSide: HurtingSide;
  
  // Urgency level
  urgency: VelocityUrgency;
  
  // Timestamps
  calculatedAt: number;
}

export interface QuoteDecision {
  // For YES side
  yes: {
    shouldQuoteBids: boolean;
    shouldQuoteAsks: boolean;
    spreadMultiplier: number;      // 1.0 = normal, 2.0 = double spread
    sizeMultiplier: number;        // 1.0 = normal, 0.0 = no quotes
  };
  // Reasoning
  reason: string;
}

// ============================================================================
// CALIBRATION TYPES (Phase 3 - V3 Design)
// ============================================================================

export type CalibrationConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface CalibrationResult {
  // Belief diffusive volatility (main output)
  sigma_b: number;
  
  // Jump parameters (for future use)
  lambda: number;           // Jump intensity per hour
  jumpMean: number;         // Average jump size in x-space
  jumpStd: number;          // Jump std dev in x-space
  
  // Data quality
  sampleCount: number;      // Number of fair value observations used
  diffusionCount: number;   // Non-jump observations
  jumpCount: number;        // Jump observations detected
  
  // Confidence scoring
  confidence: CalibrationConfidence;
  
  // Timestamps
  calibratedAt: number;
  windowStartAt: number;
}

export interface FairValuePoint {
  fairValue: number;        // p ∈ (0, 1)
  logOdds: number;          // x = log(p/(1-p))
  timestamp: number;
  price: number;            // Underlying BTC price at this time
}

// Load configuration from environment
function loadConfig(): MMConfigV2 {
  return {
    // Spread
    baseSpread: parseFloat(process.env.MM_BASE_SPREAD || '0.04'),
    minSpread: parseFloat(process.env.MM_MIN_SPREAD || '0.02'),
    maxSpread: parseFloat(process.env.MM_MAX_SPREAD || '0.20'),
    
    // Size
    baseSize: parseFloat(process.env.MM_BASE_SIZE || '100'),
    maxSize: parseFloat(process.env.MM_MAX_SIZE || '1000'),
    minSize: parseFloat(process.env.MM_MIN_SIZE || '10'),
    levels: parseInt(process.env.MM_LEVELS || '3'),
    levelSpacing: parseFloat(process.env.MM_LEVEL_SPACING || '0.01'),
    
    // Inventory
    maxPositionPerMarket: parseFloat(process.env.MM_MAX_POSITION || '10000'),
    maxImbalance: parseFloat(process.env.MM_MAX_IMBALANCE || '5000'),
    skewFactor: parseFloat(process.env.MM_SKEW_FACTOR || '0.02'),
    rebalanceStartPct: parseFloat(process.env.MM_REBALANCE_START_PCT || '0.70'),
    criticalRebalancePct: parseFloat(process.env.MM_CRITICAL_REBALANCE_PCT || '0.90'),
    
    // Time
    quoteUpdateMs: parseInt(process.env.MM_QUOTE_UPDATE_MS || '250'),
    closeBeforeExpiryMs: parseInt(process.env.MM_CLOSE_BEFORE_EXPIRY_MS || '2000'),
    stopQuotingLoserPct: parseFloat(process.env.MM_STOP_QUOTING_LOSER_PCT || '0.10'),
    
    // Volatility (annualized)
    defaultVolatility: parseFloat(process.env.MM_DEFAULT_VOLATILITY || '0.50'),
    volatilityOverrides: JSON.parse(process.env.MM_VOLATILITY_OVERRIDES || '{}'),
    
    // Assets
    assets: (process.env.MM_ASSETS || 'BTC').split(',').map(s => s.trim()),
    
    // WebSocket
    useWebSocket: process.env.MM_USE_WEBSOCKET !== 'false',
    wsReconnectMs: parseInt(process.env.MM_WS_RECONNECT_MS || '5000'),
    
    // Velocity (Phase 1 - V3 Design)
    velocity: {
      enabled: process.env.MM_VELOCITY_ENABLED !== 'false',  // Enabled by default
      windowMs: parseInt(process.env.MM_VELOCITY_WINDOW_MS || '3000'),
      historySize: parseInt(process.env.MM_VELOCITY_HISTORY_SIZE || '100'),
      mediumThresholdPct: parseFloat(process.env.MM_VELOCITY_MEDIUM_PCT || '0.001'),   // 0.1%/sec
      highThresholdPct: parseFloat(process.env.MM_VELOCITY_HIGH_PCT || '0.003'),       // 0.3%/sec
      extremeThresholdPct: parseFloat(process.env.MM_VELOCITY_EXTREME_PCT || '0.005'), // 0.5%/sec
      emergencyPullEnabled: process.env.MM_VELOCITY_EMERGENCY_PULL !== 'false',
    },
    
    // Avellaneda-Stoikov (Phase 2 - V3 Design)
    avellanedaStoikov: {
      enabled: process.env.MM_AS_ENABLED !== 'false',  // Enabled by default
      gamma: parseFloat(process.env.MM_AS_GAMMA || '0.05'),     // Risk aversion (lower = tighter)
      k: parseFloat(process.env.MM_AS_K || '2.0'),              // Order arrival intensity (higher = tighter)
      minHalfSpreadX: parseFloat(process.env.MM_AS_MIN_SPREAD_X || '0.04'), // ~1 cent at p=0.50
    },
    
    // Belief Volatility Calibration (Phase 3 - V3 Design)
    calibration: {
      enabled: process.env.MM_CALIBRATION_ENABLED !== 'false',  // Enabled by default
      windowSeconds: parseInt(process.env.MM_CALIBRATION_WINDOW_SEC || '300'),  // 5 min window
      minSamples: parseInt(process.env.MM_CALIBRATION_MIN_SAMPLES || '20'),     // Min data points
      jumpThresholdSigma: parseFloat(process.env.MM_CALIBRATION_JUMP_SIGMA || '2.5'),  // 2.5σ = jump
      defaultSigmaB: parseFloat(process.env.MM_CALIBRATION_DEFAULT_SIGMA || '0.25'),   // Fallback σ_b
      maxSigmaB: parseFloat(process.env.MM_CALIBRATION_MAX_SIGMA || '1.0'),            // Cap σ_b
      minSigmaB: parseFloat(process.env.MM_CALIBRATION_MIN_SIGMA || '0.05'),           // Floor σ_b
    },
  };
}

// Domain separator for order messages (must match contract)
const ORDER_MESSAGE_PREFIX = 'DEGEN_ORDER_V1:';

// ============================================================================
// MATH UTILITIES
// ============================================================================

/**
 * Standard normal cumulative distribution function (CDF)
 * Approximation using Abramowitz and Stegun method
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  
  return 0.5 * (1.0 + sign * y);
}

// ============================================================================
// LOG-ODDS SPACE QUOTING (Phase 2 - V3 Design)
// Based on arXiv:2510.15205 "Toward Black-Scholes for Prediction Markets"
// ============================================================================

/**
 * Convert probability to log-odds (x-space).
 * x = log(p / (1-p))
 * 
 * Properties:
 * - p=0.50 → x=0
 * - p=0.99 → x≈4.6
 * - p=0.01 → x≈-4.6
 * - Working in x-space makes the math more stable near boundaries
 */
function probToLogOdds(p: number): number {
  // Clamp to avoid infinities
  const safeP = Math.max(0.001, Math.min(0.999, p));
  return Math.log(safeP / (1 - safeP));
}

/**
 * Convert log-odds back to probability.
 * p = 1 / (1 + e^(-x)) = sigmoid(x)
 */
function logOddsToProb(x: number): number {
  // Prevent overflow for large |x|
  if (x > 10) return 0.99999;
  if (x < -10) return 0.00001;
  return 1 / (1 + Math.exp(-x));
}

/**
 * Derivative of sigmoid: S'(x) = p(1-p)
 * This tells us how sensitive p is to changes in x.
 * 
 * At p=0.50: S'=0.25 (most sensitive)
 * At p=0.10: S'=0.09 (less sensitive)
 * At p=0.01: S'=0.0099 (very insensitive - automatic boundary compression)
 */
function sigmoidDerivative(p: number): number {
  const safeP = Math.max(0.001, Math.min(0.999, p));
  return safeP * (1 - safeP);
}

/**
 * Avellaneda-Stoikov reservation price in x-space.
 * 
 * r_x = x - (γ * q) / (k * T)
 * 
 * Where:
 * - x = current log-odds (fair value in x-space)
 * - γ = risk aversion parameter (higher = more inventory averse)
 * - q = net inventory (YES - NO), positive = long YES
 * - k = order arrival intensity (higher = more confident in mean-reversion)
 * - T = time to expiry in seconds
 * 
 * Interpretation:
 * - If q > 0 (long YES), shift reservation DOWN to attract sellers
 * - If q < 0 (long NO), shift reservation UP to attract buyers
 */
function calculateReservationX(
  x: number,
  inventory: number,
  gamma: number,
  k: number,
  timeToExpirySec: number
): number {
  // Avoid division by zero
  const safeT = Math.max(timeToExpirySec, 1);
  const safeK = Math.max(k, 0.1);
  
  const inventoryAdjustment = (gamma * inventory) / (safeK * safeT);
  
  // Clamp adjustment to prevent extreme skews
  const maxAdjustment = 2.0; // max 2 units in x-space (~7x odds shift)
  const clampedAdjustment = Math.max(-maxAdjustment, Math.min(maxAdjustment, inventoryAdjustment));
  
  return x - clampedAdjustment;
}

/**
 * Avellaneda-Stoikov half-spread in x-space.
 * 
 * Modified formula for short-term prediction markets:
 * δ_x = base_spread + risk_spread
 * 
 * Where:
 * - base_spread depends on gamma/k (market making compensation)
 * - risk_spread depends on belief volatility and normalized time
 * 
 * Key insight: For 5-15 minute markets, we need to:
 * 1. Normalize time to 0-1 range
 * 2. Scale volatility appropriately for short durations
 */
function calculateHalfSpreadX(
  sigma_b: number,
  gamma: number,
  k: number,
  timeToExpirySec: number,
  marketDurationSec: number = 300 // Default 5 min
): number {
  const safeK = Math.max(k, 0.1);
  
  // Normalize time to 0-1 (what fraction of market remains)
  const normalizedT = Math.max(0.01, Math.min(1, timeToExpirySec / marketDurationSec));
  
  // Base liquidity spread (compensation for market making)
  // This is the minimum we need regardless of volatility
  const liquiditySpread = (1 / safeK) * Math.log(1 + gamma / safeK);
  
  // Risk spread based on belief volatility
  // Scale down significantly for short-term markets
  // sigma_b is already adjusted for timeframe, but we need it per-unit-time
  const scaledSigmaB = sigma_b * 0.1; // Scale down for short durations
  const varianceSpread = gamma * scaledSigmaB * scaledSigmaB * normalizedT;
  
  // Combined half-spread
  const baseHalfSpread = liquiditySpread + varianceSpread;
  
  // Clamp to reasonable range in x-space
  // 0.04 ≈ 1 cent at p=0.50, 0.40 ≈ 10 cents at p=0.50
  const minHalfSpreadX = 0.04;
  const maxHalfSpreadX = 0.40;
  
  return Math.max(minHalfSpreadX, Math.min(maxHalfSpreadX, baseHalfSpread));
}

/**
 * Convert x-space quotes to probability-space with boundary handling.
 * 
 * The key insight: δ_p ≈ S'(x) * δ_x = p(1-p) * δ_x
 * This automatically compresses spread near boundaries!
 */
function xQuotesToProbability(
  x_bid: number,
  x_ask: number,
  minSpread: number,
  maxSpread: number
): { p_bid: number; p_ask: number; spread: number } {
  let p_bid = logOddsToProb(x_bid);
  let p_ask = logOddsToProb(x_ask);
  
  // Ensure ask > bid
  if (p_ask <= p_bid) {
    const mid = (p_bid + p_ask) / 2;
    p_bid = mid - minSpread / 2;
    p_ask = mid + minSpread / 2;
  }
  
  // Clamp to valid range
  p_bid = Math.max(0.01, Math.min(0.98, p_bid));
  p_ask = Math.max(0.02, Math.min(0.99, p_ask));
  
  let spread = p_ask - p_bid;
  
  // Enforce spread constraints
  if (spread < minSpread) {
    const mid = (p_bid + p_ask) / 2;
    p_bid = Math.max(0.01, mid - minSpread / 2);
    p_ask = Math.min(0.99, mid + minSpread / 2);
    spread = p_ask - p_bid;
  }
  
  if (spread > maxSpread) {
    const mid = (p_bid + p_ask) / 2;
    p_bid = Math.max(0.01, mid - maxSpread / 2);
    p_ask = Math.min(0.99, mid + maxSpread / 2);
    spread = p_ask - p_bid;
  }
  
  return { p_bid, p_ask, spread };
}

/**
 * Calculate boundary-aware position limits.
 * Near p=0 or p=1, we should hold smaller positions because
 * the binary payoff creates more risk per contract.
 * 
 * Uses S'(x) = p(1-p) as a natural scaling factor.
 */
function getBoundaryAwareMaxPosition(
  fairValue: number,
  baseMaxPosition: number
): number {
  const sPrime = sigmoidDerivative(fairValue);
  
  // At p=0.5: sPrime=0.25, full position allowed
  // At p=0.1: sPrime=0.09, ~36% position allowed
  // At p=0.01: sPrime=0.0099, ~4% position allowed
  const boundaryFactor = Math.min(1.0, sPrime / 0.25);
  
  // Don't reduce below 10% of max
  return Math.max(baseMaxPosition * 0.10, baseMaxPosition * boundaryFactor);
}

/**
 * Estimate belief volatility (σ_b) from effective price volatility.
 * 
 * LEGACY: This is the fallback when calibration is disabled or has insufficient data.
 * Phase 3 calibration provides a more accurate σ_b from actual fair value changes.
 * 
 * For short-term prediction markets, σ_b should be relatively small
 * because beliefs don't change that rapidly in x-space.
 */
function estimateBeliefVolatilityFallback(
  effectiveVol: number,
  fairValue: number,
  timeToExpirySec: number
): number {
  // Start with a base belief volatility
  // For short-term markets, this should be small (0.1-0.3)
  let sigma_b = Math.min(effectiveVol, 0.30);
  
  // Near boundaries, belief changes are compressed in p-space
  // but we're working in x-space where this is handled by the transform
  // So we keep sigma_b relatively stable
  const sPrime = sigmoidDerivative(fairValue);
  
  // Only slight adjustment for boundary proximity
  const boundaryFactor = 0.7 + 0.3 * (sPrime / 0.25);
  sigma_b *= boundaryFactor;
  
  // Near expiry, beliefs are more certain (less vol, not more)
  // because there's less time for things to change
  if (timeToExpirySec < 60) {
    sigma_b *= 0.7; // Last minute: beliefs more stable
  } else if (timeToExpirySec < 180) {
    sigma_b *= 0.85; // Last 3 minutes
  }
  
  // Clamp to reasonable range for short-term markets
  return Math.max(0.05, Math.min(0.50, sigma_b));
}

// ============================================================================
// PHASE 3: BELIEF VOLATILITY CALIBRATION
// ============================================================================

/**
 * Statistical helper: calculate mean of array
 */
function arrayMean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, x) => sum + x, 0) / arr.length;
}

/**
 * Statistical helper: calculate variance of array
 */
function arrayVariance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arrayMean(arr);
  return arr.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / (arr.length - 1);
}

/**
 * Statistical helper: calculate standard deviation of array
 */
function arrayStd(arr: number[]): number {
  return Math.sqrt(arrayVariance(arr));
}

/**
 * Calibrate belief volatility (σ_b) from actual fair value changes.
 * 
 * This is the core Phase 3 function. It:
 * 1. Converts fair value history to log-odds (x-space)
 * 2. Calculates changes (Δx) between observations
 * 3. Separates jumps from diffusion using threshold detection
 * 4. Estimates σ_b from diffusive component only
 * 5. Extracts jump parameters for future use
 * 
 * The key insight from the paper: belief changes in x-space are more
 * stable and follow a jump-diffusion process. By separating jumps,
 * we get a cleaner estimate of the diffusive volatility.
 */
function calibrateBeliefDynamics(
  fairValueHistory: FairValuePoint[],
  config: MMConfigV2,
  timeToExpirySec: number
): CalibrationResult {
  const now = Date.now();
  const windowMs = config.calibration.windowSeconds * 1000;
  const windowStart = now - windowMs;
  
  // Filter to recent observations only
  const recent = fairValueHistory.filter(p => p.timestamp > windowStart);
  
  // Insufficient data - return conservative defaults
  if (recent.length < config.calibration.minSamples) {
    return {
      sigma_b: config.calibration.defaultSigmaB,
      lambda: 1.0,
      jumpMean: 0,
      jumpStd: 0.5,
      sampleCount: recent.length,
      diffusionCount: 0,
      jumpCount: 0,
      confidence: 'LOW',
      calibratedAt: now,
      windowStartAt: windowStart,
    };
  }
  
  // Step 1: Calculate changes in x-space
  const changes: { dx: number; dt: number; timestamp: number }[] = [];
  for (let i = 1; i < recent.length; i++) {
    const dx = recent[i].logOdds - recent[i - 1].logOdds;
    const dt = (recent[i].timestamp - recent[i - 1].timestamp) / 1000; // seconds
    
    if (dt > 0 && dt < 60) { // Ignore gaps > 60 seconds (likely market closed)
      changes.push({ dx, dt, timestamp: recent[i].timestamp });
    }
  }
  
  if (changes.length < 10) {
    return {
      sigma_b: config.calibration.defaultSigmaB,
      lambda: 0.5,
      jumpMean: 0,
      jumpStd: 0.3,
      sampleCount: recent.length,
      diffusionCount: changes.length,
      jumpCount: 0,
      confidence: 'LOW',
      calibratedAt: now,
      windowStartAt: windowStart,
    };
  }
  
  // Step 2: Separate jumps from diffusion
  // First pass: estimate overall std of changes
  const allDx = changes.map(c => c.dx);
  const dxStd = arrayStd(allDx);
  const jumpThreshold = config.calibration.jumpThresholdSigma * dxStd;
  
  const diffusion: typeof changes = [];
  const jumps: typeof changes = [];
  
  for (const change of changes) {
    if (Math.abs(change.dx) >= jumpThreshold) {
      jumps.push(change);
    } else {
      diffusion.push(change);
    }
  }
  
  // Step 3: Estimate diffusive volatility
  let sigma_b: number;
  
  if (diffusion.length >= 5) {
    // Calculate variance per unit time from diffusive moves
    const diffusionDx = diffusion.map(c => c.dx);
    const diffusionDt = diffusion.map(c => c.dt);
    
    // Variance of dx normalized by dt
    // For Brownian motion: Var(dx) = σ² * dt, so σ² = Var(dx)/dt
    const avgDt = arrayMean(diffusionDt);
    const variance = arrayVariance(diffusionDx);
    const variancePerSec = avgDt > 0 ? variance / avgDt : variance;
    
    // Convert to annualized volatility for consistency with the rest of the system
    // But for short-term markets, we want to scale appropriately
    // sqrt(variancePerSec * seconds_per_year) = annualized σ
    const secondsPerYear = 365 * 24 * 3600;
    sigma_b = Math.sqrt(variancePerSec * secondsPerYear);
    
    // For very short-term markets, scale down
    // The formula above gives annualized vol; for 5-min markets we need smaller values
    const marketDuration = getMarketDurationSec(config.assets[0] || '5m'); // Fallback
    const timeScaleFactor = Math.sqrt(timeToExpirySec / secondsPerYear);
    
    // The σ_b we use in A-S should be per-unit-normalized-time
    // For a 5-min market: σ_b represents vol over the remaining fraction of market duration
    sigma_b = Math.sqrt(variance) * Math.sqrt(300 / avgDt); // Scale to 5-min window equivalent
  } else {
    // Not enough diffusive observations
    sigma_b = config.calibration.defaultSigmaB;
  }
  
  // Step 4: Estimate jump parameters
  const windowSeconds = config.calibration.windowSeconds;
  const lambda = (jumps.length / windowSeconds) * 3600; // jumps per hour
  
  const jumpSizes = jumps.map(j => j.dx);
  const jumpMean = jumpSizes.length > 0 ? arrayMean(jumpSizes) : 0;
  const jumpStd = jumpSizes.length > 1 ? arrayStd(jumpSizes) : 0.5;
  
  // Step 5: Determine confidence
  let confidence: CalibrationConfidence;
  if (recent.length >= 100 && diffusion.length >= 50) {
    confidence = 'HIGH';
  } else if (recent.length >= 50 && diffusion.length >= 20) {
    confidence = 'MEDIUM';
  } else {
    confidence = 'LOW';
  }
  
  // Clamp σ_b to configured bounds
  sigma_b = Math.max(config.calibration.minSigmaB, Math.min(config.calibration.maxSigmaB, sigma_b));
  
  return {
    sigma_b,
    lambda: Math.min(lambda, 20), // Cap at 20 jumps/hour
    jumpMean,
    jumpStd: Math.max(0.1, Math.min(2.0, jumpStd)),
    sampleCount: recent.length,
    diffusionCount: diffusion.length,
    jumpCount: jumps.length,
    confidence,
    calibratedAt: now,
    windowStartAt: windowStart,
  };
}

/**
 * Get belief volatility, using calibration if available and enabled,
 * otherwise falling back to the estimation method.
 */
function getBeliefVolatility(
  config: MMConfigV2,
  calibration: CalibrationResult | null,
  effectiveVol: number,
  fairValue: number,
  timeToExpirySec: number
): { sigma_b: number; source: 'calibrated' | 'estimated'; confidence: CalibrationConfidence } {
  // If calibration is enabled and we have valid calibration data
  if (config.calibration.enabled && calibration && calibration.confidence !== 'LOW') {
    return {
      sigma_b: calibration.sigma_b,
      source: 'calibrated',
      confidence: calibration.confidence,
    };
  }
  
  // Fall back to estimation
  return {
    sigma_b: estimateBeliefVolatilityFallback(effectiveVol, fairValue, timeToExpirySec),
    source: 'estimated',
    confidence: 'LOW',
  };
}

/**
 * A-S quoting parameters (configurable via env in future)
 */
const AS_PARAMS = {
  gamma: 0.1,      // Risk aversion (0.01 = risk neutral, 0.5 = very risk averse)
  k: 1.0,          // Order arrival intensity (higher = more flow expected)
  minSpreadX: 0.08, // Minimum half-spread in x-space (~2 cents at p=0.50)
};

// ============================================================================
// VELOCITY CALCULATION (Phase 1 - V3 Design)
// ============================================================================

interface PricePoint {
  price: number;
  timestamp: number;
}

/**
 * Calculate price velocity using linear regression over a time window.
 * More stable than point-to-point calculation.
 */
function calculatePriceVelocity(
  priceHistory: PricePoint[],
  windowMs: number = 3000
): { velocity: number; velocityPct: number } {
  const now = Date.now();
  const windowStart = now - windowMs;
  const recent = priceHistory.filter(p => p.timestamp > windowStart);
  
  if (recent.length < 2) {
    return { velocity: 0, velocityPct: 0 };
  }
  
  // Linear regression for velocity (more stable than point-to-point)
  const n = recent.length;
  let sumT = 0, sumP = 0, sumTP = 0, sumTT = 0;
  
  for (const { price, timestamp } of recent) {
    const t = (timestamp - now) / 1000;  // seconds ago (negative)
    sumT += t;
    sumP += price;
    sumTP += t * price;
    sumTT += t * t;
  }
  
  const denominator = n * sumTT - sumT * sumT;
  if (Math.abs(denominator) < 0.0001) {
    return { velocity: 0, velocityPct: 0 };
  }
  
  // Slope = velocity in $/second
  const velocity = (n * sumTP - sumT * sumP) / denominator;
  
  // As percentage of average price
  const avgPrice = sumP / n;
  const velocityPct = avgPrice > 0 ? velocity / avgPrice : 0;
  
  return { velocity, velocityPct };
}

/**
 * Determine which side of the binary market is being hurt by the price movement.
 * 
 * YES wins if price > strike at expiry
 * NO wins if price < strike at expiry
 * 
 * @returns 'YES' if YES is getting hurt, 'NO' if NO is getting hurt, 'NEITHER' if neutral
 */
function determineHurtingSide(
  currentPrice: number,
  strike: number,
  priceVelocity: number,
  currentFairValue: number
): HurtingSide {
  const isAboveStrike = currentPrice > strike;
  const isRising = priceVelocity > 0;
  const isFalling = priceVelocity < 0;
  
  // Threshold for "significant" velocity ($/sec) - ~$10/sec for BTC
  const significantVelocity = strike * 0.0001;
  const hasSignificantVelocity = Math.abs(priceVelocity) > significantVelocity;
  
  if (!hasSignificantVelocity) {
    return 'NEITHER';
  }
  
  // YES wins if price > strike at expiry
  // NO wins if price < strike at expiry
  
  if (isAboveStrike && isRising) {
    // Price above strike and rising further → YES getting stronger, NO hurting
    return 'NO';
  }
  
  if (isAboveStrike && isFalling) {
    // Price above strike but falling toward it → YES weakening
    // More urgent if fair value is close to 0.5 (market is uncertain)
    if (currentFairValue < 0.70) {
      return 'YES';
    }
    return 'NEITHER';
  }
  
  if (!isAboveStrike && isFalling) {
    // Price below strike and falling further → NO getting stronger, YES hurting
    return 'YES';
  }
  
  if (!isAboveStrike && isRising) {
    // Price below strike but rising toward it → NO weakening
    if (currentFairValue > 0.30) {
      return 'NO';
    }
    return 'NEITHER';
  }
  
  return 'NEITHER';
}

/**
 * Classify velocity urgency based on thresholds.
 * Takes into account time to expiry and boundary proximity.
 */
function classifyVelocityUrgency(
  priceVelocityPct: number,
  fairValueVelocity: number,
  currentFairValue: number,
  timeToExpirySec: number,
  config: MMConfigV2
): VelocityUrgency {
  const absPriceVelPct = Math.abs(priceVelocityPct);
  
  // Time factor: urgency increases as expiry approaches
  const timeFactor = timeToExpirySec < 300 ? 2.0 :  // < 5 min
                     timeToExpirySec < 900 ? 1.5 :  // < 15 min
                     1.0;
  
  // Boundary factor: urgency increases near 0 or 1
  const boundaryFactor = (currentFairValue < 0.15 || currentFairValue > 0.85) ? 1.5 : 1.0;
  
  // Adjust thresholds based on factors (lower thresholds = more sensitive)
  const adjustedMedium = config.velocity.mediumThresholdPct / (timeFactor * boundaryFactor);
  const adjustedHigh = config.velocity.highThresholdPct / (timeFactor * boundaryFactor);
  const adjustedExtreme = config.velocity.extremeThresholdPct / (timeFactor * boundaryFactor);
  
  if (absPriceVelPct > adjustedExtreme) return 'EXTREME';
  if (absPriceVelPct > adjustedHigh) return 'HIGH';
  if (absPriceVelPct > adjustedMedium) return 'MEDIUM';
  return 'LOW';
}

/**
 * Calculate complete velocity state for a market.
 */
function calculateVelocityState(
  priceHistory: PricePoint[],
  currentPrice: number,
  strike: number,
  currentFairValue: number,
  timeToExpirySec: number,
  config: MMConfigV2
): VelocityState {
  const { velocity: priceVelocity, velocityPct: priceVelocityPct } = calculatePriceVelocity(
    priceHistory,
    config.velocity.windowMs
  );
  
  // Estimate fair value velocity from price velocity (simplified)
  // This is approximate - a more accurate version would track FV history
  const fairValueVelocity = priceVelocityPct * currentFairValue * (1 - currentFairValue) * 2;
  
  const hurtingSide = determineHurtingSide(currentPrice, strike, priceVelocity, currentFairValue);
  
  const movingAwayFromStrike = 
    (currentPrice > strike && priceVelocity > 0) ||
    (currentPrice < strike && priceVelocity < 0);
  
  const urgency = classifyVelocityUrgency(
    priceVelocityPct,
    fairValueVelocity,
    currentFairValue,
    timeToExpirySec,
    config
  );
  
  return {
    priceVelocity,
    priceVelocityPct,
    fairValueVelocity,
    movingAwayFromStrike,
    hurtingSide,
    urgency,
    calculatedAt: Date.now(),
  };
}

/**
 * Make quote decision based on velocity state.
 * Determines spread/size multipliers and whether to pull quotes.
 */
function makeVelocityQuoteDecision(
  velocity: VelocityState,
  fairValue: number,
  inventory: { yes: number; no: number },
  timeToExpirySec: number,
  config: MMConfigV2
): QuoteDecision {
  const decision: QuoteDecision = {
    yes: {
      shouldQuoteBids: true,
      shouldQuoteAsks: true,
      spreadMultiplier: 1.0,
      sizeMultiplier: 1.0,
    },
    reason: 'Normal quoting (velocity LOW)',
  };
  
  if (!config.velocity.enabled) {
    return decision;
  }
  
  // === VELOCITY-BASED ADJUSTMENTS ===
  
  if (velocity.urgency === 'EXTREME') {
    // PULL QUOTES on the hurting side entirely
    if (velocity.hurtingSide === 'YES') {
      decision.yes.shouldQuoteBids = false;  // Don't buy dying YES
      decision.yes.sizeMultiplier = 0.1;     // Minimal ask size too
      decision.yes.spreadMultiplier = 3.0;   // Wide asks if we quote
      decision.reason = `🚨 EXTREME velocity (${(velocity.priceVelocityPct * 100).toFixed(3)}%/s) hurting YES - PULLED YES BIDS`;
    } else if (velocity.hurtingSide === 'NO') {
      // NO is hurt = YES is doing well = don't sell YES cheap
      decision.yes.shouldQuoteAsks = false;  // Don't sell winning YES
      decision.yes.sizeMultiplier = 0.1;
      decision.yes.spreadMultiplier = 3.0;
      decision.reason = `🚨 EXTREME velocity (${(velocity.priceVelocityPct * 100).toFixed(3)}%/s) hurting NO - PULLED YES ASKS`;
    }
  }
  
  else if (velocity.urgency === 'HIGH') {
    // Widen spreads significantly, reduce size
    decision.yes.spreadMultiplier = 2.0;
    decision.yes.sizeMultiplier = 0.25;
    
    if (velocity.hurtingSide === 'YES') {
      decision.yes.shouldQuoteBids = false;  // Stop buying the loser
      decision.reason = `⚠️ HIGH velocity (${(velocity.priceVelocityPct * 100).toFixed(3)}%/s) hurting YES - pulled bids, 2x spread`;
    } else if (velocity.hurtingSide === 'NO') {
      decision.yes.shouldQuoteAsks = false;  // Stop selling the winner
      decision.reason = `⚠️ HIGH velocity (${(velocity.priceVelocityPct * 100).toFixed(3)}%/s) hurting NO - pulled asks, 2x spread`;
    } else {
      decision.reason = `⚠️ HIGH velocity (${(velocity.priceVelocityPct * 100).toFixed(3)}%/s) - 2x spread, 25% size`;
    }
  }
  
  else if (velocity.urgency === 'MEDIUM') {
    // Moderate spread widening
    decision.yes.spreadMultiplier = 1.5;
    decision.yes.sizeMultiplier = 0.5;
    decision.reason = `⚡ MEDIUM velocity (${(velocity.priceVelocityPct * 100).toFixed(3)}%/s) - 1.5x spread, 50% size`;
  }
  
  // === TIME-BASED OVERRIDES ===
  
  // Near expiry with clear winner - be more aggressive about pulling
  if (timeToExpirySec < 60 && (fairValue < 0.10 || fairValue > 0.90)) {
    const loser = fairValue < 0.10 ? 'YES' : 'NO';
    if (loser === 'YES') {
      decision.yes.shouldQuoteBids = false;
      decision.yes.sizeMultiplier = 0;
    } else {
      decision.yes.shouldQuoteAsks = false;
      decision.yes.sizeMultiplier = 0;
    }
    decision.reason = `⏰ Near expiry (${timeToExpirySec}s), ${loser} is dead (FV=${fairValue.toFixed(3)}) - no ${loser} liquidity`;
  }
  
  return decision;
}

/**
 * Get effective volatility adjusted for timeframe.
 * 
 * Short-term markets (5m, 15m) need LOWER volatility than the annualized default
 * because price doesn't move as much in short windows.
 * 
 * The 50% annualized default assumes uniform distribution of moves across the year,
 * but in reality, most of BTC's annual volatility comes from large moves on specific days.
 * For 5-minute windows during calm periods, realized vol is much lower.
 */
function getEffectiveVolatility(
  baseVolatility: number,
  timeframe: string,
  timeToExpirySec: number
): number {
  // Timeframe-specific volatility multipliers
  // Lower = more decisive fair values (appropriate for short timeframes)
  const timeframeMultipliers: Record<string, number> = {
    '5m': 0.40,   // 5-min: use 40% of base vol (e.g., 50% → 20%)
    '15m': 0.50,  // 15-min: use 50% of base vol (e.g., 50% → 25%)
    '1h': 0.70,   // 1-hour: use 70% of base vol (e.g., 50% → 35%)
    '4h': 0.85,   // 4-hour: use 85% of base vol
    '24h': 1.0,   // 24-hour: use full base vol
  };
  
  const multiplier = timeframeMultipliers[timeframe] ?? 0.60;
  
  // Additional reduction as we approach expiry
  // In the last 20% of time, vol should drop further (less time for big moves)
  const marketDurationSec = getMarketDurationSec(timeframe);
  const timeRemainingPct = timeToExpirySec / marketDurationSec;
  
  let expiryAdjustment = 1.0;
  if (timeRemainingPct < 0.20) {
    // Last 20%: reduce vol by up to 50%
    expiryAdjustment = 0.50 + (timeRemainingPct / 0.20) * 0.50;
  } else if (timeRemainingPct < 0.50) {
    // 20-50% remaining: reduce vol by up to 20%
    expiryAdjustment = 0.80 + ((timeRemainingPct - 0.20) / 0.30) * 0.20;
  }
  
  return baseVolatility * multiplier * expiryAdjustment;
}

/**
 * Get market duration in seconds based on timeframe string.
 */
function getMarketDurationSec(timeframe: string): number {
  const durations: Record<string, number> = {
    '5m': 5 * 60,
    '15m': 15 * 60,
    '1h': 60 * 60,
    '4h': 4 * 60 * 60,
    '24h': 24 * 60 * 60,
  };
  return durations[timeframe] ?? 15 * 60; // default 15m
}

/**
 * Calculate fair value (probability of YES winning) using Black-Scholes d2
 * 
 * For binary options: P(S_T > K) = N(d2)
 * where d2 = [ln(S/K) + (r - σ²/2)T] / (σ√T)
 * 
 * Simplified (assuming r ≈ 0 for short-term markets):
 * d2 = ln(S/K) / (σ√T)
 */
function calculateFairValue(
  currentPrice: number,
  strikePrice: number,
  timeToExpirySec: number,
  volatility: number,
  timeframe?: string
): number {
  // Handle edge cases
  if (timeToExpirySec <= 0) {
    return currentPrice > strikePrice ? 0.99 : 0.01;
  }
  
  if (currentPrice <= 0 || strikePrice <= 0) {
    return 0.50;
  }
  
  // Apply timeframe-aware volatility adjustment
  const effectiveVol = timeframe 
    ? getEffectiveVolatility(volatility, timeframe, timeToExpirySec)
    : volatility;
  
  // Convert to annualized time
  const T = timeToExpirySec / (365 * 24 * 60 * 60);
  
  // d2 calculation (simplified, no risk-free rate for short-term)
  const logMoneyness = Math.log(currentPrice / strikePrice);
  const volSqrtT = effectiveVol * Math.sqrt(T);
  
  // Avoid division by zero for very small T
  if (volSqrtT < 0.0001) {
    return currentPrice > strikePrice ? 0.99 : 0.01;
  }
  
  const d2 = logMoneyness / volSqrtT;
  
  // Probability of finishing above strike
  const probability = normalCDF(d2);
  
  // Clamp to valid range (always leave room for trading)
  return Math.max(0.01, Math.min(0.99, probability));
}

// ============================================================================
// QUOTE CALCULATION
// ============================================================================

interface Quote {
  price: number;
  size: number;
}

interface QuoteSet {
  yesBids: Quote[];
  yesAsks: Quote[];
  noBids: Quote[];
  noAsks: Quote[];
  fairValueYes: number;
  fairValueNo: number;
  spread: number;
  skew: number;
}

/**
 * Calculate inventory skew to push toward delta neutrality
 * 
 * Positive skew = too much YES, lower all prices to attract NO buyers
 * Negative skew = too much NO, raise all prices to attract YES buyers
 */
function calculateInventorySkew(
  yesPosition: number,
  noPosition: number,
  timeRemainingPct: number,
  config: MMConfigV2
): number {
  const imbalance = yesPosition - noPosition;
  const normalizedImbalance = imbalance / config.maxImbalance;
  
  // Skew more aggressively as time runs out
  let skewMultiplier = 1.0;
  
  if (timeRemainingPct < (1 - config.criticalRebalancePct)) {
    // Critical phase (last 10%): 4x skew
    skewMultiplier = 4.0;
  } else if (timeRemainingPct < (1 - config.rebalanceStartPct)) {
    // Rebalancing phase (30-10% remaining): 2x skew
    skewMultiplier = 2.0;
  }
  
  // Max skew limited by skewFactor
  const maxSkew = config.skewFactor * 2.5;  // e.g., 0.02 * 2.5 = 0.05 (5 cents)
  const skew = normalizedImbalance * config.skewFactor * skewMultiplier;
  
  return Math.max(-maxSkew, Math.min(maxSkew, skew));
}

/**
 * Calculate dynamic spread based on conditions
 * Widens when:
 * - Fair value is extreme (high confidence = more risk)
 * - Near expiry
 * - Large inventory imbalance
 */
function calculateDynamicSpread(
  fairValue: number,
  timeRemainingPct: number,
  inventoryImbalance: number,
  config: MMConfigV2
): number {
  let spread = config.baseSpread;
  
  // Widen at extremes (far from 0.50)
  const distanceFromMid = Math.abs(fairValue - 0.50);
  if (distanceFromMid > 0.35) {
    spread *= 1.5;  // 50% wider when very confident
  } else if (distanceFromMid > 0.25) {
    spread *= 1.25;  // 25% wider when moderately confident
  }
  
  // Widen near expiry
  if (timeRemainingPct < 0.10) {
    spread *= 2.0;  // 2x spread in last 10%
  } else if (timeRemainingPct < 0.20) {
    spread *= 1.5;  // 1.5x spread in last 20%
  }
  
  // Widen with inventory imbalance
  const imbalanceRatio = Math.abs(inventoryImbalance) / config.maxImbalance;
  if (imbalanceRatio > 0.50) {
    spread *= (1 + imbalanceRatio * 0.5);  // Up to 1.5x for full imbalance
  }
  
  return Math.max(config.minSpread, Math.min(config.maxSpread, spread));
}

/**
 * Calculate dynamic size based on conditions
 * Reduces when:
 * - Fair value is extreme (higher risk)
 * - Near expiry
 * - Already have large inventory
 */
function calculateDynamicSize(
  fairValue: number,
  timeRemainingPct: number,
  currentPosition: number,
  side: 'bid' | 'ask',
  outcome: 'YES' | 'NO',
  config: MMConfigV2
): number {
  let size = config.baseSize;
  
  // Reduce at extremes
  const distanceFromMid = Math.abs(fairValue - 0.50);
  if (distanceFromMid > 0.40) {
    size *= 0.25;  // 25% size when very confident
  } else if (distanceFromMid > 0.30) {
    size *= 0.50;  // 50% size when confident
  }
  
  // Reduce near expiry
  if (timeRemainingPct < 0.10) {
    size *= 0.25;  // 25% size in last 10%
  } else if (timeRemainingPct < 0.20) {
    size *= 0.50;  // 50% size in last 20%
  }
  
  // Reduce if we're accumulating too much on one side
  const positionRatio = Math.abs(currentPosition) / config.maxPositionPerMarket;
  if (positionRatio > 0.50) {
    // If we're bidding and already long, reduce bid size
    // If we're asking and already short, reduce ask size
    const isAccumulating = (side === 'bid' && currentPosition > 0) || 
                           (side === 'ask' && currentPosition < 0);
    if (isAccumulating) {
      size *= Math.max(0.1, 1 - positionRatio);
    }
  }
  
  return Math.max(config.minSize, Math.min(config.maxSize, Math.round(size)));
}

/**
 * Determine if we should quote a specific side/outcome based on time and fair value
 * 
 * Key insight: Near expiry, stop quoting bids on the clearly losing side
 */
function shouldQuoteSide(
  fairValue: number,
  timeRemainingPct: number,
  side: 'bid' | 'ask',
  outcome: 'YES' | 'NO',
  config: MMConfigV2
): boolean {
  // Always quote if plenty of time
  if (timeRemainingPct > config.stopQuotingLoserPct) {
    return true;
  }
  
  // Near expiry, check if this is a losing side
  const isYesLosing = fairValue < 0.15;  // YES is almost certainly losing
  const isNoLosing = fairValue > 0.85;   // NO is almost certainly losing
  
  // Stop quoting BIDS on the losing outcome (don't buy more losers)
  if (side === 'bid') {
    if (outcome === 'YES' && isYesLosing) {
      return false;
    }
    if (outcome === 'NO' && isNoLosing) {
      return false;
    }
  }
  
  // Still quote asks (let people buy from us if they want)
  return true;
}

/**
 * Generate quotes using Avellaneda-Stoikov model in log-odds space.
 * 
 * This approach:
 * 1. Converts fair value to log-odds (x-space)
 * 2. Calculates reservation price (inventory-adjusted mid) in x-space
 * 3. Calculates optimal spread in x-space
 * 4. Converts back to probability space
 * 
 * Benefits:
 * - More stable math near p=0 or p=1
 * - Automatic spread compression at boundaries via S'(x)=p(1-p)
 * - Theoretically grounded inventory management
 */
function generateQuotesAS(
  fairValueYes: number,
  timeRemainingPct: number,
  timeToExpirySec: number,
  effectiveVol: number,
  yesPosition: number,
  noPosition: number,
  config: MMConfigV2,
  timeframe?: string,
  calibration?: CalibrationResult | null
): QuoteSet {
  const fairValueNo = 1 - fairValueYes;
  const inventory = yesPosition - noPosition; // Net inventory
  
  // Convert to log-odds space
  const x = probToLogOdds(fairValueYes);
  
  // A-S parameters from config
  const gamma = config.avellanedaStoikov.gamma;
  const k = config.avellanedaStoikov.k;
  
  // Get belief volatility - use calibration if available, otherwise estimate
  const volResult = getBeliefVolatility(config, calibration || null, effectiveVol, fairValueYes, timeToExpirySec);
  const sigma_b = volResult.sigma_b;
  
  // Calculate reservation price (inventory-adjusted mid)
  const r_x = calculateReservationX(x, inventory, gamma, k, timeToExpirySec);
  
  // Get market duration for normalization
  const marketDurationSec = getMarketDurationSec(timeframe || '5m');
  
  // Calculate half-spread in x-space
  let halfSpreadX = calculateHalfSpreadX(sigma_b, gamma, k, timeToExpirySec, marketDurationSec);
  
  // Ensure minimum half-spread
  halfSpreadX = Math.max(halfSpreadX, config.avellanedaStoikov.minHalfSpreadX);
  
  // Generate quotes in x-space then convert
  const yesBids: Quote[] = [];
  const yesAsks: Quote[] = [];
  
  // Boundary-aware max position
  const boundaryMaxPos = getBoundaryAwareMaxPosition(fairValueYes, config.maxPositionPerMarket);
  
  // Level spacing in x-space - smaller = tighter book
  // 0.04 ≈ 1 cent at p=0.50, scales with boundary
  const levelSpacingX = 0.04;
  
  for (let i = 0; i < config.levels; i++) {
    const levelOffsetX = i * levelSpacingX;
    
    // Check if we should quote this side
    if (shouldQuoteSide(fairValueYes, timeRemainingPct, 'bid', 'YES', config)) {
      // Bid in x-space
      const x_bid = r_x - halfSpreadX - levelOffsetX;
      const p_bid = logOddsToProb(x_bid);
      
      // Size scales with level and boundary factor
      const boundaryFactor = sigmoidDerivative(fairValueYes) / 0.25;
      let bidSize = config.baseSize * Math.pow(0.7, i) * boundaryFactor;
      
      // Reduce size if approaching position limit
      const positionUtilization = Math.abs(yesPosition) / boundaryMaxPos;
      if (positionUtilization > 0.5 && yesPosition > 0) {
        bidSize *= Math.max(0.1, 1 - positionUtilization);
      }
      
      bidSize = Math.max(config.minSize, Math.min(config.maxSize, Math.round(bidSize)));
      
      if (p_bid >= 0.01 && p_bid <= 0.98) {
        yesBids.push({
          price: Math.round(p_bid * 100) / 100,
          size: bidSize,
        });
      }
    }
    
    if (shouldQuoteSide(fairValueYes, timeRemainingPct, 'ask', 'YES', config)) {
      // Ask in x-space
      const x_ask = r_x + halfSpreadX + levelOffsetX;
      const p_ask = logOddsToProb(x_ask);
      
      // Size scales with level and boundary factor
      const boundaryFactor = sigmoidDerivative(fairValueYes) / 0.25;
      let askSize = config.baseSize * Math.pow(0.7, i) * boundaryFactor;
      
      // Reduce size if approaching position limit
      const positionUtilization = Math.abs(noPosition) / boundaryMaxPos;
      if (positionUtilization > 0.5 && noPosition > 0) {
        askSize *= Math.max(0.1, 1 - positionUtilization);
      }
      
      askSize = Math.max(config.minSize, Math.min(config.maxSize, Math.round(askSize)));
      
      if (p_ask >= 0.02 && p_ask <= 0.99) {
        yesAsks.push({
          price: Math.round(p_ask * 100) / 100,
          size: askSize,
        });
      }
    }
  }
  
  // Calculate effective spread and skew for reporting
  const p_mid = logOddsToProb(r_x);
  const spread = yesBids.length > 0 && yesAsks.length > 0
    ? yesAsks[0].price - yesBids[0].price
    : config.baseSpread;
  const skew = fairValueYes - p_mid; // How much we shifted due to inventory
  
  return {
    yesBids,
    yesAsks,
    noBids: [],
    noAsks: [],
    fairValueYes,
    fairValueNo,
    spread,
    skew,
  };
}

/**
 * Generate complete quote set for a market
 * 
 * SINGLE ORDERBOOK MODEL:
 * - Only YES quotes are generated and placed in the orderbook
 * - NO prices are derived as complements (1 - YES price) by the frontend
 * - This ensures ABOVE + BELOW always = $1.00 (no arbitrage)
 * - MM stays delta neutral: buying YES vs selling YES (which = buying NO)
 * 
 * How NO trades work:
 * - User buys NO @ $0.48 → Matches against YES BID @ $0.52
 * - User sells NO @ $0.48 → Matches against YES ASK @ $0.52
 * - Net effect: Same as trading against complement YES order
 */
function generateQuotes(
  fairValueYes: number,
  timeRemainingPct: number,
  yesPosition: number,
  noPosition: number,
  config: MMConfigV2,
  // Optional params for A-S mode
  timeToExpirySec?: number,
  effectiveVol?: number,
  timeframe?: string,
  calibration?: CalibrationResult | null
): QuoteSet {
  // Use Avellaneda-Stoikov if enabled and we have the required params
  if (config.avellanedaStoikov.enabled && timeToExpirySec !== undefined && effectiveVol !== undefined) {
    return generateQuotesAS(
      fairValueYes,
      timeRemainingPct,
      timeToExpirySec,
      effectiveVol,
      yesPosition,
      noPosition,
      config,
      timeframe,
      calibration
    );
  }
  
  // Fall back to original simple quoting
  const fairValueNo = 1 - fairValueYes;
  
  // Calculate adjustments
  const skew = calculateInventorySkew(yesPosition, noPosition, timeRemainingPct, config);
  const inventoryImbalance = yesPosition - noPosition;
  const spread = calculateDynamicSpread(fairValueYes, timeRemainingPct, inventoryImbalance, config);
  const halfSpread = spread / 2;
  
  const yesBids: Quote[] = [];
  const yesAsks: Quote[] = [];
  
  // SINGLE ORDERBOOK: Only generate YES quotes
  // NO quotes are derived by the matching engine and frontend
  for (let i = 0; i < config.levels; i++) {
    const levelOffset = i * config.levelSpacing;
    
    // YES bid (we buy YES / user sells YES / user buys NO)
    // When user buys NO @ (1-bid), they match against this YES bid
    if (shouldQuoteSide(fairValueYes, timeRemainingPct, 'bid', 'YES', config)) {
      const bidPrice = fairValueYes - halfSpread - levelOffset - skew;
      const bidSize = calculateDynamicSize(fairValueYes, timeRemainingPct, yesPosition, 'bid', 'YES', config);
      
      if (bidPrice >= 0.01 && bidPrice <= 0.98) {
        yesBids.push({
          price: Math.round(bidPrice * 100) / 100,
          size: bidSize,
        });
      }
    }
    
    // YES ask (we sell YES / user buys YES / user sells NO)
    // When user sells NO @ (1-ask), they match against this YES ask
    if (shouldQuoteSide(fairValueYes, timeRemainingPct, 'ask', 'YES', config)) {
      const askPrice = fairValueYes + halfSpread + levelOffset - skew;
      const askSize = calculateDynamicSize(fairValueYes, timeRemainingPct, -noPosition, 'ask', 'YES', config);
      
      if (askPrice >= 0.02 && askPrice <= 0.99) {
        yesAsks.push({
          price: Math.round(askPrice * 100) / 100,
          size: askSize,
        });
      }
    }
  }
  
  // NO quotes are empty - they're derived by matching engine from YES quotes
  // Frontend derives NO prices as complement: NO_ASK = 1 - YES_ASK
  
  return {
    yesBids,
    yesAsks,
    noBids: [],  // Empty - derived from YES bids
    noAsks: [],  // Empty - derived from YES asks
    fairValueYes,
    fairValueNo,
    spread,
    skew,
  };
}

// ============================================================================
// ORDER MESSAGE BUILDING
// ============================================================================

function buildOrderMessage(
  marketPubkey: PublicKey,
  side: 'BID' | 'ASK',
  outcome: 'YES' | 'NO',
  price: number,
  size: number,
  expiryTs: number,
  clientOrderId: number
): Uint8Array {
  const prefixBytes = new TextEncoder().encode(ORDER_MESSAGE_PREFIX);
  const buffer = new ArrayBuffer(81);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  
  let offset = 0;
  
  bytes.set(prefixBytes, offset);
  offset += prefixBytes.length;
  
  bytes.set(marketPubkey.toBytes(), offset);
  offset += 32;
  
  view.setUint8(offset, side === 'BID' ? 0 : 1);
  offset += 1;
  
  view.setUint8(offset, outcome === 'YES' ? 0 : 1);
  offset += 1;
  
  const priceU64 = BigInt(Math.floor(price * 1_000_000));
  view.setBigUint64(offset, priceU64, true);
  offset += 8;
  
  view.setBigUint64(offset, BigInt(Math.floor(size)), true);
  offset += 8;
  
  view.setBigInt64(offset, BigInt(expiryTs), true);
  offset += 8;
  
  view.setBigUint64(offset, BigInt(clientOrderId), true);
  
  return bytes;
}

// ============================================================================
// MARKET STATE
// ============================================================================

interface MarketState {
  id: string;
  pubkey: string;
  asset: string;
  timeframe: string;
  strike: number;
  expiryAt: number;
  createdAt: number;
  orders: Map<string, { id: string; side: 'BID' | 'ASK'; outcome: 'YES' | 'NO'; price: number; size: number }>;
  yesPosition: number;
  noPosition: number;
  lastFairValue: number;
  lastSpread: number;
  lastSkew: number;
  lastQuoteTime: number;
  lastCurrentPrice: number;
  
  // === VELOCITY TRACKING (Phase 1 - V3 Design) ===
  priceHistory: PricePoint[];      // Rolling window of price points
  lastVelocityState: VelocityState | null;
  lastQuoteDecision: QuoteDecision | null;
  quotesCurrentlyPulled: boolean;  // Track if we've pulled quotes due to velocity
  
  // === CALIBRATION TRACKING (Phase 3 - V3 Design) ===
  fairValueHistory: FairValuePoint[];  // Rolling window of fair value observations
  lastCalibration: CalibrationResult | null;
}

// ============================================================================
// MARKET MAKER BOT V2
// ============================================================================

class MarketMakerBotV2 {
  private config: MMConfigV2;
  private running: boolean = false;
  private markets: Map<string, MarketState> = new Map();
  private keypair: Keypair | null = null;
  private walletAddress: string | null = null;
  private userId: string | null = null;
  private updateInterval: NodeJS.Timeout | null = null;
  private initialized: boolean = false;
  
  // Price cache for WebSocket updates
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
  
  // Market sync cache to avoid repeated DB queries
  private marketsSyncCacheTime: number = 0;
  private marketsSyncCacheTTL: number = 5000; // 5 seconds
  
  // WebSocket connection
  private ws: WebSocket | null = null;
  private wsReconnectTimeout: NodeJS.Timeout | null = null;

  constructor(configOverrides: Partial<MMConfigV2> = {}) {
    this.config = { ...loadConfig(), ...configOverrides };
    
    const mmPrivateKey = process.env.MM_PRIVATE_KEY || process.env.MM_WALLET_PRIVATE_KEY;
    
    if (mmPrivateKey) {
      try {
        const secretKey = bs58.decode(mmPrivateKey);
        this.keypair = Keypair.fromSecretKey(secretKey);
        this.walletAddress = this.keypair.publicKey.toBase58();
        mmLogger.info(`MM Bot V2 wallet: ${this.walletAddress}`);
      } catch {
        mmLogger.warn('Invalid MM_PRIVATE_KEY, using ephemeral wallet');
        this.keypair = Keypair.generate();
        this.walletAddress = this.keypair.publicKey.toBase58();
      }
    } else {
      mmLogger.warn('No MM_PRIVATE_KEY set, using ephemeral wallet');
      this.keypair = Keypair.generate();
      this.walletAddress = this.keypair.publicKey.toBase58();
    }
    
    this.logConfig();
  }

  private logConfig(): void {
    mmLogger.info('=== MM Bot V2 Configuration ===');
    mmLogger.info(`Spread: base=${this.config.baseSpread}, min=${this.config.minSpread}, max=${this.config.maxSpread}`);
    mmLogger.info(`Size: base=${this.config.baseSize}, max=${this.config.maxSize}, levels=${this.config.levels}`);
    mmLogger.info(`Inventory: maxPos=${this.config.maxPositionPerMarket}, maxImbalance=${this.config.maxImbalance}, skewFactor=${this.config.skewFactor}`);
    mmLogger.info(`Time: updateMs=${this.config.quoteUpdateMs}, rebalanceStart=${this.config.rebalanceStartPct}, critical=${this.config.criticalRebalancePct}`);
    mmLogger.info(`Volatility: default=${this.config.defaultVolatility}, overrides=${JSON.stringify(this.config.volatilityOverrides)}`);
    mmLogger.info(`Assets: ${this.config.assets.join(', ')}`);
    mmLogger.info(`WebSocket: ${this.config.useWebSocket ? 'enabled' : 'disabled'}`);
    // Velocity config (Phase 1)
    mmLogger.info(`Velocity: enabled=${this.config.velocity.enabled}, window=${this.config.velocity.windowMs}ms, emergency=${this.config.velocity.emergencyPullEnabled}`);
    mmLogger.info(`Velocity thresholds: medium=${this.config.velocity.mediumThresholdPct * 100}%/s, high=${this.config.velocity.highThresholdPct * 100}%/s, extreme=${this.config.velocity.extremeThresholdPct * 100}%/s`);
    // A-S config (Phase 2)
    mmLogger.info(`Avellaneda-Stoikov: enabled=${this.config.avellanedaStoikov.enabled}, gamma=${this.config.avellanedaStoikov.gamma}, k=${this.config.avellanedaStoikov.k}`);
    // Calibration config (Phase 3)
    mmLogger.info(`Calibration: enabled=${this.config.calibration.enabled}, window=${this.config.calibration.windowSeconds}s, jumpSigma=${this.config.calibration.jumpThresholdSigma}`);
    mmLogger.info(`Calibration bounds: minSigma=${this.config.calibration.minSigmaB}, maxSigma=${this.config.calibration.maxSigmaB}, default=${this.config.calibration.defaultSigmaB}`);
    mmLogger.info('================================');
  }

  private async initializeUser(): Promise<boolean> {
    if (!this.walletAddress) return false;

    try {
      const user = await userService.getOrCreate(this.walletAddress);
      this.userId = user.id;
      this.initialized = true;
      mmLogger.info(`MM Bot V2 user initialized: ${this.userId}`);
      return true;
    } catch (err) {
      mmLogger.error(`Failed to initialize MM Bot V2 user: ${err}`);
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    
    mmLogger.info('MM Bot V2 starting...');
    
    if (!await this.initializeUser()) {
      mmLogger.error('MM Bot V2 failed to initialize user');
      return;
    }
    
    // Load existing positions
    await this.loadPositions();
    
    this.running = true;
    
    // Sync markets
    await this.syncMarkets();
    
    // Connect WebSocket if enabled
    if (this.config.useWebSocket) {
      this.connectWebSocket();
    }
    
    // Start quote update loop
    this.updateInterval = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.updateAllQuotes();
      } catch (err) {
        mmLogger.error(`MM V2 update error: ${err}`);
      }
    }, this.config.quoteUpdateMs);
    
    mmLogger.info(`MM Bot V2 started successfully`);
  }

  async stop(): Promise<void> {
    mmLogger.info('MM Bot V2 stopping...');
    this.running = false;
    
    // Clear update interval
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    // Close WebSocket
    this.stopWsPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    if (this.wsReconnectTimeout) {
      clearTimeout(this.wsReconnectTimeout);
      this.wsReconnectTimeout = null;
    }
    
    // Cancel all orders
    for (const marketId of this.markets.keys()) {
      await this.cancelAllOrders(marketId);
    }
    
    this.markets.clear();
    mmLogger.info('MM Bot V2 stopped');
  }

  // ============================================================================
  // WEBSOCKET HANDLING
  // ============================================================================

  private connectWebSocket(): void {
    try {
      const wsUrl = process.env.MM_WS_URL || `ws://localhost:${config.port}/ws`;
      mmLogger.info(`MM Bot V2 connecting to WebSocket: ${wsUrl}`);
      
      this.ws = new WebSocket(wsUrl);
      
      this.ws.on('open', () => {
        mmLogger.info('MM Bot V2 WebSocket connected');
        
        // Start ping interval to keep connection alive
        this.startWsPing();
        
        // Subscribe to price feeds
        this.ws?.send(JSON.stringify({
          op: 'subscribe',
          channel: 'prices',
          assets: this.config.assets,
        }));
        
        // Subscribe to market events
        for (const [marketId, state] of this.markets) {
          this.ws?.send(JSON.stringify({
            op: 'subscribe',
            channel: 'orderbook',
            market: state.pubkey,
          }));
        }
      });
      
      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          mmLogger.debug(`MM V2 WS received: ${msg.type || msg.channel || msg.op || 'unknown'}`);
          this.handleWsMessage(msg);
        } catch (err) {
          mmLogger.debug(`MM V2 WebSocket parse error: ${err}`);
        }
      });
      
      this.ws.on('close', () => {
        mmLogger.warn('MM Bot V2 WebSocket disconnected');
        this.stopWsPing();
        this.scheduleWsReconnect();
      });
      
      this.ws.on('error', (err) => {
        mmLogger.error(`MM Bot V2 WebSocket error: ${err.message}`);
      });
      
    } catch (err) {
      mmLogger.error(`Failed to connect WebSocket: ${err}`);
      this.scheduleWsReconnect();
    }
  }

  private scheduleWsReconnect(): void {
    if (!this.running) return;
    
    if (this.wsReconnectTimeout) {
      clearTimeout(this.wsReconnectTimeout);
    }
    
    this.wsReconnectTimeout = setTimeout(() => {
      if (this.running) {
        mmLogger.info('MM Bot V2 attempting WebSocket reconnect...');
        this.connectWebSocket();
      }
    }, this.config.wsReconnectMs);
  }

  // Ping interval for WebSocket keepalive
  private wsPingInterval: NodeJS.Timeout | null = null;
  
  private startWsPing(): void {
    // Clear any existing ping interval
    if (this.wsPingInterval) {
      clearInterval(this.wsPingInterval);
    }
    
    // Send ping every 25 seconds (server timeout is 60s)
    this.wsPingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, 25000);
  }
  
  private stopWsPing(): void {
    if (this.wsPingInterval) {
      clearInterval(this.wsPingInterval);
      this.wsPingInterval = null;
    }
  }

  private handleWsMessage(msg: any): void {
    // Handle both channel-based and type-based messages
    const channel = msg.channel || '';
    const type = msg.type || '';
    
    if (channel === 'prices' || type === 'price_update') {
      this.onPriceUpdate(msg.data);
    } else if (channel === 'orderbook') {
      // Could be used to track competition, but not essential
    } else if (channel === 'user') {
      if (msg.event === 'fill') {
        this.onWsFill(msg.data);
      }
    }
  }

  private onPriceUpdate(data: { asset: string; price: number; timestamp?: number }): void {
    if (!data) return;
    
    const { asset, price } = data;
    if (!asset || typeof price !== 'number') return;
    
    const now = Date.now();
    
    // Update price cache
    this.priceCache.set(asset, {
      price,
      timestamp: now,
    });
    
    // Trigger immediate quote update for affected markets
    for (const [marketId, state] of this.markets) {
      if (state.asset === asset) {
        const lastPrice = state.lastCurrentPrice || price;
        const priceDiff = Math.abs(price - lastPrice) / lastPrice;
        
        // === VELOCITY TRACKING (Phase 1) ===
        // Add to price history
        state.priceHistory.push({ price, timestamp: now });
        
        // Trim old history (keep last N entries based on config)
        const maxHistory = this.config.velocity.historySize;
        if (state.priceHistory.length > maxHistory) {
          state.priceHistory = state.priceHistory.slice(-maxHistory);
        }
        
        // Calculate velocity state if we have enough data
        if (state.priceHistory.length >= 3 && this.config.velocity.enabled) {
          const timeToExpiry = state.expiryAt - now;
          const volatility = this.config.volatilityOverrides[state.asset] || this.config.defaultVolatility;
          
          // Calculate fair value for velocity assessment (with timeframe adjustment)
          const fairValue = calculateFairValue(
            price,
            state.strike,
            timeToExpiry / 1000,
            volatility,
            state.timeframe
          );
          
          const velocityState = calculateVelocityState(
            state.priceHistory,
            price,
            state.strike,
            fairValue,
            timeToExpiry / 1000,
            this.config
          );
          
          state.lastVelocityState = velocityState;
          
          // === EMERGENCY QUOTE PULL (Sub-cycle) ===
          if (this.config.velocity.emergencyPullEnabled && 
              velocityState.urgency === 'EXTREME' && 
              velocityState.hurtingSide !== 'NEITHER') {
            
            mmLogger.warn(
              `🚨 [VELOCITY] EXTREME ${state.asset}-${state.timeframe}: ` +
              `vel=${(velocityState.priceVelocityPct * 100).toFixed(3)}%/s, ` +
              `hurting=${velocityState.hurtingSide}, ` +
              `price=$${price.toFixed(2)}, strike=$${state.strike}`
            );
            
            // Emergency pull - cancel orders on hurting side IMMEDIATELY
            this.emergencyPullQuotes(marketId, velocityState.hurtingSide).catch(err => {
              mmLogger.debug(`Emergency pull failed: ${err.message}`);
            });
          }
          
          // Log significant velocity changes
          const prevUrgency = state.lastQuoteDecision?.reason?.includes('EXTREME') ? 'EXTREME' :
                             state.lastQuoteDecision?.reason?.includes('HIGH') ? 'HIGH' :
                             state.lastQuoteDecision?.reason?.includes('MEDIUM') ? 'MEDIUM' : 'LOW';
          
          if (velocityState.urgency !== prevUrgency && velocityState.urgency !== 'LOW') {
            mmLogger.info(
              `⚡ [VELOCITY] ${state.asset}-${state.timeframe}: ` +
              `${prevUrgency} → ${velocityState.urgency}, ` +
              `vel=${(velocityState.priceVelocityPct * 100).toFixed(3)}%/s, ` +
              `hurting=${velocityState.hurtingSide}`
            );
          }
        }
        
        // CRITICAL: Detect strike crossing - this flips the fair value dramatically
        const crossedStrike = (lastPrice < state.strike && price >= state.strike) ||
                              (lastPrice >= state.strike && price < state.strike);
        
        if (crossedStrike) {
          mmLogger.info(`⚡ STRIKE CROSSED: ${asset} ${lastPrice.toFixed(2)} → ${price.toFixed(2)} (strike: ${state.strike})`);
        }
        
        // Update on ANY price change or strike crossing
        if (priceDiff > 0.00005 || crossedStrike || lastPrice === 0) {
          this.updateQuotesForMarket(marketId).catch(err => {
            mmLogger.debug(`Failed to update quotes for ${marketId}: ${err.message}`);
          });
        }
      }
    }
  }

  /**
   * Emergency pull quotes on a specific side due to extreme velocity.
   * This is called IMMEDIATELY on price updates, not waiting for the quote cycle.
   */
  private async emergencyPullQuotes(marketId: string, hurtingSide: HurtingSide): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state || !this.userId) return;
    
    // Already pulled? Don't spam
    if (state.quotesCurrentlyPulled) return;
    state.quotesCurrentlyPulled = true;
    
    const ordersToCancel: string[] = [];
    
    for (const [orderId, order] of state.orders) {
      // YES hurting = pull YES BIDS (don't buy dying YES)
      // NO hurting = pull YES ASKS (don't sell winning YES cheap)
      const shouldPull = 
        (hurtingSide === 'YES' && order.side === 'BID' && order.outcome === 'YES') ||
        (hurtingSide === 'NO' && order.side === 'ASK' && order.outcome === 'YES');
      
      if (shouldPull) {
        ordersToCancel.push(orderId);
      }
    }
    
    if (ordersToCancel.length > 0) {
      mmLogger.warn(
        `🚨 [EMERGENCY PULL] ${state.asset}-${state.timeframe}: ` +
        `Cancelling ${ordersToCancel.length} orders (${hurtingSide} hurting)`
      );
      
      await this.cancelOrdersById(marketId, new Set(ordersToCancel));
    }
  }

  private onWsFill(data: any): void {
    // Update position tracking based on WebSocket fill notification
    const { marketAddress, outcome, side, filledSize } = data;
    
    for (const [marketId, state] of this.markets) {
      if (state.pubkey === marketAddress) {
        const size = parseFloat(filledSize) || 0;
        
        if (side === 'bid') {
          // We bought
          if (outcome === 'yes') {
            state.yesPosition += size;
          } else {
            state.noPosition += size;
          }
        } else {
          // We sold (which means we received the opposite)
          if (outcome === 'yes') {
            state.noPosition += size;
          } else {
            state.yesPosition += size;
          }
        }
        
        mmLogger.debug(`MM V2 position update: ${state.asset} YES=${state.yesPosition}, NO=${state.noPosition}`);
        break;
      }
    }
  }

  // ============================================================================
  // POSITION MANAGEMENT
  // ============================================================================

  private async loadPositions(): Promise<void> {
    if (!this.userId) return;
    
    try {
      const positions = await positionService.getByUser(this.userId);
      
      for (const pos of positions) {
        const yesShares = parseFloat(pos.yesShares || '0');
        const noShares = parseFloat(pos.noShares || '0');
        
        // Will be applied when market is synced
        mmLogger.debug(`Loaded position for market ${pos.marketId}: YES=${yesShares}, NO=${noShares}`);
      }
    } catch (err) {
      mmLogger.error(`Failed to load positions: ${err}`);
    }
  }

  // ============================================================================
  // MARKET SYNC
  // ============================================================================

  async syncMarkets(): Promise<void> {
    // Use cache to avoid hammering DB on every quote cycle
    const now = Date.now();
    if (now - this.marketsSyncCacheTime < this.marketsSyncCacheTTL) {
      return; // Skip sync, use existing market state
    }
    this.marketsSyncCacheTime = now;
    
    const activeMarkets = await marketService.getMarkets({ status: 'OPEN' });
    
    // Filter to configured assets AND only activated markets (strikePrice > 0)
    // Markets with strikePrice = '0' are pending activation and shouldn't be quoted
    // Also skip 24h markets for testing static orderbook behavior
    const SKIP_TIMEFRAMES = ['24h']; // Timeframes to skip for static orderbook testing
    
    const filteredMarkets = activeMarkets.filter(m => {
      const hasValidStrike = parseFloat(m.strikePrice) > 0;
      const isConfiguredAsset = this.config.assets.length === 0 || this.config.assets.includes(m.asset);
      const isSkippedTimeframe = SKIP_TIMEFRAMES.includes(m.timeframe);
      
      if (!hasValidStrike) {
        mmLogger.debug(`Skipping pending market ${m.asset}-${m.timeframe} (strikePrice=0)`);
      }
      
      if (isSkippedTimeframe) {
        mmLogger.debug(`Skipping ${m.asset}-${m.timeframe} (timeframe in skip list for static testing)`);
      }
      
      return hasValidStrike && isConfiguredAsset && !isSkippedTimeframe;
    });
    
    for (const market of filteredMarkets) {
      if (!this.markets.has(market.id)) {
        // Load position for this market
        let yesPos = 0;
        let noPos = 0;
        
        if (this.userId) {
          try {
            const position = await positionService.getPosition(this.userId, market.id);
            if (position) {
              yesPos = parseFloat(position.yesShares || '0');
              noPos = parseFloat(position.noShares || '0');
            }
          } catch {}
        }
        
        this.markets.set(market.id, {
          id: market.id,
          pubkey: market.pubkey,
          asset: market.asset,
          timeframe: market.timeframe,
          strike: parseFloat(market.strikePrice),
          expiryAt: market.expiryAt.getTime(),
          createdAt: market.createdAt.getTime(),
          orders: new Map(),
          yesPosition: yesPos,
          noPosition: noPos,
          lastFairValue: 0.50,
          lastSpread: this.config.baseSpread,
          lastSkew: 0,
          lastQuoteTime: 0,
          lastCurrentPrice: 0,
          // Velocity tracking (Phase 1)
          priceHistory: [],
          lastVelocityState: null,
          lastQuoteDecision: null,
          quotesCurrentlyPulled: false,
          // Calibration tracking (Phase 3)
          fairValueHistory: [],
          lastCalibration: null,
        });
        
        mmLogger.info(`MM V2 tracking: ${market.asset}-${market.timeframe} strike=$${parseFloat(market.strikePrice).toFixed(2)}, pos=(YES=${yesPos}, NO=${noPos})`);
      }
    }
    
    // Remove markets no longer active
    for (const [id, state] of this.markets) {
      if (!filteredMarkets.find(m => m.id === id)) {
        await this.cancelAllOrders(id);
        this.markets.delete(id);
        mmLogger.info(`MM V2 stopped tracking: ${state.asset}-${state.timeframe}`);
      }
    }
  }

  // ============================================================================
  // QUOTE UPDATES
  // ============================================================================

  async updateAllQuotes(): Promise<void> {
    await this.syncMarkets();
    
    for (const [marketId, state] of this.markets) {
      if (!this.running) break;
      
      try {
        await this.updateQuotesForMarket(marketId);
      } catch (err) {
        mmLogger.debug(`MM V2 quote update failed for ${state.asset}: ${(err as Error).message}`);
      }
    }
  }

  private async updateQuotesForMarket(marketId: string): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state) return;
    
    const now = Date.now();
    const timeToExpiry = state.expiryAt - now;
    const marketDuration = state.expiryAt - state.createdAt;
    const timeRemainingPct = Math.max(0, timeToExpiry / marketDuration);
    
    // Stop quoting near expiry
    if (timeToExpiry < this.config.closeBeforeExpiryMs) {
      await this.cancelAllOrders(marketId);
      return;
    }
    
    // Get current price (from cache or fetch)
    let currentPrice: number;
    const cachedPrice = this.priceCache.get(state.asset);
    
    // Use price cache with very short staleness (500ms) for fast updates
    if (cachedPrice && (now - cachedPrice.timestamp) < 500) {
      currentPrice = cachedPrice.price;
    } else {
      const priceData = await priceFeedService.getPrice(state.asset);
      currentPrice = priceData?.price ?? state.strike;
      
      this.priceCache.set(state.asset, {
        price: currentPrice,
        timestamp: now,
      });
    }
    
    state.lastCurrentPrice = currentPrice;
    
    // Get volatility for this asset
    const volatility = this.config.volatilityOverrides[state.asset] || this.config.defaultVolatility;
    
    // Calculate fair value using Black-Scholes (with timeframe-aware volatility)
    const effectiveVol = getEffectiveVolatility(volatility, state.timeframe, timeToExpiry / 1000);
    const fairValue = calculateFairValue(
      currentPrice,
      state.strike,
      timeToExpiry / 1000,
      volatility,
      state.timeframe
    );
    
    // Log significant fair value changes
    const previousFV = state.lastFairValue;
    const fairValueChanged = Math.abs(fairValue - (previousFV || 0.5)) > 0.01;
    if (fairValueChanged) {
      mmLogger.info(`MM V2 ${state.asset} ${state.timeframe}: FV=${fairValue.toFixed(3)} (BTC=$${currentPrice.toFixed(0)}, strike=$${state.strike}, TTX=${(timeToExpiry/1000).toFixed(0)}s, effVol=${(effectiveVol*100).toFixed(1)}%)`);
    }
    
    state.lastFairValue = fairValue;
    
    // === FAIR VALUE HISTORY & CALIBRATION (Phase 3) ===
    // Track fair value history for calibration
    const fvPoint: FairValuePoint = {
      fairValue,
      logOdds: probToLogOdds(fairValue),
      timestamp: now,
      price: currentPrice,
    };
    state.fairValueHistory.push(fvPoint);
    
    // Prune old fair value history (keep 5 min window + buffer)
    const calibrationWindowMs = this.config.calibration.windowSeconds * 1000;
    const fvPruneThreshold = now - calibrationWindowMs * 1.5;
    state.fairValueHistory = state.fairValueHistory.filter(p => p.timestamp > fvPruneThreshold);
    
    // Run calibration if enabled
    if (this.config.calibration.enabled) {
      const calibration = calibrateBeliefDynamics(
        state.fairValueHistory,
        this.config,
        timeToExpiry / 1000
      );
      state.lastCalibration = calibration;
      
      // Log calibration updates periodically (every ~10 seconds based on sample count change)
      const prevSamples = state.lastCalibration?.sampleCount || 0;
      if (calibration.sampleCount >= 20 && calibration.sampleCount % 40 === 0 && calibration.sampleCount !== prevSamples) {
        mmLogger.info(`[CALIBRATION] ${state.asset}-${state.timeframe}: σ_b=${calibration.sigma_b.toFixed(3)} conf=${calibration.confidence} samples=${calibration.sampleCount} jumps=${calibration.jumpCount} λ=${calibration.lambda.toFixed(1)}/hr`);
      }
    }
    
    // === VELOCITY-BASED QUOTE DECISION (Phase 1) ===
    let quoteDecision: QuoteDecision | null = null;
    
    if (this.config.velocity.enabled && state.lastVelocityState) {
      quoteDecision = makeVelocityQuoteDecision(
        state.lastVelocityState,
        fairValue,
        { yes: state.yesPosition, no: state.noPosition },
        timeToExpiry / 1000,
        this.config
      );
      
      state.lastQuoteDecision = quoteDecision;
      
      // Log decision changes
      if (quoteDecision.reason !== state.lastQuoteDecision?.reason) {
        mmLogger.info(`[VELOCITY DECISION] ${state.asset}-${state.timeframe}: ${quoteDecision.reason}`);
      }
    }
    
    // Reset pulled flag on normal quote cycle
    state.quotesCurrentlyPulled = false;
    
    // Generate quotes with all adjustments
    // Pass extra params for A-S mode (Phase 2) and calibration (Phase 3)
    const quotes = generateQuotes(
      fairValue,
      timeRemainingPct,
      state.yesPosition,
      state.noPosition,
      this.config,
      timeToExpiry / 1000,  // timeToExpirySec for A-S
      effectiveVol,         // effectiveVol for A-S
      state.timeframe,      // timeframe for A-S
      state.lastCalibration // calibration for A-S (Phase 3)
    );
    
    // Apply velocity-based adjustments to quotes
    if (quoteDecision) {
      // Apply spread multiplier
      const spreadMultiplier = quoteDecision.yes.spreadMultiplier;
      if (spreadMultiplier !== 1.0) {
        const adjustedHalfSpread = (quotes.spread * spreadMultiplier) / 2;
        const fairMid = fairValue;
        
        // Recalculate bid/ask prices with wider spread
        for (let i = 0; i < quotes.yesBids.length; i++) {
          const levelOffset = i * this.config.levelSpacing;
          quotes.yesBids[i].price = Math.max(0.01, Math.round((fairMid - adjustedHalfSpread - levelOffset - quotes.skew) * 100) / 100);
        }
        for (let i = 0; i < quotes.yesAsks.length; i++) {
          const levelOffset = i * this.config.levelSpacing;
          quotes.yesAsks[i].price = Math.min(0.99, Math.round((fairMid + adjustedHalfSpread + levelOffset - quotes.skew) * 100) / 100);
        }
        quotes.spread = quotes.spread * spreadMultiplier;
      }
      
      // Apply size multiplier
      const sizeMultiplier = quoteDecision.yes.sizeMultiplier;
      if (sizeMultiplier !== 1.0) {
        for (const bid of quotes.yesBids) {
          bid.size = Math.max(this.config.minSize, Math.round(bid.size * sizeMultiplier));
        }
        for (const ask of quotes.yesAsks) {
          ask.size = Math.max(this.config.minSize, Math.round(ask.size * sizeMultiplier));
        }
      }
      
      // Remove quotes based on decision
      if (!quoteDecision.yes.shouldQuoteBids) {
        quotes.yesBids = [];
      }
      if (!quoteDecision.yes.shouldQuoteAsks) {
        quotes.yesAsks = [];
      }
    }
    
    state.lastSpread = quotes.spread;
    state.lastSkew = quotes.skew;
    state.lastQuoteTime = now;
    
    // Only update market prices in database when there's a meaningful change
    // This reduces DB load significantly (was updating every 100-250ms regardless)
    const priceDelta = Math.abs(fairValue - (previousFV || 0.5));
    if (priceDelta > 0.001) {  // More than 0.1 cent change
    try {
      await marketService.updatePrices(marketId, fairValue, 1 - fairValue);
    } catch {}
    }
    
    // Update orders
    await this.updateMarketOrders(marketId, quotes);
  }

  private async updateMarketOrders(marketId: string, quotes: QuoteSet): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state) return;
    
    // IMPORTANT: Place new orders FIRST, then cancel old ones
    // This eliminates the "empty orderbook" window that causes UI flickering
    // Users always see liquidity instead of a brief empty state
    
    // 1. Capture OLD order IDs to cancel later
    const oldOrderIds = new Set(state.orders.keys());
    
    // 2. Place new orders - SINGLE ORDERBOOK: Only place YES orders
    // NO orders are derived by the matching engine when users trade NO
    for (const bid of quotes.yesBids) {
      await this.placeOrder(marketId, 'BID', 'YES', bid.price, bid.size);
    }
    for (const ask of quotes.yesAsks) {
      await this.placeOrder(marketId, 'ASK', 'YES', ask.price, ask.size);
    }
    // NO orders removed - they're derived from YES orders by matching engine
    
    // 3. Cancel OLD orders (now the book still has new orders for liquidity)
    await this.cancelOrdersById(marketId, oldOrderIds);
    
    // 4. Broadcast orderbook updates - only YES orderbook is real
    // Frontend derives NO prices as complements (1 - YES price)
    try {
      const yesSnapshot = await orderbookService.getSnapshot(marketId, 'YES');
      
      // Broadcast YES orderbook (the only real orderbook)
      broadcastOrderbookUpdate(
        state.pubkey,
        yesSnapshot.bids.map(l => [l.price, l.size] as [number, number]),
        yesSnapshot.asks.map(l => [l.price, l.size] as [number, number]),
        yesSnapshot.sequenceId,
        'YES'
      );
      
      // NO orderbook broadcast removed - frontend derives from YES
    } catch {}
  }

  // ============================================================================
  // ORDER PLACEMENT
  // ============================================================================

  private async placeOrder(
    marketId: string,
    side: 'BID' | 'ASK',
    outcome: 'YES' | 'NO',
    price: number,
    size: number
  ): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state || !this.userId || !this.keypair || !this.initialized) return;
    
    // Validate price
    if (price < 0.01 || price > 0.99) {
      return;
    }
    
    // Validate size
    if (size < this.config.minSize) {
      return;
    }
    
    try {
      const expiryTs = Math.floor(state.expiryAt / 1000);
      const onChainMarketPda = getMarketPda(state.asset, state.timeframe, expiryTs);
      
      const clientOrderId = Date.now() + Math.floor(Math.random() * 1000);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const orderExpiryTs = Math.floor(expiresAt.getTime() / 1000);
      
      const binaryMessage = buildOrderMessage(
        onChainMarketPda,
        side,
        outcome,
        price,
        size,
        orderExpiryTs,
        clientOrderId
      );
      
      const signature = bs58.encode(nacl.sign.detached(binaryMessage, this.keypair.secretKey));
      const binaryMessageBase64 = Buffer.from(binaryMessage).toString('base64');

      const order = config.disableMmOrderPersistence
        ? ({ id: randomUUID() } as any)
        : await orderService.create({
            clientOrderId,
            marketId,
            userId: this.userId,
            side,
            outcome,
            orderType: 'LIMIT',
            price: price.toString(),
            size: size.toString(),
            signature,
            encodedInstruction: null,
            isMmOrder: true,
            expiresAt,
          });
      
      const orderbookOrder = {
        id: order.id,
        marketId,
        userId: this.userId,
        side,
        outcome,
        price,
        size,
        remainingSize: size,
        createdAt: Date.now(),
        clientOrderId,
        expiresAt: expiresAt.getTime(),
        signature,
        binaryMessage: binaryMessageBase64,
      };
      
      const result = await matchingService.processOrder(orderbookOrder);
      
      if (result.addedToBook) {
        state.orders.set(order.id, { id: order.id, side, outcome, price, size });
        mmLogger.debug(
          `[MM] Added to book: ${side} ${outcome} @ $${price.toFixed(2)}`
        );
      } else {
        // DEBUG: Log when order was NOT added - this helps diagnose price mismatch
        mmLogger.warn(
          `[MM] NOT added to book: ${side} ${outcome} @ $${price.toFixed(2)} ` +
          `(fills=${result.fills.length}, seq=${result.sequenceId})`
        );
      }
      
      // Track fills
      for (const fill of result.fills) {
        this.onFill({ marketId, side, outcome, size: fill.size });
      }
      
      // Log order
      mmLogger.orderPlaced(`MM V2: ${side} ${outcome} ${size} @ ${price}`, {
        orderId: order.id,
        marketId,
        asset: state.asset,
        timeframe: state.timeframe,
        side,
        outcome,
        price,
        size,
        fairValue: state.lastFairValue,
        spread: state.lastSpread,
        skew: state.lastSkew,
        fills: result.fills.length,
        addedToBook: result.addedToBook,
        event: 'MM_V2_ORDER_PLACED',
      });
    } catch (err) {
      mmLogger.debug(`MM V2 order placement failed: ${(err as Error).message}`);
    }
  }

  private async cancelAllOrders(marketId: string): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state) return;
    
    await this.cancelOrdersById(marketId, new Set(state.orders.keys()));
  }

  /**
   * Cancel specific orders by ID
   * Used by updateMarketOrders to cancel OLD orders after NEW orders are placed
   * This prevents the empty-book race condition
   * 
   * OPTIMIZED: Uses batch DB operation instead of sequential cancels
   */
  private async cancelOrdersById(marketId: string, orderIds: Set<string>): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state || orderIds.size === 0) return;
    
    // Collect orders to remove from orderbook (in-memory ops are fast)
    const ordersToRemove: Array<{
      id: string;
      side: 'BID' | 'ASK';
      outcome: 'YES' | 'NO';
      price: number;
      size: number;
    }> = [];
    
    for (const orderId of orderIds) {
        const o = state.orders.get(orderId);
      if (o) {
        ordersToRemove.push(o);
        state.orders.delete(orderId);
      }
    }
    
    // Remove from orderbook (in-memory) - fast, no DB
    if (this.userId) {
      for (const o of ordersToRemove) {
        try {
          await orderbookService.removeOrder({
            id: o.id,
            marketId,
            userId: this.userId,
            side: o.side,
            outcome: o.outcome,
            price: o.price,
            size: o.size,
            remainingSize: o.size,
            createdAt: Date.now(),
          });
        } catch {}
      }
    }

    // Batch cancel in DB (single query instead of N queries)
    if (!config.disableMmOrderPersistence && ordersToRemove.length > 0) {
      try {
        await orderService.cancelBatch(ordersToRemove.map(o => o.id), 'MM_CANCEL');
      } catch (err) {
        mmLogger.debug(`Batch cancel failed: ${(err as Error).message}`);
        }
    }
  }

  private onFill(fill: { marketId: string; side: 'BID' | 'ASK'; outcome: 'YES' | 'NO'; size: number }): void {
    const state = this.markets.get(fill.marketId);
    if (!state) return;
    
    if (fill.side === 'BID') {
      // We bought
      if (fill.outcome === 'YES') state.yesPosition += fill.size;
      else state.noPosition += fill.size;
    } else {
      // We "sold" (received opposite)
      if (fill.outcome === 'YES') state.noPosition += fill.size;
      else state.yesPosition += fill.size;
    }
    
    mmLogger.fill(`MM V2 fill: ${fill.side} ${fill.size} ${fill.outcome}`, {
      marketId: fill.marketId,
      asset: state.asset,
      timeframe: state.timeframe,
      yesPosition: state.yesPosition,
      noPosition: state.noPosition,
      imbalance: state.yesPosition - state.noPosition,
      event: 'MM_V2_FILL',
    });
  }

  // ============================================================================
  // STATUS & MONITORING
  // ============================================================================

  getStatus() {
    const now = Date.now();
    const marketDetails = Array.from(this.markets.values()).map(state => {
      const timeToExpiry = state.expiryAt - now;
      const marketDuration = state.expiryAt - state.createdAt;
      const timeRemainingPct = Math.max(0, timeToExpiry / marketDuration);
      
      // Velocity info (Phase 1)
      const velocityInfo = state.lastVelocityState ? {
        priceVelocity: state.lastVelocityState.priceVelocity,
        priceVelocityPct: state.lastVelocityState.priceVelocityPct,
        urgency: state.lastVelocityState.urgency,
        hurtingSide: state.lastVelocityState.hurtingSide,
        movingAwayFromStrike: state.lastVelocityState.movingAwayFromStrike,
      } : null;
      
      const quoteDecisionInfo = state.lastQuoteDecision ? {
        reason: state.lastQuoteDecision.reason,
        yesBidsEnabled: state.lastQuoteDecision.yes.shouldQuoteBids,
        yesAsksEnabled: state.lastQuoteDecision.yes.shouldQuoteAsks,
        spreadMultiplier: state.lastQuoteDecision.yes.spreadMultiplier,
        sizeMultiplier: state.lastQuoteDecision.yes.sizeMultiplier,
      } : null;
      
      // Calibration info (Phase 3)
      const calibrationInfo = state.lastCalibration ? {
        sigma_b: state.lastCalibration.sigma_b,
        confidence: state.lastCalibration.confidence,
        sampleCount: state.lastCalibration.sampleCount,
        diffusionCount: state.lastCalibration.diffusionCount,
        jumpCount: state.lastCalibration.jumpCount,
        lambda: state.lastCalibration.lambda,
      } : null;
      
      return {
        id: state.id,
        asset: state.asset,
        timeframe: state.timeframe,
        strike: state.strike,
        currentPrice: state.lastCurrentPrice,
        fairValueYes: state.lastFairValue,
        fairValueNo: 1 - state.lastFairValue,
        spread: state.lastSpread,
        skew: state.lastSkew,
        yesPosition: state.yesPosition,
        noPosition: state.noPosition,
        imbalance: state.yesPosition - state.noPosition,
        orderCount: state.orders.size,
        secondsToExpiry: Math.round(timeToExpiry / 1000),
        timeRemainingPct: Math.round(timeRemainingPct * 100),
        // Velocity info (Phase 1)
        velocity: velocityInfo,
        quoteDecision: quoteDecisionInfo,
        quotesCurrentlyPulled: state.quotesCurrentlyPulled,
        // Calibration info (Phase 3)
        calibration: calibrationInfo,
      };
    });
    
    const totalImbalance = marketDetails.reduce((sum, m) => sum + Math.abs(m.imbalance), 0);
    
    return {
      version: 'v2+velocity',
      running: this.running,
      initialized: this.initialized,
      wsConnected: this.ws?.readyState === WebSocket.OPEN,
      markets: this.markets.size,
      totalOrders: marketDetails.reduce((sum, m) => sum + m.orderCount, 0),
      totalImbalance,
      wallet: this.walletAddress,
      userId: this.userId,
      config: {
        baseSpread: this.config.baseSpread,
        baseSize: this.config.baseSize,
        levels: this.config.levels,
        maxImbalance: this.config.maxImbalance,
        skewFactor: this.config.skewFactor,
        volatility: this.config.defaultVolatility,
        updateMs: this.config.quoteUpdateMs,
        // Velocity config (Phase 1)
        velocityEnabled: this.config.velocity.enabled,
        velocityWindowMs: this.config.velocity.windowMs,
        velocityEmergencyPull: this.config.velocity.emergencyPullEnabled,
        velocityThresholds: {
          medium: this.config.velocity.mediumThresholdPct,
          high: this.config.velocity.highThresholdPct,
          extreme: this.config.velocity.extremeThresholdPct,
        },
        // A-S config (Phase 2)
        avellanedaStoikov: {
          enabled: this.config.avellanedaStoikov.enabled,
          gamma: this.config.avellanedaStoikov.gamma,
          k: this.config.avellanedaStoikov.k,
        },
      },
      marketDetails,
    };
  }

  async getQuoteInfo(marketId: string) {
    const state = this.markets.get(marketId);
    if (!state) return null;
    
    const now = Date.now();
    const timeToExpiry = state.expiryAt - now;
    const marketDuration = state.expiryAt - state.createdAt;
    const timeRemainingPct = Math.max(0, timeToExpiry / marketDuration);
    
    // Get fresh price
    const priceData = await priceFeedService.getPrice(state.asset);
    const currentPrice = priceData?.price || state.lastCurrentPrice;
    
    // Calculate fair value (with timeframe-aware volatility)
    const volatility = this.config.volatilityOverrides[state.asset] || this.config.defaultVolatility;
    const effectiveVol = getEffectiveVolatility(volatility, state.timeframe, timeToExpiry / 1000);
    const fairValue = calculateFairValue(
      currentPrice,
      state.strike,
      timeToExpiry / 1000,
      volatility,
      state.timeframe
    );
    
    // Generate quotes for inspection (pass calibration if available)
    const quotes = generateQuotes(
      fairValue,
      timeRemainingPct,
      state.yesPosition,
      state.noPosition,
      this.config,
      timeToExpiry / 1000,
      effectiveVol,
      state.timeframe,
      state.lastCalibration
    );
    
    // Get belief volatility info for display
    const volResult = getBeliefVolatility(
      this.config,
      state.lastCalibration,
      effectiveVol,
      fairValue,
      timeToExpiry / 1000
    );
    
    return {
      fairValueYes: fairValue,
      fairValueNo: 1 - fairValue,
      currentPrice,
      strike: state.strike,
      volatility,
      effectiveVolatility: effectiveVol,
      timeToExpirySeconds: Math.round(timeToExpiry / 1000),
      timeRemainingPct: Math.round(timeRemainingPct * 100),
      spread: quotes.spread,
      skew: quotes.skew,
      yesPosition: state.yesPosition,
      noPosition: state.noPosition,
      imbalance: state.yesPosition - state.noPosition,
      quotes: {
        yesBids: quotes.yesBids,
        yesAsks: quotes.yesAsks,
        noBids: quotes.noBids,
        noAsks: quotes.noAsks,
      },
      // Phase 3: Calibration info
      calibration: state.lastCalibration ? {
        sigma_b: state.lastCalibration.sigma_b,
        confidence: state.lastCalibration.confidence,
        sampleCount: state.lastCalibration.sampleCount,
        jumpCount: state.lastCalibration.jumpCount,
        lambda: state.lastCalibration.lambda,
        source: volResult.source,
      } : null,
    };
  }

  /**
   * Get the MM bot's user ID (for metrics tracking)
   */
  getUserId(): string | null {
    return this.userId;
  }

  /**
   * Get the MM bot's wallet address
   */
  getWalletAddress(): string | null {
    return this.walletAddress;
  }
}

// Export singleton instance
export const mmBotV2 = new MarketMakerBotV2();

// Also export class for testing
export { MarketMakerBotV2 };

