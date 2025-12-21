import { redis, RedisKeys } from '../db/redis.js';
import { logger } from '../lib/logger.js';

/**
 * Orderbook Service
 * 
 * Manages the in-memory (Redis) orderbook for fast order matching.
 * Uses Redis sorted sets for O(log N) insert/remove operations.
 * 
 * Data Structure:
 * - orderbook:{marketId}:{outcome}:{side} -> Sorted Set (score = price, member = orderId:size)
 * - order:{orderId} -> Hash (full order details)
 * - sequence:{marketId} -> Counter for orderbook updates
 */

export interface OrderbookOrder {
  id: string;
  marketId: string;
  userId: string;
  side: 'BID' | 'ASK';
  outcome: 'YES' | 'NO';
  orderType?: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';  // Order type for special handling
  price: number;        // 0.01 - 0.99
  size: number;         // Original size
  remainingSize: number;
  createdAt: number;    // Timestamp for time priority
  clientOrderId?: number; // For on-chain execution
  expiresAt?: number;     // Order expiry timestamp
  signature?: string;     // Ed25519 signature for on-chain verification
  binaryMessage?: string; // Base64 encoded binary message that was signed
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

// Price conversion: We store prices as integers (multiply by 1M for precision)
const PRICE_MULTIPLIER = 1000000;

export class OrderbookService {
  /**
   * Add an order to the orderbook
   */
  async addOrder(order: OrderbookOrder): Promise<{ sequenceId: number }> {
    const key = RedisKeys.orderbook(order.marketId, order.outcome, order.side);
    const orderKey = `order:${order.id}`;
    
    // Store full order details
    await redis.hset(orderKey, {
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
    
    // Set expiry on order hash (24 hours - orders shouldn't live longer)
    await redis.expire(orderKey, 86400);
    
    // Add to sorted set
    // Score = price (for BID: negative so highest is first, for ASK: positive so lowest is first)
    // Member = orderId:remainingSize:createdAt (for tie-breaking by time)
    const score = order.side === 'BID' 
      ? -(order.price * PRICE_MULTIPLIER)  // Negative for descending order
      : order.price * PRICE_MULTIPLIER;
    
    const member = `${order.id}:${order.remainingSize}:${order.createdAt}`;
    
    await redis.zadd(key, score, member);
    
    // Increment sequence ID
    const sequenceId = await this.incrementSequence(order.marketId);
    
    logger.debug(`Added order ${order.id} to orderbook at price ${order.price}`);
    
    return { sequenceId };
  }

  /**
   * Remove an order from the orderbook
   */
  async removeOrder(order: OrderbookOrder): Promise<{ sequenceId: number }> {
    const key = RedisKeys.orderbook(order.marketId, order.outcome, order.side);
    const orderKey = `order:${order.id}`;
    
    // Find and remove the order from sorted set
    // We need to find it first since member includes size and timestamp
    const members = await redis.zrange(key, 0, -1);
    const memberToRemove = members.find(m => m.startsWith(`${order.id}:`));
    
    if (memberToRemove) {
      await redis.zrem(key, memberToRemove);
    }
    
    // Remove order hash
    await redis.del(orderKey);
    
    // Increment sequence ID
    const sequenceId = await this.incrementSequence(order.marketId);
    
    logger.debug(`Removed order ${order.id} from orderbook`);
    
    return { sequenceId };
  }

  /**
   * Update order size in the orderbook (after partial fill)
   */
  async updateOrderSize(
    order: OrderbookOrder, 
    newRemainingSize: number
  ): Promise<{ sequenceId: number }> {
    const key = RedisKeys.orderbook(order.marketId, order.outcome, order.side);
    const orderKey = `order:${order.id}`;
    
    // Find and remove old entry
    const members = await redis.zrange(key, 0, -1);
    const oldMember = members.find(m => m.startsWith(`${order.id}:`));
    
    if (oldMember) {
      await redis.zrem(key, oldMember);
    }
    
    if (newRemainingSize > 0) {
      // Add updated entry
      const score = order.side === 'BID'
        ? -(order.price * PRICE_MULTIPLIER)
        : order.price * PRICE_MULTIPLIER;
      
      const newMember = `${order.id}:${newRemainingSize}:${order.createdAt}`;
      await redis.zadd(key, score, newMember);
      
      // Update order hash
      await redis.hset(orderKey, 'remainingSize', newRemainingSize.toString());
    } else {
      // Fully filled - remove order hash
      await redis.del(orderKey);
    }
    
    const sequenceId = await this.incrementSequence(order.marketId);
    
    return { sequenceId };
  }

  /**
   * Get the best bid (highest buy price)
   */
  async getBestBid(marketId: string, outcome: 'YES' | 'NO'): Promise<OrderbookOrder | null> {
    const key = RedisKeys.orderbook(marketId, outcome, 'BID');
    
    // Get first element (highest bid due to negative scoring)
    const results = await redis.zrange(key, 0, 0, 'WITHSCORES');
    
    if (results.length < 2) return null;
    
    const [member, scoreStr] = results;
    const [orderId] = member.split(':');
    
    return this.getOrderFromHash(orderId);
  }

  /**
   * Get the best ask (lowest sell price)
   */
  async getBestAsk(marketId: string, outcome: 'YES' | 'NO'): Promise<OrderbookOrder | null> {
    const key = RedisKeys.orderbook(marketId, outcome, 'ASK');
    
    // Get first element (lowest ask)
    const results = await redis.zrange(key, 0, 0, 'WITHSCORES');
    
    if (results.length < 2) return null;
    
    const [member] = results;
    const [orderId] = member.split(':');
    
    return this.getOrderFromHash(orderId);
  }

  /**
   * Get all orders at a price level (for matching)
   */
  async getOrdersAtPrice(
    marketId: string,
    outcome: 'YES' | 'NO',
    side: 'BID' | 'ASK',
    price: number
  ): Promise<OrderbookOrder[]> {
    const key = RedisKeys.orderbook(marketId, outcome, side);
    const score = side === 'BID' 
      ? -(price * PRICE_MULTIPLIER)
      : price * PRICE_MULTIPLIER;
    
    // Get all orders at this exact price
    const members = await redis.zrangebyscore(key, score, score);
    
    const orders: OrderbookOrder[] = [];
    for (const member of members) {
      const [orderId] = member.split(':');
      const order = await this.getOrderFromHash(orderId);
      if (order) {
        orders.push(order);
      }
    }
    
    // Sort by time (oldest first for FIFO)
    orders.sort((a, b) => a.createdAt - b.createdAt);
    
    return orders;
  }

  /**
   * Get orderbook snapshot for a market
   */
  async getSnapshot(marketId: string, outcome: 'YES' | 'NO'): Promise<OrderbookSnapshot> {
    const [bids, asks, sequenceId] = await Promise.all([
      this.getAggregatedLevels(marketId, outcome, 'BID'),
      this.getAggregatedLevels(marketId, outcome, 'ASK'),
      this.getSequence(marketId),
    ]);
    
    return {
      marketId,
      outcome,
      bids,
      asks,
      sequenceId,
    };
  }

  /**
   * Get aggregated price levels
   */
  private async getAggregatedLevels(
    marketId: string,
    outcome: 'YES' | 'NO',
    side: 'BID' | 'ASK'
  ): Promise<OrderbookLevel[]> {
    const key = RedisKeys.orderbook(marketId, outcome, side);
    
    // Get all orders with scores
    const results = await redis.zrange(key, 0, -1, 'WITHSCORES');
    
    // Aggregate by price level
    const levels = new Map<number, { size: number; count: number }>();
    
    for (let i = 0; i < results.length; i += 2) {
      const member = results[i];
      const scoreStr = results[i + 1];
      
      const [, sizeStr] = member.split(':');
      const size = parseFloat(sizeStr);
      const price = Math.abs(parseFloat(scoreStr)) / PRICE_MULTIPLIER;
      
      const existing = levels.get(price) || { size: 0, count: 0 };
      existing.size += size;
      existing.count += 1;
      levels.set(price, existing);
    }
    
    // Convert to array and sort
    const levelArray: OrderbookLevel[] = [];
    for (const [price, data] of levels) {
      levelArray.push({
        price,
        size: data.size,
        orderCount: data.count,
      });
    }
    
    // Sort: BID descending, ASK ascending
    if (side === 'BID') {
      levelArray.sort((a, b) => b.price - a.price);
    } else {
      levelArray.sort((a, b) => a.price - b.price);
    }
    
    return levelArray;
  }

  /**
   * Get order details from hash
   */
  private async getOrderFromHash(orderId: string): Promise<OrderbookOrder | null> {
    const orderKey = `order:${orderId}`;
    const data = await redis.hgetall(orderKey);
    
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    
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

  /**
   * Increment and get sequence ID
   */
  private async incrementSequence(marketId: string): Promise<number> {
    const key = RedisKeys.sequence(marketId);
    return redis.incr(key);
  }

  /**
   * Get current sequence ID
   */
  async getSequence(marketId: string): Promise<number> {
    const key = RedisKeys.sequence(marketId);
    const value = await redis.get(key);
    return value ? parseInt(value) : 0;
  }

  /**
   * Clear orderbook for a market (used at market close)
   */
  async clearOrderbook(marketId: string): Promise<void> {
    const patterns = [
      RedisKeys.orderbook(marketId, 'YES', 'BID'),
      RedisKeys.orderbook(marketId, 'YES', 'ASK'),
      RedisKeys.orderbook(marketId, 'NO', 'BID'),
      RedisKeys.orderbook(marketId, 'NO', 'ASK'),
    ];
    
    for (const key of patterns) {
      // Get all order IDs first
      const members = await redis.zrange(key, 0, -1);
      for (const member of members) {
        const [orderId] = member.split(':');
        await redis.del(`order:${orderId}`);
      }
      await redis.del(key);
    }
    
    logger.info(`Cleared orderbook for market ${marketId}`);
  }
}

export const orderbookService = new OrderbookService();


