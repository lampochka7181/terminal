# Degen Terminal V2 - System Architecture

> **Status**: 📋 Design Document
>
> **Goal**: Scale to 50K+ concurrent users, settle 50K positions in <1 minute, support millions of dollars in daily volume.
>
> **Key Changes from V1**:
> - Tokenized YES/NO shares (SPL tokens) instead of Position PDAs
> - Merkle-based batch settlement with parallel relayers
> - Redis orderbook hot-path redesign (O(log N) operations)
> - WebSocket fanout redesign (indexed broadcasts)
> - Durable async pipeline (BullMQ)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [V2 System Overview](#2-v2-system-overview)
3. [Tokenized Shares Model](#3-tokenized-shares-model)
4. [Settlement Architecture](#4-settlement-architecture)
5. [Redis Orderbook Redesign](#5-redis-orderbook-redesign)
6. [WebSocket Fanout Redesign](#6-websocket-fanout-redesign)
7. [Durable Async Pipeline](#7-durable-async-pipeline)
8. [Leverage Integration](#8-leverage-integration)
9. [Migration Strategy](#9-migration-strategy)
10. [Implementation Phases](#10-implementation-phases)

---

## 1. Executive Summary

### The V1 Problem

V1's settlement model is **linear in the number of positions**:
- `settle_positions` processes 1 Position PDA per instruction
- Market only reaches `SETTLED` after **every position** is processed
- With 50K positions at 1 tx/sec = **~14 hours** to settle

### The V2 Solution

V2 introduces three architectural changes that enable **sub-1-minute settlement for 50K users**:

1. **Tokenized Shares**: YES/NO as SPL tokens (not Position PDAs)
2. **Merkle Batch Settlement**: Post payout merkle root, batch 15 settlements per tx
3. **Parallel Relayers**: 20-50 funded wallets submitting settlements concurrently

### Expected Outcomes

| Metric | V1 | V2 |
|--------|----|----|
| Settlement time (50K users) | ~14 hours | **<1 minute** |
| Max concurrent users | ~5K | **50K+** |
| Redis ops per order update | O(N) scan | **O(log N)** |
| WS broadcast per message | O(all sockets) | **O(subscribers)** |
| Background job durability | Fire-and-forget | **Durable queue** |

---

## 2. V2 System Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           DEGEN TERMINAL V2                                      │
└─────────────────────────────────────────────────────────────────────────────────┘

     ┌──────────────┐                              ┌──────────────────┐
     │    TRADER    │                              │   MARKET MAKER   │
     │   (Browser)  │                              │      (Bot)       │
     └──────┬───────┘                              └────────┬─────────┘
            │                                               │
            │  HTTPS/WSS                          HTTPS API │
            ▼                                               ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (React/Vite)                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐       │
│  │   Charts    │  │  Orderbook  │  │   Trading   │  │  Wallet Connect │       │
│  │ (TradingView)│  │    View    │  │    Form     │  │    (Phantom)    │       │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘       │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │
                    REST API + WebSocket (Indexed Fanout)
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                          BACKEND (Relayer Cluster)                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐       │
│  │ API Gateway │  │  Orderbook  │  │  Matching   │  │  Job Queue      │       │
│  │   (REST)    │  │ (Redis V2)  │  │   Engine    │  │  (BullMQ)       │       │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘       │
│                                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │                    PARALLEL RELAYER POOL                               │   │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ... ┌────────┐           │   │
│  │  │Relayer1│ │Relayer2│ │Relayer3│ │Relayer4│     │Relayer20│          │   │
│  │  │ 0.5SOL │ │ 0.5SOL │ │ 0.5SOL │ │ 0.5SOL │     │ 0.5SOL  │          │   │
│  │  └────────┘ └────────┘ └────────┘ └────────┘     └────────┘           │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│  ┌─────────────────────────────┐  ┌───────────────────────────────────────┐   │
│  │   Redis (V2 Orderbook)      │  │   PostgreSQL (Persistent + Queue)     │   │
│  │   • O(log N) operations     │  │   • Orders, Trades, Positions         │   │
│  │   • Incremental levels      │  │   • Settlement Jobs (BullMQ)          │   │
│  │   • Delta broadcasting      │  │   • Merkle Trees                      │   │
│  └─────────────────────────────┘  └───────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────────┘
                                │
                         RPC (Solana TX)
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                         SOLANA BLOCKCHAIN (V2)                                │
│                                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │                    DEGEN PROGRAM V2 (Anchor)                          │   │
│  │                                                                       │   │
│  │  NEW: Tokenized Shares Model                                          │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐    │   │
│  │  │   YES Token     │  │    NO Token     │  │   USDC Vault        │    │   │
│  │  │   (SPL Mint)    │  │   (SPL Mint)    │  │      (PDA)          │    │   │
│  │  │   per market    │  │   per market    │  │                     │    │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────┘    │   │
│  │                                                                       │   │
│  │  NEW: Merkle Batch Settlement                                         │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │   │
│  │  │  post_merkle_root(root, total_payouts)                          │  │   │
│  │  │  batch_settle_with_proof(proofs[15], recipients[15], amounts[15])│  │   │
│  │  │  finalize_market() - after all settlements                       │  │   │
│  │  └─────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Tokenized Shares Model

### 3.1 Concept

Instead of tracking positions in PDAs (one per user per market), V2 represents positions as **SPL tokens**:

| V1 (Position PDAs) | V2 (Tokenized Shares) |
|--------------------|----------------------|
| 1 PDA per user per market | Users hold YES/NO tokens in their ATAs |
| `yes_shares`, `no_shares` fields | Token balance = position size |
| Settlement updates PDA | Settlement redeems tokens |
| Can't transfer positions | Positions are transferable tokens |

### 3.2 Token Architecture

Each market has two SPL token mints:

```
Market: BTC-5m-12:00
├── YES Token Mint: YesBTC5m1200...
│   └── Mint Authority: Market PDA
├── NO Token Mint:  NoBTC5m1200...
│   └── Mint Authority: Market PDA
└── USDC Vault: stores collateral
```

### 3.3 Trade Execution Flow (Opening Trade)

**V1 Flow (Position PDA)**:
```
execute_match:
├── Transfer USDC from buyer → Vault
├── Transfer USDC from seller → Vault
├── Update buyer's Position PDA (yes_shares += size)
├── Update seller's Position PDA (no_shares += size)
└── Increment market.total_positions
```

**V2 Flow (Tokenized)**:
```
execute_match:
├── Transfer USDC from buyer → Vault
├── Transfer USDC from seller → Vault
├── Mint YES tokens to buyer's ATA
├── Mint NO tokens to seller's ATA
└── Increment market.open_interest
```

### 3.4 Trade Execution Flow (Closing Trade)

When a YES holder sells to someone:

**V1 Flow**:
```
execute_close:
├── Transfer buyer's USDC → seller
├── Update buyer's Position PDA (yes_shares += size)
├── Update seller's Position PDA (yes_shares -= size)
└── (Seller's PDA might still exist with 0 shares)
```

**V2 Flow**:
```
execute_close:
├── Transfer buyer's USDC → seller
├── Transfer YES tokens from seller → buyer
└── No minting/burning (just token transfer)
```

### 3.5 On-Chain Account Structure

```rust
// Market account (similar to V1, with token mint references)
pub struct MarketV2 {
    pub pubkey: Pubkey,
    pub asset: String,
    pub duration_minutes: u16,
    pub strike_price: u64,
    pub expiry_at: i64,
    pub status: MarketStatus,
    pub outcome: MarketOutcome,

    // V2: Token mints instead of position tracking
    pub yes_mint: Pubkey,           // SPL token mint for YES
    pub no_mint: Pubkey,            // SPL token mint for NO
    pub open_interest: u64,         // Total YES+NO pairs minted

    // V2: Settlement state
    pub settlement_merkle_root: Option<[u8; 32]>,
    pub total_settlement_amount: u64,
    pub settlements_processed: u64,
    pub settlements_total: u64,
}
```

### 3.6 Benefits of Tokenization

1. **No Position PDA per user**: Settlement doesn't need to iterate PDAs
2. **Transferable positions**: Users can transfer tokens (secondary market potential)
3. **Standard token tooling**: Wallets show positions as token balances
4. **Simpler close trades**: Just token transfers, no PDA updates
5. **Composability**: Tokens can be used in DeFi (collateral, lending)

---

## 4. Settlement Architecture

### 4.1 Overview: Merkle Batch Settlement

Instead of settling one position at a time, V2:

1. **Off-chain**: Compute merkle tree of all payouts
2. **On-chain**: Post merkle root (single tx)
3. **On-chain**: Batch settle 15 users per tx with proofs
4. **Parallel**: Multiple relayer wallets submit concurrently

### 4.2 Settlement Data Structure

```typescript
interface SettlementEntry {
  recipient: PublicKey;    // User's wallet
  yesTokens: number;       // YES tokens held at resolution
  noTokens: number;        // NO tokens held at resolution
  payout: number;          // Calculated payout in USDC
}

interface MerkleSettlement {
  marketPubkey: string;
  outcome: 'YES' | 'NO';
  entries: SettlementEntry[];
  merkleRoot: Buffer;       // 32 bytes
  merkleProofs: Buffer[][]; // Proof for each entry
}
```

### 4.3 Settlement Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     MERKLE BATCH SETTLEMENT FLOW                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  PHASE 1: PREPARATION (Off-Chain)                                               │
│  ────────────────────────────────                                               │
│                                                                                 │
│  1. Market reaches RESOLVED status                                              │
│  2. Keeper snapshots all token balances:                                        │
│     - Query all YES token holders (getProgramAccounts on YES mint)             │
│     - Query all NO token holders (getProgramAccounts on NO mint)               │
│                                                                                 │
│  3. Calculate payouts:                                                          │
│     - If outcome=YES: payout = yes_tokens × $1.00                              │
│     - If outcome=NO:  payout = no_tokens × $1.00                               │
│                                                                                 │
│  4. Build merkle tree:                                                          │
│     leaf = keccak256(recipient || payout)                                       │
│     tree = MerkleTree(leaves)                                                   │
│     root = tree.root                                                            │
│                                                                                 │
│  5. Store settlement data in DB:                                                │
│     - merkle_root                                                               │
│     - all entries with proofs                                                   │
│     - partition into batches of 15                                              │
│                                                                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  PHASE 2: POST MERKLE ROOT (Single TX)                                          │
│  ─────────────────────────────────────                                          │
│                                                                                 │
│  Transaction: post_merkle_root                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  Accounts:                                                               │   │
│  │    - market (mut)                                                        │   │
│  │    - relayer (signer)                                                    │   │
│  │                                                                          │   │
│  │  Args:                                                                   │   │
│  │    - merkle_root: [u8; 32]                                               │   │
│  │    - total_payouts: u64                                                  │   │
│  │    - settlement_count: u64                                               │   │
│  │                                                                          │   │
│  │  Effects:                                                                │   │
│  │    - market.settlement_merkle_root = Some(merkle_root)                   │   │
│  │    - market.total_settlement_amount = total_payouts                      │   │
│  │    - market.settlements_total = settlement_count                         │   │
│  │    - market.status = SETTLING                                            │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  PHASE 3: BATCH SETTLEMENT (Parallel TXs)                                       │
│  ────────────────────────────────────────                                       │
│                                                                                 │
│  Multiple relayers process batches concurrently:                                │
│                                                                                 │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐     ┌────────────┐             │
│  │  Relayer 1 │  │  Relayer 2 │  │  Relayer 3 │ ... │ Relayer 20 │             │
│  │  Batch 1   │  │  Batch 2   │  │  Batch 3   │     │  Batch 20  │             │
│  │  15 users  │  │  15 users  │  │  15 users  │     │  15 users  │             │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘     └─────┬──────┘             │
│        │               │               │                   │                    │
│        ▼               ▼               ▼                   ▼                    │
│                                                                                 │
│  Transaction: batch_settle_with_proof                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  Accounts (using remaining_accounts for batch):                          │   │
│  │    - market (mut)                                                        │   │
│  │    - vault (mut)                                                         │   │
│  │    - relayer (signer)                                                    │   │
│  │    - token_program                                                       │   │
│  │    - remaining_accounts: [recipient_1, ata_1, ..., recipient_15, ata_15] │   │
│  │                                                                          │   │
│  │  Args:                                                                   │   │
│  │    - recipients: [Pubkey; 15]                                            │   │
│  │    - amounts: [u64; 15]                                                  │   │
│  │    - proofs: [[u8; 32]; 15][PROOF_DEPTH]                                 │   │
│  │                                                                          │   │
│  │  Effects (for each entry):                                               │   │
│  │    1. Verify: merkle_verify(root, proof, hash(recipient, amount))        │   │
│  │    2. Check: not already settled (bitmap or set)                         │   │
│  │    3. Transfer: vault → recipient ATA                                    │   │
│  │    4. Burn: recipient's YES/NO tokens (optional)                         │   │
│  │    5. Mark: settled (bitmap or set)                                      │   │
│  │    6. Increment: market.settlements_processed += 1                       │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  PHASE 4: FINALIZATION                                                          │
│  ────────────────────                                                           │
│                                                                                 │
│  When settlements_processed == settlements_total:                               │
│                                                                                 │
│  Transaction: finalize_market                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  - market.status = SETTLED                                               │   │
│  │  - Close YES mint account (recover rent)                                 │   │
│  │  - Close NO mint account (recover rent)                                  │   │
│  │  - Any remaining vault balance → fee recipient                           │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 4.4 Parallel Relayer Pool

```typescript
interface RelayerPool {
  relayers: RelayerWallet[];      // 20-50 funded wallets
  batchQueue: SettlementBatch[];  // Batches waiting to be processed

  // Each relayer independently:
  // 1. Claims a batch from queue
  // 2. Builds and submits tx
  // 3. Confirms or retries
  // 4. Claims next batch
}

interface RelayerWallet {
  pubkey: PublicKey;
  balance: number;          // SOL for tx fees
  activeJobs: number;       // Current in-flight txs
  successRate: number;      // For load balancing
}
```

### 4.5 Settlement Time Calculation

**Parameters**:
- Users: 50,000
- Users per batch: 15
- Batches: 50,000 / 15 = 3,334 batches
- Relayers: 20
- Time per tx: ~2 seconds (submit + confirm)

**Sequential (V1)**:
```
50,000 positions × 1 tx each × 1 second = 50,000 seconds ≈ 14 hours
```

**Parallel V2 (20 relayers)**:
```
3,334 batches ÷ 20 relayers = 167 rounds
167 rounds × 2 seconds/round = 334 seconds ≈ 5.5 minutes
```

**Parallel V2 (50 relayers)**:
```
3,334 batches ÷ 50 relayers = 67 rounds
67 rounds × 2 seconds/round = 134 seconds ≈ 2.2 minutes
```

**With optimizations (priority fees, preflight disabled)**:
```
67 rounds × 1 second/round = 67 seconds ≈ 1 minute
```

### 4.6 Settlement Job Queue (BullMQ)

```typescript
// Settlement job structure
interface SettlementJob {
  id: string;                    // Idempotency key
  marketPubkey: string;
  batchIndex: number;
  recipients: string[];          // 15 pubkeys
  amounts: number[];             // 15 amounts
  proofs: Buffer[][];            // 15 merkle proofs

  // Status tracking
  status: 'PENDING' | 'PROCESSING' | 'CONFIRMED' | 'FAILED';
  relayerPubkey?: string;
  txSignature?: string;
  attempts: number;
  lastError?: string;
}

// Job processing
async function processSettlementBatch(job: SettlementJob) {
  const relayer = await claimAvailableRelayer();

  try {
    const tx = buildBatchSettleTx(job, relayer);
    const sig = await sendAndConfirm(tx, relayer);

    await markJobConfirmed(job.id, sig);
    releaseRelayer(relayer);
  } catch (error) {
    await markJobFailed(job.id, error);
    releaseRelayer(relayer);
    // BullMQ will retry with backoff
    throw error;
  }
}
```

---

## 5. Redis Orderbook Redesign

### 5.1 V1 Problem

V1 orderbook operations do **full scans**:

```typescript
// V1: Remove order - O(N) scan
async removeOrder(orderId: string) {
  const orders = await redis.zrange(key, 0, -1);  // O(N)
  for (const order of orders) {
    if (parseOrder(order).id === orderId) {
      await redis.zrem(key, order);  // Found it
      break;
    }
  }
}

// V1: Snapshot - O(N) scan + aggregation
async getSnapshot() {
  const orders = await redis.zrange(key, 0, -1, 'WITHSCORES');  // O(N)
  // Aggregate in JS...
}
```

### 5.2 V2 Solution: Indexed Data Model

**New Redis Structure**:

```
# ZSET: price-sorted order IDs only
orderbook:{market}:bids = ZSET
  score: price (inverted for bids: 1 - price)
  member: orderId (stable, no scanning needed)

orderbook:{market}:asks = ZSET
  score: price
  member: orderId

# HASH: order details by ID
order:{orderId} = HASH
  price: "0.42"
  size: "100"
  remaining: "100"
  owner: "wallet..."
  createdAt: "1706..."

# HASH: aggregated levels (maintained incrementally)
levels:{market}:bids = HASH
  "0.42": "1500"    # total size at this price
  "0.41": "800"

levels:{market}:asks = HASH
  "0.43": "1200"
  "0.44": "900"

# Counter: sequence number for delta sync
sequence:{market} = STRING
  "10542"
```

### 5.3 V2 Operations

**Add Order - O(log N)**:
```typescript
async addOrder(order: Order) {
  const multi = redis.multi();

  // Add to price-sorted set
  multi.zadd(orderbookKey, order.price, order.id);

  // Store order details
  multi.hset(`order:${order.id}`, {
    price: order.price,
    size: order.size,
    remaining: order.size,
    owner: order.owner,
    createdAt: Date.now()
  });

  // Update aggregated level
  multi.hincrbyfloat(levelsKey, order.price.toString(), order.size);

  // Increment sequence
  multi.incr(sequenceKey);

  await multi.exec();
}
```

**Remove Order - O(log N)**:
```typescript
async removeOrder(orderId: string) {
  const order = await redis.hgetall(`order:${orderId}`);
  if (!order) return;

  const multi = redis.multi();

  // Remove from sorted set (direct, no scan)
  multi.zrem(orderbookKey, orderId);

  // Delete order details
  multi.del(`order:${orderId}`);

  // Update aggregated level
  multi.hincrbyfloat(levelsKey, order.price, -parseFloat(order.remaining));

  // Clean up empty level
  // (handled in Lua script to be atomic)

  multi.incr(sequenceKey);

  await multi.exec();
}
```

**Get Snapshot - O(levels)**:
```typescript
async getSnapshot(market: string, depth: number = 20) {
  // Read pre-aggregated levels (O(levels), not O(orders))
  const [bids, asks, sequence] = await Promise.all([
    redis.hgetall(`levels:${market}:bids`),
    redis.hgetall(`levels:${market}:asks`),
    redis.get(`sequence:${market}`)
  ]);

  // Sort and take top N levels
  const sortedBids = Object.entries(bids)
    .map(([price, size]) => ({ price: parseFloat(price), size: parseFloat(size) }))
    .filter(l => l.size > 0)
    .sort((a, b) => b.price - a.price)
    .slice(0, depth);

  // Similar for asks...

  return { bids: sortedBids, asks: sortedAsks, sequence };
}
```

### 5.4 Delta Broadcasting

**V1**: Broadcast full snapshot on every change
**V2**: Broadcast deltas with sequence numbers

```typescript
interface OrderbookDelta {
  market: string;
  sequence: number;
  changes: {
    side: 'bid' | 'ask';
    price: number;
    size: number;    // New total size at this level (0 = remove level)
  }[];
}

// Client receives deltas and applies locally
// If sequence gap detected, request full snapshot
```

---

## 6. WebSocket Fanout Redesign

### 6.1 V1 Problem

V1 broadcast iterates **all connected sockets**:

```typescript
// V1: O(all sockets) per broadcast
broadcast(channel: string, data: any) {
  for (const socket of this.allSockets) {  // O(N)
    if (socket.subscriptions.has(channel)) {
      socket.send(data);
    }
  }
}
```

### 6.2 V2 Solution: Indexed Subscriptions

**Data Structures**:

```typescript
class WebSocketManagerV2 {
  // Reverse index: channel → subscribers
  private channelSubscribers: Map<string, Set<WebSocket>> = new Map();

  // User index: userId → sockets
  private userSockets: Map<string, Set<WebSocket>> = new Map();

  // Batching: accumulate messages for high-frequency channels
  private batchBuffers: Map<string, any[]> = new Map();
  private batchTimers: Map<string, NodeJS.Timeout> = new Map();
}
```

**Subscribe - O(1)**:
```typescript
subscribe(socket: WebSocket, channel: string) {
  if (!this.channelSubscribers.has(channel)) {
    this.channelSubscribers.set(channel, new Set());
  }
  this.channelSubscribers.get(channel)!.add(socket);
  socket.subscriptions.add(channel);
}
```

**Broadcast - O(subscribers)**:
```typescript
broadcast(channel: string, data: any) {
  const subscribers = this.channelSubscribers.get(channel);
  if (!subscribers) return;

  const message = JSON.stringify(data);
  for (const socket of subscribers) {  // O(subscribers), not O(all)
    if (socket.readyState === WebSocket.OPEN) {
      this.sendWithBackpressure(socket, message);
    }
  }
}
```

### 6.3 Batching for High-Frequency Channels

```typescript
// Orderbook updates batched every 50ms
const BATCH_INTERVAL_MS = 50;
const HIGH_FREQUENCY_CHANNELS = ['orderbook:', 'trades:'];

broadcastBatched(channel: string, data: any) {
  if (!this.shouldBatch(channel)) {
    return this.broadcast(channel, data);
  }

  // Accumulate in buffer
  if (!this.batchBuffers.has(channel)) {
    this.batchBuffers.set(channel, []);
  }
  this.batchBuffers.get(channel)!.push(data);

  // Schedule flush if not already scheduled
  if (!this.batchTimers.has(channel)) {
    this.batchTimers.set(channel, setTimeout(() => {
      this.flushBatch(channel);
    }, BATCH_INTERVAL_MS));
  }
}

flushBatch(channel: string) {
  const buffer = this.batchBuffers.get(channel) || [];
  this.batchBuffers.delete(channel);
  this.batchTimers.delete(channel);

  if (buffer.length === 0) return;

  // Send combined batch
  this.broadcast(channel, {
    type: 'batch',
    messages: buffer
  });
}
```

### 6.4 Backpressure Handling

```typescript
sendWithBackpressure(socket: WebSocket, message: string) {
  // Check socket buffer size
  if (socket.bufferedAmount > MAX_BUFFER_SIZE) {
    // Drop non-critical messages
    if (this.isNonCritical(message)) {
      socket.needsSnapshot = true;  // Flag for snapshot on next subscribe
      return;
    }
    // Critical messages still sent (orders, settlements)
  }

  socket.send(message);
}

// On subscribe, check if client needs snapshot due to dropped messages
handleSubscribe(socket: WebSocket, channel: string) {
  this.subscribe(socket, channel);

  if (socket.needsSnapshot || this.isOrderbookChannel(channel)) {
    // Send full snapshot
    const snapshot = await this.getSnapshot(channel);
    socket.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
    socket.needsSnapshot = false;
  }
}
```

---

## 7. Durable Async Pipeline

### 7.1 V1 Problem

V1 background tasks are **fire-and-forget**:
- Process crash = lost work
- No retry guarantees
- No visibility into failures
- Reconciliation is manual

### 7.2 V2 Solution: BullMQ Job Queue

**Queue Setup**:

```typescript
import { Queue, Worker, Job } from 'bullmq';

// Job queues
const onChainSubmitQueue = new Queue('onchain-submit', { connection: redis });
const settlementQueue = new Queue('settlement', { connection: redis });
const wsEventQueue = new Queue('ws-events', { connection: redis });

// Workers
const onChainWorker = new Worker('onchain-submit', processOnChainJob, {
  connection: redis,
  concurrency: 20,  // Parallel submissions
});

const settlementWorker = new Worker('settlement', processSettlementJob, {
  connection: redis,
  concurrency: 50,  // Max parallel relayers
});
```

### 7.3 Job Types

**On-Chain Submission Job**:
```typescript
interface OnChainJob {
  id: string;                    // Idempotency key
  type: 'execute_match' | 'settle_position' | 'resolve_market';
  payload: {
    marketPubkey: string;
    // Type-specific data...
  };
  idempotencyKey: string;        // Prevents duplicate processing
  attempts: number;
  maxAttempts: number;
}

async function processOnChainJob(job: Job<OnChainJob>) {
  const { idempotencyKey, type, payload } = job.data;

  // Check if already processed
  const existing = await db.query(
    'SELECT tx_sig FROM processed_jobs WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  if (existing.rows[0]) {
    return { status: 'already_processed', txSig: existing.rows[0].tx_sig };
  }

  // Process based on type
  const txSig = await submitOnChain(type, payload);

  // Record completion
  await db.query(
    'INSERT INTO processed_jobs (idempotency_key, tx_sig, completed_at) VALUES ($1, $2, NOW())',
    [idempotencyKey, txSig]
  );

  return { status: 'success', txSig };
}
```

**WebSocket Event Job**:
```typescript
interface WSEventJob {
  channel: string;
  event: string;
  data: any;
  priority: 'high' | 'normal' | 'low';
}

// Priority queue ensures critical events processed first
await wsEventQueue.add('trade_fill', {
  channel: `user:${userId}`,
  event: 'order_filled',
  data: fillData,
  priority: 'high'
}, { priority: 1 });
```

### 7.4 Reconciliation Job

```typescript
// Runs every 5 minutes
const reconciliationJob = new Worker('reconciliation', async () => {
  // Find PENDING trades older than 2 minutes
  const stuckTrades = await db.query(`
    SELECT * FROM trades
    WHERE tx_status = 'PENDING'
    AND created_at < NOW() - INTERVAL '2 minutes'
  `);

  for (const trade of stuckTrades.rows) {
    // Check actual on-chain status
    const onChainStatus = await checkOnChainStatus(trade.tx_sig);

    if (onChainStatus === 'confirmed') {
      // Update DB
      await db.query('UPDATE trades SET tx_status = $1 WHERE id = $2', ['CONFIRMED', trade.id]);
      // Emit missed WS event
      await wsEventQueue.add('reconciled_trade', { tradeId: trade.id });
    } else if (onChainStatus === 'failed') {
      // Re-queue for submission
      await onChainSubmitQueue.add('retry_trade', { tradeId: trade.id });
    }
    // Still pending = wait more
  }
});
```

---

## 8. Leverage Integration

### 8.1 How Leverage Works with Tokenized Model

The Lending Pool execution model remains the same, but now works with tokens:

**V1 (Position PDAs)**:
```
Lending Pool holds Position PDA with yes_shares/no_shares
```

**V2 (Tokenized)**:
```
Lending Pool holds YES/NO tokens in its ATAs
```

### 8.2 Leveraged Trade Flow (V2)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    LEVERAGED TRADE - TOKENIZED MODEL                             │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  1. User places 5x leveraged order ($25 margin for $125 buying power)           │
│                                                                                 │
│  ┌──────────────┐                        ┌─────────────────┐                   │
│  │   User       │ ── $25 margin ──────▶  │  Lending Pool   │                   │
│  │   Wallet     │                        │     Wallet      │                   │
│  └──────────────┘                        │  +$100 (loan)   │                   │
│                                          │  =$125 total    │                   │
│                                          └────────┬────────┘                   │
│                                                   │                             │
│  2. Lending Pool executes trade, receives tokens                                │
│                                                   │                             │
│                                                   ▼                             │
│  ┌───────────────────────────────────────────────────────────────────────┐     │
│  │  Lending Pool's Token Accounts:                                        │     │
│  │                                                                        │     │
│  │  YES ATA: 250 tokens (for BTC-5m market)                              │     │
│  │  NO ATA:  0 tokens                                                     │     │
│  │                                                                        │     │
│  │  (On-chain: Lending Pool owns the tokens)                             │     │
│  │  (Database: User alice is beneficial owner via margin_account)         │     │
│  └───────────────────────────────────────────────────────────────────────┘     │
│                                                                                 │
│  3. Database tracking (unchanged from V1):                                      │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────┐     │
│  │  margin_accounts:                                                      │     │
│  │    user_id: alice                                                      │     │
│  │    market_id: BTC-5m                                                   │     │
│  │    side: YES                                                           │     │
│  │    shares: 250            # Beneficial ownership of LP's tokens        │     │
│  │    margin_deposited: $25                                               │     │
│  │    loan_amount: $100                                                   │     │
│  │    leverage: 5x                                                        │     │
│  │    liquidation_price: $0.41                                            │     │
│  └───────────────────────────────────────────────────────────────────────┘     │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 8.3 Leveraged Settlement Flow (V2)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    LEVERAGED SETTLEMENT - TOKENIZED MODEL                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  Market resolves YES (user had YES position via Lending Pool)                   │
│                                                                                 │
│  1. Settlement computes Lending Pool's total payout:                            │
│     - LP holds 250 YES tokens → $250 payout                                     │
│                                                                                 │
│  2. Merkle tree includes Lending Pool as recipient:                             │
│     leaf = hash(lending_pool_pubkey, $250)                                      │
│                                                                                 │
│  3. batch_settle_with_proof transfers $250 USDC to Lending Pool                 │
│                                                                                 │
│  4. Lending Pool's settlement distribution (off-chain coordination):            │
│                                                                                 │
│     ┌─────────────────────────────────────────────────────────────────────┐    │
│     │  For each margin_account linked to this market:                      │    │
│     │                                                                      │    │
│     │  Alice's margin account:                                             │    │
│     │    shares: 250 YES                                                   │    │
│     │    payout_share: 250 × $1.00 = $250                                  │    │
│     │    loan_amount: $100                                                 │    │
│     │    ───────────────────────────────                                   │    │
│     │    user_profit: $250 - $100 = $150 → Transfer to Alice               │    │
│     │                                                                      │    │
│     │  (Original margin $25 + profit $125 = $150 total return)             │    │
│     │  (500% return on margin with 5x leverage!)                           │    │
│     └─────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  5. On-chain: Lending Pool transfers $150 to Alice's wallet                     │
│     (or keeper does bulk distribution)                                          │
│                                                                                 │
│  6. YES tokens in LP's ATA are burned (or just left, market is settled)         │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 8.4 Liquidation Flow (V2)

Liquidation remains the same conceptually:

```
1. Keeper detects margin_ratio < maintenance_margin
2. Keeper sets margin_account.liquidating_at (prevents user sells)
3. Lending Pool sells tokens:
   - execute_close: LP transfers YES tokens to buyer for USDC
4. Distribution:
   - Loan repaid to Lending Pool
   - Penalty to Insurance Fund
   - Remaining to User
5. margin_account.status = LIQUIDATED
```

The key difference is that instead of updating a Position PDA, the Lending Pool just transfers tokens.

---

## 9. Migration Strategy

### 9.1 Phase 0: Preparation (No User Impact)

- Deploy V2 program alongside V1
- Create parallel relayer wallets (fund 20 wallets with 0.5 SOL each)
- Set up BullMQ infrastructure
- Implement Redis V2 data model (run both in parallel)

### 9.2 Phase 1: New Markets Use V2 (~1 week)

- New markets created with tokenized model
- V1 markets continue to operate until settled
- Monitor V2 performance and fix issues

### 9.3 Phase 2: Full V2 Migration (~2 weeks)

- Stop creating V1 markets
- Wait for all V1 markets to settle
- Deprecate V1 program

### 9.4 Database Migration

```sql
-- Add V2 columns to markets table
ALTER TABLE markets ADD COLUMN IF NOT EXISTS yes_mint VARCHAR(44);
ALTER TABLE markets ADD COLUMN IF NOT EXISTS no_mint VARCHAR(44);
ALTER TABLE markets ADD COLUMN IF NOT EXISTS settlement_merkle_root BYTEA;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS settlements_processed INT DEFAULT 0;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS settlements_total INT DEFAULT 0;

-- Settlement jobs table (BullMQ backed)
CREATE TABLE IF NOT EXISTS settlement_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  market_id UUID NOT NULL REFERENCES markets(id),
  batch_index INT NOT NULL,
  recipients JSONB NOT NULL,
  amounts JSONB NOT NULL,
  proofs JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING',
  relayer_pubkey VARCHAR(44),
  tx_signature VARCHAR(88),
  attempts INT DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(market_id, batch_index)
);

-- Relayer pool table
CREATE TABLE IF NOT EXISTS relayer_wallets (
  pubkey VARCHAR(44) PRIMARY KEY,
  balance_sol DECIMAL(20, 9) NOT NULL,
  active_jobs INT DEFAULT 0,
  total_submitted INT DEFAULT 0,
  total_confirmed INT DEFAULT 0,
  total_failed INT DEFAULT 0,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Processed jobs table (for idempotency)
CREATE TABLE IF NOT EXISTS processed_jobs (
  idempotency_key VARCHAR(128) PRIMARY KEY,
  tx_sig VARCHAR(88),
  completed_at TIMESTAMP DEFAULT NOW()
);
```

---

## 10. Implementation Phases

### Phase 1: Infrastructure (Week 1-2)

- [ ] Set up BullMQ with Redis
- [ ] Implement job queues (on-chain submit, settlement, WS events)
- [ ] Create relayer pool management system
- [ ] Implement reconciliation job

### Phase 2: Redis V2 Orderbook (Week 2-3)

- [ ] Implement new data model (indexed, incremental levels)
- [ ] Update matching engine to use new model
- [ ] Implement delta broadcasting
- [ ] Run both models in parallel for validation

### Phase 3: WebSocket V2 (Week 3-4)

- [ ] Implement subscription reverse index
- [ ] Add batching for high-frequency channels
- [ ] Add backpressure handling
- [ ] Migrate clients to delta-based updates

### Phase 4: Tokenized Model (Week 4-6)

- [ ] Implement V2 program with token mints
- [ ] Update execute_match for token minting
- [ ] Update execute_close for token transfers
- [ ] Update leverage service for token model

### Phase 5: Merkle Settlement (Week 6-8)

- [ ] Implement merkle tree builder
- [ ] Implement post_merkle_root instruction
- [ ] Implement batch_settle_with_proof instruction
- [ ] Implement parallel relayer settlement

### Phase 6: Testing & Migration (Week 8-10)

- [ ] Load test with 50K simulated users
- [ ] Validate settlement time targets
- [ ] Deploy to devnet for full testing
- [ ] Gradual mainnet rollout

---

## Appendix A: Gas Cost Analysis

### Settlement Gas Comparison

| Model | Txs for 50K users | Est. Cost |
|-------|-------------------|-----------|
| V1 (1 per position) | 50,000 | ~2.5 SOL |
| V2 (15 per tx) | 3,334 | ~0.17 SOL |

V2 is ~15x more gas efficient for settlement.

### Trading Gas (Unchanged)

Opening/closing trades remain similar cost since we're still doing 1 tx per match.

---

## Appendix B: Failure Modes & Recovery

### Relayer Failure

If a relayer fails mid-settlement:
1. Job remains in queue (BullMQ retry)
2. Another relayer picks up the job
3. Idempotency key prevents double-settlement

### Merkle Root Mismatch

If merkle root computation differs from on-chain:
1. batch_settle_with_proof will fail proof verification
2. Settlement jobs fail, trigger alert
3. Manual investigation required (should never happen)

### Partial Settlement

If process crashes after posting root but before all batches:
1. settlements_processed < settlements_total
2. Reconciliation job detects incomplete settlement
3. Re-queues remaining batches

---

*Last updated: January 2026*
