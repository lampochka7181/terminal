import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { requireAuth, getCurrentUserId, getCurrentWallet } from '../lib/auth.js';
import { orderService } from '../services/order.service.js';
import { marketService } from '../services/market.service.js';
import { userService } from '../services/user.service.js';
import { positionService } from '../services/position.service.js';
import { matchingService } from '../services/matching.service.js';
import { logger, orderLogger, logEvents } from '../lib/logger.js';
import { config } from '../config.js';

// Validation schemas
const placeOrderSchema = z.object({
  marketAddress: z.string().min(32).max(44),
  side: z.enum(['bid', 'ask']),
  outcome: z.enum(['yes', 'no']),
  type: z.enum(['limit', 'market', 'ioc', 'fok']).default('limit'),
  price: z.number().min(0.01).max(0.99), // $0.01 - $0.99
  size: z.number().min(0.001).max(100000),
  expiry: z.number().optional(),
  clientOrderId: z.number().optional(),
  signature: z.string(),
  encodedInstruction: z.string(),
  binaryMessage: z.string().optional(),  // Base64 encoded binary message for on-chain verification
});

const cancelOrderSchema = z.object({
  signature: z.string(),
});

const cancelAllQuerySchema = z.object({
  marketAddress: z.string().optional(),
});

const orderIdSchema = z.object({
  id: z.string().uuid(),
});

export async function orderRoutes(app: FastifyInstance) {
  // Apply auth middleware to all routes
  app.addHook('preHandler', requireAuth);

  /**
   * POST /orders/notify
   * Fast mode order entry point (uses delegation)
   */
  const notifyOrderSchema = z.object({
    marketAddress: z.string().min(32).max(44),
    side: z.enum(['bid', 'ask']),
    outcome: z.enum(['yes', 'no']),
    type: z.enum(['limit', 'market', 'ioc', 'fok']).default('limit'),
    price: z.number().min(0.01).max(0.99),
    size: z.number().min(0.001).max(100000),
    expiry: z.number(),
    clientOrderId: z.number(),
    dollarAmount: z.number().min(1).max(1000000).optional(),
    maxPrice: z.number().min(0.01).max(0.99).optional(),
    signature: z.string(),
    binaryMessage: z.string(),
  });

  app.post('/notify', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    const wallet = getCurrentWallet(request);
    
    if (!userId || !wallet) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    const body = notifyOrderSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Invalid order parameters', details: body.error.flatten() },
      });
    }

    const data = body.data;
    const market = await marketService.getByPubkey(data.marketAddress);
    if (!market) {
      return reply.code(404).send({
        error: { code: 'MARKET_NOT_FOUND', message: 'Market not found' },
      });
    }

    // Profitability check
    let notionalValue = data.price * data.size;
    if (data.type.toUpperCase() === 'MARKET') {
      if (data.dollarAmount && data.dollarAmount > 0) {
        notionalValue = data.dollarAmount;
      } else {
        const currentPrice = data.outcome.toUpperCase() === 'YES'
          ? parseFloat(market.yesPrice || '0.50')
          : parseFloat(market.noPrice || '0.50');
        notionalValue = currentPrice * data.size;
      }
    }

    if (notionalValue < config.minNotionalValue) {
      return reply.code(400).send({
        error: { 
          code: 'ORDER_TOO_SMALL', 
          message: `Minimum order value is $${config.minNotionalValue.toFixed(2)}. Your order is only $${notionalValue.toFixed(2)}.`,
        },
      });
    }

    if (market.status !== 'OPEN') {
      return reply.code(409).send({
        error: { code: 'MARKET_CLOSED', message: 'Market is not accepting orders' },
      });
    }

    // Markets with strikePrice = '0' are pending activation (trading suspended)
    if (market.strikePrice === '0') {
      return reply.code(409).send({
        error: { code: 'MARKET_PENDING', message: 'Trading suspended - market strike price not yet set' },
      });
    }

    const isMarketOrder = data.type.toUpperCase() === 'MARKET';
    const isSellOrder = data.side.toUpperCase() === 'ASK';
    const outcomeUpper = data.outcome.toUpperCase() as 'YES' | 'NO';
    
    // 1. SELL order logic
    if (isMarketOrder && isSellOrder) {
      const delCheck = await matchingService.checkDelegation(userId, 0);
      if (!delCheck.isApproved) {
        return reply.code(400).send({ error: { code: 'DELEGATION_REQUIRED', message: delCheck.error } });
      }

      const result = await matchingService.processSellOrder({
        marketId: market.id,
        userId,
        outcome: outcomeUpper,
        size: data.size,
        minPrice: data.price,
        clientOrderId: data.clientOrderId,
        expiresAt: data.expiry * 1000,
        signature: data.signature,
        binaryMessage: data.binaryMessage,
      });
      
      logEvents.orderPlaced({
        orderId: result.orderId,
        userId, wallet, marketId: market.id, asset: market.asset, timeframe: market.timeframe,
        side: 'ASK', outcome: outcomeUpper, price: result.avgPrice, size: result.totalSold, orderType: 'MARKET',
      });
      
      return {
        orderId: result.orderId,
        status: result.totalSold > 0 ? (result.remainingSize > 0.001 ? 'partial' : 'filled') : 'cancelled',
        fills: result.fills.length,
        filledSize: result.totalSold,
        avgPrice: result.avgPrice,
        createdAt: Date.now(),
      };
    }
    
    // 2. BUY order logic (Limit or Dollar-based Market)
    const feeMultiplier = 1 + (config.takerFeeBps / 10000);
    const requiredAmount = (data.dollarAmount || (data.price * data.size)) * feeMultiplier;
    const delCheck = await matchingService.checkDelegation(userId, requiredAmount);
    
    if (!delCheck.isApproved || delCheck.error) {
      return reply.code(400).send({ error: { code: 'DELEGATION_INSUFFICIENT', message: delCheck.error } });
    }

    if (data.type.toUpperCase() === 'LIMIT') {
      const result = await matchingService.processLimitOrder({
        marketId: market.id,
        userId,
        side: 'BID',
        outcome: outcomeUpper,
        price: data.price,
        size: data.size,
        clientOrderId: data.clientOrderId,
        expiresAt: data.expiry * 1000,
        signature: data.signature,
        binaryMessage: data.binaryMessage,
      });
      
      logEvents.orderPlaced({
        orderId: result.orderId,
        userId, wallet, marketId: market.id, asset: market.asset, timeframe: market.timeframe,
        side: 'BID', outcome: outcomeUpper, price: data.price, size: data.size, orderType: 'LIMIT',
      });
      
      return {
        orderId: result.orderId,
        status: result.status,
        fills: result.fills.length,
        filledSize: result.filledSize,
        createdAt: Date.now(),
      };
    } else if (isMarketOrder && data.dollarAmount) {
      const result = await matchingService.processMarketOrderByDollar({
        marketId: market.id,
        userId,
        side: 'BID',
        outcome: outcomeUpper,
        dollarAmount: data.dollarAmount,
        maxPrice: data.maxPrice || 0.99,
        clientOrderId: data.clientOrderId,
        expiresAt: data.expiry * 1000,
        signature: data.signature,
        binaryMessage: data.binaryMessage,
      });
      
      logEvents.orderPlaced({
        orderId: result.orderId,
        userId, wallet, marketId: market.id, asset: market.asset, timeframe: market.timeframe,
        side: 'BID', outcome: outcomeUpper, price: result.avgPrice, size: result.totalContracts, orderType: 'MARKET',
      });
      
      return {
        orderId: result.orderId,
        status: result.totalContracts > 0 ? (result.unfilledDollars > 0.01 ? 'partial' : 'filled') : 'cancelled',
        fills: result.fills.length,
        filledSize: result.totalContracts,
        avgPrice: result.avgPrice,
        createdAt: Date.now(),
      };
    }

    return reply.code(400).send({ error: { code: 'INVALID_ORDER', message: 'Unsupported order configuration' } });
  });

  /**
   * GET /orders/:id
   * Get a specific order
   */
  app.get('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    const params = orderIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Invalid order ID' },
      });
    }

    const order = await orderService.getById(params.data.id);
    
    if (!order) {
      return reply.code(404).send({
        error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' },
      });
    }

    // Verify ownership
    if (order.userId !== userId) {
      return reply.code(403).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authorized to view this order' },
      });
    }

    return {
      id: order.id,
      marketId: order.marketId,
      side: order.side?.toLowerCase(),
      outcome: order.outcome?.toLowerCase(),
      type: order.orderType?.toLowerCase(),
      price: parseFloat(order.price),
      size: parseFloat(order.size),
      filledSize: parseFloat(order.filledSize || '0'),
      remainingSize: parseFloat(order.remainingSize || '0'),
      status: order.status?.toLowerCase(),
      createdAt: order.createdAt?.getTime(),
      updatedAt: order.updatedAt?.getTime(),
    };
  });

  /**
   * DELETE /orders/:id
   * Cancel a specific order
   */
  app.delete('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    const params = orderIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Invalid order ID' },
      });
    }

    // Validate cancel signature
    const body = cancelOrderSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Cancel signature required' },
      });
    }

    const order = await orderService.getById(params.data.id);
    
    if (!order) {
      return reply.code(404).send({
        error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' },
      });
    }

    // Verify ownership
    if (order.userId !== userId) {
      return reply.code(403).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authorized to cancel this order' },
      });
    }

    // Check if order can be cancelled
    if (order.status === 'FILLED') {
      return reply.code(409).send({
        error: { code: 'ORDER_ALREADY_FILLED', message: 'Order is already filled' },
      });
    }

    if (order.status === 'CANCELLED') {
      return reply.code(409).send({
        error: { code: 'ORDER_ALREADY_CANCELLED', message: 'Order is already cancelled' },
      });
    }

    // TODO: Verify cancel signature

    // Cancel the order and remove from orderbook
    const success = await matchingService.cancelOrder(params.data.id, userId);

    if (!success) {
      return reply.code(500).send({
        error: { code: 'CANCEL_FAILED', message: 'Failed to cancel order' },
      });
    }

    return {
      orderId: params.data.id,
      status: 'cancelled',
    };
  });

  /**
   * DELETE /orders
   * Cancel all open orders (emergency kill switch)
   */
  app.delete('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    const query = cancelAllQuerySchema.safeParse(request.query);
    const marketAddress = query.success ? query.data.marketAddress : undefined;

    let marketId: string | undefined;
    if (marketAddress) {
      const market = await marketService.getByPubkey(marketAddress);
      if (!market) {
        return reply.code(404).send({
          error: { code: 'MARKET_NOT_FOUND', message: 'Market not found' },
        });
      }
      marketId = market.id;
    }

    // Cancel all user's orders
    const cancelledIds = await orderService.cancelAllForUser(userId, marketId);

    // TODO: Remove from Redis orderbook

    return {
      cancelledCount: cancelledIds.length,
      orderIds: cancelledIds,
    };
  });
}
