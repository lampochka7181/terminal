import { redis, RedisKeys } from '../db/redis.js';
import { logger } from '../lib/logger.js';
import { redisMetrics, startTimer } from '../metrics/index.js';

/**
 * Orderbook Service (v2 - O(log N) hot path)
 * 
 * Redesigned Redis data model:
 *   ZSET  ob:{marketId}:{outcome}:{side}        member = orderId (stable), score = price
 *   HASH  order:{orderId}                        full order details
 *   HASH  levels:{marketId}:{outcome}:{side}     pre-aggregated price levels
 *         field = priceKey (integer), value = "totalSize:orderCount"
 *   KEY   sequence:{marketId}                    monotonic counter for delta sync
 *
 * Key improvements over v1:
 *   - removeOrder()     O(log N) via ZREM orderId  (was O(N) full scan)
 *   - updateOrderSize() O(1) hash update + level adjust  (was O(N) full scan)
 *   - getSnapshot()     O(levels) from pre-aggregated hash  (was O(orders) full scan)
 */

export interface OrderbookOrder {
  id: string;
  marketId: string;
  userId: string;
  side: 'BID' | 'ASK';
  outcome: 'YES' | 'NO';
  orderType?: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
  price: number;        // 0.01 - 0.99
  size: number;         // Original size
  remainingSize: number;
  createdAt: number;    // Timestamp for time priority
  clientOrderId?: number;
  expiresAt?: number;
  signature?: string;
  binaryMessage?: string;
  leverage?: number;
  marginAmount?: number;
  loanAmount?: number;
}

export interface OrderbookLevel {
  price: number;
  size: number;
  orderCount: number;
}

export interface OrderbookSnapshot {
  marketId: string;
  outcome: 'YES' | 'NO';
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  sequenceId: number;
}

export interface OrderbookUpdate {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BID' | 'ASK';
  price: number;
  size: number;        // New total size at this price (0 = level removed)
  sequenceId: number;
}

// Price conversion: integers for precision
const PRICE_MULTIPLIER = 1000000;

// Lua script: atomically update a price level in the levels hash.
// Returns "newSize:newCount" or "0:0" if level was cleaned up.
const UPDATE_LEVEL_LUA = `
local sField = ARGV[1] .. ':s'
local cField = ARGV[1] .. ':c'
local newSize = redis.call('HINCRBYFLOAT', KEYS[1], sField, ARGV[2])
local newCount = redis.call('HINCRBY', KEYS[1], cField, ARGV[3])
newSize = tonumber(newSize)
newCount = tonumber(newCount)
if newCount <= 0 or newSize < 0.000001 then
  redis.call('HDEL', KEYS[1], sField, cField)
  return '0:0'
end
return tostring(newSize) .. ':' .. tostring(newCount)
`;

// ── Lua: atomic getBest (zrange + hgetall in one round-trip) ──
// KEYS[1] = ob ZSET key
// Returns: [orderId, score, field1, val1, field2, val2, ...]
// Returns empty table if no entries or all orphaned (cleans up to 20 orphans)
const GET_BEST_LUA = `
for i = 1, 20 do
  local res = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if #res < 2 then return {} end
  local orderId = res[1]
  local score = res[2]
  local orderKey = 'order:' .. orderId
  local data = redis.call('HGETALL', orderKey)
  if #data > 0 then
    -- Prepend orderId and score, then all hash fields
    local result = {orderId, score}
    for j = 1, #data do result[#result + 1] = data[j] end
    return result
  end
  -- Orphaned entry — remove and retry
  redis.call('ZREM', KEYS[1], orderId)
end
return {}
`;

// ── Lua: atomic consume (update/remove + level adjust + sequence incr) ──
// KEYS[1] = order hash key (order:{id})
// KEYS[2] = ob ZSET key
// KEYS[3] = levels hash key
// KEYS[4] = sequence key
// ARGV[1] = newRemainingSize (0 = full fill → remove)
// ARGV[2] = priceKey (for level update)
// Returns: sequenceId
const CONSUME_ORDER_LUA = `
local orderKey = KEYS[1]
local obKey = KEYS[2]
local lvlKey = KEYS[3]
local seqKey = KEYS[4]
local newRemaining = tonumber(ARGV[1])
local priceKey = ARGV[2]
local orderId = ARGV[3]

-- Read current remaining size for accurate delta
local oldSize = tonumber(redis.call('HGET', orderKey, 'remainingSize') or '0')
local sizeDelta = newRemaining - oldSize

if newRemaining > 0 then
  -- Partial fill: update hash only (ZSET member=orderId, no change needed)
  redis.call('HSET', orderKey, 'remainingSize', tostring(newRemaining))
else
  -- Full fill: remove from ZSET + delete hash
  redis.call('ZREM', obKey, orderId)
  redis.call('DEL', orderKey)
end

-- Adjust aggregated level
local countDelta = newRemaining > 0 and 0 or -1
local sField = priceKey .. ':s'
local cField = priceKey .. ':c'
local newLvlSize = redis.call('HINCRBYFLOAT', lvlKey, sField, sizeDelta)
local newLvlCount = redis.call('HINCRBY', lvlKey, cField, countDelta)
newLvlSize = tonumber(newLvlSize)
newLvlCount = tonumber(newLvlCount)
if newLvlCount <= 0 or newLvlSize < 0.000001 then
  redis.call('HDEL', lvlKey, sField, cField)
end

-- Increment sequence
local seq = redis.call('INCR', seqKey)
return seq
`;

function priceToKey(price: number): string {
  return Math.round(price * PRICE_MULTIPLIER).toString();
}

function keyToPrice(key: string): number {
  return parseInt(key) / PRICE_MULTIPLIER;
}

function scoreForSide(price: number, side: 'BID' | 'ASK'): number {
  const raw = price * PRICE_MULTIPLIER;
  return side === 'BID' ? -raw : raw;
}

function levelsKey(marketId: string, outcome: string, side: string): string {
  return `levels:${marketId}:${outcome}:${side}`;
}

export class OrderbookService {
  // ───────────────────────── mutations ─────────────────────────

  /**
   * Add an order to the orderbook.  O(log N) + O(1) level update.
   */
  async addOrder(order: OrderbookOrder): Promise<{ sequenceId: number }> {
    const timer = startTimer();
    const obKey = RedisKeys.orderbook(order.marketId, order.outcome, order.side);
    const orderKey = `order:${order.id}`;
    const lvlKey = levelsKey(order.marketId, order.outcome, order.side);
    const pk = priceToKey(order.price);

    const pipe = redis.pipeline();

    // 1. Store full order details in hash
    pipe.hset(orderKey, {
      id: order.id,
      marketId: order.marketId,
      userId: order.userId,
      side: order.side,
      outcome: order.outcome,
      price: order.price.toString(),
      size: order.size.toString(),
      remainingSize: order.remainingSize.toString(),
      createdAt: order.createdAt.toString(),
    });
    pipe.expire(orderKey, 86400);

    // 2. Add to sorted set (member = orderId, score = price)
    pipe.zadd(obKey, scoreForSide(order.price, order.side), order.id);

    // 3. Increment sequence
    pipe.incr(RedisKeys.sequence(order.marketId));

    await pipe.exec();

    // 4. Update aggregated level (atomic Lua)
    await redis.eval(
      UPDATE_LEVEL_LUA, 1, lvlKey,
      pk, order.remainingSize.toString(), '1',
    );

    const sequenceId = await this.getSequence(order.marketId);

    redisMetrics.orderbookOperations.inc({ operation: 'add' });
    redisMetrics.orderbookOperationDuration.observe({ operation: 'add' }, timer.elapsed());

    logger.debug(`Added order ${order.id} to orderbook at price ${order.price}`);
    return { sequenceId };
  }

  /**
   * Remove an order from the orderbook.  O(log N) via direct ZREM.
   */
  async removeOrder(order: OrderbookOrder): Promise<{ sequenceId: number }> {
    const timer = startTimer();
    const obKey = RedisKeys.orderbook(order.marketId, order.outcome, order.side);
    const orderKey = `order:${order.id}`;
    const lvlKey = levelsKey(order.marketId, order.outcome, order.side);

    // Read the order hash so we know the price & remaining size for the level update
    const orderData = await redis.hgetall(orderKey);
    const remainingSize = orderData?.remainingSize ? parseFloat(orderData.remainingSize) : order.remainingSize;
    const price = orderData?.price ? parseFloat(orderData.price) : order.price;
    const pk = priceToKey(price);

    const pipe = redis.pipeline();
    // 1. Remove from ZSET by orderId (O(log N) - no scan needed!)
    pipe.zrem(obKey, order.id);
    // 2. Delete order hash
    pipe.del(orderKey);
    // 3. Increment sequence
    pipe.incr(RedisKeys.sequence(order.marketId));
    await pipe.exec();

    // 4. Decrement aggregated level
    if (remainingSize > 0) {
      await redis.eval(
        UPDATE_LEVEL_LUA, 1, lvlKey,
        pk, (-remainingSize).toString(), '-1',
      );
    }

    const sequenceId = await this.getSequence(order.marketId);

    redisMetrics.orderbookOperations.inc({ operation: 'remove' });
    redisMetrics.orderbookOperationDuration.observe({ operation: 'remove' }, timer.elapsed());

    logger.debug(`Removed order ${order.id} from orderbook`);
    return { sequenceId };
  }

  /**
   * Update order size (after partial fill).
   * O(1) — no ZSET mutation needed because member is just orderId.
   */
  async updateOrderSize(
    order: OrderbookOrder,
    newRemainingSize: number,
  ): Promise<{ sequenceId: number }> {
    const timer = startTimer();
    const obKey = RedisKeys.orderbook(order.marketId, order.outcome, order.side);
    const orderKey = `order:${order.id}`;
    const lvlKey = levelsKey(order.marketId, order.outcome, order.side);
    const pk = priceToKey(order.price);

    // Read current remaining size from hash for accurate delta
    const oldSizeStr = await redis.hget(orderKey, 'remainingSize');
    const oldSize = oldSizeStr ? parseFloat(oldSizeStr) : order.remainingSize;
    const sizeDelta = newRemainingSize - oldSize;

    if (newRemainingSize > 0) {
      // Update hash only — ZSET member is orderId so no change needed
      await redis.hset(orderKey, 'remainingSize', newRemainingSize.toString());
    } else {
      // Fully filled — remove from ZSET and delete hash
      const pipe = redis.pipeline();
      pipe.zrem(obKey, order.id);
      pipe.del(orderKey);
      await pipe.exec();
    }

    // Adjust aggregated level
    const countDelta = newRemainingSize > 0 ? 0 : -1;
    await redis.eval(
      UPDATE_LEVEL_LUA, 1, lvlKey,
      pk, sizeDelta.toString(), countDelta.toString(),
    );

    const sequenceId = await redis.incr(RedisKeys.sequence(order.marketId));

    redisMetrics.orderbookOperations.inc({ operation: 'update' });
    redisMetrics.orderbookOperationDuration.observe({ operation: 'update' }, timer.elapsed());

    return { sequenceId };
  }

  // ───────────────────────── queries ──────────────────────────

  /**
   * Get the best bid (highest buy price).
   * Uses atomic Lua script: ZRANGE + HGETALL in 1 round-trip (was 2+).
   * Auto-cleans up to 20 orphaned ZSET entries.
   */
  async getBestBid(marketId: string, outcome: 'YES' | 'NO'): Promise<OrderbookOrder | null> {
    const key = RedisKeys.orderbook(marketId, outcome, 'BID');
    return this.getBestAtomic(key);
  }

  /**
   * Get the best ask (lowest sell price).
   * Uses atomic Lua script: ZRANGE + HGETALL in 1 round-trip (was 2+).
   */
  async getBestAsk(marketId: string, outcome: 'YES' | 'NO'): Promise<OrderbookOrder | null> {
    const key = RedisKeys.orderbook(marketId, outcome, 'ASK');
    return this.getBestAtomic(key);
  }

  /**
   * Atomic getBest using Lua (1 round-trip instead of 2+ per fill).
   */
  private async getBestAtomic(obKey: string): Promise<OrderbookOrder | null> {
    const result = await redis.eval(GET_BEST_LUA, 1, obKey) as string[];
    if (!result || result.length < 4) return null; // [orderId, score, ...hashFields]

    // Parse: result = [orderId, score, field1, val1, field2, val2, ...]
    const data: Record<string, string> = {};
    for (let i = 2; i < result.length; i += 2) {
      data[result[i]] = result[i + 1];
    }
    if (!data.id) return null;

    return {
      id: data.id,
      marketId: data.marketId,
      userId: data.userId,
      side: data.side as 'BID' | 'ASK',
      outcome: data.outcome as 'YES' | 'NO',
      price: parseFloat(data.price),
      size: parseFloat(data.size),
      remainingSize: parseFloat(data.remainingSize),
      createdAt: parseInt(data.createdAt),
      clientOrderId: data.clientOrderId ? parseInt(data.clientOrderId) : undefined,
      signature: data.signature || undefined,
      binaryMessage: data.binaryMessage || undefined,
    };
  }

  /**
   * Atomic consume: update/remove order + level adjust + sequence incr in 1 round-trip.
   * Replaces the separate updateOrderSize/removeOrder calls in the matching hot path.
   */
  async consumeOrder(
    order: OrderbookOrder,
    newRemainingSize: number,
  ): Promise<{ sequenceId: number }> {
    const timer = startTimer();
    const orderKey = `order:${order.id}`;
    const obKey = RedisKeys.orderbook(order.marketId, order.outcome, order.side);
    const lvlKey = levelsKey(order.marketId, order.outcome, order.side);
    const seqKey = RedisKeys.sequence(order.marketId);
    const pk = priceToKey(order.price);

    const sequenceId = await redis.eval(
      CONSUME_ORDER_LUA, 4,
      orderKey, obKey, lvlKey, seqKey,
      newRemainingSize.toString(), pk, order.id,
    ) as number;

    const op = newRemainingSize > 0 ? 'update' : 'remove';
    redisMetrics.orderbookOperations.inc({ operation: op });
    redisMetrics.orderbookOperationDuration.observe({ operation: op }, timer.elapsed());

    return { sequenceId };
  }

  /**
   * Get all orders at a price level (for matching).
   */
  async getOrdersAtPrice(
    marketId: string,
    outcome: 'YES' | 'NO',
    side: 'BID' | 'ASK',
    price: number,
  ): Promise<OrderbookOrder[]> {
    const key = RedisKeys.orderbook(marketId, outcome, side);
    const score = scoreForSide(price, side);

    const members = await redis.zrangebyscore(key, score, score);

    const orders: OrderbookOrder[] = [];
    for (const orderId of members) {
      const order = await this.getOrderFromHash(orderId);
      if (order) orders.push(order);
    }

    // FIFO: oldest first
    orders.sort((a, b) => a.createdAt - b.createdAt);
    return orders;
  }

  /**
   * Get orderbook snapshot from pre-aggregated levels.
   * O(levels) — no longer scans every individual order.
   */
  async getSnapshot(marketId: string, outcome: 'YES' | 'NO'): Promise<OrderbookSnapshot> {
    const timer = startTimer();
    const [bids, asks, sequenceId] = await Promise.all([
      this.getAggregatedLevels(marketId, outcome, 'BID'),
      this.getAggregatedLevels(marketId, outcome, 'ASK'),
      this.getSequence(marketId),
    ]);

    redisMetrics.orderbookOperations.inc({ operation: 'snapshot' });
    redisMetrics.orderbookOperationDuration.observe({ operation: 'snapshot' }, timer.elapsed());

    return { marketId, outcome, bids, asks, sequenceId };
  }

  /**
   * Get aggregated price levels from pre-computed hash.
   * O(levels) instead of O(orders).
   */
  private async getAggregatedLevels(
    marketId: string,
    outcome: 'YES' | 'NO',
    side: 'BID' | 'ASK',
  ): Promise<OrderbookLevel[]> {
    const lvlKey = levelsKey(marketId, outcome, side);
    const raw = await redis.hgetall(lvlKey);

    // Parse fields: each price has two fields  "{priceKey}:s" and "{priceKey}:c"
    const map = new Map<string, { size: number; count: number }>();
    for (const [field, value] of Object.entries(raw)) {
      const colonIdx = field.lastIndexOf(':');
      if (colonIdx === -1) continue;
      const pk = field.slice(0, colonIdx);
      const suffix = field.slice(colonIdx + 1);

      let entry = map.get(pk);
      if (!entry) { entry = { size: 0, count: 0 }; map.set(pk, entry); }

      if (suffix === 's') entry.size = parseFloat(value);
      else if (suffix === 'c') entry.count = parseInt(value);
    }

    const levels: OrderbookLevel[] = [];
    for (const [pk, data] of map) {
      if (data.count > 0 && data.size > 0.000001) {
        levels.push({
          price: keyToPrice(pk),
          size: data.size,
          orderCount: data.count,
        });
      }
    }

    // Sort: BID descending, ASK ascending
    if (side === 'BID') {
      levels.sort((a, b) => b.price - a.price);
    } else {
      levels.sort((a, b) => a.price - b.price);
    }

    return levels;
  }

  // ───────────────────────── helpers ──────────────────────────

  /**
   * Get order details from hash.
   */
  private async getOrderFromHash(orderId: string): Promise<OrderbookOrder | null> {
    const data = await redis.hgetall(`order:${orderId}`);
    if (!data || Object.keys(data).length === 0) return null;

    return {
      id: data.id,
      marketId: data.marketId,
      userId: data.userId,
      side: data.side as 'BID' | 'ASK',
      outcome: data.outcome as 'YES' | 'NO',
      price: parseFloat(data.price),
      size: parseFloat(data.size),
      remainingSize: parseFloat(data.remainingSize),
      createdAt: parseInt(data.createdAt),
    };
  }

  /** Get current sequence ID */
  async getSequence(marketId: string): Promise<number> {
    const val = await redis.get(RedisKeys.sequence(marketId));
    return val ? parseInt(val) : 0;
  }

  /** Increment and get sequence ID */
  private async incrementSequence(marketId: string): Promise<number> {
    return redis.incr(RedisKeys.sequence(marketId));
  }

  /**
   * Clear orderbook for a market (used at market close).
   * Also clears pre-aggregated levels.
   */
  async clearOrderbook(marketId: string): Promise<void> {
    const sides: Array<{ outcome: 'YES' | 'NO'; side: 'BID' | 'ASK' }> = [
      { outcome: 'YES', side: 'BID' },
      { outcome: 'YES', side: 'ASK' },
      { outcome: 'NO', side: 'BID' },
      { outcome: 'NO', side: 'ASK' },
    ];

    for (const { outcome, side } of sides) {
      const obKey = RedisKeys.orderbook(marketId, outcome, side);
      const lvlKey = levelsKey(marketId, outcome, side);

      // Get all orderIds from ZSET
      const orderIds = await redis.zrange(obKey, 0, -1);

      if (orderIds.length > 0) {
        // Batch-delete order hashes
        const pipe = redis.pipeline();
        for (const orderId of orderIds) {
          pipe.del(`order:${orderId}`);
        }
        await pipe.exec();
      }

      // Delete ZSET and levels hash
      await redis.del(obKey, lvlKey);
    }

    logger.info(`Cleared orderbook for market ${marketId}`);
  }
}

export const orderbookService = new OrderbookService();
