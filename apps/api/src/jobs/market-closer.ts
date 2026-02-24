import { eq, and, ne, notLike } from 'drizzle-orm';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { db, markets } from '../db/index.js';
import { marketService } from '../services/market.service.js';
import { anchorClient, getMarketPda, getYesMintPda, getNoMintPda } from '../lib/anchor-client.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

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

// Safety delay before closing markets with trading activity
// (Wait 5 minutes after settlement to ensure all payouts are processed)
const TRADED_MARKET_MIN_AGE_MS = 5 * 60 * 1000;

// Short delay for markets with ZERO trading activity (save gas faster)
const ZERO_TRADE_MIN_AGE_MS = 5 * 1000; 

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

  if (settledMarkets.length > 0) {
    logger.debug(`Market Closer: found ${settledMarkets.length} settled markets potentially ready for closure`);
  }

  const now = Date.now();
  const marketsToClose = [];

  for (const market of settledMarkets) {
    // Skip if already being processed
    if (closingMarkets.has(market.id)) {
      continue;
    }

    // Determine required delay based on activity
    const hasTrades = parseFloat(market.totalVolume || '0') > 0;
    const minAge = hasTrades ? TRADED_MARKET_MIN_AGE_MS : ZERO_TRADE_MIN_AGE_MS;
    
    // Skip if settled too recently (use settledAt as safety timestamp)
    const settledAt = market.settledAt?.getTime() || 0;
    const age = now - settledAt;
    
    if (age < minAge) {
      if (hasTrades) {
        logger.debug(`Market ${market.id} (${market.asset}) has trades, waiting ${Math.ceil((minAge - age)/1000)}s longer for safety`);
      }
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
      // Build close instructions based on V1 or V2 mode
      const isV2 = config.useV2;
      const instructions = await Promise.all(
        batch.map(m => {
          if (isV2) {
            const marketPubkey = new PublicKey(m.pubkey);
            return anchorClient.buildCloseMarketV2Instruction({
              marketPubkey: m.pubkey,
              yesMint: getYesMintPda(marketPubkey).toBase58(),
              noMint: getNoMintPda(marketPubkey).toBase58(),
            });
          }
          return anchorClient.buildCloseMarketInstruction({ marketPubkey: m.pubkey });
        })
      );

      // Query relayer SOL balance before close to measure actual rent recovery
      const connection = anchorClient.getConnection();
      const relayerPubkeyStr = anchorClient.getRelayerPublicKey?.() || null;
      const relayerPubkey = relayerPubkeyStr ? new PublicKey(relayerPubkeyStr) : null;
      let balanceBefore = 0;
      if (relayerPubkey) {
        try {
          balanceBefore = await connection.getBalance(relayerPubkey, 'confirmed');
        } catch { /* ignore */ }
      }

      const signature = await anchorClient.submitTransaction(
        instructions,
        [],
        `Batch Close ${batch.length} markets (${batch.map(m => m.asset).join(',')})`
      );

      // Measure actual rent recovered on-chain (balance after - before)
      let rentLog = '';
      if (relayerPubkey && balanceBefore > 0) {
        try {
          const balanceAfter = await connection.getBalance(relayerPubkey, 'confirmed');
          const delta = balanceAfter - balanceBefore;
          const deltaSOL = delta / LAMPORTS_PER_SOL;
          rentLog = `, rent recovered: ${deltaSOL >= 0 ? '+' : ''}${deltaSOL.toFixed(6)} SOL`;
        } catch { /* ignore */ }
      }

      const marketNames = batch.map(m => `${m.asset}-${m.timeframe}`).join(', ');
      logger.info(`Market closure tx: ${signature} (${batch.length} market(s): ${marketNames}${rentLog})`);

      // Archive in database
      for (const market of batch) {
        await marketService.markArchived(market.id);
      }

    } catch (err: any) {
      const errorMsg = err.message || '';
      logger.debug(`Batch closure failed, retrying individually: ${errorMsg}`);

      for (const market of batch) {
        try {
          const sig = await closeMarketOnChainWithSignature(market);
          await marketService.markArchived(market.id);
          logger.info(`Market closure tx (individual): ${sig} (${market.asset}-${market.timeframe})`);
        } catch (innerErr: any) {
          handleCloseMarketError(market, innerErr);
        }
      }
    } finally {
      batch.forEach(m => closingMarkets.delete(m.id));
    }
  }
}

/**
 * Close a single market on-chain, trying V2 first if enabled, falling back to V1.
 * Returns the on-chain transaction signature.
 */
async function closeMarketOnChainWithSignature(market: { id: string; pubkey: string; asset: string; timeframe: string }): Promise<string> {
  if (config.useV2) {
    const marketPubkey = new PublicKey(market.pubkey);
    return anchorClient.closeMarketV2({
      marketPubkey: market.pubkey,
      yesMint: getYesMintPda(marketPubkey).toBase58(),
      noMint: getNoMintPda(marketPubkey).toBase58(),
    });
  }
  return anchorClient.closeMarket({ marketPubkey: market.pubkey });
}

/**
 * Handle errors from individual market close attempts.
 */
async function handleCloseMarketError(
  market: { id: string; pubkey: string; asset: string; timeframe: string },
  err: any
): Promise<void> {
  const msg = err.message || '';

  // Already closed or not found on-chain — just archive in DB
  if (msg.includes('AccountNotFound') ||
      msg.includes('AccountNotInitialized') ||
      msg.includes('0xbc4') ||
      msg.includes('0x1')) {
    logger.debug(`Market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) already closed or not found, archiving`);
    await marketService.markArchived(market.id);
    return;
  }

  // V1: still has unsettled positions
  if (msg.includes('MarketNotSettled') || msg.includes('0x177c')) {
    logger.warn(`Market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) still has unsettled positions, will retry later`);
    return;
  }

  // V2: has open interest or not resolved — needs merkle settlement
  if (msg.includes('MarketHasOpenInterest') || msg.includes('MarketNotResolved')) {
    logger.debug(`V2 Market ${market.asset}-${market.timeframe} has open interest or not resolved, needs merkle settlement`);
    return;
  }

  // Discriminator mismatch: V1/V2 mismatch — try the other version
  if (msg.includes('AccountDiscriminatorMismatch') || msg.includes('0xbba')) {
    try {
      let sig: string;
      if (config.useV2) {
        sig = await anchorClient.closeMarket({ marketPubkey: market.pubkey });
      } else {
        const marketPubkey = new PublicKey(market.pubkey);
        sig = await anchorClient.closeMarketV2({
          marketPubkey: market.pubkey,
          yesMint: getYesMintPda(marketPubkey).toBase58(),
          noMint: getNoMintPda(marketPubkey).toBase58(),
        });
      }
      await marketService.markArchived(market.id);
      logger.info(`Market closure tx (fallback): ${sig} (${market.asset}-${market.timeframe})`);
    } catch (fallbackErr: any) {
      const fallbackMsg = fallbackErr.message || '';
      if (fallbackMsg.includes('AccountNotFound') || fallbackMsg.includes('0x1')) {
        await marketService.markArchived(market.id);
      } else {
        logger.error(`Failed to close market ${market.asset}-${market.timeframe} (fallback): ${fallbackMsg}`);
      }
    }
    return;
  }

  logger.error(`Failed to close market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}): ${msg}`);
}
