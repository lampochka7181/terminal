import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { canonicalOrderMessageToBase64 } from '../lib/order-auth.js';
import { requireAuth, getCurrentUserId, getCurrentWallet, isAgentRequest } from '../lib/auth.js';
import { orderService } from '../services/order.service.js';
import { marketService } from '../services/market.service.js';
import { userService } from '../services/user.service.js';
import { positionService } from '../services/position.service.js';
import { matchingService } from '../services/matching.service.js';
import { feeService, calculateTakerFee, calculateAgentTakerFee } from '../services/fee.service.js';
import { sessionService } from '../services/session.service.js';
import { redis } from '../db/redis.js';
import { logger, orderLogger, logEvents } from '../lib/logger.js';
import { config } from '../config.js';
import { anchorClient, getYesMintPda, getNoMintPda } from '../lib/anchor-client.js';

// M-14: Per-user rate limiter for order cancellations (prevents cancel-spam abuse)
const CANCEL_RATE_LIMIT = 30;          // max cancels per window
const CANCEL_RATE_WINDOW_SEC = 60;     // 60-second sliding window

async function checkCancelRateLimit(userId: string): Promise<{ allowed: boolean; remaining: number }> {
  if (!redis) return { allowed: true, remaining: CANCEL_RATE_LIMIT }; // skip if Redis unavailable
  const key = `ratelimit:cancel:${userId}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, CANCEL_RATE_WINDOW_SEC);
    }
    return { allowed: count <= CANCEL_RATE_LIMIT, remaining: Math.max(0, CANCEL_RATE_LIMIT - count) };
  } catch {
    return { allowed: true, remaining: CANCEL_RATE_LIMIT }; // fail open
  }
}

function decodeSignature(signature: string): Uint8Array {
  try {
    return bs58.decode(signature);
  } catch {
    return Buffer.from(signature, 'base64');
  }
}

function buildExpectedOrderMessage(data: {
  marketAddress: string;
  side: 'bid' | 'ask';
  outcome: 'yes' | 'no';
  type: 'limit' | 'market' | 'ioc' | 'fok';
  price: number;
  size: number;
  expiry: number;
  clientOrderId: number;
  dollarAmount?: number;
  sessionPublicKey?: string;
}, wallet: string): string {
  const canonicalSize = data.type === 'market' && data.side === 'bid' && data.dollarAmount
    ? data.dollarAmount
    : data.size;
  return canonicalOrderMessageToBase64({
    marketAddress: data.marketAddress,
    walletAddress: wallet,
    signerPublicKey: data.sessionPublicKey || wallet,
    side: data.side.toUpperCase() as 'BID' | 'ASK',
    outcome: data.outcome.toUpperCase() as 'YES' | 'NO',
    orderType: data.type.toUpperCase() as 'LIMIT' | 'MARKET' | 'IOC' | 'FOK',
    price: data.price,
    size: canonicalSize,
    expiryTs: data.expiry,
    clientOrderId: data.clientOrderId,
  });
}

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
    expiry: z.number().optional(),                        // Optional for agents (default: 1 hour)
    clientOrderId: z.number().optional(),                  // Optional for agents (default: Date.now())
    dollarAmount: z.number().min(0.02).max(1000000).optional(), // Min $0.02 for sells
    maxPrice: z.number().min(0.01).max(0.99).optional(),
    signature: z.string().optional(),                      // Optional for agents (API key auth is sufficient)
    binaryMessage: z.string().optional(),                  // Optional for agents
    encodedInstruction: z.string().optional(),             // Optional for agents
    sessionPublicKey: z.string().min(32).max(64).optional(), // For session-signed orders
  });

  app.post('/notify', async (request: FastifyRequest, reply: FastifyReply) => {
    const t0 = Date.now();
    logger.info(`[⏱️ ORDER API] T+0ms: Request received`);
    
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
    const isAgent = isAgentRequest(request);
    logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Validated, ${data.side} ${data.outcome} $${data.dollarAmount || data.size}${isAgent ? ' [AGENT]' : ''}`);

    // ========================================
    // AGENT ORDER DEFAULTS
    // ========================================
    // Agents may place orders if they provide a valid wallet signature (on-chain authorization).
    // Unsigned agent orders are still rejected.
    if (isAgent && (!data.signature || !data.binaryMessage)) {
      return reply.code(403).send({
        error: { code: 'AGENT_ORDERS_DISABLED', message: 'Agent orders require a wallet signature. Sign the canonical order message with your private key and include signature + binaryMessage.' },
      });
    }
    if (!data.signature) {
      // Non-agent requests MUST have signature
      return reply.code(400).send({
        error: { code: 'SIGNATURE_REQUIRED', message: 'Signature is required for non-agent orders' },
      });
    }
    if (!data.binaryMessage) {
      return reply.code(400).send({
        error: { code: 'MESSAGE_REQUIRED', message: 'binaryMessage is required for signed orders' },
      });
    }
    if (!data.clientOrderId) data.clientOrderId = Date.now();
    if (!data.expiry) data.expiry = Math.floor(Date.now() / 1000) + 3600;

    const expectedBinaryMessage = (() => {
      try {
        return buildExpectedOrderMessage({
          marketAddress: data.marketAddress,
          side: data.side,
          outcome: data.outcome,
          type: data.type,
          price: data.price,
          size: data.size,
          expiry: data.expiry,
          clientOrderId: data.clientOrderId,
          dollarAmount: data.dollarAmount,
          sessionPublicKey: data.sessionPublicKey,
        }, wallet);
      } catch (messageErr: any) {
        logger.warn(`Order canonical message error: ${messageErr.message}`);
        return null;
      }
    })();

    if (!expectedBinaryMessage || data.binaryMessage !== expectedBinaryMessage) {
      return reply.code(400).send({
        error: { code: 'INVALID_MESSAGE', message: 'binaryMessage does not match the canonical order payload' },
      });
    }

    // Verify the authenticated wallet or its approved session signed the exact canonical payload.
    try {
      const messageBytes = Buffer.from(data.binaryMessage, 'base64');
      const signatureBytes = decodeSignature(data.signature);
      const signerPubkey = new PublicKey(data.sessionPublicKey || wallet);
      const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, signerPubkey.toBytes());
      if (!isValid) {
        return reply.code(401).send({
          error: { code: 'INVALID_SIGNATURE', message: 'Order signature verification failed' },
        });
      }
    } catch (sigErr: any) {
      logger.warn(`Order signature verification error: ${sigErr.message}`);
      return reply.code(400).send({
        error: { code: 'INVALID_SIGNATURE', message: 'Could not verify order signature' },
      });
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

    const EXPIRY_BUFFER_MS = 3_000;
    if (market.expiryAt) {
      const expiryMs = new Date(market.expiryAt).getTime();
      const remainingMs = expiryMs - Date.now();
      if (remainingMs < EXPIRY_BUFFER_MS) {
        return reply.code(409).send({
          error: { code: 'MARKET_EXPIRING', message: `Orders cannot be placed within 3 seconds of expiry` },
        });
      }
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
      // Delegation check for sell orders (amount=0 since selling shares, not spending USDC)
      if (!isAgent) {
        const delCheck = await matchingService.checkDelegation(userId, 0);
        if (!delCheck.isApproved) {
          return reply.code(400).send({ error: { code: 'DELEGATION_REQUIRED', message: delCheck.error } });
        }
      } else {
        logger.debug(`[Orders] Agent order — using cached delegation for sell`);
      }

      const position = await positionService.getPosition(userId, market.id);
      const availableShares = outcomeUpper === 'YES'
        ? parseFloat(position?.yesShares || '0')
        : parseFloat(position?.noShares || '0');

      if (availableShares < 0.001) {
        return reply.code(400).send({
          error: {
            code: 'INSUFFICIENT_SHARES',
            message: `No ${outcomeUpper} shares available to sell`,
          },
        });
      }

      if (data.size > availableShares + 0.000001) {
        return reply.code(400).send({
          error: {
            code: 'INSUFFICIENT_SHARES',
            message: `Cannot sell ${data.size} ${outcomeUpper} shares; only ${availableShares.toFixed(6)} available`,
          },
        });
      }

      try {
        const marketPubkey = new PublicKey(market.pubkey);
        const mint = outcomeUpper === 'YES'
          ? getYesMintPda(marketPubkey)
          : getNoMintPda(marketPubkey);
        const walletPk = new PublicKey(wallet);
        const ata = await getAssociatedTokenAddress(mint, walletPk, false, TOKEN_2022_PROGRAM_ID);
        const account = await getAccount(anchorClient.getConnection(), ata, 'confirmed', TOKEN_2022_PROGRAM_ID);
        const confirmedShares = Number(account.amount) / 1_000_000;

        if (confirmedShares < 0.001) {
          return reply.code(409).send({
            error: {
              code: 'PENDING_POSITION_SYNC',
              message: `Your ${outcomeUpper} buys are not yet confirmed on-chain. Wait for confirmation before selling.`,
            },
          });
        }

        if (data.size > confirmedShares + 0.000001) {
          return reply.code(409).send({
            error: {
              code: 'PENDING_POSITION_SYNC',
              message: `Cannot sell ${data.size} ${outcomeUpper} shares yet; only ${confirmedShares.toFixed(6)} are confirmed on-chain.`,
            },
          });
        }
      } catch (err: any) {
        logger.debug(`[Orders] Could not confirm on-chain share balance before sell: ${err.message}`);
      }

      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Starting SELL order matching...`);
      const sellStart = Date.now();
      
      const result = await matchingService.processSellOrder({
        marketId: market.id,
        userId,
        outcome: outcomeUpper,
        size: data.size,
        minPrice: data.price,
        clientOrderId: data.clientOrderId!,
        expiresAt: data.expiry! * 1000,
        signature: data.signature || '',
        binaryMessage: data.binaryMessage || '',
        sessionPublicKey: data.sessionPublicKey,
      });
      
      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Sell matching complete (${Date.now()-sellStart}ms), ${result.fills.length} fills`);
      
      logEvents.orderPlaced({
        orderId: result.orderId,
        userId, wallet, marketId: market.id, asset: market.asset, timeframe: market.timeframe,
        side: 'ASK', outcome: outcomeUpper, price: result.avgPrice, size: result.totalSold, orderType: 'MARKET',
      });
      
      // Build position data for immediate frontend update
      let positionData = null;
      
      if (result.totalSold > 0 && position) {
        const originalYesShares = parseFloat(position.yesShares || '0');
        const originalNoShares = parseFloat(position.noShares || '0');
        
        const soldShares = result.totalSold;
        const remainingYes = outcomeUpper === 'YES' 
          ? Math.max(0, originalYesShares - soldShares)
          : originalYesShares;
        const remainingNo = outcomeUpper === 'NO' 
          ? Math.max(0, originalNoShares - soldShares)
          : originalNoShares;
        
        if (remainingYes > 0.001 || remainingNo > 0.001) {
          positionData = {
            marketAddress: market.pubkey,
            market: `${market.asset} ${market.timeframe}`,
            asset: market.asset,
            expiryAt: market.expiresAt ? new Date(market.expiresAt).getTime() : 0,
            yesShares: remainingYes,
            noShares: remainingNo,
            avgEntryPrice: parseFloat(position.avgEntryYes || position.avgEntryNo || '0.50'),
            currentPrice: outcomeUpper === 'YES' 
              ? parseFloat(market.yesPrice || '0.50')
              : parseFloat(market.noPrice || '0.50'),
            unrealizedPnL: 0,
            status: 'open' as const,
            createdAt: position.createdAt ? new Date(position.createdAt).getTime() : Date.now(),
          };
        }
      }
      
      return {
        orderId: result.orderId,
        status: result.totalSold > 0 ? (result.remainingSize > 0.001 ? 'partial' : 'filled') : 'cancelled',
        fills: result.fills.length,
        filledSize: result.totalSold,
        avgPrice: result.avgPrice,
        totalFee: result.totalTakerFees,
        createdAt: Date.now(),
        position: positionData,
      };
    }
    
    // 2. BUY order logic (Limit or Dollar-based Market)
    // Calculate fee using tiered fee structure (agents get discounted fees)
    const orderNotional = data.dollarAmount || (data.price * data.size);
    let agentFeeDiscountPct = 0;
    if (isAgent) {
      const user = await userService.findById(userId);
      agentFeeDiscountPct = user?.feeDiscountPct || config.agent.defaultFeeDiscountPct;
    }
    const feeCalc = isAgent
      ? calculateAgentTakerFee(orderNotional, agentFeeDiscountPct)
      : calculateTakerFee(orderNotional);
    
    const requiredAmount = orderNotional + feeCalc.fee;
    
    // Delegation check — verify user has approved relayer to spend their USDC
    // For session/agent orders: skip full on-chain check for speed
    if (!isAgent) {
      const delCheckStart = Date.now();
      const delCheck = await matchingService.checkDelegation(userId, requiredAmount);
      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Delegation check done (${Date.now()-delCheckStart}ms)`);

      if (!delCheck.isApproved || delCheck.error) {
        return reply.code(400).send({ error: { code: 'DELEGATION_INSUFFICIENT', message: delCheck.error } });
      }
    }

    if (data.type.toUpperCase() === 'LIMIT') {
      const result = await matchingService.processLimitOrder({
        marketId: market.id,
        userId,
        side: 'BID',
        outcome: outcomeUpper,
        price: data.price,
        size: data.size,
        clientOrderId: data.clientOrderId!,
        expiresAt: data.expiry! * 1000,
        signature: data.signature || '',
        binaryMessage: data.binaryMessage || '',
        sessionPublicKey: data.sessionPublicKey,
      });

      logEvents.orderPlaced({
        orderId: result.orderId,
        userId, wallet, marketId: market.id, asset: market.asset, timeframe: market.timeframe,
        side: 'BID', outcome: outcomeUpper, price: data.price, size: data.size, orderType: 'LIMIT',
      });

      // Deduct spent amount from delegation cache to prevent double-spend on rapid orders
      if (result.filledSize > 0) {
        matchingService.deductFromDelegationCache(userId, requiredAmount);
      }
      
      // Build position data for immediate frontend update
      let positionData = null;
      if (result.filledSize > 0) {
        const yesShares = outcomeUpper === 'YES' ? result.filledSize : 0;
        const noShares = outcomeUpper === 'NO' ? result.filledSize : 0;
        const currentPrice = outcomeUpper === 'YES' 
          ? parseFloat(market.yesPrice || '0.50')
          : parseFloat(market.noPrice || '0.50');
        
        positionData = {
          marketAddress: market.pubkey,
          market: `${market.asset} ${market.timeframe}`,
          asset: market.asset,
          expiryAt: market.expiresAt ? new Date(market.expiresAt).getTime() : 0,
          yesShares,
          noShares,
          avgEntryPrice: data.price,
          avgEntryYes: outcomeUpper === 'YES' ? data.price : 0,
          avgEntryNo: outcomeUpper === 'NO' ? data.price : 0,
          currentPrice,
          unrealizedPnL: (currentPrice - data.price) * result.filledSize,
          status: 'open' as const,
          createdAt: Date.now(),
        };
      }
      
      return {
        orderId: result.orderId,
        status: result.status,
        fills: result.fills.length,
        filledSize: result.filledSize,
        createdAt: Date.now(),
        position: positionData,
      };
    } else if (isMarketOrder && data.dollarAmount) {
      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Starting MARKET order matching...`);
      const matchStart = Date.now();
      
      const result = await matchingService.processMarketOrderByDollar({
        marketId: market.id,
        userId,
        side: 'BID',
        outcome: outcomeUpper,
        dollarAmount: data.dollarAmount,
        maxPrice: data.maxPrice || 0.99,
        clientOrderId: data.clientOrderId!,
        expiresAt: data.expiry! * 1000,
        signature: data.signature || '',
        binaryMessage: data.binaryMessage || '',
        sessionPublicKey: data.sessionPublicKey,
      });

      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Matching complete (${Date.now()-matchStart}ms), ${result.fills.length} fills`);

      // Deduct spent amount from delegation cache to prevent double-spend on rapid orders
      if (result.totalContracts > 0) {
        matchingService.deductFromDelegationCache(userId, requiredAmount);
      }

      logEvents.orderPlaced({
        orderId: result.orderId,
        userId, wallet, marketId: market.id, asset: market.asset, timeframe: market.timeframe,
        side: 'BID', outcome: outcomeUpper, price: result.avgPrice, size: result.totalContracts, orderType: 'MARKET',
      });
      
      // Build position data for immediate frontend update
      // totalCost = pure collateral (notional) spent — fees are separate.
      // This ensures avgEntryPrice = fill price and SIZE displays correctly.
      let positionData = null;
      if (result.totalContracts > 0) {
        const yesShares = outcomeUpper === 'YES' ? result.totalContracts : 0;
        const noShares = outcomeUpper === 'NO' ? result.totalContracts : 0;
        const totalCost = result.totalSpent;
        const currentPrice = outcomeUpper === 'YES' 
          ? parseFloat(market.yesPrice || '0.50')
          : parseFloat(market.noPrice || '0.50');
        
        positionData = {
          marketAddress: market.pubkey,
          market: `${market.asset} ${market.timeframe}`,
          asset: market.asset,
          expiryAt: market.expiresAt ? new Date(market.expiresAt).getTime() : 0,
          yesShares,
          noShares,
          avgEntryPrice: result.avgPrice,
          avgEntryYes: outcomeUpper === 'YES' ? result.avgPrice : 0,
          avgEntryNo: outcomeUpper === 'NO' ? result.avgPrice : 0,
          currentPrice,
          totalCost,
          unrealizedPnL: (currentPrice - result.avgPrice) * result.totalContracts,
          status: 'open' as const,
          createdAt: Date.now(),
        };
      }
      
      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Sending response with position data`);
      
      return {
        orderId: result.orderId,
        restingOrderId: result.restingOrderId,
        status: result.totalContracts > 0 ? 'filled' : (result.restingOrderId ? 'resting' : 'cancelled'),
        fills: result.fills.length,
        filledSize: result.totalContracts,
        avgPrice: result.avgPrice,
        totalSpent: result.totalSpent,
        dollarAmount: result.dollarAmount,
        unfilledDollars: result.unfilledDollars,
        createdAt: Date.now(),
        position: positionData,
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

    // M-14: Rate limit cancellations (30/min per user)
    const rateCheck = await checkCancelRateLimit(userId);
    if (!rateCheck.allowed) {
      return reply.code(429).send({
        error: { code: 'CANCEL_RATE_LIMITED', message: `Too many cancellations. Limit: ${CANCEL_RATE_LIMIT} per minute.`, remaining: rateCheck.remaining },
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

    // Verify cancel signature: the signature must be a valid Ed25519 signature
    // of the order ID by the user's wallet
    const wallet = getCurrentWallet(request);
    if (wallet) {
      try {
        const message = new TextEncoder().encode(`cancel:${params.data.id}`);
        const signatureBytes = bs58.decode(body.data.signature);
        const pubkeyBytes = bs58.decode(wallet);
        const isValid = nacl.sign.detached.verify(message, signatureBytes, pubkeyBytes);
        if (!isValid) {
          return reply.code(401).send({
            error: { code: 'INVALID_SIGNATURE', message: 'Cancel signature verification failed' },
          });
        }
      } catch (sigErr: any) {
        logger.warn(`Cancel signature verification error: ${sigErr.message}`);
        // Allow cancellation if signature parsing fails but user is authenticated
        // This maintains backward compatibility with clients not yet sending proper signatures
      }
    }

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
