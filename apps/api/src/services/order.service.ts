import { eq, and, or, desc, sql, inArray } from 'drizzle-orm';
import { db, orders, markets, users, type Order, type NewOrder } from '../db/index.js';
import { logger } from '../lib/logger.js';

export type OrderSide = 'BID' | 'ASK';
export type OrderOutcome = 'YES' | 'NO';
export type OrderType = 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
export type OrderStatus = 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED';

export interface OrderWithMarket extends Order {
  market?: {
    pubkey: string;
    asset: string;
    timeframe: string;
  };
}

export class OrderService {
  /**
   * Get user's orders with optional filters
   */
  async getUserOrders(
    userId: string,
    options: {
      status?: OrderStatus | OrderStatus[] | 'all';
      marketId?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ orders: OrderWithMarket[]; total: number }> {
    const { status = 'all', marketId, limit = 20, offset = 0 } = options;
    
    // Build conditions
    const conditions: any[] = [eq(orders.userId, userId)];
    
    if (status !== 'all') {
      if (Array.isArray(status)) {
        conditions.push(inArray(orders.status, status));
      } else {
        conditions.push(eq(orders.status, status));
      }
    }
    if (marketId) {
      conditions.push(eq(orders.marketId, marketId));
    }
    
    // Get orders with market info
    const result = await db
      .select({
        order: orders,
        market: {
          pubkey: markets.pubkey,
          asset: markets.asset,
          timeframe: markets.timeframe,
        },
      })
      .from(orders)
      .leftJoin(markets, eq(orders.marketId, markets.id))
      .where(and(...conditions))
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset(offset);
    
    // Get total count
    const countResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(orders)
      .where(and(...conditions));
    
    return {
      orders: result.map((r) => ({
        ...r.order,
        market: r.market || undefined,
      })),
      total: Number(countResult[0]?.count || 0),
    };
  }

  /**
   * Get a specific order by ID
   */
  async getById(orderId: string): Promise<Order | null> {
    const result = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    
    return result[0] || null;
  }

  /**
   * Get open orders for a specific market and side
   */
  async getOpenOrders(marketId: string, outcome: OrderOutcome, side: OrderSide): Promise<Order[]> {
    const result = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.marketId, marketId),
          eq(orders.outcome, outcome),
          eq(orders.side, side),
          or(eq(orders.status, 'OPEN'), eq(orders.status, 'PARTIAL'))
        )
      )
      .orderBy(
        side === 'BID' ? desc(orders.price) : orders.price,
        orders.createdAt
      );
    
    return result;
  }

  /**
   * Create a new order
   */
  async create(data: NewOrder & { status?: OrderStatus, filledSize?: number }): Promise<Order> {
    const { status = 'OPEN', filledSize = 0, ...orderData } = data;
    const remainingSize = parseFloat(orderData.size) - filledSize;

    const [order] = await db
      .insert(orders)
      .values({
        ...orderData,
        status,
        filledSize: filledSize.toString(),
        remainingSize: Math.max(0, remainingSize).toString(),
      })
      .returning();
    
    logger.debug(`Order created: ${order.id} (${status})`);
    return order;
  }

  /**
   * Update order after partial fill
   */
  async updateAfterFill(orderId: string, filledAmount: number): Promise<Order | null> {
    const order = await this.getById(orderId);
    if (!order) return null;
    
    const currentFilled = parseFloat(order.filledSize || '0');
    const totalSize = parseFloat(order.size);
    const newFilled = currentFilled + filledAmount;
    const newRemaining = totalSize - newFilled;
    
    const newStatus: OrderStatus = newRemaining <= 0 ? 'FILLED' : 'PARTIAL';
    
    const [updated] = await db
      .update(orders)
      .set({
        filledSize: newFilled.toString(),
        remainingSize: Math.max(0, newRemaining).toString(),
        status: newStatus,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId))
      .returning();
    
    return updated;
  }

  /**
   * Cancel an order
   */
  async cancel(orderId: string, reason: string = 'USER'): Promise<Order | null> {
    const order = await this.getById(orderId);
    if (!order) return null;
    
    // Can only cancel open or partial orders
    if (order.status !== 'OPEN' && order.status !== 'PARTIAL') {
      return null;
    }
    
    const [cancelled] = await db
      .update(orders)
      .set({
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId))
      .returning();
    
    logger.debug(`Order cancelled: ${orderId} (${reason})`);
    return cancelled;
  }

  /**
   * Cancel all user's orders in a market
   */
  async cancelAllForUser(userId: string, marketId?: string): Promise<string[]> {
    const conditions: any[] = [
      eq(orders.userId, userId),
      or(eq(orders.status, 'OPEN'), eq(orders.status, 'PARTIAL')),
    ];
    
    if (marketId) {
      conditions.push(eq(orders.marketId, marketId));
    }
    
    const openOrders = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(...conditions));
    
    if (openOrders.length === 0) {
      return [];
    }
    
    const orderIds = openOrders.map((o) => o.id);
    
    await db
      .update(orders)
      .set({
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: 'USER_CANCEL_ALL',
        updatedAt: new Date(),
      })
      .where(inArray(orders.id, orderIds));
    
    logger.info(`Cancelled ${orderIds.length} orders for user ${userId}`);
    return orderIds;
  }

  /**
   * Cancel all open orders for a market (used at market close)
   */
  async cancelAllForMarket(marketId: string): Promise<number> {
    const openOrders = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.marketId, marketId),
          or(eq(orders.status, 'OPEN'), eq(orders.status, 'PARTIAL'))
        )
      );

    if (openOrders.length === 0) {
      return 0;
    }

    await db
      .update(orders)
      .set({
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: 'MARKET_CLOSED',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(orders.marketId, marketId),
          or(eq(orders.status, 'OPEN'), eq(orders.status, 'PARTIAL'))
        )
      );
    
    return openOrders.length;
  }

  /**
   * Get open user (non-MM) orders for a market to force-cancel on-chain at close.
   */
  async getOpenUserOrdersForMarket(marketId: string): Promise<Array<{ ownerWallet: string; clientOrderId: number }>> {
    const result = await db
      .select({
        ownerWallet: users.walletAddress,
        clientOrderId: orders.clientOrderId,
      })
      .from(orders)
      .innerJoin(users, eq(orders.userId, users.id))
      .where(
        and(
          eq(orders.marketId, marketId),
          eq(orders.isMmOrder, false),
          or(eq(orders.status, 'OPEN'), eq(orders.status, 'PARTIAL'))
        )
      );

    return result;
  }

  /**
   * Check for duplicate client order ID
   */
  async isDuplicateClientOrderId(userId: string, clientOrderId: number): Promise<boolean> {
    const result = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(eq(orders.userId, userId), eq(orders.clientOrderId, clientOrderId))
      )
      .limit(1);
    
    return result.length > 0;
  }

  /**
   * Get expired orders that need to be cancelled
   */
  async getExpiredOrders(): Promise<Order[]> {
    const now = new Date();
    
    const result = await db
      .select()
      .from(orders)
      .where(
        and(
          or(eq(orders.status, 'OPEN'), eq(orders.status, 'PARTIAL')),
          sql`${orders.expiresAt} IS NOT NULL`,
          sql`${orders.expiresAt} < ${now}`
        )
      );
    
    return result;
  }
}

export const orderService = new OrderService();


