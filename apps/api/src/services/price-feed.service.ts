import WebSocket from 'ws';
import { redis, RedisKeys } from '../db/redis.js';
import { logger } from '../lib/logger.js';
import { broadcastPriceUpdate } from '../lib/broadcasts.js';

/**
 * Price Feed Service
 * 
 * Connects to Coinbase WebSocket for real-time BTC, ETH, SOL prices.
 * (Binance blocked in some regions, Coinbase works globally)
 * 
 * Caches prices in Redis for use by:
 * - Market Creator (strike price)
 * - Market Resolver (final price)
 * - Frontend (live price display)
 */

interface PriceData {
  asset: string;
  price: number;
  timestamp: number;
  source: string;
}

// Coinbase WebSocket endpoint (works globally)
const COINBASE_WS_URL = 'wss://ws-feed.exchange.coinbase.com';

// Asset to Coinbase product ID mapping
const ASSET_PRODUCTS: Record<string, string> = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
};

// Reconnection settings
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;
const TICK_RETENTION_MS = 6 * 60 * 60 * 1000; // 6 hours

class PriceFeedService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private isRunning = false;
  private prices: Map<string, PriceData> = new Map();

  /**
   * Start the price feed
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Price feed already running');
      return;
    }
    
    this.isRunning = true;
    this.connect();
    logger.info('Price feed service started');
  }

  /**
   * Stop the price feed
   */
  stop(): void {
    this.isRunning = false;
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    logger.info('Price feed service stopped');
  }

  /**
   * Connect to Coinbase WebSocket
   */
  private connect(): void {
    if (!this.isRunning) return;
    
    logger.info(`Connecting to Coinbase WebSocket...`);
    
    this.ws = new WebSocket(COINBASE_WS_URL);
    
    this.ws.on('open', () => {
      logger.info('✅ Connected to Coinbase WebSocket');
      this.reconnectAttempts = 0;
      
      // Subscribe to per-trade matches for maximum granularity
      const subscribeMsg = {
        type: 'subscribe',
        product_ids: Object.values(ASSET_PRODUCTS),
        channels: ['matches'],
      };
      
      this.ws!.send(JSON.stringify(subscribeMsg));
      logger.info(`   Subscribed to: ${Object.keys(ASSET_PRODUCTS).join(', ')}`);
    });
    
    this.ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });
    
    this.ws.on('close', () => {
      logger.warn('Coinbase WebSocket closed');
      this.scheduleReconnect();
    });
    
    this.ws.on('error', (err: Error) => {
      logger.error('Coinbase WebSocket error:', err.message);
    });
  }

  /**
   * Handle incoming price message
   */
  private async handleMessage(data: string): Promise<void> {
    try {
      const msg = JSON.parse(data);
      
      // Handle subscription confirmations
      if (msg.type === 'subscriptions') {
        logger.debug('Subscription confirmed:', msg.channels);
        return;
      }
      
      // Handle trade match messages (tick-by-tick)
      if (msg.type === 'match') {
        const productId = msg.product_id; // e.g., 'BTC-USD'
        const price = parseFloat(msg.price);
        const timestamp = new Date(msg.time).getTime();
        
        // Find asset from product ID
        const asset = Object.entries(ASSET_PRODUCTS)
          .find(([, p]) => p === productId)?.[0];
        
        if (!asset || isNaN(price)) return;
        
        const priceData: PriceData = {
          asset,
          price,
          timestamp,
          source: 'coinbase',
        };
        
        // Update in-memory cache
        this.prices.set(asset, priceData);
        
        // Update Redis cache
        await this.cachePrice(priceData);

        // Store tick history for charting
        await this.storeTick(priceData);
        
        // Broadcast to WebSocket clients (throttled)
        this.broadcastPrice(priceData);
      }
    } catch (err) {
      // Ignore parse errors for non-JSON messages
    }
  }

  /**
   * Cache price in Redis
   */
  private async cachePrice(data: PriceData): Promise<void> {
    try {
      const key = RedisKeys.price(data.asset);
      await redis.set(key, JSON.stringify(data), 'EX', 60); // Expire after 60s
    } catch (err) {
      logger.error(`Failed to cache price for ${data.asset}:`, err);
    }
  }

  /**
   * Store rolling tick history for charting in Redis.
   * Uses a ZSET: score=timestampMs, member="price:rand" (unique member).
   */
  private async storeTick(data: PriceData): Promise<void> {
    try {
      const key = RedisKeys.ticks(data.asset);
      const member = `${data.price}:${Math.random().toString(36).slice(2)}`;
      await redis.zadd(key, String(data.timestamp), member);
      // Keep last N hours by score
      const cutoff = Date.now() - TICK_RETENTION_MS;
      await redis.zremrangebyscore(key, 0, cutoff);
    } catch (err) {
      // Non-fatal: chart history is best-effort
    }
  }

  // Throttle broadcasts (max 1 per 100ms per asset)
  private lastBroadcast: Map<string, number> = new Map();
  private readonly BROADCAST_THROTTLE_MS = 100;

  /**
   * Broadcast price update to WebSocket clients
   */
  private broadcastPrice(data: PriceData): void {
    const now = Date.now();
    const lastTime = this.lastBroadcast.get(data.asset) || 0;
    
    if (now - lastTime < this.BROADCAST_THROTTLE_MS) {
      return; // Throttled
    }
    
    this.lastBroadcast.set(data.asset, now);
    broadcastPriceUpdate(data.asset, data.price, data.timestamp);
  }

  /**
   * Schedule reconnection
   */
  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error('Max reconnect attempts reached, giving up');
      return;
    }
    
    this.reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * this.reconnectAttempts;
    
    logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Get current price for an asset
   */
  async getPrice(asset: string): Promise<PriceData | null> {
    // Try in-memory first
    const cached = this.prices.get(asset);
    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached;
    }
    
    // Try Redis
    try {
      const redisData = await redis.get(RedisKeys.price(asset));
      if (redisData) {
        return JSON.parse(redisData);
      }
    } catch (err) {
      logger.error(`Failed to get price from Redis for ${asset}:`, err);
    }
    
    return null;
  }

  /**
   * Get all current prices
   */
  async getAllPrices(): Promise<Record<string, PriceData>> {
    const result: Record<string, PriceData> = {};
    
    for (const asset of Object.keys(ASSET_PRODUCTS)) {
      const price = await this.getPrice(asset);
      if (price) {
        result[asset] = price;
      }
    }
    
    return result;
  }

  /**
   * Check if price feed is healthy
   */
  isHealthy(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    
    // Check if we have recent prices (within 30s)
    const now = Date.now();
    for (const asset of Object.keys(ASSET_PRODUCTS)) {
      const price = this.prices.get(asset);
      if (!price || now - price.timestamp > 30000) {
        return false;
      }
    }
    
    return true;
  }
}

export const priceFeedService = new PriceFeedService();
