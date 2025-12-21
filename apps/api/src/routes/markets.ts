import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { marketService } from '../services/market.service.js';
import { priceFeedService } from '../services/price-feed.service.js';
import { redis, RedisKeys } from '../db/redis.js';
import { logger } from '../lib/logger.js';

// Validation schemas
const listMarketsSchema = z.object({
  asset: z.enum(['BTC', 'ETH', 'SOL']).optional(),
  status: z.enum(['OPEN', 'CLOSED', 'RESOLVED', 'SETTLED']).optional(),
  timeframe: z.enum(['5m', '15m', '1h', '4h']).optional(),
});

const marketParamsSchema = z.object({
  address: z.string().min(32).max(44),
});

const tradesQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  before: z.string().optional(),
});

export async function marketRoutes(app: FastifyInstance) {
  /**
   * GET /markets
   * List all markets with optional filters
   */
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = listMarketsSchema.safeParse(request.query);
    
    if (!query.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid query parameters',
          details: query.error.flatten(),
        },
      });
    }
    
    const markets = await marketService.getMarkets(query.data);
    
    // Transform to API response format
    return markets.map((m) => {
      const expiryDate = m.expiryAt instanceof Date ? m.expiryAt : new Date(m.expiryAt);
      
      return {
        id: m.id,
        address: m.pubkey,
        asset: m.asset,
        timeframe: m.timeframe,
        strike: parseFloat(m.strikePrice),
        expiry: expiryDate.getTime(),
        status: m.status,
        volume24h: parseFloat(m.totalVolume || '0'),
        yesPrice: m.yesPrice ? parseFloat(m.yesPrice) : null,
        noPrice: m.noPrice ? parseFloat(m.noPrice) : null,
      };
    });
  });

  /**
   * GET /markets/prices
   * Get current prices for all assets (from Binance)
   */
  app.get('/prices', async (request: FastifyRequest, reply: FastifyReply) => {
    const prices = await priceFeedService.getAllPrices();
    
    // Transform to API format
    const result: Record<string, any> = {};
    
    for (const [asset, data] of Object.entries(prices)) {
      result[asset] = {
        price: data.price,
        timestamp: data.timestamp,
        source: data.source,
      };
    }
    
    // Add fallbacks for any missing assets
    for (const asset of ['BTC', 'ETH', 'SOL']) {
      if (!result[asset]) {
        result[asset] = {
          price: 0,
          timestamp: Date.now(),
          source: 'unavailable',
        };
      }
    }
    
    return result;
  });

  /**
   * GET /markets/stats
   * Get platform-wide statistics
   */
  app.get('/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const stats = await marketService.getPlatformStats();
    
    return {
      totalVolume24h: stats.totalVolume24h,
      totalTrades24h: stats.totalTrades24h,
      activeMarkets: stats.activeMarkets,
      totalUsers: 0, // TODO: Add user count
    };
  });

  /**
   * GET /markets/:address
   * Get detailed info for a single market
   */
  app.get('/:address', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = marketParamsSchema.safeParse(request.params);
    
    if (!params.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid market address',
        },
      });
    }
    
    const market = await marketService.getByPubkey(params.data.address);
    
    if (!market) {
      return reply.code(404).send({
        error: {
          code: 'MARKET_NOT_FOUND',
          message: 'Market not found',
        },
      });
    }
    
    return {
      id: market.id,
      address: market.pubkey,
      asset: market.asset,
      timeframe: market.timeframe,
      strike: parseFloat(market.strikePrice),
      expiry: market.expiryAt.getTime(),
      status: market.status,
      outcome: market.outcome,
      totalVolume: parseFloat(market.totalVolume || '0'),
      openInterest: parseFloat(market.openInterest || '0'),
      createdAt: market.createdAt?.getTime(),
      resolvedAt: market.resolvedAt?.getTime() || null,
      finalPrice: market.finalPrice ? parseFloat(market.finalPrice) : null,
    };
  });

  /**
   * GET /markets/:address/orderbook
   * Get orderbook snapshot for a market (both YES and NO outcomes)
   */
  app.get('/:address/orderbook', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = marketParamsSchema.safeParse(request.params);
    
    if (!params.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid market address',
        },
      });
    }
    
    const market = await marketService.getByPubkey(params.data.address);
    
    if (!market) {
      return reply.code(404).send({
        error: {
          code: 'MARKET_NOT_FOUND',
          message: 'Market not found',
        },
      });
    }
    
    // Get orderbook from Redis for BOTH YES and NO outcomes
    const [
      yesBidData, yesAskData,
      noBidData, noAskData,
      sequenceId
    ] = await Promise.all([
      redis.zrevrange(RedisKeys.orderbook(market.id, 'YES', 'BID'), 0, -1, 'WITHSCORES'),
      redis.zrange(RedisKeys.orderbook(market.id, 'YES', 'ASK'), 0, -1, 'WITHSCORES'),
      redis.zrevrange(RedisKeys.orderbook(market.id, 'NO', 'BID'), 0, -1, 'WITHSCORES'),
      redis.zrange(RedisKeys.orderbook(market.id, 'NO', 'ASK'), 0, -1, 'WITHSCORES'),
      redis.get(RedisKeys.sequence(market.id)),
    ]);
    
    // Parse Redis data into orderbook format
    // Format: [[price, size], [price, size], ...]
    const yesBids = parseOrderbookData(yesBidData);
    const yesAsks = parseOrderbookData(yesAskData);
    const noBids = parseOrderbookData(noBidData);
    const noAsks = parseOrderbookData(noAskData);
    
    // Calculate mid price and spread for YES
    const yesBestBid = yesBids[0]?.[0] || 0;
    const yesBestAsk = yesAsks[0]?.[0] || 1;
    const yesMidPrice = (yesBestBid + yesBestAsk) / 2;
    const yesSpread = yesBestAsk - yesBestBid;
    
    // Calculate mid price and spread for NO
    const noBestBid = noBids[0]?.[0] || 0;
    const noBestAsk = noAsks[0]?.[0] || 1;
    const noMidPrice = (noBestBid + noBestAsk) / 2;
    const noSpread = noBestAsk - noBestBid;
    
    return {
      // Legacy format (YES only) for backwards compatibility
      bids: yesBids,
      asks: yesAsks,
      midPrice: parseFloat(yesMidPrice.toFixed(2)),
      spread: parseFloat(yesSpread.toFixed(2)),
      sequenceId: parseInt(sequenceId || '0'),
      // New format with both outcomes
      yes: {
        bids: yesBids,
        asks: yesAsks,
        midPrice: parseFloat(yesMidPrice.toFixed(2)),
        spread: parseFloat(yesSpread.toFixed(2)),
      },
      no: {
        bids: noBids,
        asks: noAsks,
        midPrice: parseFloat(noMidPrice.toFixed(2)),
        spread: parseFloat(noSpread.toFixed(2)),
      },
    };
  });

  /**
   * GET /markets/:address/trades
   * Get recent trades for a market
   */
  app.get('/:address/trades', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = marketParamsSchema.safeParse(request.params);
    const query = tradesQuerySchema.safeParse(request.query);
    
    if (!params.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid market address',
        },
      });
    }
    
    const market = await marketService.getByPubkey(params.data.address);
    
    if (!market) {
      return reply.code(404).send({
        error: {
          code: 'MARKET_NOT_FOUND',
          message: 'Market not found',
        },
      });
    }
    
    const limit = query.success ? query.data.limit : 50;
    const trades = await marketService.getRecentTrades(market.id, limit);
    
    return {
      trades: trades.map((t) => ({
        id: t.id,
        price: parseFloat(t.price),
        size: parseFloat(t.size),
        outcome: t.outcome?.toLowerCase(),
        side: 'buy', // TODO: Determine from trade data
        timestamp: t.executedAt?.getTime(),
        txSignature: t.txSignature,
      })),
      nextCursor: trades.length === limit ? trades[trades.length - 1]?.id : null,
    };
  });
}

/**
 * Parse Redis ZRANGE WITHSCORES data into orderbook format
 */
function parseOrderbookData(data: string[]): [number, number][] {
  const result: [number, number][] = [];
  
  // Data comes as [member, score, member, score, ...]
  for (let i = 0; i < data.length; i += 2) {
    const size = parseFloat(data[i]);
    const price = parseFloat(data[i + 1]);
    
    if (!isNaN(price) && !isNaN(size)) {
      result.push([price / 1000000, size]); // Convert from 6 decimals
    }
  }
  
  return result;
}
