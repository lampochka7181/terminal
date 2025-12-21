import { marketService } from '../services/market.service.js';
import { orderbookService } from '../services/orderbook.service.js';
import { orderService } from '../services/order.service.js';
import { priceFeedService } from '../services/price-feed.service.js';
import { logger, marketLogger, logEvents } from '../lib/logger.js';
import { broadcastMarketResolved } from '../lib/broadcasts.js';
import { anchorClient, getMarketPda } from '../lib/anchor-client.js';
import { prepareSettlementData, settleMarketWithData, type SettlementPrepData } from './position-settler.js';

/**
 * Market Resolver Job
 * 
 * Resolves expired markets by:
 * 1. Checking if price is above or below strike
 * 2. Setting the outcome (YES/NO)
 * 3. Closing the market
 * 4. Cancelling any remaining open orders
 */

// Track markets being processed to prevent duplicate concurrent processing
const processingMarkets = new Set<string>();

export async function marketResolverJob(): Promise<void> {
  const now = new Date();
  
  // Get markets that are CLOSED but not yet RESOLVED
  const closedMarkets = await marketService.getMarketsToResolve();
  
  // Process CLOSED markets in parallel
  await Promise.all(
    closedMarkets
      .filter(market => !processingMarkets.has(market.id))
      .map(async market => {
        processingMarkets.add(market.id);
        try {
          await resolveMarket(market.id, market.pubkey, market.asset, market.strikePrice, now);
        } catch (err: any) {
          logger.error(`Failed to resolve market ${market.id} (${market.asset}-${market.timeframe}): ${err.message}`);
        } finally {
          processingMarkets.delete(market.id);
        }
      })
  );
  
  // Check for OPEN markets that should be CLOSED (already expired)
  // Close AND immediately resolve them in one pass for faster UX
  const expiredMarkets = await marketService.getExpiredOpenMarkets();
  
  // Process expired markets in parallel
  await Promise.all(
    expiredMarkets
      .filter(market => !processingMarkets.has(market.id))
      .map(async market => {
        processingMarkets.add(market.id);
        try {
          // Close + resolve + settle in one atomic flow
          await closeMarket(market.id, market.pubkey);
          await resolveMarket(market.id, market.pubkey, market.asset, market.strikePrice, now);
        } catch (err: any) {
          logger.error(`Failed to close/resolve market ${market.id} (${market.asset}-${market.timeframe}): ${err.message}`);
        } finally {
          processingMarkets.delete(market.id);
        }
      })
  );
}

/**
 * Close a market (stop accepting orders)
 */
async function closeMarket(marketId: string, marketPubkey: string): Promise<void> {
  // Update market status, cancel orders, clear orderbook in parallel
  const [, , market] = await Promise.all([
    marketService.updateStatus(marketId, 'CLOSED'),
    orderService.cancelAllForMarket(marketId),
    marketService.getById(marketId),
  ]);
  
  // Clear orderbook (fast, Redis operation)
  await orderbookService.clearOrderbook(marketId);
  
  // Log market closed
  logEvents.marketClosed({
    marketId,
    asset: market?.asset || 'UNKNOWN',
    timeframe: market?.timeframe || 'UNKNOWN',
    openOrdersCancelled: 0,
  });
}

/**
 * Resolve a market (determine outcome)
 * 
 * PIPELINED FLOW for speed:
 * 1. Start on-chain resolve transaction
 * 2. IN PARALLEL: Fetch positions + user wallets for settlement
 * 3. When both complete: Execute settlement immediately
 */
async function resolveMarket(
  marketId: string,
  marketPubkey: string,
  asset: string,
  strikePrice: string,
  now: Date
): Promise<void> {
  // Get market info first - check if already resolved
  const market = await marketService.getById(marketId);
  if (!market) {
    logger.error(`Market ${marketId} not found`);
    return;
  }
  
  // Skip if already resolved (race condition with another job)
  if (market.status === 'RESOLVED' || market.status === 'SETTLED') {
    logger.debug(`Market ${marketId} already resolved/settled, skipping`);
    return;
  }

  // Get final price from oracle/cache
  const finalPrice = await getFinalPrice(asset);
  
  if (finalPrice === null) {
    logger.warn(`No final price available for ${asset}, skipping resolution`);
    return;
  }
  
  const strike = parseFloat(strikePrice);
  
  // Determine outcome: YES if price > strike, NO if price <= strike
  const outcome: 'YES' | 'NO' = finalPrice > strike ? 'YES' : 'NO';

  // OPTIMIZATION: If zero positions were created, don't waste gas resolving on-chain
  // Just update DB and let the closer job recover the rent directly
  if (market.totalPositions === 0) {
    logger.info(`Market ${marketId} (${market.asset}-${market.timeframe}) has 0 positions. Skipping on-chain resolution to save gas.`);
    
    // Update market with outcome in database only
    await marketService.resolve(marketId, outcome, finalPrice.toString());
    
    // Mark as settled immediately since there's nothing to settle
    await marketService.updateStatus(marketId, 'SETTLED');
    
    // Broadcast resolution event for UI consistency
    broadcastMarketResolved(marketPubkey, outcome, finalPrice, strike);
    return;
  }

  // PIPELINED: Start on-chain resolve AND fetch settlement data in parallel
  let onChainResolvePending: Promise<string | null> | null = null;
  let settlementPrepPending: Promise<SettlementPrepData | null>;
  
  // Start on-chain resolve (don't await yet)
  if (anchorClient.isReady()) {
    logger.info(`Resolving market on-chain: ${market.pubkey} (outcome=${outcome}, price=${finalPrice})`);
    
    onChainResolvePending = anchorClient.resolveMarket({
      marketPubkey: market.pubkey,
      outcome,
      finalPrice,
    }).then(sig => {
      logger.info(`✅ Market resolved on-chain: ${sig}`);
      return sig;
    }).catch(async (err: any) => {
      const errorMsg = err.message || '';
      if (errorMsg.includes('MarketAlreadyResolved') || errorMsg.includes('0x1778')) {
        logger.debug(`Market ${marketId} already resolved on-chain, continuing`);
      } else if (errorMsg.includes('AccountNotInitialized') || errorMsg.includes('0xbc4')) {
        logger.warn(`Market ${marketId} (${market.pubkey}) does not exist on-chain. Marking as archived.`);
        await marketService.markArchived(marketId);
      } else {
        logger.error(`❌ Failed to resolve market on-chain: ${errorMsg}`);
      }
      return null;
    });
  }
  
  // Start settlement prep IN PARALLEL with on-chain resolve
  settlementPrepPending = prepareSettlementData(marketId);
  
  // Wait for on-chain resolve to complete (settlement prep continues in parallel)
  if (onChainResolvePending) {
    await onChainResolvePending;
  }
  
  // Update market with outcome in database
  await marketService.resolve(marketId, outcome, finalPrice.toString());
  
  // Broadcast resolution event
  broadcastMarketResolved(marketPubkey, outcome, finalPrice, strike);
  
  // Log market resolution
  logEvents.marketResolved({
    marketId,
    asset: market.asset,
    timeframe: market.timeframe,
    outcome,
    strikePrice: strike,
    finalPrice,
  });
  
  // Wait for settlement prep to complete (likely already done)
  const settlementPrepData = await settlementPrepPending;
  
  // Get updated market with outcome for settlement
  const resolvedMarket = await marketService.getById(marketId);
  if (!resolvedMarket) {
    logger.error(`Market ${marketId} not found after resolution`);
    return;
  }
  
  // Execute settlement immediately with pipelined data
  try {
    await settleMarketWithData(resolvedMarket, settlementPrepData);
  } catch (err) {
    logger.error(`Immediate settlement failed for ${marketId}, will retry on next settler run:`, err);
  }
}

/**
 * Get the final price for an asset at resolution time
 */
async function getFinalPrice(asset: string): Promise<number | null> {
  try {
    const priceData = await priceFeedService.getPrice(asset);
    
    if (priceData) {
      // Check if price is fresh enough (within 60 seconds)
      const priceAge = Date.now() - priceData.timestamp;
      if (priceAge < 60000) {
        return priceData.price;
      }
      
      logger.warn(`Price for ${asset} is stale (${priceAge}ms old), using anyway`);
      return priceData.price;
    }
    
    // Fallback for development (when Binance not connected)
    const fallbackPrices: Record<string, number> = {
      BTC: 95000 + (Math.random() - 0.5) * 1000,
      ETH: 3300 + (Math.random() - 0.5) * 100,
      SOL: 145 + (Math.random() - 0.5) * 10,
    };
    
    logger.warn(`Using fallback price for ${asset} resolution`);
    return fallbackPrices[asset] || null;
  } catch (err) {
    logger.error(`Failed to get final price for ${asset}:`, err);
    return null;
  }
}

