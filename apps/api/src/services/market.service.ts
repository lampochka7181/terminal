import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import { db, markets, trades, type Market, type NewMarket } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { redis, RedisKeys } from '../db/redis.js';

export type MarketStatus = 'OPEN' | 'CLOSED' | 'RESOLVED' | 'SETTLED';
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
   */
  private async clearMarketsCache(): Promise<void> {
    try {
      const keys = await redis.keys('markets:list:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        logger.debug(`Cleared ${keys.length} markets cache keys`);
      }
    } catch (err) {
      logger.error('Failed to clear markets cache:', err);
    }
  }

  /**
   * Get all markets with optional filters
   */
  async getMarkets(filter: MarketFilter = {}): Promise<Market[]> {
    // Try cache first
    const cacheKey = RedisKeys.markets(JSON.stringify(filter));
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          // Revive Date objects from JSON strings
          return parsed.map(m => ({
            ...m,
            createdAt: m.createdAt ? new Date(m.createdAt) : null,
            expiryAt: m.expiryAt ? new Date(m.expiryAt) : null,
            resolvedAt: m.resolvedAt ? new Date(m.resolvedAt) : null,
            settledAt: m.settledAt ? new Date(m.settledAt) : null,
          }));
        }
      }
    } catch (err) {
      logger.debug('Markets cache miss or invalid data');
    }

    let query = db.select().from(markets);
    
    const conditions: any[] = [];
    
    if (filter.asset) {
      conditions.push(eq(markets.asset, filter.asset));
    }
    if (filter.status) {
      conditions.push(eq(markets.status, filter.status));
    }
    if (filter.timeframe) {
      conditions.push(eq(markets.timeframe, filter.timeframe));
    }
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }
    
    const result = await query.orderBy(desc(markets.createdAt));

    // Cache the result for 10 seconds (short enough for frequent updates, long enough for high load)
    try {
      await redis.set(cacheKey, JSON.stringify(result), 'EX', 10);
    } catch (err) {
      logger.error('Failed to cache markets:', err);
    }

    return result;
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
   */
  async getExpiredOpenMarkets(): Promise<Market[]> {
    const now = new Date();
    
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
   */
  async getMarketsToResolve(): Promise<Market[]> {
    const now = new Date();
    
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

