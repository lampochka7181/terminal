import { eq, and, sql } from 'drizzle-orm';
import { db, positions, markets, settlements, type Position, type NewPosition } from '../db/index.js';

export interface PositionWithMarket extends Position {
  market?: {
    pubkey: string;
    asset: string;
    timeframe: string;
    strikePrice: string;
    expiryAt: Date;
    status: string | null;
    yesPrice: string | null;
    noPrice: string | null;
  };
}

export class PositionService {
  /**
   * Get all positions for a user
   */
  async getUserPositions(userId: string, status?: 'OPEN' | 'SETTLED'): Promise<PositionWithMarket[]> {
    let query = db
      .select({
        position: positions,
        market: {
          pubkey: markets.pubkey,
          asset: markets.asset,
          timeframe: markets.timeframe,
          strikePrice: markets.strikePrice,
          expiryAt: markets.expiryAt,
          status: markets.status,
          yesPrice: markets.yesPrice,
          noPrice: markets.noPrice,
        },
      })
      .from(positions)
      .leftJoin(markets, eq(positions.marketId, markets.id))
      .where(eq(positions.userId, userId));
    
    if (status) {
      query = query.where(and(eq(positions.userId, userId), eq(positions.status, status))) as typeof query;
    }
    
    const result = await query;
    
    return result.map((r) => ({
      ...r.position,
      market: r.market || undefined,
    }));
  }

  /**
   * Get a specific position
   */
  async getPosition(userId: string, marketId: string): Promise<Position | null> {
    const result = await db
      .select()
      .from(positions)
      .where(and(eq(positions.userId, userId), eq(positions.marketId, marketId)))
      .limit(1);
    
    return result[0] || null;
  }

  /**
   * Get or create position for user in market — race-safe.
   *
   * The previous SELECT-then-INSERT could race: two concurrent callers both
   * see "no row", both INSERT, the second hits the (user_id, market_id) UNIQUE
   * constraint and throws. Callers with `.catch()` swallowed that error and
   * silently lost the second caller's share update.
   *
   * This version does a single INSERT ... ON CONFLICT DO NOTHING and re-reads
   * on miss. No shares are written here — callers that need to increment
   * should use `updateAfterTrade`, which upserts atomically.
   */
  async getOrCreate(userId: string, marketId: string): Promise<Position> {
    const inserted = await db
      .insert(positions)
      .values({
        userId,
        marketId,
        yesShares: '0',
        noShares: '0',
        totalCost: '0',
        realizedPnl: '0',
        status: 'OPEN',
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length > 0) return inserted[0];

    // Row existed already — fetch and return.
    const existing = await this.getPosition(userId, marketId);
    if (!existing) {
      throw new Error(`Position for user ${userId} in market ${marketId} not found after upsert`);
    }
    return existing;
  }

  /**
   * Update position after a trade — atomic, concurrency-safe.
   *
   * @param isBuy - true if buying/acquiring shares, false if selling existing shares
   * @param cost - For buys: total cost paid. For sells: proceeds received.
   *
   * Implementation notes:
   * - A single taker market order walks the book and produces N fills, each
   *   with its own call to this method. Previously this was SELECT→compute→UPDATE
   *   in JS, which under concurrent fills for the same (user, market) loses
   *   updates: two callers read the same `current*` snapshot, compute in
   *   isolation, and the second UPDATE overwrites the first. Across a perf
   *   test with fresh wallets each taking multiple fills, this produced a
   *   consistent ~0.1% undercount visible via the DriftReconciler job.
   * - Fix: use a single atomic `INSERT ... ON CONFLICT DO UPDATE` that reads
   *   the DB's current values (`positions.*`) inside the UPDATE SET clause.
   *   Postgres serializes these via the primary-key lock, so two concurrent
   *   upserts for the same (user, market) accumulate correctly.
   * - The weighted-average entry price is computed in SQL from live DB values
   *   so it stays correct under concurrency too.
   */
  async updateAfterTrade(
    userId: string,
    marketId: string,
    outcome: 'YES' | 'NO',
    shares: number,
    cost: number,
    isBuy: boolean
  ): Promise<void> {
    // Round to match on-chain 6-decimal precision (see previous note on why
    // Math.round beats Math.floor after float round-trips).
    const truncateToOnChainPrecision = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
    const sharesDelta = truncateToOnChainPrecision(shares);
    if (sharesDelta <= 0) return;

    if (isBuy) {
      // Price per share for the shares added in THIS fill (used to weight the
      // average-entry-price update). Bound away from div-by-zero above.
      const avgNew = cost / sharesDelta;
      const yesAdd = outcome === 'YES' ? sharesDelta : 0;
      const noAdd = outcome === 'NO' ? sharesDelta : 0;
      const avgYesNew = outcome === 'YES' ? avgNew : 0;
      const avgNoNew = outcome === 'NO' ? avgNew : 0;

      await db.execute(sql`
        INSERT INTO positions (
          user_id, market_id, yes_shares, no_shares, total_cost,
          avg_entry_yes, avg_entry_no, realized_pnl, status, created_at, updated_at
        )
        VALUES (
          ${userId}::uuid,
          ${marketId}::uuid,
          ${yesAdd.toString()}::numeric,
          ${noAdd.toString()}::numeric,
          ${cost.toString()}::numeric,
          ${avgYesNew.toString()}::numeric,
          ${avgNoNew.toString()}::numeric,
          '0'::numeric,
          'OPEN',
          NOW(),
          NOW()
        )
        ON CONFLICT (user_id, market_id) DO UPDATE SET
          yes_shares = positions.yes_shares + EXCLUDED.yes_shares,
          no_shares  = positions.no_shares  + EXCLUDED.no_shares,
          total_cost = positions.total_cost + EXCLUDED.total_cost,
          avg_entry_yes = CASE
            WHEN EXCLUDED.yes_shares > 0 AND (positions.yes_shares + EXCLUDED.yes_shares) > 0 THEN
              (positions.yes_shares * positions.avg_entry_yes + EXCLUDED.yes_shares * EXCLUDED.avg_entry_yes)
              / (positions.yes_shares + EXCLUDED.yes_shares)
            ELSE positions.avg_entry_yes
          END,
          avg_entry_no = CASE
            WHEN EXCLUDED.no_shares > 0 AND (positions.no_shares + EXCLUDED.no_shares) > 0 THEN
              (positions.no_shares * positions.avg_entry_no + EXCLUDED.no_shares * EXCLUDED.avg_entry_no)
              / (positions.no_shares + EXCLUDED.no_shares)
            ELSE positions.avg_entry_no
          END,
          status = 'OPEN',
          updated_at = NOW()
      `);
      return;
    }

    // SELL path — decrement shares and accumulate realized PnL atomically.
    // We don't INSERT-on-miss here: selling from a nonexistent position is a
    // logical no-op (no shares to reduce). If the row doesn't exist, the
    // UPDATE WHERE clause matches nothing and we return cleanly.
    if (outcome === 'YES') {
      await db.execute(sql`
        UPDATE positions SET
          realized_pnl  = positions.realized_pnl
                          + (${cost.toString()}::numeric - positions.avg_entry_yes * ${sharesDelta.toString()}::numeric),
          total_cost    = GREATEST(0::numeric, positions.total_cost - positions.avg_entry_yes * ${sharesDelta.toString()}::numeric),
          yes_shares    = GREATEST(0::numeric, positions.yes_shares - ${sharesDelta.toString()}::numeric),
          updated_at    = NOW()
        WHERE user_id = ${userId}::uuid AND market_id = ${marketId}::uuid
      `);
    } else {
      await db.execute(sql`
        UPDATE positions SET
          realized_pnl  = positions.realized_pnl
                          + (${cost.toString()}::numeric - positions.avg_entry_no * ${sharesDelta.toString()}::numeric),
          total_cost    = GREATEST(0::numeric, positions.total_cost - positions.avg_entry_no * ${sharesDelta.toString()}::numeric),
          no_shares     = GREATEST(0::numeric, positions.no_shares - ${sharesDelta.toString()}::numeric),
          updated_at    = NOW()
        WHERE user_id = ${userId}::uuid AND market_id = ${marketId}::uuid
      `);
    }
  }

  /**
   * Get positions for settlement (all open positions in a resolved market)
   */
  async getPositionsForSettlement(marketId: string): Promise<Position[]> {
    const result = await db
      .select()
      .from(positions)
      .where(and(eq(positions.marketId, marketId), eq(positions.status, 'OPEN')));
    
    return result;
  }

  /**
   * Settle a position
   */
  async settlePosition(
    positionId: string,
    payout: number
  ): Promise<void> {
    await db
      .update(positions)
      .set({
        status: 'SETTLED',
        payout: payout.toString(),
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(positions.id, positionId));
  }

  /**
   * Get user settlements history
   */
  async getUserSettlements(userId: string, limit: number = 50) {
    const result = await db
      .select({
        settlement: settlements,
        market: {
          pubkey: markets.pubkey,
          asset: markets.asset,
          timeframe: markets.timeframe,
        },
      })
      .from(settlements)
      .leftJoin(markets, eq(settlements.marketId, markets.id))
      .where(eq(settlements.userId, userId))
      .orderBy(sql`${settlements.createdAt} DESC`)
      .limit(limit);
    
    return result;
  }

}

export const positionService = new PositionService();





