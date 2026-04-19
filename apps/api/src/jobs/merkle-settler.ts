import { eq, and, inArray, sql } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import { db, markets, settlements, settlementTrees, users } from '../db/index.js';
import { positionService } from '../services/position.service.js';
import { marketService } from '../services/market.service.js';
import { anchorClient, AnchorClient, getYesMintPda, getNoMintPda, fetchMarketV2OnChainState, fetchSettlementBitmap } from '../lib/anchor-client.js';
import { fetchMintHolders } from '../lib/settlement-snapshot.js';
import { syncMarketStatusFromChain } from '../lib/chain-sync.js';
import { buildMerkleTree, createSettlementLeaf, verifyMerkleProof, verifyCompactBridgeProof, type SettlementLeaf, type MerkleTree } from '../lib/merkle-tree.js';
import { broadcastUserSettlement } from '../lib/broadcasts.js';
import { onchainSubmitQueue } from '../queue/queues.js';
import { tryAdvisoryLock, releaseAdvisoryLock } from '../lib/advisory-lock.js';
import { logger, logEvents } from '../lib/logger.js';

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

/**
 * M-05: Convert a decimal string (e.g. "10.500000") to integer microUSDC (bigint)
 * without floating-point intermediate, avoiding precision loss.
 *
 * Examples:
 *   "10.5"      → 10_500_000n
 *   "0.001"     → 1_000n
 *   "100"       → 100_000_000n
 *   "1.123456"  → 1_123_456n
 *   "1.1234567" → 1_123_457n (rounded)
 */
function decimalToMicroUsdc(value: string): bigint {
  const trimmed = value.trim();
  const dotIdx = trimmed.indexOf('.');
  if (dotIdx === -1) {
    // No decimal point — whole number
    return BigInt(trimmed) * 1_000_000n;
  }
  const intPart = trimmed.slice(0, dotIdx) || '0';
  let fracPart = trimmed.slice(dotIdx + 1);
  if (fracPart.length > 7) {
    // Take 7 digits for rounding, then truncate to 6
    const seventh = parseInt(fracPart[6], 10);
    fracPart = fracPart.slice(0, 6);
    let micro = BigInt(intPart) * 1_000_000n + BigInt(fracPart);
    if (seventh >= 5) micro += 1n;
    return micro;
  }
  // Pad to 6 decimals
  fracPart = fracPart.padEnd(6, '0');
  return BigInt(intPart) * 1_000_000n + BigInt(fracPart);
}

// In-memory state for markets being settled
interface SettlingState {
  leaves: Array<{ recipient: InstanceType<typeof PublicKey>; amount: bigint; positionId: string; userId: string | null }>;
  tree: MerkleTree;
  totalAmount: bigint;
  batchesCreated: boolean;
  totalBatches: number;
  batchSignatures: string[];
  rootPosted?: boolean; // Set by combined resolve+postMerkleRoot to skip redundant postMerkleRoot call
  /**
   * Address Lookup Table for batch settle versioned TXs. Set after the ALT
   * is created and observable on-chain; absent for small markets that take
   * the legacy TX path. Threaded into every batch job's payload so the
   * onchain-submit worker can build a versioned TX referencing it.
   */
  lookupTablePubkey?: string;
}
const settlingState = new Map<string, SettlingState>();

export async function merkleSettlerJob(): Promise<void> {
  if (!anchorClient.isReady()) {
    return;
  }

  const resolvedMarkets = await db
    .select()
    .from(markets)
    .where(eq(markets.status, 'RESOLVED'));

  for (const market of resolvedMarkets) {
    if (processingMarkets.has(market.id)) continue;

    const hasDbVolume = parseFloat(market.totalVolume || '0') > 0;
    const hasPreSeededState = settlingState.has(market.id);
    if (!hasDbVolume && !hasPreSeededState) {
      // Zero-trade markets: skip merkle settlement, mark as SETTLED so market-closer
      // picks them up and closes on-chain accounts to recover rent (~0.009 SOL each)
      logger.info(`[MerkleSettler] Marking zero-trade market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) as SETTLED for cleanup`);
      await marketService.markSettled(market.id);
      continue;
    }

    // SYNCHRONOUS add — close the TOCTOU race window before any await.
    // Previously, `add()` was after `await tryAdvisoryLock()`, allowing multiple
    // concurrent calls to pass the `has()` check before any reached `add()`.
    processingMarkets.add(market.id);
    try {
      // M-04: Acquire DB advisory lock (multi-instance safe)
      const lockAcquired = await tryAdvisoryLock('settle', market.id);
      if (!lockAcquired) continue; // Another instance is settling this market (finally still runs)
      try {
        await processMarketSettlement(market);
      } catch (err: any) {
        logger.error(`[MerkleSettler] Failed for market ${market.id} (${market.asset}-${market.timeframe}): ${err.message}`);
      } finally {
        await releaseAdvisoryLock('settle', market.id);
      }
    } finally {
      processingMarkets.delete(market.id);
    }
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
  if (!anchorClient.isReady()) return;
  if (processingMarkets.has(marketId)) return;

  // SYNCHRONOUS add — close the TOCTOU race window before any await.
  // Previously, `add()` was after `await tryAdvisoryLock()`, allowing the
  // worker completion callback + periodic merkleSettlerJob to both pass `has()`
  // before either reached `add()`, causing duplicate settlement pipeline runs.
  processingMarkets.add(marketId);

  try {
    // Always fetch fresh from DB for the totalVolume check — the passed marketObj
    // may have stale totalVolume=0 from getById cache (30s TTL). This caused markets
    // with actual trades to be incorrectly marked as "zero-trade" and skip settlement.
    const market = (await db.select().from(markets).where(eq(markets.id, marketId)).limit(1))[0];
    if (!market || market.status !== 'RESOLVED') return;

    // Check both DB totalVolume AND pre-seeded settling state (defense-in-depth).
    // The settling state is pre-built from positions during resolve, so it's reliable
    // even if totalVolume hasn't been flushed to DB yet (write-behind race).
    const hasDbVolume = parseFloat(market.totalVolume || '0') > 0;
    const hasPreSeededState = settlingState.has(marketId);
    if (!hasDbVolume && !hasPreSeededState) {
      // Truly zero-trade market: mark as SETTLED for cleanup
      logger.info(`[MerkleSettler] Marking zero-trade market ${market.asset}-${market.timeframe} (${market.pubkey.slice(0, 8)}) as SETTLED for cleanup`);
      await marketService.markSettled(market.id);
      return;
    }

    // M-04: Acquire DB advisory lock (multi-instance safe)
    const lockAcquired = await tryAdvisoryLock('settle', marketId);
    if (!lockAcquired) return;
    try {
      await processMarketSettlement(market);
    } catch (err: any) {
      logger.error(`[MerkleSettler] Triggered settlement failed for ${marketId}: ${err.message}`);
    } finally {
      await releaseAdvisoryLock('settle', marketId);
    }
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

  // ─────────────────────────────────────────────────────────────────────────
  // ROUTER: post-root vs pre-root.
  //
  // Once the merkle root is on-chain, the tree is immutable. Any rebuild from
  // current DB state will produce a *different* tree whose leaves won't hash
  // into the posted root (see: partial-settlement drift incident 2026-04-17).
  //
  // If has_merkle_root on-chain, load the authoritative tree from
  // settlement_trees and skip drift + postMerkleRoot. The downstream batch
  // enqueue logic filters against the on-chain bitmap so already-claimed
  // leaves aren't re-submitted.
  //
  // If has_merkle_root on-chain AND no persisted tree exists, we've lost the
  // authoritative state — escalate to SETTLEMENT_FAILED instead of silently
  // rebuilding from current mutable DB state.
  // ─────────────────────────────────────────────────────────────────────────
  let claimedLeafIndices: Set<number> | null = null;
  let state: SettlingState | undefined;
  try {
    const chain = await fetchMarketV2OnChainState(
      anchorClient.getConnection(),
      new PublicKey(marketPubkey),
    );
    if (chain?.hasMerkleRoot) {
      state = settlingState.get(marketId);
      if (!state) {
        const loaded = await loadSettlementTree(marketId);
        if (!loaded) {
          logger.error(
            `[MerkleSettler] Market ${marketId} (${market.asset}-${market.timeframe}) has merkle root on-chain ` +
            `but no persisted tree in settlement_trees. This means the tree was posted before the ` +
            `persistence layer was deployed, or the DB row was lost. Rebuilding from mutable DB state would ` +
            `produce a tree that doesn't hash into the on-chain root. Marking as SETTLEMENT_FAILED.`
          );
          await marketService.markSettlementFailed(marketId);
          settlingState.delete(marketId);
          marketFailureCount.delete(marketId);
          return;
        }
        state = loaded;
        state.rootPosted = true; // Skip pre-root drift + postMerkleRoot in existing flow
        settlingState.set(marketId, state);
        logger.info(
          `[MerkleSettler] Loaded persisted tree for ${market.asset}-${market.timeframe}: ` +
          `${state.leaves.length} leaves, root=${Buffer.from(state.tree.root).toString('hex').slice(0, 16)}...`
        );
      } else {
        // In-memory state exists; ensure rootPosted is set so the post-root
        // flow below takes effect.
        state.rootPosted = true;
      }

      // Read bitmap(s) to know which leaves are already claimed. The enqueue
      // loop below skips batches whose indices are fully contained in this set.
      const chunkCount = Math.max(1, Math.ceil(state.leaves.length / 8192));
      claimedLeafIndices = new Set<number>();
      for (let chunk = 0; chunk < chunkCount; chunk++) {
        try {
          const chunkClaimed = await fetchSettlementBitmap(
            anchorClient.getConnection(),
            new PublicKey(marketPubkey),
            chunk,
          );
          for (const idx of chunkClaimed) claimedLeafIndices.add(idx);
        } catch (bmErr: any) {
          logger.warn(`[MerkleSettler] Bitmap read failed for chunk ${chunk}: ${bmErr.message}`);
        }
      }

      // Fast path: all leaves claimed on-chain → settlement is done; let the
      // existing step 4+ finalize path run (batch completion check will see
      // everything COMPLETED / or we re-sync settlement_jobs below).
      if (
        chain.settlementsTotal > 0n &&
        chain.settlementsProcessed >= chain.settlementsTotal
      ) {
        logger.info(
          `[MerkleSettler] On-chain settlement complete (${chain.settlementsProcessed}/${chain.settlementsTotal}) ` +
          `for ${market.asset}-${market.timeframe}; reconciling DB and finalizing.`
        );
        // Mark any non-COMPLETED settlement_jobs as COMPLETED since on-chain
        // truth says they all landed. Safe: we're post-hoc recording reality.
        await db.execute(sql`
          UPDATE settlement_jobs
          SET status = 'COMPLETED', completed_at = COALESCE(completed_at, NOW())
          WHERE market_id = ${marketId}::uuid AND status != 'COMPLETED'
        `).catch(() => { /* non-fatal */ });
        // batchesCreated is true so the existing code won't re-enqueue.
        state.batchesCreated = true;
      }
    }
  } catch (err: any) {
    logger.warn(`[MerkleSettler] Post-root router read failed, falling back to pre-root path: ${err.message}`);
  }

  // ─── Unified flow (both paths converge here) ────────────────────────────
  // Step 1: Build settlement state (pre-root only — post-root already loaded)
  if (!state) {
    state = settlingState.get(marketId);
  }
  if (!state) {
    // Build settlement state from on-chain mint holders. The
    // `buildSettlementStateFromChain` call invariant-checks
    // `sum(holders) === open_interest` and returns null if it doesn't match,
    // which we treat as either "nothing to settle" (open_interest == 0) or a
    // protocol-level bug requiring manual review (SETTLEMENT_FAILED).
    const chainForBuild = await fetchMarketV2OnChainState(
      anchorClient.getConnection(),
      new PublicKey(marketPubkey),
    );
    if (!chainForBuild) {
      logger.warn(`[MerkleSettler] No on-chain state for ${marketId}, will retry`);
      return;
    }
    const built = await buildSettlementStateFromChain(market, outcome, chainForBuild.openInterest);
    if (!built) {
      if (chainForBuild.openInterest === 0n) {
        await marketService.markSettled(marketId);
        logEvents.marketSettled({
          marketId, asset: market.asset, timeframe: market.timeframe,
          positionsSettled: 0, totalPayout: 0,
        });
      } else {
        await marketService.markSettlementFailed(marketId);
      }
      return;
    }
    state = built;
    settlingState.set(marketId, state);
  }

  // Step 2: Post merkle root on-chain.
  //
  // No pre-root drift check needed — buildSettlementStateFromChain already
  // enforced sum(holders) === open_interest as an invariant, so the tree we
  // post is guaranteed to match. If state.rootPosted is true (post-root path
  // loaded an existing tree from settlement_trees), we skip posting.
  if (!state.rootPosted) {
    try {
      const sig = await anchorClient.postMerkleRoot({
        marketPubkey,
        merkleRoot: state.tree.root,
        totalAmount: state.totalAmount,
        totalSettlements: state.leaves.length,
      });
      logger.info(`[MerkleSettler] Merkle root posted for ${market.asset}-${market.timeframe}: ${sig}`);
      // Persist the tree we just committed on-chain. On crash recovery the
      // post-root path loads from this row instead of rebuilding (which
      // would produce a different tree once any batch has executed).
      await persistSettlementTree(marketId, state, outcome, sig).catch((persistErr: any) => {
        logger.error(`[MerkleSettler] Failed to persist settlement tree for ${marketId}: ${persistErr.message}`);
      });
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
        return;
      } else if (
        msg.includes('InvalidSettlementAmount') ||
        msg.includes('0x17ab') ||
        msg.includes('6059')
      ) {
        // Should be unreachable now that the chain-built tree is invariant-
        // checked, but keep the handler so a program bug surfaces clearly.
        logger.error(
          `[MerkleSettler] InvalidSettlementAmount despite chain-sourced invariant ` +
          `(state.totalAmount=${state.totalAmount}). Marking as SETTLEMENT_FAILED.`
        );
        await marketService.markSettlementFailed(marketId);
        settlingState.delete(marketId);
        marketFailureCount.delete(marketId);
        return;
      } else {
        throw err;
      }
    }
  }

  // Step 2.5: Build an Address Lookup Table for this market when it's worth
  // it. ALT compresses each account reference from 32 bytes → 1 byte in a
  // versioned TX, which lets subtreeSize=32 fit in 1232 bytes. Below the
  // threshold, ALT setup overhead (~3-5s of create+extend TXs) outweighs
  // the per-batch savings, so we skip it.
  //
  // Idempotent: skips if state already carries an ALT pubkey from a previous
  // cycle (loaded from settlement_trees.lookup_table_pubkey).
  const shouldUseAlt = state.leaves.length >= AnchorClient.ALT_RECIPIENT_THRESHOLD &&
                       state.leaves.length <= AnchorClient.MAX_ADDRESSES_PER_LUT - 7; // -7 for fixed accounts
  if (shouldUseAlt && !state.lookupTablePubkey) {
    try {
      const recipientWallets = state.leaves.map((l) => l.recipient);
      const altPk = await anchorClient.createMarketLookupTable(
        new PublicKey(marketPubkey),
        recipientWallets,
      );
      if (altPk) {
        // Wait for the ALT to be active (referenceable in versioned TXs).
        // Expected address count = 7 fixed + dedupedAtas (deduped by owner).
        const dedupedRecipientCount = new Set(recipientWallets.map((w) => w.toBase58())).size;
        const expectedAddressCount = 7 + dedupedRecipientCount;
        const ready = await anchorClient.waitForLookupTableActive(altPk, expectedAddressCount);
        if (ready) {
          state.lookupTablePubkey = altPk;
          await updateSettlementTreeLookupTable(marketId, altPk).catch((err: any) => {
            logger.warn(`[MerkleSettler] Failed to persist ALT pubkey for ${marketId}: ${err.message}`);
          });
          logger.info(
            `[MerkleSettler] ALT ready for ${market.asset}-${market.timeframe}: ` +
            `${altPk.slice(0, 8)} (${expectedAddressCount} addresses) — batches will use versioned TX with subtreeSize=32`
          );
        } else {
          logger.warn(`[MerkleSettler] ALT ${altPk.slice(0, 8)} not active in time; falling back to legacy TX path`);
        }
      }
    } catch (err: any) {
      // ALT setup is best-effort: failure means we fall back to the legacy
      // TX path (smaller subtreeSize), which still works.
      logger.warn(`[MerkleSettler] ALT setup failed for ${marketId}, falling back: ${err.message}`);
    }
  }

  // Step 3: Create settlement_jobs and enqueue to BullMQ (parallel!)
  //
  // V3 compact batching: instead of per-leaf full proofs, we group consecutive
  // leaves into subtree-aligned batches with a single shared bridge proof.
  // This saves ~4-8x TX space, allowing 8-32 settlements per TX vs 1-2 in V2.
  //
  // Fallback to V2 for tiny trees where compact batching doesn't help.

  const TX_LIMIT = 1232;
  // Sizing constants for legacy (non-ALT) TXs. Per-entry assumes the worst
  // case: createATA ix is included for every recipient. With Phase A's ATA
  // cache, warm batches skip createATA (~42 bytes/entry savings), but we
  // keep the conservative number so first-time runs still fit.
  //
  // Empirical baseline (2026-04-18, 49-holder market, all createATA emitted):
  //   1237 bytes for k=8 → 89.5 bytes/entry → round up to 96.
  const FIXED_OVERHEAD = 425;  // sig + header + blockhash + 6 fixed accounts + ix framing + discriminator
  const PER_ENTRY_OVERHEAD = 96;  // recipient ATA meta + createATA framing + wallet meta + amount + compact-u16

  // ALT-aware sizing: when an ALT compresses every account reference to 1
  // byte, the per-entry cost drops dramatically. Each entry only contributes
  // its 1-byte ATA index (in the ix's account-list) + 8 bytes for the amount
  // value + ~3 bytes for the createATA ix framing (still emitted for cold ATAs).
  // Fixed overhead also shrinks because the 6 fixed accounts compress too.
  const ALT_FIXED_OVERHEAD = 280;     // sig + header + blockhash + ALT lookup metadata + 6 compressed account refs + ix framing
  const ALT_PER_ENTRY_OVERHEAD = 14;  // 1-byte ATA index + 8-byte amount + ~5 bytes createATA framing (cold)

  const treeDepth = Math.ceil(Math.log2(Math.max(state.leaves.length, 2)));
  const paddedCount = state.tree.paddedSize;
  const altActive = !!state.lookupTablePubkey;

  /**
   * Find optimal subtree size (largest power-of-2 that fits in TX).
   * Returns 0 to signal V2 fallback when compact batching doesn't help.
   */
  function getOptimalSubtreeSize(depth: number, withAlt: boolean): number {
    const fixed = withAlt ? ALT_FIXED_OVERHEAD : FIXED_OVERHEAD;
    const perEntry = withAlt ? ALT_PER_ENTRY_OVERHEAD : PER_ENTRY_OVERHEAD;
    // Try k=32 first when ALT is active; legacy path tops out at k=16.
    const candidates = withAlt ? [32, 16, 8, 4] : [16, 8, 4];
    for (const k of candidates) {
      const bridgeDepth = depth - Math.log2(k);
      if (bridgeDepth < 0) continue;
      const txSize = fixed + bridgeDepth * 32 + k * perEntry;
      if (txSize <= TX_LIMIT - 52) return k; // 52-byte safety margin
    }
    return 0; // V2 fallback
  }

  const subtreeSize = getOptimalSubtreeSize(treeDepth, altActive);
  const useV3 = subtreeSize > 0 && state.leaves.length > 2 && state.leaves.length <= 8192;

  if (!state.batchesCreated) {
    if (useV3) {
      // ── V3 Compact Batch Settlement ──
      const totalSubtrees = paddedCount / subtreeSize;
      let batchIdx = 0;

      for (let i = 0; i < totalSubtrees; i++) {
        const startIndex = i * subtreeSize;
        const realCount = Math.min(subtreeSize, state.leaves.length - startIndex);
        if (realCount <= 0) continue; // skip all-padding subtrees

        // Partial-subtree fallback: when realCount < subtreeSize the V3 compact
        // instruction has produced InvalidMerkleProof on-chain (2026-04-18,
        // 1-leaf subtree of size 8). The V2 single-leaf path is proven and
        // handles the remainder cleanly, so route those leaves through it
        // instead of wrestling with V3 partial-subtree padding semantics.
        if (realCount < subtreeSize) {
          for (let k = 0; k < realCount; k++) {
            const leafIndex = startIndex + k;
            if (claimedLeafIndices && claimedLeafIndices.has(leafIndex)) {
              logger.debug(`[MerkleSettler] Skipping claimed remainder leaf ${leafIndex}`);
              continue;
            }
            const leaf = state.leaves[leafIndex];
            const thisBatchIdx = batchIdx++;
            const proof = state.tree.getProof(leafIndex);
            const leafHash = createSettlementLeaf(leaf.recipient, leaf.amount);
            if (!verifyMerkleProof(proof, state.tree.root, leafHash, leafIndex)) {
              throw new Error(`[MerkleSettler] V2 fallback local proof verification failed for leaf ${leafIndex}`);
            }
            await db.execute(sql`
              INSERT INTO settlement_jobs (market_id, batch_index, recipients, amounts, proofs, status)
              VALUES (
                ${marketId}::uuid,
                ${thisBatchIdx},
                ${JSON.stringify([leaf.recipient.toBase58()])}::jsonb,
                ${JSON.stringify([leaf.amount.toString()])}::jsonb,
                ${JSON.stringify([{ index: leafIndex, proof: proof.map(p => Buffer.from(p).toString('hex')) }])}::jsonb,
                'PENDING'
              )
              ON CONFLICT (market_id, batch_index) DO NOTHING
            `);
            const jobId = `batch-settle-${marketId}-${thisBatchIdx}`;
            await onchainSubmitQueue.add('batch-settle', {
              type: 'batch-settle' as const,
              idempotencyKey: jobId,
              payload: {
                marketPubkey,
                bitmapChunkIndex: Math.floor(leafIndex / 8192),
                settlements: [{
                  recipient: leaf.recipient.toBase58(),
                  amount: leaf.amount.toString(),
                  index: leafIndex,
                  proof: proof.map(p => Buffer.from(p).toString('hex')),
                }],
                marketId,
                batchIndex: thisBatchIdx,
              },
            }, { jobId }).catch(err => {
              logger.error(`[MerkleSettler] Failed to enqueue V2-fallback remainder leaf ${leafIndex}: ${err.message}`);
            });
          }
          continue; // Skip V3 enqueue for this partial subtree
        }

        // Reserve batchIdx eagerly so that skipping a fully-claimed batch
        // doesn't shift downstream batch indices. This keeps batch_index ↔
        // startIndex stable across pre-root and post-root cycles, so any
        // existing settlement_jobs row matches the row we'd insert.
        const thisBatchIdx = batchIdx;
        batchIdx++;

        // Post-root retry: skip batches where every leaf is already claimed
        // on-chain (bitmap set). Saves a pointless TX that would fail with
        // AlreadyClaimed and burn a worker slot.
        if (claimedLeafIndices) {
          let allClaimed = true;
          for (let k = 0; k < realCount; k++) {
            if (!claimedLeafIndices.has(startIndex + k)) { allClaimed = false; break; }
          }
          if (allClaimed) {
            logger.debug(`[MerkleSettler] Skipping fully-claimed V3 batch ${thisBatchIdx} @ index=${startIndex}`);
            continue;
          }
        }

        const batchLeaves = state.leaves.slice(startIndex, startIndex + realCount);
        const bridgeProof = state.tree.getSubtreeBridgeProof(startIndex, subtreeSize);

        // Local verification before submission
        const leafHashes = batchLeaves.map(l =>
          createSettlementLeaf(l.recipient, l.amount)
        );
        if (!verifyCompactBridgeProof(leafHashes, bridgeProof, state.tree.root, startIndex, subtreeSize)) {
          throw new Error(`[MerkleSettler] V3 local bridge proof verification failed for subtree at index ${startIndex}`);
        }

        // Insert settlement_job row
        await db.execute(sql`
          INSERT INTO settlement_jobs (market_id, batch_index, recipients, amounts, proofs, status)
          VALUES (
            ${marketId}::uuid,
            ${thisBatchIdx},
            ${JSON.stringify(batchLeaves.map(l => l.recipient.toBase58()))}::jsonb,
            ${JSON.stringify(batchLeaves.map(l => l.amount.toString()))}::jsonb,
            ${JSON.stringify({ version: 'v3', startIndex, subtreeSize, bridgeProof: bridgeProof.map(p => Buffer.from(p).toString('hex')) })}::jsonb,
            'PENDING'
          )
          ON CONFLICT (market_id, batch_index) DO NOTHING
        `);

        // Enqueue as V3 batch-settle job
        const jobId = `batch-settle-v3-${marketId}-${thisBatchIdx}`;
        await onchainSubmitQueue.add('batch-settle-v3', {
          type: 'batch-settle-v3' as const,
          idempotencyKey: jobId,
          payload: {
            marketPubkey,
            bitmapChunkIndex: Math.floor(startIndex / 8192),
            startIndex,
            subtreeSize,
            settlements: batchLeaves.map(l => ({
              recipient: l.recipient.toBase58(),
              amount: l.amount.toString(),
            })),
            bridgeProof: bridgeProof.map(p => Buffer.from(p).toString('hex')),
            marketId,
            batchIndex: thisBatchIdx,
            // Optional: ALT pubkey for versioned-TX path. When present, the
            // worker fetches this ALT and submits a versioned TX referencing
            // it, allowing subtreeSize=32 to fit. When absent, falls back to
            // a legacy TX (smaller subtree sizes).
            lookupTablePubkey: state.lookupTablePubkey,
          },
        }, { jobId }).catch(err => {
          logger.error(`[MerkleSettler] Failed to enqueue V3 batch ${thisBatchIdx}: ${err.message}`);
        });
      }

      state.totalBatches = batchIdx;
      state.batchesCreated = true;
      logger.info(`[MerkleSettler] V3: ${batchIdx} compact batches (subtreeSize=${subtreeSize}) enqueued for ${state.leaves.length} settlements`);
    } else {
      // ── V2 Fallback (small trees) ──
      const proofDepth = treeDepth;
      const entrySize = 52 + proofDepth * 32;
      const PER_ENTRY_ACCOUNTS_OVERHEAD = 80;
      const effectiveEntrySize = entrySize + PER_ENTRY_ACCOUNTS_OVERHEAD;
      const batchSize = Math.min(15, Math.max(1, Math.floor((TX_LIMIT - FIXED_OVERHEAD) / effectiveEntrySize)));
      let totalBatches = 0;

      logger.info(`[MerkleSettler] V2 fallback: chunk-aware batching (batchSize=${batchSize}) for ${state.leaves.length} settlements`);

      for (let start = 0, batchIdx = 0; start < state.leaves.length; batchIdx++) {
        const chunkBoundary = (Math.floor(start / 8192) + 1) * 8192;
        const end = Math.min(start + batchSize, state.leaves.length, chunkBoundary);

        // Post-root retry: skip batches whose leaves are fully claimed on-chain
        if (claimedLeafIndices) {
          let allClaimed = true;
          for (let idx = start; idx < end; idx++) {
            if (!claimedLeafIndices.has(idx)) { allClaimed = false; break; }
          }
          if (allClaimed) {
            logger.debug(`[MerkleSettler] Skipping fully-claimed V2 batch [${start}..${end})`);
            start = end;
            continue;
          }
        }

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

        const jobId = `batch-settle-${marketId}-${batchIdx}`;
        await onchainSubmitQueue.add('batch-settle', {
          type: 'batch-settle' as const,
          idempotencyKey: jobId,
          payload: {
            marketPubkey,
            bitmapChunkIndex: Math.floor(start / 8192),
            settlements: batchSettlements.map(s => ({
              recipient: s.recipient,
              amount: s.amount,
              index: s.index,
              proof: s.proof,
            })),
            marketId,
            batchIndex: batchIdx,
          },
        }, { jobId }).catch(err => {
          logger.error(`[MerkleSettler] Failed to enqueue batch ${batchIdx}: ${err.message}`);
        });

        totalBatches++;
        start = end;
      }

      state.totalBatches = totalBatches;
      state.batchesCreated = true;
      logger.info(`[MerkleSettler] ${totalBatches} V2 settlement batches enqueued`);
    }
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

  logger.info(`[MerkleSettler] All ${state.totalBatches} batches completed for ${marketId}`);

  // Step 5: Sync settlements to DB immediately (user-facing — don't wait for cleanup)
  await syncSettlementToDb(market, state, outcome);

  // Step 6: Burn remaining share tokens — BLOCKING to ensure mint supply = 0
  // If mints have supply > 0, finalize_market_v2 can't close them, leaking ~0.003 SOL each.
  const marketPk = new PublicKey(marketPubkey);
  const yesMint = getYesMintPda(marketPk);
  const noMint = getNoMintPda(marketPk);

  let burnSuccess = true;
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
      const MAX_BURN_RETRIES = 2;
      for (let i = 0; i < shareAtas.length; i += BURN_BATCH_SIZE) {
        const batch = shareAtas.slice(i, i + BURN_BATCH_SIZE);
        let burned = false;
        for (let attempt = 0; attempt <= MAX_BURN_RETRIES; attempt++) {
          try {
            const sig = await anchorClient.burnRemainingSharesV2({
              marketPubkey,
              yesMint: yesMint.toBase58(),
              noMint: noMint.toBase58(),
              userShareAtas: batch,
            });
            logger.info(`[MerkleSettler] Burned shares batch ${Math.floor(i / BURN_BATCH_SIZE) + 1}: ${sig}`);
            burned = true;
            break;
          } catch (burnErr: any) {
            const msg = burnErr.message || '';
            // AccountNotFound = ATA doesn't exist (user never received shares or already burned) — safe to skip
            if (msg.includes('AccountNotFound') || msg.includes('could not find account')) {
              logger.debug(`[MerkleSettler] Burn batch ${Math.floor(i / BURN_BATCH_SIZE) + 1}: some ATAs not found (already burned), continuing`);
              burned = true;
              break;
            }
            if (attempt < MAX_BURN_RETRIES) {
              logger.warn(`[MerkleSettler] Burn batch ${Math.floor(i / BURN_BATCH_SIZE) + 1} attempt ${attempt + 1} failed: ${msg}, retrying...`);
              await new Promise(r => setTimeout(r, 1000)); // 1s backoff
            } else {
              logger.error(`[MerkleSettler] Burn batch ${Math.floor(i / BURN_BATCH_SIZE) + 1} failed after ${MAX_BURN_RETRIES + 1} attempts: ${msg}`);
              burnSuccess = false;
            }
          }
        }
      }
    }
  } catch (err: any) {
    logger.error(`[MerkleSettler] Share burn step failed: ${err.message}`);
    burnSuccess = false;
  }

  if (!burnSuccess) {
    logger.warn(`[MerkleSettler] Some burn batches failed for ${marketId} — finalize will skip mint closure for affected mints (rent leak ~0.003 SOL per unclosed mint)`);
  }

  // Step 8: Finalize market on-chain
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

  // Step 9: Mark market settled + archived (after on-chain cleanup)
  await syncMarketStatusFromChain(marketId, marketPubkey, 'RESOLVED');
  await marketService.markSettled(market.id);
  await marketService.markArchived(market.id);

  // Cleanup
  settlingState.delete(marketId);

  // Clean up settlement_jobs rows
  await db.execute(sql`
    DELETE FROM settlement_jobs WHERE market_id = ${marketId}::uuid
  `);

  // Clean up persisted merkle tree — market is fully settled and finalized
  // on-chain, so the tree no longer serves any recovery purpose. Keeping it
  // wastes ~1KB per resolved market over time.
  //
  // NOTE: if state.lookupTablePubkey is set, the on-chain ALT account is
  // NOT closed here (Solana requires a 512-slot deactivation cooldown
  // before closeLookupTable can run, ~3-4 minutes). That ~0.003 SOL of
  // rent stays locked until a separate ALT-sweeper job (TODO) processes
  // deactivated tables. For devnet/perf testing the leak is negligible;
  // for production, build the sweeper before scaling.
  await db.execute(sql`
    DELETE FROM settlement_trees WHERE market_id = ${marketId}::uuid
  `).catch((err: any) => {
    logger.warn(`[MerkleSettler] Failed to clean settlement_trees row for ${marketId}: ${err.message}`);
  });

  const settlementElapsedMs = Date.now() - settlementStartMs;
  logger.info(`[MerkleSettler] Market ${market.asset}-${market.timeframe} fully settled [${settlementElapsedMs}ms total]`);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Chain-sourced settlement state builder.
 *
 * Queries the winning mint's holders on-chain (via Helius DAS, or gPA fallback)
 * and builds leaves directly from token account balances. The invariant
 *   sum(holder balances) === market.open_interest
 * must hold by protocol construction — if it doesn't, the Anchor program
 * itself has a bug (mint supplies out of sync with the vault) and we refuse
 * to post a tree. The caller escalates to SETTLEMENT_FAILED.
 *
 * Does not read the DB `positions` table. DB drift cannot propagate here.
 */
async function buildSettlementStateFromChain(
  market: typeof markets.$inferSelect,
  outcome: 'YES' | 'NO',
  onChainOpenInterest: bigint,
): Promise<SettlingState | null> {
  const marketPubkey = new PublicKey(market.pubkey);
  const winnerMint = outcome === 'YES' ? getYesMintPda(marketPubkey) : getNoMintPda(marketPubkey);

  const holders = await fetchMintHolders(anchorClient.getConnection(), winnerMint);
  if (holders.length === 0) {
    logger.warn(`[MerkleSettler] No on-chain holders of the winning mint for ${market.asset}-${market.timeframe} — nothing to settle`);
    return null;
  }

  const totalAmount = holders.reduce((sum, h) => sum + h.amount, 0n);

  // Invariant: the sum of winning-side balances must equal open_interest. If
  // it doesn't, either (a) the market account we just read is stale vs the
  // mint state, or (b) the program has a bug. Retry once on stale reads; if
  // still off, bail and let the caller escalate.
  if (totalAmount !== onChainOpenInterest) {
    logger.error(
      `[MerkleSettler] Invariant violation for ${market.asset}-${market.timeframe}: ` +
      `sum(holders)=${totalAmount}, open_interest=${onChainOpenInterest}, drift=${totalAmount - onChainOpenInterest}. ` +
      `This should not happen on a correctly-functioning program — refusing to post a tree.`
    );
    return null;
  }

  // Resolve wallet → userId for WS notifications. Users without a DB row get
  // paid (the on-chain proof is all they need) but receive no WS push.
  const walletStrings = holders.map((h) => h.owner.toBase58());
  const userRows = walletStrings.length > 0
    ? await db.select({ id: users.id, walletAddress: users.walletAddress })
        .from(users)
        .where(inArray(users.walletAddress, walletStrings))
    : [];
  const walletToUserId = new Map(userRows.map((u) => [u.walletAddress, u.id]));

  const leaves: SettlingState['leaves'] = holders.map((h) => ({
    recipient: h.owner,
    amount: h.amount,
    positionId: '', // not used downstream for chain-sourced trees
    userId: walletToUserId.get(h.owner.toBase58()) ?? null,
  }));

  const treeLeaves: SettlementLeaf[] = leaves.map((l) => ({ recipient: l.recipient, amount: l.amount }));
  const tree = buildMerkleTree(treeLeaves);

  logger.info(
    `[MerkleSettler] Built merkle tree from chain: ${leaves.length} holders, ` +
    `totalAmount=${totalAmount}, root=${Buffer.from(tree.root).toString('hex').slice(0, 16)}...`
  );

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
  // Defense-in-depth: if settlements already exist for this market, skip entirely.
  // This guards against duplicate runs that bypassed the processingMarkets guard
  // (e.g., TOCTOU race or advisory lock reentrance on the same DB connection).
  const existingCheck = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM settlements WHERE market_id = ${market.id}::uuid
  `);
  if (((existingCheck.rows?.[0] as any)?.cnt || 0) > 0) {
    logger.warn(`[MerkleSettler] Settlements already exist for market ${market.id} — skipping duplicate sync`);
    return;
  }

  const lastSig = state.batchSignatures[state.batchSignatures.length - 1] || null;
  const allPositions = await positionService.getPositionsForSettlement(market.id);

  for (const position of allPositions) {
    // M-05: Use integer microUSDC for payout calculation, then convert to human-readable
    const winningSharesStr = outcome === 'YES'
      ? (position.yesShares || '0')
      : (position.noShares || '0');
    const payoutMicro = decimalToMicroUsdc(winningSharesStr);
    const winningShares = Number(payoutMicro) / 1_000_000;
    const payout = winningShares; // $1.00 per share
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

  const totalPayout = state.leaves.reduce((sum, l) => sum + Number(l.amount) / 1_000_000, 0);
  logEvents.marketSettled({
    marketId: market.id,
    asset: market.asset,
    timeframe: market.timeframe,
    positionsSettled: allPositions.length,
    totalPayout,
  });
}

// ─── Settlement tree persistence ────────────────────────────────────────────
//
// Once the merkle root is posted on-chain the tree is immutable. We write the
// authoritative leaves + structure here so retries and crash recovery can
// reconstruct the SettlingState without touching mutable positions/trades.

interface PersistedLeaf {
  index: number;
  recipient: string;
  amountMicroUsdc: string; // bigint-as-string
  positionId: string;
  userId: string | null;
}

/**
 * Persist the merkle tree for a market at post-root time. Idempotent via PK
 * on market_id — subsequent calls are no-ops. Call this from every path that
 * successfully posts a root (combined resolve+post in market-resolver, and
 * the fallback postMerkleRoot in processMarketSettlement).
 */
export async function persistSettlementTree(
  marketId: string,
  state: SettlingState,
  winnerOutcome: 'YES' | 'NO',
  postedTxSignature: string | null,
): Promise<void> {
  const leavesJson: PersistedLeaf[] = state.leaves.map((leaf, i) => ({
    index: i,
    recipient: leaf.recipient.toBase58(),
    amountMicroUsdc: leaf.amount.toString(),
    positionId: leaf.positionId,
    userId: leaf.userId,
  }));

  await db.execute(sql`
    INSERT INTO settlement_trees (
      market_id, root, total_amount, total_leaves, padded_size,
      winner_outcome, leaves, lookup_table_pubkey, posted_tx_signature, posted_at
    )
    VALUES (
      ${marketId}::uuid,
      ${Buffer.from(state.tree.root).toString('hex')},
      ${state.totalAmount.toString()}::numeric,
      ${state.leaves.length},
      ${state.tree.paddedSize},
      ${winnerOutcome},
      ${JSON.stringify(leavesJson)}::jsonb,
      ${state.lookupTablePubkey ?? null},
      ${postedTxSignature},
      NOW()
    )
    ON CONFLICT (market_id) DO NOTHING
  `);
}

/**
 * Update an existing settlement_trees row's lookup_table_pubkey. Used after
 * the ALT is built (which happens AFTER the tree is initially persisted, so
 * the column is null on first insert).
 */
async function updateSettlementTreeLookupTable(marketId: string, lookupTablePubkey: string): Promise<void> {
  await db.execute(sql`
    UPDATE settlement_trees
    SET lookup_table_pubkey = ${lookupTablePubkey}
    WHERE market_id = ${marketId}::uuid
  `);
}

/**
 * Load the persisted tree for a market and reconstruct a SettlingState. The
 * merkle tree structure (including the root and all internal nodes) is
 * rebuilt from leaves via the deterministic builder — since buildMerkleTree
 * is a pure function of the (recipient, amount) pairs, the reconstructed root
 * will match the persisted root byte-for-byte. Returns null if no row exists.
 */
export async function loadSettlementTree(marketId: string): Promise<SettlingState | null> {
  const result = await db.execute(sql`
    SELECT root, total_amount::text AS total_amount, total_leaves, padded_size, leaves, lookup_table_pubkey
    FROM settlement_trees
    WHERE market_id = ${marketId}::uuid
    LIMIT 1
  `);
  const row = result.rows?.[0] as any;
  if (!row) return null;

  const persistedLeaves: PersistedLeaf[] = row.leaves;
  const leaves: SettlingState['leaves'] = persistedLeaves
    .sort((a, b) => a.index - b.index)
    .map((p) => ({
      recipient: new PublicKey(p.recipient),
      amount: BigInt(p.amountMicroUsdc),
      positionId: p.positionId,
      userId: p.userId,
    }));

  const treeLeaves: SettlementLeaf[] = leaves.map((l) => ({ recipient: l.recipient, amount: l.amount }));
  const tree = buildMerkleTree(treeLeaves);

  // Sanity check: reconstructed root must match persisted root. If not, the
  // row is corrupted or buildMerkleTree is non-deterministic (should never
  // happen) — fail loud instead of submitting leaves that won't verify.
  const expectedRootHex = (row.root as string).toLowerCase();
  const actualRootHex = Buffer.from(tree.root).toString('hex');
  if (expectedRootHex !== actualRootHex) {
    logger.error(
      `[MerkleSettler] Persisted tree mismatch for ${marketId}: ` +
      `expected root=${expectedRootHex}, rebuilt=${actualRootHex}. Refusing to use.`
    );
    return null;
  }

  const totalAmount = BigInt(row.total_amount);
  return {
    leaves,
    tree,
    totalAmount,
    batchesCreated: false,
    totalBatches: 0,
    batchSignatures: [],
    lookupTablePubkey: row.lookup_table_pubkey ?? undefined,
  };
}
