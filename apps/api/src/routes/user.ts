import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { or, eq, desc } from 'drizzle-orm';
import { requireAuth, getCurrentUserId, getCurrentWallet } from '../lib/auth.js';
import { positionService } from '../services/position.service.js';
import { orderService } from '../services/order.service.js';
import { userService } from '../services/user.service.js';
import { marketService } from '../services/market.service.js';
import { anchorClient } from '../lib/anchor-client.js';
import { db, trades, settlements, markets } from '../db/index.js';

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

  /**
   * GET /user/positions
   * Get all user positions
   */
  app.get('/positions', async (request: FastifyRequest, reply: FastifyReply) => {
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
    
    const positions = await positionService.getUserPositions(userId, status);

    // Truncate to 6 decimals to match on-chain precision
    const truncate6 = (n: number) => Math.floor(n * 1_000_000) / 1_000_000;
    
    return positions.map((p) => {
      const yesShares = truncate6(parseFloat(p.yesShares || '0'));
      const noShares = truncate6(parseFloat(p.noShares || '0'));
      const avgEntry = yesShares > 0 
        ? parseFloat(p.avgEntryYes || '0')
        : parseFloat(p.avgEntryNo || '0');
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
        currentPrice,
        unrealizedPnL: parseFloat(unrealizedPnL.toFixed(2)),
        totalCost: parseFloat(p.totalCost || '0'),
        status: p.status?.toLowerCase() || 'open',
      };
    });
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
   * Get user's trade history (all transactions: opens, closes, settlements)
   * 
   * Returns transactions from:
   * 1. Trades table - where user is maker or taker (opening/closing positions)
   * 2. Settlements table - when market expires and positions are settled
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
    
    // 1. Get trades where user is maker OR taker
    const userTrades = await db
      .select({
        id: trades.id,
        marketId: trades.marketId,
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
      .orderBy(desc(trades.executedAt))
      .limit(limit + 1) // +1 to check if there are more
      .offset(offset);
    
    // 2. Get settlements for this user
    const userSettlements = await db
      .select({
        id: settlements.id,
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
      })
      .from(settlements)
      .leftJoin(markets, eq(settlements.marketId, markets.id))
      .where(eq(settlements.userId, userId))
      .orderBy(desc(settlements.createdAt))
      .limit(limit)
      .offset(offset);
    
    // Transform trades into unified format
    const tradeTransactions = userTrades.slice(0, limit).map((t) => {
      const isMaker = t.makerUserId === userId;
      const isTaker = t.takerUserId === userId;
      
      // Determine user's perspective
      const userOutcome = isTaker ? t.takerOutcome : t.makerOutcome;
      const userPrice = isTaker ? parseFloat(t.takerPrice || '0') : parseFloat(t.makerPrice || '0');
      const userNotional = isTaker ? parseFloat(t.takerNotional || '0') : parseFloat(t.makerNotional || '0');
      const userFee = isTaker ? parseFloat(t.takerFee || '0') : parseFloat(t.makerFee || '0');
      const size = parseFloat(t.size || '0');
      
      // Determine if this is an opening or closing trade
      // BID = buying contracts (opening position)
      // ASK = selling contracts (closing position)
      const takerSide = t.takerSide;
      const isOpening = isTaker 
        ? takerSide === 'BID' // Taker buying = opening
        : takerSide === 'ASK'; // Maker on other side of taker's sell = opening
      
      const transactionType = isOpening ? 'open' : 'close';
      
      // Note: We don't calculate PnL for trades because we don't have cost basis
      // PnL is only shown for settlements where we have the actual profit stored
      
      return {
        id: t.id,
        type: 'trade' as const,
        transactionType,
        marketAddress: t.marketPubkey || '',
        market: t.marketAsset && t.marketTimeframe 
          ? `${t.marketAsset}-${t.marketTimeframe}` 
          : '',
        asset: t.marketAsset || '',
        expiryAt: t.marketExpiryAt?.getTime() || 0,
        outcome: userOutcome?.toLowerCase() || '',
        side: isTaker ? (takerSide === 'BID' ? 'buy' : 'sell') : (takerSide === 'BID' ? 'sell' : 'buy'),
        price: userPrice,
        size: size,
        notional: userNotional,
        fee: userFee,
        // PnL is not available for trades - would need cost basis from original purchase
        pnl: undefined,
        txSignature: t.txSignature || '',
        timestamp: t.executedAt?.getTime() || 0,
      };
    });
    
    // Transform settlements into unified format (filter out 0-share settlements)
    const settlementTransactions = userSettlements
      .filter((s) => parseFloat(s.winningShares || '0') > 0)
      .map((s) => {
      const payout = parseFloat(s.payoutAmount || '0');
      const profit = parseFloat(s.profit || '0');
      const shares = parseFloat(s.winningShares || '0');
      const isWin = payout > 0;
      
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
        price: isWin ? 1.0 : 0.0, // Settlement price is $1 for win, $0 for loss
        size: shares,
        notional: payout,
        fee: 0,
        pnl: profit,
        txSignature: s.txSignature || '',
        timestamp: s.createdAt?.getTime() || 0,
      };
    });
    
    // Combine and sort by timestamp descending
    const allTransactions = [...tradeTransactions, ...settlementTransactions]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
    
    const hasMore = userTrades.length > limit;
    
    return {
      transactions: allTransactions,
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
