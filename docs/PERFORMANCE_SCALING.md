# Performance & Scaling Guide (v2)

> **Target scenario**: 15-minute market, **$5M+ per market**, millions of dollars traded daily, **10K–50K concurrent users**, fast close/resolve/settle UX.
>
> **Status**: 📋 Planning → Execution
>
> **This doc is intentionally “codebase-aware”**: it describes what the repo actually does today, what will break at scale, and which architectural changes are required for “fast settlement”.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Reality Check: What the Codebase Does Today](#reality-check-what-the-codebase-does-today)
3. [Scaling Constraints (Hard Limits)](#scaling-constraints-hard-limits)
4. [Bottlenecks (Ordered by Impact)](#bottlenecks-ordered-by-impact)
5. [Target Architecture (Two Tracks)](#target-architecture-two-tracks)
6. [Phased Plan](#phased-plan)
7. [Monitoring & Alerting](#monitoring--alerting)
8. [Load Testing Plan](#load-testing-plan)
9. [Implementation Checklist](#implementation-checklist)

---

## Executive Summary

### The uncomfortable truth

If you want **fast settlement** for **thousands of users** in high-volume markets, the current on-chain settlement state machine is the ceiling:

- On-chain settlement today (`settle_positions`) is **1 position PDA per instruction**, and the market only reaches **`Settled`** after **every position** is processed.
- That means the system’s “market completion time” scales with **number of positions**, not with compute you add to the backend.

### The biggest missing levers (must add)

1. **Settlement redesign** (required for “fast settlement at scale”):
   - **Claim-based settlement** (pull model) *or*
   - **Tokenized shares + redeem** (best long-term) *or*
   - A new on-chain **batch settlement instruction** (medium-term relief, still linear).

2. **Orderbook hot path redesign** (required for high TPS off-chain matching):
   - Current Redis operations do multiple **`zrange 0..-1` scans** for remove/update/snapshot, which becomes a CPU + network killer.
   - Fix the data model so remove/update is O(log N) without scanning, and snapshots aren’t full scans.

3. **WebSocket fanout redesign** (required for high concurrency):
   - Current broadcast iterates **all sockets** for each channel message.
   - Add reverse indexes + batching + backpressure; consider `uWebSockets.js` if pushing 50K+.

4. **Durable async pipeline** (required for correctness under load):
   - “Fire-and-forget” background tasks will cause dropped work on restarts and makes reconciliation expensive.
   - Add a queue and idempotency for on-chain submission + DB post-processing + WS events.

### Outcome you should expect after implementing this doc

- **Short-term (days)**: significant latency improvements (WS + Redis + DB), fewer timeouts, safer operations.
- **Medium-term (1–2 weeks)**: stable 10K+ concurrent users with predictable performance.
- **Long-term (2–4+ weeks)**: settlement becomes “fast” at scale by removing the “settle everyone before market completes” requirement.

---

## Reality Check: What the Codebase Does Today

### Backend topology (today)

- Single API process handles:
  - REST + WebSocket server
  - Matching engine (Redis-backed orderbook)
  - Keeper jobs (market lifecycle, settlement, order expiry, liquidation)
  - Solana relayer transaction submission
- Postgres (Supabase) is used for persistence + analytics.
- Redis is used for orderbook and some caches.

### Market lifecycle (today)

From `STATE_MACHINES.md`:

- `OPEN → CLOSED → RESOLVED → SETTLED` (then `close_market`).
- **Important**: `RESOLVED → SETTLED` currently implies “all positions paid out”.

### Settlement implementation (today)

- Market resolver job pipelines: starts on-chain resolve, **pre-fetches settlement data**, then triggers settlement immediately.
- Position settler job builds DB settlement rows and calls an “API-side batch” method that actually sends **multiple on-chain settle txs**.

### WebSocket implementation (today)

- Clients subscribe to channels like:
  - `orderbook:{marketPubkey}`, `trades:{marketPubkey}`, `prices:{asset}`, `market:{marketPubkey}`, plus per-user channel after JWT auth.
- Broadcast fanout is currently **O(total connected sockets)** per message.

### Redis orderbook (today)

- ZSET member is a composite string containing order id + size + timestamp.
- Remove/update frequently scans entire ZSET to find the member matching an order id.
- Snapshot builds aggregated levels by `zrange 0..-1 WITHSCORES` and aggregating in JS.

---

## Scaling Constraints (Hard Limits)

These constraints drive the architecture you need.

### Solana transaction size + account limits

Even with v0 transactions and lookup tables, there are limits:

- **Bytes**: transaction size and account metadata overhead cap how many “settle position” style accounts fit per tx.
- **Compute**: the compute unit limit caps how much you can do in one instruction.
- **Account closure**: your current `settle_positions` closes the position PDA; any batching must handle closing safely and deterministically.

**Implication:** “Just increase batch size to 50” is not a reliable plan unless the on-chain program supports it, or you use ALT/v0 and validate compute.

### WebSocket fanout

Node’s event loop can be dominated by:

- iterating sockets
- JSON serialization
- slow-client backpressure

**Implication:** fanout must be indexed, batched, and backpressured.

### Redis CPU/network

At scale, `zrange 0..-1` on hot keys becomes a bottleneck even if Redis is “fast”.

**Implication:** fix orderbook primitives before load testing large user counts.

---

## Bottlenecks (Ordered by Impact)

### 1) Settlement completion time is linear in number of positions (CRITICAL)

**Why this matters:** you can’t “scale servers” to settle faster if the chain must process N positions.

#### Options

- **Option A: Claim-based settlement (recommended)**
  - Market becomes “resolved” quickly.
  - Users claim their payout on demand (or a third party claims for them).
  - Market completion is not blocked on settling every position PDA.
  - UX: winners see payout quickly when they claim; you can auto-claim for active users via service.

- **Option B: Tokenized YES/NO shares + redeem (best long-term)**
  - Positions represented as SPL tokens.
  - Settlement is redeeming winning token for USDC.
  - Removes “position PDA per user” bottleneck and simplifies secondary market mechanics.

- **Option C: Batch settlement instruction**
  - Add a single instruction that settles many positions using remaining accounts.
  - Still linear overall, but fewer transactions.
  - Requires careful compute budget, account ordering, and failure handling.

### 2) Redis orderbook implementation does full scans (CRITICAL)

**Symptoms at scale:**

- remove/update operations scan `zrange 0..-1` to locate members
- snapshots scan full zsets and aggregate in JS
- frequent full snapshot broadcasts amplify costs

**Fix direction:**

- Make ZSET member = `orderId` (stable, removable without scanning)
- Store order details in hash (size, createdAt, etc.)
- Maintain aggregated price levels incrementally (hash `level:{price} -> {size,count}`) so snapshots become O(levels), not O(orders)
- Broadcast deltas; only send snapshots on subscribe or detected sequence gaps

### 3) WebSocket broadcast is O(all sockets) (HIGH)

**Fix direction:**

- Maintain reverse index:
  - `channel -> Set<socket>`
  - `userId -> Set<socket>`
- Add batching window (e.g. 25–50ms) per channel
- Add per-socket backpressure strategy:
  - if socket send buffer grows, drop non-critical messages (orderbook deltas) and force client to request snapshot
- Consider `uWebSockets.js` if aiming for 50K+ persistent connections in one process

### 4) “Fire-and-forget” background work is not durable (HIGH)

You currently do:

- on-chain submissions in background
- DB post-processing in background

Under process crash/restart you can lose in-flight work.

**Fix direction:**

- Use a queue (BullMQ/Redis Streams/NATS JetStream/Kafka) for:
  - on-chain submission jobs
  - DB reconciliation jobs
  - WS event emission jobs
- Make everything idempotent with stable keys:
  - `match_id`, `settlement_id`, `order_id`, `market_id`

### 5) DB pool + query shape (MEDIUM, but will hurt)

Increasing pool size helps only until:

- you saturate Supabase pooler
- you spend most time waiting for DB

**Fix direction:**

- aggressively reduce hot read patterns (`/user/positions`, markets list)
- cache short-lived hot data
- add read replica routing if needed

### 6) Matching timeouts (walk-the-book) create partial fills under thin liquidity (MEDIUM, but user-visible)

The matching engine has an explicit **total matching time cap** to prevent requests from hanging when the book is empty or the MM is replenishing slowly:

- Buy (dollar-based MARKET) matching: `MAX_MATCHING_TIME_MS = 5000`
- Sell matching: `MAX_MATCHING_TIME_MS = 5000`
- Retry behavior while empty: `MAX_RETRIES = 20`, `RETRY_DELAY_MS = 100ms` (≈ 2 seconds of “wait for MM” inside the overall cap)

**User-visible behavior:**

- Orders can return **partially filled** with **unfilled dollars / remaining size** when the timeout is hit.
- Logs like: “Matching timeout after 5000ms, remaining $X” are expected if the orderbook is thin or MM replenishment is lagging.

**Scaling guidance:**

- Under high load, increasing this timeout increases tail latency and can amplify load (more concurrent matching loops).
- If you need higher fill ratios without raising timeout, prefer:
  - faster MM replenishment loop / tighter quoting
  - deeper resting liquidity
  - better orderbook primitives (remove full scans) so matching iterations are cheaper
  - splitting large market orders into bounded chunks server-side

---

## Target Architecture (Two Tracks)

You should pick one track for settlement. Everything else (WS + Redis + durable queue) is common.

### Track 1: Minimal contract changes (fastest to ship)

- Keep existing `settle_positions` instruction
- Improve throughput with:
  - v0 tx + Address Lookup Tables
  - better chunking + concurrency + per-tx signature tracking
  - optional batch settlement instruction if feasible
- Accept that “market fully settled” still scales with number of positions

### Track 2: Settlement redesign (recommended for your target scale)

- Introduce one of:
  - claim-based settlement
  - tokenized shares + redeem
- Update state machine:
  - market “completion” no longer depends on settling all positions
  - `close_market` gating changes accordingly

---

## Phased Plan

Time estimates assume one strong engineer focused; adjust if parallelizing.

### Phase 0 — Correctness + instrumentation (0.5–1 day)

- Fix correctness gaps that will poison load test results:
  - multi-transaction settlement must record the correct signature(s) per settlement row
  - any “batch” method that actually emits multiple txs must expose that truth for monitoring
- Add the metrics you’ll need to know what to optimize next:
  - WS fanout time per channel
  - Redis hot-key ops/second + latency
  - DB pool waiting + query p95/p99 per endpoint
  - on-chain submission queue depth + success rate

### Phase 1 — Orderbook hot-path redesign (1–3 days)

**Goal:** remove full scans from Redis and stop broadcasting huge snapshots.

- Change Redis orderbook representation so update/remove is O(log N), not O(N):
  - stable ZSET members
  - order details in hash
- Add aggregated price-level storage maintained incrementally
- Broadcast deltas + sequence ids
- Client snapshot only:
  - on subscribe
  - on gap detection
  - on backpressure-triggered drop

**Expected impact:** 10–50x lower Redis + network pressure under load.

### Phase 2 — WebSocket fanout redesign (1–3 days)

**Goal:** broadcasts scale with subscribers, not total connections.

- Add subscription reverse index
- Add per-user socket map
- Add batching window for high frequency channels
- Add backpressure handling + snapshot fallback

**Expected impact:** large drop in event loop stalls and broadcast latency.

### Phase 3 — Durable async pipeline (2–5 days)

**Goal:** no lost work, predictable retries, and clean operational visibility.

- Introduce a queue for:
  - submit on-chain tx
  - confirm on-chain tx
  - update DB post-confirmation
  - emit WS events
- Add idempotency keys to every job payload
- Add a reconciliation job that:
  - finds PENDING trades/settlements older than X
  - re-checks chain
  - replays missing DB/WS updates

### Phase 4 — Settlement strategy (choose one)

#### 4A) Throughput improvements without redesign (2–7 days)

- Use v0 transactions + ALTs to increase “positions per tx” safely
- Add parallelism:
  - multiple relayer wallets (funded and rate-limited)
  - bounded concurrency waves
- Fix signature accounting end-to-end

**Reality:** this makes settlement *faster*, but still linear in number of positions.

#### 4B) Claim-based settlement (1–3 weeks, recommended)

**Concept:**

- Market resolves quickly on-chain.
- Users claim payout themselves:
  - `claim(position)` transfers from vault and closes the position PDA (or marks it claimed).
- Market can be “finalized” independently of claiming all positions:
  - optional: after a deadline, sweep leftover vault to treasury and close accounts.

**Pros:**
- “Fast settlement UX” for active users (they can claim instantly)
- avoids centralized keeper bottleneck

**Cons:**
- requires on-chain changes + careful economics (fees, dust, unclaimed funds)

#### 4C) Tokenized shares + redeem (2–6+ weeks, best long-term)

**Concept:**

- YES/NO shares are SPL tokens.
- Trading results in token transfers, not PDA updates per user.
- Settlement is redeeming winning token for USDC.

**Pros:**
- scales best
- simpler settlement mechanics

**Cons:**
- significant protocol redesign + migration concerns

---

## Monitoring & Alerting

### Must-have metrics (minimum)

- **WS**
  - connections total
  - broadcast latency per channel
  - dropped messages due to backpressure
  - snapshot requests due to gaps

- **Redis**
  - ops/sec, latency p95/p99
  - hot keys (orderbook keys) latency
  - memory usage

- **DB**
  - pool waiting count
  - query p95/p99 per endpoint (positions, markets, orders)

- **Solana**
  - tx submit rate, confirm rate, failure reasons
  - retries per tx
  - time-to-confirm distribution

### Alert thresholds (starter)

- DB pool waiting > 20 for > 30s
- WS broadcast p99 > 100ms
- Redis p99 > 10ms on orderbook keys
- Solana tx failure rate > 5% (rolling 5 min)

---

## Load Testing Plan

### Scenarios

1. **WS-only scale test**
   - 10K → 50K sockets subscribed to one market orderbook + trades
   - Validate broadcast latency + drop behavior + snapshot fallback

2. **Order flood test**
   - sustained market orders + limit orders across multiple markets
   - validate Redis orderbook CPU/network and event loop health

3. **Market close/resolve/settle storm**
   - many markets expiring in a narrow window
   - validates keeper/queue behavior and DB pressure shielding

### Success criteria

- WS broadcast p99 < 50ms at 10K, < 100ms at 50K
- API p99 < 500ms under expected traffic
- No cascading failures when DB is under pressure (graceful degradation)
- Settlement completion time meets target for chosen settlement track

---

## Implementation Checklist

### Phase 0
- [ ] Add metrics (WS/Redis/DB/Solana)
- [ ] Fix multi-tx settlement signature accounting and per-position tx tracking
- [ ] Add reconciliation loop for PENDING trades/settlements

### Phase 1 (Redis orderbook)
- [ ] Redesign zset members to avoid full scans
- [ ] Maintain incremental aggregated levels
- [ ] Delta-based broadcasting + snapshots on subscribe/gap

### Phase 2 (WebSocket)
- [ ] Subscription reverse index
- [ ] Per-user socket index
- [ ] Batching windows for high-frequency channels
- [ ] Backpressure handling + snapshot fallback
- [ ] Evaluate `uWebSockets.js` if aiming for 50K+ per process

### Phase 3 (Durable async)
- [ ] Introduce job queue for on-chain submission + DB/WS side effects
- [ ] Idempotency keys and safe retries everywhere
- [ ] Reconciliation job

### Phase 4 (Settlement)
- [ ] Choose track: (4A) throughput only, (4B) claim-based, or (4C) tokenized shares
- [ ] Update `STATE_MACHINES.md` accordingly
- [ ] Implement and load test end-to-end


