import { eq, and, inArray, sql } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import { db, markets, positions, settlements, users } from '../db/index.js';
import { positionService } from '../services/position.service.js';
import { marketService } from '../services/market.service.js';
import { anchorClient, getYesMintPda, getNoMintPda } from '../lib/anchor-client.js';
import { syncMarketStatusFromChain } from '../lib/chain-sync.js';
import { buildMerkleTree, createSettlementLeaf, verifyMerkleProof, type SettlementLeaf, type MerkleTree } from '../lib/merkle-tree.js';
import { broadcastUserSettlement } from '../lib/broadcasts.js';
import { onchainSubmitQueue } from '../queue/queues.js';
import { logger, logEvents } from '../lib/logger.js';
import { config } from '../config.js';

/**
 * Merkle Settler Job (V2 — Parallel via BullMQ + Relayer Pool)
 *
 * Settlement pipeline:
 *   1. Snapshot winners from DB
 *   2. Build merkle tree
 *   3. Post merkle root on-chain (RESOLVED → SETTLING)
 *   4. Create settlement_jobs rows (one per batch of 15 recipients)
 *   5. Enqueue each batch to BullMQ onchain-submit queue
 *   6. Wait for all batches to complete (checked each cycle)
 *   7. Burn remaining share tokens (PermanentDelegate) → supply = 0
 *   8. Finalize market on-chain (SETTLING → SETTLED, close mints + vault + PDA)
 *   9. Sync DB
 *
 * With 5 relayers, a market with 100 positions (7 batches of 15)
 * settles in ~2 rounds instead of 7 sequential transactions.
 */

// Concurrency guard — one market at a time
const processingMarkets = new Set<string>();

// Track consecutive failures per market to avoid infinite retry loops
const marketFailureCount = new Map<string, number>();
const MAX_SETTLEMENT_FAILURES = 10; // After 10 failed cycles, mark as SETTLEMENT_FAILED

// In-memory state for markets being settled
interface SettlingState {
  leaves: Array<{ recipient: InstanceType<typeof PublicKey>; amount: bigint; positionId: string; userId: string | null }>;
  tree: MerkleTree;
  totalAmount: bigint;
  batchesCreated: boolean;
  totalBatches: number;
  batchSignatures: string[];
  rootPosted?: boolean; // Set by combined resolve+postMerkleRoot to skip redundant postMerkleRoot call
}
const settlingState = new Map<string, SettlingState>();

export async function merkleSettlerJob(): Promise<void> {
  if (!config.useV2 || !anchorClient.isReady()) {
    return;
  }

  const resolvedMarkets = await db
    .select()
    .from(markets)
    .where(eq(markets.status, 'RESOLVED'));

  for (const market of resolvedMarkets) {
    if (processingMarkets.has(market.id)) continue;

    const hasTrades = parseFloat(market.totalVolume || '0') > 0;
    if (!hasTrades) {
      // Zero-trade markets: skip merkle settlement, mark as SETTLED so market-closer
      // picks them up and closes on-chain accounts to recover rent (~0.009 SOL each)
      logger.info(`[MerkleSettler] Marking zero-trade market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) as SETTLED for cleanup`);
      await marketService.markSettled(market.id);
      continue;
    }

    processingMarkets.add(market.id);
    try {
      await processMarketSettlement(market);
    } catch (err: any) {
      logger.error(`[MerkleSettler] Failed for market ${market.id} (${market.asset}-${market.timeframe}): ${err.message}`);
    } finally {
      processingMarkets.delete(market.id);
    }
  }
}

/**
 * Pre-seed the settling state from already-fetched settlement data.
 * Called from market-resolver DURING the resolve TX (parallel prep) so the
 * merkle tree is ready the instant the resolve TX confirms — saves ~300ms
 * of DB queries that buildSettlementState would otherwise do.
 */
export function preSeedSettlingState(
  marketId: string,
  outcome: 'YES' | 'NO',
  positions: Array<{ id: string; userId: string | null; yesShares: string | null; noShares: string | null }>,
  walletMap: Map<string, string | null>,
): boolean {
  if (settlingState.has(marketId)) return false;

  const leaves: SettlingState['leaves'] = [];
  for (const position of positions) {
    const yesShares = parseFloat(position.yesShares || '0');
    const noShares = parseFloat(position.noShares || '0');
    const winningShares = outcome === 'YES' ? yesShares : noShares;
    if (winningShares <= 0) continue;

    const wallet = position.userId ? walletMap.get(position.userId) : null;
    if (!wallet) continue;

    const amount = BigInt(Math.round(winningShares * 1_000_000));
    leaves.push({ recipient: new PublicKey(wallet), amount, positionId: position.id, userId: position.userId });
  }

  if (leaves.length === 0) return false;

  const treeLeaves: SettlementLeaf[] = leaves.map(l => ({ recipient: l.recipient, amount: l.amount }));
  const tree = buildMerkleTree(treeLeaves);
  const totalAmount = leaves.reduce((sum, l) => sum + l.amount, 0n);

  settlingState.set(marketId, { leaves, tree, totalAmount, batchesCreated: false, totalBatches: 0, batchSignatures: [] });
  logger.info(`[MerkleSettler] Pre-seeded merkle tree: ${leaves.length} leaves, totalAmount=${totalAmount}, root=${Buffer.from(tree.root).toString('hex').slice(0, 16)}...`);
  return true;
}

/**
 * Get the pre-seeded merkle tree info for the combined resolve+postMerkleRoot instruction.
 * Returns null if no state is pre-seeded for this market.
 */
export function getPreSeededMerkleData(marketId: string): {
  merkleRoot: Uint8Array;
  totalAmount: bigint;
  totalSettlements: number;
} | null {
  const state = settlingState.get(marketId);
  if (!state) return null;
  return {
    merkleRoot: state.tree.root,
    totalAmount: state.totalAmount,
    totalSettlements: state.leaves.length,
  };
}

/**
 * Mark that the merkle root was already posted on-chain (via combined instruction).
 * processMarketSettlement will skip the separate postMerkleRoot call.
 */
export function markRootPosted(marketId: string): void {
  const state = settlingState.get(marketId);
  if (state) {
    state.rootPosted = true;
  }
}

/**
 * Direct trigger for merkle settlement — called from market-resolver and
 * onchain-submit worker to eliminate polling gaps.
 * Safe to call multiple times: idempotent pipeline + processingMarkets guard.
 *
 * @param marketId    Market UUID
 * @param marketObj   Optional pre-fetched market row (avoids a DB round-trip when caller already has it)
 */
export async function triggerMerkleSettlement(
  marketId: string,
  marketObj?: typeof markets.$inferSelect,
): Promise<void> {
  if (!config.useV2 || !anchorClient.isReady()) return;
  if (processingMarkets.has(marketId)) return;

  const market = marketObj ?? (await db.select().from(markets).where(eq(markets.id, marketId)).limit(1))[0];
  if (!market || market.status !== 'RESOLVED') return;
  if (parseFloat(market.totalVolume || '0') <= 0) {
    // Zero-trade market: mark as SETTLED for cleanup
    logger.info(`[MerkleSettler] Marking zero-trade market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) as SETTLED for cleanup`);
    await marketService.markSettled(market.id);
    return;
  }

  processingMarkets.add(marketId);
  try {
    await processMarketSettlement(market);
  } catch (err: any) {
    logger.error(`[MerkleSettler] Triggered settlement failed for ${marketId}: ${err.message}`);
  } finally {
    processingMarkets.delete(marketId);
  }
}

async function processMarketSettlement(market: typeof markets.$inferSelect): Promise<void> {
  const marketId = market.id;
  const marketPubkey = market.pubkey;
  const outcome = market.outcome as 'YES' | 'NO';

  if (!outcome || (outcome !== 'YES' && outcome !== 'NO')) {
    logger.warn(`[MerkleSettler] Market ${marketId} has no valid outcome, skipping`);
    return;
  }

  const settlementStartMs = Date.now();
  logger.info(`[MerkleSettler] Processing market ${marketId} (${market.asset}-${market.timeframe}), outcome=${outcome}`);

  // Step 1: Build settlement state
  let state = settlingState.get(marketId);
  if (!state) {
    const built = await buildSettlementState(market, outcome);
    if (!built) {
      await marketService.markSettled(marketId);
      logEvents.marketSettled({
        marketId, asset: market.asset, timeframe: market.timeframe,
        positionsSettled: 0, totalPayout: 0,
      });
      return;
    }
    state = built;
    settlingState.set(marketId, state);
  }

  // Step 2: Post merkle root on-chain (skip if combined resolve+post already did it)
  if (state.rootPosted) {
    logger.info(`[MerkleSettler] Merkle root already posted via combined instruction for ${market.asset}-${market.timeframe}, skipping to batch creation`);
    marketFailureCount.delete(marketId);
  } else try {
    const sig = await anchorClient.postMerkleRoot({
      marketPubkey,
      merkleRoot: state.tree.root,
      totalAmount: state.totalAmount,
      totalSettlements: state.leaves.length,
    });
    logger.info(`[MerkleSettler] Merkle root posted for ${market.asset}-${market.timeframe}: ${sig}`);
    marketFailureCount.delete(marketId);
    // Skip syncMarketStatusFromChain — the TX just confirmed so we know the
    // on-chain state is SETTLING. DB stays RESOLVED until finalize. (~300ms saved)
  } catch (err: any) {
    const msg = err.message || '';
    if (msg.includes('MerkleRootAlreadySet') || msg.includes('already in use') || msg.includes('MarketNotSettling')) {
      logger.debug(`[MerkleSettler] Merkle root already posted for ${marketId}, continuing`);
      marketFailureCount.delete(marketId);
    } else if (msg.includes('MarketNotResolved') || msg.includes('0x177a')) {
      // Market is NOT resolved on-chain yet — can't post merkle root.
      // This is NOT the same as "already posted". Track failures and give up after max retries.
      const count = (marketFailureCount.get(marketId) || 0) + 1;
      marketFailureCount.set(marketId, count);
      if (count >= MAX_SETTLEMENT_FAILURES) {
        logger.error(`[MerkleSettler] Market ${marketId} (${market.asset}-${market.timeframe}) not resolved on-chain after ${count} attempts — marking as SETTLEMENT_FAILED`);
        await marketService.markSettlementFailed(marketId);
        settlingState.delete(marketId);
        marketFailureCount.delete(marketId);
      } else {
        logger.warn(`[MerkleSettler] Market ${marketId} not resolved on-chain (attempt ${count}/${MAX_SETTLEMENT_FAILURES}), will retry next cycle`);
      }
      return; // Don't continue to batch settlement — market isn't ready
    } else if (msg.includes('InvalidSettlementAmount') || msg.includes('0x17a9')) {
      // Vault has insufficient funds — on-chain match likely never executed.
      logger.error(`[MerkleSettler] SETTLEMENT FAILED for market ${marketId} (${market.asset}-${market.timeframe}): settlement amount exceeds on-chain open interest. Vault likely unfunded — on-chain match may have failed. Marking as SETTLEMENT_FAILED.`);
      await marketService.markSettlementFailed(marketId);
      settlingState.delete(marketId);
      marketFailureCount.delete(marketId);
      return;
    } else {
      throw err;
    }
  }

  // Step 3: Create settlement_jobs and enqueue to BullMQ (parallel!)
  const proofDepth = Math.ceil(Math.log2(Math.max(state.leaves.length, 2)));
  const entrySize = 52 + proofDepth * 32;  // Borsh data per entry: pubkey(32) + amount(8) + index(8) + proof_len(4) + proofs
  // Solana TX limit is 1232 bytes. Must account for TOTAL TX size, not just instruction data:
  //   Fixed overhead (~400 bytes): signature(64), header(3), blockhash(32), 8 fixed account keys(256),
  //     instruction framing, compact-u16 lengths, discriminator(8), vec_len(4)
  //   Per entry (~80 bytes beyond instruction data): 2 account keys (recipient + ATA = 64 bytes),
  //     createAssociatedTokenAccountIdempotent ix overhead (~16 bytes)
  const TX_LIMIT = 1232;
  const FIXED_OVERHEAD = 400;
  const PER_ENTRY_ACCOUNTS_OVERHEAD = 80;
  const effectiveEntrySize = entrySize + PER_ENTRY_ACCOUNTS_OVERHEAD;
  const batchSize = Math.min(15, Math.max(1, Math.floor((TX_LIMIT - FIXED_OVERHEAD) / effectiveEntrySize)));
  const totalBatches = Math.ceil(state.leaves.length / batchSize);
  state.totalBatches = totalBatches;

  if (!state.batchesCreated) {
    logger.info(`[MerkleSettler] Creating ${totalBatches} settlement batches for parallel execution`);

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const start = batchIdx * batchSize;
      const end = Math.min(start + batchSize, state.leaves.length);
      const batchLeaves = state.leaves.slice(start, end);

      const batchSettlements = batchLeaves.map((leaf, i) => {
        const leafIndex = start + i;
        const proof = state!.tree.getProof(leafIndex);

        const leafHash = createSettlementLeaf(leaf.recipient, leaf.amount);
        if (!verifyMerkleProof(proof, state!.tree.root, leafHash, leafIndex)) {
          throw new Error(`[MerkleSettler] Local proof verification failed for leaf ${leafIndex}`);
        }

        return {
          recipient: leaf.recipient.toBase58(),
          amount: leaf.amount.toString(),
          index: leafIndex,
          proof: proof.map(p => Buffer.from(p).toString('hex')),
        };
      });

      // Insert settlement_job row
      await db.execute(sql`
        INSERT INTO settlement_jobs (market_id, batch_index, recipients, amounts, proofs, status)
        VALUES (
          ${marketId}::uuid,
          ${batchIdx},
          ${JSON.stringify(batchSettlements.map(s => s.recipient))}::jsonb,
          ${JSON.stringify(batchSettlements.map(s => s.amount))}::jsonb,
          ${JSON.stringify(batchSettlements.map(s => ({ index: s.index, proof: s.proof })))}::jsonb,
          'PENDING'
        )
        ON CONFLICT (market_id, batch_index) DO NOTHING
      `);

      // Enqueue to BullMQ for parallel execution
      // NOTE: BullMQ serializes via JSON — keep BigInt as string, Buffer as hex.
      // The worker converts them back before calling the on-chain instruction.
      const jobId = `batch-settle-${marketId}-${batchIdx}`;
      await onchainSubmitQueue.add('batch-settle', {
        type: 'batch-settle' as const,
        idempotencyKey: jobId,
        payload: {
          marketPubkey,
          bitmapChunkIndex: 0,
          settlements: batchSettlements.map(s => ({
            recipient: s.recipient,
            amount: s.amount,          // already a string from .toString() above
            index: s.index,
            proof: s.proof,            // already hex strings
          })),
          marketId,
          batchIndex: batchIdx,
        },
      }, { jobId }).catch(err => {
        logger.error(`[MerkleSettler] Failed to enqueue batch ${batchIdx}: ${err.message}`);
      });
    }

    state.batchesCreated = true;
    logger.info(`[MerkleSettler] ${totalBatches} settlement batches enqueued for parallel execution`);
  }

  // Step 4: Check if all batches are completed
  const pendingBatches = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM settlement_jobs
    WHERE market_id = ${marketId}::uuid AND status NOT IN ('COMPLETED')
  `);

  const pendingCount = (pendingBatches.rows?.[0] as any)?.cnt || 0;

  if (pendingCount > 0) {
    // Also check for batches that were settled on-chain but not updated in DB
    // (e.g., if the worker processed them but the DB update failed)
    const submittedBatches = await db.execute(sql`
      SELECT batch_index, tx_signature
      FROM settlement_jobs
      WHERE market_id = ${marketId}::uuid AND status = 'SUBMITTED'
    `);

    for (const row of (submittedBatches.rows || []) as any[]) {
      if (row.tx_signature) {
        // Mark as completed if we have a signature
        await db.execute(sql`
          UPDATE settlement_jobs
          SET status = 'COMPLETED', completed_at = NOW()
          WHERE market_id = ${marketId}::uuid AND batch_index = ${row.batch_index}
        `);
      }
    }

    // Re-check
    const stillPending = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM settlement_jobs
      WHERE market_id = ${marketId}::uuid AND status NOT IN ('COMPLETED')
    `);

    if (((stillPending.rows?.[0] as any)?.cnt || 0) > 0) {
      logger.info(`[MerkleSettler] ${(stillPending.rows?.[0] as any)?.cnt} batches still pending for ${marketId}`);
      return; // Will retry on next cycle
    }
  }

  // Collect batch signatures
  const completedBatches = await db.execute(sql`
    SELECT tx_signature FROM settlement_jobs
    WHERE market_id = ${marketId}::uuid AND status = 'COMPLETED'
    ORDER BY batch_index
  `);
  state.batchSignatures = (completedBatches.rows || []).map((r: any) => r.tx_signature).filter(Boolean);

  logger.info(`[MerkleSettler] All ${totalBatches} batches completed for ${marketId}`);

  // Step 5: Burn remaining share tokens
  const marketPk = new PublicKey(marketPubkey);
  const yesMint = getYesMintPda(marketPk);
  const noMint = getNoMintPda(marketPk);

  try {
    const allPositions = await positionService.getPositionsForSettlement(marketId);
    const userIds = [...new Set(allPositions.map(p => p.userId).filter(Boolean) as string[])];
    const userWallets = userIds.length > 0
      ? await db.select({ id: users.id, walletAddress: users.walletAddress })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];

    const shareAtas: string[] = [];
    for (const user of userWallets) {
      const wallet = new PublicKey(user.walletAddress);
      const yesAta = await getAssociatedTokenAddress(yesMint, wallet, false, TOKEN_2022_PROGRAM_ID);
      const noAta = await getAssociatedTokenAddress(noMint, wallet, false, TOKEN_2022_PROGRAM_ID);
      shareAtas.push(yesAta.toBase58(), noAta.toBase58());
    }

    if (shareAtas.length > 0) {
      const BURN_BATCH_SIZE = 20;
      for (let i = 0; i < shareAtas.length; i += BURN_BATCH_SIZE) {
        const batch = shareAtas.slice(i, i + BURN_BATCH_SIZE);
        try {
          const sig = await anchorClient.burnRemainingSharesV2({
            marketPubkey,
            yesMint: yesMint.toBase58(),
            noMint: noMint.toBase58(),
            userShareAtas: batch,
          });
          logger.info(`[MerkleSettler] Burned shares batch ${Math.floor(i / BURN_BATCH_SIZE) + 1}: ${sig}`);
        } catch (burnErr: any) {
          logger.warn(`[MerkleSettler] Burn batch warning: ${burnErr.message}`);
        }
      }
    }
  } catch (err: any) {
    logger.warn(`[MerkleSettler] Share burn step failed (non-fatal): ${err.message}`);
  }

  // Step 6: Finalize market on-chain
  try {
    const sig = await anchorClient.finalizeMarketV2({
      marketPubkey,
      yesMint: yesMint.toBase58(),
      noMint: noMint.toBase58(),
    });
    logger.info(`[MerkleSettler] Market finalized: ${sig}`);
  } catch (err: any) {
    const msg = err.message || '';
    if (msg.includes('SettlementNotComplete')) {
      logger.warn(`[MerkleSettler] Settlement not yet complete for ${marketId}, will retry`);
      return;
    }
    if (!msg.includes('MarketNotSettling')) {
      throw err;
    }
  }

  // Step 7: Verify on-chain state, then sync DB
  await syncMarketStatusFromChain(marketId, marketPubkey, 'RESOLVED');
  await syncSettlementToDb(market, state, outcome);

  // Cleanup
  settlingState.delete(marketId);

  // Clean up settlement_jobs rows
  await db.execute(sql`
    DELETE FROM settlement_jobs WHERE market_id = ${marketId}::uuid
  `);

  const settlementElapsedMs = Date.now() - settlementStartMs;
  logger.info(`[MerkleSettler] Market ${market.asset}-${market.timeframe} fully settled [${settlementElapsedMs}ms total]`);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function buildSettlementState(
  market: typeof markets.$inferSelect,
  outcome: 'YES' | 'NO',
): Promise<SettlingState | null> {
  const openPositions = await positionService.getPositionsForSettlement(market.id);
  if (openPositions.length === 0) return null;

  const userIds = [...new Set(openPositions.map(p => p.userId).filter(Boolean) as string[])];
  const userWallets = userIds.length > 0
    ? await db.select({ id: users.id, walletAddress: users.walletAddress })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const walletMap = new Map(userWallets.map(u => [u.id, u.walletAddress]));

  const leaves: SettlingState['leaves'] = [];
  for (const position of openPositions) {
    const yesShares = parseFloat(position.yesShares || '0');
    const noShares = parseFloat(position.noShares || '0');
    const winningShares = outcome === 'YES' ? yesShares : noShares;

    if (winningShares <= 0) continue;

    const wallet = position.userId ? walletMap.get(position.userId) : null;
    if (!wallet) {
      logger.warn(`[MerkleSettler] No wallet for user ${position.userId}, position ${position.id}`);
      continue;
    }

    const amount = BigInt(Math.round(winningShares * 1_000_000));
    leaves.push({
      recipient: new PublicKey(wallet),
      amount,
      positionId: position.id,
      userId: position.userId,
    });
  }

  if (leaves.length === 0) return null;

  const treeLeaves: SettlementLeaf[] = leaves.map(l => ({
    recipient: l.recipient,
    amount: l.amount,
  }));
  const tree = buildMerkleTree(treeLeaves);
  const totalAmount = leaves.reduce((sum, l) => sum + l.amount, 0n);

  logger.info(`[MerkleSettler] Built merkle tree: ${leaves.length} leaves, totalAmount=${totalAmount}, root=${Buffer.from(tree.root).toString('hex').slice(0, 16)}...`);

  return {
    leaves,
    tree,
    totalAmount,
    batchesCreated: false,
    totalBatches: 0,
    batchSignatures: [],
  };
}

async function syncSettlementToDb(
  market: typeof markets.$inferSelect,
  state: SettlingState,
  outcome: 'YES' | 'NO',
): Promise<void> {
  const lastSig = state.batchSignatures[state.batchSignatures.length - 1] || null;
  const allPositions = await positionService.getPositionsForSettlement(market.id);

  for (const position of allPositions) {
    const yesShares = parseFloat(position.yesShares || '0');
    const noShares = parseFloat(position.noShares || '0');
    const winningShares = outcome === 'YES' ? yesShares : noShares;
    const payout = winningShares * 1.0;
    const totalCost = parseFloat(position.totalCost || '0');
    const profit = payout - totalCost;

    await db.insert(settlements).values({
      positionId: position.id,
      userId: position.userId,
      marketId: market.id,
      outcome,
      winningShares: winningShares.toString(),
      payoutAmount: payout.toString(),
      profit: profit.toString(),
      txSignature: lastSig,
      txStatus: 'CONFIRMED',
      confirmedAt: new Date(),
    }).onConflictDoNothing();

    await positionService.settlePosition(position.id, payout);

    if (position.userId) {
      broadcastUserSettlement(position.userId, {
        marketId: market.id,
        outcome,
        size: winningShares,
        payout,
      });
    }

    logEvents.positionSettled({
      positionId: position.id,
      userId: position.userId || '',
      marketId: market.id,
      asset: market.asset,
      timeframe: market.timeframe,
      outcome,
      winningShares,
      payout,
      profit,
    });
  }

  await marketService.markSettled(market.id);

  const totalPayout = state.leaves.reduce((sum, l) => sum + Number(l.amount) / 1_000_000, 0);
  logEvents.marketSettled({
    marketId: market.id,
    asset: market.asset,
    timeframe: market.timeframe,
    positionsSettled: allPositions.length,
    totalPayout,
  });

  await marketService.markArchived(market.id);
}
