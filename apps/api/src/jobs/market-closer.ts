import { eq, and, ne, notLike } from 'drizzle-orm';
import { db, markets } from '../db/index.js';
import { marketService } from '../services/market.service.js';
import { anchorClient, getMarketPda } from '../lib/anchor-client.js';
import { logger } from '../lib/logger.js';

/**
 * Market Closer Job
 * 
 * Closes fully settled markets to recover rent (~0.006 SOL per market).
 * This job runs periodically and:
 * 1. Finds markets with status = SETTLED and non-empty pubkey
 * 2. Closes the on-chain market account and vault
 * 3. Recovers rent to the relayer wallet
 * 4. Marks market as archived (pubkey = '') in database
 * 
 * Cost savings: ~$1.20 per market recovered
 */

// Track markets being closed to prevent duplicate attempts
const closingMarkets = new Set<string>();

// Minimum age before closing (wait 5 minutes after settlement)
const MIN_AGE_BEFORE_CLOSE_MS = 5 * 60 * 1000;

export async function marketCloserJob(): Promise<void> {
  if (!anchorClient.isReady()) {
    return; // Skip if not connected to Solana
  }

  // Find settled markets that haven't been archived yet
  const allSettledMarkets = await db
    .select()
    .from(markets)
    .where(eq(markets.status, 'SETTLED'));

  const settledMarkets = allSettledMarkets.filter(m => !m.pubkey.startsWith('arc-'));

  const now = Date.now();
  const marketsToClose = [];

  for (const market of settledMarkets) {
    // Skip if already being processed
    if (closingMarkets.has(market.id)) {
      continue;
    }

    // Skip if settled too recently (give time for any pending operations)
    const settledAt = market.updatedAt?.getTime() || 0;
    if (now - settledAt < MIN_AGE_BEFORE_CLOSE_MS) {
      continue;
    }

    marketsToClose.push(market);
  }

  if (marketsToClose.length === 0) {
    return;
  }

  // Batch closures (max 5 per transaction for safety)
  const BATCH_SIZE = 5;
  for (let i = 0; i < marketsToClose.length; i += BATCH_SIZE) {
    const batch = marketsToClose.slice(i, i + BATCH_SIZE);
    
    // Track them all
    batch.forEach(m => closingMarkets.add(m.id));

    try {
      const instructions = await Promise.all(
        batch.map(m => anchorClient.buildCloseMarketInstruction({ marketPubkey: m.pubkey }))
      );

      const signature = await anchorClient.submitTransaction(
        instructions, 
        [], 
        `Batch Close ${batch.length} markets (${batch.map(m => m.asset).join(',')})`
      );
      logger.info(`✅ Batched market closure (${batch.length} markets): ${signature}`);

      // Update database and summary stats for all
      for (const market of batch) {
        await marketService.markArchived(market.id);
        const recovered = 0.00395328;
        logger.info(`🧹 Market ${market.asset}-${market.timeframe} archived (recovered rent)`);
      }

    } catch (err: any) {
      const errorMsg = err.message || '';
      
      // If the whole batch fails, we retry individually and handle "not found" cases
      logger.debug(`Batch closure failed, retrying individual markets: ${errorMsg}`);
      
      for (const market of batch) {
        try {
          await anchorClient.closeMarket({ marketPubkey: market.pubkey });
          await marketService.markArchived(market.id);
          logger.info(`🧹 Market ${market.asset} closed individually`);
        } catch (innerErr: any) {
          const innerMsg = innerErr.message || '';
          
          // Handle "Already Closed" or "Never Existed" gracefully
          if (innerMsg.includes('AccountNotFound') || 
              innerMsg.includes('AccountNotInitialized') || 
              innerMsg.includes('0xbc4') || 
              innerMsg.includes('0x1')) {
            logger.debug(`Market ${market.id} already closed or not found on-chain, archiving in DB`);
            await marketService.markArchived(market.id);
          } else {
            logger.error(`Individual closure failed for ${market.id}: ${innerMsg}`);
          }
        }
      }
    } finally {
      batch.forEach(m => closingMarkets.delete(m.id));
    }
  }
}

