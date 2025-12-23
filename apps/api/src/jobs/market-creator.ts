import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { marketService } from '../services/market.service.js';
import { priceFeedService } from '../services/price-feed.service.js';
import { anchorClient, PROGRAM_ID } from '../lib/anchor-client.js';
import { logger, marketLogger, logEvents } from '../lib/logger.js';
import { config } from '../config.js';

/**
 * Market Creator Job
 * 
 * PROACTIVE MARKET CREATION:
 * Instead of creating markets when the previous one expires,
 * we PRE-CREATE markets so the next one is always ready.
 * 
 * For each asset/timeframe combo, we ensure:
 * - Current market exists (expiry in the future)
 * - NEXT market is pre-created (so it's ready instantly when current expires)
 * 
 * This means users will always see a market available - zero gap.
 */

interface MarketConfig {
  asset: 'BTC' | 'ETH' | 'SOL';
  timeframe: '5m' | '15m' | '1h' | '4h';
  intervalMs: number;
  durationMs: number;
}

const MARKET_CONFIGS: MarketConfig[] = [
  // BTC only for now (scaled down for testing)
  { asset: 'BTC', timeframe: '5m', intervalMs: 5 * 60 * 1000, durationMs: 5 * 60 * 1000 },
  { asset: 'BTC', timeframe: '15m', intervalMs: 15 * 60 * 1000, durationMs: 15 * 60 * 1000 },
  { asset: 'BTC', timeframe: '1h', intervalMs: 60 * 60 * 1000, durationMs: 60 * 60 * 1000 },
  // ETH and SOL disabled for now
  // { asset: 'ETH', timeframe: '5m', intervalMs: 5 * 60 * 1000, durationMs: 5 * 60 * 1000 },
  // { asset: 'ETH', timeframe: '15m', intervalMs: 15 * 60 * 1000, durationMs: 15 * 60 * 1000 },
  // { asset: 'ETH', timeframe: '1h', intervalMs: 60 * 60 * 1000, durationMs: 60 * 60 * 1000 },
  // { asset: 'SOL', timeframe: '5m', intervalMs: 5 * 60 * 1000, durationMs: 5 * 60 * 1000 },
  // { asset: 'SOL', timeframe: '15m', intervalMs: 15 * 60 * 1000, durationMs: 15 * 60 * 1000 },
];

// How many markets ahead to pre-create (1 = current + next)
const MARKETS_LOOK_AHEAD = 2;

/**
 * Main market creator job
 */
export async function marketCreatorJob(): Promise<void> {
  const now = Date.now();
  const marketsToCreate: Array<{ asset: string, timeframe: string, expiry: Date, strikePrice: number }> = [];
  
  // 1. Collect all markets that need to be created
  for (const marketConfig of MARKET_CONFIGS) {
    try {
      const configMarkets = await getMarketsToCreate(marketConfig, now);
      marketsToCreate.push(...configMarkets);
    } catch (err) {
      logger.error(`Failed to check ${marketConfig.asset}-${marketConfig.timeframe} markets:`, err);
    }
  }

  if (marketsToCreate.length === 0) {
    return;
  }

  // 2. Batch on-chain initialization (max 3 per transaction to stay under size limits)
  const BATCH_SIZE = 3;
  for (let i = 0; i < marketsToCreate.length; i += BATCH_SIZE) {
    const batch = marketsToCreate.slice(i, i + BATCH_SIZE);
    let successfullyCreatedOnChain = new Set<string>(); // Set of expiryTs that are confirmed on-chain
    
    if (anchorClient.isReady()) {
      try {
        const instructions = await Promise.all(
          batch.map(m => anchorClient.buildInitializeMarketInstruction({
            asset: m.asset,
            timeframe: m.timeframe,
            strikePrice: m.strikePrice,
            expiryTs: Math.floor(m.expiry.getTime() / 1000),
          }))
        );

        const signature = await anchorClient.submitTransaction(
          instructions, 
          [], 
          `Batch Init ${batch.length} markets (${batch.map(m => m.asset).join(',')})`
        );
        logger.info(`✅ Batched market creation (${batch.length} markets): ${signature}`);
        
        // All in this batch succeeded
        batch.forEach(m => successfullyCreatedOnChain.add(m.expiry.getTime().toString()));
      } catch (err: any) {
        const errorMsg = err.message || '';
        
        if (errorMsg.includes('already in use') || errorMsg.includes('0x0')) {
          logger.debug(`Some markets in batch already exist on-chain, verifying individual markets...`);
          // We'll verify them in the next step
        } else {
          logger.error(`❌ Failed to batch create markets: ${errorMsg}`);
          // If it's a real error (not "already in use"), we skip DB creation for this entire batch
          continue; 
        }
      }
    }

    // 3. Create in database (only if they exist on-chain)
    for (const m of batch) {
      const expiryTs = Math.floor(m.expiry.getTime() / 1000);
      const marketPubkey = deriveMarketPda(m.asset as any, m.timeframe as any, expiryTs);
      const expiryKey = m.expiry.getTime().toString();

      // If not confirmed in the batch, check individually (to handle "already in use" cases)
      if (!successfullyCreatedOnChain.has(expiryKey)) {
        try {
          // Attempt individual initialization (will fail gracefully if already exists)
          await anchorClient.initializeMarket({
            asset: m.asset,
            timeframe: m.timeframe,
            strikePrice: m.strikePrice,
            expiryTs
          });
          successfullyCreatedOnChain.add(expiryKey);
        } catch (innerErr: any) {
          const innerMsg = innerErr.message || '';
          if (innerMsg.includes('already in use') || innerMsg.includes('0x0')) {
            logger.debug(`Market ${m.asset}-${m.timeframe} (${marketPubkey.slice(0, 8)}) already exists on-chain`);
            successfullyCreatedOnChain.add(expiryKey);
          } else {
            logger.error(`❌ Final attempt to create market ${m.asset}-${m.timeframe} on-chain failed: ${innerMsg}`);
            continue; // DO NOT create in DB if it's not on-chain
          }
        }
      }
      
      // Only reach here if we're sure it's on-chain
      // HARD CHECK (with short retry): Verify the Market account actually exists on-chain before inserting into DB.
      // Some RPCs can lag briefly after confirmation, so we retry a couple times to avoid false negatives.
      const verifyOnChain = async (): Promise<boolean> => {
        const conn = anchorClient.getConnection();
        const pk = new PublicKey(marketPubkey);
        const maxAttempts = 6;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const info = await conn.getAccountInfo(pk, 'confirmed');
            if (info) {
              if (!info.owner.equals(PROGRAM_ID)) {
                logger.error(
                  `❌ On-chain market owner mismatch for ${marketPubkey}: expected=${PROGRAM_ID.toBase58()} actual=${info.owner.toBase58()}`
                );
                return false;
              }
              return true;
            }
          } catch (e: any) {
            // keep retrying; we surface final failure below
            if (attempt === maxAttempts) {
              logger.error(`❌ Failed to verify on-chain market account for ${marketPubkey}: ${e?.message || e}`);
              return false;
            }
          }

          // backoff ~2.5s total worst case
          await new Promise((r) => setTimeout(r, 250 + attempt * 100));
        }
        return false;
      };

      const ok = await verifyOnChain();
      if (!ok) {
        logger.error(`❌ On-chain market account missing after creation attempt: ${m.asset}-${m.timeframe} ${marketPubkey}`);
        continue;
      }

      // Check if it already exists in DB to prevent duplicates
      const existing = await marketService.getByPubkey(marketPubkey);
      if (existing) {
        logger.debug(`Market ${marketPubkey.slice(0, 8)} already exists in DB, skipping create`);
        continue;
      }

      await marketService.create({
        pubkey: marketPubkey,
        asset: m.asset as any,
        timeframe: m.timeframe as any,
        strikePrice: m.strikePrice.toString(),
        expiryAt: m.expiry,
        status: 'OPEN',
      });

      logEvents.marketCreated({
        marketId: 'new',
        pubkey: marketPubkey,
        asset: m.asset as any,
        timeframe: m.timeframe as any,
        strikePrice: m.strikePrice,
        expiryAt: m.expiry,
      });
    }
  }
}

/**
 * Identify which markets need creation for this config
 */
async function getMarketsToCreate(
  marketConfig: MarketConfig,
  now: number
): Promise<Array<{ asset: string, timeframe: string, expiry: Date, strikePrice: number }>> {
  const { asset, timeframe, intervalMs, durationMs } = marketConfig;
  const toCreate = [];
  
  const existingMarkets = await marketService.getMarkets({ asset, timeframe });
  const openMarkets = existingMarkets.filter(m => m.status === 'OPEN');
  const existingExpiries = new Set(openMarkets.map(m => Math.floor(m.expiryAt.getTime() / 60000)));
  
  const currentIntervalStart = Math.floor(now / intervalMs) * intervalMs;
  
  for (let i = 0; i < MARKETS_LOOK_AHEAD; i++) {
    const marketExpiry = currentIntervalStart + (i * intervalMs) + durationMs;
    const expiryMinute = Math.floor(marketExpiry / 60000);
    
    if (marketExpiry <= now || existingExpiries.has(expiryMinute)) {
      continue;
    }
    
    const currentPrice = await getCurrentPrice(asset);
    if (currentPrice) {
      toCreate.push({
        asset,
        timeframe,
        expiry: new Date(marketExpiry),
        strikePrice: currentPrice
      });
    }
  }
  
  return toCreate;
}

/**
 * Get current price for an asset from price feed
 */
async function getCurrentPrice(asset: string): Promise<number | null> {
  try {
    const priceData = await priceFeedService.getPrice(asset);
    if (priceData) {
      return priceData.price;
    }
    
    // Fallback: use placeholder prices for development (when Binance not connected)
    const fallbackPrices: Record<string, number> = {
      BTC: 95000,
      ETH: 3300,
      SOL: 145,
    };
    
    logger.warn(`Using fallback price for ${asset}`);
    return fallbackPrices[asset] || null;
  } catch (err) {
    logger.error(`Failed to get price for ${asset}:`, err);
    return null;
  }
}

/**
 * Derive the market PDA from seeds
 * Must match on-chain: seeds = [b"market", asset.as_bytes(), timeframe.as_bytes(), expiry_ts.to_le_bytes()]
 * Note: asset and timeframe use raw bytes, NOT padded
 */
function deriveMarketPda(
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

