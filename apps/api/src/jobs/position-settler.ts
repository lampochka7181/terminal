import { eq, and, inArray } from 'drizzle-orm';
import { db, markets, positions, settlements, users, marginAccounts } from '../db/index.js';
import { positionService } from '../services/position.service.js';
import { marketService } from '../services/market.service.js';
import { transactionService } from '../services/transaction.service.js';
import { userService } from '../services/user.service.js';
import { lendingService } from '../services/lending.service.js';
import { logger, positionLogger, marketLogger, logEvents } from '../lib/logger.js';
import { broadcastUserSettlement } from '../lib/broadcasts.js';
import { anchorClient } from '../lib/anchor-client.js';

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
  
  // BATCH SETTLEMENT: Build all settlement data first, then execute in one transaction
  const settlementBatch = await prepareSettlementBatch(openPositions, outcome, market, walletMap, settlementMap);
  
  if (settlementBatch.length > 0) {
    // Execute all on-chain settlements in a single transaction
    await executeBatchSettlement(settlementBatch, market);
  }
  
  // Process DB updates and notifications for all positions
  await Promise.all(
    settlementBatch.map(item => finalizeSettlement(item, market))
  );

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

    // Immediately recover on-chain market/vault rent after settlement (no 5m delay).
    // This is safe because `settle_positions` should have paid out all positions and
    // the program's `close_market` sweeps any leftover dust before closing the vault.
    //
    // We keep the Market Closer job as a fallback in case this fails (RPC issues, etc.).
    if (anchorClient.isReady() && !market.pubkey.startsWith('arc-')) {
      try {
        const sig = await anchorClient.closeMarket({ marketPubkey: market.pubkey });
        logger.info(`🧹 Market rent recovered immediately after settlement: ${sig}`);
        await marketService.markArchived(market.id);
      } catch (err: any) {
        const msg = err?.message || String(err);
        logger.warn(`Market ${market.id} close_market failed post-settlement (will retry via Market Closer): ${msg}`);
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
  const marginAccountsList = positionIds.length > 0 
    ? await db
        .select()
        .from(marginAccounts)
        .where(and(
          inArray(marginAccounts.positionId, positionIds),
          eq(marginAccounts.status, 'OPEN')
        ))
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
    const profit = payout - totalCost;
    const userWallet = position.userId ? walletMap.get(position.userId) || null : null;
    
    // Check if this is a leveraged position
    const marginAccount = marginAccountMap.get(position.id);
    const isLeveraged = !!marginAccount;
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
 */
async function executeBatchSettlement(
  batch: SettlementBatchItem[],
  market: typeof markets.$inferSelect
): Promise<string | null> {
  // Filter positions that need on-chain settlement
  const onChainItems = batch.filter(item => item.needsOnChainSettlement);
  
  if (onChainItems.length === 0) {
    logger.info(`No on-chain settlements needed for market ${market.id}`);
    return null;
  }
  
  // Separate regular and leveraged settlements
  const regularItems = onChainItems.filter(item => !item.isLeveraged);
  const leveragedItems = onChainItems.filter(item => item.isLeveraged);
  
  logger.info(`Executing batch settlement: ${regularItems.length} regular + ${leveragedItems.length} leveraged positions`);
  
  try {
    // Build all settle instructions
    // Use settlementWallet which is:
    // - User wallet for regular positions
    // - Lending Pool wallet for leveraged positions
    const wallets = onChainItems.map(item => item.settlementWallet!);
    
    // Execute batch settlement (all in one transaction)
    const signature = await anchorClient.settlePositionsBatch({
      marketPubkey: market.pubkey,
      userWallets: wallets,
    });
    
    logger.info(`✅ Batch settlement executed: ${signature} (${onChainItems.length} positions)`);
    
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
    if (errorMsg.includes('AccountNotInitialized') || errorMsg.includes('0xbc4')) {
      logger.warn(`Market ${market.pubkey} does not exist on-chain. Marking as archived.`);
      await marketService.markArchived(market.id);
    }
    
    logger.error(`❌ Batch settlement failed: ${errorMsg}`);
    
    // Mark all as failed
    const settlementIds = onChainItems.map(item => item.settlementId);
    await db
      .update(settlements)
      .set({ txStatus: 'FAILED' })
      .where(inArray(settlements.id, settlementIds));
    
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


