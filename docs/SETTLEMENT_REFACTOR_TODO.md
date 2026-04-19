# Settlement Refactor — DB → On-Chain Source of Truth

**Status:** Done — chain-only path is the only path. Legacy DB code removed.
**Branch:** `claude/nifty-antonelli-d0b90c`
**Last updated:** 2026-04-19

## Problem

Merkle settlement currently builds leaves from `positions` rows in Postgres. Under load the DB drifts from on-chain reality (one-sided position updates, races in db-sync reversal, etc.), and the drift keeps breaking settlement: the tree we try to post doesn't match what the vault actually holds, so the on-chain instruction rejects with `InvalidSettlementAmount (6059)` or `InvalidMerkleProof (6053)`.

We've patched symptoms (drift detector, phantom-share repair, precision reconcile, persisted merkle trees, bitmap-driven retry) but the root cause is architectural: **DB is a derived view, not a source of truth, and we're settling from the derived view**.

## Principle

On-chain mints and USDC vault ARE the truth. Settlement tree must be built from:
- **Total:** `market.open_interest` — the exact USDC the vault holds.
- **Per-holder:** the winning mint's token account balance for each wallet.

DB `positions` remains the UI/history surface. It is never an input to the merkle settler again.

## Design decisions (locked in)

1. **Query method:** Helius DAS `getTokenAccounts`. Standard `getProgramAccounts` as fallback for non-Helius RPCs.
2. **Combined `resolveAndPostMerkleRootV2` TX:** killed. Resolve and post-root are separate steps; the speed loss is ~1.5–2s/market, which is invisible outside perf tests.
3. **Snapshot timing (primary):** right after on-chain resolve, once the market status transitions to `Resolved` (at which point pending match TXs can no longer alter mint supplies).
4. **Snapshot timing (optimization, Step E):** optional second path that snapshots both mints at market-close time (status → `Closed`). Resolve then picks the right pre-built tree.
5. **Position-tracking bug:** still worth chasing separately. The refactor makes *settlement* robust to it, but the UI still shows drifted P&L until the real bug is fixed. The reconciler job (Step D) surfaces the drift so we can hunt the bug with data.

## Steps

Each step is shippable independently. Behind a config flag `SETTLEMENT_SOURCE=chain|db` (default `db` until Step F) so on-chain settlement can be A/B-tested on devnet without blocking prod.

### Step A — Helius DAS holder helper ☑

**Goal:** `fetchMintHolders(mintPubkey) → Array<{ owner: PublicKey, amount: bigint }>`. Aggregates by owner, filters zero balances, paginates if necessary.

**Files:**
- `apps/api/src/lib/settlement-snapshot.ts` (new).

**Acceptance:**
- ☑ Returns all non-zero holders of the given mint.
- ☑ Sum of amounts equals the mint's supply (verified via Step B invariant check on devnet, 2026-04-19 perf run: 48 holders summed to exactly `open_interest`).
- ☑ Works on devnet against a real resolved market.
- ☑ Falls back to `getProgramAccounts` when DAS endpoint not detected as Helius.

**Notes from implementation:**
- Uses native `fetch` (Node 18+). No new deps.
- Helius detection sniffs `helius-rpc.com` / `helius.xyz` in the `Connection`'s `_rpcEndpoint` (or falls back to `config.solanaRpcUrl`).
- Results sorted by owner pubkey ascending. Merkle tree construction is order-sensitive — **all callers must use this order**.
- Token-2022 parse: first 72 bytes always contain `mint(32)|owner(32)|amount(u64 LE)` regardless of extensions. No dataSize filter on gPA so it works with `MintCloseAuthority` + `PermanentDelegate`.
- Pagination: DAS pages of 1000, terminates on under-filled page or when `page * limit >= total`. Ceiling of 100 pages (100k holders) before hard-stop.

### Step B — Chain-sourced `buildSettlementStateFromChain` ☑

**Goal:** drop-in alternative to `buildSettlementState` that builds leaves from `fetchMintHolders` instead of DB positions. Invariant-checks `sum(leaves) === market.open_interest`.

**Files:**
- `apps/api/src/jobs/merkle-settler.ts` (added `buildSettlementStateFromChain`, branched `processMarketSettlement` on flag).
- `apps/api/src/config.ts` (added `settlementSource` config, default `'chain'`).

**Acceptance:**
- ☑ Called only when `SETTLEMENT_SOURCE=chain`.
- ☑ Tree root is deterministic given the same holders (sorted by owner pubkey in `fetchMintHolders`).
- ☑ Hard-fails (returns null, caller marks `SETTLEMENT_FAILED`) if invariant doesn't hold.
- ☑ Distinguishes "zero holders, nothing to settle" (mark SETTLED) from "non-zero open_interest but invariant failure" (mark SETTLEMENT_FAILED).

### Step C — Kill combined `resolveAndPostMerkleRootV2`, kill pre-seed ☑

**Goal:** when `SETTLEMENT_SOURCE=chain`, `market-resolver` only calls `resolveMarketV2`. `prepareSettlementData` and `preSeedSettlingState` become no-ops for this path. Merkle settler is the single builder of the tree, post-resolve.

**Files:**
- `apps/api/src/jobs/market-resolver.ts` (combined TX path and pre-seed call removed entirely — single resolve TX, settler builds tree afterwards from chain).
- `apps/api/src/jobs/merkle-settler.ts` (see Step B).
- `apps/api/src/jobs/position-settler.ts` — **deleted** in Step F cleanup.

**Acceptance:**
- ☑ Combined TX not attempted (instruction call site removed).
- ☑ Pre-seed map not populated (function removed).
- ☑ End-to-end settlement works on devnet (2026-04-19 perf run: 12 batches, 48 settlements, all confirmed; "All batches complete" log fires).

### Step D — Drift reconciler job ☑

**Goal:** periodic job that compares DB position sums to on-chain mint supplies for active markets and logs drift. Independent of settlement path — runs regardless of flag.

**Files:**
- `apps/api/src/jobs/drift-reconciler.ts` (new).
- `apps/api/src/jobs/index.ts` (scheduled every 60s, `startupDelay=65s` so it doesn't pile on at boot).

**What it compares per market (status in OPEN/CLOSED/RESOLVED):**
- On-chain `market.open_interest`.
- On-chain YES mint supply (`getTokenSupply`).
- On-chain NO mint supply (`getTokenSupply`).
- DB `SUM(positions.yes_shares)` for open positions.
- DB `SUM(positions.no_shares)` for open positions.

Expected: all five equal. Any mismatch → structured `WARN` log with the full breakdown (on-chain values, DB values, per-axis drift lamports). Zero mutation.

**Acceptance:**
- ☑ Job runs on schedule (60s, perf-mode disables).
- ☑ Caps at 25 markets per cycle to bound RPC load.
- ☑ Does NOT auto-correct DB — purely observational.
- ☐ Per-user drift breakdown when aggregate mismatch detected (**future enhancement**; today logs aggregate only).

### Step E — Optional: snapshot-at-close optimization ☐

**Goal:** when a market closes, snapshot BOTH mints' holders to a new `mint_snapshots` table. When resolve completes, use the pre-fetched snapshot for the winning outcome. Saves ~200–500ms from resolve-to-root latency.

**Files:**
- New `mint_snapshots` table.
- Market-closer hooks to take snapshots.
- `buildSettlementStateFromChain` prefers snapshot, falls back to live fetch.

**Acceptance:**
- Snapshot taken within N ms of close.
- Resolve uses snapshot when outcome matches a cached side.
- Stale snapshots (>1 hour old) are ignored in favor of live fetch.

**Defer until Steps A–D are stable.**

### Step F — Remove DB-sourced settlement path ☑

**Goal:** delete the legacy DB code and the `SETTLEMENT_SOURCE` flag now that chain-only is proven on devnet.

**Files touched (2026-04-19):**
- `apps/api/src/config.ts` — `settlementSource` flag removed.
- `apps/api/src/jobs/market-resolver.ts` — combined-TX try block, pre-seed call, and all related imports removed. Resolve flow is now: `attemptResolve()` → `triggerMerkleSettlement`.
- `apps/api/src/jobs/merkle-settler.ts` — deleted: `buildSettlementState`, `repairLegacyFailedTradePositions`, `reversePositionForSettlementRepair`, `preSeedSettlingState`, `getPreSeededMerkleData`, `markRootPosted`, `invalidateSettlingState`, `persistSettlingStateByMarketId`, `logSettlementDriftDiagnostics`, `reconcileSmallSettlementDrift`, `previewSettlementLeaves`, `rebuildSettlementTree`. The drift block in `processMarketSettlement` collapsed to a plain `postMerkleRoot` + persist (the chain-built tree is invariant-checked, so drift can't happen pre-post-root).
- `apps/api/src/lib/anchor-client.ts` — `resolveAndPostMerkleRootV2` method removed.
- `apps/api/src/jobs/position-settler.ts` — **deleted** (entire file; nothing imported it externally after market-resolver dropped `prepareSettlementData`).

**Acceptance:**
- ☑ Config flag removed.
- ☑ Legacy functions deleted (~547 lines of dead code gone).
- ☑ No DB reads from settlement critical path. (`syncSettlementToDb` still reads `positions` for the user-facing settlement *records*; that's intentional UI history, not the merkle input.)
- ☑ Perf tests hit 7 tps sustainable without settlement errors (2026-04-19 run, 99.2% success rate, drift = 0).

## Out of scope for this refactor

- **Position-tracking bug hunt.** **Resolved** 2026-04-19 — root cause was *not* the originally-suspected matching/db-sync paths but a synthetic non-UUID `tradeId` from `executeFillsOnChain` that crashed the db-sync reversal lookup with "invalid input syntax for type uuid". The throw was swallowed by an outer try/catch and the takerOrderId fallback never ran, so chain-failed trades' optimistic position updates were never reversed → phantom drift. Fix in `db-sync.worker.ts`: `isUuid()` gate on tradeId lookups + explicit fall-through to order-id lookups + WARN log when no trade is found. Also fixed the original SELECT→compute→UPDATE race in `position.service.ts::updateAfterTrade` and the same race in `db-sync.worker.ts::reverseUserPosition` (both now atomic SQL upserts/updates).
- **UI changes.** DB stays authoritative for UI reads. Only settlement flow moved to chain.
- **On-chain program changes.** No Anchor code changes.

## Open items flagged while planning

- Helius DAS `getTokenAccounts` response format has shifted between API versions; pin a version or sniff capability.
- For >8K holders we need pagination in `fetchMintHolders`. Today's markets are far below that; document the ceiling.
- User-wallet lookup: we currently have `userId` threaded through for WS notifications. Chain-sourced leaves only have wallet addresses. After holders fetched, do one batched `SELECT id FROM users WHERE wallet_address IN (...)` to resolve. Users without a DB row still get paid — they just don't get the WS ping.
- Burn step (`burnRemainingSharesV2`) currently iterates DB-derived ATAs. Switch to the holder list from Step A.

## Progress log

- 2026-04-18 — Plan drafted, decisions locked in. Reverted the "top-up-largest-leaf" band-aid. Starting Step A.
- 2026-04-18 — Steps A, B, C, D implemented. Step F default flipped (legacy code retained for one-cycle rollback). Step E deferred. Ready for live devnet test with default `SETTLEMENT_SOURCE=chain`.
- 2026-04-19 — Devnet perf test confirms chain path works end-to-end (48 holders, 12 batches, all confirmed, drift = 0). Position-tracking bug root-caused (synthetic-tradeId UUID throw) and fixed in db-sync. Step F completed: legacy code deleted, flag removed. Refactor done; remaining items (Step E, per-user reconciler breakdown) reclassified as nice-to-haves and moved to the done-list above.
