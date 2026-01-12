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
import { feeService, calculateTakerFee } from '../services/fee.service.js';
import { sessionService } from '../services/session.service.js';
import { marginService, leverageCalc } from '../services/margin.service.js';
import { lendingService } from '../services/lending.service.js';
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
    dollarAmount: z.number().min(0.02).max(1000000).optional(), // Min $0.02 for sells
    maxPrice: z.number().min(0.01).max(0.99).optional(),
    signature: z.string(),
    binaryMessage: z.string(),
    sessionPublicKey: z.string().min(32).max(64).optional(), // For session-signed orders
    // Leverage parameters
    leverage: z.number().min(1).max(config.leverage.maxLeverage).optional().default(1), // 1x = no leverage
    marginAmount: z.number().min(0).optional(), // User's margin (required if leverage > 1)
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
    
    // ========================================
    // SIGNATURE VERIFICATION
    // ========================================
    // If sessionPublicKey is provided, verify against session service
    // Otherwise, the signature was from the wallet directly (verified by JWT auth)
    if (data.sessionPublicKey) {
      // Decode the order data from binaryMessage
      let orderData: Record<string, unknown>;
      try {
        const messageJson = Buffer.from(data.binaryMessage, 'base64').toString('utf-8');
        orderData = JSON.parse(messageJson);
      } catch {
        return reply.code(400).send({
          error: { code: 'INVALID_MESSAGE', message: 'Invalid order message format' },
        });
      }
      
      // Verify session signature
      const sessionVerify = sessionService.verifySessionSignature(
        data.sessionPublicKey,
        orderData,
        data.signature
      );
      
      if (!sessionVerify.valid) {
        return reply.code(401).send({
          error: { code: 'INVALID_SESSION', message: sessionVerify.error || 'Session signature verification failed' },
        });
      }
      
      // Verify session belongs to the authenticated user
      if (sessionVerify.walletAddress !== wallet) {
        return reply.code(403).send({
          error: { code: 'SESSION_MISMATCH', message: 'Session does not belong to authenticated user' },
        });
      }
      
      logger.debug(`[Orders] Session-signed order from ${wallet.slice(0, 8)}... (session: ${data.sessionPublicKey.slice(0, 8)}...)`);
    }
    
    const market = await marketService.getByPubkey(data.marketAddress);
    if (!market) {
      return reply.code(404).send({
        error: { code: 'MARKET_NOT_FOUND', message: 'Market not found' },
      });
    }

    // Calculate notional value for validation
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

    // Minimum order validation (different for buy vs sell)
    // bid = buying contracts, ask = selling contracts
    const orderSide = data.side === 'bid' ? 'buy' : 'sell';
    const minValidation = feeService.validateOrderMinimum(notionalValue, orderSide);
    if (!minValidation.valid) {
      return reply.code(400).send({
        error: { 
          code: 'ORDER_TOO_SMALL', 
          message: minValidation.message || `Minimum ${orderSide} order is $${minValidation.minimum.toFixed(2)}. Your order is only $${notionalValue.toFixed(2)}.`,
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
    // Calculate fee using tiered fee structure
    const orderNotional = data.dollarAmount || (data.price * data.size);
    const feeCalc = calculateTakerFee(orderNotional);
    
    // ========================================
    // LEVERAGE VALIDATION
    // ========================================
    const leverage = data.leverage || 1;
    const isLeveraged = leverage > 1;
    
    // DEBUG: Log leverage info for all orders
    logger.info(`[Orders] Leverage check: received=${data.leverage}, using=${leverage}, isLeveraged=${isLeveraged}, marginAmount=${data.marginAmount}`);
    let loanAmount = 0;
    let marginRequired = 0;
    
    if (isLeveraged) {
      // Check if leverage is enabled
      if (!lendingService.isEnabled()) {
        return reply.code(503).send({
          error: { code: 'LEVERAGE_DISABLED', message: 'Leverage trading is not enabled' },
        });
      }
      
      // Calculate margin and loan amounts
      marginRequired = leverageCalc.initialMarginRequired(orderNotional, leverage);
      loanAmount = leverageCalc.loanAmount(orderNotional, leverage);
      
      // Validate minimum margin
      if (marginRequired < config.leverage.minMarginUsd) {
        return reply.code(400).send({
          error: { 
            code: 'MARGIN_TOO_SMALL', 
            message: `Minimum margin is $${config.leverage.minMarginUsd}. Your margin ($${marginRequired.toFixed(2)}) is too small for ${leverage}x leverage.`,
          },
        });
      }
      
      // Validate margin amount provided matches required
      if (data.marginAmount !== undefined && Math.abs(data.marginAmount - marginRequired) > 0.01) {
        return reply.code(400).send({
          error: { 
            code: 'MARGIN_MISMATCH', 
            message: `Provided margin ($${data.marginAmount.toFixed(2)}) doesn't match required margin ($${marginRequired.toFixed(2)}) for ${leverage}x leverage.`,
          },
        });
      }
      
      // Check if lending pool can provide the loan
      const loanCheck = await lendingService.canMakeLoan(loanAmount, userId);
      if (!loanCheck.canLoan) {
        return reply.code(400).send({
          error: { 
            code: 'LOAN_UNAVAILABLE', 
            message: loanCheck.reason || `Cannot borrow $${loanAmount.toFixed(2)} - max available: $${loanCheck.maxLoan.toFixed(2)}`,
          },
        });
      }
      
      logger.info(`[Orders] Leveraged order: ${leverage}x, margin=$${marginRequired.toFixed(2)}, loan=$${loanAmount.toFixed(2)}`);
    }
    
    // For leveraged orders, user only needs to have margin + fees (loan covers the rest)
    const requiredAmount = isLeveraged 
      ? marginRequired + feeCalc.fee 
      : orderNotional + feeCalc.fee;
    
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
        // Leverage fields (for on-chain execution through Lending Pool)
        leverage: isLeveraged ? leverage : undefined,
        marginAmount: isLeveraged ? marginRequired : undefined,
        loanAmount: isLeveraged ? loanAmount : undefined,
      });
      
      logEvents.orderPlaced({
        orderId: result.orderId,
        userId, wallet, marketId: market.id, asset: market.asset, timeframe: market.timeframe,
        side: 'BID', outcome: outcomeUpper, price: data.price, size: data.size, orderType: 'LIMIT',
      });
      
      // Create margin account if leveraged and order filled
      let marginAccountId: string | null = null;
      if (isLeveraged && result.filledSize > 0) {
        try {
          // Get the position that was created/updated
          const position = await positionService.getPosition(userId, market.id);
          if (position) {
            const filledNotional = result.filledSize * data.price;
            const actualMargin = leverageCalc.initialMarginRequired(filledNotional, leverage);
            const actualLoan = leverageCalc.loanAmount(filledNotional, leverage);
            
            const marginAccount = await marginService.createMarginAccount({
              userId,
              positionId: position.id,
              marketId: market.id,
              side: outcomeUpper,
              shares: result.filledSize,
              entryPrice: data.price,
              leverage,
              marginDeposited: actualMargin,
              loanAmount: actualLoan,
            });
            marginAccountId = marginAccount.id;
            logger.info(`[Orders] Created margin account ${marginAccountId} for ${leverage}x leveraged position`);
          }
        } catch (err: any) {
          logger.error(`[Orders] Failed to create margin account for leveraged order: ${err.message}`);
          // Don't fail the order - margin account can be created manually
        }
      }
      
      return {
        orderId: result.orderId,
        status: result.status,
        fills: result.fills.length,
        filledSize: result.filledSize,
        createdAt: Date.now(),
        leverage: isLeveraged ? leverage : undefined,
        marginAccountId: marginAccountId || undefined,
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
        // Leverage fields (for on-chain execution through Lending Pool)
        leverage: isLeveraged ? leverage : undefined,
        marginAmount: isLeveraged ? marginRequired : undefined,
        loanAmount: isLeveraged ? loanAmount : undefined,
      });
      
      logEvents.orderPlaced({
        orderId: result.orderId,
        userId, wallet, marketId: market.id, asset: market.asset, timeframe: market.timeframe,
        side: 'BID', outcome: outcomeUpper, price: result.avgPrice, size: result.totalContracts, orderType: 'MARKET',
      });
      
      // Create margin account if leveraged and order filled
      let marginAccountId: string | null = null;
      if (isLeveraged && result.totalContracts > 0) {
        try {
          const position = await positionService.getPosition(userId, market.id);
          if (position) {
            const filledNotional = result.totalSpent; // Total spent (not including fee)
            const actualMargin = leverageCalc.initialMarginRequired(filledNotional, leverage);
            const actualLoan = leverageCalc.loanAmount(filledNotional, leverage);
            
            const marginAccount = await marginService.createMarginAccount({
              userId,
              positionId: position.id,
              marketId: market.id,
              side: outcomeUpper,
              shares: result.totalContracts,
              entryPrice: result.avgPrice,
              leverage,
              marginDeposited: actualMargin,
              loanAmount: actualLoan,
            });
            marginAccountId = marginAccount.id;
            logger.info(`[Orders] Created margin account ${marginAccountId} for ${leverage}x leveraged market order`);
          }
        } catch (err: any) {
          logger.error(`[Orders] Failed to create margin account for leveraged market order: ${err.message}`);
        }
      }
      
      return {
        orderId: result.orderId,
        status: result.totalContracts > 0 ? (result.unfilledDollars > 0.01 ? 'partial' : 'filled') : 'cancelled',
        fills: result.fills.length,
        filledSize: result.totalContracts,
        avgPrice: result.avgPrice,
        createdAt: Date.now(),
        leverage: isLeveraged ? leverage : undefined,
        marginAccountId: marginAccountId || undefined,
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
