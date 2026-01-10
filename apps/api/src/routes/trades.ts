import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { trades, markets, users } from '../db/schema.js';
import { desc, eq, and, isNotNull } from 'drizzle-orm';
import { logger } from '../lib/logger.js';

// Validation schemas
const globalTradesQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
  before: z.string().uuid().optional(),
  asset: z.enum(['BTC', 'ETH', 'SOL']).optional(),
});

export async function tradesRoutes(app: FastifyInstance) {
  /**
   * GET /trades/global
   * Get all trades across the platform (global trade blotter)
   * Shows all executed trades with market info and Solscan links
   */
  app.get('/global', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = globalTradesQuerySchema.safeParse(request.query);
    
    if (!query.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid query parameters',
          details: query.error.flatten(),
        },
      });
    }
    
    const { limit, before, asset } = query.data;
    
    try {
      // Build query conditions
      const conditions = [isNotNull(trades.txSignature)];
      
      // Join with markets to get asset/timeframe info
      let tradesQuery = db
        .select({
          id: trades.id,
          marketId: trades.marketId,
          takerSide: trades.takerSide,
          takerOutcome: trades.takerOutcome,
          takerPrice: trades.takerPrice,
          makerOutcome: trades.makerOutcome,
          makerPrice: trades.makerPrice,
          size: trades.size,
          txSignature: trades.txSignature,
          txStatus: trades.txStatus,
          executedAt: trades.executedAt,
          // Market info
          marketAsset: markets.asset,
          marketTimeframe: markets.timeframe,
          marketPubkey: markets.pubkey,
          marketStrike: markets.strikePrice,
          marketExpiry: markets.expiryAt,
          // Taker info (truncated wallet for display)
          takerUserId: trades.takerUserId,
        })
        .from(trades)
        .innerJoin(markets, eq(trades.marketId, markets.id))
        .where(
          asset 
            ? and(...conditions, eq(markets.asset, asset))
            : and(...conditions)
        )
        .orderBy(desc(trades.executedAt))
        .limit(limit);
      
      const result = await tradesQuery;
      
      // Format response
      const formattedTrades = result.map((t) => {
        const executedAt = t.executedAt instanceof Date ? t.executedAt : new Date(t.executedAt || 0);
        const expiryAt = t.marketExpiry instanceof Date ? t.marketExpiry : new Date(t.marketExpiry || 0);
        
        // Generate market name
        const marketName = `${t.marketAsset}-${t.marketTimeframe}`;
        
        return {
          id: t.id,
          market: marketName,
          marketAddress: t.marketPubkey,
          asset: t.marketAsset,
          timeframe: t.marketTimeframe,
          // Trade details (taker's perspective for display)
          side: t.takerSide?.toLowerCase() === 'bid' ? 'buy' : 'sell',
          outcome: t.takerOutcome?.toLowerCase(),
          price: parseFloat(t.takerPrice || '0'),
          size: parseFloat(t.size || '0'),
          notional: parseFloat(t.takerPrice || '0') * parseFloat(t.size || '0'),
          // Blockchain
          txSignature: t.txSignature,
          txStatus: t.txStatus,
          // Explorer links
          solscanUrl: t.txSignature ? `https://solscan.io/tx/${t.txSignature}` : null,
          solanaExplorerUrl: t.txSignature ? `https://explorer.solana.com/tx/${t.txSignature}` : null,
          // Timestamps
          timestamp: executedAt.getTime(),
          marketExpiry: expiryAt.getTime(),
        };
      });
      
      return {
        trades: formattedTrades,
        nextCursor: result.length === limit ? result[result.length - 1]?.id : null,
      };
    } catch (err) {
      logger.error('Failed to fetch global trades:', err);
      return reply.code(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch trades',
        },
      });
    }
  });
}

