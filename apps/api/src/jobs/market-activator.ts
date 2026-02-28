import { PublicKey } from '@solana/web3.js';
import { marketService } from '../services/market.service.js';
import { priceFeedService } from '../services/price-feed.service.js';
import { anchorClient, fetchMarketV2OnChainState } from '../lib/anchor-client.js';
import { syncMarketStatusFromChain } from '../lib/chain-sync.js';
import { logger, logEvents } from '../lib/logger.js';
import { broadcastMarketActivated } from '../lib/broadcasts.js';
import { config } from '../config.js';

/**
 * Market Activator Job
 * 
 * PHASE 2 OF TWO-PHASE MARKET CREATION:
 * 
 * This job activates markets with strikePrice = 0 when their trading window starts:
 * 1. Find markets with strikePrice = '0' whose start time has arrived
 * 2. Fetch the CURRENT price from WebSocket (this becomes the strike price)
 * 3. Call activate_market ON-CHAIN to set the real strike price
 * 4. Update DB: strikePrice -> real price (status stays OPEN)
 * 
 * Markets with strikePrice = '0' are considered "pending activation"
 * (We use this instead of a PENDING status to avoid Supabase pooler enum caching issues)
 */

/**
 * Main market activator job
 */
export async function marketActivatorJob(): Promise<void> {
  const startTime = Date.now();
  
  // Get markets with strikePrice = 0 that should be activated
  const pendingMarkets = await marketService.getPendingMarketsToActivate();
  const queryTime = Date.now() - startTime;
  
  if (queryTime > 100) {
    logger.debug(`[MarketActivator] getPendingMarketsToActivate took ${queryTime}ms`);
  }
  
  if (pendingMarkets.length === 0) {
    return;
  }
  
  logger.info(`🔓 Found ${pendingMarkets.length} market(s) to activate (strikePrice=0)`);
  
  for (const market of pendingMarkets) {
    try {
      await activateMarketEntry(market);
    } catch (err) {
      logger.error(`Failed to activate market ${market.pubkey}:`, err);
    }
  }
}

/**
 * Activate a single market
 */
async function activateMarketEntry(market: Awaited<ReturnType<typeof marketService.getPendingMarketsToActivate>>[0]): Promise<void> {
  const { id, pubkey, asset, timeframe, expiryAt } = market;
  
  // 1. Get current price from WebSocket feed
  const currentPrice = await getCurrentPrice(asset);
  if (!currentPrice) {
    logger.error(`Cannot activate market ${pubkey}: no price available for ${asset}`);
    return;
  }
  
  // 2. Pre-flight: check on-chain status before attempting activation
  let alreadyActive = false;
  if (anchorClient.isReady() && config.useV2) {
    try {
      const chainState = await fetchMarketV2OnChainState(
        anchorClient.getConnection(),
        new PublicKey(pubkey),
      );
      if (!chainState) {
        logger.warn(`[MarketActivator] ${pubkey.slice(0, 8)} on-chain account gone, skipping`);
        await marketService.markArchived(id);
        return;
      }
      if (chainState.status !== 'OPEN' || chainState.statusRaw !== 0) {
        // statusRaw 0 = Pending, 1 = Open; anything other than Pending means already activated
        alreadyActive = chainState.statusRaw !== 0;
        if (alreadyActive) {
          logger.info(`[MarketActivator] ${pubkey.slice(0, 8)} already ${chainState.status} on-chain (raw=${chainState.statusRaw}), updating DB only`);
        }
      }
    } catch (err: any) {
      logger.debug(`[MarketActivator] Pre-flight check failed for ${pubkey.slice(0, 8)}: ${err.message}`);
    }
  }

  // 3. Activate on-chain (only if not already active)
  if (!alreadyActive && anchorClient.isReady()) {
    try {
      if (config.useV2) {
        await anchorClient.activateMarketV2({
          marketPubkey: pubkey,
          strikePrice: currentPrice,
        });
        logger.info(`✅ Activated on-chain MarketV2 ${asset}-${timeframe} with strike $${currentPrice.toLocaleString()}`);
      } else {
        await anchorClient.activateMarket({
          marketPubkey: pubkey,
          strikePrice: currentPrice,
        });
        logger.info(`✅ Activated on-chain market ${asset}-${timeframe} with strike $${currentPrice.toLocaleString()}`);
      }
    } catch (err: any) {
      const errorMsg = String(err.message || err);
      const errorLogs = err.logs ? err.logs.join(' ') : '';
      const fullError = errorMsg + ' ' + errorLogs;
      
      if (fullError.includes('MarketNotPending') || fullError.includes('0x1776') || fullError.includes('6006')) {
        logger.debug(`Market ${pubkey.slice(0, 8)} already activated on-chain, updating DB only`);
      } else {
        logger.error(`❌ Failed to activate market ${pubkey} on-chain: ${errorMsg}`);
        return;
      }
    }
  } else if (!anchorClient.isReady()) {
    logger.warn(`Anchor client not ready, activating market ${pubkey} in DB only`);
  }
  
  // 4. Sync chain status and update DB
  if (anchorClient.isReady() && config.useV2) {
    const chainState = await syncMarketStatusFromChain(id, pubkey, 'OPEN');
    if (chainState && chainState.status !== 'OPEN') {
      logger.warn(`[MarketActivator] On-chain status after activation is ${chainState.status}, expected OPEN`);
    }
  }
  await marketService.activateMarket(id, currentPrice.toString());
  
  // 4. Broadcast activation to all connected clients for instant UI update
  broadcastMarketActivated(pubkey, {
    marketId: id,
    asset,
    timeframe,
    strikePrice: currentPrice,
    expiryAt: expiryAt.getTime(),
  });
  
  logger.info(`🚀 Activated market ${asset}-${timeframe} | Strike: $${currentPrice.toLocaleString()} | Expires: ${expiryAt.toISOString()}`);
  
  logEvents.marketCreated({
    marketId: id,
    pubkey,
    asset: asset as any,
    timeframe: timeframe as any,
    strikePrice: currentPrice,
    expiryAt,
  });
}

/**
 * Get current price for an asset from WebSocket feed
 */
async function getCurrentPrice(asset: string): Promise<number | null> {
  try {
    const priceData = await priceFeedService.getPrice(asset);
    
    // Only use fresh prices (within 15 seconds)
    if (priceData && Date.now() - priceData.timestamp < 15_000) {
      return priceData.price;
    }
    
    // Fallback: Coinbase REST API
    const productId = asset === 'BTC' ? 'BTC-USD' : asset === 'ETH' ? 'ETH-USD' : asset === 'SOL' ? 'SOL-USD' : null;
    if (productId) {
      try {
        const ac = new AbortController();
        const timeout = setTimeout(() => ac.abort(), 2500);
        const res = await fetch(`https://api.exchange.coinbase.com/products/${productId}/ticker`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: ac.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          const json: any = await res.json();
          const p = Number(json?.price);
          if (Number.isFinite(p) && p > 0) {
            logger.warn(`Using Coinbase REST fallback price for ${asset}: ${p}`);
            return p;
          }
        }
      } catch (e: any) {
        logger.warn(`Coinbase REST fallback failed for ${asset}: ${e?.message || e}`);
      }
    }

    // No reliable price available — do NOT use hardcoded placeholders
    // Market activation will be retried on the next activator run
    logger.error(`No reliable price available for ${asset} — cannot activate market. Will retry.`);
    return null;
  } catch (err) {
    logger.error(`Failed to get price for ${asset}:`, err);
    return null;
  }
}

