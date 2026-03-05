# V2 Implementation TODO

> **Goal**: Scale to 50K+ concurrent users, settle 50K positions in <1 minute
>
> **Status**: ✅ All Phases Complete — Phases 0-7 implemented. Load testing pending.
>
> **Started**: January 2026 | **Core pipeline tested**: February 2026

---

## Dependency Graph

```
✅ Phase 0: Instrumentation ──┬──▶ ✅ Phase 1: Redis Orderbook ──▶ ✅ Phase 2: WebSocket Fanout
                              │
                              └──▶ ✅ Phase 3: BullMQ Pipeline ──┐
                                                                  │
✅ Phase 4: Tokenized Shares ──▶ ✅ Phase 5: Merkle Settlement ──┼──▶ ✅ Phase 6: Relayer Pool
                                                                  │
                                   ✅ Phase 7: Settlement Orch. ──┘
```

---

## Phase 0: Add Instrumentation and Metrics
**Status**: ✅ Complete (Core)
**Blocked by**: None
**Blocks**: Phase 1, Phase 3

Add metrics collection before optimization to measure improvements.

### Tasks
- [x] Install metrics library (prom-client)
- [x] Add WebSocket metrics
  - [x] Fanout time per channel (histogram)
  - [x] Connected sockets count (gauge)
  - [x] Messages sent per second (counter)
  - [x] Broadcast latency p50/p95/p99
- [x] Add Redis metrics
  - [x] Operations per second by command type
  - [x] Latency per command (histogram)
  - [x] Hot key access patterns (orderbook operations)
- [x] Add DB metrics (structure created)
  - [x] Pool waiting count (gauge)
  - [x] Query latency by endpoint (histogram)
  - [x] Connection count (gauge)
- [x] Add on-chain submission metrics (structure created)
  - [x] Queue depth (gauge)
  - [x] Submission latency (histogram)
  - [x] Success/failure rate (counter)
  - [x] Retry count (histogram)
- [x] Create metrics endpoint `/metrics` (Prometheus format)
- [ ] Document baseline measurements

### Files Created/Modified
- [x] `apps/api/src/metrics/index.ts` (new - all metrics defined)
- [x] `apps/api/src/routes/metrics.ts` (new - /metrics endpoint)
- [x] `apps/api/src/lib/broadcasts.ts` (instrumented)
- [x] `apps/api/src/routes/websocket.ts` (instrumented)
- [x] `apps/api/src/services/orderbook.service.ts` (instrumented)
- [x] `apps/api/src/index.ts` (registered metrics routes)
- [x] `apps/api/package.json` (added prom-client)

---

## Phase 1: Redis Orderbook Hot-Path Redesign
**Status**: ✅ Complete
**Blocked by**: Phase 0
**Blocks**: Phase 2
**Completed**: February 2026

Upgraded in-place in `orderbook.service.ts` — all operations now O(log N) or better with Lua atomicity.

### Tasks
- [x] Design new Redis data model
  - [x] ZSET with orderId as member (`ob:{marketId}:{outcome}:{side}`)
  - [x] HASH for order details (`order:{orderId}`)
  - [x] HASH for aggregated levels (`levels:{marketId}:{outcome}:{side}`)
  - [x] Sequence counter for delta sync (`sequence:{marketId}`)
- [x] Implement new orderbook service (upgraded `orderbook.service.ts` in-place)
  - [x] `addOrder()` - O(log N) with incremental level update via Lua
  - [x] `removeOrder()` - O(log N) direct ZREM by orderId
  - [x] `updateOrderSize()` - O(1) hash update + level adjustment
  - [x] `getSnapshot()` - O(levels) from pre-aggregated `levels` hash
  - [x] `consumeOrder()` - atomic Lua: update/remove + level adjust + sequence increment
  - [x] `getBestBid()`/`getBestAsk()` - atomic Lua with orphan cleanup
  - [x] `getCompositeSnapshot()` - merged YES/NO with complement pricing
- [x] Update matching engine to use new service
- [x] Implement delta broadcasting
  - [x] Emit deltas with sequence numbers (every mutation increments `sequence:{marketId}`)
  - [x] Client tracks sequence, requests snapshot on gap
- [x] 3 Lua scripts for atomicity: `UPDATE_LEVEL_LUA`, `GET_BEST_LUA`, `CONSUME_ORDER_LUA`

### Files Modified
- [x] `apps/api/src/services/orderbook.service.ts` (upgraded in-place to v2)
- [x] `apps/api/src/services/matching.service.ts` (uses getBestBid/Ask, consumeOrder, getCompositeSnapshot)
- [x] `apps/api/src/lib/broadcasts.ts` (delta support with sequenceId)

---

## Phase 2: WebSocket Fanout Redesign
**Status**: ✅ Complete
**Blocked by**: Phase 1
**Blocks**: None
**Completed**: February 2026

Upgraded in-place in `broadcasts.ts` — reverse-indexed, batched, with backpressure handling.

### Tasks
- [x] Implement subscription reverse index
  - [x] `channelSubscribers: Map<channel, Set<socket>>`
  - [x] `userSockets: Map<userId, Set<socket>>`
- [x] Update subscribe/unsubscribe to maintain indexes
  - [x] `indexSubscribe()`, `indexUnsubscribe()`, `indexUser()`, `indexRemoveClient()`
- [x] Update broadcast to use index (O(subscribers))
  - [x] Fallback to old-style scan when reverse index empty (transition safety)
- [x] Implement batching for high-frequency channels
  - [x] 30ms batch window for `orderbook:` and `trades:` channels
  - [x] Latest snapshot wins (coalesces rapid updates)
- [x] Implement backpressure handling
  - [x] 64KB `bufferedAmount` threshold
  - [x] Skip non-critical messages when buffer full
  - [x] Client recovers via snapshot request
- [ ] Performance test: measure broadcast latency at 10K connections

### Files Modified
- [x] `apps/api/src/lib/broadcasts.ts` (upgraded in-place to v2 with reverse index + batching)
- [x] `apps/api/src/routes/websocket.ts` (calls index functions on subscribe/unsubscribe/disconnect)

---

## Phase 3: Durable Async Pipeline with BullMQ
**Status**: ✅ Complete
**Blocked by**: Phase 0
**Blocks**: Phase 6
**Completed**: February 2026

All on-chain submission, DB sync, and WS event delivery uses durable BullMQ queues with rate limiting, retries, and idempotency.

### Tasks
- [x] Install BullMQ
- [x] Create queue infrastructure
  - [x] `onchain-submit` queue (match, close, batch-settle jobs)
  - [x] `db-sync` queue (post-confirmation DB updates)
  - [x] `ws-events` queue (WebSocket broadcast delivery)
- [x] Create workers
  - [x] OnChainSubmitWorker (concurrency=35, rate=7/s devnet, 15/s mainnet w/ Sender)
  - [x] DbSyncWorker (concurrency=10)
  - [x] WSEventWorker (concurrency=10)
- [x] Add idempotency
  - [x] Stable job IDs: `match-{tradeId}`, `close-{tradeId}`, `dbsync-{key}`
  - [x] BullMQ deduplicates by jobId automatically
- [x] Create reconciliation job
  - [x] Finds PENDING trades/settlements older than threshold
  - [x] Re-checks on-chain status
  - [x] Replays missing DB/WS updates
- [x] Migrate all background tasks to queues
- [x] Rate limiting: 1-second smooth window (prevents 429 RPC cascades)
- [x] Write-behind service for batched DB persistence (~1s flush intervals)
- [x] RPC connection pool with round-robin across multiple endpoints
- [x] Blockhash caching (5s TTL, single-flight deduplication)
- [ ] BullMQ dashboard (optional, not yet added)

### Files Created/Modified
- [x] `apps/api/src/queue/queues.ts` (queue definitions, cleanup)
- [x] `apps/api/src/queue/workers/onchain-submit.worker.ts` (rate-limited TX submission)
- [x] `apps/api/src/queue/workers/db-sync.worker.ts` (post-confirmation DB updates)
- [x] `apps/api/src/queue/workers/ws-events.worker.ts` (WebSocket broadcast)
- [x] `apps/api/src/queue/jobs/reconciliation.job.ts` (stale PENDING recovery)
- [x] `apps/api/src/services/write-behind.service.ts` (batched DB writes)
- [x] `apps/api/src/services/matching.service.ts` (enqueues to BullMQ on match)

### Performance (measured on devnet)
- Burst: 20.4 confirmed tx/s (60 orders)
- Sustained: 7 tx/s with zero 429 errors (503 orders over 3.5 min)
- Zero stuck PENDING trades after rate limit fix

---

## Phase 4: Tokenized Shares On-Chain Program
**Status**: ✅ Complete (Core Instructions)
**Blocked by**: None
**Blocks**: Phase 5

CRITICAL for settlement scaling - Replace Position PDAs with SPL tokens.

### Tasks
- [x] Create MarketV2 account structure
  - [x] Add `yes_mint: Pubkey`
  - [x] Add `no_mint: Pubkey`
  - [x] Add `open_interest: u64`
  - [x] Add merkle settlement fields
- [x] Create `initialize_market_v2` instruction
  - [x] Create YES token mint (authority: market PDA)
  - [x] Create NO token mint (authority: market PDA)
  - [x] Initialize market with mint references
- [x] Create `execute_match_v2` instruction (opening trade)
  - [x] Mint YES tokens to buyer's ATA
  - [x] Mint NO tokens to seller's ATA
  - [x] Increment open_interest
  - [x] Auto-create ATAs via init_if_needed
- [x] Create `execute_close_v2` instruction (closing trade)
  - [x] Transfer tokens from seller to buyer
  - [x] No minting/burning needed
- [x] Create `activate_market_v2` instruction
- [x] Create `resolve_market_v2` instruction
- [ ] Update tests for new token model
- [ ] Deploy to devnet for testing

### Files Created/Modified
- [x] `packages/contracts/programs/degen-terminal/src/state_v2.rs` (new - V2 state)
- [x] `packages/contracts/programs/degen-terminal/src/instructions/initialize_market_v2.rs` (new)
- [x] `packages/contracts/programs/degen-terminal/src/instructions/execute_match_v2.rs` (new)
- [x] `packages/contracts/programs/degen-terminal/src/instructions/execute_close_v2.rs` (new)
- [x] `packages/contracts/programs/degen-terminal/src/instructions/activate_market_v2.rs` (new)
- [x] `packages/contracts/programs/degen-terminal/src/instructions/resolve_market_v2.rs` (new)
- [x] `packages/contracts/programs/degen-terminal/src/instructions/mod.rs` (updated)
- [x] `packages/contracts/programs/degen-terminal/src/lib.rs` (updated)
- [ ] `packages/contracts/tests/*.ts`

---

## Phase 5: Merkle Batch Settlement On-Chain
**Status**: ✅ Complete (On-chain + API + E2E Tested)
**Blocked by**: Phase 4
**Blocks**: Phase 6, Phase 7
**Completed**: February 2026

Merkle tree settlement fully implemented, integrated, and load-tested on devnet with 200+ users.

### Tasks
- [x] Add SETTLING status to MarketStatus enum (in state_v2.rs)
- [x] Add settlement fields to Market account (in state_v2.rs)
  - [x] `settlement_merkle_root: [u8; 32]`
  - [x] `total_settlement_amount: u64`
  - [x] `settlements_processed: u64`
  - [x] `settlements_total: u64`
- [x] Implement `post_merkle_root` instruction
  - [x] Verify market is RESOLVED
  - [x] Store merkle root
  - [x] Set settlement counts
  - [x] Transition to SETTLING
  - [x] Initialize SettlementBitmap
- [x] Implement `batch_settle_v2` instruction
  - [x] Accept up to 15 recipients via remaining_accounts
  - [x] Verify merkle proofs for each
  - [x] Transfer USDC from vault
  - [x] Track processed count
  - [x] Use bitmap to prevent double-settlement
- [x] Implement `finalize_market_v2` instruction
  - [x] Verify all settlements complete
  - [x] Close vault (recover rent)
  - [x] Transition to SETTLED
- [x] Add merkle proof verification (keccak256) - in state_v2.rs
- [ ] Update on-chain unit tests
- [x] API V2 trade execution integration
  - [x] Feature flag: `USE_V2=true` env var to toggle V1/V2
  - [x] `transaction.service.ts` updated with V2 execute match/close
  - [x] `anchor-client.ts` added executeMatchV2, executeCloseV2 methods
  - [x] Market creator uses V2 when flag enabled
  - [x] Market activator uses V2 when flag enabled
  - [x] Market resolver uses V2 when flag enabled
- [x] API integration for V2 merkle settlement flow
  - [x] `merkle-settler.ts` keeper job (builds tree, posts root, batch settles, finalizes)
  - [x] `merkle-tree.ts` library (keccak256, proof generation)
  - [x] `anchor-client.ts` added postMerkleRoot, batchSettleV2, finalizeMarketV2 methods
  - [x] Keeper registered in `jobs/index.ts` (runs every 10s when USE_V2=true)
  - [x] Fix: FEE_RECIPIENT crash in buildExecuteCloseV2Instruction (2026-02-07)
- [x] Batch size calculation accounts for full TX size (1232 byte limit)
  - [x] Fixed overhead: ~400 bytes (signature, header, blockhash, 8 account keys)
  - [x] Per-entry overhead: ~80 bytes (recipient + ATA account keys)
  - [x] Result: 2 settlements per TX for typical proof depths (depth 8+)
- [x] E2E load testing on devnet
  - [x] 201 users settled in 22-second window (burst test)
  - [x] 96 users settled in 10-second window (sustained test)
  - [x] 100% settlement success rate across all tests
  - [x] Settlement jobs tracked in `settlement_jobs` table

### Files Created/Modified
- [x] `packages/contracts/programs/degen-terminal/src/state_v2.rs` (merkle helpers, SettlementBitmap)
- [x] `packages/contracts/programs/degen-terminal/src/instructions/post_merkle_root.rs` (new)
- [x] `packages/contracts/programs/degen-terminal/src/instructions/batch_settle_v2.rs` (new)
- [x] `packages/contracts/programs/degen-terminal/src/instructions/finalize_market_v2.rs` (new)
- [x] `packages/contracts/programs/degen-terminal/src/errors.rs` (added merkle errors)
- [x] `apps/api/src/config.ts` (added useV2 flag)
- [x] `apps/api/src/lib/anchor-client.ts` (added V2 PDA helpers and execute methods)
- [x] `apps/api/src/services/transaction.service.ts` (V2 execute match/close)
- [x] `apps/api/src/jobs/market-creator.ts` (V2 market creation)
- [x] `apps/api/src/jobs/market-activator.ts` (V2 market activation)
- [x] `apps/api/src/jobs/market-resolver.ts` (V2 market resolution)
- [x] `apps/api/src/jobs/merkle-settler.ts` (full settlement pipeline)
- [x] `apps/api/src/lib/merkle-tree.ts` (merkle tree builder)

---

## Phase 6: Fault-Tolerant Multi-Relayer Pool
**Status**: ✅ Complete (Implementation)
**Blocked by**: Phase 3 ✅, Phase 5 ✅
**Blocks**: None
**Completed**: March 2026

Dual-master wallet architecture with auto-generated child fee payers. Child wallets pay SOL TX fees + Jito tips; master wallets remain the relayer authority (SPL Token delegation). Fallback chain: children → master1 → master2.

### Architecture
- **Master 1** (`RELAYER_PRIVATE_KEY`): relayer authority + primary funding source
- **Master 2** (`RELAYER_PRIVATE_KEY_2`): backup funding source + fallback fee payer
- **Child wallets** (DB-stored, auto-generated on boot): primary fee payers (round-robin)
- On-chain constraint: SPL Token only allows 1 delegate per account, so children can't be relayer authorities — only fee payers

### Tasks
- [x] Create `relayer_wallets` table
  - [x] pubkey, secret_key (AES-256-GCM encrypted), balance_lamports, active_jobs, status
  - [x] Circuit breaker fields: consecutive_failures, cooldown_until
- [x] Dual-master config
  - [x] `RELAYER_PRIVATE_KEY_2` env var for backup master
  - [x] `RELAYER_POOL_ENABLED`, `RELAYER_POOL_SIZE`, `RELAYER_MIN_BALANCE_SOL`, etc.
- [x] Auto-generate child wallets on boot
  - [x] `ensurePoolPopulated()` checks DB count vs config, generates missing keypairs
  - [x] Encrypts secret keys with AES-256-GCM before DB storage
  - [x] Immediately funds new wallets from master
- [x] Implement `acquireFeePayer()` — fee payer selection with fallback
  - [x] Round-robin with balance awareness (active children, lowest active_jobs)
  - [x] Fallback chain: child → master1 → master2
  - [x] Circuit breaker: 5 consecutive failures → 60s cooldown
  - [x] Auto-restores wallets from cooldown when timer expires
- [x] Implement auto-funding keeper
  - [x] Monitors all child wallet balances on-chain
  - [x] Tops up from master1 first, then master2 if master1 low
  - [x] Updates stored balance in DB after each check/fund
- [x] Fee payer override in anchor-client
  - [x] `submitTransaction()` accepts `feePayerOverride` keypair
  - [x] Child pays SOL fees + Jito tips; master signs as relayer authority
  - [x] Both signers on the same transaction (Solana supports multi-signer)
- [x] Transaction service passthrough
  - [x] `feePayerKeypair?` added to MatchParams and CloseParams
  - [x] Forwarded to all 4 execute methods (V1/V2 match, V1/V2 close)
- [x] Worker integration
  - [x] Acquires fee payer before each match/close job
  - [x] Releases with success/failure tracking
  - [x] SOL error detection triggers retry with different child wallet
  - [x] Settlement jobs use master directly (no child override)
- [x] Boot initialization
  - [x] Builds master keypair array from env vars
  - [x] Calls `relayerPoolService.init()` + `ensurePoolPopulated()`
  - [x] Logs pool status on startup
- [ ] Load test with multiple relayers on devnet/mainnet

### Files Created/Modified
- [x] `apps/api/src/config.ts` (added `relayerPrivateKey2`, `relayerPool.*` config)
- [x] `apps/api/src/services/relayer-pool.service.ts` (complete rewrite: dual-master, auto-gen, fee payer selection)
- [x] `apps/api/src/lib/anchor-client.ts` (feePayerOverride in submitTransaction, Jito tip from fee payer)
- [x] `apps/api/src/services/transaction.service.ts` (feePayerKeypair in MatchParams/CloseParams)
- [x] `apps/api/src/queue/workers/onchain-submit.worker.ts` (acquireFeePayer, SOL error retry)
- [x] `apps/api/src/index.ts` (boot initialization with pool setup)
- [x] Database table: `relayer_wallets` (exists in Supabase)

---

## Phase 7: Merkle Tree Builder and Settlement Orchestration
**Status**: ✅ Complete (Core Pipeline)
**Blocked by**: Phase 5 ✅, Phase 6 (partial)
**Blocks**: None
**Completed**: February 2026

Full merkle settlement pipeline implemented, tested with 200+ users on devnet.

### Tasks
- [x] Implement MerkleTreeBuilder
  - [x] Query winning positions from DB (by market + outcome)
  - [x] Calculate payouts based on share size
  - [x] Build merkle tree (keccak256 leaves)
  - [x] Generate proofs for each leaf
- [x] Create `settlement_jobs` table
  - [x] market_id, batch_index, recipients, amounts, proofs
  - [x] status (PENDING → SUBMITTED → COMPLETED / FAILED), tx_signature, attempts
- [x] Implement merkle-settler keeper job (`merkle-settler.ts`)
  - [x] Trigger on RESOLVED markets
  - [x] Build tree, post root on-chain via `resolveMarketV2`
  - [x] Create batch jobs (2 settlements per TX due to 1232-byte limit)
  - [x] Enqueue batch-settle jobs to BullMQ `onchain-submit` queue
  - [x] Track settlement_jobs status in DB
  - [x] Finalize market after all batches complete
- [x] Batch-settle via BullMQ worker
  - [x] `executeBatchSettle()` in on-chain submit worker
  - [x] Deserializes Merkle proofs from JSON-safe format
  - [x] Handles `AlreadyClaimed` (idempotent re-settlement)
  - [x] Updates settlement_jobs status on success/failure
- [x] Settlement DB records
  - [x] `settlements` table: per-user payout records with tx_signature, confirmed_at
  - [x] Used for per-user payout timing metrics
- [ ] Update leverage settlement
  - [ ] Include Lending Pool in merkle tree
  - [ ] Create LP distribution job
  - [ ] Distribute profits to margin account holders
- [x] End-to-end testing
  - [x] 201 users settled in 22s (burst test)
  - [x] 96 users settled in 10s (sustained test)
  - [x] 100% settlement success rate
  - [ ] 1000+ users settlement test (not yet)

### Files Created/Modified
- [x] `apps/api/src/jobs/merkle-settler.ts` (full pipeline: tree build → post root → batch settle → finalize)
- [x] `apps/api/src/lib/merkle-tree.ts` (keccak256 tree builder + proof generation)
- [x] `apps/api/src/queue/workers/onchain-submit.worker.ts` (`executeBatchSettle` handler)
- [x] Database migration: `settlement_jobs` table
- [x] Database migration: `settlements` table (per-user payout records)

---

## Progress Tracking

| Phase | Status | Started | Completed | Notes |
|-------|--------|---------|-----------|-------|
| 0 - Instrumentation | ✅ | Jan 2026 | Jan 2026 | Core metrics infrastructure complete |
| 1 - Redis Orderbook | ✅ | Feb 2026 | Feb 2026 | O(log N) Lua-based ops, ZSET+HASH model, sequence delta sync |
| 2 - WebSocket Fanout | ✅ | Feb 2026 | Feb 2026 | Reverse index, 30ms batching, 64KB backpressure |
| 3 - BullMQ Pipeline | ✅ | Feb 2026 | Feb 2026 | 3 queues, rate limiting, write-behind, RPC pool, 20 tx/s burst |
| 4 - Tokenized Shares | ✅ | Jan 2026 | Jan 2026 | All V2 instructions complete, on-chain tests pending |
| 5 - Merkle Settlement | ✅ | Jan 2026 | Feb 2026 | On-chain + API + E2E tested, 100% success rate, 200+ users |
| 6 - Relayer Pool | ✅ | Feb 2026 | Mar 2026 | Dual-master + auto-gen child fee payers, fallback chain, auto-funding |
| 7 - Settlement Orchestration | ✅ | Feb 2026 | Feb 2026 | Full pipeline: tree build → batch settle → finalize |

**Legend**: ⏳ Pending | 🚧 In Progress | ✅ Complete | ❌ Blocked

---

## Testing Milestones

- [ ] **M1**: Redis orderbook handles 10K orders without degradation
- [ ] **M2**: WebSocket broadcasts to 10K connections in <50ms p99
- [x] **M3**: No lost jobs after sustained load (BullMQ durable queue, 0 stuck PENDING)
- [x] **M4**: Tokenized trades work end-to-end on devnet (200 wallets, 644 orders)
- [x] **M5**: Merkle settlement works for 200+ users on devnet (201 users, 100% success)
- [ ] **M6**: 20 relayers settle 1000 users in <30 seconds
- [ ] **M7**: Full system settles 50K users in <5 minutes

### Achieved performance benchmarks (devnet, Feb 2026)

| Benchmark | Target | Achieved | Notes |
|---|---|---|---|
| Burst TX throughput | 10 tx/s | **20.4 tx/s** | 60 orders, Helius Dev + free Solana RPC |
| Sustained TX throughput | 7 tx/s | **7 tx/s** | 503 orders over 3.5 min, zero 429 errors |
| Settlement window | <60s | **10-22s** | 96-201 users, 100% success rate |
| Resolution → last payout | <120s | **76-80s** | Includes keeper intervals + settlement |
| TX confirm time (P50) | <10s | **5.4s** | Devnet; mainnet expected 1-3s |
| Order match rate | >90% | **99.5%** (burst) | 45% sustained (MM liquidity limited) |
| 429 RPC errors | 0 | **0** | After rate limit fix (1s smooth window) |

---

*Last updated: 2026-03-01*
