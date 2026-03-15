import { eq, and, sql } from 'drizzle-orm';
import { db, marginAccounts, markets } from '../db/index.js';
import { marginService } from '../services/margin.service.js';
import { lendingService } from '../services/lending.service.js';
import { orderbookService } from '../services/orderbook.service.js';
import { transactionService } from '../services/transaction.service.js';
import { anchorClient } from '../lib/anchor-client.js';
import { logger, keeperLogger, logEvents } from '../lib/logger.js';
import { broadcastUserLiquidation } from '../lib/broadcasts.js';
import { config } from '../config.js';
import { redis } from '../db/redis.js';

/**
 * Liquidation Checker Job
 * 
 * Continuously monitors leveraged positions and liquidates those
 * that have fallen below the maintenance margin threshold.
 * 
 * - Runs every 1 second for responsive liquidations
 * - Uses current market prices (best bid/ask) to determine liquidation
 * - Executes liquidations atomically to prevent bad debt
 * - Sends penalties to insurance fund
 */

// How often to check for liquidations (more frequent = less slippage risk)
export const LIQUIDATION_CHECK_INTERVAL_MS = 1 * 1000; // 1 second

// Cooldown for failed liquidations (don't spam retries)
const LIQUIDATION_COOLDOWN_MS = 30 * 1000; // 30 seconds
const failedLiquidations = new Map<string, number>(); // marginAccountId -> timestamp of last failure

// Cache key for tracking if there are any open margin accounts
const OPEN_ACCOUNTS_CACHE_KEY = 'liquidation:has_open_accounts';
const OPEN_ACCOUNTS_CACHE_TTL = 10; // seconds

/**
 * Main liquidation checker job
 */
export async function liquidationCheckerJob(): Promise<void> {
  // Skip if leverage not enabled
  if (!lendingService.isEnabled()) {
    return;
  }

  // SHORT-CIRCUIT: Check cached count first to avoid DB query when no accounts
  // This prevents unnecessary DB load when there are no leveraged positions
  try {
    const cachedHasAccounts = await redis.get(OPEN_ACCOUNTS_CACHE_KEY);
    if (cachedHasAccounts === '0') {
      // No open margin accounts, skip the expensive DB query
      return;
    }
  } catch {
    // Redis error - proceed with DB query as fallback
  }

  // Get all open margin accounts with their markets
  // Only check accounts where on-chain position is confirmed (prevents race condition
  // where liquidation runs before execute_match completes)
  const accountsToCheck = await db
    .select({
      account: marginAccounts,
      market: markets,
    })
    .from(marginAccounts)
    .innerJoin(markets, eq(marginAccounts.marketId, markets.id))
    .where(and(
      eq(marginAccounts.status, 'OPEN'),
      eq(markets.status, 'OPEN'),
      // Only liquidate accounts with confirmed on-chain position
      // This prevents trying to execute_close before execute_match completes
      sql`${marginAccounts.onChainConfirmedAt} IS NOT NULL`
    ));

  // Update cache with current count (even if 0)
  try {
    await redis.set(
      OPEN_ACCOUNTS_CACHE_KEY,
      accountsToCheck.length > 0 ? '1' : '0',
      'EX',
      OPEN_ACCOUNTS_CACHE_TTL
    );
  } catch {
    // Ignore Redis errors - non-critical
  }

  if (accountsToCheck.length === 0) {
    return;
  }
  
  // Get current prices for all relevant markets
  const currentPrices = new Map<string, number>();
  const marketIds = [...new Set(accountsToCheck.map(a => a.market.id))];
  
  for (const marketId of marketIds) {
    try {
      // Get best bid and ask from orderbook
      const snapshot = await orderbookService.getSnapshot(marketId, 'YES');
      
      // Use mid price for liquidation checks
      // If no orders, use the stored market price
      let price = 0.5; // Default mid
      
      if (snapshot.bids.length > 0 && snapshot.asks.length > 0) {
        const bestBid = snapshot.bids[0].price;
        const bestAsk = snapshot.asks[0].price;
        price = (bestBid + bestAsk) / 2;
      } else if (snapshot.bids.length > 0) {
        price = snapshot.bids[0].price;
      } else if (snapshot.asks.length > 0) {
        price = snapshot.asks[0].price;
      } else {
        // Fall back to stored market price
        const market = accountsToCheck.find(a => a.market.id === marketId)?.market;
        if (market?.yesPrice) {
          price = parseFloat(market.yesPrice);
        }
      }
      
      currentPrices.set(marketId, price);
    } catch (err) {
      // If we can't get price, skip this market for safety
      keeperLogger.warn(`Could not get price for market ${marketId}, skipping liquidation check`);
    }
  }
  
  // Check each account for liquidation
  let liquidatedCount = 0;
  
  for (const { account, market } of accountsToCheck) {
    const currentPrice = currentPrices.get(market.id);
    if (currentPrice === undefined) continue;
    
    // Skip if this account recently failed liquidation (cooldown period)
    const lastFailure = failedLiquidations.get(account.id);
    if (lastFailure && Date.now() - lastFailure < LIQUIDATION_COOLDOWN_MS) {
      continue; // Still in cooldown, skip silently
    }
    
    const liquidationPrice = parseFloat(account.liquidationPrice);
    const side = account.side as 'YES' | 'NO';
    // Floor shares to 6 decimals to match on-chain precision (SHARE_MULTIPLIER = 10^6)
    // This prevents "InsufficientShares" errors from precision mismatches
    const shares = Math.floor(parseFloat(account.shares) * 1_000_000) / 1_000_000;
    
    // Check if should liquidate
    // currentPrice is YES price from orderbook
    // For YES positions: liquidate when YES price drops to liq price
    // For NO positions: liquidate when NO price drops to liq price (i.e., YES rises)
    let shouldLiquidate = false;
    
    if (side === 'YES') {
      // YES positions liquidate when YES price drops to/below liquidation price
      shouldLiquidate = currentPrice <= liquidationPrice;
    } else {
      // NO positions liquidate when NO price drops to/below liquidation price
      // NO price = 1 - YES price, so we compare (1 - currentPrice) to liquidation price
      const currentNoPrice = 1 - currentPrice;
      shouldLiquidate = currentNoPrice <= liquidationPrice;
    }
    
    if (!shouldLiquidate) continue;
    
    // Execute liquidation
    try {
      // SET LIQUIDATION LOCK FIRST - blocks user sells while we liquidate
      // This happens BEFORE any on-chain work to prevent race conditions
      const lockSet = await marginService.setLiquidationLock(account.id);
      if (!lockSet) {
        keeperLogger.warn(`Could not set liquidation lock on ${account.id} - may already be liquidating or closed`, {
          source: 'LIQUIDATION',
          marginAccountId: account.id,
        });
        continue; // Skip - either already being liquidated or already closed
      }
      
      keeperLogger.info(`Liquidating margin account ${account.id}`, {
        source: 'LIQUIDATION',
        userId: account.userId,
        marketId: market.id,
        side,
        shares,
        entryPrice: account.entryPrice,
        liquidationPrice,
        currentPrice,
        leverage: account.leverage,
        loanAmount: account.loanAmount,
      });
      
      // For liquidations, execute at the LIQUIDATION PRICE to guarantee expected equity
      // This ensures:
      // 1. No bad debt (loan is always covered)
      // 2. User gets their expected remaining equity returned
      // 3. MM acts as liquidator and buys at the calculated liq price
      const triggerPrice = currentPrice;
      
      // Calculate execution price - use liquidation price to guarantee solvency
      // liquidationPrice is stored in the position's native price (YES for YES, NO for NO)
      // currentPrice is always YES price from orderbook
      let executionPrice: number;
      if (side === 'YES') {
        // YES: use liq price (higher = better for seller)
        executionPrice = liquidationPrice;
      } else {
        // NO: liquidationPrice is NO price, need to return YES price for proceeds calc
        // Since NO liq happens when NO drops, we execute at liq NO price
        // But proceeds = shares × price, and for NO shares price = NO price
        // So executionPrice should be the NO liquidation price
        executionPrice = liquidationPrice;
      }
      
      // Execute on-chain close: Lending Pool sells shares to MM
      const lendingPoolWallet = lendingService.getLendingWalletPubkey()?.toBase58();
      const mmWallet = anchorClient.getMmPublicKey();
      let onChainCloseSuccess = false;
      
      if (!lendingPoolWallet) {
        keeperLogger.error(`Lending pool wallet not configured, cannot execute liquidation close`, {
          source: 'LIQUIDATION',
          marginAccountId: account.id,
        });
        continue; // Skip this liquidation - we can't close without lending pool
      }
      
      if (mmWallet && market.pubkey && anchorClient.isReady()) {
        // For execute_close, the price is already in the native terms for each side:
        // - YES positions: executionPrice is YES liquidation price
        // - NO positions: executionPrice is NO liquidation price (already converted above)
        // So we use executionPrice directly - no conversion needed!
        const closePrice = executionPrice;
        
        keeperLogger.info(`Executing liquidation close on-chain: ${shares.toFixed(2)} ${side} @ ${closePrice.toFixed(4)} (liquidation price)`, {
          source: 'LIQUIDATION',
          lendingPool: lendingPoolWallet.slice(0, 8),
          mmWallet: mmWallet.slice(0, 8),
          marketPubkey: market.pubkey.slice(0, 8),
          side,
          closePrice,
        });
        
        try {
          // Execute close: Lending Pool sells shares to MM
          // MM buys back the shares at the close price
          // Use configured flat fee (same as regular orders) to ensure profitability
          const liquidationFee = config.fees.flatFeeUsd;
          
          const closeResult = await transactionService.executeClose({
            marketPubkey: market.pubkey,
            buyerWallet: mmWallet,           // MM buys the shares
            sellerWallet: lendingPoolWallet, // Lending Pool sells
            outcome: side,                   // The share type being traded
            price: closePrice,               // Converted price for the outcome
            matchSize: shares,
            takerFee: liquidationFee,        // Use config flat fee for consistency
          });
          
          if (closeResult.success) {
            keeperLogger.info(`✅ Liquidation close executed on-chain: ${closeResult.signature}`, {
              source: 'LIQUIDATION',
              signature: closeResult.signature,
            });
            onChainCloseSuccess = true;
          } else {
            keeperLogger.error(`❌ On-chain liquidation close failed: ${closeResult.error}`, {
              source: 'LIQUIDATION',
              error: closeResult.error,
              side,
              shares,
              executionPrice,
            });
          }
        } catch (closeErr: any) {
          keeperLogger.error(`❌ Exception during liquidation close: ${closeErr.message}`, {
            source: 'LIQUIDATION',
            error: closeErr.message,
            side,
            shares,
            executionPrice,
          });
        }
      } else {
        keeperLogger.warn(`Cannot execute on-chain close: missing config`, {
          source: 'LIQUIDATION',
          hasMmWallet: !!mmWallet,
          hasMarketPubkey: !!market.pubkey,
          anchorReady: anchorClient.isReady(),
        });
      }
      
      // Only process liquidation in DB if on-chain close succeeded
      // Otherwise the position still exists on-chain and we'd create accounting mismatch
      if (!onChainCloseSuccess) {
        // Clear the liquidation lock so user can try to sell (or we retry liquidation)
        await marginService.clearLiquidationLock(account.id);
        
        // Track failed liquidation for cooldown (prevent spam)
        failedLiquidations.set(account.id, Date.now());
        
        keeperLogger.warn(`Skipping DB liquidation - on-chain close failed. Will retry in ${LIQUIDATION_COOLDOWN_MS/1000}s`, {
          source: 'LIQUIDATION',
          marginAccountId: account.id,
          positionId: account.positionId,
          side,
          shares,
        });
        continue; // Don't process this liquidation until on-chain succeeds
      }
      
      // Clear cooldown on success
      failedLiquidations.delete(account.id);
      
      // Record liquidation in DB and distribute funds (only after on-chain success)
      const liquidation = await marginService.liquidate(account.id, triggerPrice, executionPrice);
      
      liquidatedCount++;
      
      keeperLogger.info(`Successfully liquidated account ${account.id}`, {
        source: 'LIQUIDATION',
        triggerPrice,
        executionPrice,
      });
      
      // Broadcast to user so frontend can refresh positions
      broadcastUserLiquidation(account.userId, {
        marketId: market.id,
        marketAddress: market.pubkey,
        side,
        shares,
        entryPrice: parseFloat(account.entryPrice),
        liquidationPrice: parseFloat(account.liquidationPrice),
        executionPrice,
        proceeds: parseFloat(liquidation.proceeds),
        returnedToUser: parseFloat(liquidation.returnedToUser),
        leverage: parseFloat(account.leverage),
      });
      
    } catch (err: any) {
      keeperLogger.error(`Failed to liquidate account ${account.id}: ${err.message}`, {
        source: 'LIQUIDATION',
        error: err.message,
        userId: account.userId,
        marketId: market.id,
      });
    }
  }
  
  if (liquidatedCount > 0) {
    keeperLogger.info(`Liquidation cycle complete: ${liquidatedCount} positions liquidated`, {
      source: 'LIQUIDATION',
      count: liquidatedCount,
    });
  }
}

/**
 * Get the execution price for a liquidation
 * 
 * In a real system, this would involve placing a market sell order
 * and getting the actual fill price. For v1, we use the orderbook
 * to estimate slippage.
 */
async function getExecutionPrice(
  marketId: string,
  side: 'YES' | 'NO',
  shares: number,
  currentPrice: number
): Promise<number> {
  try {
    const snapshot = await orderbookService.getSnapshot(marketId, 'YES');
    
    // For YES position liquidation, we need to sell YES shares (hit the bids)
    // For NO position liquidation, we need to sell NO shares (buy YES to close)
    
    if (side === 'YES') {
      // Selling YES shares - walk through bids
      let remaining = shares;
      let totalValue = 0;
      
      for (const level of snapshot.bids) {
        const fillSize = Math.min(remaining, level.size);
        totalValue += fillSize * level.price;
        remaining -= fillSize;
        if (remaining <= 0) break;
      }
      
      // If not enough liquidity, use a slippage estimate
      if (remaining > 0) {
        // Assume 5% slippage for remaining
        const worstPrice = Math.max(0.01, currentPrice * 0.95);
        totalValue += remaining * worstPrice;
      }
      
      return totalValue / shares;
      
    } else {
      // Selling NO shares - walk through asks (buying YES to close NO)
      let remaining = shares;
      let totalCost = 0;
      
      for (const level of snapshot.asks) {
        const fillSize = Math.min(remaining, level.size);
        totalCost += fillSize * level.price;
        remaining -= fillSize;
        if (remaining <= 0) break;
      }
      
      // For NO, execution price is what YES trades at
      if (remaining > 0) {
        // Assume 5% adverse slippage
        const worstPrice = Math.min(0.99, currentPrice * 1.05);
        totalCost += remaining * worstPrice;
      }
      
      return totalCost / shares;
    }
  } catch {
    // Fall back to current price with small slippage
    if (side === 'YES') {
      return currentPrice * 0.98; // 2% slippage for sells
    } else {
      return currentPrice * 1.02; // 2% adverse move for NO liquidation
    }
  }
}

/**
 * Sync lending pool balance (run periodically)
 * This ensures the lending pool DB is in sync with on-chain balance
 */
export async function lendingPoolSyncJob(): Promise<void> {
  if (!lendingService.isEnabled()) {
    return;
  }
  
  try {
    const status = await lendingService.syncPoolBalance();
    logEvents.lendingPoolSynced({
      balance: status.balance,
      available: status.available,
      loaned: status.loaned,
    });
  } catch (err: any) {
    keeperLogger.error(`Failed to sync lending pool: ${err.message}`, {
      source: 'LENDING',
      error: err.message,
    });
  }
}

