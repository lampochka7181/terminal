import { eq, ne, and, gte, lte, desc, sql, inArray } from 'drizzle-orm';
import { db, markets, trades, type Market, type NewMarket } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { redis, RedisKeys } from '../db/redis.js';

export type MarketStatus = 'PENDING' | 'OPEN' | 'CLOSED' | 'RESOLVED' | 'SETTLED';
export type Asset = 'BTC' | 'ETH' | 'SOL';
export type Timeframe = '5m' | '15m' | '1h' | '4h';

export interface MarketFilter {
  asset?: Asset;
  status?: MarketStatus;
  timeframe?: Timeframe;
}

export class MarketService {
  /**
   * Helper to clear markets cache
   * Uses SCAN instead of KEYS to avoid blocking Redis
   * Also debounced to prevent stampede on rapid updates
   */
  private clearCacheQueued = false;
  private clearCacheTimer: NodeJS.Timeout | null = null;
  
  /**
   * CIRCUIT BREAKER: Track concurrent DB queries to prevent overload
   * If too many queries are in flight, return cached/stale data instead of queuing more
   */
  private activeDbQueries = 0;
  private static readonly MAX_CONCURRENT_QUERIES = 10;
  
  private async clearMarketsCache(): Promise<void> {
    // Debounce cache clears - wait 100ms and batch multiple clears into one
    if (this.clearCacheQueued) return;
    
    this.clearCacheQueued = true;
    
    if (this.clearCacheTimer) {
      clearTimeout(this.clearCacheTimer);
    }
    
    this.clearCacheTimer = setTimeout(async () => {
      this.clearCacheQueued = false;
      this.clearCacheTimer = null;
      
      try {
        // Use a known set of cache keys instead of scanning
        // We cache with specific filter combinations, so clear those
        const commonFilters = [
          '{}',
          '{"status":"OPEN"}',
          '{"asset":"BTC"}',
          '{"asset":"BTC","status":"OPEN"}',
          '{"asset":"ETH","status":"OPEN"}',
          '{"asset":"SOL","status":"OPEN"}',
        ];
        
        const keysToDelete = commonFilters.map(f => RedisKeys.markets(f));
        
        // Also clear any asset+timeframe combos
        for (const asset of ['BTC', 'ETH', 'SOL']) {
          for (const timeframe of ['5m', '15m', '1h', '4h', '24h']) {
            keysToDelete.push(RedisKeys.markets(JSON.stringify({ asset, timeframe })));
            keysToDelete.push(RedisKeys.markets(JSON.stringify({ asset, timeframe, status: 'OPEN' })));
          }
        }
        
        // Delete in one batch (ignore errors for non-existent keys)
        if (keysToDelete.length > 0) {
          await redis.del(...keysToDelete).catch(() => {});
        }
      } catch (err) {
        // Silently ignore cache clear errors - not critical
      }
    }, 100);
  }

  /**
   * Get all markets with optional filters
   * By default excludes SETTLED markets to improve performance
   * 
   * CIRCUIT BREAKER: If too many DB queries are in flight, return stale cache
   * rather than queue more queries and risk pool exhaustion
   */
  async getMarkets(filter: MarketFilter = {}): Promise<Market[]> {
    // Try cache first
    const cacheKey = RedisKeys.markets(JSON.stringify(filter));
    let cachedData: Market[] | null = null;
    
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          // Revive Date objects from JSON strings
          cachedData = parsed.map(m => ({
            ...m,
            createdAt: m.createdAt ? new Date(m.createdAt) : null,
            expiryAt: m.expiryAt ? new Date(m.expiryAt) : null,
            resolvedAt: m.resolvedAt ? new Date(m.resolvedAt) : null,
            settledAt: m.settledAt ? new Date(m.settledAt) : null,
          }));
          logger.debug(`[MarketService] getMarkets cache HIT (${cachedData.length} markets)`);
          return cachedData;
        }
      }
    } catch (err) {
      logger.debug('Markets cache miss or invalid data');
    }
    
    // CIRCUIT BREAKER: If too many queries in flight, return empty or stale data
    // This prevents the cascade failure when cache clears and many clients hit DB
    if (this.activeDbQueries >= MarketService.MAX_CONCURRENT_QUERIES) {
      logger.warn(`[MarketService] Circuit breaker: ${this.activeDbQueries} queries in flight, skipping DB query`);
      // Return cached data if available, otherwise empty array
      return cachedData || [];
    }

    const startTime = Date.now();
    this.activeDbQueries++;
    
    try {
      let query = db.select().from(markets);
      
      const conditions: any[] = [];
      
      if (filter.asset) {
        conditions.push(eq(markets.asset, filter.asset));
      }
      if (filter.status) {
        conditions.push(eq(markets.status, filter.status));
      } else {
        // By default exclude SETTLED markets - they're archived and not needed for trading
        // This significantly improves query performance as SETTLED markets accumulate
        conditions.push(ne(markets.status, 'SETTLED'));
      }
      if (filter.timeframe) {
        conditions.push(eq(markets.timeframe, filter.timeframe));
      }
      
      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }
      
      // Limit results to prevent slow queries as markets accumulate
      // 100 is plenty - frontend only shows active markets anyway
      const result = await query.orderBy(desc(markets.createdAt)).limit(100);
      const duration = Date.now() - startTime;
      
      logger.debug(`[MarketService] getMarkets DB query took ${duration}ms (${result.length} results, filter=${JSON.stringify(filter)})`);
      if (duration > 500) {
        logger.warn(`[MarketService] SLOW getMarkets query: ${duration}ms`);
      }

      // Cache the result for 15 seconds (increased from 10s to reduce DB pressure during market lifecycle events)
      // The frontend uses WebSocket for real-time updates, so polling frequency can be relaxed
      try {
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 15);
      } catch (err) {
        logger.error('Failed to cache markets:', err);
      }

      return result;
    } finally {
      this.activeDbQueries--;
    }
  }

  /**
   * Get a single market by pubkey (on-chain address)
   */
  async getByPubkey(pubkey: string): Promise<Market | null> {
    const result = await db
      .select()
      .from(markets)
      .where(eq(markets.pubkey, pubkey))
      .limit(1);
    
    return result[0] || null;
  }

  /**
   * Get multiple markets by pubkeys in a single query
   * Returns a Map for O(1) lookup
   */
  async getByPubkeys(pubkeys: string[]): Promise<Map<string, Market>> {
    if (pubkeys.length === 0) return new Map();
    
    const result = await db
      .select()
      .from(markets)
      .where(inArray(markets.pubkey, pubkeys));
    
    return new Map(result.map(m => [m.pubkey, m]));
  }

  /**
   * Get a single market by ID
   */
  async getById(id: string): Promise<Market | null> {
    const result = await db
      .select()
      .from(markets)
      .where(eq(markets.id, id))
      .limit(1);
    
    return result[0] || null;
  }

  /**
   * Get recent trades for a market
   */
  async getRecentTrades(marketId: string, limit: number = 50) {
    const result = await db
      .select({
        id: trades.id,
        price: trades.price,
        size: trades.size,
        outcome: trades.outcome,
        txSignature: trades.txSignature,
        executedAt: trades.executedAt,
      })
      .from(trades)
      .where(eq(trades.marketId, marketId))
      .orderBy(desc(trades.executedAt))
      .limit(limit);
    
    return result;
  }

  /**
   * Get markets expiring soon (for keeper)
   */
  async getExpiringMarkets(withinMinutes: number = 1): Promise<Market[]> {
    const now = new Date();
    const cutoff = new Date(now.getTime() + withinMinutes * 60 * 1000);
    
    const result = await db
      .select()
      .from(markets)
      .where(
        and(
          eq(markets.status, 'OPEN'),
          lte(markets.expiryAt, cutoff),
          gte(markets.expiryAt, now)
        )
      )
      .orderBy(markets.expiryAt);
    
    return result;
  }

  /**
   * Get OPEN markets that have already expired (need to be closed)
   * Uses a 500ms buffer to account for clock skew between server and Solana cluster
   */
  async getExpiredOpenMarkets(): Promise<Market[]> {
    // Add 500ms buffer to prevent "MarketNotExpired" errors from clock skew
    const now = new Date(Date.now() - 500);
    
    const result = await db
      .select()
      .from(markets)
      .where(
        and(
          eq(markets.status, 'OPEN'),
          lte(markets.expiryAt, now)
        )
      );
    
    return result;
  }

  /**
   * Get markets ready for resolution (expired but not resolved)
   * Uses a 500ms buffer to account for clock skew between server and Solana cluster
   */
  async getMarketsToResolve(): Promise<Market[]> {
    // Add 500ms buffer to prevent "MarketNotExpired" errors from clock skew
    const now = new Date(Date.now() - 500);
    
    const result = await db
      .select()
      .from(markets)
      .where(
        and(
          eq(markets.status, 'CLOSED'),
          lte(markets.expiryAt, now)
        )
      );
    
    return result;
  }

  /**
   * Create a new market
   * Markets start at 0.50 YES / 0.50 NO (fair value when strike = current price)
   */
  async create(data: NewMarket): Promise<Market> {
    const [market] = await db
      .insert(markets)
      .values({
        ...data,
        yesPrice: '0.50',  // Initial fair value
        noPrice: '0.50',   // Initial fair value (YES + NO = 1.00)
      })
      .returning();
    
    await this.clearMarketsCache();
    logger.info(`Created market: ${market.pubkey} (${market.asset}-${market.timeframe}) YES=0.50, NO=0.50`);
    return market;
  }

  /**
   * Update market status
   */
  async updateStatus(id: string, status: MarketStatus): Promise<void> {
    await db
      .update(markets)
      .set({ status })
      .where(eq(markets.id, id));
    
    await this.clearMarketsCache();
  }

  /**
   * Resolve market with outcome
   */
  async resolve(id: string, outcome: 'YES' | 'NO', finalPrice: string): Promise<void> {
    await db
      .update(markets)
      .set({
        status: 'RESOLVED',
        outcome,
        finalPrice,
        resolvedAt: new Date(),
      })
      .where(eq(markets.id, id));
    
    await this.clearMarketsCache();
    logger.info(`Resolved market ${id}: ${outcome} at price ${finalPrice}`);
  }

  /**
   * Mark market as settled
   */
  async markSettled(id: string): Promise<void> {
    await db
      .update(markets)
      .set({
        status: 'SETTLED',
        settledAt: new Date(),
      })
      .where(eq(markets.id, id));
    
    await this.clearMarketsCache();
  }

  /**
   * Get markets that need activation (strikePrice = '0' means pending)
   * A market's start time is calculated as: expiryAt - duration (based on timeframe)
   * 
   * NOTE: We use strikePrice = '0' to indicate pending instead of a PENDING status
   * to avoid PostgreSQL enum caching issues with Supabase connection pooler.
   */
  async getPendingMarketsToActivate(): Promise<Market[]> {
    const now = new Date();
    
    // Markets with strikePrice = '0' are pending activation
    const result = await db
      .select()
      .from(markets)
      .where(
        and(
          eq(markets.status, 'OPEN'),
          eq(markets.strikePrice, '0')
        )
      );
    
    // Filter to markets whose start time has arrived
    // Start time = expiry - duration (e.g., for 5m market expiring at 12:05, start is 12:00)
    const timeframeDurations: Record<string, number> = {
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
    };
    
    return result.filter(m => {
      const duration = timeframeDurations[m.timeframe] || 5 * 60 * 1000;
      const startTime = new Date(m.expiryAt.getTime() - duration);
      return startTime <= now;
    });
  }

  /**
   * Activate a PENDING market: set real strike price and status to OPEN
   */
  async activateMarket(id: string, strikePrice: string): Promise<void> {
    await db
      .update(markets)
      .set({
        status: 'OPEN',
        strikePrice,
      })
      .where(eq(markets.id, id));
    
    await this.clearMarketsCache();
    logger.info(`Activated market ${id} with strike price ${strikePrice}`);
  }

  /**
   * Mark market as archived (on-chain account closed, rent recovered)
   * Sets pubkey to a unique archived string to indicate on-chain account no longer exists
   */
  async markArchived(id: string): Promise<void> {
    await db
      .update(markets)
      .set({
        pubkey: `arc-${id.slice(0, 8)}`, // Unique-enough string for archived market
      })
      .where(eq(markets.id, id));
    
    await this.clearMarketsCache();
  }

  /**
   * Mark market as archived by its pubkey
   */
  async markArchivedByPubkey(pubkey: string): Promise<void> {
    const market = await this.getByPubkey(pubkey);
    if (market) {
      await this.markArchived(market.id);
    }
  }

  /**
   * Update market prices after a trade
   */
  async updatePrices(id: string, yesPrice: number, noPrice: number): Promise<void> {
    await db
      .update(markets)
      .set({
        yesPrice: yesPrice.toString(),
        noPrice: noPrice.toString(),
      })
      .where(eq(markets.id, id));
  }

  /**
   * Increment market volume and trade count
   */
  async incrementStats(id: string, volume: number): Promise<void> {
    await db
      .update(markets)
      .set({
        totalVolume: sql`${markets.totalVolume} + ${volume}`,
        totalTrades: sql`${markets.totalTrades} + 1`,
      })
      .where(eq(markets.id, id));
  }

  /**
   * Get platform stats
   */
  async getPlatformStats() {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    // Get 24h volume from trades
    const volumeResult = await db
      .select({
        total: sql<string>`COALESCE(SUM(${trades.notional}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(trades)
      .where(gte(trades.executedAt, yesterday));
    
    // Get active markets count
    const marketsResult = await db
      .select({
        count: sql<number>`COUNT(*)`,
      })
      .from(markets)
      .where(eq(markets.status, 'OPEN'));
    
    return {
      totalVolume24h: parseFloat(volumeResult[0]?.total || '0'),
      totalTrades24h: Number(volumeResult[0]?.count || 0),
      activeMarkets: Number(marketsResult[0]?.count || 0),
    };
  }
}

export const marketService = new MarketService();

