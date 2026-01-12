# State Machine Diagrams

This document describes all state machines in the Degen Terminal system.

---

## 1. Market Lifecycle State Machine

Markets progress through 5 states from creation to final settlement.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            MARKET LIFECYCLE                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│    ┌─────────┐    activate_market    ┌─────────┐                               │
│    │ PENDING │ ─────────────────────▶│  OPEN   │                               │
│    │         │   (set strike price)  │         │                               │
│    └─────────┘                       └────┬────┘                               │
│         │                                 │                                     │
│         │ initialize_market               │ expiry_at reached                   │
│         │ (strike_price > 0)              │ (trading window closes)             │
│         │                                 ▼                                     │
│         │                           ┌─────────┐                                │
│         └──────────────────────────▶│ CLOSED  │◀─── Trading stops T-2s         │
│              (direct activation)    │         │     before expiry               │
│                                     └────┬────┘                                │
│                                          │                                      │
│                                          │ resolve_market                       │
│                                          │ (keeper fetches final_price,         │
│                                          │  sets outcome: YES or NO)            │
│                                          ▼                                      │
│                                    ┌──────────┐                                │
│                                    │ RESOLVED │                                │
│                                    │          │                                │
│                                    └────┬─────┘                                │
│                                         │                                       │
│                                         │ settle_positions                      │
│                                         │ (all positions paid out,              │
│                                         │  settled_positions == total_positions)│
│                                         ▼                                       │
│                                    ┌──────────┐                                │
│                                    │ SETTLED  │ ─────▶ close_market            │
│                                    │          │        (reclaim rent ~$1.20)   │
│                                    └──────────┘                                │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

TRIGGERS & ACTORS:
┌────────────────────┬──────────────────────────────────────────────────────────┐
│ Transition         │ Actor / Trigger                                          │
├────────────────────┼──────────────────────────────────────────────────────────┤
│ → PENDING          │ Keeper (market-creator job) - every 30s                  │
│ PENDING → OPEN     │ Keeper (market-activator job) - every 5s, sets strike    │
│ → OPEN (direct)    │ initialize_market with strike_price > 0                  │
│ OPEN → CLOSED      │ Automatic at expiry_at - 2 seconds                       │
│ CLOSED → RESOLVED  │ Keeper (market-resolver job) - every 2s                  │
│ RESOLVED → SETTLED │ Keeper (position-settler job) - every 5s                 │
│ SETTLED → (closed) │ Keeper (market-closer job) - every 20s                   │
└────────────────────┴──────────────────────────────────────────────────────────┘
```

### Market Status Values (On-Chain)

```rust
pub enum MarketStatus {
    Pending = 0,    // Pre-created, awaiting activation (strike price not set)
    Open = 1,       // Trading active
    Closed = 2,     // Trading stopped, awaiting resolution
    Resolved = 3,   // Outcome determined (YES or NO)
    Settled = 4,    // All positions paid out
}
```

### Market Outcome Values

```rust
pub enum MarketOutcome {
    Pending = 0,    // Outcome not yet determined
    Yes = 1,        // Price > strike at expiry
    No = 2,         // Price <= strike at expiry
}
```

---

## 2. Order Lifecycle State Machine

Orders can be filled, partially filled, cancelled, or expire.

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

CANCEL REASONS:
┌─────────────────────┬────────────────────────────────────────────────────────┐
│ Reason              │ Description                                            │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ USER                │ User manually cancelled the order                      │
│ USER_CANCEL_ALL     │ User cancelled all orders (bulk cancel)                │
│ MARKET_CLOSED       │ Market expired, all open orders auto-cancelled         │
│ EXPIRED             │ Order's expiry_ts passed (Good-Till-Time)              │
│ SELF_TRADE          │ Would match against user's own order                   │
│ INSUFFICIENT_FUNDS  │ User's balance insufficient at execution time          │
└─────────────────────┴────────────────────────────────────────────────────────┘
```

### Order Status Values (On-Chain & Database)

```rust
pub enum OrderStatus {
    Open = 0,        // Active, can be matched
    PartialFill = 1, // Partially filled, remainder still active
    Filled = 2,      // Fully filled
    Cancelled = 3,   // Cancelled by user or system
    Expired = 4,     // Past expiry_ts (on-chain only)
}
```

### Order Type Behavior

```
┌───────────┬──────────────────────────────────────────────────────────────────┐
│ Type      │ Behavior                                                         │
├───────────┼──────────────────────────────────────────────────────────────────┤
│ LIMIT     │ Match what you can → Add remainder to orderbook                  │
│ MARKET    │ Match at any price → Cancel unfilled (extreme price protection)  │
│ IOC       │ Match immediately → Cancel remainder (no book placement)         │
│ FOK       │ Fill entire order or reject completely (all-or-nothing)          │
└───────────┴──────────────────────────────────────────────────────────────────┘
```

---

## 3. Position Lifecycle State Machine

Positions are created when trades execute and settled when markets resolve.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           POSITION LIFECYCLE                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                           User doesn't have position                            │
│                                      │                                          │
│                                      │ First trade in market                    │
│                                      │ (execute_match creates position PDA)     │
│                                      ▼                                          │
│                                 ┌─────────┐                                    │
│    ┌────────────────────────────│  OPEN   │────────────────────────────┐       │
│    │                            └────┬────┘                            │       │
│    │                                 │                                 │       │
│    │ buy more shares                 │ sell shares                     │       │
│    │ (yes_shares++ or no_shares++)   │ (yes_shares-- or no_shares--)   │       │
│    │                                 │                                 │       │
│    │    ┌────────────────────────────┼────────────────────────────┐    │       │
│    │    │                            │                            │    │       │
│    │    │        ┌───────────────────┴───────────────────┐        │    │       │
│    │    │        │         Market Resolves               │        │    │       │
│    │    │        │   (keeper: settle_positions)          │        │    │       │
│    │    │        └───────────────────┬───────────────────┘        │    │       │
│    │    │                            │                            │    │       │
│    │    │          ┌─────────────────┴─────────────────┐          │    │       │
│    │    │          │                                   │          │    │       │
│    │    ▼          ▼                                   ▼          ▼    │       │
│    │  ┌─────────────────┐                     ┌─────────────────┐     │       │
│    │  │   WON           │                     │   LOST          │     │       │
│    │  │                 │                     │                 │     │       │
│    │  │ Receive $1.00   │                     │ Receive $0.00   │     │       │
│    │  │ per winning     │                     │ per losing      │     │       │
│    │  │ share           │                     │ share           │     │       │
│    │  └────────┬────────┘                     └────────┬────────┘     │       │
│    │           │                                       │              │       │
│    │           └───────────────────┬───────────────────┘              │       │
│    │                               │                                  │       │
│    │                               ▼                                  │       │
│    │                          ┌─────────┐                             │       │
│    └─────────────────────────▶│ SETTLED │◀────────────────────────────┘       │
│                               │         │                                      │
│                               │ settled = true                                 │
│                               │ payout = calculated                            │
│                               └─────────┘                                      │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

SETTLEMENT CALCULATION:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  If outcome = YES:                                                           │
│    payout = yes_shares × $1.00                                               │
│    (NO shares worth $0)                                                      │
│                                                                              │
│  If outcome = NO:                                                            │
│    payout = no_shares × $1.00                                                │
│    (YES shares worth $0)                                                     │
│                                                                              │
│  profit = payout - total_cost_basis                                          │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Position Fields (On-Chain)

```rust
pub struct UserPosition {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub yes_shares: u64,      // 6 decimals
    pub no_shares: u64,       // 6 decimals
    pub yes_cost_basis: u64,  // Total USDC paid for YES
    pub no_cost_basis: u64,   // Total USDC paid for NO
    pub realized_pnl: i64,    // P&L from closing trades
    pub settled: bool,        // Has settlement payout been sent?
    pub payout: u64,          // Amount received at settlement
}
```

---

## 4. Transaction Status State Machine

Trades have a transaction status tracking on-chain confirmation.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          TRANSACTION STATUS                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                           Trade created off-chain                               │
│                                      │                                          │
│                                      │                                          │
│                                      ▼                                          │
│                                ┌──────────┐                                    │
│                                │ PENDING  │                                    │
│                                │          │                                    │
│                                └────┬─────┘                                    │
│                                     │                                          │
│                    ┌────────────────┴────────────────┐                         │
│                    │                                 │                         │
│                    │ Solana TX confirms              │ Solana TX fails         │
│                    │ (success)                       │ (error/timeout)         │
│                    ▼                                 ▼                         │
│              ┌───────────┐                     ┌──────────┐                    │
│              │ CONFIRMED │                     │  FAILED  │                    │
│              │           │                     │          │                    │
│              │ tx_sig    │                     │ error    │                    │
│              │ recorded  │                     │ logged   │                    │
│              └───────────┘                     └──────────┘                    │
│                                                     │                          │
│                                                     │ Retry logic              │
│                                                     │ (up to 3 attempts)       │
│                                                     ▼                          │
│                                               ┌──────────┐                     │
│                                               │ PENDING  │ (re-queued)         │
│                                               └──────────┘                     │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Transaction Status Values

```typescript
type TxStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';
```

---

## 5. Trade Type State Machine

Determines how collateral and shares flow during a trade.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                             TRADE TYPE DETECTION                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                              Matching Engine finds fill                         │
│                                        │                                        │
│                                        │                                        │
│                                        ▼                                        │
│                              ┌───────────────────┐                              │
│                              │ Is taker selling? │                              │
│                              │   (side == ASK)   │                              │
│                              └─────────┬─────────┘                              │
│                                        │                                        │
│                        ┌───────────────┴───────────────┐                        │
│                        │                               │                        │
│                       NO                              YES                       │
│                        │                               │                        │
│                        ▼                               ▼                        │
│               ┌─────────────────┐          ┌───────────────────────┐            │
│               │  OPENING TRADE  │          │ Does seller have      │            │
│               │                 │          │ enough shares?        │            │
│               │ execute_match   │          └───────────┬───────────┘            │
│               │ instruction     │                      │                        │
│               └─────────────────┘          ┌───────────┴───────────┐            │
│                       │                    │                       │            │
│                       │                   YES                      NO           │
│                       │                    │                       │            │
│                       │                    ▼                       ▼            │
│                       │           ┌─────────────────┐    ┌─────────────────┐    │
│                       │           │ CLOSING TRADE   │    │ OPENING TRADE   │    │
│                       │           │                 │    │                 │    │
│                       │           │ execute_close   │    │ execute_match   │    │
│                       │           │ instruction     │    │ (fallback)      │    │
│                       │           └─────────────────┘    └─────────────────┘    │
│                       │                    │                       │            │
│                       ▼                    ▼                       ▼            │
│         ┌─────────────────────────────────────────────────────────────────┐     │
│         │                        COLLATERAL FLOW                          │     │
│         ├─────────────────────────────────────────────────────────────────┤     │
│         │                                                                 │     │
│         │  OPENING TRADE:                  CLOSING TRADE:                 │     │
│         │  ├─ Buyer USDC → Vault           ├─ Buyer USDC → Seller         │     │
│         │  ├─ Seller USDC → Vault          ├─ Seller shares → Buyer       │     │
│         │  ├─ Mint YES to buyer            ├─ Open interest unchanged     │     │
│         │  ├─ Mint NO to seller            │                              │     │
│         │  └─ Open interest += size        │                              │     │
│         │                                                                 │     │
│         └─────────────────────────────────────────────────────────────────┘     │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Trade Type Values (On-Chain)

```rust
pub enum TradeType {
    Opening = 0,  // Both parties deposit USDC, mint YES/NO pair
    Closing = 1,  // Seller transfers shares, buyer pays USDC
}
```

---

## 6. Protocol State Machine

The protocol can be paused by admin in emergencies.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                             PROTOCOL STATE                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                                ┌──────────┐                                    │
│                         ┌──────│  ACTIVE  │◀─────┐                             │
│                         │      │          │      │                             │
│                         │      │ paused   │      │ pause_protocol              │
│                         │      │ = false  │      │ (paused = false)            │
│                         │      └────┬─────┘      │                             │
│                         │           │            │                             │
│                         │           │            │                             │
│    All operations       │           │ pause_protocol                           │
│    allowed:             │           │ (admin only)                             │
│    • place_order        │           │ (paused = true)                          │
│    • execute_match      │           │                                          │
│    • cancel_order       │           ▼                                          │
│                         │      ┌──────────┐                                    │
│                         │      │  PAUSED  │                                    │
│                         │      │          │                                    │
│                         │      │ paused   │                                    │
│                         │      │ = true   │                                    │
│                         │      │ reason   │                                    │
│                         │      │ stored   │                                    │
│                         │      └──────────┘                                    │
│                         │           │                                          │
│                         │           │                                          │
│    Blocked operations:  │           │                                          │
│    • place_order ❌     └───────────┘                                          │
│    • execute_match ❌                                                          │
│                                                                                 │
│    Allowed operations:                                                          │
│    • cancel_order ✓                                                            │
│    • resolve_market ✓ (settlements continue)                                   │
│    • settle_positions ✓                                                        │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### GlobalState Fields

```rust
pub struct GlobalState {
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub maker_fee_bps: u16,
    pub taker_fee_bps: u16,
    pub paused: bool,                          // Protocol pause flag
    pub pause_reason: [u8; 100],               // Human-readable reason
    pub paused_at: i64,                        // Timestamp of pause
    pub total_markets: u64,
    pub total_volume: u64,
}
```

---

## 7. User Authentication State Machine

User authentication flow with Solana wallet (SIWS).

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         USER AUTHENTICATION                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                            ┌──────────────────┐                                │
│                            │   DISCONNECTED   │                                │
│                            │                  │                                │
│                            │ No wallet        │                                │
│                            │ connected        │                                │
│                            └────────┬─────────┘                                │
│                                     │                                          │
│                                     │ connect wallet                           │
│                                     │ (Phantom, Solflare, etc.)                │
│                                     ▼                                          │
│                            ┌──────────────────┐                                │
│                            │    CONNECTED     │                                │
│                            │                  │                                │
│                            │ Wallet address   │                                │
│                            │ available        │                                │
│                            └────────┬─────────┘                                │
│                                     │                                          │
│                                     │ GET /auth/nonce                          │
│                                     │ (server generates challenge)             │
│                                     ▼                                          │
│                            ┌──────────────────┐                                │
│                            │ CHALLENGE_ISSUED │                                │
│                            │                  │                                │
│                            │ nonce received   │                                │
│                            │ expiry set       │                                │
│                            └────────┬─────────┘                                │
│                                     │                                          │
│                                     │ User signs message with wallet           │
│                                     │ POST /auth/verify                        │
│                                     ▼                                          │
│                            ┌──────────────────┐                                │
│                     ┌──────│   VERIFYING      │──────┐                         │
│                     │      │                  │      │                         │
│                     │      │ Server checks    │      │                         │
│                     │      │ signature        │      │                         │
│                     │      └──────────────────┘      │                         │
│                     │                                │                         │
│            Valid signature                  Invalid signature                  │
│                     │                                │                         │
│                     ▼                                ▼                         │
│            ┌──────────────────┐            ┌──────────────────┐                │
│            │  AUTHENTICATED   │            │     FAILED       │                │
│            │                  │            │                  │                │
│            │ JWT issued       │            │ Error returned   │                │
│            │ Can place orders │            │ Retry from       │                │
│            │ Can view data    │            │ CONNECTED        │                │
│            └────────┬─────────┘            └──────────────────┘                │
│                     │                                                          │
│      ┌──────────────┼──────────────┐                                          │
│      │              │              │                                          │
│      │ JWT expires  │ POST /auth/  │ POST /auth/logout                        │
│      │              │ refresh      │ or disconnect wallet                     │
│      ▼              ▼              ▼                                          │
│ ┌──────────┐  ┌──────────┐  ┌──────────────┐                                  │
│ │ EXPIRED  │  │REFRESHED │  │ DISCONNECTED │                                  │
│ │          │  │          │  │              │                                  │
│ │ Need re- │  │ New JWT  │  │ Session      │                                  │
│ │ auth     │  │ issued   │  │ invalidated  │                                  │
│ └──────────┘  └──────────┘  └──────────────┘                                  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Session-Based Trading State Machine

For pro traders who want instant order execution without wallet popups.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        SESSION-BASED TRADING                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                            ┌──────────────────┐                                │
│                            │   NO SESSION     │                                │
│                            │                  │                                │
│                            │ User authenticated                                │
│                            │ but no trading   │                                │
│                            │ session active   │                                │
│                            └────────┬─────────┘                                │
│                                     │                                          │
│                                     │ POST /auth/session                       │
│                                     │ (wallet signs session authorization)     │
│                                     ▼                                          │
│                            ┌──────────────────┐                                │
│                            │  SESSION_SETUP   │                                │
│                            │                  │                                │
│                            │ • Generate       │                                │
│                            │   ephemeral key  │                                │
│                            │ • Wallet signs   │                                │
│                            │   authorization  │                                │
│                            │ • Server stores  │                                │
│                            │   mapping        │                                │
│                            └────────┬─────────┘                                │
│                                     │                                          │
│                                     │ Session validated                        │
│                                     ▼                                          │
│                            ┌──────────────────┐                                │
│                            │  SESSION_ACTIVE  │                                │
│                            │                  │                                │
│                            │ Orders signed    │                                │
│                            │ with session key │                                │
│                            │ (no popups!)     │                                │
│                            └────────┬─────────┘                                │
│                                     │                                          │
│      ┌──────────────────────────────┼──────────────────────────────┐           │
│      │                              │                              │           │
│      │ Session expires              │ User revokes                 │           │
│      │ (1h, 4h, or 24h)             │ DELETE /auth/session         │           │
│      ▼                              ▼                              │           │
│ ┌──────────┐                  ┌──────────┐                         │           │
│ │ EXPIRED  │                  │ REVOKED  │                         │           │
│ │          │                  │          │                         │           │
│ │ Need new │                  │ Session  │                         │           │
│ │ session  │                  │ invalid  │                         │           │
│ └──────────┘                  └──────────┘                         │           │
│      │                              │                              │           │
│      └──────────────────────────────┴──────────────────────────────┘           │
│                                     │                                          │
│                                     ▼                                          │
│                            ┌──────────────────┐                                │
│                            │   NO SESSION     │                                │
│                            └──────────────────┘                                │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

SESSION DURATIONS:
┌─────────────┬─────────────────────────────────────────────────────────────────┐
│ Duration    │ Use Case                                                        │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 1 hour      │ Quick trading session                                           │
│ 4 hours     │ Default - normal trading day                                    │
│ 24 hours    │ Extended session for active traders                             │
└─────────────┴─────────────────────────────────────────────────────────────────┘
```

---

## 9. Keeper Jobs Scheduling

Background jobs that drive state transitions.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           KEEPER JOB SCHEDULE                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  TIMELINE (per market lifecycle):                                               │
│                                                                                 │
│  T-5min          T-0s         T+0s         T+2s        T+~10s      T+~30s       │
│     │              │            │            │            │            │        │
│     ▼              ▼            ▼            ▼            ▼            ▼        │
│  ┌──────┐    ┌──────────┐  ┌────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │CREATE│───▶│ ACTIVATE │─▶│ CLOSE  │─▶│ RESOLVE │─▶│ SETTLE  │─▶│  CLOSE  │  │
│  │      │    │          │  │TRADING │  │         │  │         │  │ MARKET  │  │
│  │Market│    │Set strike│  │Window  │  │Set      │  │Pay      │  │Reclaim  │  │
│  │Creator    │from WS   │  │        │  │outcome  │  │winners  │  │rent     │  │
│  └──────┘    └──────────┘  └────────┘  └─────────┘  └─────────┘  └─────────┘  │
│                                                                                 │
│  JOB INTERVALS:                                                                 │
│  ┌────────────────────┬──────────┬────────────────────────────────────────┐    │
│  │ Job                │ Interval │ Purpose                                │    │
│  ├────────────────────┼──────────┼────────────────────────────────────────┤    │
│  │ Market Creator     │ 30s      │ Pre-create PENDING markets in DB       │    │
│  │ Market Activator   │ 5s       │ Set strike price, create on-chain      │    │
│  │ Market Resolver    │ 2s       │ Resolve expired markets                │    │
│  │ Position Settler   │ 5s       │ Batch settle winning positions         │    │
│  │ Order Expirer      │ 10s      │ Cancel GTT orders + market close       │    │
│  │ Market Closer      │ 20s      │ Close settled markets, reclaim rent    │    │
│  └────────────────────┴──────────┴────────────────────────────────────────┘    │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Summary: All Status Enums

```typescript
// Database Enums (apps/api/src/db/schema.ts)
type MarketStatus = 'OPEN' | 'CLOSED' | 'RESOLVED' | 'SETTLED';
type OrderSide = 'BID' | 'ASK';
type OrderOutcome = 'YES' | 'NO';
type OrderType = 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
type OrderStatus = 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED';
type TxStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';
type LedgerType = 'DEPOSIT' | 'WITHDRAW' | 'TRADE' | 'SETTLE' | 'FEE';

// On-Chain Enums (packages/contracts/programs/degen-terminal/src/state.rs)
enum MarketStatus { Pending, Open, Closed, Resolved, Settled }
enum MarketOutcome { Pending, Yes, No }
enum OrderStatus { Open, PartialFill, Filled, Cancelled, Expired }
enum Side { Bid, Ask }
enum Outcome { Yes, No }
enum OrderType { Limit, Market, IOC, FOK }
enum TradeType { Opening, Closing }
```

---

*Last updated: January 2026*

