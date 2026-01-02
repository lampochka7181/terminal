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
    closeBeforeExpiryMs: parseInt(process.env.MM_CLOSE_BEFORE_EXPIRY_MS || '5000'),
    stopQuotingLoserPct: parseFloat(process.env.MM_STOP_QUOTING_LOSER_PCT || '0.10'),
    
    // Volatility (annualized)
    defaultVolatility: parseFloat(process.env.MM_DEFAULT_VOLATILITY || '0.50'),
    volatilityOverrides: JSON.parse(process.env.MM_VOLATILITY_OVERRIDES || '{}'),
    
    // Assets
    assets: (process.env.MM_ASSETS || 'BTC').split(',').map(s => s.trim()),
    
    // WebSocket
    useWebSocket: process.env.MM_USE_WEBSOCKET !== 'false',
    wsReconnectMs: parseInt(process.env.MM_WS_RECONNECT_MS || '5000'),
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
  volatility: number
): number {
  // Handle edge cases
  if (timeToExpirySec <= 0) {
    return currentPrice > strikePrice ? 0.99 : 0.01;
  }
  
  if (currentPrice <= 0 || strikePrice <= 0) {
    return 0.50;
  }
  
  // Convert to annualized time
  const T = timeToExpirySec / (365 * 24 * 60 * 60);
  
  // d2 calculation (simplified, no risk-free rate for short-term)
  const logMoneyness = Math.log(currentPrice / strikePrice);
  const volSqrtT = volatility * Math.sqrt(T);
  
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
 * Generate complete quote set for a market
 */
function generateQuotes(
  fairValueYes: number,
  timeRemainingPct: number,
  yesPosition: number,
  noPosition: number,
  config: MMConfigV2
): QuoteSet {
  const fairValueNo = 1 - fairValueYes;
  
  // Calculate adjustments
  const skew = calculateInventorySkew(yesPosition, noPosition, timeRemainingPct, config);
  const inventoryImbalance = yesPosition - noPosition;
  const spread = calculateDynamicSpread(fairValueYes, timeRemainingPct, inventoryImbalance, config);
  const halfSpread = spread / 2;
  
  const yesBids: Quote[] = [];
  const yesAsks: Quote[] = [];
  const noBids: Quote[] = [];
  const noAsks: Quote[] = [];
  
  // Generate YES quotes
  for (let i = 0; i < config.levels; i++) {
    const levelOffset = i * config.levelSpacing;
    
    // YES bid (we buy YES)
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
    
    // YES ask (we sell YES = buy NO from counterparty perspective)
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
  
  // Generate NO quotes (complementary to YES)
  for (let i = 0; i < config.levels; i++) {
    const levelOffset = i * config.levelSpacing;
    
    // NO bid (we buy NO)
    if (shouldQuoteSide(fairValueYes, timeRemainingPct, 'bid', 'NO', config)) {
      const bidPrice = fairValueNo - halfSpread - levelOffset + skew;  // Opposite skew direction
      const bidSize = calculateDynamicSize(fairValueNo, timeRemainingPct, noPosition, 'bid', 'NO', config);
      
      if (bidPrice >= 0.01 && bidPrice <= 0.98) {
        noBids.push({
          price: Math.round(bidPrice * 100) / 100,
          size: bidSize,
        });
      }
    }
    
    // NO ask (we sell NO = buy YES from counterparty perspective)
    if (shouldQuoteSide(fairValueYes, timeRemainingPct, 'ask', 'NO', config)) {
      const askPrice = fairValueNo + halfSpread + levelOffset + skew;  // Opposite skew direction
      const askSize = calculateDynamicSize(fairValueNo, timeRemainingPct, -yesPosition, 'ask', 'NO', config);
      
      if (askPrice >= 0.02 && askPrice <= 0.99) {
        noAsks.push({
          price: Math.round(askPrice * 100) / 100,
          size: askSize,
        });
      }
    }
  }
  
  return {
    yesBids,
    yesAsks,
    noBids,
    noAsks,
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
    
    // Update price cache
    this.priceCache.set(asset, {
      price,
      timestamp: Date.now(),
    });
    
    // Trigger immediate quote update for affected markets
    for (const [marketId, state] of this.markets) {
      if (state.asset === asset) {
        const lastPrice = state.lastCurrentPrice || price;
        const priceDiff = Math.abs(price - lastPrice) / lastPrice;
        
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
    const activeMarkets = await marketService.getMarkets({ status: 'OPEN' });
    
    // Filter to configured assets AND only activated markets (strikePrice > 0)
    // Markets with strikePrice = '0' are pending activation and shouldn't be quoted
    const filteredMarkets = activeMarkets.filter(m => {
      const hasValidStrike = parseFloat(m.strikePrice) > 0;
      const isConfiguredAsset = this.config.assets.length === 0 || this.config.assets.includes(m.asset);
      
      if (!hasValidStrike) {
        mmLogger.debug(`Skipping pending market ${m.asset}-${m.timeframe} (strikePrice=0)`);
      }
      
      return hasValidStrike && isConfiguredAsset;
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
    
    // Calculate fair value using Black-Scholes
    const fairValue = calculateFairValue(
      currentPrice,
      state.strike,
      timeToExpiry / 1000,
      volatility
    );
    
    // Log significant fair value changes
    const previousFV = state.lastFairValue;
    const fairValueChanged = Math.abs(fairValue - (previousFV || 0.5)) > 0.01;
    if (fairValueChanged) {
      mmLogger.info(`MM V2 ${state.asset} ${state.timeframe}: FV=${fairValue.toFixed(3)} (BTC=$${currentPrice.toFixed(0)}, strike=$${state.strike}, TTX=${(timeToExpiry/1000).toFixed(0)}s)`);
    }
    
    state.lastFairValue = fairValue;
    
    // Generate quotes with all adjustments
    const quotes = generateQuotes(
      fairValue,
      timeRemainingPct,
      state.yesPosition,
      state.noPosition,
      this.config
    );
    
    state.lastSpread = quotes.spread;
    state.lastSkew = quotes.skew;
    state.lastQuoteTime = now;
    
    // ALWAYS update market prices in database (so UI shows correct fair value)
    try {
      await marketService.updatePrices(marketId, fairValue, 1 - fairValue);
    } catch {}
    
    // Update orders
    await this.updateMarketOrders(marketId, quotes);
  }

  private async updateMarketOrders(marketId: string, quotes: QuoteSet): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state) return;
    
    // Cancel existing orders
    await this.cancelAllOrders(marketId);
    
    // Place orders sequentially to avoid DB connection pool exhaustion
    // (Parallelization was causing too many simultaneous connections)
    for (const bid of quotes.yesBids) {
      await this.placeOrder(marketId, 'BID', 'YES', bid.price, bid.size);
    }
    for (const ask of quotes.yesAsks) {
      await this.placeOrder(marketId, 'ASK', 'YES', ask.price, ask.size);
    }
    for (const bid of quotes.noBids) {
      await this.placeOrder(marketId, 'BID', 'NO', bid.price, bid.size);
    }
    for (const ask of quotes.noAsks) {
      await this.placeOrder(marketId, 'ASK', 'NO', ask.price, ask.size);
    }
    
    // Broadcast orderbook updates using PUBKEY (frontend subscribes by pubkey, not db id)
    try {
      const yesSnapshot = await orderbookService.getSnapshot(marketId, 'YES');
      const noSnapshot = await orderbookService.getSnapshot(marketId, 'NO');
      
      // Use pubkey for broadcast channel (frontend subscribes by market address)
      broadcastOrderbookUpdate(
        state.pubkey,
        yesSnapshot.bids.map(l => [l.price, l.size] as [number, number]),
        yesSnapshot.asks.map(l => [l.price, l.size] as [number, number]),
        yesSnapshot.sequenceId,
        'YES'
      );
      
      broadcastOrderbookUpdate(
        state.pubkey,
        noSnapshot.bids.map(l => [l.price, l.size] as [number, number]),
        noSnapshot.asks.map(l => [l.price, l.size] as [number, number]),
        noSnapshot.sequenceId,
        'NO'
      );
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
    
    // Cancel orders sequentially to avoid DB connection pool exhaustion
    for (const orderId of state.orders.keys()) {
      try {
        const o = state.orders.get(orderId);
        if (o && this.userId) {
          // Remove from orderbook (in-memory)
          await orderbookService.removeOrder({
            id: orderId,
            marketId,
            userId: this.userId,
            side: o.side,
            outcome: o.outcome,
            price: o.price,
            size: o.size,
            remainingSize: o.size,
            createdAt: Date.now(),
          });

          // Cancel in DB if persistence enabled
          if (!config.disableMmOrderPersistence) {
            await orderService.cancel(orderId, 'MM_CANCEL');
          }
        }
      } catch {}
    }
    
    state.orders.clear();
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
      };
    });
    
    const totalImbalance = marketDetails.reduce((sum, m) => sum + Math.abs(m.imbalance), 0);
    
    return {
      version: 'v2',
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
    
    // Calculate fair value
    const volatility = this.config.volatilityOverrides[state.asset] || this.config.defaultVolatility;
    const fairValue = calculateFairValue(
      currentPrice,
      state.strike,
      timeToExpiry / 1000,
      volatility
    );
    
    // Generate quotes for inspection
    const quotes = generateQuotes(
      fairValue,
      timeRemainingPct,
      state.yesPosition,
      state.noPosition,
      this.config
    );
    
    return {
      fairValueYes: fairValue,
      fairValueNo: 1 - fairValue,
      currentPrice,
      strike: state.strike,
      volatility,
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
    };
  }
}

// Export singleton instance
export const mmBotV2 = new MarketMakerBotV2();

// Also export class for testing
export { MarketMakerBotV2 };

