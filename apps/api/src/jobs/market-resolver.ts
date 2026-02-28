import { marketService } from '../services/market.service.js';
import { orderbookService } from '../services/orderbook.service.js';
import { orderService } from '../services/order.service.js';
import { priceFeedService } from '../services/price-feed.service.js';
import { logger, marketLogger, logEvents } from '../lib/logger.js';
import { broadcastMarketResolved } from '../lib/broadcasts.js';
import { anchorClient, getMarketPda } from '../lib/anchor-client.js';
import { syncMarketStatusFromChain } from '../lib/chain-sync.js';
import { prepareSettlementData, settleMarketWithData, type SettlementPrepData } from './position-settler.js';
import { triggerMerkleSettlement, preSeedSettlingState, getPreSeededMerkleData, markRootPosted } from './merkle-settler.js';
import { tryAdvisoryLock, releaseAdvisoryLock } from '../lib/advisory-lock.js';
import { config } from '../config.js';

/**
 * Market Resolver Job
 *
 * Resolves expired markets by:
 * 1. Checking if price is above or below strike
 * 2. Setting the outcome (YES/NO)
 * 3. Closing the market
 * 4. Cancelling any remaining open orders
 */

// M-04: Database-backed concurrency guard via pg_try_advisory_lock
// Replaced in-memory Set with PostgreSQL advisory locks for multi-instance safety.
// Local Set kept as fast-path to avoid unnecessary DB round-trips within the same process.
const processingMarkets = new Set<string>();

// L-09: Track consecutive AccountNotInitialized failures before archiving
const accountNotFoundCount = new Map<string, number>();

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    // eslint-disable-next-line no-loop-func
    const p = worker(item).finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

export async function marketResolverJob(): Promise<void> {
  const now = new Date();
  
  // First check for OPEN markets that have expired - this is the most common case
  // Only make the second query if we actually have expired markets
  const expiredMarkets = await marketService.getExpiredOpenMarkets();
  
  // Only query for CLOSED markets if we don't have expired ones to process
  // (CLOSED markets are rare - they only exist briefly between close and resolve)
  let closedMarkets: Awaited<ReturnType<typeof marketService.getMarketsToResolve>> = [];
  if (expiredMarkets.length === 0) {
    closedMarkets = await marketService.getMarketsToResolve();
  }
  
  // Early exit if nothing to do (most common case)
  if (expiredMarkets.length === 0 && closedMarkets.length === 0) {
    return;
  }
  
  // Process CLOSED markets with bounded concurrency to avoid DB pool spikes
  const closedToProcess = closedMarkets.filter(market => !processingMarkets.has(market.id));
  await runWithConcurrency(closedToProcess, 2, async (market) => {
    // M-04: Acquire DB advisory lock (multi-instance safe)
    const lockAcquired = await tryAdvisoryLock('resolve', market.id);
    if (!lockAcquired) return; // Another instance is processing this market
    processingMarkets.add(market.id);
    try {
      await resolveMarket(market.id, market.pubkey, market.asset, market.strikePrice, now);
    } catch (err: any) {
      logger.error(`Failed to resolve market ${market.id} (${market.asset}-${market.timeframe}): ${err.message}`);
    } finally {
      processingMarkets.delete(market.id);
      await releaseAdvisoryLock('resolve', market.id);
    }
  });

  // Process expired markets with bounded concurrency to avoid DB pool spikes
  const expiredToProcess = expiredMarkets.filter(market => !processingMarkets.has(market.id));
  await runWithConcurrency(expiredToProcess, 2, async (market) => {
    // M-04: Acquire DB advisory lock (multi-instance safe)
    const lockAcquired = await tryAdvisoryLock('resolve', market.id);
    if (!lockAcquired) return;
    processingMarkets.add(market.id);
    try {
      // Close + resolve + settle in one atomic flow
      // We wrap closeMarket in its own try/catch so it doesn't block resolution
      try {
        await closeMarket(market.id, market.pubkey);
      } catch (closeErr: any) {
        logger.error(`Non-fatal: Failed to close market ${market.id} before resolution: ${closeErr.message}`);
      }

      await resolveMarket(market.id, market.pubkey, market.asset, market.strikePrice, now);
    } catch (err: any) {
      logger.error(`Failed to resolve market ${market.id} (${market.asset}-${market.timeframe}): ${err.message}`);
    } finally {
      processingMarkets.delete(market.id);
      await releaseAdvisoryLock('resolve', market.id);
    }
  });
}

/**
 * Close a market (stop accepting orders)
 */
async function closeMarket(marketId: string, marketPubkey: string): Promise<void> {
  // Capture currently-open USER orders before we flip DB state, so we can
  // force-cancel their on-chain Order PDAs (rent + escrow recovery).
  const openUserOrders = await orderService.getOpenUserOrdersForMarket(marketId);

  // Update market status, cancel orders, fetch market info in parallel
  const [, cancelledCount, market] = await Promise.all([
    marketService.updateStatus(marketId, 'CLOSED'),
    orderService.cancelAllForMarket(marketId),
    marketService.getById(marketId),
  ]);
  
  // Clear orderbook (fast, Redis operation)
  await orderbookService.clearOrderbook(marketId);

  // Force-cancel on-chain Order PDAs (only for user orders).
  // This is what returns SOL rent to users; DB cancellation alone does not.
  if (anchorClient.isReady() && openUserOrders.length > 0) {
    try {
      await anchorClient.cancelOrdersByRelayer({
        marketPubkey,
        orders: openUserOrders.map((o) => ({
          ownerPubkey: o.ownerWallet,
          clientOrderId: o.clientOrderId,
        })),
      });
    } catch (err: any) {
      logger.error(`Failed to force-cancel on-chain orders for market ${marketId}: ${err.message || err}`);
    }
  }
  
  // Log market closed
  logEvents.marketClosed({
    marketId,
    asset: market?.asset || 'UNKNOWN',
    timeframe: market?.timeframe || 'UNKNOWN',
    openOrdersCancelled: cancelledCount,
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

  // PIPELINED: Start on-chain resolve AND fetch settlement data in parallel
  let onChainResolvePending: Promise<string | null> | null = null;
  let settlementPrepPending: Promise<SettlementPrepData | null>;
  
  // Helper to attempt on-chain resolution with retry for clock skew
  const attemptResolve = async (retryCount = 0): Promise<string | null> => {
    try {
      let sig: string;
      if (config.useV2) {
        // V2: Tokenized shares market
        sig = await anchorClient.resolveMarketV2({
          marketPubkey: market.pubkey,
          outcome,
          finalPrice,
        });
        logger.info(`✅ MarketV2 resolved on-chain: ${sig}`);
      } else {
        // V1: Position PDAs market
        sig = await anchorClient.resolveMarket({
          marketPubkey: market.pubkey,
          outcome,
          finalPrice,
        });
        logger.info(`✅ Market resolved on-chain: ${sig}`);
      }
      return sig;
    } catch (err: any) {
      const errorMsg = err.message || '';
      
      // Handle "MarketNotExpired" error (0x1777) - clock skew between server and Solana
      // Retry once after a short delay to allow Solana clock to catch up
      if ((errorMsg.includes('MarketNotExpired') || errorMsg.includes('0x1777')) && retryCount < 1) {
        logger.warn(`Market ${marketId} not yet expired on-chain (clock skew), retrying in 1s...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return attemptResolve(retryCount + 1);
      }
      
      if (errorMsg.includes('MarketAlreadyResolved') || errorMsg.includes('0x1778')) {
        logger.debug(`Market ${marketId} already resolved on-chain, continuing`);
      } else if (errorMsg.includes('AccountNotInitialized') || errorMsg.includes('0xbc4')) {
        // L-09: Don't auto-archive on a single RPC failure — could be transient.
        // Track consecutive failures and only archive after 3 consecutive confirmations.
        const count = (accountNotFoundCount.get(marketId) || 0) + 1;
        accountNotFoundCount.set(marketId, count);
        if (count >= 3) {
          logger.warn(`Market ${marketId} (${market.pubkey}) confirmed not on-chain after ${count} checks. Marking as archived.`);
          await marketService.markArchived(marketId);
          accountNotFoundCount.delete(marketId);
        } else {
          logger.warn(`Market ${marketId} (${market.pubkey}) not found on-chain (attempt ${count}/3), will retry before archiving.`);
        }
      } else {
        logger.error(`❌ Failed to resolve market on-chain: ${errorMsg}`);
      }
      return null;
    }
  };
  
  // Start on-chain resolve (don't await yet) — V1 only.
  // V2 uses the combined resolveAndPostMerkleRoot instruction below.
  if (anchorClient.isReady() && !config.useV2) {
    logger.info(`Resolving market on-chain: ${market.pubkey} (outcome=${outcome}, price=${finalPrice})`);
    onChainResolvePending = attemptResolve();
  }
  
  // Start settlement prep IN PARALLEL with on-chain resolve
  settlementPrepPending = prepareSettlementData(marketId);
  
  // V2 fast path: combined resolve + postMerkleRoot in ONE TX (~2s saved)
  if (config.useV2) {
    // Pre-build merkle tree from settlement data fetched in parallel with resolve TX.
    // This runs BEFORE the resolve TX confirms, so the tree is ready the instant it does.
    const settlementPrepData = await settlementPrepPending;
    if (settlementPrepData && settlementPrepData.positions.length > 0) {
      preSeedSettlingState(marketId, outcome, settlementPrepData.positions, settlementPrepData.walletMap);
    }

    // Try combined resolve+postMerkleRoot in a single TX (saves ~2s)
    const merkleData = getPreSeededMerkleData(marketId);
    let usedCombinedTx = false;

    if (anchorClient.isReady() && merkleData) {
      try {
        const sig = await anchorClient.resolveAndPostMerkleRootV2({
          marketPubkey: market.pubkey,
          outcome,
          finalPrice,
          merkleRoot: merkleData.merkleRoot,
          totalAmount: merkleData.totalAmount,
          totalSettlements: merkleData.totalSettlements,
        });
        logger.info(`✅ MarketV2 resolved+merkleRoot in single TX: ${sig}`);
        markRootPosted(marketId);
        usedCombinedTx = true;
      } catch (err: any) {
        const errorMsg = err.message || '';
        // Handle clock skew — fall back to separate resolve + postMerkleRoot
        if (errorMsg.includes('MarketNotExpired') || errorMsg.includes('0x1777')) {
          logger.warn(`Combined TX failed (clock skew), falling back to separate resolve: ${errorMsg}`);
        } else if (errorMsg.includes('MarketAlreadyResolved') || errorMsg.includes('0x1778')) {
          logger.debug(`Market ${marketId} already resolved on-chain, continuing`);
        } else if (errorMsg.includes('AccountNotInitialized') || errorMsg.includes('0xbc4')) {
          // L-09: Don't auto-archive on transient RPC — require 3 consecutive confirmations
          const count = (accountNotFoundCount.get(marketId) || 0) + 1;
          accountNotFoundCount.set(marketId, count);
          if (count >= 3) {
            logger.warn(`Market ${marketId} (${market.pubkey}) confirmed not on-chain after ${count} checks. Marking as archived.`);
            await marketService.markArchived(marketId);
            accountNotFoundCount.delete(marketId);
          } else {
            logger.warn(`Market ${marketId} (${market.pubkey}) not found on-chain (attempt ${count}/3), will retry.`);
          }
          return;
        } else {
          logger.warn(`Combined TX failed, falling back to separate resolve: ${errorMsg}`);
        }
      }
    }

    // Fallback: separate resolve TX if combined didn't work (no merkle data, or combined failed)
    if (!usedCombinedTx && anchorClient.isReady()) {
      logger.info(`Resolving market on-chain (fallback): ${market.pubkey} (outcome=${outcome}, price=${finalPrice})`);
      await attemptResolve();
    }

    // Update DB + broadcast (skip syncMarketStatusFromChain — TX just confirmed)
    await marketService.resolve(marketId, outcome, finalPrice.toString());
    broadcastMarketResolved(marketPubkey, outcome, finalPrice, strike);
    logEvents.marketResolved({
      marketId, asset: market.asset, timeframe: market.timeframe,
      outcome, strikePrice: strike, finalPrice,
    });

    // Trigger batch settlement. If combined TX was used, processMarketSettlement
    // skips postMerkleRoot (rootPosted flag) and goes straight to batch creation.
    // If fallback was used, it does the normal postMerkleRoot first.
    const resolvedMarket = { ...market, status: 'RESOLVED' as const, outcome, finalPrice: finalPrice.toString() };
    triggerMerkleSettlement(marketId, resolvedMarket as any).catch(err => {
      logger.warn(`[MarketResolver] Direct merkle trigger failed for ${marketId}, polling will pick up: ${(err as Error).message}`);
    });
    return;
  }

  // V1 path: full sync + position settler
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

      // Allow stale prices up to 5 minutes for resolution (markets already expired)
      if (priceAge < 300000) {
        logger.warn(`Price for ${asset} is stale (${priceAge}ms old), using for resolution since market already expired`);
        return priceData.price;
      }

      logger.error(`Price for ${asset} is too stale (${priceAge}ms old) — refusing to resolve with unreliable price`);
      return null;
    }

    // No price data available — do NOT use random/hardcoded fallbacks
    // Markets will be retried on the next resolver run when prices are available
    logger.error(`No price data available for ${asset} — cannot resolve. Will retry on next run.`);
    return null;
  } catch (err) {
    logger.error(`Failed to get final price for ${asset}:`, err);
    return null;
  }
}

