import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { requireAuth, getCurrentUserId, getCurrentWallet, isAgentRequest } from '../lib/auth.js';
import { orderService } from '../services/order.service.js';
import { marketService } from '../services/market.service.js';
import { userService } from '../services/user.service.js';
import { positionService } from '../services/position.service.js';
import { matchingService } from '../services/matching.service.js';
import { feeService, calculateTakerFee, calculateAgentTakerFee } from '../services/fee.service.js';
import { sessionService } from '../services/session.service.js';
import { marginService, leverageCalc } from '../services/margin.service.js';
import { lendingService } from '../services/lending.service.js';
import { db, trades } from '../db/index.js';
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
    expiry: z.number().optional(),                        // Optional for agents (default: 1 hour)
    clientOrderId: z.number().optional(),                  // Optional for agents (default: Date.now())
    dollarAmount: z.number().min(0.02).max(1000000).optional(), // Min $0.02 for sells
    maxPrice: z.number().min(0.01).max(0.99).optional(),
    signature: z.string().optional(),                      // Optional for agents (API key auth is sufficient)
    binaryMessage: z.string().optional(),                  // Optional for agents
    encodedInstruction: z.string().optional(),             // Optional for agents
    sessionPublicKey: z.string().min(32).max(64).optional(), // For session-signed orders
    // Leverage parameters
    leverage: z.number().min(1).max(config.leverage.maxLeverage).optional().default(1), // 1x = no leverage
    marginAmount: z.number().min(0).optional(), // User's margin (required if leverage > 1)
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
    if (isAgent) {
      // Agents don't need signatures — JWT auth is sufficient
      if (!data.clientOrderId) data.clientOrderId = Date.now();
      if (!data.expiry) data.expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour default
    } else if (!data.signature) {
      // Non-agent requests MUST have signature
      return reply.code(400).send({
        error: { code: 'SIGNATURE_REQUIRED', message: 'Signature is required for non-agent orders' },
      });
    }

    // ========================================
    // SIGNATURE VERIFICATION (skip for agents)
    // ========================================
    // If sessionPublicKey is provided, verify against session service
    // Otherwise, the signature was from the wallet directly (verified by JWT auth)
    if (!isAgent && data.sessionPublicKey) {
      // Decode the order data from binaryMessage
      let orderData: Record<string, unknown>;
      try {
        const messageJson = Buffer.from(data.binaryMessage!, 'base64').toString('utf-8');
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
        data.signature!
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

    // Track if this is a session-signed or agent order (used to skip delegation check later)
    const isSessionOrder = !!data.sessionPublicKey;
    
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

    // Reject orders too close to market expiry — they'll likely fail on-chain with MarketNotOpen
    const EXPIRY_BUFFER_MS = 30_000; // 30 seconds
    if (market.expiryAt) {
      const expiryMs = new Date(market.expiryAt).getTime();
      const remainingMs = expiryMs - Date.now();
      if (remainingMs < EXPIRY_BUFFER_MS) {
        return reply.code(409).send({
          error: { code: 'MARKET_EXPIRING', message: `Market closes in ${Math.round(remainingMs / 1000)}s — orders cannot be placed within 30 seconds of expiry` },
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
      if (!isSessionOrder && !isAgent) {
        const delCheck = await matchingService.checkDelegation(userId, 0);
        if (!delCheck.isApproved) {
          return reply.code(400).send({ error: { code: 'DELEGATION_REQUIRED', message: delCheck.error } });
        }
      } else {
        logger.debug(`[Orders] ${isAgent ? 'Agent' : 'Session'} order — using cached delegation for sell`);
      }

      // Check if this position has a margin account (leveraged position)
      const position = await positionService.getPosition(userId, market.id);
      let marginAccount = null;
      if (position) {
        marginAccount = await marginService.getByPositionId(position.id);
      }
      
      // Check if margin account exists but is already closed/liquidated
      if (marginAccount && (marginAccount.status === 'CLOSED' || marginAccount.status === 'LIQUIDATED')) {
        logger.warn(`[Orders] Sell rejected - leveraged position already ${marginAccount.status}`, {
          marginAccountId: marginAccount.id,
          status: marginAccount.status,
        });
        return reply.code(410).send({ 
          error: { 
            code: 'POSITION_ALREADY_CLOSED', 
            message: marginAccount.status === 'LIQUIDATED' 
              ? 'This leveraged position has been liquidated. Please refresh to see your updated positions.'
              : 'This leveraged position has already been closed.',
          } 
        });
      }
      
      const isLeveragedPosition = marginAccount && marginAccount.status === 'OPEN';
      
      if (isLeveragedPosition) {
        // CHECK LIQUIDATION LOCK - reject if position is being liquidated
        const liquidatingAt = await marginService.isBeingLiquidated(marginAccount.id);
        if (liquidatingAt) {
          logger.warn(`[Orders] Sell rejected - position is being liquidated`, {
            marginAccountId: marginAccount.id,
            liquidatingAt,
          });
          return reply.code(409).send({ 
            error: { 
              code: 'POSITION_BEING_LIQUIDATED', 
              message: 'This position is currently being liquidated. Please wait for the liquidation to complete.',
              liquidatingAt: liquidatingAt.toISOString(),
            } 
          });
        }
        
        logger.info(`[Orders] Closing leveraged position: ${data.size} ${outcomeUpper} shares, margin account ${marginAccount.id}`);
      }
      
      // Execute the sell order
      // For leveraged positions, the on-chain shares are owned by Lending Pool
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
        // LEVERAGED CLOSE: On-chain shares are owned by Lending Pool
        isLeveragedClose: isLeveragedPosition || false,
      });
      
      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Sell matching complete (${Date.now()-sellStart}ms), ${result.fills.length} fills`);
      
      logEvents.orderPlaced({
        orderId: result.orderId,
        userId, wallet, marketId: market.id, asset: market.asset, timeframe: market.timeframe,
        side: 'ASK', outcome: outcomeUpper, price: result.avgPrice, size: result.totalSold, orderType: 'MARKET',
      });
      
      // Handle leveraged position closure
      let marginClosed = false;
      let loanRepaid = 0;
      let userEquityReturned = 0;
      
      if (isLeveragedPosition && result.totalSold > 0 && marginAccount) {
        try {
          const marginShares = parseFloat(marginAccount.shares);
          const soldShares = result.totalSold;
          
          // Check if this is a full close (sold all or nearly all shares)
          const isFullClose = soldShares >= marginShares - 0.001;
          
          if (isFullClose) {
            // Full close: close the margin account
            const loanAmount = parseFloat(marginAccount.loanAmount);
            const proceeds = result.totalProceeds;
            
            // Calculate user equity: proceeds - loan
            const userEquity = Math.max(0, proceeds - loanAmount);
            
            // Record loan repayment
            if (loanAmount > 0) {
              await lendingService.recordRepayment(Math.min(loanAmount, proceeds));
              loanRepaid = Math.min(loanAmount, proceeds);
            }
            
            // Close the margin account
            await marginService.closeAccount(marginAccount.id);
            marginClosed = true;
            userEquityReturned = userEquity;
            
            logger.info(`[Orders] Closed leveraged position: proceeds=$${proceeds.toFixed(2)}, loan=$${loanAmount.toFixed(2)}, equity=$${userEquity.toFixed(2)}`);
            
            // ASYNC OPTIMIZATION: Fire off on-chain operations in background
            // We return response immediately - GUI updates before on-chain completes
            // On-chain close and equity transfer still happen IN ORDER (close first, then transfer)
            // This is safe because lending pool has ample funds
            const positionIdToSettle = position.id;
            const orderId = result.orderId;
            
            // Fire-and-forget the on-chain operations (they still run in sequence internally)
            (async () => {
              try {
                // Wait a bit for the on-chain close to complete (fired by matching service)
                // The matching service fires execute_close asynchronously
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Now transfer equity to user
                if (userEquity > 0) {
                  const transferSig = await lendingService.transferToUser(wallet, userEquity);
                  if (transferSig) {
                    logger.info(`[Orders] Transferred $${userEquity.toFixed(2)} equity to user ${wallet.slice(0,8)}: ${transferSig}`);
                    
                    // Update trade records with equity transfer signature
                    try {
                      await db
                        .update(trades)
                        .set({
                          txSignature: transferSig,
                          txStatus: 'CONFIRMED',
                          confirmedAt: new Date(),
                        })
                        .where(eq(trades.takerOrderId, orderId));
                      logger.info(`[Orders] Updated trade txSignature to equity transfer: ${transferSig.slice(0, 16)}...`);
                    } catch (updateErr: any) {
                      logger.warn(`[Orders] Failed to update trade txSignature: ${updateErr.message}`);
                    }
                  } else {
                    logger.error(`[Orders] Failed to transfer equity to user ${wallet.slice(0,8)} - no signature returned`);
                  }
                }
                
                // Mark position as settled after transfer succeeds
                try {
                  await positionService.markAsSettled(positionIdToSettle, userEquity);
                  logger.info(`[Orders] Marked position ${positionIdToSettle} as SETTLED after leveraged close`);
                } catch (settleErr: any) {
                  logger.error(`[Orders] Failed to mark position as settled: ${settleErr.message}`);
                }
              } catch (bgErr: any) {
                logger.error(`[Orders] Background leveraged close failed: ${bgErr.message}`);
              }
            })();
            
          } else {
            // Partial close: update margin account proportionally
            const closeRatio = soldShares / marginShares;
            const partialLoanRepay = parseFloat(marginAccount.loanAmount) * closeRatio;
            const partialProceeds = result.totalProceeds;
            
            // Calculate user equity from this partial close: proceeds - loan portion
            const partialUserEquity = Math.max(0, partialProceeds - partialLoanRepay);
            
            // Record partial loan repayment
            if (partialLoanRepay > 0) {
              await lendingService.recordRepayment(partialLoanRepay);
              loanRepaid = partialLoanRepay;
            }
            
            // Update margin account with new shares, loan, and liquidation price
            const { newShares, newLoan, newLiqPrice } = await marginService.updateAfterPartialClose(
              marginAccount.id,
              soldShares,
              partialLoanRepay
            );
            
            logger.info(`[Orders] Partial close of leveraged position: sold ${soldShares.toFixed(2)}/${marginShares.toFixed(2)}, remaining ${newShares.toFixed(2)} shares, loan $${newLoan.toFixed(2)}, liq $${newLiqPrice.toFixed(4)}`);
            
            // Transfer user equity from partial close (proceeds minus loan repayment)
            if (partialUserEquity > 0) {
              // Fire-and-forget: transfer equity in background (similar to full close)
              const orderId = result.orderId;
              (async () => {
                try {
                  // Wait for on-chain close to complete first
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  
                  const transferSig = await lendingService.transferToUser(wallet, partialUserEquity);
                  if (transferSig) {
                    logger.info(`[Orders] Transferred $${partialUserEquity.toFixed(2)} partial close equity to user ${wallet.slice(0,8)}: ${transferSig}`);
                    
                    // Update trade txSignature to the equity transfer (this is what user cares about)
                    try {
                      await db
                        .update(trades)
                        .set({
                          txSignature: transferSig,
                          txStatus: 'CONFIRMED',
                          confirmedAt: new Date(),
                        })
                        .where(eq(trades.takerOrderId, orderId));
                      logger.info(`[Orders] Updated partial close trade txSignature to equity transfer: ${transferSig.slice(0, 16)}...`);
                    } catch (updateErr: any) {
                      logger.warn(`[Orders] Failed to update partial close trade txSignature: ${updateErr.message}`);
                    }
                  } else {
                    logger.error(`[Orders] Failed to transfer partial equity to user ${wallet.slice(0,8)}`);
                  }
                } catch (err: any) {
                  logger.error(`[Orders] Background partial equity transfer failed: ${err.message}`);
                }
              })();
              
              userEquityReturned = partialUserEquity;
            }
          }
        } catch (err: any) {
          logger.error(`[Orders] Failed to handle leveraged position close: ${err.message}`);
          // Don't fail the sell order - the shares are already sold
        }
      }
      
      // Build position data for immediate frontend update
      // For sells, calculate remaining shares from the sell result
      let positionData = null;
      
      // For leveraged full closes, we already know position is being closed
      if (marginClosed) {
        // Position fully closed - return null so frontend removes it
        positionData = null;
      } else if (result.totalSold > 0 && position) {
        // For partial sells or non-leveraged sells, calculate remaining shares
        const originalYesShares = parseFloat(position.yesShares || '0');
        const originalNoShares = parseFloat(position.noShares || '0');
        
        // Calculate remaining shares after this sale
        const soldShares = result.totalSold;
        const remainingYes = outcomeUpper === 'YES' 
          ? Math.max(0, originalYesShares - soldShares)
          : originalYesShares;
        const remainingNo = outcomeUpper === 'NO' 
          ? Math.max(0, originalNoShares - soldShares)
          : originalNoShares;
        
        // Only include position if shares remain
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
            unrealizedPnL: 0, // Will be calculated by frontend
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
        createdAt: Date.now(),
        // Position data for immediate frontend update (null if position fully closed)
        position: positionData,
        // Leverage close details
        ...(isLeveragedPosition && {
          leverageClosed: marginClosed,
          loanRepaid,
          userEquityReturned,
        }),
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
      const loanCheckStart = Date.now();
      const loanCheck = await lendingService.canMakeLoan(loanAmount, userId);
      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Loan check done (${Date.now()-loanCheckStart}ms)`);
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
    
    // Delegation check — verify user has approved relayer to spend their USDC
    // For session/agent orders: skip full on-chain check for speed
    if (!isSessionOrder && !isAgent) {
      const delCheckStart = Date.now();
      const delCheck = await matchingService.checkDelegation(userId, requiredAmount);
      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Delegation check done (${Date.now()-delCheckStart}ms)`);

      if (!delCheck.isApproved || delCheck.error) {
        return reply.code(400).send({ error: { code: 'DELEGATION_INSUFFICIENT', message: delCheck.error } });
      }
    } else if (isAgent) {
      // Agent orders: delegation managed by MCP server / agent setup flow
      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Agent order — skipping delegation check`);
    } else {
      // Session orders: skip full on-chain check for speed, but verify session is still valid
      // The session service already validates expiry during signature verification above
      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Session order — using cached delegation status`);
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
      
      // Build position data for immediate frontend update
      let positionData = null;
      if (result.filledSize > 0) {
        const yesShares = outcomeUpper === 'YES' ? result.filledSize : 0;
        const noShares = outcomeUpper === 'NO' ? result.filledSize : 0;
        const totalCost = result.filledSize * data.price;
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
          currentPrice,
          unrealizedPnL: (currentPrice - data.price) * result.filledSize,
          status: 'open' as const,
          createdAt: Date.now(),
          // Leverage fields if applicable
          ...(isLeveraged && {
            leverage,
            marginDeposited: leverageCalc.initialMarginRequired(totalCost, leverage),
            loanAmount: leverageCalc.loanAmount(totalCost, leverage),
            liquidationPrice: outcomeUpper === 'YES'
              ? leverageCalc.liquidationPriceYes(result.filledSize, data.price, leverageCalc.loanAmount(totalCost, leverage))
              : leverageCalc.liquidationPriceNo(result.filledSize, data.price, leverageCalc.loanAmount(totalCost, leverage)),
            marginAccountId: marginAccountId || undefined,
          }),
        };
      }
      
      return {
        orderId: result.orderId,
        status: result.status,
        fills: result.fills.length,
        filledSize: result.filledSize,
        createdAt: Date.now(),
        leverage: isLeveraged ? leverage : undefined,
        marginAccountId: marginAccountId || undefined,
        // Position data for immediate frontend update
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
        // Leverage fields (for on-chain execution through Lending Pool)
        leverage: isLeveraged ? leverage : undefined,
        marginAmount: isLeveraged ? marginRequired : undefined,
        loanAmount: isLeveraged ? loanAmount : undefined,
      });

      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Matching complete (${Date.now()-matchStart}ms), ${result.fills.length} fills`);
      
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
      
      // Build position data for immediate frontend update
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
          currentPrice,
          unrealizedPnL: (currentPrice - result.avgPrice) * result.totalContracts,
          status: 'open' as const,
          createdAt: Date.now(),
          // Leverage fields if applicable
          ...(isLeveraged && {
            leverage,
            marginDeposited: leverageCalc.initialMarginRequired(totalCost, leverage),
            loanAmount: leverageCalc.loanAmount(totalCost, leverage),
            liquidationPrice: outcomeUpper === 'YES'
              ? leverageCalc.liquidationPriceYes(result.totalContracts, result.avgPrice, leverageCalc.loanAmount(totalCost, leverage))
              : leverageCalc.liquidationPriceNo(result.totalContracts, result.avgPrice, leverageCalc.loanAmount(totalCost, leverage)),
            marginAccountId: marginAccountId || undefined,
          }),
        };
      }
      
      logger.info(`[⏱️ ORDER API] T+${Date.now()-t0}ms: Sending response with position data`);
      
      return {
        orderId: result.orderId,
        status: result.totalContracts > 0 ? (result.unfilledDollars > 0.01 ? 'partial' : 'filled') : 'cancelled',
        fills: result.fills.length,
        filledSize: result.totalContracts,
        avgPrice: result.avgPrice,
        createdAt: Date.now(),
        leverage: isLeveraged ? leverage : undefined,
        marginAccountId: marginAccountId || undefined,
        // Position data for immediate frontend update
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
