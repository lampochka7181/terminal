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
  timeframe: z.enum(['5m', '15m', '1h', '4h', '24h']).optional(),
});

const marketParamsSchema = z.object({
  address: z.string().min(32).max(44),
});

const tradesQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  before: z.string().optional(),
});

const candlesQuerySchema = z.object({
  asset: z.enum(['BTC', 'ETH', 'SOL']),
  intervalSec: z.coerce.number().min(1).max(60).default(5),
  lookbackSec: z.coerce.number().min(60).max(6 * 60 * 60).default(60 * 60), // 1h default, max 6h
});

type Candle = { time: number; open: number; high: number; low: number; close: number };

async function fetchCoinbaseTradesTicks(params: {
  productId: string;
  startMs: number;
  endMs: number;
}): Promise<Array<{ ts: number; price: number }>> {
  const { productId, startMs, endMs } = params;
  let before: string | undefined = undefined;
  const out: Array<{ ts: number; price: number }> = [];

  // Best-effort backfill; cap pages to avoid rate limit / long tail.
  const MAX_PAGES = 8;
  const LIMIT = 1000;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`https://api.exchange.coinbase.com/products/${productId}/trades`);
    url.searchParams.set('limit', String(LIMIT));
    if (before) url.searchParams.set('before', before);

    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!res.ok) break;
    const rows = (await res.json()) as Array<{ trade_id: number; price: string; time: string }>;
    if (!Array.isArray(rows) || rows.length === 0) break;

    // Coinbase returns newest-first. Append and page backwards.
    for (const r of rows) {
      const ts = Date.parse(r.time);
      const price = Number(r.price);
      if (!Number.isFinite(ts) || !Number.isFinite(price)) continue;
      if (ts >= startMs && ts <= endMs) out.push({ ts, price });
    }

    const last = rows[rows.length - 1];
    if (!last?.trade_id) break;
    before = String(last.trade_id);

    // Stop if we've reached (or passed) the start window based on the oldest trade in this page.
    const oldestTs = Date.parse(last.time);
    if (Number.isFinite(oldestTs) && oldestTs <= startMs) break;

    // Small delay to be polite to the API
    await new Promise((r) => setTimeout(r, 150));
  }

  // Sort ascending for candle aggregation
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function buildCandlesFromTicks(params: {
  ticks: Array<{ ts: number; price: number }>;
  intervalSec: number;
  startMs: number;
  endMs: number;
}): Candle[] {
  const { ticks, intervalSec, startMs, endMs } = params;
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.floor(endMs / 1000);
  const startBucket = Math.floor(startSec / intervalSec) * intervalSec;
  const endBucket = Math.floor(endSec / intervalSec) * intervalSec;

  const candles: Candle[] = [];
  let tickIdx = 0;
  let prevClose: number | null = null;

  for (let bucket = startBucket; bucket <= endBucket; bucket += intervalSec) {
    const bucketStartMs = bucket * 1000;
    const bucketEndMs = (bucket + intervalSec) * 1000;

    // Advance tick index to first tick in/after bucket
    while (tickIdx < ticks.length && ticks[tickIdx].ts < bucketStartMs) tickIdx++;

    const firstIdx = tickIdx;
    let open: number | null = null;
    let high: number | null = null;
    let low: number | null = null;
    let close: number | null = null;

    while (tickIdx < ticks.length && ticks[tickIdx].ts < bucketEndMs) {
      const p = ticks[tickIdx].price;
      if (open == null) open = p;
      high = high == null ? p : Math.max(high, p);
      low = low == null ? p : Math.min(low, p);
      close = p;
      tickIdx++;
    }

    if (open == null) {
      // No trades in this bucket; carry forward last close if we have it.
      if (prevClose == null) {
        // Still no price context; skip until we get our first trade.
        continue;
      }
      open = prevClose;
      high = prevClose;
      low = prevClose;
      close = prevClose;
    }

    prevClose = close!;
    candles.push({ time: bucket, open: open!, high: high!, low: low!, close: close! });

    // If bucket had no ticks, tickIdx didn't move; ensure we don't get stuck (we won't, since bucket increments)
    if (firstIdx === tickIdx) {
      // noop
    }
  }

  return candles;
}

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
   * GET /markets/candles
   * Return aggregated candles (default 5s) for charting.
   * Uses Redis tick history; best-effort backfills from Coinbase REST trades if needed.
   */
  app.get('/candles', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = candlesQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid query parameters',
          details: query.error.flatten(),
        },
      });
    }

    const { asset, intervalSec, lookbackSec } = query.data;
    const endMs = Date.now();
    const startMs = endMs - lookbackSec * 1000;

    const key = RedisKeys.ticks(asset);
    let ticks: Array<{ ts: number; price: number }> = [];

    try {
      const raw = await redis.zrangebyscore(key, startMs, endMs, 'WITHSCORES');
      for (let i = 0; i < raw.length; i += 2) {
        const member = raw[i];
        const score = Number(raw[i + 1]);
        const price = Number(String(member).split(':')[0]);
        if (!Number.isFinite(score) || !Number.isFinite(price)) continue;
        ticks.push({ ts: score, price });
      }
      ticks.sort((a, b) => a.ts - b.ts);
    } catch {
      // ignore
    }

    // Backfill if we have too little data (common after restart)
    if (ticks.length < 200) {
      const productId = asset === 'BTC' ? 'BTC-USD' : asset === 'ETH' ? 'ETH-USD' : 'SOL-USD';
      try {
        const backfilled = await fetchCoinbaseTradesTicks({ productId, startMs, endMs });
        if (backfilled.length > 0) {
          ticks = backfilled;
          // Best-effort seed Redis so subsequent requests are cheap
          try {
            const pipeline = redis.pipeline();
            for (const t of backfilled) {
              pipeline.zadd(key, String(t.ts), `${t.price}:${Math.random().toString(36).slice(2)}`);
            }
            pipeline.zremrangebyscore(key, 0, endMs - 6 * 60 * 60 * 1000);
            await pipeline.exec();
          } catch {
            // ignore
          }
        }
      } catch (e: any) {
        logger.warn(`Failed to backfill candles from Coinbase trades for ${asset}: ${e?.message || e}`);
      }
    }

    const candles = buildCandlesFromTicks({ ticks, intervalSec, startMs, endMs });
    return { asset, intervalSec, candles };
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
