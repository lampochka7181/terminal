import { marketService } from '../services/market.service.js';
import { priceFeedService } from '../services/price-feed.service.js';
import { anchorClient } from '../lib/anchor-client.js';
import { logger, logEvents } from '../lib/logger.js';
import { broadcastMarketActivated } from '../lib/broadcasts.js';

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
  // Get markets with strikePrice = 0 that should be activated
  const pendingMarkets = await marketService.getPendingMarketsToActivate();
  
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
  
  // 2. Activate on-chain (set strike price and change status to OPEN)
  if (anchorClient.isReady()) {
    try {
      await anchorClient.activateMarket({
        marketPubkey: pubkey,
        strikePrice: currentPrice,
      });
      logger.info(`✅ Activated on-chain market ${asset}-${timeframe} with strike $${currentPrice.toLocaleString()}`);
    } catch (err: any) {
      const errorMsg = String(err.message || err);
      const errorLogs = err.logs ? err.logs.join(' ') : '';
      const fullError = errorMsg + ' ' + errorLogs;
      
      // If market is already activated (not PENDING on-chain), that's fine - just update DB
      // Error code 0x1774 (6004) = MarketNotPending
      if (fullError.includes('MarketNotPending') || fullError.includes('0x1774') || fullError.includes('6004')) {
        logger.debug(`Market ${pubkey.slice(0, 8)} already activated on-chain, updating DB only`);
      } else {
        logger.error(`❌ Failed to activate market ${pubkey} on-chain: ${errorMsg}`);
        return; // Don't activate in DB if on-chain failed unexpectedly
      }
    }
  } else {
    // Anchor client not ready - still activate in DB for testing
    logger.warn(`Anchor client not ready, activating market ${pubkey} in DB only`);
  }
  
  // 3. Update DB: status -> OPEN, strikePrice -> real price
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

    // Last resort: placeholder (only for testing, should not happen in production)
    const fallbackPrices: Record<string, number> = { BTC: 95000, ETH: 3300, SOL: 145 };
    logger.warn(`Using LAST-RESORT placeholder price for ${asset}`);
    return fallbackPrices[asset] || null;
  } catch (err) {
    logger.error(`Failed to get price for ${asset}:`, err);
    return null;
  }
}

