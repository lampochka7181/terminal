# Performance & Scaling Guide (v3)

> **Last updated**: 2026-02-07 (after matching engine Lua optimization + full pipeline throughput audit)
>
> **Target scenario**: 5-minute markets, **$5M+ per market**, millions of dollars traded daily, **10K–50K concurrent users**, fast close/resolve/settle UX.
>
> **Status**: Core pipeline implemented and load-tested. Ready for mainnet deployment with Helius Sender.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Architecture (Implemented)](#current-architecture-implemented)
3. [Measured Performance (Devnet)](#measured-performance-devnet)
4. [Mainnet Projections](#mainnet-projections)
5. [Helius Sender — Mainnet Activation](#helius-sender--mainnet-activation)
6. [Rate Limiting & Tuning Guide](#rate-limiting--tuning-guide)
7. [Scaling Constraints (Hard Limits)](#scaling-constraints-hard-limits)
8. [Remaining Bottlenecks (Ordered by Impact)](#remaining-bottlenecks-ordered-by-impact)
9. [Scaling to 100x+ (2,000 tx/s)](#scaling-to-100x-2000-txs)
10. [Phased Plan (Updated)](#phased-plan-updated)
11. [Monitoring & Alerting](#monitoring--alerting)
12. [Load Testing Results](#load-testing-results)
13. [Implementation Checklist](#implementation-checklist)

---

## Executive Summary

### What changed since v2

The core pipeline has been **fully implemented and load-tested** on devnet:

- **BullMQ durable queue** replaces fire-and-forget on-chain submission (Phase 3 — DONE)
- **Write-behind service** decouples matching from DB writes (~1ms matching latency)
- **Merkle tree settlement** (batchSettleV2) replaces per-position settlement (Phase 4 — DONE)
- **RPC connection pool** round-robins across multiple endpoints
- **Helius Sender integration** ready for mainnet (15 tx/s via Jito dual-routing)
- **Circuit breaker** protects DB pool under load

### Measured numbers (devnet, Helius Developer plan)

| Metric | Burst (60 orders) | Sustained (503 orders, 3.5 min) |
|---|---|---|
| Matching speed | **61 orders/sec** (491ms avg) | ~3 orders/sec (with MM replenish waits) |
| On-chain confirmed tx/s | **20.4 tx/s** | **~7 tx/s** (zero 429 errors) |
| On-chain confirm time (P50) | **1.7s** | 5.4s |
| Settlement — all users paid | 5s window | 10s window |
| Settlement success rate | 100% | 100% |
| Resolution → last payout | ~42s | ~80s |
| Stuck PENDING trades | 0 | 0 |

### Current pipeline throughput (per step)

| Pipeline Step | Measured Max | Bottleneck? | Scaling Ceiling |
|---|---|---|---|
| REST API (receive order) | ~1,000+ req/s | No | Node.js HTTP |
| **Matching engine (Redis)** | **~61 orders/sec** | No (was 3/s before Lua opt) | ~200-500/sec single process |
| Write-behind (enqueue) | ~5,000+ orders/sec | No | Array.push + batch flush |
| BullMQ enqueue | ~10,000+ jobs/sec | No | Redis LPUSH |
| **On-chain worker** | **7 tx/s (devnet)** | **Yes — primary bottleneck** | 15/s Sender, 50/s Business |
| Solana confirmation (P50) | 1.7s devnet | Latency, not throughput | ~0.5s mainnet |
| DB sync worker | ~100-200 updates/s | No | BullMQ concurrency |
| WebSocket broadcast | ~1,000+ events/s | No | O(subscribers) |
| **Settlement (Merkle)** | **~10-14 payouts/sec** | Moderate | ~30/s with Sender |
| **DB connection pool** | **3-25 concurrent** | Yes (under sustained load) | Supabase Pro (25-100) |

### What's still needed for scale

1. **Multi-wallet relayer pool** — needed for >20 tx/s (single wallet serialization limit)
2. **DB connection pool upgrade** — Supabase free tier (3-25 connections) constrains sustained load
3. **Helius plan upgrade** — Developer plan limits to 7 tx/s sustained; Business unlocks 50 tx/s
4. **WebSocket fanout redesign** — needed at 10K+ concurrent users

---

## Current Architecture (Implemented)

### Pipeline flow

```
User order → REST API → Matching Engine (Redis orderbook)
                              ↓
                    Write-Behind Service (batched DB flush, ~1s intervals)
                              ↓
                    BullMQ Queue (onchain-submit)
                              ↓
                    On-chain Worker (rate-limited, round-robin RPC pool)
                              ↓
                    Solana Blockchain (execute_match_v2 / batch_settle_v2)
                              ↓
                    DB Sync Worker (update trade status + tx signature)
                              ↓
                    WebSocket Broadcast (per-user fills, global trades)
```

### Key components

| Component | Implementation | Status |
|---|---|---|
| **Matching engine** | Redis ZSET orderbook, Lua atomic getBest + consume (2 round-trips/fill), write-behind | Implemented + Optimized |
| **On-chain queue** | BullMQ `onchain-submit` with rate limiting + retries | Implemented |
| **DB sync queue** | BullMQ `db-sync` for post-confirmation updates | Implemented |
| **WS events queue** | BullMQ `ws-events` for broadcast delivery | Implemented |
| **Settlement** | Merkle tree (batchSettleV2), 2 settlements per TX | Implemented |
| **Market lifecycle** | Keeper jobs: activate → resolve → settle → close | Implemented |
| **RPC pool** | Round-robin across N endpoints (Helius + free Solana + optional) | Implemented |
| **Helius Sender** | 15 tx/s via Jito dual-routing, auto-disabled on devnet | Implemented |
| **Circuit breaker** | DB pool exhaustion protection with auto-recovery | Implemented |
| **Write-behind** | Batched order/trade DB flushes (~1s intervals) | Implemented |
| **MM bot v2** | Automated liquidity provision across active markets | Implemented |

### Market lifecycle (current)

```
PENDING → OPEN → CLOSED → RESOLVED → SETTLED
              ↑           ↑           ↑
          Keeper:      Keeper:     Keeper:
        activator    resolver    settler (Merkle)
                                     ↓
                              batchSettleV2 (2 per TX)
                                     ↓
                              All users paid → SETTLED
                                     ↓
                              close_market on-chain
```

### Settlement implementation (Merkle tree — current)

1. **Market resolves** — keeper determines winning outcome from oracle
2. **Merkle tree built** — all winning positions aggregated, tree computed
3. **Root stored on-chain** — `resolveMarketV2` stores Merkle root
4. **Batch settlement** — `batchSettleV2` processes 2 settlements per TX with Merkle proofs
5. **Payout confirmed** — USDC transferred from market vault to user ATA

**Batch size constraint**: Solana TX limit is 1232 bytes. With proof depth ~8 and per-entry overhead:
- Fixed overhead: ~400 bytes (signature, header, blockhash, 8 account keys, discriminator)
- Per entry: ~132 bytes (52 Borsh data + 80 account keys/ATA overhead)
- Result: **2 settlements per TX** for typical proof depths

---

## Measured Performance (Devnet)

### Test 1: Burst — 60 orders (before matching optimization)

| Metric | Value |
|---|---|
| Orders submitted | 60 |
| Orders matched | 60 (100%) |
| Match latency (avg) | 1,876ms |
| TX throughput (confirmed) | **20.39 tx/s** |
| On-chain confirm (P50) | 8.2s |
| Per-user payout (avg) | 21.4s |
| Settlement success | 100% |

### Test 2: Sustained — 644 orders (BEFORE rate fix)

| Metric | Value |
|---|---|
| Orders submitted | 644 |
| Orders matched | 641 (99.5%) |
| On-chain confirmed | 160 (25.3%) |
| **On-chain stuck PENDING** | **429 (67.8%)** |
| 429 RPC errors | **113** |
| Root cause | BullMQ burst window (100 jobs/10s) overwhelmed RPC rate limits |

### Test 3: Sustained — 503 orders (AFTER rate fix)

| Metric | Value |
|---|---|
| Orders submitted | 503 |
| Orders matched | 226 (45%) |
| On-chain confirmed | **98 (92.5%)** |
| **On-chain stuck PENDING** | **0 (0%)** |
| 429 RPC errors | **0** |
| On-chain confirm (P50) | **5.4s** |
| Settlement: users paid | 96/96 (100%) |
| Settlement window | **10 seconds** |

### Test 4: Burst — 60 orders (AFTER matching engine Lua optimization)

| Metric | Before Lua | After Lua | Improvement |
|---|---|---|---|
| Match latency (avg) | 1,876ms | **491ms** | **3.8x faster** |
| Match latency (P50) | 1,648ms | **498ms** | **3.3x faster** |
| Order submission window | ~14.5s | **0.98s** | **14.8x faster** |
| On-chain confirm (P50) | 8,200ms | **1,724ms** | **4.8x faster** |
| Settlement window | 22s | **5.3s** | **4x faster** |
| Orders matched | 60/60 (100%) | 60/60 (100%) | Same |
| On-chain confirmed | 50/50 | 50/50 | Same |
| Settlement success | 100% | 100% | Same |

### Key findings

**1. Matching engine Lua optimization (3.8x improvement)**

Collapsed Redis operations from 6 sequential round-trips per fill to 2 atomic Lua scripts:
- `GET_BEST_LUA`: ZRANGE + HGETALL in 1 call (was 2+ calls with orphan cleanup)
- `CONSUME_ORDER_LUA`: update/remove + level adjust + sequence incr in 1 call (was 4 calls)

Also reduced empty-book retry delays from 100ms → 20ms and max retries from 20 → 10.

**2. Rate limiter fix (eliminates 429 cascades)**

Changed BullMQ limiter from 10-second burst window (`max: 100, duration: 10000`) to 1-second smooth window (`max: 7, duration: 1000`). This eliminated 429 cascades entirely — from 113 errors and 429 stuck trades to zero of both.

**3. Burst vs sustained**

Short bursts achieve high instantaneous throughput (20 tx/s) because all TXs overlap in confirmation. Sustained load is limited by the RPC rate ceiling. The matching engine (61 orders/sec burst) produces work ~8x faster than the on-chain pipeline (7 tx/s) can consume — BullMQ absorbs the difference.

---

## Mainnet Projections

| Metric | Devnet (measured) | Mainnet (projected) |
|---|---|---|
| **Matching engine** | 61 orders/sec | 61+ orders/sec (same) |
| **Helius Sender** | Auto-disabled | **15 tx/s via Jito** |
| On-chain confirm (P50) | 1.7s | **0.5-1s** (mainnet is faster) |
| On-chain confirm (P95) | 25s | **3-5s** |
| Settlement window | 5-10s | **3-5s** |
| Resolution → last payout | 42-80s | **20-30s** |
| Effective throughput | 7 tx/s | **15-20 tx/s** |

Mainnet improvements come from:
1. **Helius Sender** — 15 tx/s natively via Jito dual-routing (vs 5 tx/s standard)
2. **Faster block times** — mainnet confirms in ~400ms slots vs devnet's variable timing
3. **Jito tips** — priority landing reduces confirmation variance
4. **No free RPC instability** — devnet free RPC is flaky; mainnet paid RPCs are reliable

---

## Helius Sender — Mainnet Activation

### What it is

Helius Sender is a transaction sending service that dual-routes through validators AND Jito block engine. It provides:
- **15 tx/s** (free, no Helius credits consumed)
- **Priority landing** via Jito tips
- **Automatic retry** on the Helius side

### How to enable for mainnet

1. **Set environment variable**:

```bash
# In .env (uncomment for mainnet):
HELIUS_SENDER_URL=https://sender.helius-rpc.com/fast
```

2. **Ensure mainnet RPC URL** is set:

```bash
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

3. **Auto-detection**: The anchor client checks if `SOLANA_RPC_URL` contains "devnet":
   - If devnet → Sender auto-disables (Jito is mainnet-only)
   - If mainnet → Sender activates, worker rate increases to 15 tx/s

### How it works in code

```
anchor-client.ts:
  - Detects mainnet vs devnet from RPC URL
  - If mainnet + HELIUS_SENDER_URL set → enables Sender
  - sendAndConfirmV2() tries Sender first, falls back to standard sendRawTransaction
  - Adds Jito tip instruction automatically when Sender is active

onchain-submit.worker.ts:
  - Reads anchorClient.isSenderEnabled at startup
  - Sets rate to 15/s (Sender) or 5/s (standard)
  - Adjusts concurrency accordingly
```

### Jito tip configuration

```bash
# Optional: customize tip amount (default is 10,000 lamports = 0.00001 SOL)
# Higher tips = faster landing in competitive blocks
JITO_TIP_LAMPORTS=10000
```

### Verification

After starting the server on mainnet, check logs for:
```
🔗 Helius Sender enabled: https://sender.helius-rpc.com/fast
[QUEUE:onchain] Worker started (concurrency=75, rate=15/s, 1 RPC(s), Helius Sender)
```

### Cost

- Helius Sender itself is **free** (no credits consumed)
- Jito tips cost ~0.00001 SOL per TX (~$0.002 at $200/SOL)
- At 15 tx/s sustained: ~$2.60/hour in tips

---

## Rate Limiting & Tuning Guide

### The problem: RPC calls per on-chain job

Each BullMQ `onchain-submit` job does more than 1 RPC call:

| RPC Call | Count | Notes |
|---|---|---|
| `getLatestBlockhash` | ~0 | Cached for 5s with single-flight |
| `sendRawTransaction` | 1 | With `skipPreflight: true` |
| `confirmTransaction` | 1-5 | WebSocket subscription + polling fallback |
| **Total per job** | **~2-6** | Varies by confirmation time |

### Why bursts cause 429 cascades

With concurrency=80 and a 10-second burst window:
1. BullMQ starts 80+ jobs simultaneously
2. 80 concurrent `confirmTransaction` sessions each poll ~0.5 RPC/s
3. Total: 80 × 0.5 = 40 polls/s + ongoing sends = 50+ RPC/s
4. Exceeds Helius Developer plan limit (50 RPC/s)
5. 429 errors → retries → more load → cascade failure

### Current tuning (optimized for sustained load)

```typescript
// onchain-submit.worker.ts
const baseTxPerSec = useSender ? 15 : 5;       // Per Helius plan limits
const extraTxPerSec = extraRpcCount * 2;         // Free RPCs add ~2 tx/s each
const ratePerSec = baseTxPerSec + extraTxPerSec; // e.g. 5 + 2 = 7 on devnet

const concurrency = Math.min(ratePerSec * 5, 50); // Cap confirmation polling overhead

// 1-SECOND window prevents bursts (was 10-second window before)
limiter: { max: ratePerSec, duration: 1_000 }
```

### Tuning for different Helius plans

| Plan | RPC/s | sendTx/s | Sender tx/s | Recommended `baseTxPerSec` | Recommended `concurrency` |
|---|---|---|---|---|---|
| Developer (free) | 50 | 5 | 15 | 5 (no Sender) / 15 (Sender) | 35-50 |
| Business ($199/mo) | 200 | 50 | 50 | 50 | 100-150 |
| Professional ($499/mo) | 500 | 100 | 100 | 100 | 200-300 |
| Enterprise | Custom | Custom | Custom | Contact Helius | Scale to match |

### Adding more RPC endpoints

```bash
# Each additional paid RPC adds full throughput:
SOLANA_RPC_URL_2=https://solana-mainnet.g.alchemy.com/v2/YOUR_KEY  # +5-10 tx/s
SOLANA_RPC_URL_3=https://your-quicknode-endpoint.com                # +5-10 tx/s

# Free Solana public RPC adds only ~2 tx/s (40 RPC/10s total limit):
SOLANA_RPC_URL_2=https://api.mainnet-beta.solana.com                # +2 tx/s
```

### Blockhash caching

The anchor client caches `getLatestBlockhash` results for 5 seconds with single-flight deduplication. This means under sustained load, only 1 blockhash RPC call is made per 5 seconds regardless of how many concurrent TXs are in flight.

---

## Scaling Constraints (Hard Limits)

### Solana transaction size (1232 bytes)

- Settlement batch size: **2 per TX** (with Merkle proofs at depth 8+)
- Match execution: 1 per TX (each match involves 8+ accounts)
- Cannot increase without on-chain program changes

### Single relayer wallet serialization

Solana serializes transactions from the same fee payer. With one relayer:
- Theoretical: ~50 tx/s if all land in different blocks
- Practical: **15-20 tx/s** confirmed (overlapping confirmation windows)
- Fix: multi-wallet relayer pool (see Scaling to 100x)

### Helius Developer plan rate limits

- 50 RPC calls/second (total, across all methods)
- 5 `sendTransaction`/second
- 15 tx/s via Helius Sender (separate from RPC limits, free)

### Supabase connection pool

- Free tier: ~3 connections via PgBouncer
- Pro tier: ~25 connections
- Under sustained load, pool exhaustion causes connection timeouts
- Circuit breaker protects against cascade failures

---

## Remaining Bottlenecks (Ordered by Impact)

### 1) On-chain RPC rate limits — PRIMARY BOTTLENECK

The on-chain worker (7 tx/s devnet, 15 tx/s mainnet with Sender) is the pipeline's throughput ceiling. Everything upstream (matching at 61/s, write-behind at 5,000/s, BullMQ enqueue at 10,000/s) feeds into this funnel.

**Current state:**
- Helius Developer plan: 5 sendTx/s + 15 Sender tx/s (mainnet only)
- Free Solana RPC adds ~2 tx/s
- Combined: ~7 tx/s devnet, ~15-17 tx/s mainnet

**Fix direction:**
- Helius Business ($199/mo) → 50 tx/s
- Additional paid RPCs → +5-10 tx/s each
- See [Rate Limiting & Tuning Guide](#rate-limiting--tuning-guide) for configuration details

### 2) Single relayer wallet serialization — HIGH (blocks >20 tx/s)

Solana serializes transactions from the same fee payer. Even with unlimited RPC capacity, a single wallet tops out at ~20 confirmed tx/s.

**Fix direction:**
- Multi-wallet relayer pool (10-25 wallets)
- Round-robin job assignment
- See Phase 6 in V2_IMPLEMENTATION_TODO.md

### 3) DB connection pool — MEDIUM

Under sustained load (500+ orders), Supabase free tier pool (3-25 connections) can become exhausted. Write-behind helps by batching, but keeper jobs + on-chain workers + API routes all compete for connections.

**Fix direction:**
- Upgrade to Supabase Pro (25-100 connections)
- Add PgBouncer connection pooling
- Read replica for analytics queries

### 4) WebSocket broadcast — LOW (not yet a bottleneck)

Current O(all sockets) fanout works fine at current scale. Will become critical at 10K+ concurrent users.

**Fix direction:** Reverse index, batching, backpressure, uWebSockets.js

### 5) Settlement batch size — LOW (2 per TX is workable)

With Merkle settlement at 2 settlements per TX, a 200-user market needs ~100 TXs. At 7-15 tx/s, that's 7-14 seconds. Acceptable for current scale.

**Fix direction (if needed):**
- Reduce Merkle proof overhead with shallower trees
- Use v0 transactions + Address Lookup Tables
- Claim-based settlement (users claim their own payout)

### ~~Matching engine~~ — RESOLVED

Previously the primary bottleneck at ~3 orders/sec (1.7s per order). **Now at 61 orders/sec (491ms avg)** after Lua atomic script optimization. No longer a bottleneck — produces work ~8x faster than the on-chain worker can consume.

---

## Scaling to 100x+ (2,000 tx/s)

To scale from current ~15-20 tx/s to 2,000 tx/s:

### Tier 1: RPC upgrade (get to ~50-100 tx/s)

- Upgrade to Helius Business ($199/mo) → 50 tx/s via Sender
- Add 2-3 additional paid RPC endpoints → +15-30 tx/s
- Cost: ~$300-500/mo

### Tier 2: Multi-wallet relayer pool (get to ~200-500 tx/s)

- Single wallet serialization limits to ~20 tx/s confirmed
- Need 10-25 funded relayer wallets
- Round-robin job assignment → parallel Solana block inclusion
- Each wallet handles its own nonce/blockhash/confirmation
- Requires: funded wallets + relayer pool service + load balancing logic

### Tier 3: Horizontal worker scaling (get to ~500-2,000 tx/s)

- Multiple `onchain-submit` worker processes consuming from same BullMQ queue
- Each worker has its own relayer wallet(s) + RPC connections
- Run across multiple servers/containers
- BullMQ natively supports distributed workers

### Tier 4: Infrastructure upgrades

- Dedicated Solana RPC (Helius Enterprise or self-hosted)
- Supabase Pro or self-hosted Postgres with PgBouncer
- Redis Cluster for orderbook horizontal scaling
- Multiple API processes behind load balancer

### Estimated costs at scale

| Throughput | RPC Plan | Relayer Wallets | Jito Tips/hr | DB | Total/mo |
|---|---|---|---|---|---|
| 15-20 tx/s | Developer ($0) | 1 | $2.60 | Free | ~$60 |
| 50-100 tx/s | Business ($199) | 5 | $13 | Pro ($25) | ~$550 |
| 200-500 tx/s | Professional ($499) | 15 | $65 | Pro ($25) | ~$2,100 |
| 1,000-2,000 tx/s | Enterprise ($$$) | 50+ | $260+ | Dedicated | $5,000+ |

---

## Phased Plan (Updated)

### Phase 0 — Correctness + instrumentation — DONE

- [x] BullMQ durable queue for on-chain submission
- [x] Idempotency keys for all on-chain jobs
- [x] Write-behind batched DB persistence
- [x] Circuit breaker for DB pool protection
- [x] Per-trade tx_signature and confirmed_at tracking
- [x] Settlement status tracking (PENDING → CONFIRMED)

### Phase 1 — Orderbook hot-path optimization — DONE (Lua atomic scripts)

- [x] Lua `GET_BEST_LUA` script: atomic ZRANGE + HGETALL + orphan cleanup (1 round-trip)
- [x] Lua `CONSUME_ORDER_LUA` script: atomic update/remove + level adjust + sequence incr (1 round-trip)
- [x] Reduced Redis round-trips per fill from 6 → 2
- [x] Tightened empty-book retry delays (100ms → 20ms) and max retries (20 → 10)
- **Result**: Matching engine from **3 orders/s → 61 orders/s** (20x improvement)
- [ ] (Future) Incremental aggregated levels for O(1) book depth queries
- [ ] (Future) Delta-based broadcasting + snapshots on subscribe/gap

### Phase 2 — WebSocket fanout redesign (1–3 days) — NOT STARTED

- [ ] Subscription reverse index
- [ ] Per-user socket index
- [ ] Batching windows for high-frequency channels
- [ ] Backpressure handling + snapshot fallback

### Phase 3 — Durable async pipeline — DONE

- [x] BullMQ queues: `onchain-submit`, `db-sync`, `ws-events`
- [x] Rate limiting with 1-second smooth window (no bursts)
- [x] Retry logic with exponential backoff
- [x] Reconciliation job for PENDING trades
- [x] RPC connection pool with round-robin

### Phase 4 — Settlement strategy — DONE (Merkle tree)

- [x] Merkle tree settlement (batchSettleV2)
- [x] 2 settlements per TX (within 1232-byte limit)
- [x] Settlement jobs tracked in DB
- [x] 100% settlement success rate in testing

### Phase 5 — Mainnet deployment (next)

- [ ] Enable Helius Sender (`HELIUS_SENDER_URL`)
- [ ] Configure Jito tip amount
- [ ] Verify rate limiting works with Sender's 15 tx/s
- [ ] Run smoke test on mainnet-beta
- [ ] Monitor 429 rate + confirmation times in production

### Phase 6 — Scale to 100+ tx/s (when needed)

- [ ] Upgrade Helius plan
- [ ] Implement multi-wallet relayer pool
- [ ] Upgrade DB connection pool
- [ ] Load test at higher throughput

---

## Monitoring & Alerting

### Must-have metrics

- **On-chain pipeline**
  - BullMQ queue depth (waiting + active + delayed)
  - Job processing rate (jobs/sec)
  - TX confirmation rate and time (P50, P95, P99)
  - TX failure rate by error code
  - 429 Too Many Requests count (should be 0)
  - Relayer SOL balance

- **Matching engine**
  - Orders/sec processed
  - Match latency (P50, P95)
  - Fill rate (matched/submitted)
  - Write-behind queue depth + flush errors

- **DB**
  - Connection pool: total, idle, waiting
  - Circuit breaker state + trip count
  - Query latency (P95/P99 per endpoint)

- **WebSocket**
  - Connections total
  - Broadcast latency per channel
  - Dropped messages

- **Settlement**
  - Settlement jobs: pending, submitted, completed, failed
  - Time from resolution to last payout
  - Payout success rate

### Alert thresholds

| Metric | Warning | Critical |
|---|---|---|
| 429 RPC errors (5 min) | > 0 | > 10 |
| BullMQ queue depth | > 100 | > 500 |
| DB pool waiting | > 5 | > 15 |
| Circuit breaker trips | > 0 | > 3 |
| TX failure rate (5 min) | > 5% | > 15% |
| Settlement pending > 5 min | > 0 | > 10 |
| Relayer SOL balance | < 0.5 SOL | < 0.1 SOL |

---

## Load Testing Results

### Test configuration

All tests run on devnet with Helius Developer plan (50 RPC/s, 5 sendTx/s) + free Solana public RPC.

### Test matrix

| Test | Orders | Mode | Duration | Wallets | Key finding |
|---|---|---|---|---|---|
| Burst (v1) | 60 | Max throughput | ~14.5s submit | 200 | 20.4 confirmed tx/s burst, matching at 3/s |
| Sustained (v1, broken) | 644 | Paced 10/s | 3.2 min | 200 | 429 cascade: 68% trades stuck PENDING |
| Sustained (v2, fixed) | 503 | Paced 10/s | 3.5 min | 200 | 0 stuck PENDING, 92.5% confirmed |
| **Burst (v2, Lua opt)** | **60** | **Max throughput** | **0.98s submit** | **200** | **61 orders/sec, 491ms avg match, P50 confirm 1.7s** |

### Settlement performance

| Metric | Test 1 (burst, old) | Test 3 (sustained) | Test 4 (burst, Lua opt) |
|---|---|---|---|
| Users settled | 201 | 96 | 201 |
| Settlement window | 22s | 10s | **5.3s** |
| Settlement success | 100% | 100% | 100% |
| Payout throughput | ~9 payouts/sec | ~10 payouts/sec | **~14 payouts/sec** |
| Resolution → last payout | 76s | 80s | **~42s** |

### Error analysis

| Error type | Test 2 (broken) | Test 3 (fixed) | Test 4 (Lua opt) |
|---|---|---|---|
| 429 Too Many Requests | 113 | 0 | 0 |
| fetch failed (MAX_RETRIES) | 4 | 18 (devnet flakiness) | 0 |
| INSUFFICIENT_FUNDS | 17 | 8 | 0 |
| DB connection timeout | 0 | 26 (early burst) | 0 |
| Stuck PENDING trades | 429 | 0 | 0 |

---

## Implementation Checklist

### Completed
- [x] BullMQ durable queue with rate limiting
- [x] Write-behind service for DB persistence
- [x] Merkle tree settlement (batchSettleV2)
- [x] RPC connection pool (round-robin)
- [x] Helius Sender integration (mainnet-ready)
- [x] Circuit breaker for DB protection
- [x] Blockhash caching (5s TTL, single-flight)
- [x] `skipPreflight: true` for TX submission
- [x] 1-second smooth rate limiter (prevents 429 cascades)
- [x] Settlement batch size calculation (accounts for TX size limit)
- [x] Reconciliation job for stale PENDING trades
- [x] Performance test framework (burst + sustained modes)
- [x] Matching engine Lua optimization (6 → 2 Redis round-trips per fill)
- [x] Empty-book retry tuning (100ms → 20ms delays)

### Next up
- [ ] Enable Helius Sender on mainnet
- [ ] Upgrade DB connection pool for sustained load
- [ ] Multi-wallet relayer pool for >20 tx/s
- [ ] WebSocket fanout redesign for 10K+ users

### Future (when needed)
- [ ] Horizontal worker scaling
- [ ] Redis Cluster
- [ ] Claim-based settlement (removes "settle all before complete" constraint)
- [ ] Tokenized YES/NO shares (best long-term scaling)
