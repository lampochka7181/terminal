# State Machine Diagrams V2

This document describes all state machines in the Degen Terminal V2 system with tokenized shares and merkle batch settlement.

> **Changes from V1**:
> - Market lifecycle includes SETTLING state for merkle settlement
> - Position lifecycle replaced by token holdings
> - Settlement uses merkle proofs and parallel relayers
> - Leverage flow updated for token model

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

```rust
pub enum MarketStatus {
    Pending = 0,    // Pre-created, awaiting activation
    Open = 1,       // Trading active, YES/NO tokens being minted/transferred
    Closed = 2,     // Trading stopped, awaiting resolution
    Resolved = 3,   // Outcome determined (YES or NO)
    Settling = 4,   // NEW: Merkle root posted, batches processing
    Settled = 5,    // All payouts distributed
}
```

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

Orders remain unchanged from V1 - they can be filled, partially filled, cancelled, or expire.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                             ORDER LIFECYCLE                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                        ┌─────────────────────────────────────┐                  │
│                        │            User places order        │                  │
│                        │         (place_order instruction)   │                  │
│                        └─────────────────┬───────────────────┘                  │
│                                          │                                      │
│                                          ▼                                      │
│                                     ┌─────────┐                                │
│                              ┌──────│  OPEN   │──────┐                         │
│                              │      └────┬────┘      │                         │
│                              │           │           │                         │
│                    partial   │           │           │   user cancels          │
│                    fill      │           │           │   (cancel_order)        │
│                              ▼           │           ▼                         │
│                        ┌─────────┐       │     ┌───────────┐                   │
│                        │ PARTIAL │       │     │ CANCELLED │                   │
│                        │         │       │     │           │                   │
│                        └────┬────┘       │     └───────────┘                   │
│                             │            │           ▲                         │
│             remaining fill  │            │           │                         │
│             completes       │            │           │ market closes           │
│                             │            │           │ (MARKET_CLOSED)         │
│                             ▼            │           │                         │
│                        ┌─────────┐       │           │ order expires           │
│                        │ FILLED  │◀──────┘           │ (EXPIRED)               │
│                        │         │    full fill      │                         │
│                        └─────────┘                   │                         │
│                                                      │                         │
│                             ┌─────────┐              │                         │
│                             │ EXPIRED │◀─────────────┘                         │
│                             │         │  (GTT order past expiry_ts)            │
│                             └─────────┘                                        │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

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

Individual settlement batches progress through states.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        SETTLEMENT BATCH LIFECYCLE (V2)                           │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                          Merkle root posted on-chain                            │
│                          Settlement jobs created in DB                          │
│                                      │                                          │
│                                      │                                          │
│                                      ▼                                          │
│                                ┌──────────┐                                    │
│                                │ PENDING  │                                    │
│                                │          │                                    │
│                                │ In queue │                                    │
│                                └────┬─────┘                                    │
│                                     │                                          │
│                                     │ Relayer claims job                       │
│                                     ▼                                          │
│                               ┌───────────┐                                    │
│                               │PROCESSING │                                    │
│                               │           │                                    │
│                               │ Building  │                                    │
│                               │ TX...     │                                    │
│                               └─────┬─────┘                                    │
│                                     │                                          │
│                    ┌────────────────┴────────────────┐                         │
│                    │                                 │                         │
│                    │ TX confirmed                    │ TX failed               │
│                    ▼                                 ▼                         │
│              ┌───────────┐                     ┌──────────┐                    │
│              │ CONFIRMED │                     │  FAILED  │                    │
│              │           │                     │          │                    │
│              │ tx_sig    │                     │ error    │                    │
│              │ recorded  │                     │ logged   │                    │
│              └───────────┘                     └────┬─────┘                    │
│                                                     │                          │
│                                                     │ Retry (up to 3)          │
│                                                     ▼                          │
│                                               ┌──────────┐                     │
│                                               │ PENDING  │ (re-queued)         │
│                                               └──────────┘                     │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

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
│  │  status: PENDING | PROCESSING | CONFIRMED | FAILED                      │ │
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

## 6. Margin Account Lifecycle (V2 - Leverage)

Margin accounts work the same conceptually, but the Lending Pool holds tokens instead of a Position PDA.

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                     MARGIN ACCOUNT LIFECYCLE V2 (Tokenized)                          │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│                         User places leveraged order                                 │
│                         (leverage > 1x, e.g., 5x)                                   │
│                                      │                                              │
│                                      │ Margin collected from user                   │
│                                      │ Loan recorded in DB                          │
│                                      │ Lending Pool executes trade                  │
│                                      ▼                                              │
│                                 ┌─────────┐                                        │
│    ┌───────────────────────────│  OPEN   │───────────────────────────┐            │
│    │                           └────┬────┘                           │            │
│    │                                │                                │            │
│    │ Price moves toward             │                                │ Price drops │
│    │ liquidation price              │ User sells position            │ below liq   │
│    │                                │ (manual close)                 │ price       │
│    │                                │                                │            │
│    │    ┌───────────────────────────┼───────────────────────────┐    │            │
│    │    │                           │                           │    │            │
│    │    │        ┌──────────────────┴──────────────────┐        │    │            │
│    │    │        │       Market Resolves               │        │    │            │
│    │    │        │ (LP included in merkle settlement)  │        │    │            │
│    │    │        └──────────────────┬──────────────────┘        │    │            │
│    │    │                           │                           │    │            │
│    │    ▼                           ▼                           ▼    │            │
│    │  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────────┐         │
│    │  │ MANUAL CLOSE    │    │ SETTLEMENT      │    │  LIQUIDATED      │         │
│    │  │                 │    │                 │    │                  │         │
│    │  │ • LP sells      │    │ • LP receives   │    │ • Keeper sells   │         │
│    │  │   tokens        │    │   payout        │    │   LP's tokens    │         │
│    │  │ • Loan repaid   │    │ • Loan repaid   │    │ • Loan repaid    │         │
│    │  │ • Equity→user   │    │ • Profit→user   │    │ • Penalty→Ins.   │         │
│    │  │                 │    │ • Loss→Ins.     │    │ • Remaining→user │         │
│    │  └────────┬────────┘    └────────┬────────┘    └────────┬─────────┘         │
│    │           │                      │                      │                   │
│    │           └──────────────────────┼──────────────────────┘                   │
│    │                                  │                                          │
│    │                                  ▼                                          │
│    │                            ┌──────────┐                                     │
│    └───────────────────────────▶│  CLOSED  │◀────────────────────────────────────┘
│                                 │          │
│                                 │ status = CLOSED                                │
│                                 │ closedAt = now                                 │
│                                 └──────────┘                                     │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘

V2 KEY DIFFERENCE - TOKEN HOLDINGS:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  V1 (Position PDA):                      V2 (Tokens):                        │
│  ─────────────────                       ────────────                        │
│  Lending Pool has Position PDA           Lending Pool has YES/NO tokens      │
│  with yes_shares/no_shares fields        in its Associated Token Accounts    │
│                                                                              │
│  On-Chain State:                         On-Chain State:                     │
│  ┌────────────────────────┐              ┌────────────────────────┐          │
│  │ Position PDA           │              │ Lending Pool Wallet    │          │
│  │   owner: Lending Pool  │              │   YES ATA: 250 tokens  │          │
│  │   yes_shares: 250      │              │   NO ATA: 0 tokens     │          │
│  │   no_shares: 0         │              │                        │          │
│  └────────────────────────┘              └────────────────────────┘          │
│                                                                              │
│  Database (unchanged):                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  margin_accounts:                                                       │ │
│  │    user_id: alice                                                       │ │
│  │    side: YES                                                            │ │
│  │    shares: 250  (beneficial ownership of LP's tokens)                   │ │
│  │    loan_amount: $200                                                    │ │
│  │    leverage: 5x                                                         │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### V2 Leveraged Settlement Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    LEVERAGED SETTLEMENT FLOW (V2)                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  1. Market reaches RESOLVED status                                              │
│                                                                                 │
│  2. Merkle tree builder snapshots token balances:                               │
│     - Lending Pool has 500 YES tokens (across all leveraged positions)          │
│     - Regular users have their own token balances                               │
│                                                                                 │
│  3. Merkle tree includes Lending Pool:                                          │
│     leaf = hash(lending_pool_pubkey, $500_payout)                               │
│                                                                                 │
│  4. batch_settle_with_proof transfers $500 to Lending Pool                      │
│                                                                                 │
│  5. Lending Pool Distribution Job (runs after settlement):                      │
│                                                                                 │
│     For each margin_account linked to this market:                              │
│     ┌─────────────────────────────────────────────────────────────────────────┐│
│     │  Alice's account: 250 shares @ 5x                                       ││
│     │    payout_share = 250 × $1.00 = $250                                    ││
│     │    loan_repaid = $200                                                   ││
│     │    user_profit = $250 - $200 = $50 → Transfer to Alice                  ││
│     │                                                                         ││
│     │  Bob's account: 250 shares @ 3x                                         ││
│     │    payout_share = 250 × $1.00 = $250                                    ││
│     │    loan_repaid = $167                                                   ││
│     │    user_profit = $250 - $167 = $83 → Transfer to Bob                    ││
│     └─────────────────────────────────────────────────────────────────────────┘│
│                                                                                 │
│  6. On-chain transfers from Lending Pool to users                               │
│     (can be batched or individual)                                              │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Relayer Pool State Machine (V2 - NEW)

Individual relayers in the pool have states.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         RELAYER STATE (V2)                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                            ┌──────────────────┐                                │
│                            │      IDLE        │                                │
│                            │                  │                                │
│                            │ Waiting for jobs │                                │
│                            └────────┬─────────┘                                │
│                                     │                                          │
│                                     │ Job claimed from queue                   │
│                                     ▼                                          │
│                            ┌──────────────────┐                                │
│                            │     ACTIVE       │                                │
│                            │                  │                                │
│                            │ Processing batch │                                │
│                            │ tx_in_flight++   │                                │
│                            └────────┬─────────┘                                │
│                                     │                                          │
│                    ┌────────────────┴────────────────┐                         │
│                    │                                 │                         │
│                    │ TX confirmed                    │ TX failed               │
│                    ▼                                 ▼                         │
│            ┌──────────────────┐            ┌──────────────────┐                │
│            │   IDLE           │            │   COOLDOWN       │                │
│            │                  │            │                  │                │
│            │ success_count++  │            │ failure_count++  │                │
│            │ Ready for next   │            │ Brief pause      │                │
│            └──────────────────┘            │ before retry     │                │
│                    ▲                       └────────┬─────────┘                │
│                    │                                │                          │
│                    │         After cooldown         │                          │
│                    └────────────────────────────────┘                          │
│                                                                                 │
│  RELAYER POOL MANAGEMENT:                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                                                                         │   │
│  │  Relayer Selection (for job assignment):                                │   │
│  │  1. Filter: status == IDLE && balance > MIN_SOL                         │   │
│  │  2. Sort by: success_rate DESC, last_used ASC                           │   │
│  │  3. Assign to highest-ranked available relayer                          │   │
│  │                                                                         │   │
│  │  Auto-Funding:                                                          │   │
│  │  If relayer.balance < 0.1 SOL → Fund from master wallet                 │   │
│  │                                                                         │   │
│  │  Circuit Breaker:                                                       │   │
│  │  If relayer.failure_rate > 50% in last 10 jobs → Mark as UNHEALTHY      │   │
│  │  UNHEALTHY relayers skipped until manual review                         │   │
│  │                                                                         │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Keeper Jobs Schedule (V2)

Updated job schedule with new V2 jobs.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           KEEPER JOB SCHEDULE V2                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  TIMELINE (per market lifecycle):                                               │
│                                                                                 │
│  T-5min     T-0s      T+0s      T+2s        T+5s         T+30s      T+60s       │
│     │         │         │         │           │             │          │        │
│     ▼         ▼         ▼         ▼           ▼             ▼          ▼        │
│  ┌──────┐ ┌──────┐ ┌────────┐ ┌───────┐ ┌─────────┐ ┌──────────┐ ┌─────────┐  │
│  │CREATE│ │ACTIV.│ │ CLOSE  │ │RESOLVE│ │ MERKLE  │ │  BATCH   │ │FINALIZE │  │
│  │      │ │      │ │TRADING │ │       │ │  ROOT   │ │ SETTLE   │ │         │  │
│  │Market│ │Create│ │Window  │ │Set    │ │ Build & │ │ Parallel │ │ Close   │  │
│  │+Mints│ │Strike│ │        │ │outcome│ │ Post    │ │ relayers │ │ mints   │  │
│  └──────┘ └──────┘ └────────┘ └───────┘ └─────────┘ └──────────┘ └─────────┘  │
│                                                                                 │
│  V2 JOB INTERVALS:                                                              │
│  ┌────────────────────────┬──────────┬──────────────────────────────────────┐  │
│  │ Job                    │ Interval │ Purpose                              │  │
│  ├────────────────────────┼──────────┼──────────────────────────────────────┤  │
│  │ Market Creator         │ 30s      │ Create PENDING markets + token mints │  │
│  │ Market Activator       │ 5s       │ Set strike price, activate market    │  │
│  │ Market Resolver        │ 2s       │ Resolve expired markets              │  │
│  │ Merkle Builder         │ 2s       │ Build & post merkle root for RESOLVED│  │ ◀ NEW
│  │ Batch Settler          │ 1s       │ Process settlement batches (parallel)│  │ ◀ NEW
│  │ Market Finalizer       │ 10s      │ Finalize SETTLED markets, close mints│  │ ◀ NEW
│  │ Order Expirer          │ 10s      │ Cancel GTT orders + market close     │  │
│  │ Liquidation Checker    │ 1s       │ Check & liquidate underwater margin  │  │
│  │ Lending Pool Syncer    │ 60s      │ Sync lending pool token balances     │  │
│  │ LP Distribution        │ 5s       │ Distribute LP payouts to users       │  │ ◀ NEW
│  │ Relayer Health Check   │ 30s      │ Monitor relayer balances & health    │  │ ◀ NEW
│  │ Reconciliation         │ 5m       │ Fix stuck jobs, missing DB updates   │  │ ◀ NEW
│  └────────────────────────┴──────────┴──────────────────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Summary: V2 Status Enums

```typescript
// Database Enums (apps/api/src/db/schema.ts) - V2 Updates
type MarketStatus = 'PENDING' | 'OPEN' | 'CLOSED' | 'RESOLVED' | 'SETTLING' | 'SETTLED';  // SETTLING is new
type OrderSide = 'BID' | 'ASK';
type OrderOutcome = 'YES' | 'NO';
type OrderType = 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
type OrderStatus = 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED';
type TxStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';
type LedgerType = 'DEPOSIT' | 'WITHDRAW' | 'TRADE' | 'SETTLE' | 'FEE';

// V2 New Enums
type SettlementBatchStatus = 'PENDING' | 'PROCESSING' | 'CONFIRMED' | 'FAILED';
type RelayerStatus = 'IDLE' | 'ACTIVE' | 'COOLDOWN' | 'UNHEALTHY';

// Leverage Enums (unchanged)
type MarginAccountStatus = 'OPEN' | 'CLOSED' | 'LIQUIDATED';
type MarginTransactionType = 'MARGIN_DEPOSIT' | 'LOAN_ISSUED' | 'LOAN_REPAID' |
                             'LIQUIDATION' | 'MARGIN_ADDED' | 'EQUITY_RETURNED';

// On-Chain Enums (packages/contracts/programs/degen-terminal-v2/src/state.rs)
enum MarketStatus { Pending, Open, Closed, Resolved, Settling, Settled }  // Settling is new
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

*Last updated: January 2026*
