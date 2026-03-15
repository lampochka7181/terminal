import { eq } from 'drizzle-orm';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { db, markets } from '../db/index.js';
import { marketService } from '../services/market.service.js';
import { anchorClient, getYesMintPda, getNoMintPda, fetchMarketV2OnChainState } from '../lib/anchor-client.js';
import { logger } from '../lib/logger.js';

/**
 * Market Closer Job
 * 
 * Closes fully settled markets to recover rent (~0.006 SOL per market).
 * Uses chain-first checks: reads on-chain status before attempting close,
 * preventing infinite retry loops when DB/chain status diverge.
 */

const closingMarkets = new Set<string>();

const TRADED_MARKET_MIN_AGE_MS = 5 * 60 * 1000;
const ZERO_TRADE_MIN_AGE_MS = 5 * 1000; 

export async function marketCloserJob(): Promise<void> {
  if (!anchorClient.isReady()) {
    return;
  }

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
    if (closingMarkets.has(market.id)) continue;

    const hasTrades = parseFloat(market.totalVolume || '0') > 0;
    const minAge = hasTrades ? TRADED_MARKET_MIN_AGE_MS : ZERO_TRADE_MIN_AGE_MS;
    const settledAt = market.settledAt?.getTime() || 0;
    
    if (now - settledAt < minAge) continue;

    marketsToClose.push(market);
  }

  if (marketsToClose.length === 0) return;

  // Pre-flight: check on-chain status for each market before attempting close.
  // This prevents sending failing txs for markets whose on-chain state doesn't match DB.
  const connection = anchorClient.getConnection();
  const eligible: typeof marketsToClose = [];

  for (const market of marketsToClose) {
    try {
      const chainState = await fetchMarketV2OnChainState(connection, new PublicKey(market.pubkey));

      if (!chainState) {
        // Account already gone (finalized) — just archive in DB
        logger.info(`Market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) on-chain account gone, archiving`);
        await marketService.markArchived(market.id);
        continue;
      }

      // CloseMarketV2 requires Resolved + openInterest == 0
      if (chainState.status === 'RESOLVED' && chainState.openInterest === 0n) {
        eligible.push(market);
      } else {
        logger.debug(
          `Market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) on-chain status=${chainState.status} OI=${chainState.openInterest}, skipping close`
        );
      }
    } catch (err: any) {
      logger.debug(`Failed to read on-chain state for ${market.pubkey.slice(0, 8)}: ${err.message}`);
    }
  }

  if (eligible.length === 0) return;

  const BATCH_SIZE = 5;
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    batch.forEach(m => closingMarkets.add(m.id));

    try {
      const instructions = await Promise.all(
        batch.map(m => {
          const marketPubkey = new PublicKey(m.pubkey);
          return anchorClient.buildCloseMarketV2Instruction({
            marketPubkey: m.pubkey,
            yesMint: getYesMintPda(marketPubkey).toBase58(),
            noMint: getNoMintPda(marketPubkey).toBase58(),
          });
        })
      );

      const relayerPubkeyStr = anchorClient.getRelayerPublicKey?.() || null;
      const relayerPubkey = relayerPubkeyStr ? new PublicKey(relayerPubkeyStr) : null;
      let balanceBefore = 0;
      if (relayerPubkey) {
        try { balanceBefore = await connection.getBalance(relayerPubkey, 'confirmed'); } catch { /* ignore */ }
      }

      const signature = await anchorClient.submitTransaction(
        instructions,
        [],
        `Batch Close ${batch.length} markets (${batch.map(m => m.asset).join(',')})`
      );

      let rentLog = '';
      if (relayerPubkey && balanceBefore > 0) {
        try {
          const balanceAfter = await connection.getBalance(relayerPubkey, 'confirmed');
          const delta = balanceAfter - balanceBefore;
          rentLog = `, rent recovered: ${delta >= 0 ? '+' : ''}${(delta / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
        } catch { /* ignore */ }
      }

      logger.info(`Market closure tx: ${signature} (${batch.length} market(s): ${batch.map(m => `${m.asset}-${m.timeframe}`).join(', ')}${rentLog})`);

      for (const market of batch) {
        await marketService.markArchived(market.id);
      }

    } catch (err: any) {
      logger.debug(`Batch closure failed, retrying individually: ${err.message || ''}`);

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

async function closeMarketOnChainWithSignature(market: { id: string; pubkey: string; asset: string; timeframe: string }): Promise<string> {
  const marketPubkey = new PublicKey(market.pubkey);
  return anchorClient.closeMarketV2({
    marketPubkey: market.pubkey,
    yesMint: getYesMintPda(marketPubkey).toBase58(),
    noMint: getNoMintPda(marketPubkey).toBase58(),
  });
}

async function handleCloseMarketError(
  market: { id: string; pubkey: string; asset: string; timeframe: string },
  err: any
): Promise<void> {
  const msg = err.message || '';

  if (msg.includes('AccountNotFound') ||
      msg.includes('AccountNotInitialized') ||
      msg.includes('0xbc4') ||
      msg.includes('0x1')) {
    logger.debug(`Market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) already closed or not found, archiving`);
    await marketService.markArchived(market.id);
    return;
  }

  if (msg.includes('MarketNotSettled') || msg.includes('0x177c')) {
    logger.warn(`Market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) still has unsettled positions, will retry later`);
    return;
  }

  if (msg.includes('MarketHasOpenInterest') || msg.includes('MarketNotResolved')) {
    // Chain-first check should have caught this — sync DB status from chain
    try {
      const connection = anchorClient.getConnection();
      const chainState = await fetchMarketV2OnChainState(connection, new PublicKey(market.pubkey));
      if (!chainState) {
        logger.info(`Market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) on-chain account gone, archiving`);
        await marketService.markArchived(market.id);
        return;
      }
      logger.warn(`Market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) on-chain status=${chainState.status} OI=${chainState.openInterest}, skipping`);
    } catch { /* ignore */ }
    return;
  }

  if (msg.includes('AccountDiscriminatorMismatch') || msg.includes('0xbba')) {
    // Legacy V1 market — can't close with V2 instruction. Archive in DB.
    logger.debug(`Market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) discriminator mismatch (legacy V1), archiving`);
    await marketService.markArchived(market.id);
    return;
  }

  logger.error(`Failed to close market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}): ${msg}`);
}
