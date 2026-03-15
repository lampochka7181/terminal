import { PublicKey } from '@solana/web3.js';
import { marketService } from '../services/market.service.js';
import { anchorClient, PROGRAM_ID, getMarketV2Pda, getNoMintPda } from '../lib/anchor-client.js';
import { logger, logEvents } from '../lib/logger.js';

/**
 * Market Creator Job
 * 
 * TWO-PHASE MARKET CREATION:
 * 
 * Phase 1 (this job): PRE-CREATE markets with strikePrice = 0
 * - Creates market ON-CHAIN with strike_price = 0 (PENDING status on-chain)
 * - Creates market in DB with strikePrice = '0' and status = 'OPEN'
 * - Markets with strikePrice = '0' are considered "pending activation"
 * - Markets exist ahead of time so there's zero gap
 * 
 * Phase 2 (market-activator job): ACTIVATE markets when they go live
 * - Sets the real strike price from current WebSocket price
 * - Calls activate_market on-chain to set strike and change status to OPEN
 * - Updates DB: strikePrice -> actual price (status stays OPEN)
 * 
 * NOTE: We use strikePrice = '0' instead of a PENDING status to avoid
 * PostgreSQL enum caching issues with Supabase connection pooler.
 */

interface MarketConfig {
  asset: 'BTC' | 'ETH' | 'SOL';
  timeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '24h';
  intervalMs: number;
  durationMs: number;
}

const MARKET_CONFIGS: MarketConfig[] = [
  // BTC markets: 1m, 5m
  { asset: 'BTC', timeframe: '1m', intervalMs: 60 * 1000, durationMs: 60 * 1000 },
  { asset: 'BTC', timeframe: '5m', intervalMs: 5 * 60 * 1000, durationMs: 5 * 60 * 1000 },
  // 1h and 24h disabled for now
  // { asset: 'BTC', timeframe: '1h', intervalMs: 60 * 60 * 1000, durationMs: 60 * 60 * 1000 },
  // { asset: 'BTC', timeframe: '24h', intervalMs: 24 * 60 * 60 * 1000, durationMs: 24 * 60 * 60 * 1000 },
  // ETH and SOL disabled for now
  // { asset: 'ETH', timeframe: '5m', intervalMs: 5 * 60 * 1000, durationMs: 5 * 60 * 1000 },
  // { asset: 'ETH', timeframe: '1h', intervalMs: 60 * 60 * 1000, durationMs: 60 * 60 * 1000 },
  // { asset: 'SOL', timeframe: '5m', intervalMs: 5 * 60 * 1000, durationMs: 5 * 60 * 1000 },
];

// How many markets ahead to pre-create (3 needed for 1m markets due to 90s on-chain buffer)
const MARKETS_LOOK_AHEAD = 3;

/**
 * Main market creator job
 * Pre-creates markets on-chain and in DB with strikePrice = 0 (pending activation)
 */
export async function marketCreatorJob(): Promise<void> {
  const now = Date.now();
  
  for (const marketConfig of MARKET_CONFIGS) {
    try {
      await createPendingMarkets(marketConfig, now);
    } catch (err) {
      logger.error(`Failed to pre-create ${marketConfig.asset}-${marketConfig.timeframe} markets:`, err);
    }
  }
}

/**
 * Pre-create markets for a given config
 * 
 * OPTIMIZED: Uses batch pubkey lookup instead of sequential queries
 */
async function createPendingMarkets(
  marketConfig: MarketConfig,
  now: number
): Promise<void> {
  const { asset, timeframe, intervalMs, durationMs } = marketConfig;
  const startTime = Date.now();
  
  // Get all existing OPEN markets to avoid duplicates
  // (Markets with strikePrice = '0' are pending activation but still have status OPEN)
  const existingMarkets = await marketService.getMarkets({ asset, timeframe });
  logger.debug(`[MarketCreator] ${asset}-${timeframe}: getMarkets took ${Date.now() - startTime}ms`);
  
  const existingExpiries = new Set(
    existingMarkets
      .filter(m => m.status === 'OPEN')
      .map(m => Math.floor(m.expiryAt.getTime() / 60000))
  );
  
  const currentIntervalStart = Math.floor(now / intervalMs) * intervalMs;
  
  // Phase 1: Collect all potential markets and their pubkeys
  const potentialMarkets: Array<{
    marketExpiry: number;
    expiryTs: number;
    marketPubkey: string;
    yesMint?: string;  // V2 only
    noMint?: string;   // V2 only
  }> = [];

  for (let i = 0; i < MARKETS_LOOK_AHEAD; i++) {
    const marketExpiry = currentIntervalStart + (i * intervalMs) + durationMs;
    const expiryMinute = Math.floor(marketExpiry / 60000);

    // Skip if market already expired, expires too soon, or already exists.
    // On-chain program requires expiry_ts > clock.unix_timestamp + 60s,
    // so add 90s buffer (60s on-chain + 30s for TX propagation/confirmation).
    if (marketExpiry <= now + 90_000 || existingExpiries.has(expiryMinute)) {
      continue;
    }

    const expiryTs = Math.floor(marketExpiry / 1000);
    const marketPubkey = getMarketV2Pda(asset, timeframe, expiryTs).toBase58();

    potentialMarkets.push({ marketExpiry, expiryTs, marketPubkey });
  }
  
  if (potentialMarkets.length === 0) {
    return; // Nothing to create
  }
  
  // Phase 2: Batch lookup existing pubkeys (1 query instead of N)
  const pubkeys = potentialMarkets.map(m => m.marketPubkey);
  const existingByPubkey = await marketService.getByPubkeys(pubkeys);
  
  // Phase 3: Create markets that don't exist
  for (const { marketExpiry, expiryTs, marketPubkey } of potentialMarkets) {
    // Skip if already exists in DB
    if (existingByPubkey.has(marketPubkey)) {
      logger.debug(`Market ${marketPubkey.slice(0, 8)} already exists in DB, skipping`);
      continue;
    }
    
    // 1. Create on-chain with strike_price = 0 (PENDING status)
    let yesMint: string | undefined;
    let noMint: string | undefined;

    if (anchorClient.isReady()) {
      try {
        const result = await anchorClient.initializeMarketV2({
          asset,
          timeframe,
          strikePrice: 0,
          expiryTs,
        });
        yesMint = result.yesMint;
        noMint = result.noMint;
        logger.info(`✅ Created PENDING MarketV2 on-chain: ${marketPubkey.slice(0, 8)}`);
        logger.info(`   YES mint: ${yesMint}`);
        logger.info(`   NO mint: ${noMint}`);
      } catch (err: any) {
        const errorMsg = err.message || '';
        if (errorMsg.includes('already in use') || errorMsg.includes('0x0')) {
          logger.debug(`Market ${marketPubkey.slice(0, 8)} already exists on-chain`);
        } else if (errorMsg.includes('IllegalOwner') || errorMsg.includes('owner is not allowed')) {
          // Orphaned market: Phase 1 exists on-chain from a previous session but Phase 2
          // (vault creation) fails non-recoverably. Save a DB entry so we don't retry every cycle.
          logger.warn(`⚠️ Orphaned market ${marketPubkey.slice(0, 8)} (Phase 2 non-recoverable) — saving to DB to prevent retries`);
          try {
            await marketService.create({
              pubkey: marketPubkey,
              asset: asset as any,
              timeframe: timeframe as any,
              strikePrice: '0',
              expiryAt: new Date(marketExpiry),
              status: 'EXPIRED',
            });
          } catch { /* ignore if already exists */ }
          continue;
        } else if (errorMsg.includes('InsufficientFundsForRent') || errorMsg.includes('insufficient lamports')) {
          // Relayer out of SOL — skip this cycle. The auto-funding keeper will
          // top up the relayer balance, and next cycle will retry successfully.
          logger.error(`❌ Relayer out of SOL for market creation — skipping this cycle. Fund the relayer wallet.`);
          continue;
        } else {
          // Log a concise single-line error (detailed simulation logs already logged by submitTransaction)
          const shortMsg = errorMsg.split('\n')[0].slice(0, 200);
          logger.error(`❌ Failed to create market on-chain: ${shortMsg}`);
          continue; // Don't create in DB if on-chain failed
        }
      }

      // Verify on-chain account exists
      const verified = await verifyOnChainMarket(marketPubkey);
      if (!verified) {
        logger.error(`❌ On-chain market missing after creation: ${marketPubkey}`);
        continue;
      }

      // Verify NO mint exists (Phase 2 health check)
      const noMintOk = await verifyNoMintExists(marketPubkey);
      if (!noMintOk) {
        logger.warn(`⚠️ NO mint missing for ${marketPubkey.slice(0, 8)} — attempting Phase 2 recovery...`);
        try {
          await anchorClient.completeMarketV2Phase2(new PublicKey(marketPubkey), 0);
          const recovered = await verifyNoMintExists(marketPubkey);
          if (!recovered) {
            logger.error(`❌ Phase 2 recovery failed for ${marketPubkey.slice(0, 8)} — skipping market`);
            continue;
          }
          logger.info(`✅ Phase 2 recovery successful for ${marketPubkey.slice(0, 8)}`);
        } catch (recoveryErr: any) {
          logger.error(`❌ Phase 2 recovery threw for ${marketPubkey.slice(0, 8)}: ${recoveryErr.message}`);
          continue;
        }
      }
    } else {
      logger.warn(`Anchor client not ready, creating market ${marketPubkey.slice(0, 8)} in DB only`);
    }
    
    // 2. Create in DB with status OPEN but strikePrice = 0 (indicates pending activation)
    // Using strikePrice = '0' instead of PENDING status to avoid Supabase pooler enum caching issues
    await marketService.create({
      pubkey: marketPubkey,
      asset: asset as any,
      timeframe: timeframe as any,
      strikePrice: '0', // Placeholder - will be set when market goes live
      expiryAt: new Date(marketExpiry),
      status: 'OPEN', // Status is OPEN, but strikePrice = 0 means "pending activation"
    });
    
    const startTime = new Date(marketExpiry - durationMs);
    logger.info(`📋 Pre-created market ${asset}-${timeframe} (strikePrice=0, expires ${new Date(marketExpiry).toISOString()}, starts ${startTime.toISOString()})`);
    
    logEvents.marketCreated({
      marketId: 'pending',
      pubkey: marketPubkey,
      asset: asset as any,
      timeframe: timeframe as any,
      strikePrice: 0,
      expiryAt: new Date(marketExpiry),
    });
  }
}

/**
 * Verify the NO mint PDA exists on-chain (i.e., Phase 2 completed)
 */
async function verifyNoMintExists(marketPubkey: string): Promise<boolean> {
  const conn = anchorClient.getConnection();
  const noMint = getNoMintPda(new PublicKey(marketPubkey));
  try {
    const info = await conn.getAccountInfo(noMint, 'confirmed');
    if (info && info.data.length > 0) {
      return true;
    }
    return false;
  } catch (e: any) {
    logger.warn(`Failed to check NO mint for ${marketPubkey.slice(0, 8)}: ${e.message}`);
    return false;
  }
}

/**
 * Verify on-chain market account exists
 */
async function verifyOnChainMarket(pubkey: string): Promise<boolean> {
  const conn = anchorClient.getConnection();
  const pk = new PublicKey(pubkey);
  const maxAttempts = 4;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const info = await conn.getAccountInfo(pk, 'confirmed');
      if (info) {
        if (!info.owner.equals(PROGRAM_ID)) {
          logger.error(`On-chain market owner mismatch for ${pubkey}`);
          return false;
        }
        return true;
      }
    } catch (e: any) {
      if (attempt === maxAttempts) {
        logger.error(`Failed to verify on-chain market: ${pubkey}: ${e?.message || e}`);
        return false;
      }
    }
    await new Promise((r) => setTimeout(r, 200 * attempt));
  }
  return false;
}

