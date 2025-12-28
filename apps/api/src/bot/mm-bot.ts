import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { mmLogger } from '../lib/logger.js';
import { priceFeedService } from '../services/price-feed.service.js';
import { marketService } from '../services/market.service.js';
import { orderService } from '../services/order.service.js';
import { matchingService } from '../services/matching.service.js';
import { userService } from '../services/user.service.js';
import { anchorClient, getMarketPda } from '../lib/anchor-client.js';
import { broadcastOrderbookUpdate } from '../lib/broadcasts.js';
import { orderbookService } from '../services/orderbook.service.js';

// Domain separator for order messages (must match contract)
const ORDER_MESSAGE_PREFIX = 'DEGEN_ORDER_V1:';

/**
 * Build binary order message for signing
 */
function buildOrderMessage(
  marketPubkey: any,
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
  
  view.setBigUint64(offset, BigInt(size), true);
  offset += 8;
  
  view.setBigInt64(offset, BigInt(expiryTs), true);
  offset += 8;
  
  view.setBigUint64(offset, BigInt(clientOrderId), true);
  
  return bytes;
}

/**
 * Market Maker Bot - Simplified Pricing
 * 
 * Core principle: Markets start at 0.50 YES / 0.50 NO
 * Fair value adjusts based on current price vs strike:
 * - Price > strike: YES probability increases
 * - Price < strike: NO probability increases
 * - Probability change is proportional to % distance from strike
 * 
 * The spread is set via MM_SPREAD env variable (default: 0.04 = 4 cents)
 */

// ========================
// Configuration
// ========================

interface MMConfig {
  spread: number;              // Total spread (e.g., 0.04 = 4 cents)
  sizePerLevel: number;        // Contracts per quote level
  numLevels: number;           // Number of price levels
  maxPositionPerMarket: number;
  quoteUpdateMs: number;       // How often to update quotes
  closeBeforeExpiryMs: number; // Cancel quotes this early
  assets: string[];            // Which assets to market make (empty = all)
}

// Load spread from env, default to 0.04 (4 cents)
const MM_SPREAD = parseFloat(process.env.MM_SPREAD || '0.04');
// Load assets from env, default to BTC only
const MM_ASSETS = (process.env.MM_ASSETS || 'BTC').split(',').map((a: string) => a.trim());

const DEFAULT_CONFIG: MMConfig = {
  spread: MM_SPREAD,
  sizePerLevel: 10000,         // 10000 contracts per level (instant fills for most orders)
  numLevels: 3,                // 3 levels of depth
  maxPositionPerMarket: 100000,
  quoteUpdateMs: 2000,         // Update every 2 seconds for responsiveness
  closeBeforeExpiryMs: 30000,  // Stop 30s before expiry
  assets: MM_ASSETS,           // BTC only by default
};

mmLogger.info(`MM Bot config: spread=${DEFAULT_CONFIG.spread} (${DEFAULT_CONFIG.spread * 100} cents), assets=${DEFAULT_CONFIG.assets.join(',')}`);


// ========================
// Fair Value Calculation - SIMPLIFIED
// ========================

/**
 * Calculate fair value (YES probability) based on price vs strike
 * 
 * Simple linear model:
 * - At strike: 50%
 * - Every 1% move from strike shifts probability by ~10%
 * - Clamped to 0.05 - 0.95 to always allow trading
 * 
 * As time runs out, probability becomes more extreme (approaches 0 or 1)
 */
function calculateFairValue(
  currentPrice: number,
  strikePrice: number,
  timeToExpirySeconds: number
): number {
  // Base case: start at 0.50
  const baseProbability = 0.50;
  
  // Calculate % distance from strike
  const pctFromStrike = (currentPrice - strikePrice) / strikePrice;
  
  // Time factor: as time runs out, probability becomes more extreme
  // At T=0, factor = 1.0 (full effect)
  // At T=5min, factor = 0.2 (20% effect)
  // At T=1hr, factor = 0.05 (5% effect)
  const maxTime = 3600; // 1 hour
  const timeFactor = Math.max(0.1, 1 - (timeToExpirySeconds / maxTime));
  
  // Sensitivity: how much probability moves per 1% price change
  // Higher time factor = more sensitive
  const sensitivity = 5 * timeFactor; // 5x at expiry, 0.5x at 1hr
  
  // Calculate probability shift
  const probabilityShift = pctFromStrike * sensitivity;
  
  // Final probability
  let probability = baseProbability + probabilityShift;
  
  // Clamp to valid range (always leave room for trades)
  probability = Math.max(0.05, Math.min(0.95, probability));
  
  // Round to 2 decimal places
  return Math.round(probability * 100) / 100;
}

// ========================
// Quote Calculator
// ========================

interface Quote {
  price: number;
  size: number;
}

interface Quotes {
  yesBids: Quote[];
  yesAsks: Quote[];
  noBids: Quote[];
  noAsks: Quote[];
}

/**
 * Generate quotes for both YES and NO outcomes
 * 
 * Key insight: YES + NO = $1.00
 * So if YES fair value = 0.60, NO fair value = 0.40
 */
function calculateQuotes(fairValue: number, config: MMConfig): Quotes {
  const halfSpread = config.spread / 2;
  
  const yesBids: Quote[] = [];
  const yesAsks: Quote[] = [];
  const noBids: Quote[] = [];
  const noAsks: Quote[] = [];
  
  // NO fair value is complement of YES
  const noFairValue = 1 - fairValue;
  
  for (let i = 0; i < config.numLevels; i++) {
    const levelOffset = i * 0.01; // 1 cent between levels
    
    // YES quotes
    const yesBidPrice = Math.max(0.01, Math.round((fairValue - halfSpread - levelOffset) * 100) / 100);
    const yesAskPrice = Math.min(0.99, Math.round((fairValue + halfSpread + levelOffset) * 100) / 100);
    
    if (yesBidPrice >= 0.01 && yesAskPrice <= 0.99 && yesBidPrice < yesAskPrice) {
      yesBids.push({ price: yesBidPrice, size: config.sizePerLevel });
      yesAsks.push({ price: yesAskPrice, size: config.sizePerLevel });
    }
    
    // NO quotes (complement pricing)
    const noBidPrice = Math.max(0.01, Math.round((noFairValue - halfSpread - levelOffset) * 100) / 100);
    const noAskPrice = Math.min(0.99, Math.round((noFairValue + halfSpread + levelOffset) * 100) / 100);
    
    if (noBidPrice >= 0.01 && noAskPrice <= 0.99 && noBidPrice < noAskPrice) {
      noBids.push({ price: noBidPrice, size: config.sizePerLevel });
      noAsks.push({ price: noAskPrice, size: config.sizePerLevel });
    }
  }
  
  return { yesBids, yesAsks, noBids, noAsks };
}

// ========================
// Market State
// ========================

interface MarketState {
  id: string;
  pubkey: string;
  asset: string;
  timeframe: string;
  strike: number;
  expiryAt: number;
  orders: Map<string, { id: string; side: 'BID' | 'ASK'; outcome: 'YES' | 'NO'; price: number; size: number }>;
  yesPosition: number;
  noPosition: number;
  lastFairValue: number;
}

// ========================
// Market Maker Bot Class
// ========================

class MarketMakerBot {
  private config: MMConfig;
  private running: boolean = false;
  private markets: Map<string, MarketState> = new Map();
  private keypair: any = null;
  private walletAddress: string | null = null;
  private userId: string | null = null;
  private updateInterval: NodeJS.Timeout | null = null;
  private initialized: boolean = false;

  constructor(config: Partial<MMConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    const mmPrivateKey = process.env.MM_PRIVATE_KEY || process.env.MM_WALLET_PRIVATE_KEY;
    
    if (mmPrivateKey) {
      try {
        const secretKey = bs58.decode(mmPrivateKey);
        this.keypair = Keypair.fromSecretKey(secretKey);
        this.walletAddress = this.keypair.publicKey.toBase58();
        mmLogger.debug(`MM Bot wallet: ${this.walletAddress}`);
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
  }

  private async initializeUser(): Promise<boolean> {
    if (!this.walletAddress) return false;

    try {
      const user = await userService.getOrCreate(this.walletAddress);
      this.userId = user.id;
      this.initialized = true;
      mmLogger.debug(`MM Bot user: ${this.userId}`);
      return true;
    } catch (err) {
      mmLogger.error(`Failed to initialize MM Bot user: ${err}`);
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    
    mmLogger.info('MM Bot starting...');
    
    if (!await this.initializeUser()) {
      mmLogger.error('MM Bot failed to initialize');
      return;
    }
    
    this.running = true;
    
    await this.syncMarkets();
    
    // Start quote update loop
    this.updateInterval = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.updateAllQuotes();
      } catch (err) {
        mmLogger.error(`MM update error: ${err}`);
      }
    }, this.config.quoteUpdateMs);
    
    mmLogger.info(`MM Bot started (spread: ${this.config.spread}, update: ${this.config.quoteUpdateMs}ms)`);
  }

  async stop(): Promise<void> {
    this.running = false;
    
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    for (const marketId of this.markets.keys()) {
      await this.cancelAllOrders(marketId);
    }
    
    this.markets.clear();
    mmLogger.info('MM Bot stopped');
  }

  async syncMarkets(): Promise<void> {
    const activeMarkets = await marketService.getMarkets({ status: 'OPEN' });
    
    // Filter to only configured assets
    const filteredMarkets = this.config.assets.length > 0
      ? activeMarkets.filter(m => this.config.assets.includes(m.asset))
      : activeMarkets;
    
    for (const market of filteredMarkets) {
      if (!this.markets.has(market.id)) {
        this.markets.set(market.id, {
          id: market.id,
          pubkey: market.pubkey,
          asset: market.asset,
          timeframe: market.timeframe,
          strike: parseFloat(market.strikePrice),
          expiryAt: market.expiryAt.getTime(),
          orders: new Map(),
          yesPosition: 0,
          noPosition: 0,
          lastFairValue: 0.50,
        });
        
        mmLogger.info(`MM tracking: ${market.asset}-${market.timeframe} strike=$${parseFloat(market.strikePrice).toFixed(2)}`, {
          asset: market.asset,
          timeframe: market.timeframe,
        });
      }
    }
    
    // Remove markets no longer active or not in our asset list
    for (const [id, state] of this.markets) {
      if (!filteredMarkets.find(m => m.id === id)) {
        await this.cancelAllOrders(id);
        this.markets.delete(id);
      }
    }
  }

  async updateAllQuotes(): Promise<void> {
    await this.syncMarkets();
    
    const now = Date.now();
    
    for (const [marketId, state] of this.markets) {
      if (!this.running) break;
      
      const timeToExpiry = state.expiryAt - now;
      
      // Skip if market closing soon
      if (timeToExpiry < this.config.closeBeforeExpiryMs) {
        await this.cancelAllOrders(marketId);
        continue;
      }
      
      // Get current price
      const priceData = await priceFeedService.getPrice(state.asset);
      // If the price feed is briefly unavailable (common on startup), still quote around strike.
      // This ensures devnet market orders have liquidity immediately.
      const effectivePrice = priceData?.price ?? state.strike;
      
      // Calculate fair value
      const fairValue = calculateFairValue(
        effectivePrice,
        state.strike,
        timeToExpiry / 1000
      );
      
      state.lastFairValue = fairValue;
      
      // Generate quotes
      const quotes = calculateQuotes(fairValue, this.config);
      
      // Update market prices in database
      try {
        // When DB pressure is high (or MM order persistence is disabled), skip these frequent writes.
        if (!config.disableMmOrderPersistence) {
          await marketService.updatePrices(marketId, fairValue, 1 - fairValue);
        }
      } catch {}
      
      // Update orders
      try {
        await this.updateMarketOrders(marketId, quotes);
      } catch (err) {
        mmLogger.debug(`MM order update failed: ${(err as Error).message}`);
      }
    }
  }

  async updateMarketOrders(marketId: string, quotes: Quotes): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state) return;
    
    // Cancel existing orders
    await this.cancelAllOrders(marketId);
    
    // Place YES bids
    for (const bid of quotes.yesBids) {
      await this.placeOrder(marketId, 'BID', 'YES', bid.price, bid.size);
    }
    
    // Place YES asks
    for (const ask of quotes.yesAsks) {
      await this.placeOrder(marketId, 'ASK', 'YES', ask.price, ask.size);
    }
    
    // Place NO bids
    for (const bid of quotes.noBids) {
      await this.placeOrder(marketId, 'BID', 'NO', bid.price, bid.size);
    }
    
    // Place NO asks
    for (const ask of quotes.noAsks) {
      await this.placeOrder(marketId, 'ASK', 'NO', ask.price, ask.size);
    }
    
    // Broadcast orderbook updates
    try {
      const yesSnapshot = await orderbookService.getSnapshot(marketId, 'YES');
      const noSnapshot = await orderbookService.getSnapshot(marketId, 'NO');
      
      broadcastOrderbookUpdate(
        marketId,
        yesSnapshot.bids.map(l => [l.price, l.size] as [number, number]),
        yesSnapshot.asks.map(l => [l.price, l.size] as [number, number]),
        yesSnapshot.sequenceId,
        'YES'
      );
      
      broadcastOrderbookUpdate(
        marketId,
        noSnapshot.bids.map(l => [l.price, l.size] as [number, number]),
        noSnapshot.asks.map(l => [l.price, l.size] as [number, number]),
        noSnapshot.sequenceId,
        'NO'
      );
    } catch {}
  }

  async placeOrder(
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
      mmLogger.warn(`MM invalid price: ${price}`);
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

      // Optional: skip persisting MM orders in Postgres to reduce DB write volume.
      // We still publish them to the Redis orderbook and match normally.
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
            encodedInstruction: null, // MM orders don't have on-chain instructions
            isMmOrder: true, // Mark as Market Maker order
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
      
      for (const fill of result.fills) {
        this.onFill({ marketId, side, outcome, size: fill.size });
      }
      
      // Log MM order (suppressed from console, written to files)
      mmLogger.orderPlaced(`MM placed: ${side} ${outcome} ${size} @ ${price}`, {
        orderId: order.id,
        userId: this.userId,
        wallet: this.walletAddress || '',
        marketId,
        asset: state.asset,
        timeframe: state.timeframe,
        side,
        outcome,
        price,
        size,
        orderType: 'LIMIT',
        fills: result.fills.length,
        addedToBook: result.addedToBook,
        event: 'MM_ORDER_PLACED',
      });
    } catch (err) {
      // Silent fail for MM orders
    }
  }

  async cancelAllOrders(marketId: string): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state) return;
    
    for (const orderId of state.orders.keys()) {
      try {
        // Always remove from Redis orderbook; DB row may not exist when persistence is disabled.
        const o = state.orders.get(orderId);
        if (o && this.userId) {
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
        }

        if (!config.disableMmOrderPersistence) {
          await orderService.cancel(orderId, 'MM_CANCEL');
        }
      } catch {}
    }
    
    state.orders.clear();
  }

  onFill(fill: { marketId: string; side: 'BID' | 'ASK'; outcome: 'YES' | 'NO'; size: number }): void {
    const state = this.markets.get(fill.marketId);
    if (!state) return;
    
    if (fill.side === 'BID') {
      if (fill.outcome === 'YES') state.yesPosition += fill.size;
      else state.noPosition += fill.size;
    } else {
      if (fill.outcome === 'YES') state.noPosition += fill.size;
      else state.yesPosition += fill.size;
    }
    
    // Log MM fill (suppressed from console, written to files)
    mmLogger.fill(`MM fill: ${fill.side} ${fill.size} ${fill.outcome}`, {
      marketId: fill.marketId,
      asset: state.asset,
      timeframe: state.timeframe,
      yesPosition: state.yesPosition,
      noPosition: state.noPosition,
      event: 'MM_FILL',
    });
  }

  getStatus() {
    const now = Date.now();
    const marketDetails = Array.from(this.markets.values()).map(state => ({
      id: state.id,
      asset: state.asset,
      timeframe: state.timeframe,
      strike: state.strike,
      fairValue: state.lastFairValue,
      yesPosition: state.yesPosition,
      noPosition: state.noPosition,
      orderCount: state.orders.size,
      secondsToExpiry: Math.round((state.expiryAt - now) / 1000),
    }));
    
    return {
      running: this.running,
      initialized: this.initialized,
      markets: this.markets.size,
      totalOrders: marketDetails.reduce((sum, m) => sum + m.orderCount, 0),
      wallet: this.walletAddress,
      userId: this.userId,
      config: {
        spread: this.config.spread,
        sizePerLevel: this.config.sizePerLevel,
        numLevels: this.config.numLevels,
        updateMs: this.config.quoteUpdateMs,
      },
      marketDetails,
    };
  }

  async getQuoteInfo(marketId: string) {
    const state = this.markets.get(marketId);
    if (!state) return null;
    
    const priceData = await priceFeedService.getPrice(state.asset);
    const timeToExpiry = state.expiryAt - Date.now();
    
    const fairValue = priceData 
      ? calculateFairValue(priceData.price, state.strike, timeToExpiry / 1000)
      : 0.50;
    
    const quotes = calculateQuotes(fairValue, this.config);
    
    return {
      fairValue,
      noFairValue: 1 - fairValue,
      currentPrice: priceData?.price || null,
      strike: state.strike,
      timeToExpirySeconds: Math.round(timeToExpiry / 1000),
      quotes,
    };
  }
}

export const mmBot = new MarketMakerBot();
