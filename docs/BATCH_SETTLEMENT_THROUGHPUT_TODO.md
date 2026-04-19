# Batch Settlement Throughput — Optimization Backlog

**Status:** Options A and B shipped 2026-04-19. C deferred.
**Last updated:** 2026-04-19

## Current state

V3 compact batch settlement uses **subtreeSize = 4** (4 settlements per on-chain TX) for typical trees. This is conservative — set during the empirical recalibration of `PER_ENTRY_OVERHEAD` from 44 → 96 bytes after the "Transaction too large: 1237 > 1232" failures on 2026-04-18.

Sizing formula in [merkle-settler.ts](apps/api/src/jobs/merkle-settler.ts) `getOptimalSubtreeSize`:

```
txSize = FIXED_OVERHEAD + bridgeDepth * 32 + k * PER_ENTRY_OVERHEAD
       = 425 + bridgeDepth * 32 + k * 96
must satisfy: txSize ≤ 1232 - 52 = 1180
```

For typical depth-6 trees (~33–64 winners):

| k | bridgeDepth | predicted size | fits? |
|---|---|---|---|
| 16 | 2 | 425 + 64 + 1536 = **2025** | ❌ |
| 8 | 3 | 425 + 96 + 768 = **1289** | ❌ (109 bytes over the safety-margined cap) |
| **4** | 4 | 425 + 128 + 384 = **937** | ✓ |

**Observed throughput:** 48-holder market settles in 12 batches × ~1s confirm time (parallelized) = ~5s wall clock. Acceptable today; will become the bottleneck for markets with 100+ winners.

## Why we left it at 4

The 2026-04-18 incident showed our previous estimate (PER_ENTRY_OVERHEAD = 44) was way off. Real per-entry cost in a `BatchSettleV3` TX is ~89.5 bytes (back-calculated from the observed 1237-byte failure). I rounded up to 96 for safety. With that calibration, k=8 doesn't fit and k=4 is the largest power-of-2 that does.

To get back to k=8 (or higher) we need to **shave bytes from the TX**. Three options below, ordered by cost/benefit.

---

## ☑ Option A — Skip `createAssociatedTokenAccountIdempotent` for cached ATAs (shipped 2026-04-19)

**Win:** ~12 bytes/entry. Drops per-entry cost from ~96 → ~84. Then k=8 fits at 1193 bytes (just under the 1180 cap with safety margin tightened a touch).

**Why it works:** [batchSettleV3](apps/api/src/lib/anchor-client.ts) currently emits one `createAssociatedTokenAccountIdempotent` instruction per recipient unconditionally. Each adds ~10–12 bytes (program-id index + 6 account-list bytes + 1 data byte). Most of those are no-ops at runtime because the recipient already has a USDC ATA from prior trading.

**Implementation sketch:**

1. Reuse the `knownAtas: Set<string>` cache I built in `AnchorClient` for the match path. Add a `markUsdcAtaExists(owner)` / `usdcAtaIsKnown(owner)` pair, separately from the share-mint ATA cache (they live in different mints).
2. In `batchSettleV3`, build `createAtaIxs` only for entries whose ATA isn't in the cache. After successful TX confirmation, mark all entries as known.
3. On rare cache-miss-but-ATA-actually-missing (e.g., process restart, fresh recipient): the inner Anchor program will throw `InvalidAccountData` or similar. BullMQ retries the batch; on retry, evict the cache entry and re-include the `createATA`. Self-healing.

**Effort:** ~30 lines. **Risk:** low. **Throughput change:** 4 → 8 settlements/TX (2× throughput).

**Caveat:** the safety margin (currently `TX_LIMIT - 52 = 1180`) needs to come down to ~30 to give k=8 room. With empirical calibration we have less need for a fat margin, but 30 is the floor.

---

## ☑ Option B — Address Lookup Tables (ALTs) + versioned transactions (shipped 2026-04-19)

**Win:** account references shrink from 32 bytes → 1 byte. Now picks k=32 when ALT is in use; k=16/k=8/k=4 still available as fallbacks.

**Why it works:** Solana versioned TXs can reference accounts via an on-chain `AddressLookupTable` instead of inlining each pubkey. For batch settlement, the account list per TX includes:
- 6 fixed accounts (market, vault, bitmap, relayer, token program, system program) → put in a per-market or global ALT.
- N recipient ATAs → put in a per-market ALT, lazily populated as users trade.

A 32-byte → 1-byte swap on, say, 8 recipients + 6 fixed accounts saves ~14 × 31 ≈ **434 bytes per TX**. Plenty of room for k=16 or higher.

**Implementation:**

1. Bootstrap: `createLookupTable` instruction at market activation (alongside the existing init instructions). One ALT per market.
2. Lazy population: when a user's ATA appears for the first time on a match TX, queue an `extendLookupTable` to add it. Throttle to avoid TX-size hit on the activation path.
3. Migrate `submitTransaction` to use `VersionedTransaction` + `MessageV0.compile({ ..., addressLookupTableAccounts })`. Today we use legacy `Transaction`.
4. Update `batchSettleV3` to look up the market's ALT and pass it to the versioned-TX builder.

**Effort:** medium, ~200 lines + migration. **Risk:** moderate — versioned TXs are well-supported but every code path that builds TXs needs updating, and ALT propagation latency matters (an ATA must be on-chain in the ALT for ≥1 slot before the TX can use it).

**When to do it:** once markets routinely have >100 winners and Option A's k=8 is no longer enough.

---

## Option C — Multiple V3 instructions per TX

**Win:** pack 2–3 `BatchSettleV3` instructions into one TX. With k=8 each, that's 16–24 settlements per TX.

**Why it works:** TX size limit is shared with compute budget. Each V3 instruction consumes ~11,125 CU. Our budget is 400,000 CU per TX. So compute-wise we could fit ~36 instructions. The limiter is the 1232-byte TX size.

If Option A gets us to k=8 at ~1193 bytes, two parallel V3 instructions for two non-overlapping bitmap chunks (or two non-overlapping subtrees in the same chunk) won't fit — both would carry their own `bridge_proof` + amounts + accounts. Would need to either:
- Share the bridge proof if both subtrees are siblings (specialized helper instruction needed in the on-chain program).
- Use ALTs from Option B to compress accounts enough that two full-batch instructions fit.

**Effort:** medium, requires either Anchor program changes or Option B as a prerequisite. **Risk:** moderate — partial-failure semantics get trickier (TX is atomic; if one ix fails the whole batch fails and retries together).

**When to do it:** only if A + B together still aren't enough.

---

## Implementation notes (A + B as shipped)

**Option A — `batchSettleV3` ATA cache reuse.**
- Shares the existing `AnchorClient.knownAtas` `Set<string>` with the match path. Cache keys are ATA pubkeys (not owner pubkeys), so YES/NO mint ATAs and USDC ATAs coexist without collision.
- New `ataDecisions` array tracks per-entry skip decisions. Successful TX → mark all entries as known. Failed TX → evict the entries we relied on (in case the cache was wrong). BullMQ retries with the eviction in place re-include the createATA.
- Logged via `createAtaSkipped=N/M` in the success line so we can see cache hit rate over time.

**Option B — Address Lookup Tables.**
- Per-market lifecycle: ALT created at settlement time (not market activation), populated with 7 fixed accounts + deduped recipient ATAs in `MAX_ADDRESSES_PER_EXTEND`-sized chunks (28 addresses per `extendLookupTable` TX), then waited until observable + 1 slot before referenceable.
- Threshold: `ALT_RECIPIENT_THRESHOLD = 64`. Below this, ALT setup overhead (~3-5s of create+extend TXs) outweighs per-batch savings — markets stay on the legacy TX path with k=4/k=8.
- Cap: `MAX_ADDRESSES_PER_LUT = 256`. Markets above 249 holders fall back to legacy. (For markets that big, multi-ALT support is a future enhancement.)
- Storage: `settlement_trees.lookup_table_pubkey` (nullable). Persisted right after ALT becomes active so post-root crash recovery can find it.
- Versioned-TX support: `submitTransaction` grew an `addressLookupTableAccounts` option. When present it builds a `MessageV0` + `VersionedTransaction`; otherwise legacy `Transaction` (current behavior). Both produce a serialized byte buffer that the existing send/simulate/confirm paths consume uniformly.
- Sizing: `getOptimalSubtreeSize` is now ALT-aware. With ALT it tries [32, 16, 8, 4]; without it stays at [16, 8, 4]. Constants `ALT_FIXED_OVERHEAD = 280` and `ALT_PER_ENTRY_OVERHEAD = 14` are conservative estimates — calibrate against runtime once we have empirical numbers.
- Cleanup deferred: ALT rent (~0.003 SOL) stays locked after market settles. A separate sweeper job needs to call `deactivateLookupTable` then wait 512 slots then `closeLookupTable`. Not built yet.

**What still doesn't ship in this round:**
- ALT sweeper for rent reclamation (rent leak per market — fine for devnet, must build before mainnet scale).
- Empirical recalibration of `ALT_PER_ENTRY_OVERHEAD` — the 14 number is a defensible guess. If runtime measurement shows headroom, we could maybe raise it, but k=32 already fits and there are no larger power-of-2 candidates.
- Pre-warming the ALT during market activation (would shave 3-5s off the first batch latency).

## Decision matrix

| Scenario | Recommended action |
|---|---|
| Current (≤100 winners/market, ~5s settlement OK) | Stay at k=4, ship A when convenient |
| Routine 100–500 winners | Implement A → k=8 |
| 500–2,000 winners | A + B → k=16 |
| 2,000+ winners | A + B + C → k=32 effective |

## Other tangential ideas worth noting

- **Tighter `getOptimalSubtreeSize` safety margin.** Currently `TX_LIMIT - 52 = 1180`. With empirical calibration (96 bytes/entry derived from a real 1237-byte measurement), the 52-byte buffer is overkill. Could safely tighten to ~30, which is already what Option A's math assumes.
- **Lazy ATA pre-warming during market resolve.** When `resolveMarketV2` confirms, kick off a background job that pre-fetches every winner's USDC ATA existence and warms the cache before batch-settle starts. Cuts the first-settlement latency by ~one round-trip.
- **Per-method RPC routing.** `getProgramAccounts` (used by the chain-sourced settlement snapshot) and `sendTransaction` could be split across separate Helius API keys to dodge per-method rate limits independently. Already configurable via `solanaRpcUrl2/3`, just not actively used.

---

## Cross-references

- Settlement architecture: `docs/SETTLEMENT_REFACTOR_TODO.md`
- State machine context: `docs/STATE_MACHINES_V2.md` §4 (Settlement Batch Lifecycle), §7 (Keeper Jobs)
- Sizing formula source: `apps/api/src/jobs/merkle-settler.ts` (`getOptimalSubtreeSize`)
- Builder source: `apps/api/src/lib/anchor-client.ts` (`batchSettleV3`)
- ATA cache (existing scaffold to extend for Option A): `AnchorClient.knownAtas`
