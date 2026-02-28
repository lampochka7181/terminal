import { notInArray } from 'drizzle-orm';
import { db, markets } from '../db/index.js';
import { anchorClient } from '../lib/anchor-client.js';
import { syncMarketStatusFromChain } from '../lib/chain-sync.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

/**
 * Market Reconciler Job
 *
 * Safety-net that periodically reads on-chain status for all active markets
 * and reconciles DB status with the canonical chain state.
 *
 * Catches drift caused by:
 *  - Failed/crashed lifecycle jobs
 *  - Race conditions between concurrent jobs
 *  - Manual DB edits that don't reflect reality
 */

export async function marketReconcilerJob(): Promise<void> {
  if (!anchorClient.isReady() || !config.useV2) return;

  const activeMarkets = await db
    .select({
      id: markets.id,
      pubkey: markets.pubkey,
      status: markets.status,
      asset: markets.asset,
      timeframe: markets.timeframe,
    })
    .from(markets)
    .where(
      notInArray(markets.status, ['SETTLED', 'SETTLEMENT_FAILED'])
    );

  // Only reconcile markets with real pubkeys (not archived)
  const toReconcile = activeMarkets.filter(m => m.pubkey && !m.pubkey.startsWith('arc-'));

  if (toReconcile.length === 0) return;

  let synced = 0;
  let archived = 0;

  for (const market of toReconcile) {
    try {
      const result = await syncMarketStatusFromChain(market.id, market.pubkey, market.status!);
      if (!result) {
        archived++;
      } else if (result.status !== market.status) {
        synced++;
      }
    } catch (err: any) {
      logger.debug(`[Reconciler] Failed to sync ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}): ${err.message}`);
    }
  }

  if (synced > 0 || archived > 0) {
    logger.info(`[Reconciler] Checked ${toReconcile.length} markets: ${synced} status synced, ${archived} archived`);
  }
}
