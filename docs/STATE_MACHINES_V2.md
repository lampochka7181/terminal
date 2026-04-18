# State Machine Diagrams V2

This document describes all state machines in the Degen Terminal V2 system with tokenized shares and merkle batch settlement.

> **Changes from V1**:
> - Market lifecycle includes SETTLING state for merkle settlement
> - Position lifecycle replaced by token holdings
> - Settlement uses merkle proofs and parallel relayers

---

## 1. Market Lifecycle State Machine (V2)

Markets progress through 6 states from creation to final settlement.

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            MARKET LIFECYCLE V2                                       │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│    ┌─────────┐    activate_market    ┌─────────┐                                   │
│    │ PENDING │ ─────────────────────▶│  OPEN   │                                   │
│    │         │   (set strike price,  │         │                                   │
│    │         │    create YES/NO      │         │                                   │
│    └─────────┘    token mints)       └────┬────┘                                   │
│         │                                 │                                         │
│         │ initialize_market               │ expiry_at reached                       │
│         │ (creates market PDA,            │ (trading window closes)                 │
│         │  YES mint, NO mint)             ▼                                         │
│         │                           ┌─────────┐                                    │
│         └──────────────────────────▶│ CLOSED  │◀─── Trading stops T-2s             │
│              (direct activation)    │         │     before expiry                   │
│                                     └────┬────┘                                    │
│                                          │                                          │
│                                          │ resolve_market                           │
│                                          │ (keeper fetches final_price,             │
│                                          │  sets outcome: YES or NO)                │
│                                          ▼                                          │
│                                    ┌──────────┐                                    │
│                                    │ RESOLVED │                                    │
│                                    │          │                                    │
│                                    └────┬─────┘                                    │
│                                         │                                           │
│                                         │ post_merkle_root                          │
│                                         │ (compute off-chain, post root on-chain)   │
│                                         ▼                                           │
│                               ┌────────────────┐   ◀── NEW STATE                   │
│                               │   SETTLING     │                                    │
│                               │                │                                    │
│                               │ merkle_root    │                                    │
│                               │ set, batches   │                                    │
│                               │ processing     │                                    │
│                               └───────┬────────┘                                    │
│                                       │                                             │
│                                       │ all batches confirmed                       │
│                                       │ (settlements_processed == settlements_total) │
│                                       ▼                                             │
│                                  ┌──────────┐                                      │
│                                  │ SETTLED  │ ─────▶ finalize_market               │
│                                  │          │        (close mints, reclaim rent)   │
│                                  └──────────┘                                      │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘

TRIGGERS & ACTORS (V2):
┌────────────────────────┬────────────────────────────────────────────────────────────┐
│ Transition             │ Actor / Trigger                                            │
├────────────────────────┼────────────────────────────────────────────────────────────┤
│ → PENDING              │ Keeper (market-creator job) - every 30s                    │
│ PENDING → OPEN         │ Keeper (market-activator job) - creates mints + market PDA │
│ OPEN → CLOSED          │ Automatic at expiry_at - 2 seconds                         │
│ CLOSED → RESOLVED      │ Keeper (market-resolver job) - every 2s                    │
│ RESOLVED → SETTLING    │ Keeper (merkle-builder job) - posts merkle root            │
│ SETTLING → SETTLED     │ Keeper (batch-settler job) - parallel relayers             │
│ SETTLED → (finalized)  │ Keeper (market-finalizer job) - closes accounts            │
└────────────────────────┴────────────────────────────────────────────────────────────┘
```

### Market Status Values (V2 On-Chain)

Defined in `packages/contracts/programs/degen-terminal/src/state_v2.rs` as
`MarketStatusV2` (the V1 `MarketStatus` in `state.rs` still exists for legacy
markets and has only 5 variants — no `Settling`).

```rust
pub enum MarketStatusV2 {
    Pending = 0,    // Pre-created, awaiting activation
    Open = 1,       // Trading active, YES/NO tokens being minted/transferred
    Closed = 2,     // Trading stopped, awaiting resolution
    Resolved = 3,   // Outcome determined (YES or NO)
    Settling = 4,   // Merkle root posted, batches processing
    Settled = 5,    // All payouts distributed
}
```

### DB Representation (differs from on-chain)

The Postgres enum is deliberately narrower than the on-chain enum because the
Supabase connection pooler caches enum values and will not pick up new variants
on a live deployment. See `apps/api/src/db/schema.ts`:

```ts
pgEnum('market_status', ['OPEN', 'CLOSED', 'RESOLVED', 'SETTLED', 'SETTLEMENT_FAILED'])
```

- `PENDING` is **not** a DB enum value — pending markets are stored with
  `status = 'OPEN'` and `strike_price = '0'` (the activator job scans for this).
- `SETTLING` is **not** a DB enum value — it is transient. DB rows stay at
  `RESOLVED` during batch settlement; the merkle settler reads the on-chain
  `Settling` status directly when it needs to.
- `SETTLEMENT_FAILED` is added for markets that exceed the
  `MAX_SETTLEMENT_FAILURES` (10) threshold in the merkle settler and need
  manual review.

### Market Account Fields (V2)

```rust
pub struct MarketV2 {
    pub pubkey: Pubkey,
    pub asset: String,
    pub duration_minutes: u16,
    pub strike_price: u64,
    pub expiry_at: i64,
    pub status: MarketStatus,
    pub outcome: MarketOutcome,

    // V2: Token mints
    pub yes_mint: Pubkey,           // SPL token mint for YES shares
    pub no_mint: Pubkey,            // SPL token mint for NO shares
    pub open_interest: u64,         // Total YES+NO pairs in circulation

    // V2: Merkle settlement
    pub settlement_merkle_root: Option<[u8; 32]>,
    pub total_settlement_amount: u64,
    pub settlements_processed: u64,
    pub settlements_total: u64,

    // Existing fields
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    pub final_price: Option<u64>,
}
```

---

## 2. Order Lifecycle State Machine

Orders can be filled, partially filled, cancelled (by the user OR the
backend), or — once the market they belong to resolves — settled.

Two things to be aware of when reading the diagram:

- **`EXPIRED` is on-chain only.** The DB `order_status` enum is
  `'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED'`. The Order Expirer keeper
  and on-chain tx-failure handlers write `CANCELLED` in the DB and record
  the real reason in `cancel_reason` (`'EXPIRED'`, `'MARKET_CLOSING'`,
  `'INSUFFICIENT_FUNDS'`, etc).
- **`SETTLED` / `SETTLEMENT_FAILED` are logical states, not DB enum values.**
  After a FILLED (or partially-filled) order's market reaches
  `markets.status = 'SETTLED'` or `'SETTLEMENT_FAILED'`, the order is
  logically in that terminal state too — but the `orders.status` column
  itself does not change. These terminal states are derived by joining on
  the market status when needed.

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                                    ORDER LIFECYCLE                                         │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                           │
│                          ┌─────────────────────────────────────┐                          │
│                          │           User places order         │                          │
│                          │        (place_order instruction)    │                          │
│                          └────────────────────┬────────────────┘                          │
│                                               │                                           │
│                                               ▼                                           │
│                                          ┌─────────┐                                      │
│                         ┌───────────────│  OPEN   │───────────────┐                       │
│                         │                └────┬────┘                │                      │
│                         │                     │                     │                      │
│                partial  │             full    │                     │   cancel            │
│                fill     │             fill    │                     │   (any reason)      │
│                         ▼                     │                     ▼                      │
│                    ┌─────────┐                │               ┌───────────┐                │
│            ┌──────│ PARTIAL │───────┐        │               │ CANCELLED │                │
│            │       └────┬────┘       │        │               │           │                │
│            │            │            │        │               │ cancel_   │                │
│            │ rest fills │ cancel     │        │               │ reason    │                │
│            │            │ (any)      │        │               │ recorded  │                │
│            │            ▼            │        │               └─────┬─────┘                │
│            │       ┌─────────┐       │        │                     ▲                      │
│            │       │CANCELLED│       │        │                     │                      │
│            │       └─────────┘       │        │                     │                      │
│            │                         ▼        ▼                     │                      │
│            │                    ┌─────────────────┐                 │                      │
│            │                    │     FILLED      │                 │                      │
│            │                    │                 │                 │                      │
│            │                    │ remaining_size  │                 │                      │
│            │                    │      = 0        │                 │                      │
│            │                    └────────┬────────┘                 │                      │
│            │                             │                          │                      │
│            └─────────────────┐           │     Market reaches       │                      │
│                              │           │     SETTLED or           │                      │
│              Market reaches  │           │     SETTLEMENT_FAILED    │                      │
│              SETTLED or      │           │                          │                      │
│              SETTLEMENT_     │           │                          │                      │
│              FAILED          │           │                          │                      │
│                              ▼           ▼                          │                      │
│                    ┌──────────────────────────────┐                 │                      │
│                    │  (logical)    SETTLED  /     │                 │                      │
│                    │         SETTLEMENT_FAILED    │                 │                      │
│                    │                              │                 │                      │
│                    │ Derived from markets.status. │                 │                      │
│                    │ orders.status stays FILLED   │                 │                      │
│                    │ (or CANCELLED w/ fills).     │                 │                      │
│                    └──────────────────────────────┘                 │                      │
│                                                                     │                      │
│                                                                     │                      │
│               Cancel reasons (orders.cancel_reason):                │                      │
│                                                                     │                      │
│               User-initiated           Backend / system-initiated   │                      │
│               ─────────────            ──────────────────────────   │                      │
│               • USER                   • EXPIRED (GTT past exp_ts)  │                      │
│               • USER_CANCEL_ALL        • MARKET_CLOSED              │                      │
│                                        • MARKET_CLOSING (pre-close) │                      │
│               MM / agent               • INSUFFICIENT_FUNDS         │                      │
│               ─────────                • INSUFFICIENT_SHARES        │                      │
│               • MM_CANCEL              • INSUFFICIENT_LAMPORTS      │                      │
│                                        • FEE_TOO_LOW                │                      │
│                                        • SELF_TRADE                 │                      │
│                                        • POSITION_LIMIT             │                      │
│                                        • INVALID_SIGNATURE          │                      │
│                                        • ACCOUNT_NOT_FOUND          │                      │
│                                        • ACCOUNT_DESERIALIZATION    │                      │
│                                        • MAX_RETRIES                │                      │
│                                                                     │                      │
│               RPC backpressure (see §2.1 below)                     │                      │
│               ──────────────────────────────────                    │                      │
│                                        • RPC_RATE_LIMITED (HTTP 429)│                      │
│                                        • RPC_TIMEOUT (ETIMEDOUT,    │                      │
│                                          socket hang up, blockhash  │                      │
│                                          not found, fetch failed)   │                      │
│                                                                                           │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

The backend-error reasons are emitted by the on-chain submit worker
(`apps/api/src/queue/workers/onchain-submit.worker.ts` — see the
`permanentCodes` list) and the trade error classifier in
`apps/api/src/services/transaction.service.ts`. A rejected taker order is
cancelled with its error code as the `cancel_reason`.

`FILLED → SETTLED / SETTLEMENT_FAILED` only applies to orders that produced
any fills. A `CANCELLED` order with `filled_size > 0` (e.g. a partial fill
killed at `MARKET_CLOSING`) is subject to the same logical settlement
transition for the filled portion.

### 2.1 RPC Backpressure Sub-State Machine

HTTP 429 / timeout errors from the Solana RPC are transient — the right
response is to back off, not to cancel the order. The match and close paths
in `transaction.service.ts` run a dedicated retry loop for these so a brief
provider rate-limit spike doesn't instantly burn the 3-attempt
`MAX_RETRIES` budget and cancel the user's order.

Detected by `isRpcBackpressureError()`:

- `RPC_RATE_LIMITED` — any error message matching `429`,
  `Too Many Requests`, `rate limit`, `Connection rate limits exceeded`.
- `RPC_TIMEOUT` — `ETIMEDOUT`, `ESOCKETTIMEDOUT`, `socket hang up`,
  `ECONNRESET`, `ECONNREFUSED`, `fetch failed`, `blockhash not found`,
  `request timed out`.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                  RPC BACKPRESSURE RETRY FLOW (match / close)                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│    anchorClient.executeMatchV2() throws                                         │
│                 │                                                               │
│                 ▼                                                               │
│         isPermanentError(err)? ──── yes ───▶ cancel order with the              │
│                 │ no                         permanent code and return          │
│                 ▼                                                               │
│         isRpcBackpressureError(err)?                                            │
│                 │                                                               │
│         ┌───────┴────────┐                                                      │
│         │                │                                                      │
│         ▼ yes            ▼ no                                                   │
│   ┌──────────────┐  ┌──────────────────┐                                        │
│   │ BACKPRESSURE │  │ TRANSIENT        │                                        │
│   │              │  │                  │                                        │
│   │ retries ≤ 5  │  │ attempts ≤ 3     │                                        │
│   │ 1.5s → 3s →  │  │ 0.5s → 1s → 2s   │                                        │
│   │ 6s → 12s →   │  │ (no jitter)      │                                        │
│   │ 15s (cap)    │  │                  │                                        │
│   │ + 0–500ms    │  │                  │                                        │
│   │ jitter       │  │                  │                                        │
│   └──────┬───────┘  └────────┬─────────┘                                        │
│          │                   │                                                  │
│          ▼                   ▼                                                  │
│   budget exhausted?    budget exhausted?                                        │
│          │ yes              │ yes                                               │
│          ▼                   ▼                                                  │
│   cancel order with    cancel order with                                        │
│   RPC_RATE_LIMITED     MAX_RETRIES                                              │
│   or RPC_TIMEOUT       (or last backpressure                                    │
│                         code seen, if any)                                      │
│                                                                                 │
│   The two budgets are independent: a match can survive up to 5 × backpressure   │
│   retries + 3 × generic-transient retries before the order is cancelled.        │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**User-facing surface.** On exhaustion the order is cancelled with
`cancel_reason = 'RPC_RATE_LIMITED' | 'RPC_TIMEOUT'` and a `trade_failed`
WebSocket event is pushed to the affected users with the same `errorCode`.
The webv3 activity panel renders these as `Failed (Network Busy)` /
`Failed (Network Timeout)` instead of the generic `Failed`, so the user
knows to retry rather than suspect their order was malformed.

**Note on the queue layer.** `RPC_RATE_LIMITED` / `RPC_TIMEOUT` are added to
the `onchain-submit` worker's `permanentCodes` list. That looks paradoxical
(rate-limits *are* transient) but is deliberate: by the time a code bubbles
out of the transaction service it has already exhausted the backpressure
retry budget, so letting BullMQ retry would just pile more load onto a
provider that is explicitly asking us to slow down.

---

## 3. Token Holding Lifecycle (V2 - Replaces Position PDAs)

In V2, positions are represented as SPL token holdings rather than Position PDAs.

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         TOKEN HOLDING LIFECYCLE (V2)                                 │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│                           User doesn't hold tokens                                  │
│                                      │                                              │
│                                      │ First trade in market                        │
│                                      │ (execute_match mints tokens to user's ATA)   │
│                                      ▼                                              │
│                              ┌──────────────┐                                      │
│    ┌─────────────────────────│   HOLDING    │─────────────────────────┐            │
│    │                         └──────┬───────┘                         │            │
│    │                                │                                 │            │
│    │ buy more shares                │ sell shares                     │            │
│    │ (tokens minted/transferred)    │ (tokens transferred/burned)     │            │
│    │                                │                                 │            │
│    │    ┌───────────────────────────┼───────────────────────────┐     │            │
│    │    │                           │                           │     │            │
│    │    │        ┌──────────────────┴──────────────────┐        │     │            │
│    │    │        │         Market Resolves             │        │     │            │
│    │    │        │   (batch_settle_with_proof)         │        │     │            │
│    │    │        └──────────────────┬──────────────────┘        │     │            │
│    │    │                           │                           │     │            │
│    │    │          ┌────────────────┴────────────────┐          │     │            │
│    │    │          │                                 │          │     │            │
│    │    ▼          ▼                                 ▼          ▼     │            │
│    │  ┌─────────────────┐                   ┌─────────────────┐      │            │
│    │  │   WON           │                   │   LOST          │      │            │
│    │  │                 │                   │                 │      │            │
│    │  │ Merkle proof    │                   │ Merkle proof    │      │            │
│    │  │ verifies payout │                   │ verifies $0     │      │            │
│    │  │ → USDC transfer │                   │ (no transfer)   │      │            │
│    │  └────────┬────────┘                   └────────┬────────┘      │            │
│    │           │                                     │               │            │
│    │           └─────────────────┬───────────────────┘               │            │
│    │                             │                                   │            │
│    │                             ▼                                   │            │
│    │                       ┌───────────┐                             │            │
│    └──────────────────────▶│  SETTLED  │◀────────────────────────────┘            │
│                            │           │                                           │
│                            │ Payout received (if winner)                           │
│                            │ Tokens can be burned or left                          │
│                            └───────────┘                                           │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘

SETTLEMENT CALCULATION (V2 - Same Logic, Token-Based):
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  Pre-settlement: Snapshot all token balances                                 │
│    - Query YES token holders (getProgramAccounts on YES mint)               │
│    - Query NO token holders (getProgramAccounts on NO mint)                 │
│                                                                              │
│  Payout Calculation:                                                         │
│    If outcome = YES:                                                         │
│      payout = user's YES token balance × $1.00                              │
│      (NO tokens worth $0)                                                    │
│                                                                              │
│    If outcome = NO:                                                          │
│      payout = user's NO token balance × $1.00                               │
│      (YES tokens worth $0)                                                   │
│                                                                              │
│  Merkle Tree:                                                                │
│    leaf = keccak256(recipient || payout_amount)                             │
│    All leaves → merkle tree → root posted on-chain                          │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Token Account Structure

Users hold tokens in Associated Token Accounts (ATAs):

```
User Wallet: Alice (7xK...)
├── SOL balance
├── USDC ATA: Gh9Z...  (balance: 1000.00)
├── YES ATA (BTC-5m): 9aB2...  (balance: 150 tokens)
├── NO ATA (BTC-5m): 3cD4...  (balance: 0 tokens)
├── YES ATA (ETH-1h): 5eF6...  (balance: 75 tokens)
└── NO ATA (ETH-1h): 7gH8...  (balance: 200 tokens)
```

---

## 4. Settlement Batch State Machine (V2 - NEW)

Individual settlement batches progress through states. Status transitions are
written to the `settlement_jobs` table by the `onchain-submit` BullMQ worker
(`apps/api/src/queue/workers/onchain-submit.worker.ts`), not by a keeper job.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        SETTLEMENT BATCH LIFECYCLE (V2)                           │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                          Merkle root posted on-chain                            │
│                          Settlement jobs created in DB                          │
│                          Enqueued on BullMQ `onchain-submit`                    │
│                                      │                                          │
│                                      ▼                                          │
│                                ┌──────────┐                                    │
│                                │ PENDING  │                                    │
│                                │          │                                    │
│                                │ In queue │                                    │
│                                └────┬─────┘                                    │
│                                     │                                          │
│                                     │ Worker acquires fee payer, submits TX    │
│                                     ▼                                          │
│                               ┌───────────┐                                    │
│                               │ SUBMITTED │                                    │
│                               │           │                                    │
│                               │ attempts++│                                    │
│                               │ awaiting  │                                    │
│                               │ confirm   │                                    │
│                               └─────┬─────┘                                    │
│                                     │                                          │
│                    ┌────────────────┴────────────────┐                         │
│                    │                                 │                         │
│                    │ TX confirmed OR                 │ TX failed / exhausted   │
│                    │ already-claimed                 │ retries                 │
│                    ▼                                 ▼                         │
│              ┌───────────┐                     ┌──────────┐                    │
│              │ COMPLETED │                     │  FAILED  │                    │
│              │           │                     │          │                    │
│              │ tx_sig,   │                     │ error_   │                    │
│              │ completed │                     │ message  │                    │
│              │ _at set   │                     │ logged   │                    │
│              └───────────┘                     └────┬─────┘                    │
│                                                     │                          │
│                                                     │ BullMQ retry (bounded)   │
│                                                     ▼                          │
│                                               ┌───────────┐                    │
│                                               │ SUBMITTED │ (re-submitted)     │
│                                               └───────────┘                    │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

Raw states (settlement_jobs.status): 'PENDING' | 'SUBMITTED' | 'COMPLETED' | 'FAILED'.
There is no separate 'PROCESSING'/'CONFIRMED' pair — transient work lives
entirely within BullMQ job attempts.

BATCH STRUCTURE:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  Settlement Batch (15 users per batch):                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  batch_id: "market123_batch_7"                                          │ │
│  │  market_pubkey: "BTC5m12..."                                            │ │
│  │  batch_index: 7                                                         │ │
│  │                                                                         │ │
│  │  entries: [                                                             │ │
│  │    { recipient: "Alice...", amount: 150.00, proof: [...] },             │ │
│  │    { recipient: "Bob...",   amount: 75.00,  proof: [...] },             │ │
│  │    ... (up to 15 entries)                                               │ │
│  │  ]                                                                      │ │
│  │                                                                         │ │
│  │  status: PENDING | SUBMITTED | COMPLETED | FAILED                       │ │
│  │  relayer_pubkey: "Relayer3..."                                          │ │
│  │  tx_signature: "5xK7..."                                                │ │
│  │  attempts: 1                                                            │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Trade Type State Machine (V2)

Trade types remain the same, but mechanics differ for tokens.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          TRADE TYPE DETECTION (V2)                               │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                              Matching Engine finds fill                         │
│                                        │                                        │
│                                        ▼                                        │
│                              ┌───────────────────┐                              │
│                              │ Does seller have  │                              │
│                              │ tokens to sell?   │                              │
│                              └─────────┬─────────┘                              │
│                                        │                                        │
│                        ┌───────────────┴───────────────┐                        │
│                        │                               │                        │
│                       YES                              NO                       │
│                        │                               │                        │
│                        ▼                               ▼                        │
│               ┌─────────────────┐          ┌───────────────────────┐            │
│               │  CLOSING TRADE  │          │   OPENING TRADE       │            │
│               │  (V2: Transfer) │          │   (V2: Mint)          │            │
│               │                 │          │                       │            │
│               │ • Buyer USDC    │          │ • Both deposit USDC   │            │
│               │   → Seller      │          │   → Vault             │            │
│               │ • Seller tokens │          │ • Mint YES to buyer   │            │
│               │   → Buyer ATA   │          │ • Mint NO to seller   │            │
│               │ • No minting    │          │ • open_interest++     │            │
│               └─────────────────┘          └───────────────────────┘            │
│                                                                                 │
│                                                                                 │
│  V2 COLLATERAL FLOW:                                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                                                                         │   │
│  │  OPENING TRADE (New Position Pair):                                     │   │
│  │  ├─ Buyer: $50 USDC → Vault                                             │   │
│  │  ├─ Seller: $50 USDC → Vault                                            │   │
│  │  ├─ Vault: Mint 100 YES tokens → Buyer's ATA                            │   │
│  │  ├─ Vault: Mint 100 NO tokens → Seller's ATA                            │   │
│  │  └─ market.open_interest += 100                                         │   │
│  │                                                                         │   │
│  │  CLOSING TRADE (Position Transfer):                                     │   │
│  │  ├─ Buyer: $50 USDC → Seller's wallet                                   │   │
│  │  ├─ Seller: 100 YES tokens → Buyer's ATA                                │   │
│  │  └─ market.open_interest unchanged                                      │   │
│  │                                                                         │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Relayer Pool State Machine (V2 - NEW)

Child relayer wallets live in the `relayer_wallets` table (raw SQL —
`relayer_wallets` is managed outside the Drizzle schema). State transitions are
driven by `apps/api/src/services/relayer-pool.service.ts`.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         RELAYER STATE (V2)                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                            ┌──────────────────┐                                │
│                            │      active      │                                │
│                            │                  │                                │
│                            │ Eligible for     │                                │
│                            │ acquireFeePayer  │                                │
│                            └────────┬─────────┘                                │
│                                     │                                          │
│                                     │ releaseFeePayer(success=false)           │
│                                     │ consecutive_failures >= threshold        │
│                                     ▼                                          │
│                            ┌──────────────────┐                                │
│                            │     cooldown     │                                │
│                            │                  │                                │
│                            │ cooldown_until   │                                │
│                            │ timestamp set    │                                │
│                            └────────┬─────────┘                                │
│                                     │                                          │
│                                     │ cooldown_until < NOW()                   │
│                                     │ (restored on next acquire)               │
│                                     ▼                                          │
│                            ┌──────────────────┐                                │
│                            │      active      │                                │
│                            │ failures reset   │                                │
│                            └──────────────────┘                                │
│                                                                                 │
│                            ┌──────────────────┐                                │
│                            │     disabled     │                                │
│                            │                  │                                │
│                            │ Permanently      │                                │
│                            │ removed; skipped │                                │
│                            │ by all selectors │                                │
│                            └──────────────────┘                                │
│                                                                                 │
│  RELAYER ACQUISITION (acquireFeePayer):                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                                                                         │   │
│  │  1. Promote any `cooldown` wallet whose `cooldown_until < NOW()`        │   │
│  │     back to `active` (with consecutive_failures reset).                 │   │
│  │  2. Pick the child wallet with status='active' and                      │   │
│  │     balance_lamports >= MIN_BALANCE_SOL, ordered by                     │   │
│  │     active_jobs ASC, last_used_at ASC NULLS FIRST. LIMIT 1.             │   │
│  │  3. Fallback chain if no child is eligible:                             │   │
│  │       child pool → master1 → master2                                    │   │
│  │  4. Master wallets are not state-tracked; they are always eligible      │   │
│  │     if on-chain balance is above MIN_BALANCE_SOL.                       │   │
│  │                                                                         │   │
│  │  Auto-Funding (Relayer Pool Funder keeper, every 30s):                  │   │
│  │  For every non-disabled child with balance < MIN_BALANCE_SOL,           │   │
│  │  transfer FUND_AMOUNT_SOL from master1 (fallback master2).              │   │
│  │                                                                         │   │
│  │  Circuit Breaker:                                                       │   │
│  │  `disabled` is a terminal state set manually (no automatic promotion    │   │
│  │  from `cooldown` → `disabled` today). The cooldown path is the only    │   │
│  │  automatic backoff; persistent failures just keep bouncing through it. │   │
│  │                                                                         │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Keeper Jobs Schedule (V2)

Source of truth: `apps/api/src/jobs/index.ts`. Intervals have two columns —
the default runtime and the value used when `PERF_TEST_MODE=true` (disables
some jobs entirely to avoid load during benchmarks). All jobs add 0–500ms
random jitter per tick to avoid lock-step scheduling, and each job can be
skipped when the DB pool's `waitingCount` is too high.

Batch settlement is **not** a keeper job — batches are enqueued to the
BullMQ `onchain-submit` queue by the Merkle Settler and consumed by
`apps/api/src/queue/workers/onchain-submit.worker.ts`.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           KEEPER JOB SCHEDULE V2                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  TIMELINE (per market lifecycle):                                               │
│                                                                                 │
│  T-30s    T-0s       T+0s      T+3s      T+3s       (via queue)    T+30s        │
│    │       │          │         │          │             │            │         │
│    ▼       ▼          ▼         ▼          ▼             ▼            ▼         │
│  ┌──────┐ ┌──────┐ ┌────────┐ ┌───────┐ ┌─────────┐ ┌──────────┐ ┌─────────┐  │
│  │CREATE│ │ACTIV.│ │ CLOSE  │ │RESOLVE│ │ MERKLE  │ │ onchain- │ │ CLOSE   │  │
│  │      │ │      │ │TRADING │ │       │ │SETTLER  │ │ submit   │ │ MARKET  │  │
│  │Market│ │Strike│ │(at     │ │Set    │ │ builds  │ │ BullMQ   │ │ Close   │  │
│  │+Mints│ │+Acti-│ │ expiry │ │outcome│ │ tree &  │ │ worker   │ │ mints,  │  │
│  │(DB)  │ │vate  │ │ inside │ │       │ │ posts   │ │ processes│ │ recover │  │
│  │      │ │      │ │resolver│ │       │ │ root    │ │ batches  │ │ rent    │  │
│  └──────┘ └──────┘ └────────┘ └───────┘ └─────────┘ └──────────┘ └─────────┘  │
│                                                                                 │
│  V2 JOB INTERVALS (default / perf-test mode):                                   │
│  ┌────────────────────────┬──────────────────┬────────────────────────────────┐│
│  │ Job                    │ Interval         │ Purpose                        ││
│  ├────────────────────────┼──────────────────┼────────────────────────────────┤│
│  │ Market Activator       │ 500ms  / 10s     │ Set strike, activate on-chain  ││
│  │ Market Resolver        │ 3s     / 10s     │ Close + resolve expired markets││
│  │ Market Creator         │ 30s    / 60s     │ Pre-create PENDING markets     ││
│  │ Order Expirer          │ 10s    / off     │ Cancel GTT + pre-close orders  ││
│  │ Merkle Settler         │ 3s     / 30s     │ Build tree, post root, enqueue ││
│  │                        │                  │ batches, finalize market       ││
│  │ Market Closer          │ 30s    / off     │ Close SETTLED market accounts, ││
│  │                        │                  │ reclaim rent                   ││
│  │ Market Reconciler      │ 60s    / off     │ Fix drift between chain ↔ DB   ││
│  │ Trade Reconciliation   │ 60s    / off     │ Reconcile trade TX outcomes    ││
│  │ Relayer Pool Funder    │ 30s    / off     │ Refund low child wallets from  ││
│  │                        │                  │ masters; also refreshes        ││
│  │                        │                  │ balance_lamports               ││
│  └────────────────────────┴──────────────────┴────────────────────────────────┘│
│                                                                                 │
│  BATCH SETTLEMENT (not a keeper job):                                           │
│    • BullMQ queue       : onchain-submit                                        │
│    • Worker             : apps/api/src/queue/workers/onchain-submit.worker.ts   │
│    • Triggered by       : Merkle Settler enqueueing per-batch jobs              │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Summary: V2 Status Enums

```typescript
// Database Enums (apps/api/src/db/schema.ts)
// NOTE: PENDING is not a DB enum value — pending markets use strike_price='0'.
// NOTE: SETTLING is not a DB enum value — it is chain-only/transient.
type MarketStatus = 'OPEN' | 'CLOSED' | 'RESOLVED' | 'SETTLED' | 'SETTLEMENT_FAILED';
type OrderSide = 'BID' | 'ASK';
type OrderOutcome = 'YES' | 'NO';
type OrderType = 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
type OrderStatus = 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED'; // EXPIRED lives on-chain only
type TxStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';
type LedgerType = 'DEPOSIT' | 'WITHDRAW' | 'TRADE' | 'SETTLE' | 'FEE';

// V2 Settlement / Relayer state (raw SQL in init-db.sql, not Drizzle)
type SettlementJobStatus = 'PENDING' | 'SUBMITTED' | 'COMPLETED' | 'FAILED';
type RelayerWalletStatus = 'active' | 'cooldown' | 'disabled';

// On-Chain V2 Enums (packages/contracts/programs/degen-terminal/src/state_v2.rs)
enum MarketStatusV2 { Pending, Open, Closed, Resolved, Settling, Settled }
enum MarketOutcomeV2 { Pending, Yes, No }

// On-Chain V1 Enums still present for legacy markets
// (packages/contracts/programs/degen-terminal/src/state.rs)
enum MarketStatus { Pending, Open, Closed, Resolved, Settled }  // no Settling in V1
enum MarketOutcome { Pending, Yes, No }
enum OrderStatus { Open, PartialFill, Filled, Cancelled, Expired }
enum Side { Bid, Ask }
enum Outcome { Yes, No }
enum OrderType { Limit, Market, IOC, FOK }
enum TradeType { Opening, Closing }
```

---

## Migration Notes

### State Machine Transition Compatibility

- V1 markets in progress will use V1 state machine (RESOLVED → SETTLED directly)
- V2 markets use new state machine (RESOLVED → SETTLING → SETTLED)
- Both can coexist during migration period
- DB column `market_version` distinguishes V1 vs V2 markets

### Keeper Job Coexistence

During migration:
- V1 `position-settler` job handles V1 markets
- V2 `merkle-builder` + `batch-settler` jobs handle V2 markets
- Both run in parallel, keyed by market version

---

*Last updated: April 2026*
