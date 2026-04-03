import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/index.js';
import { users, settlements, positions } from '../db/schema.js';
import { eq, desc, sql, and, gt } from 'drizzle-orm';
import { logger } from '../lib/logger.js';

export async function agentRoutes(app: FastifyInstance) {
  /**
   * GET /agents/leaderboard
   * Public endpoint — returns ranked agent stats with lifetime PnL.
   */
  app.get('/leaderboard', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await db
        .select({
          walletAddress: users.walletAddress,
          agentName: users.agentName,
          totalVolume: users.totalVolume,
          totalTrades: users.totalTrades,
          memberSince: users.createdAt,
          agentMetadata: users.agentMetadata,
        })
        .from(users)
        .where(eq(users.isAgent, true))
        .orderBy(desc(sql`COALESCE(${users.totalVolume}, '0')::numeric`))
        .limit(100);

      const walletIds = result.map((r) => r.walletAddress);
      if (walletIds.length === 0) {
        return { agents: [], updatedAt: Date.now() };
      }

      // Aggregate realized PnL from settlements per user wallet
      const pnlRows = await db
        .select({
          walletAddress: users.walletAddress,
          lifetimePnl: sql<string>`COALESCE(SUM(${settlements.profit}), '0')`,
          totalSettlements: sql<number>`COUNT(${settlements.id})::int`,
          wins: sql<number>`COUNT(CASE WHEN ${settlements.profit}::numeric > 0 THEN 1 END)::int`,
          losses: sql<number>`COUNT(CASE WHEN ${settlements.profit}::numeric <= 0 THEN 1 END)::int`,
        })
        .from(settlements)
        .innerJoin(users, eq(settlements.userId, users.id))
        .where(eq(users.isAgent, true))
        .groupBy(users.walletAddress);

      // Aggregate realized PnL from closed positions (sell trades)
      const closePnlRows = await db
        .select({
          walletAddress: users.walletAddress,
          realizedPnl: sql<string>`COALESCE(SUM(${positions.realizedPnl}), '0')`,
        })
        .from(positions)
        .innerJoin(users, eq(positions.userId, users.id))
        .where(and(
          eq(users.isAgent, true),
          gt(sql`ABS(${positions.realizedPnl}::numeric)`, 0),
        ))
        .groupBy(users.walletAddress);

      const pnlMap = new Map(pnlRows.map((r) => [r.walletAddress, r]));
      const closePnlMap = new Map(closePnlRows.map((r) => [r.walletAddress, r]));

      const agents = result.map((agent, idx) => {
        const pnl = pnlMap.get(agent.walletAddress);
        const closePnl = closePnlMap.get(agent.walletAddress);
        const settlementPnl = parseFloat(pnl?.lifetimePnl || '0');
        const tradingPnl = parseFloat(closePnl?.realizedPnl || '0');

        return {
          rank: idx + 1,
          wallet: agent.walletAddress,
          name: agent.agentName || `Agent ${agent.walletAddress.slice(0, 6)}`,
          volume: parseFloat(agent.totalVolume || '0'),
          trades: agent.totalTrades || 0,
          lifetimePnl: settlementPnl + tradingPnl,
          settlements: pnl?.totalSettlements || 0,
          winRate: pnl && pnl.totalSettlements > 0
            ? Math.round((pnl.wins / pnl.totalSettlements) * 100)
            : 0,
          memberSince: agent.memberSince?.getTime() || 0,
          metadata: agent.agentMetadata,
        };
      });

      // Re-sort by lifetime PnL descending and re-rank
      agents.sort((a, b) => b.lifetimePnl - a.lifetimePnl);
      agents.forEach((a, i) => { a.rank = i + 1; });

      return { agents, updatedAt: Date.now() };
    } catch (err: any) {
      logger.error(`Agent leaderboard error: ${err.message}`);
      return reply.code(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch agent leaderboard' },
      });
    }
  });
}
