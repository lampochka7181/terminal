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
  sessionPublicKey?: string;
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

// ── Lua: batch fetch top N orders in 1 round-trip ──
// KEYS[1] = ob ZSET key
// ARGV[1] = N (max orders to fetch)
// Returns flat array: [orderId, score, fieldCount, f1, v1, f2, v2, ..., orderId2, ...]
// Cleans orphaned entries (ZSET member with missing hash) inline.
const BATCH_GET_TOP_N_LUA = `
local n = tonumber(ARGV[1])
local res = redis.call('ZRANGE', KEYS[1], 0, n - 1, 'WITHSCORES')
local result = {}
local orphans = {}
for i = 1, #res, 2 do
  local orderId = res[i]
  local score = res[i+1]
  local orderKey = 'order:' .. orderId
  local data = redis.call('HGETALL', orderKey)
  if #data > 0 then
    result[#result + 1] = orderId
    result[#result + 1] = score
    result[#result + 1] = tostring(#data / 2)
    for j = 1, #data do result[#result + 1] = data[j] end
  else
    orphans[#orphans + 1] = orderId
  end
end
for _, oid in ipairs(orphans) do
  redis.call('ZREM', KEYS[1], oid)
end
return result
`;

// ── Lua: batch consume multiple orders in 1 round-trip ──
// KEYS[1] = ob ZSET key
// KEYS[2] = levels hash key
// KEYS[3] = sequence key
// ARGV[1] = count of orders
// Then groups of 4: orderId, orderHashKey, newRemainingSize, priceKey
// Returns: [seq, consumed1, consumed2, ...] where consumed=1 means order was consumed, 0=already gone
const BATCH_CONSUME_LUA = `
local obKey = KEYS[1]
local lvlKey = KEYS[2]
local seqKey = KEYS[3]
local count = tonumber(ARGV[1])
local result = {}

for i = 0, count - 1 do
  local base = 2 + i * 4
  local orderId = ARGV[base]
  local orderKey = ARGV[base + 1]
  local newRemaining = tonumber(ARGV[base + 2])
  local priceKey = ARGV[base + 3]

  local oldSize = tonumber(redis.call('HGET', orderKey, 'remainingSize') or '0')
  if oldSize == 0 then
    -- Order already consumed by another instance — skip
    result[#result + 1] = 0
  else
    local sizeDelta = newRemaining - oldSize

    if newRemaining > 0 then
      redis.call('HSET', orderKey, 'remainingSize', tostring(newRemaining))
    else
      redis.call('ZREM', obKey, orderId)
      redis.call('DEL', orderKey)
    end

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
    result[#result + 1] = 1
  end
end

local seq = redis.call('INCR', seqKey)
-- Prepend sequence ID to results
table.insert(result, 1, seq)
return result
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
      orderType: order.orderType || 'LIMIT',
      price: order.price.toString(),
      size: order.size.toString(),
      remainingSize: order.remainingSize.toString(),
      createdAt: order.createdAt.toString(),
      clientOrderId: order.clientOrderId?.toString() || '',
      expiresAt: order.expiresAt?.toString() || '',
      signature: order.signature || '',
      binaryMessage: order.binaryMessage || '',
      sessionPublicKey: order.sessionPublicKey || '',
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

  /**
   * Batch-fetch top N orders from one side of the book in 1 Redis round-trip.
   * Used by batch-matching to replace per-fill getBestAsk/getBestBid calls.
   * Cleans orphaned ZSET entries (missing hash) inline.
   */
  async getTopN(
    marketId: string,
    outcome: 'YES' | 'NO',
    side: 'BID' | 'ASK',
    n: number = 64,
  ): Promise<OrderbookOrder[]> {
    const timer = startTimer();
    const obKey = RedisKeys.orderbook(marketId, outcome, side);

    const result = await redis.eval(BATCH_GET_TOP_N_LUA, 1, obKey, n.toString()) as string[];
    if (!result || result.length === 0) return [];

    const orders: OrderbookOrder[] = [];
    let i = 0;
    while (i < result.length) {
      const orderId = result[i++];
      const _score = result[i++];   // score from ZSET (not needed — price is in hash)
      const fieldCount = parseInt(result[i++]);

      // Parse hash fields: fieldCount pairs of (key, value)
      const data: Record<string, string> = {};
      for (let f = 0; f < fieldCount; f++) {
        const key = result[i++];
        const val = result[i++];
        data[key] = val;
      }

      if (!data.id) continue; // safety

      orders.push({
        id: data.id || orderId,
        marketId: data.marketId,
        userId: data.userId,
        side: data.side as 'BID' | 'ASK',
        outcome: data.outcome as 'YES' | 'NO',
        orderType: data.orderType as 'LIMIT' | 'MARKET' | 'IOC' | 'FOK' | undefined,
        price: parseFloat(data.price),
        size: parseFloat(data.size),
        remainingSize: parseFloat(data.remainingSize),
        createdAt: parseInt(data.createdAt),
        clientOrderId: data.clientOrderId ? parseInt(data.clientOrderId) : undefined,
        expiresAt: data.expiresAt ? parseInt(data.expiresAt) : undefined,
        signature: data.signature || undefined,
        binaryMessage: data.binaryMessage || undefined,
        sessionPublicKey: data.sessionPublicKey || undefined,
      });
    }

    redisMetrics.orderbookOperations.inc({ operation: 'getTopN' });
    redisMetrics.orderbookOperationDuration.observe({ operation: 'getTopN' }, timer.elapsed());

    return orders;
  }

  /**
   * Batch-consume multiple orders in 1 Redis round-trip.
   * Handles race conditions: if another instance consumed an order between
   * getTopN() and batchConsume(), that order returns consumed=false.
   *
   * @param consumptions Array of {order, newRemainingSize} for each fill
   * @returns sequenceId and consumed[] bitmap (true = successfully consumed)
   */
  async batchConsume(
    marketId: string,
    outcome: 'YES' | 'NO',
    side: 'BID' | 'ASK',
    consumptions: Array<{ order: OrderbookOrder; newRemainingSize: number }>,
  ): Promise<{ sequenceId: number; consumed: boolean[] }> {
    if (consumptions.length === 0) {
      const seq = await this.getSequence(marketId);
      return { sequenceId: seq, consumed: [] };
    }

    const timer = startTimer();
    const obKey = RedisKeys.orderbook(marketId, outcome, side);
    const lvlKey = levelsKey(marketId, outcome, side);
    const seqKey = RedisKeys.sequence(marketId);

    // Build ARGV: [count, orderId1, orderHashKey1, newRemaining1, priceKey1, ...]
    const args: string[] = [consumptions.length.toString()];
    for (const { order, newRemainingSize } of consumptions) {
      args.push(
        order.id,
        `order:${order.id}`,
        Math.max(0, newRemainingSize).toString(),
        priceToKey(order.price),
      );
    }

    const result = await redis.eval(
      BATCH_CONSUME_LUA, 3,
      obKey, lvlKey, seqKey,
      ...args,
    ) as number[];

    // result = [sequenceId, consumed1, consumed2, ...]
    const sequenceId = result[0];
    const consumed = result.slice(1).map(v => v === 1);

    redisMetrics.orderbookOperations.inc({ operation: 'batchConsume' });
    redisMetrics.orderbookOperationDuration.observe({ operation: 'batchConsume' }, timer.elapsed());

    return { sequenceId, consumed };
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
      orderType: data.orderType as 'LIMIT' | 'MARKET' | 'IOC' | 'FOK' | undefined,
      price: parseFloat(data.price),
      size: parseFloat(data.size),
      remainingSize: parseFloat(data.remainingSize),
      createdAt: parseInt(data.createdAt),
      clientOrderId: data.clientOrderId ? parseInt(data.clientOrderId) : undefined,
      expiresAt: data.expiresAt ? parseInt(data.expiresAt) : undefined,
      signature: data.signature || undefined,
      binaryMessage: data.binaryMessage || undefined,
      sessionPublicKey: data.sessionPublicKey || undefined,
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
   * Get composite YES snapshot that merges both YES and NO orderbooks.
   *
   * SINGLE ORDERBOOK MODEL:
   * - NO BID @ p  → YES ASK @ (1-p)  (buying NO ≡ selling YES)
   * - NO ASK @ p  → YES BID @ (1-p)  (selling NO ≡ buying YES)
   *
   * This ensures the frontend always receives a unified YES view
   * regardless of whether orders were placed for YES or NO outcome.
   */
  async getCompositeSnapshot(marketId: string): Promise<OrderbookSnapshot> {
    const [yesSnap, noSnap] = await Promise.all([
      this.getSnapshot(marketId, 'YES'),
      this.getSnapshot(marketId, 'NO'),
    ]);

    // If no NO orders, return YES snapshot directly (common case)
    if (noSnap.bids.length === 0 && noSnap.asks.length === 0) {
      return yesSnap;
    }

    // Merge NO into YES at complement prices
    const compositeBids = this.mergeLevels(
      yesSnap.bids,
      noSnap.asks.map(l => ({
        price: Math.round((1 - l.price) * 100) / 100,
        size: l.size,
        orderCount: l.orderCount,
      }))
    );

    const compositeAsks = this.mergeLevels(
      yesSnap.asks,
      noSnap.bids.map(l => ({
        price: Math.round((1 - l.price) * 100) / 100,
        size: l.size,
        orderCount: l.orderCount,
      }))
    );

    // Sort: bids descending, asks ascending
    compositeBids.sort((a, b) => b.price - a.price);
    compositeAsks.sort((a, b) => a.price - b.price);

    return {
      marketId,
      outcome: 'YES',
      bids: compositeBids,
      asks: compositeAsks,
      sequenceId: Math.max(yesSnap.sequenceId, noSnap.sequenceId),
    };
  }

  /**
   * Merge two level arrays, aggregating size at matching prices.
   */
  private mergeLevels(a: OrderbookLevel[], b: OrderbookLevel[]): OrderbookLevel[] {
    const priceMap = new Map<number, OrderbookLevel>();
    for (const level of a) {
      priceMap.set(level.price, { ...level });
    }
    for (const level of b) {
      const existing = priceMap.get(level.price);
      if (existing) {
        existing.size += level.size;
        existing.orderCount += level.orderCount;
      } else {
        priceMap.set(level.price, { ...level });
      }
    }
    return Array.from(priceMap.values());
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
