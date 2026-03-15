import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { or, eq, desc } from 'drizzle-orm';
import { requireAuth, getCurrentUserId, getCurrentWallet } from '../lib/auth.js';
import { positionService } from '../services/position.service.js';
import { orderService } from '../services/order.service.js';
import { userService } from '../services/user.service.js';
import { marketService } from '../services/market.service.js';
import { anchorClient } from '../lib/anchor-client.js';
import { db, trades, settlements, markets, positions } from '../db/index.js';
import { logger } from '../lib/logger.js';

// Validation schemas
const positionsQuerySchema = z.object({
  status: z.enum(['open', 'settled', 'all']).default('all'),
});

const ordersQuerySchema = z.object({
  status: z.enum(['open', 'partial', 'filled', 'cancelled', 'all']).default('all'),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

const tradesQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
});

const settlementsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

export async function userRoutes(app: FastifyInstance) {
  // Apply auth middleware to all routes in this plugin
  app.addHook('preHandler', requireAuth);

  /**
   * GET /user/balance
   * Get user's USDC balance breakdown
   */
  app.get('/balance', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    const wallet = getCurrentWallet(request);
    
    if (!userId || !wallet) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    // Get user's open positions to calculate cost basis
    const positions = await positionService.getUserPositions(userId, 'OPEN');
    const lockedInPositions = positions.reduce((sum, p) => {
      return sum + parseFloat(p.totalCost || '0');
    }, 0);

    // Get user's open orders to calculate locked in orders
    const { orders: openOrders } = await orderService.getUserOrders(userId, { 
      status: 'OPEN',
      limit: 1000,
    });
    
    const lockedInOrders = openOrders.reduce((sum, o) => {
      const remaining = parseFloat(o.remainingSize || '0');
      const price = parseFloat(o.price);
      return sum + (remaining * price);
    }, 0);

    // Fetch actual USDC balance from chain
    const total = await anchorClient.getUsdcBalance(wallet);
    const available = total - lockedInOrders;

    return {
      total: total,
      available: Math.max(0, available),
      lockedInOrders: lockedInOrders,
      lockedInPositions: lockedInPositions,
      pendingSettlement: 0,
    };
  });

  // Track concurrent position requests
  let concurrentPositionRequests = 0;

  /**
   * GET /user/positions
   * Get all user positions
   */
  app.get('/positions', async (request: FastifyRequest, reply: FastifyReply) => {
    concurrentPositionRequests++;
    const startTime = Date.now();
    
    try {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    const query = positionsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Invalid query parameters' },
      });
    }

    const status = query.data.status === 'all' 
      ? undefined 
      : query.data.status.toUpperCase() as 'OPEN' | 'SETTLED';
    
      if (concurrentPositionRequests > 3) {
        logger.warn(`[User Positions] High concurrent requests: ${concurrentPositionRequests}`);
      }
      
    const positions = await positionService.getUserPositions(userId, status);
      
      const duration = Date.now() - startTime;
      if (duration > 200) {
        logger.debug(`[User Positions] Query took ${duration}ms (${positions.length} positions, concurrent=${concurrentPositionRequests})`);
      }

    // Truncate to 6 decimals to match on-chain precision
    const truncate6 = (n: number) => Math.floor(n * 1_000_000) / 1_000_000;
    
    return positions.map((p) => {
      const yesShares = truncate6(parseFloat(p.yesShares || '0'));
      const noShares = truncate6(parseFloat(p.noShares || '0'));
      const avgEntryYes = parseFloat(p.avgEntryYes || '0');
      const avgEntryNo = parseFloat(p.avgEntryNo || '0');
      const avgEntry = yesShares > 0 ? avgEntryYes : avgEntryNo;
      const currentPrice = p.market?.yesPrice 
        ? parseFloat(p.market.yesPrice) 
        : 0.5;
      const shares = yesShares > 0 ? yesShares : noShares;
      const unrealizedPnL = shares * (currentPrice - avgEntry);

      return {
        marketAddress: p.market?.pubkey || '',
        market: p.market 
          ? `${p.market.asset}-${p.market.timeframe}` 
          : '',
        asset: p.market?.asset,
        expiryAt: p.market?.expiryAt?.getTime(),
        yesShares,
        noShares,
        avgEntryPrice: avgEntry,
        avgEntryYes,
        avgEntryNo,
        currentPrice,
        unrealizedPnL: parseFloat(unrealizedPnL.toFixed(2)),
        totalCost: parseFloat(p.totalCost || '0'),
        status: p.status?.toLowerCase() || 'open',
      };
    });
    } finally {
      concurrentPositionRequests--;
    }
  });

  /**
   * GET /user/positions/:marketAddress
   * Get user position for a specific market
   */
  app.get('/positions/:marketAddress', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    const { marketAddress } = request.params as { marketAddress: string };
    
    // Get market by pubkey to get the internal ID
    const market = await marketService.getByPubkey(marketAddress);
    if (!market) {
      return reply.code(404).send({
        error: { code: 'MARKET_NOT_FOUND', message: 'Market not found' },
      });
    }

    const position = await positionService.getPosition(userId, market.id);
    
    if (!position) {
      // Return empty position if user has no position in this market
      return {
        marketAddress,
        market: `${market.asset}-${market.timeframe}`,
        yesShares: 0,
        noShares: 0,
        avgEntryYes: 0,
        avgEntryNo: 0,
        totalCost: 0,
        realizedPnl: 0,
        status: 'open',
      };
    }

    // Truncate to 6 decimals to match on-chain precision
    const truncate6 = (n: number) => Math.floor(n * 1_000_000) / 1_000_000;
    
    const yesShares = truncate6(parseFloat(position.yesShares || '0'));
    const noShares = truncate6(parseFloat(position.noShares || '0'));
    const currentYesPrice = market.yesPrice ? parseFloat(market.yesPrice) : 0.5;
    const currentNoPrice = market.noPrice ? parseFloat(market.noPrice) : 0.5;
    const avgEntryYes = parseFloat(position.avgEntryYes || '0');
    const avgEntryNo = parseFloat(position.avgEntryNo || '0');
    
    // Calculate unrealized PnL for each outcome
    const unrealizedYesPnl = yesShares * (currentYesPrice - avgEntryYes);
    const unrealizedNoPnl = noShares * (currentNoPrice - avgEntryNo);

    return {
      marketAddress,
      market: `${market.asset}-${market.timeframe}`,
      yesShares,
      noShares,
      avgEntryYes,
      avgEntryNo,
      totalCost: parseFloat(position.totalCost || '0'),
      realizedPnl: parseFloat(position.realizedPnl || '0'),
      unrealizedYesPnl: parseFloat(unrealizedYesPnl.toFixed(4)),
      unrealizedNoPnl: parseFloat(unrealizedNoPnl.toFixed(4)),
      currentYesPrice,
      currentNoPrice,
      status: position.status?.toLowerCase() || 'open',
    };
  });

  /**
   * GET /user/orders
   * Get user's order history
   */
  app.get('/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    const query = ordersQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Invalid query parameters' },
      });
    }

    const { status, limit, offset } = query.data;
    let statusFilter: any = status === 'all' ? 'all' : status.toUpperCase();
    
    // Map 'OPEN' to include 'PARTIAL' as well for the active orders view
    if (statusFilter === 'OPEN') {
      statusFilter = ['OPEN', 'PARTIAL'];
    }

    const { orders, total } = await orderService.getUserOrders(userId, {
      status: statusFilter,
      limit,
      offset,
    });

    return {
      orders: orders.map((o) => ({
          id: o.id,
          marketAddress: o.market?.pubkey || '',
          market: o.market 
            ? `${o.market.asset}-${o.market.timeframe}` 
            : '',
          asset: o.market?.asset,
          expiryAt: o.market?.expiryAt?.getTime(),
          side: o.side?.toLowerCase(),
          outcome: o.outcome?.toLowerCase(),
          type: o.orderType?.toLowerCase(),
          price: parseFloat(o.price),
          size: parseFloat(o.size),
          filledSize: parseFloat(o.filledSize || '0'),
          remainingSize: parseFloat(o.remainingSize || '0'),
          status: o.status?.toLowerCase(),
          dollarAmount: o.dollarAmount ? parseFloat(o.dollarAmount) : undefined,
          createdAt: o.createdAt?.getTime(),
          updatedAt: o.updatedAt?.getTime(),
      })),
      total,
      limit,
      offset,
    };
  });

  /**
   * GET /user/trades
   * Get user's trade history aggregated at ORDER level
   * 
   * Returns:
   * 1. Filled orders (aggregated from trades table) - shows total size, avg price, total fees
   * 2. Settlements - when market expires and positions are settled
   * 
   * Each order shows aggregated data from all its fills (executions).
   */
  app.get('/trades', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    const query = tradesQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Invalid query parameters' },
      });
    }

    const { limit, offset } = query.data;
    
    // 1. Get trades where user is maker OR taker, including order IDs
    const userTrades = await db
      .select({
        id: trades.id,
        marketId: trades.marketId,
        makerOrderId: trades.makerOrderId,
        takerOrderId: trades.takerOrderId,
        makerUserId: trades.makerUserId,
        takerUserId: trades.takerUserId,
        takerSide: trades.takerSide,
        takerOutcome: trades.takerOutcome,
        takerPrice: trades.takerPrice,
        takerNotional: trades.takerNotional,
        takerFee: trades.takerFee,
        makerOutcome: trades.makerOutcome,
        makerPrice: trades.makerPrice,
        makerNotional: trades.makerNotional,
        makerFee: trades.makerFee,
        size: trades.size,
        txSignature: trades.txSignature,
        txStatus: trades.txStatus,
        errorCode: trades.errorCode,
        executedAt: trades.executedAt,
        // Market info
        marketPubkey: markets.pubkey,
        marketAsset: markets.asset,
        marketTimeframe: markets.timeframe,
        marketExpiryAt: markets.expiryAt,
      })
      .from(trades)
      .leftJoin(markets, eq(trades.marketId, markets.id))
      .where(
        or(
          eq(trades.makerUserId, userId),
          eq(trades.takerUserId, userId)
        )
      )
      .orderBy(desc(trades.executedAt));
    
    // 3. Compute correct avgEntry at time of each sell from trade history.
    // Using the current position avgEntry is WRONG — it gets overwritten when
    // user sells all shares and re-buys at a different price.
    // Instead, replay trades chronologically to track avgEntry through time.
    // NOTE: Skip FAILED trades — they never settled on-chain.
    const sellAvgEntryMap = new Map<string, number>(); // orderId -> avgEntry at time of sell
    {
      // Group non-failed trades by market+outcome for this user
      const tradesByPosition = new Map<string, typeof userTrades>();
      for (const t of userTrades) {
        // Skip failed trades — they never settled on-chain
        if (t.txStatus === 'FAILED') continue;
        const isTaker = t.takerUserId === userId;
        const userOutcome = isTaker ? t.takerOutcome : t.makerOutcome;
        const key = `${t.marketId}-${userOutcome}`;
        if (!tradesByPosition.has(key)) tradesByPosition.set(key, []);
        tradesByPosition.get(key)!.push(t);
      }

      for (const [, groupTrades] of tradesByPosition) {
        // Sort chronologically (ASC) — userTrades came in DESC order
        const sorted = [...groupTrades].sort((a, b) =>
          (a.executedAt?.getTime() || 0) - (b.executedAt?.getTime() || 0)
        );

        let shares = 0;
        let avgEntry = 0;
        let totalCostBasis = 0;

        for (const t of sorted) {
          const isTaker = t.takerUserId === userId;
          const takerSide = t.takerSide;
          const size = parseFloat(t.size || '0');
          const userPrice = isTaker
            ? parseFloat(t.takerPrice || '0')
            : parseFloat(t.makerPrice || '0');
          const userFee = isTaker
            ? parseFloat(t.takerFee || '0')
            : parseFloat(t.makerFee || '0');

          // Is this user buying or selling?
          const isBuying = isTaker ? takerSide === 'BID' : takerSide === 'ASK';

          if (isBuying) {
            // Track cost basis including fees
            const fillCost = size * userPrice + userFee;
            totalCostBasis += fillCost;
            avgEntry = shares > 0
              ? (shares * avgEntry + size * userPrice) / (shares + size)
              : userPrice;
            shares += size;
          } else {
            // Selling — record the avgEntry at this point for PnL calc
            // Use cost basis per share (including buy fees) for accurate PnL
            const costBasisPerShare = shares > 0 ? totalCostBasis / shares : avgEntry;
            const orderId = isTaker ? t.takerOrderId : t.makerOrderId;
            if (orderId && !sellAvgEntryMap.has(orderId)) {
              sellAvgEntryMap.set(orderId, costBasisPerShare);
            }
            // Reduce cost basis proportionally for sold shares
            const soldFraction = Math.min(size, shares) / Math.max(shares, 0.000001);
            totalCostBasis = totalCostBasis * (1 - soldFraction);
            shares = Math.max(0, shares - size);
          }
        }
      }
    }

    // 4. Aggregate trades by order ID
    // Group by the user's order (takerOrderId if user is taker, makerOrderId if maker)
    interface OrderAggregation {
      orderId: string;
      marketId: string;
      marketAddress: string;
      market: string;
      asset: string;
      expiryAt: number;
      outcome: string;
      side: 'buy' | 'sell';
      transactionType: 'open' | 'close';
      totalSize: number;
      totalNotional: number;
      totalFee: number;
      txSignature: string; // Last tx signature for this order
      txStatus: string; // 'PENDING' | 'CONFIRMED' | 'FAILED'
      timestamp: number; // First execution timestamp
      fills: number; // Number of fills
      avgEntryPrice?: number; // For closing trades, the avg entry to calculate P&L
      errorCode?: string; // Error code for failed trades
    }
    
    const orderMap = new Map<string, OrderAggregation>();
    
    for (const t of userTrades) {
      const isTaker = t.takerUserId === userId;
      const orderId = isTaker ? t.takerOrderId : t.makerOrderId;
      
      if (!orderId) continue; // Skip if no order ID
      
      const userOutcome = isTaker ? t.takerOutcome : t.makerOutcome;
      const userPrice = isTaker ? parseFloat(t.takerPrice || '0') : parseFloat(t.makerPrice || '0');
      const userNotional = isTaker ? parseFloat(t.takerNotional || '0') : parseFloat(t.makerNotional || '0');
      const userFee = isTaker ? parseFloat(t.takerFee || '0') : parseFloat(t.makerFee || '0');
      const size = parseFloat(t.size || '0');
      
      // Determine if this is an opening or closing trade
      const takerSide = t.takerSide;
      const isOpening = isTaker 
        ? takerSide === 'BID'
        : takerSide === 'ASK';
      
      const side = isTaker ? (takerSide === 'BID' ? 'buy' : 'sell') : (takerSide === 'BID' ? 'sell' : 'buy');
      
      // For closing trades (sells), use the avgEntry computed from trade history replay
      let avgEntryPrice: number | undefined;
      if (!isOpening && orderId) {
        avgEntryPrice = sellAvgEntryMap.get(orderId);
      }
      
      const existing = orderMap.get(orderId);
      if (existing) {
        // Aggregate into existing order
        existing.totalSize += size;
        existing.totalNotional += userNotional;
        existing.totalFee += userFee;
        existing.fills += 1;
        // Keep the most recent tx signature
        if (t.txSignature) {
          existing.txSignature = t.txSignature;
        }
        // If ANY fill is FAILED, mark the whole order as FAILED
        if (t.txStatus === 'FAILED') {
          existing.txStatus = 'FAILED';
          if (t.errorCode) existing.errorCode = t.errorCode;
        } else if (existing.txStatus !== 'FAILED' && t.txStatus === 'CONFIRMED') {
          existing.txStatus = 'CONFIRMED';
        }
      } else {
        // Create new order aggregation
        orderMap.set(orderId, {
          orderId,
          marketId: t.marketId || '',
          marketAddress: t.marketPubkey || '',
          market: t.marketAsset && t.marketTimeframe
            ? `${t.marketAsset}-${t.marketTimeframe}`
            : '',
          asset: t.marketAsset || '',
          expiryAt: t.marketExpiryAt?.getTime() || 0,
          outcome: userOutcome?.toLowerCase() || '',
          side: side as 'buy' | 'sell',
          transactionType: isOpening ? 'open' : 'close',
          totalSize: size,
          totalNotional: userNotional,
          totalFee: userFee,
          txSignature: t.txSignature || '',
          txStatus: t.txStatus || 'PENDING',
          errorCode: t.errorCode || undefined,
          timestamp: t.executedAt?.getTime() || 0,
          fills: 1,
          avgEntryPrice,
        });
      }
    }
    
    // Convert to array and sort by timestamp
    const orderTransactions = Array.from(orderMap.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((o) => {
        const avgExecPrice = o.totalSize > 0 ? o.totalNotional / o.totalSize : 0;
        
        // Calculate P&L for closing trades (sells) — skip FAILED trades
        // P&L = proceeds - cost basis
        // proceeds = totalNotional (what we received from selling)
        // cost basis = size × avgEntryPrice (what we paid to buy)
        let pnl: number | undefined;
        if (o.txStatus !== 'FAILED' && o.transactionType === 'close' && o.avgEntryPrice && o.avgEntryPrice > 0) {
          const proceeds = o.totalNotional;
          const costBasis = o.totalSize * o.avgEntryPrice;
          pnl = proceeds - costBasis - o.totalFee; // Include fees in P&L
        }

        return {
          id: o.orderId,
          type: 'trade' as const,
          transactionType: o.transactionType,
          marketAddress: o.marketAddress,
          market: o.market,
          asset: o.asset,
          expiryAt: o.expiryAt,
          outcome: o.outcome,
          side: o.side,
          price: avgExecPrice, // Avg execution price
          size: o.totalSize,
          notional: o.totalNotional,
          fee: o.totalFee,
          pnl,
          txSignature: o.txSignature,
          txStatus: o.txStatus,
          errorCode: o.errorCode,
          timestamp: o.timestamp,
          fills: o.fills,
        };
      });
    
    // 3. Get settlements for this user (with position shares)
    const userSettlements = await db
      .select({
        id: settlements.id,
        positionId: settlements.positionId,
        marketId: settlements.marketId,
        outcome: settlements.outcome,
        winningShares: settlements.winningShares,
        payoutAmount: settlements.payoutAmount,
        profit: settlements.profit,
        txSignature: settlements.txSignature,
        createdAt: settlements.createdAt,
        // Market info
        marketPubkey: markets.pubkey,
        marketAsset: markets.asset,
        marketTimeframe: markets.timeframe,
        marketExpiryAt: markets.expiryAt,
        // Position shares (for accurate size on losses)
        posYesShares: positions.yesShares,
        posNoShares: positions.noShares,
      })
      .from(settlements)
      .leftJoin(markets, eq(settlements.marketId, markets.id))
      .leftJoin(positions, eq(settlements.positionId, positions.id))
      .where(eq(settlements.userId, userId))
      .orderBy(desc(settlements.createdAt));

    // Transform settlements into unified format (include both wins and losses)
    const settlementTransactions = userSettlements
      .map((s) => {
        const payout = parseFloat(s.payoutAmount || '0');
        const profit = parseFloat(s.profit || '0');
        const winShares = parseFloat(s.winningShares || '0');
        const isWin = payout > 0;
        // For losses, use actual position shares (yes+no) instead of cost
        const posYes = parseFloat(s.posYesShares || '0');
        const posNo = parseFloat(s.posNoShares || '0');
        const totalShares = posYes + posNo;
        const shares = winShares > 0 ? winShares : totalShares;

        return {
          id: s.id,
          type: 'settlement' as const,
          transactionType: 'close' as const,
          marketAddress: s.marketPubkey || '',
          market: s.marketAsset && s.marketTimeframe
            ? `${s.marketAsset}-${s.marketTimeframe}`
            : '',
          asset: s.marketAsset || '',
          expiryAt: s.marketExpiryAt?.getTime() || 0,
          outcome: s.outcome?.toLowerCase() || '',
          side: 'settlement' as const,
          price: isWin ? 1.0 : 0.0,
          size: shares,
          notional: payout,
          fee: 0,
          pnl: profit,
          txSignature: s.txSignature || '',
          timestamp: s.createdAt?.getTime() || 0,
        };
      });
    
    // Combine and sort by timestamp descending
    const allTransactions = [...orderTransactions, ...settlementTransactions]
      .sort((a, b) => b.timestamp - a.timestamp);
    
    // Apply pagination
    const paginatedTransactions = allTransactions.slice(offset, offset + limit);
    const hasMore = allTransactions.length > offset + limit;
    
    return {
      transactions: paginatedTransactions,
      total: allTransactions.length,
      limit,
      offset,
      hasMore,
    };
  });

  /**
   * GET /user/settlements
   * Get user's settlement history
   */
  app.get('/settlements', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    const query = settlementsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Invalid query parameters' },
      });
    }

    const settlements = await positionService.getUserSettlements(userId, query.data.limit);

    return {
      settlements: settlements.map((s) => ({
        marketAddress: s.market?.pubkey || '',
        market: s.market 
          ? `${s.market.asset}-${s.market.timeframe}` 
          : '',
        outcome: s.settlement.outcome,
        winningShares: parseFloat(s.settlement.winningShares),
        payout: parseFloat(s.settlement.payoutAmount),
        profit: parseFloat(s.settlement.profit),
        txSignature: s.settlement.txSignature,
        settledAt: s.settlement.createdAt?.getTime(),
      })),
      total: settlements.length,
    };
  });

  /**
   * GET /user/stats
   * Get user's trading statistics
   */
  app.get('/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    const user = await userService.findById(userId);
    if (!user) {
      return reply.code(404).send({
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }

    return {
      totalVolume: parseFloat(user.totalVolume || '0'),
      totalTrades: user.totalTrades || 0,
      feeTier: user.feeTier || 0,
      memberSince: user.createdAt?.getTime(),
    };
  });
}
