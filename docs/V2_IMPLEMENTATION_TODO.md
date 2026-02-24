# V2 Implementation TODO

> **Goal**: Scale to 50K+ concurrent users, settle 50K positions in <1 minute
>
> **Status**: 🚧 In Progress — Core pipeline (Phases 0, 3, 4, 5, 7) complete and load-tested
>
> **Started**: January 2026 | **Core pipeline tested**: February 2026

---

## Dependency Graph

```
✅ Phase 0: Instrumentation ──┬──▶ ⏳ Phase 1: Redis Orderbook ──▶ ⏳ Phase 2: WebSocket Fanout
                              │
                              └──▶ ✅ Phase 3: BullMQ Pipeline ──┐
                                                                  │
✅ Phase 4: Tokenized Shares ──▶ ✅ Phase 5: Merkle Settlement ──┼──▶ 🚧 Phase 6: Relayer Pool
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
**Status**: ⏳ Pending
**Blocked by**: Phase 0
**Blocks**: Phase 2

CRITICAL bottleneck - Redis operations do O(N) full scans.

### Tasks
- [ ] Design new Redis data model
  - [ ] ZSET with orderId as member (not composite string)
  - [ ] HASH for order details (`order:{orderId}`)
  - [ ] HASH for aggregated levels (`levels:{market}:{side}`)
  - [ ] Sequence counter for delta sync
- [ ] Implement new orderbook service
  - [ ] `addOrder()` - O(log N) with incremental level update
  - [ ] `removeOrder()` - O(log N) direct removal by orderId
  - [ ] `updateOrder()` - O(log N) with level adjustment
  - [ ] `getSnapshot()` - O(levels) from pre-aggregated data
  - [ ] `getDelta()` - return changes since sequence number
- [ ] Update matching engine to use new service
- [ ] Implement delta broadcasting
  - [ ] Emit deltas with sequence numbers
  - [ ] Client tracks sequence, requests snapshot on gap
- [ ] Migration script for existing orderbook data
- [ ] Performance test: measure ops/sec before and after

### Files to Create/Modify
- [ ] `apps/api/src/services/orderbook-v2.service.ts` (new)
- [ ] `apps/api/src/services/matching.service.ts` (update)
- [ ] `apps/webv2/src/stores/orderbookStore.ts` (delta handling)

---

## Phase 2: WebSocket Fanout Redesign
**Status**: ⏳ Pending
**Blocked by**: Phase 1
**Blocks**: None

HIGH bottleneck - Broadcasts iterate O(all sockets) per message.

### Tasks
- [ ] Implement subscription reverse index
  - [ ] `channelSubscribers: Map<channel, Set<socket>>`
  - [ ] `userSockets: Map<userId, Set<socket>>`
- [ ] Update subscribe/unsubscribe to maintain indexes
- [ ] Update broadcast to use index (O(subscribers))
- [ ] Implement batching for high-frequency channels
  - [ ] Accumulate messages for 25-50ms
  - [ ] Flush batch to subscribers
- [ ] Implement backpressure handling
  - [ ] Track socket buffer size
  - [ ] Drop non-critical messages when buffer full
  - [ ] Flag socket for snapshot on next opportunity
- [ ] Update client to handle batched messages
- [ ] Performance test: measure broadcast latency at 10K connections

### Files to Create/Modify
- [ ] `apps/api/src/services/websocket-v2.service.ts` (new or refactor)
- [ ] `apps/webv2/src/hooks/useWebSocket.ts` (batch handling)

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

## Phase 6: Parallel Relayer Pool
**Status**: 🚧 Scaffolded (single-relayer mode, pool service ready)
**Blocked by**: Phase 3 ✅, Phase 5 ✅
**Blocks**: Phase 7

Service implemented and integrated into on-chain worker. Currently runs with single default relayer — multi-wallet pool ready but not funded/activated.

### Tasks
- [ ] Create `relayer_wallets` table
  - [ ] pubkey, balance_sol, active_jobs, success_rate, status
- [ ] Generate and fund 20 relayer wallets
  - [ ] Script to create keypairs
  - [ ] Script to fund with 0.5 SOL each
- [x] Implement RelayerPool service
  - [x] `acquireRelayer()` - round-robin with load awareness
  - [x] `releaseRelayer(pubkey, success)` - marks as idle, updates stats
  - [x] Circuit breaker: 5 consecutive failures → 60s cooldown
  - [x] `getPoolStatus()` - health overview
  - [x] Falls back to default relayer when pool is empty
- [ ] Implement auto-funding
  - [ ] Monitor balances in background
  - [ ] Fund from master wallet when low
- [x] Integrate with on-chain submit worker
  - [x] Worker acquires relayer before each job
  - [x] Releases relayer after job completes (success/failure tracked)
- [ ] Load test with multiple relayers

### Files Created/Modified
- [x] `apps/api/src/services/relayer-pool.service.ts` (implemented)
- [x] `apps/api/src/queue/workers/onchain-submit.worker.ts` (uses relayer pool)
- [ ] `apps/api/src/scripts/generate-relayers.ts` (not yet)
- [ ] `apps/api/src/scripts/fund-relayers.ts` (not yet)
- [ ] Database migration: `relayer_wallets` table (not yet)

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
| 1 - Redis Orderbook | ⏳ | - | - | Main matching engine bottleneck (~3 orders/s) |
| 2 - WebSocket Fanout | ⏳ | - | - | Not yet a bottleneck at current scale |
| 3 - BullMQ Pipeline | ✅ | Feb 2026 | Feb 2026 | 3 queues, rate limiting, write-behind, RPC pool, 20 tx/s burst |
| 4 - Tokenized Shares | ✅ | Jan 2026 | Jan 2026 | All V2 instructions complete, on-chain tests pending |
| 5 - Merkle Settlement | ✅ | Jan 2026 | Feb 2026 | On-chain + API + E2E tested, 100% success rate, 200+ users |
| 6 - Relayer Pool | 🚧 | Feb 2026 | - | Service scaffolded, single-relayer mode, multi-wallet pending |
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

*Last updated: 2026-02-13*
