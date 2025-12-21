import { eq, and, lte, or } from 'drizzle-orm';
import { db, orders, markets } from '../db/index.js';
import { orderService } from '../services/order.service.js';
import { orderbookService } from '../services/orderbook.service.js';
import { marketService } from '../services/market.service.js';
import { logger, orderLogger, logEvents } from '../lib/logger.js';
import { broadcastOrderbookUpdate } from '../lib/broadcasts.js';

/**
 * Order Expirer Job
 * 
 * Handles order expiration:
 * 1. Cancel orders 2 seconds before market close
 * 2. Cancel GTT (Good-Till-Time) orders that have expired
 * 3. Reject new orders for markets closing soon
 */

// Time before market expiry to start cancelling orders
const MARKET_CLOSE_BUFFER_MS = 2 * 1000; // 2 seconds

export async function orderExpirerJob(): Promise<void> {
  const now = new Date();
  
  // 1. Cancel orders for markets about to close
  await cancelOrdersForClosingMarkets(now);
  
  // 2. Cancel expired GTT orders
  await cancelExpiredOrders(now);
}

/**
 * Cancel all orders for markets that are about to close
 */
async function cancelOrdersForClosingMarkets(now: Date): Promise<void> {
  const closeTime = new Date(now.getTime() + MARKET_CLOSE_BUFFER_MS);
  
  // Get markets expiring soon
  const expiringMarkets = await marketService.getExpiringMarkets(
    MARKET_CLOSE_BUFFER_MS / 1000 / 60 // Convert to minutes
  );
  
  for (const market of expiringMarkets) {
    try {
      // Get count of open orders
      const { orders: openOrders } = await orderService.getUserOrders('', {
        marketId: market.id,
        status: 'OPEN',
        limit: 1000,
      });
      
      if (openOrders.length === 0) continue;
      
      orderLogger.info(`Cancelling orders for closing market`, {
        marketId: market.id,
        asset: market.asset,
        timeframe: market.timeframe,
        orderCount: openOrders.length,
        secondsToExpiry: Math.round((market.expiryAt.getTime() - now.getTime()) / 1000),
      });
      
      // Cancel all orders for this market
      for (const order of openOrders) {
        if (order.userId) {
          // Remove from orderbook
          const orderbookOrder = {
            id: order.id,
            marketId: order.marketId!,
            userId: order.userId,
            side: order.side as 'BID' | 'ASK',
            outcome: order.outcome as 'YES' | 'NO',
            price: parseFloat(order.price),
            size: parseFloat(order.size),
            remainingSize: parseFloat(order.remainingSize || '0'),
            createdAt: order.createdAt?.getTime() || Date.now(),
          };
          
          await orderbookService.removeOrder(orderbookOrder);
        }
        
        // Update database
        await orderService.cancel(order.id, 'MARKET_CLOSING');
      }
      
      // Broadcast orderbook update (empty book)
      const snapshot = await orderbookService.getSnapshot(market.id, 'YES');
      broadcastOrderbookUpdate(
        market.id,
        snapshot.bids.map(l => [l.price, l.size] as [number, number]),
        snapshot.asks.map(l => [l.price, l.size] as [number, number]),
        snapshot.sequenceId
      );
      
    } catch (err: any) {
      logger.error(`Failed to cancel orders for closing market ${market.id} (${market.asset}-${market.timeframe}): ${err.message}`);
    }
  }
}

/**
 * Cancel orders that have passed their expiry time (GTT orders)
 */
async function cancelExpiredOrders(now: Date): Promise<void> {
  // Get expired orders from database
  const expiredOrders = await orderService.getExpiredOrders();
  
  if (expiredOrders.length === 0) return;
  
  orderLogger.info(`Cancelling expired orders`, { count: expiredOrders.length });
  
  // Group by market for efficient orderbook updates
  const ordersByMarket = new Map<string, typeof expiredOrders>();
  
  for (const order of expiredOrders) {
    const marketId = order.marketId!;
    if (!ordersByMarket.has(marketId)) {
      ordersByMarket.set(marketId, []);
    }
    ordersByMarket.get(marketId)!.push(order);
  }
  
  // Process each market
  for (const [marketId, marketOrders] of ordersByMarket) {
    for (const order of marketOrders) {
      try {
        // Remove from orderbook
        const orderbookOrder = {
          id: order.id,
          marketId: order.marketId!,
          userId: order.userId!,
          side: order.side as 'BID' | 'ASK',
          outcome: order.outcome as 'YES' | 'NO',
          price: parseFloat(order.price),
          size: parseFloat(order.size),
          remainingSize: parseFloat(order.remainingSize || '0'),
          createdAt: order.createdAt?.getTime() || Date.now(),
        };
        
        await orderbookService.removeOrder(orderbookOrder);
        
        // Update database
        await orderService.cancel(order.id, 'EXPIRED');
        
      } catch (err: any) {
        logger.error(`Failed to cancel expired order ${order.id} (market=${order.marketId}): ${err.message}`);
      }
    }
    
    // Broadcast orderbook update for this market
    try {
      const firstOrder = marketOrders[0];
      if (firstOrder?.outcome) {
        const snapshot = await orderbookService.getSnapshot(
          marketId,
          firstOrder.outcome as 'YES' | 'NO'
        );
        broadcastOrderbookUpdate(
          marketId,
          snapshot.bids.map(l => [l.price, l.size] as [number, number]),
          snapshot.asks.map(l => [l.price, l.size] as [number, number]),
          snapshot.sequenceId
        );
      }
    } catch (err) {
      logger.error(`Failed to broadcast orderbook update for market ${marketId}:`, err);
    }
  }
}

