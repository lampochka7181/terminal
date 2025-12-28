import { PublicKey } from '@solana/web3.js';
import { marketService } from '../services/market.service.js';
import { anchorClient, PROGRAM_ID } from '../lib/anchor-client.js';
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
  timeframe: '5m' | '15m' | '1h' | '4h' | '24h';
  intervalMs: number;
  durationMs: number;
}

const MARKET_CONFIGS: MarketConfig[] = [
  // BTC markets: 5m, 1h, 24h
  { asset: 'BTC', timeframe: '5m', intervalMs: 5 * 60 * 1000, durationMs: 5 * 60 * 1000 },
  { asset: 'BTC', timeframe: '1h', intervalMs: 60 * 60 * 1000, durationMs: 60 * 60 * 1000 },
  { asset: 'BTC', timeframe: '24h', intervalMs: 24 * 60 * 60 * 1000, durationMs: 24 * 60 * 60 * 1000 },
  // ETH and SOL disabled for now
  // { asset: 'ETH', timeframe: '5m', intervalMs: 5 * 60 * 1000, durationMs: 5 * 60 * 1000 },
  // { asset: 'ETH', timeframe: '1h', intervalMs: 60 * 60 * 1000, durationMs: 60 * 60 * 1000 },
  // { asset: 'SOL', timeframe: '5m', intervalMs: 5 * 60 * 1000, durationMs: 5 * 60 * 1000 },
];

// How many markets ahead to pre-create (2 = current + next for zero gap)
const MARKETS_LOOK_AHEAD = 2;

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
 */
async function createPendingMarkets(
  marketConfig: MarketConfig,
  now: number
): Promise<void> {
  const { asset, timeframe, intervalMs, durationMs } = marketConfig;
  
  // Get all existing OPEN markets to avoid duplicates
  // (Markets with strikePrice = '0' are pending activation but still have status OPEN)
  const existingMarkets = await marketService.getMarkets({ asset, timeframe });
  const existingExpiries = new Set(
    existingMarkets
      .filter(m => m.status === 'OPEN')
      .map(m => Math.floor(m.expiryAt.getTime() / 60000))
  );
  
  const currentIntervalStart = Math.floor(now / intervalMs) * intervalMs;
  
  for (let i = 0; i < MARKETS_LOOK_AHEAD; i++) {
    const marketExpiry = currentIntervalStart + (i * intervalMs) + durationMs;
    const expiryMinute = Math.floor(marketExpiry / 60000);
    
    // Skip if market already expired or already exists
    if (marketExpiry <= now || existingExpiries.has(expiryMinute)) {
      continue;
    }
    
    const expiryTs = Math.floor(marketExpiry / 1000);
    const marketPubkey = deriveMarketPda(asset, timeframe, expiryTs);
    
    // Double-check by pubkey
    const existingByPubkey = await marketService.getByPubkey(marketPubkey);
    if (existingByPubkey) {
      logger.debug(`Market ${marketPubkey.slice(0, 8)} already exists in DB, skipping`);
      continue;
    }
    
    // 1. Create on-chain with strike_price = 0 (PENDING status)
    if (anchorClient.isReady()) {
      try {
        await anchorClient.initializeMarket({
          asset,
          timeframe,
          strikePrice: 0, // PENDING - strike price will be set at activation
          expiryTs,
        });
        logger.info(`✅ Created PENDING market on-chain: ${marketPubkey.slice(0, 8)}`);
      } catch (err: any) {
        const errorMsg = err.message || '';
        if (errorMsg.includes('already in use') || errorMsg.includes('0x0')) {
          logger.debug(`Market ${marketPubkey.slice(0, 8)} already exists on-chain`);
        } else {
          logger.error(`❌ Failed to create market on-chain: ${errorMsg}`);
          continue; // Don't create in DB if on-chain failed
        }
      }
      
      // Verify on-chain account exists
      const verified = await verifyOnChainMarket(marketPubkey);
      if (!verified) {
        logger.error(`❌ On-chain market missing after creation: ${marketPubkey}`);
        continue;
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

/**
 * Derive the market PDA from seeds
 * Must match on-chain: seeds = [b"market", asset.as_bytes(), timeframe.as_bytes(), expiry_ts.to_le_bytes()]
 * Note: asset and timeframe use raw bytes, NOT padded
 */
export function deriveMarketPda(
  asset: string,
  timeframe: string,
  expiryTs: number  // Unix timestamp in SECONDS
): string {
  // Convert expiry to i64 little-endian bytes
  const expiryBuffer = Buffer.alloc(8);
  expiryBuffer.writeBigInt64LE(BigInt(expiryTs), 0);
  
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('market'),
      Buffer.from(asset),      // Raw bytes, no padding
      Buffer.from(timeframe),  // Raw bytes, no padding
      expiryBuffer,
    ],
    PROGRAM_ID
  );
  
  return pda.toBase58();
}
