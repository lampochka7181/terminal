import { eq, and, inArray, ne, sql } from 'drizzle-orm';
import { db, markets, positions, settlements, users, marginAccounts, mmMarketMetrics, trades } from '../db/index.js';
import { positionService } from '../services/position.service.js';
import { marketService } from '../services/market.service.js';
import { transactionService } from '../services/transaction.service.js';
import { userService } from '../services/user.service.js';
import { lendingService } from '../services/lending.service.js';
import { mmBotV2 } from '../bot/mm-bot-v2.js';
import { logger, positionLogger, marketLogger, logEvents } from '../lib/logger.js';
import { broadcastUserSettlement } from '../lib/broadcasts.js';
import { anchorClient } from '../lib/anchor-client.js';
import { config } from '../config.js';

/**
 * Batch settlement item - prepared data for one position
 */
interface SettlementBatchItem {
  position: typeof positions.$inferSelect;
  outcome: 'YES' | 'NO';
  winningShares: number;
  payout: number;
  profit: number;
  userWallet: string | null;
  settlementId: string;
  needsOnChainSettlement: boolean;
  // Leverage fields
  isLeveraged: boolean;
  settlementWallet: string | null; // Lending Pool wallet for leveraged, user wallet otherwise
  loanAmount?: number;             // Loan to repay (if leveraged)
  userPayout?: number;             // What user actually receives after loan repayment
}

/**
 * Position Settler Job
 * 
 * Settles positions for resolved markets:
 * 1. Find resolved markets that haven't been settled
 * 2. For each position, calculate payout
 * 3. Create settlement records
 * 4. Notify users via WebSocket
 * 
 * Settlement Rules:
 * - If outcome is YES: YES shareholders get $1.00 per share
 * - If outcome is NO: NO shareholders get $1.00 per share
 * - Losers get $0.00
 */

// Batch size for processing positions
const BATCH_SIZE = 20;

// Track markets being settled to prevent duplicate concurrent settlement
const settlingMarkets = new Set<string>();

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

/**
 * Check if Lending Pool has an on-chain position that needs to be settled for this market.
 * This happens when leveraged positions were manually closed - the Lending Pool's
 * on-chain position account still exists and must be settled to allow market closure.
 */
async function checkLendingPoolNeedsSettlement(marketId: string): Promise<boolean> {
  // Check if any margin accounts were created for positions in this market
  // This indicates Lending Pool executed trades for this market
  const marginAccountsForMarket = await db
    .select({ id: marginAccounts.id })
    .from(marginAccounts)
    .innerJoin(positions, eq(marginAccounts.positionId, positions.id))
    .where(eq(positions.marketId, marketId))
    .limit(1);
  
  if (marginAccountsForMarket.length > 0) {
    logger.info(`[Settlement] Lending Pool has position for market ${marketId} - will be included in settlement`);
    return true;
  }
  
  return false;
}

/**
 * Pre-fetched settlement data (positions + wallets) for pipelining
 */
export interface SettlementPrepData {
  positions: (typeof positions.$inferSelect)[];
  walletMap: Map<string, string | null>;
  settlementMap: Map<string, typeof settlements.$inferSelect>;
}

/**
 * Pipeline step 1: Fetch positions and wallets WHILE on-chain resolve is pending
 * This can run in parallel with the resolve transaction
 */
export async function prepareSettlementData(marketId: string): Promise<SettlementPrepData | null> {
  // Get all unsettled positions for this market
  const openPositions = await positionService.getPositionsForSettlement(marketId);
  
  if (openPositions.length === 0) {
    return null; // No positions to settle
  }
  
  // Batch fetch user wallets and existing settlements
  const userIds = [...new Set(openPositions.map(p => p.userId).filter(Boolean) as string[])];
  const positionIds = openPositions.map(p => p.id);
  
  const [userWallets, existingSettlements] = await Promise.all([
    userIds.length > 0 
      ? db.select({ id: users.id, walletAddress: users.walletAddress })
          .from(users)
          .where(inArray(users.id, userIds))
      : Promise.resolve([]),
    positionIds.length > 0
      ? db.select()
          .from(settlements)
          .where(inArray(settlements.positionId, positionIds))
      : Promise.resolve([]),
  ]);
  
  return {
    positions: openPositions,
    walletMap: new Map(userWallets.map(u => [u.id, u.walletAddress])),
    settlementMap: new Map(existingSettlements.map(s => [s.positionId, s])),
  };
}

/**
 * Pipeline step 2: Execute settlement with pre-fetched data
 * Called immediately after on-chain resolve completes
 */
export async function settleMarketWithData(
  market: typeof markets.$inferSelect,
  prepData: SettlementPrepData | null
): Promise<void> {
  // Prevent duplicate concurrent settlement
  if (settlingMarkets.has(market.id)) {
    logger.debug(`Market ${market.id} already being settled, skipping`);
    return;
  }
  
  settlingMarkets.add(market.id);
  
  try {
    await settleMarketFast(market, prepData);
  } finally {
    settlingMarkets.delete(market.id);
  }
}

/**
 * Legacy: Settle a specific market immediately (called from resolver for fast UX)
 * Use settleMarketWithData for better performance when market object is available
 */
export async function settleMarketImmediately(marketId: string): Promise<void> {
  // Prevent duplicate concurrent settlement
  if (settlingMarkets.has(marketId)) {
    logger.debug(`Market ${marketId} already being settled, skipping`);
    return;
  }
  
  settlingMarkets.add(marketId);
  
  try {
    const market = await db
      .select()
      .from(markets)
      .where(eq(markets.id, marketId))
      .limit(1);
    
    if (market.length > 0 && market[0].status === 'RESOLVED') {
      await settleMarketFast(market[0], null);
    }
  } finally {
    settlingMarkets.delete(marketId);
  }
}

export async function positionSettlerJob(): Promise<void> {
  // Get resolved markets that need settlement
  const resolvedMarkets = await db
    .select()
    .from(markets)
    .where(eq(markets.status, 'RESOLVED'));
  
  for (const market of resolvedMarkets) {
    // Skip if already being settled by immediate trigger
    if (settlingMarkets.has(market.id)) {
      logger.debug(`Market ${market.id} already being settled, skipping in job`);
      continue;
    }
    
    settlingMarkets.add(market.id);
    
    try {
      await settleMarket(market);
    } catch (err: any) {
      logger.error(`Failed to settle market ${market.id} (${market.asset}-${market.timeframe}): ${err.message}`);
    } finally {
      settlingMarkets.delete(market.id);
    }
  }
}

/**
 * Settle all positions in a market (legacy - for periodic job)
 */
async function settleMarket(market: typeof markets.$inferSelect): Promise<void> {
  await settleMarketFast(market, null);
}

/**
 * Fast market settlement with optional pre-fetched data
 * If prepData is null, will fetch positions/wallets (slightly slower)
 */
async function settleMarketFast(
  market: typeof markets.$inferSelect,
  prepData: SettlementPrepData | null
): Promise<void> {
  if (!market.outcome) {
    logger.warn(`Market ${market.id} has no outcome, skipping settlement`);
    return;
  }
  
  const outcome = market.outcome as 'YES' | 'NO';
  
  // Use pre-fetched data or fetch now
  let openPositions: (typeof positions.$inferSelect)[];
  let walletMap: Map<string, string | null>;
  let settlementMap: Map<string, typeof settlements.$inferSelect>;
  
  if (prepData) {
    // Use pipelined data (fastest path)
    openPositions = prepData.positions;
    walletMap = prepData.walletMap;
    settlementMap = prepData.settlementMap;
  } else {
    // Fetch data now (fallback path)
    openPositions = await positionService.getPositionsForSettlement(market.id);
    
    if (openPositions.length === 0) {
      await marketService.markSettled(market.id);
      logEvents.marketSettled({
        marketId: market.id,
        asset: market.asset,
        timeframe: market.timeframe,
        positionsSettled: 0,
        totalPayout: 0,
      });
      return;
    }
    
    const userIds = [...new Set(openPositions.map(p => p.userId).filter(Boolean) as string[])];
    const positionIds = openPositions.map(p => p.id);
    
    const [userWallets, existingSettlements] = await Promise.all([
      userIds.length > 0 
        ? db.select({ id: users.id, walletAddress: users.walletAddress })
            .from(users)
            .where(inArray(users.id, userIds))
        : Promise.resolve([]),
      positionIds.length > 0
        ? db.select()
            .from(settlements)
            .where(inArray(settlements.positionId, positionIds))
        : Promise.resolve([]),
    ]);
    
    walletMap = new Map(userWallets.map(u => [u.id, u.walletAddress]));
    settlementMap = new Map(existingSettlements.map(s => [s.positionId, s]));
  }
  
  if (openPositions.length === 0) {
    await marketService.markSettled(market.id);
    logEvents.marketSettled({
      marketId: market.id,
      asset: market.asset,
      timeframe: market.timeframe,
      positionsSettled: 0,
      totalPayout: 0,
    });
    return;
  }
  
  positionLogger.info(`Settling ${openPositions.length} positions`, {
    marketId: market.id,
    asset: market.asset,
    timeframe: market.timeframe,
    positionCount: openPositions.length,
  });
  
  // V2 markets with trades need merkle settlement (on-chain first, then DB).
  // Don't settle in DB until on-chain settlement is confirmed.
  // Market stays RESOLVED — the merkle settlement pipeline will handle the full flow.
  if (config.useV2) {
    logger.info(`[V2] Market ${market.id} (${market.asset}-${market.timeframe}) resolved with ${openPositions.length} positions — awaiting merkle settlement`);
    return;
  }

  // --- V1 settlement path (Position PDAs) ---

  // BATCH SETTLEMENT: Build all settlement data first, then execute in one transaction
  const settlementBatch = await prepareSettlementBatch(openPositions, outcome, market, walletMap, settlementMap);

  // Check if Lending Pool needs to be settled (for leveraged positions that were manually closed)
  const lendingPoolWallet = lendingService.getLendingWalletPubkey()?.toBase58() || null;
  const needsLendingPoolSettlement = lendingPoolWallet && await checkLendingPoolNeedsSettlement(market.id);

  if (settlementBatch.length > 0 || needsLendingPoolSettlement) {
    // Execute all on-chain settlements in a single transaction
    await executeBatchSettlement(settlementBatch, market, needsLendingPoolSettlement ? lendingPoolWallet : null);
  }

  // Process DB updates/notifications with bounded concurrency to avoid DB pool spikes
  await runWithConcurrency(settlementBatch, 3, async (item) => finalizeSettlement(item, market));

  // Final check: if all positions for this market are now settled, mark market as settled in DB
  const remainingOpen = await positionService.getPositionsForSettlement(market.id);
  if (remainingOpen.length === 0) {
    await marketService.markSettled(market.id);

    // Calculate total payout for logging
    const totalPayout = settlementBatch.reduce((sum, item) => sum + item.payout, 0);

    logEvents.marketSettled({
      marketId: market.id,
      asset: market.asset,
      timeframe: market.timeframe,
      positionsSettled: settlementBatch.length,
      totalPayout,
    });

    // Calculate and store MM metrics (zero-sum: MM P&L = -sum of user P&L)
    await calculateAndStoreMmMetrics(market.id, market.outcome as 'YES' | 'NO');

    // Immediately recover on-chain market/vault rent after settlement.
    if (anchorClient.isReady() && !market.pubkey.startsWith('arc-')) {
      try {
        const sig = await anchorClient.closeMarket({ marketPubkey: market.pubkey });
        logger.info(`Market rent recovered immediately after settlement: ${sig}`);
        await marketService.markArchived(market.id);
      } catch (err: any) {
        const msg = err?.message || String(err);
        logger.warn(`Market ${market.id} close failed post-settlement (will retry via Market Closer): ${msg}`);
      }
    }
  }
}

/**
 * Prepare batch of settlements - calculates payouts and creates DB records
 */
async function prepareSettlementBatch(
  openPositions: (typeof positions.$inferSelect)[],
  outcome: 'YES' | 'NO',
  market: typeof markets.$inferSelect,
  walletMap: Map<string, string | null>,
  settlementMap: Map<string, typeof settlements.$inferSelect>
): Promise<SettlementBatchItem[]> {
  const batch: SettlementBatchItem[] = [];
  
  // Get lending pool wallet for leveraged settlements
  const lendingPoolWallet = lendingService.getLendingWalletPubkey()?.toBase58() || null;
  
  // Pre-fetch all margin accounts for these positions
  const positionIds = openPositions.map(p => p.id);
  // FIX L5: Query ALL margin accounts (both OPEN and CLOSED) to detect manually closed positions
  const marginAccountsList = positionIds.length > 0 
    ? await db
        .select()
        .from(marginAccounts)
        .where(inArray(marginAccounts.positionId, positionIds))
    : [];
  const marginAccountMap = new Map(marginAccountsList.map(ma => [ma.positionId, ma]));
  
  for (const position of openPositions) {
    // Skip already settled/pending positions
    const existing = settlementMap.get(position.id);
    if (existing) {
      if (existing.txStatus === 'CONFIRMED' || existing.txStatus === 'PENDING') {
        continue;
      }
    }
    
    const yesShares = parseFloat(position.yesShares || '0');
    const noShares = parseFloat(position.noShares || '0');
    const totalCost = parseFloat(position.totalCost || '0');
    
    const winningShares = outcome === 'YES' ? yesShares : noShares;
    const payout = winningShares * 1.0;
    
    // Note: profit calculation uses position.totalCost which may be inaccurate for MM
    // due to position tracking issues. MM metrics are tracked separately via mm_market_metrics table.
    const profit = payout - totalCost;
    
    const userWallet = position.userId ? walletMap.get(position.userId) || null : null;
    
    // Check if this is a leveraged position
    const marginAccount = marginAccountMap.get(position.id);
    
    // FIX L5: Skip positions with CLOSED margin accounts - they were manually closed
    // The on-chain position was already settled via execute_close
    if (marginAccount && marginAccount.status === 'CLOSED') {
      logger.info(`Skipping position ${position.id} - margin account ${marginAccount.id} already CLOSED (manual close)`);
      // Mark position as settled in DB if not already
      if (position.status === 'OPEN') {
        await db
          .update(positions)
          .set({
            status: 'SETTLED',
            payout: '0', // Payout was handled during manual close
            settledAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(positions.id, position.id));
      }
      continue;
    }
    
    const isLeveraged = !!marginAccount && marginAccount.status === 'OPEN';
    const loanAmount = marginAccount ? parseFloat(marginAccount.loanAmount) : 0;
    
    // For leveraged positions:
    // - On-chain settlement goes to Lending Pool (which owns the position on-chain)
    // - User payout = payout - loan repayment
    // For regular positions:
    // - On-chain settlement goes to user wallet
    const settlementWallet = isLeveraged ? lendingPoolWallet : userWallet;
    const userPayout = isLeveraged ? Math.max(0, payout - loanAmount) : payout;
    
    if (isLeveraged) {
      logger.info(`Leveraged settlement: position ${position.id}, payout $${payout.toFixed(2)}, loan $${loanAmount.toFixed(2)}, user receives $${userPayout.toFixed(2)}`);
    }
    
    // Create settlement record (PENDING)
    const [settlement] = await db
      .insert(settlements)
      .values({
        positionId: position.id,
        userId: position.userId,
        marketId: position.marketId,
        outcome,
        winningShares: winningShares.toString(),
        payoutAmount: payout.toString(),
        profit: profit.toString(),
        txStatus: 'PENDING',
      })
      .returning();
    
    batch.push({
      position,
      outcome,
      winningShares,
      payout,
      profit,
      userWallet,
      settlementId: settlement.id,
      needsOnChainSettlement: !!settlementWallet, // Use settlement wallet (lending pool or user)
      isLeveraged,
      settlementWallet,
      loanAmount: isLeveraged ? loanAmount : undefined,
      userPayout: isLeveraged ? userPayout : undefined,
    });
  }
  
  return batch;
}

/**
 * Execute batch settlement - all positions in ONE on-chain transaction
 * 
 * For leveraged positions, the Lending Pool wallet receives the payout on-chain,
 * then distributes: loan repayment stays in pool, user's share is transferred.
 * 
 * @param lendingPoolWallet - If provided, also settle Lending Pool's position (for manually closed leveraged positions)
 */
async function executeBatchSettlement(
  batch: SettlementBatchItem[],
  market: typeof markets.$inferSelect,
  lendingPoolWallet: string | null = null
): Promise<string | null> {
  // V2 markets use tokenized shares — no Position PDAs to settle on-chain.
  // Settlement happens via merkle batch settlement (post_merkle_root → batch_settle_v2 → finalize_market_v2).
  // The V1 settle_positions instruction cannot work on V2 MarketV2 accounts.
  // Leave settlement records as PENDING — they'll be confirmed when on-chain settlement completes.
  if (config.useV2) {
    logger.info(`[V2] Market ${market.id} needs merkle settlement (Phase 7) — skipping V1 settle_positions`);
    return null;
  }

  // --- V1 settlement path (Position PDAs) ---

  // Filter positions that need on-chain settlement
  const onChainItems = batch.filter(item => item.needsOnChainSettlement);

  // Build wallets list from batch items
  const wallets = onChainItems.map(item => item.settlementWallet!);

  // Add Lending Pool wallet if it needs to be settled (for manually closed leveraged positions)
  // This ensures the on-chain position account is closed even if the user's DB position was already marked settled
  if (lendingPoolWallet && !wallets.includes(lendingPoolWallet)) {
    wallets.push(lendingPoolWallet);
    logger.info(`[Settlement] Adding Lending Pool ${lendingPoolWallet.slice(0,8)} to settlement batch (cleanup for manually closed positions)`);
  }

  if (wallets.length === 0) {
    logger.info(`No on-chain settlements needed for market ${market.id}`);
    return null;
  }

  // Separate regular and leveraged settlements
  const regularItems = onChainItems.filter(item => !item.isLeveraged);
  const leveragedItems = onChainItems.filter(item => item.isLeveraged);

  const lendingPoolIncluded = lendingPoolWallet && wallets.includes(lendingPoolWallet);
  logger.info(`Executing batch settlement: ${regularItems.length} regular + ${leveragedItems.length} leveraged positions${lendingPoolIncluded ? ' + Lending Pool cleanup' : ''}`);

  try {
    // Execute batch settlement (all in one transaction)
    const signature = await anchorClient.settlePositionsBatch({
      marketPubkey: market.pubkey,
      userWallets: wallets,
    });

    logger.info(`Batch settlement executed: ${signature} (${onChainItems.length} positions)`);

    // Mark all as confirmed
    const settlementIds = onChainItems.map(item => item.settlementId);
    await db
      .update(settlements)
      .set({
        txSignature: signature,
        txStatus: 'CONFIRMED',
        confirmedAt: new Date(),
      })
      .where(inArray(settlements.id, settlementIds));

    return signature;
  } catch (err: any) {
    const errorMsg = err.message || '';

    // If batch fails, try individual settlements so one bad position doesn't kill the batch
    logger.warn(`Batch settlement failed, attempting individual settlements: ${errorMsg}`);

    let successCount = 0;
    let failCount = 0;

    for (const item of onChainItems) {
      try {
        const signature = await anchorClient.settlePositionsBatch({
          marketPubkey: market.pubkey,
          userWallets: [item.settlementWallet!],
        });

        // Mark as confirmed
        await db
          .update(settlements)
          .set({
            txSignature: signature,
            txStatus: 'CONFIRMED',
            confirmedAt: new Date(),
          })
          .where(eq(settlements.id, item.settlementId));

        successCount++;
        logger.info(`Individual settlement success for position ${item.position.id}: ${signature}`);
      } catch (individualErr: any) {
        const individualMsg = individualErr.message || '';

        // Check if position doesn't exist on-chain (already closed)
        if (individualMsg.includes('AccountNotInitialized') || individualMsg.includes('0xbc4')) {
          logger.warn(`Position ${item.position.id} not found on-chain - may have been manually closed`);

          // Mark position as settled (it was likely closed via execute_close)
          await db
            .update(positions)
            .set({
              status: 'SETTLED',
              payout: '0',
              settledAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(positions.id, item.position.id));

          // Mark settlement as confirmed (no payout needed - already handled)
          await db
            .update(settlements)
            .set({
              txStatus: 'CONFIRMED',
              confirmedAt: new Date(),
            })
            .where(eq(settlements.id, item.settlementId));

          successCount++;
        } else {
          // Mark as failed
          await db
            .update(settlements)
            .set({ txStatus: 'FAILED' })
            .where(eq(settlements.id, item.settlementId));

          failCount++;
          logger.error(`Individual settlement failed for position ${item.position.id}: ${individualMsg}`);
        }
      }
    }

    // Also try to settle Lending Pool individually if it was in the batch
    if (lendingPoolWallet && !onChainItems.some(item => item.settlementWallet === lendingPoolWallet)) {
      try {
        const lpSignature = await anchorClient.settlePositionsBatch({
          marketPubkey: market.pubkey,
          userWallets: [lendingPoolWallet],
        });
        successCount++;
        logger.info(`Lending Pool settlement success: ${lpSignature}`);
      } catch (lpErr: any) {
        const lpMsg = lpErr.message || '';
        if (lpMsg.includes('AccountNotInitialized') || lpMsg.includes('0xbc4')) {
          logger.info(`Lending Pool position not found on-chain - may not have been created or already settled`);
          successCount++;
        } else {
          failCount++;
          logger.error(`Lending Pool settlement failed: ${lpMsg}`);
        }
      }
    }

    logger.info(`Individual settlement results: ${successCount} success, ${failCount} failed`);

    // If all positions failed, market might not exist
    if (successCount === 0 && failCount === onChainItems.length) {
      if (errorMsg.includes('AccountNotInitialized') || errorMsg.includes('0xbc4')) {
        logger.warn(`Market ${market.pubkey} does not exist on-chain. Marking as archived.`);
        await marketService.markArchived(market.id);
      }
    }

    return null;
  }
}

/**
 * Finalize settlement - update position status, notify user, log
 * 
 * For leveraged positions:
 * - On-chain settlement went to Lending Pool
 * - positionService.settlePosition handles loan repayment in DB
 * - User receives: payout - loanAmount (transferred from Lending Pool to User)
 */
async function finalizeSettlement(
  item: SettlementBatchItem,
  market: typeof markets.$inferSelect
): Promise<void> {
  // Check if on-chain succeeded (or no on-chain needed)
  const settlement = await db
    .select()
    .from(settlements)
    .where(eq(settlements.id, item.settlementId))
    .limit(1);
  
  const txStatus = settlement[0]?.txStatus;
  const txSignature = settlement[0]?.txSignature;
  
  // Only finalize if confirmed or no on-chain needed
  if (txStatus === 'CONFIRMED' || !item.needsOnChainSettlement) {
    // positionService.settlePosition handles:
    // - Marking position as SETTLED
    // - Repaying loan (if leveraged)
    // - Closing margin account (if leveraged)
    await positionService.settlePosition(item.position.id, item.payout);
    
    // For leveraged positions: transfer user's share from Lending Pool
    if (item.isLeveraged && item.loanAmount !== undefined && item.userPayout !== undefined && item.userWallet) {
      logger.info(`Leveraged settlement: position ${item.position.id}, gross payout $${item.payout.toFixed(2)}, loan repaid $${item.loanAmount.toFixed(2)}, user net $${item.userPayout.toFixed(2)}`);
      
      // Transfer user's share (payout - loan) from Lending Pool to User
      if (item.userPayout > 0) {
        const transferSig = await lendingService.transferToUser(item.userWallet, item.userPayout);
        if (transferSig) {
          logger.info(`✅ Transferred $${item.userPayout.toFixed(2)} to user ${item.userWallet.slice(0, 8)}: ${transferSig}`);
        } else {
          logger.error(`❌ Failed to transfer $${item.userPayout.toFixed(2)} to user ${item.userWallet.slice(0, 8)}`);
        }
      }
    }
    
    // Notify user via WebSocket
    // For leveraged positions, show what user actually receives (after loan repayment)
    if (item.position.userId) {
      broadcastUserSettlement(item.position.userId, {
        marketId: market.id,
        outcome: item.outcome,
        size: item.winningShares,
        payout: item.isLeveraged ? (item.userPayout || 0) : item.payout,
      });
    }
    
    // Log position settlement
    logEvents.positionSettled({
      positionId: item.position.id,
      userId: item.position.userId || '',
      marketId: item.position.marketId || '',
      asset: market.asset,
      timeframe: market.timeframe,
      outcome: item.outcome,
      winningShares: item.winningShares,
      payout: item.isLeveraged ? (item.userPayout || 0) : item.payout,
      profit: item.profit,
    });
  } else {
    logger.warn(`Position ${item.position.id} not finalized - on-chain failed`);
  }
}

/**
 * Calculate and store MM metrics for a settled market
 * 
 * Uses zero-sum principle but ONLY for users who traded with MM:
 * MM P&L = -(sum of profits from users who were MM's counterparty)
 * 
 * This excludes user-to-user trades (e.g., User A's limit order filled by User B)
 */
async function calculateAndStoreMmMetrics(
  marketId: string,
  outcome: 'YES' | 'NO'
): Promise<void> {
  try {
    const mmUserId = mmBotV2.getUserId();
    if (!mmUserId) {
      logger.warn(`[MM Metrics] MM user ID not available, skipping metrics for market ${marketId}`);
      return;
    }

    // Get MM's position for this market
    const mmPosition = await db
      .select()
      .from(positions)
      .where(and(
        eq(positions.marketId, marketId),
        eq(positions.userId, mmUserId)
      ))
      .limit(1);

    const yesShares = parseFloat(mmPosition[0]?.yesShares || '0');
    const noShares = parseFloat(mmPosition[0]?.noShares || '0');

    // Find all users who traded WITH MM (MM was their counterparty)
    // These are users where MM was either maker or taker in a trade
    const mmTrades = await db
      .select({
        makerUserId: trades.makerUserId,
        takerUserId: trades.takerUserId,
        takerNotional: trades.takerNotional,
      })
      .from(trades)
      .where(and(
        eq(trades.marketId, marketId),
        sql`(${trades.makerUserId} = ${mmUserId} OR ${trades.takerUserId} = ${mmUserId})`
      ));

    // Collect unique counterparty user IDs (users who traded with MM)
    const mmCounterpartyIds = new Set<string>();
    let mmTradeCount = 0;
    let mmVolume = 0;

    for (const trade of mmTrades) {
      mmTradeCount++;
      mmVolume += parseFloat(trade.takerNotional || '0');
      
      // The counterparty is the other side of the trade
      if (trade.makerUserId === mmUserId && trade.takerUserId) {
        mmCounterpartyIds.add(trade.takerUserId);
      } else if (trade.takerUserId === mmUserId && trade.makerUserId) {
        mmCounterpartyIds.add(trade.makerUserId);
      }
    }

    // Get settlements ONLY for users who traded with MM
    let mmPnl = 0;
    if (mmCounterpartyIds.size > 0) {
      const counterpartySettlements = await db
        .select({
          profit: settlements.profit,
        })
        .from(settlements)
        .where(and(
          eq(settlements.marketId, marketId),
          inArray(settlements.userId, Array.from(mmCounterpartyIds))
        ));

      // Sum counterparty profits
      const totalCounterpartyProfit = counterpartySettlements.reduce(
        (sum, s) => sum + parseFloat(s.profit || '0'),
        0
      );

      // MM P&L = negative of counterparty P&L (zero-sum for MM's trades only)
      mmPnl = -totalCounterpartyProfit;
    }

    // Insert MM metrics
    await db.insert(mmMarketMetrics).values({
      marketId,
      yesShares: yesShares.toString(),
      noShares: noShares.toString(),
      totalPnl: mmPnl.toString(),
      tradesCount: mmTradeCount,
      volumeTraded: mmVolume.toString(),
      outcome,
      settledAt: new Date(),
    });

    logger.info(
      `[MM Metrics] Market ${marketId.slice(0, 8)}: P&L=$${mmPnl.toFixed(2)}, ` +
      `YES=${yesShares.toFixed(2)}, NO=${noShares.toFixed(2)}, ` +
      `trades=${mmTradeCount}, volume=$${mmVolume.toFixed(2)}, ` +
      `counterparties=${mmCounterpartyIds.size}`
    );
  } catch (err: any) {
    logger.error(`[MM Metrics] Failed to calculate metrics for market ${marketId}: ${err.message}`);
  }
}
