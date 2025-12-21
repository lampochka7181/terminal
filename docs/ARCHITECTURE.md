# Degen Terminal - System Architecture

## 1. High-Level Overview
This platform is a Peer-to-Peer (CLOB) prediction market on Solana.
- **Model:** "Hybrid" (On-chain User Orders, Off-chain MM Orders, On-chain Settlement).
- **Network:** Solana (Low cost, high throughput).
- **Price Feeds:** Binance/Coinbase WebSocket (real-time prices for UI and settlement).

### Order Flow Model (Hybrid Architecture)
| Order Source | Storage | Signing | Cost | Trust Model |
|--------------|---------|---------|------|-------------|
| **User Limit** | On-chain PDA | Solana Transaction | ~0.002 SOL (recoverable) | Trustless |
| **User Market** | None (instant match) | Solana Transaction | Tx fee only | Trustless |
| **MM Bot** | Off-chain (Redis/DB) | Ed25519 Message | FREE | Trusted (platform bot) |
| **Settlement** | On-chain | Relayer signs | ~0.0001 SOL | Trustless |

**Why Hybrid?**
- Users get **full trustless security** (sign real transactions)
- MM bot avoids **$65K+/day** in tx fees for high-frequency quoting
- Settlement is **always on-chain** (atomic, verifiable)

## 1.1 System Architecture Diagrams

### Diagram 1: High-Level System Overview
*Shows all components and how they connect*

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DEGEN TERMINAL                                 │
└─────────────────────────────────────────────────────────────────────────────┘

     ┌──────────────┐                              ┌──────────────────┐
     │    TRADER    │                              │   MARKET MAKER   │
     │   (Browser)  │                              │      (Bot)       │
     └──────┬───────┘                              └────────┬─────────┘
            │                                               │
            │  HTTPS/WSS                          HTTPS API │
            ▼                                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (Next.js)                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │
│  │   Charts    │  │  Orderbook  │  │   Trading   │  │  Wallet Connect │   │
│  │ (TradingView)│  │    View    │  │    Form     │  │    (Phantom)    │   │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘   │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │
                    REST API + WebSocket
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                          BACKEND (Relayer)                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │
│  │ API Gateway │  │  Orderbook  │  │  Matching   │  │     Keeper      │   │
│  │   (REST)    │  │   (Redis)   │  │   Engine    │  │     (Cron)      │   │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘   │
│                                                                           │
│  ┌─────────────────────────────┐  ┌───────────────────────────────────┐   │
│  │     PostgreSQL (Orders,     │  │    Transaction Builder (Solana)   │   │
│  │     Markets, Positions)     │  │                                   │   │
│  └─────────────────────────────┘  └───────────────────────────────────┘   │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │
                         RPC (Solana TX)
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                         SOLANA BLOCKCHAIN                                 │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │                    DEGEN PROGRAM (Anchor)                         │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐    │   │
│  │  │   Markets   │  │  Positions  │  │      USDC Vault         │    │   │
│  │  │   (PDAs)    │  │   (PDAs)    │  │        (PDA)            │    │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────────────┘    │   │
│  └───────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Diagram 2: Frontend Architecture (GUI)
*What the user sees and how data flows in the UI*

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BROWSER (User's View)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  HEADER                                                              │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        ┌─────────────────┐  │   │
│  │  │   BTC    │ │   ETH    │ │   SOL    │        │ Connect Wallet  │  │   │
│  │  │ $95,432  │ │ $3,245   │ │  $142    │        │    [Phantom]    │  │   │
│  │  └──────────┘ └──────────┘ └──────────┘        └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌────────────────────────────────┐  ┌──────────────────────────────────┐  │
│  │  CHART (TradingView)           │  │  TRADING PANEL                   │  │
│  │                                │  │                                  │  │
│  │    Strike: $95,000             │  │  ┌────────────┐ ┌────────────┐   │  │
│  │    ══════════════════          │  │  │  BUY YES   │ │  BUY NO    │   │  │
│  │         ╱╲                     │  │  │  (Long)    │ │  (Short)   │   │  │
│  │        ╱  ╲    Current         │  │  └────────────┘ └────────────┘   │  │
│  │       ╱    ╲   $95,432         │  │                                  │  │
│  │      ╱      ╲                  │  │  Price:  [0.42] ────────○────    │  │
│  │     ╱        ╲                 │  │  Size:   [100 ] contracts       │  │
│  │                                │  │  Cost:   $42.00 USDC            │  │
│  │  12:00  12:01  12:02  12:03    │  │                                  │  │
│  │  [5m] [15m] [1h] [4h]          │  │  [      PLACE ORDER      ]       │  │
│  └────────────────────────────────┘  └──────────────────────────────────┘  │
│                                                                             │
│  ┌────────────────────────────────┐  ┌──────────────────────────────────┐  │
│  │  ORDERBOOK                     │  │  POSITIONS                       │  │
│  │                                │  │                                  │  │
│  │  ASKS (Sell YES)               │  │  BTC-5m-12:05                    │  │
│  │  ────────────────              │  │  100 YES @ $0.42  │ +$7.00 PnL   │  │
│  │  $0.45  │████████│  1,000      │  │                                  │  │
│  │  $0.44  │██████  │    800      │  │  ETH-1h-13:00                    │  │
│  │  $0.42  │████    │    500      │  │  50 NO @ $0.55   │ -$2.50 PnL   │  │
│  │  ────── SPREAD 0.02 ──────     │  │                                  │  │
│  │  $0.40  │█████   │    600      │  │  ─────────────────────────────   │  │
│  │  $0.39  │███████ │    900      │  │  Total PnL: +$4.50               │  │
│  │  $0.38  │████████│  1,200      │  │                                  │  │
│  │  BIDS (Buy YES)                │  │  Balance: $957.50 USDC           │  │
│  └────────────────────────────────┘  └──────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

                              DATA FLOWS
                              ──────────

┌──────────────┐     WebSocket (Real-time)      ┌──────────────────────┐
│   Frontend   │◄───────────────────────────────│   Backend Server     │
│   (Next.js)  │                                │                      │
│              │   • Orderbook deltas           │   • Price updates    │
│   Zustand    │   • Trade notifications        │   • Market events    │
│   (State)    │   • Position settlements       │   • Settlement alerts│
└──────────────┘                                └──────────────────────┘
       │
       │  User Action: "Buy 100 YES @ $0.42"
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  USER ORDER FLOW (On-Chain, Trustless):                             │
│  ──────────────────────────────────────                             │
│  1. Build Solana Transaction (place_order instruction)              │
│  2. Prompt Phantom to SIGN and SUBMIT transaction                   │
│  3. Transaction executes on-chain → Order PDA created               │
│  4. Backend listens for OrderPlaced event                           │
│  5. Backend adds order to matching engine                           │
│  6. On match → Backend submits execute_match TX                     │
│  7. WebSocket pushes update → UI refreshes                          │
│                                                                      │
│  Benefits:                                                           │
│  • User's order is cryptographically secured on-chain               │
│  • Cannot be censored or manipulated by relayer                     │
│  • Full audit trail on blockchain                                   │
│  • ~0.002 SOL rent (returned when order fills/cancels)              │
└──────────────────────────────────────────────────────────────────────┘
```

---

### Diagram 3: Backend Architecture (Relayer)
*Internal systems, databases, and blockchain interaction*

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BACKEND RELAYER SERVER                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  INBOUND                                                                    │
│  ════════                                                                   │
│                                                                             │
│  ┌─────────────────────┐    ┌─────────────────────┐                        │
│  │   REST API          │    │   WebSocket Server  │                        │
│  │   (Express/Fastify) │    │   (Socket.io)       │                        │
│  │                     │    │                     │                        │
│  │  POST /orders       │    │  Subscribe channels │                        │
│  │  GET  /markets      │    │  • orderbook:{mkt}  │                        │
│  │  GET  /user/*       │    │  • trades:{mkt}     │                        │
│  │  DELETE /orders/:id │    │  • prices           │                        │
│  └──────────┬──────────┘    │  • user:{wallet}    │                        │
│             │               └──────────┬──────────┘                        │
│             │                          │                                   │
│             ▼                          ▼                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      AUTH MIDDLEWARE (JWT + SIWS)                    │  │
│  │   • Verify JWT token for authenticated routes                        │  │
│  │   • Rate limiting (100/min public, 300/min auth)                     │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                      │                                     │
│                                      ▼                                     │
│  CORE SERVICES                                                             │
│  ═════════════                                                             │
│                                                                             │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐   │
│  │   ORDER SERVICE    │  │  MATCHING ENGINE   │  │  MARKET SERVICE    │   │
│  │                    │  │                    │  │                    │   │
│  │ • Validate order   │  │ • Price-Time FIFO  │  │ • List markets     │   │
│  │ • Verify signature │  │ • Match Bid/Ask    │  │ • Get orderbook    │   │
│  │ • Check balance    │──▶ • Partial fills    │  │ • Get trades       │   │
│  │ • Add to book      │  │ • Emit events      │  │ • Calc mid-price   │   │
│  └────────────────────┘  └─────────┬──────────┘  └────────────────────┘   │
│                                    │                                       │
│                                    │ On Match                              │
│                                    ▼                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                    TRANSACTION BUILDER                               │  │
│  │                                                                      │  │
│  │   SETTLEMENT TRANSACTION (execute_match):                            │  │
│  │   ┌─────────────────────────────────────────────────────────────┐    │  │
│  │   │  For User vs User match:                                    │    │  │
│  │   │    - References maker's on-chain Order PDA                  │    │  │
│  │   │    - References taker's on-chain Order PDA                  │    │  │
│  │   │    - Relayer signs execute_match (atomic settlement)        │    │  │
│  │   │                                                             │    │  │
│  │   │  For User vs MM match:                                      │    │  │
│  │   │    - References user's on-chain Order PDA                   │    │  │
│  │   │    - MM order verified off-chain (trusted bot)              │    │  │
│  │   │    - Relayer signs execute_match (atomic settlement)        │    │  │
│  │   │                                                             │    │  │
│  │   │  For MM vs MM match (rare):                                 │    │  │
│  │   │    - Both orders verified off-chain                         │    │  │
│  │   │    - Relayer signs execute_match (atomic settlement)        │    │  │
│  │   └─────────────────────────────────────────────────────────────┘    │  │
│  │                                                                      │  │
│  │   Output: Signed Transaction → Submit to Solana RPC                  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  DATA LAYER                                                                │
│  ══════════                                                                │
│                                                                             │
│  ┌────────────────────────────┐    ┌────────────────────────────────────┐  │
│  │   REDIS (Hot Data)         │    │   POSTGRESQL (Persistent)          │  │
│  │                            │    │                                    │  │
│  │   orderbook:{market}       │    │   markets     - Market metadata    │  │
│  │   ├── bids (sorted set)    │    │   orders      - Order history      │  │
│  │   └── asks (sorted set)    │    │   trades      - Trade records      │  │
│  │                            │    │   positions   - User positions     │  │
│  │   sequence:{market} = 1054 │    │   users       - Wallet + settings  │  │
│  │   prices:{asset} = 95432   │    │   settlements - Payout history     │  │
│  └────────────────────────────┘    └────────────────────────────────────┘  │
│                                                                             │
│  BACKGROUND JOBS (KEEPER)                                                  │
│  ════════════════════════                                                  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │   CRON SCHEDULER                                                     │  │
│  │                                                                      │  │
│  │   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │  │
│  │   │ Market Creator  │  │ Market Resolver │  │ Position Settler    │  │  │
│  │   │ Every 5m/15m/1h │  │ Every 10 sec    │  │ After resolution    │  │  │
│  │   │                 │  │                 │  │                     │  │  │
│  │   │ • Calc strike   │  │ • Check expiry  │  │ • Batch positions   │  │  │
│  │   │ • Create PDA    │  │ • Fetch price   │  │ • Transfer USDC     │  │  │
│  │   │ • Init market   │  │ • Set outcome   │  │ • Close accounts    │  │  │
│  │   └─────────────────┘  └─────────────────┘  └─────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ Solana RPC
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SOLANA BLOCKCHAIN                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                    DEGEN PROGRAM (Anchor)                          │    │
│  │                                                                    │    │
│  │   INSTRUCTIONS:                                                    │    │
│  │   ┌────────────────┐ ┌────────────────┐ ┌────────────────────────┐│    │
│  │   │ initialize_    │ │   place_order  │ │    execute_match       ││    │
│  │   │ market         │ │                │ │                        ││    │
│  │   │                │ │ • Validate sig │ │ • Atomic settlement    ││    │
│  │   │ • Create PDA   │ │ • Check params │ │ • Transfer USDC        ││    │
│  │   │ • Set strike   │ │ • Store intent │ │ • Update positions     ││    │
│  │   │ • Set expiry   │ │                │ │ • Collect fees         ││    │
│  │   └────────────────┘ └────────────────┘ └────────────────────────┘│    │
│  │   ┌────────────────┐ ┌─────────────────────────────────────────┐  │    │
│  │   │ resolve_market │ │           settle_positions              │  │    │
│  │   │                │ │                                         │  │    │
│  │   │ • Read price   │ │ • Batch process (max 20 per tx)         │  │    │
│  │   │ • Compare to   │ │ • Transfer winnings to user wallets     │  │    │
│  │   │   strike       │ │ • Mark positions settled                │  │    │
│  │   │ • Set outcome  │ │ • Reclaim rent from closed accounts     │  │    │
│  │   └────────────────┘ └─────────────────────────────────────────┘  │    │
│  │                                                                    │    │
│  │   ACCOUNTS (PDAs):                                                 │    │
│  │   ┌─────────────────────────────────────────────────────────────┐ │    │
│  │   │ GlobalState          │ Markets            │ UserPositions   │ │    │
│  │   │ ──────────────       │ ───────            │ ─────────────   │ │    │
│  │   │ • admin              │ • BTC-5m-12:00     │ • User A: BTC   │ │    │
│  │   │ • fee_recipient      │ • BTC-5m-12:05     │ • User A: ETH   │ │    │
│  │   │ • maker_fee_bps: 0   │ • ETH-1h-13:00     │ • User B: BTC   │ │    │
│  │   │ • taker_fee_bps: 10  │ • SOL-15m-12:15    │ • ...           │ │    │
│  │   └─────────────────────────────────────────────────────────────┘ │    │
│  │                                                                    │    │
│  │   ┌─────────────────────────────────────────────────────────────┐ │    │
│  │   │                    USDC VAULT (PDA)                         │ │    │
│  │   │   • Holds all collateral                                    │ │    │
│  │   │   • Only program can transfer out                           │ │    │
│  │   │   • Balance = Sum of all open positions                     │ │    │
│  │   └─────────────────────────────────────────────────────────────┘ │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 2. System Components

### A. Frontend (Client)
- **Tech:** Next.js, Tailwind, Zustand, Solana Wallet Adapter.
- **Role:** Displays order book, charts (TradingView), and handles "Partial Signing" of orders.

### B. Off-Chain Relayer (The "Backend")
- **Tech:** Node.js/Python (FastAPI) + Redis + PostgreSQL.
- **Role:**
  - Maintains the Order Book state (Redis).
  - Matches Maker/Taker orders.
  - Submits "Atomic Match" transactions to Solana.
  - Runs Cron jobs to Create/Resolve markets.

### C. Market Maker Bot (Liquidity Provider)
- **Tech:** TypeScript (runs as part of backend API).
- **Order Model:** **Off-chain** (signed messages, not on-chain transactions).
- **Role:**
  - **Fair Value Calculation:** Listens to Binance/Coinbase price feeds to calculate real-time win probabilities.
  - **Quoting:** Automatically places/cancels Limit Orders on both sides (Bid/Ask) to ensure users always have liquidity.
  - **Inventory Management:** Rebalances exposure to avoid holding too much risk.

**Why Off-Chain Orders for MM?**
| Aspect | On-Chain Orders | Off-Chain Orders |
|--------|-----------------|------------------|
| **Cost per order** | ~0.002 SOL | FREE |
| **Updates/second** | Limited by tx fees | Unlimited |
| **Daily cost (50 orders/sec)** | ~$65,000 | $0 |
| **Latency** | 400ms (block time) | <10ms |
| **Trust model** | Trustless | Trusted (it's our bot) |

**MM Bot Security:**
- MM bot wallet is controlled by the platform
- Orders are signed with Ed25519 (same as Solana signatures)
- Backend verifies MM signatures before adding to orderbook
- Settlement is always on-chain (trustless execution)
- Users' funds are NEVER at risk from MM bot

### D. On-Chain Program (The "Smart Contract")
- **Tech:** Rust (Anchor Framework).
- **Role:**
  - Holds User Funds (USDC Vault).
  - Tracks User Positions (Long/Short balances).
  - Settles positions based on relayer-reported final price.

## 3. Authentication & Security (Phantom + SIWS)

Since this is a centralized order book, we need to authenticate users to the API.

### The "Sign-In With Solana" Flow
1. **Connect:** User connects Phantom Wallet via `@solana/wallet-adapter`.
2. **Challenge:** Client requests a login message from API.
   - `GET /auth/nonce?address=Wait...`
   - API returns: `"Sign this message to login to DegenTerminal: <random_string>"`
3. **Sign:** User signs the message (ed25519 signature) in Phantom.
4. **Verify:** Client sends `{ address, signature, message }` to API.
5. **Session:** API verifies signature using `tweetnacl`.
   - If valid: Returns a **JWT (Bearer Token)**.
   - Client stores JWT in localStorage/cookies.

*Note: Placing an order is different. It requires signing a specific **Transaction Instruction**, not just a login message.*

## 4. Data Flow: The Trading Lifecycle

### Order Flow Overview (Hybrid Model)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HYBRID ORDER FLOW                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        USER ORDERS (Trustless)                        │  │
│  │                                                                       │  │
│  │  [User] → Sign TX → Submit to Solana → Order stored on-chain (PDA)   │  │
│  │                            │                                          │  │
│  │                            ▼                                          │  │
│  │                   Backend listens for OrderPlaced events              │  │
│  │                            │                                          │  │
│  │                            ▼                                          │  │
│  │              Adds to matching engine (Redis orderbook)                │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      MM BOT ORDERS (Trusted)                          │  │
│  │                                                                       │  │
│  │  [MM Bot] → Sign Message (Ed25519) → Send to Backend API              │  │
│  │                            │                                          │  │
│  │                            ▼                                          │  │
│  │              Stored off-chain (Redis + PostgreSQL)                    │  │
│  │              No on-chain cost for placing/canceling                   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      MATCHING (Off-Chain)                             │  │
│  │                                                                       │  │
│  │  [Matching Engine] → Finds crossing orders → Creates Fill             │  │
│  │                            │                                          │  │
│  │                            ▼                                          │  │
│  │              Triggers on-chain settlement                             │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                    SETTLEMENT (On-Chain, Trustless)                   │  │
│  │                                                                       │  │
│  │  [Relayer] → Build execute_match TX → Submit to Solana                │  │
│  │                            │                                          │  │
│  │                            ▼                                          │  │
│  │              Atomic: USDC transfer + Position updates                 │  │
│  │              Both parties' funds settled in single TX                 │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 1A: User Order Placement (On-Chain)
```
[User] -> Selects "Buy YES @ $0.40"
   |
   v
[Frontend] -> Builds place_order instruction
   |
   v
[Wallet] -> Signs FULL TRANSACTION (Phantom approves)
   |
   v
[Frontend] -> Submits transaction to Solana RPC
   |
   v
[Solana] -> Executes place_order -> Creates Order PDA
   |
   v
[Backend] -> Listens for OrderPlaced event -> Adds to Redis Orderbook
```

### Phase 1B: MM Bot Order Placement (Off-Chain)
```
[MM Bot] -> Calculates fair value, generates quotes
   |
   v
[MM Bot] -> Signs order message with Ed25519 (NOT a transaction)
   |
   v
[API] -> Receives signed message -> Validates signature -> Adds to Redis
   |
   (No on-chain transaction - MM orders are trusted/internal)
```

### Phase 2: Matching & Execution (Hybrid)
```
[Matching Engine] -> Finds Match (Buyer Bid >= Seller Ask)
   |
   v
[Relayer] -> Builds execute_match instruction
   |          - References maker's on-chain order OR validates MM signature
   |          - References taker's on-chain order OR validates MM signature
   |
   v
[Solana Blockchain] -> Executes Atomic Transaction
   |-> Transfers USDC from Buyer/Seller to Vault
   |-> Updates User Position Accounts (+Long / +Short)
   |-> Closes/updates Order PDAs
```

### Phase 3: Settlement (On-Chain)
```
[Keeper] -> Market expires -> Fetches final price from exchange feed
   |
   v
[Keeper] -> Calls resolve_market instruction
   |
   v
[Keeper] -> Calls settle_positions (batch)
   |
   v
[Solana] -> Winners receive USDC directly to wallet
```

## 5. Pricing Mechanism (Order Book vs AMM)

**IMPORTANT:** This platform uses a **Central Limit Order Book (CLOB)**, NOT an AMM (LSMR).

- **Price Discovery:** Determined purely by user Limit Orders.
  - If Alice wants to buy YES at $0.60 and Bob sells YES at $0.60, the price is $0.60.
- **No Bonding Curve:** The system does not algorithmically set prices.
- **Market Making:** To ensure liquidity, a "Market Maker Bot" is recommended to quote 2-sided markets (Bid/Ask) based on external volatility models.

## 6. Database Schema (PostgreSQL)

### Entity Relationship Diagram
```
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│   users     │       │   markets   │       │   orders    │
├─────────────┤       ├─────────────┤       ├─────────────┤
│ id (PK)     │       │ id (PK)     │       │ id (PK)     │
│ wallet_addr │◄──────│             │◄──────│ market_id   │
│ ...         │       │ ...         │       │ user_id     │──┐
└─────────────┘       └──────┬──────┘       │ ...         │  │
      │                      │              └─────────────┘  │
      │                      │                    │          │
      │                      ▼                    │          │
      │               ┌─────────────┐             │          │
      │               │   trades    │◄────────────┘          │
      │               ├─────────────┤ (maker/taker order)    │
      │               │ id (PK)     │                        │
      │               │ market_id   │                        │
      │               │ maker_order │                        │
      │               │ taker_order │                        │
      │               │ ...         │                        │
      │               └─────────────┘                        │
      │                      │                               │
      │                      ▼                               │
      │               ┌─────────────┐       ┌─────────────┐  │
      │               │  positions  │       │ settlements │  │
      │               ├─────────────┤       ├─────────────┤  │
      └──────────────►│ user_id     │◄──────│ position_id │  │
                      │ market_id   │       │ user_id     │◄─┘
                      │ ...         │       │ ...         │
                      └─────────────┘       └─────────────┘
```

---

### `users`
Tracks authenticated users and their settings.

| Column | Type | Constraints | Notes |
| :--- | :--- | :--- | :--- |
| `id` | UUID | PK, DEFAULT uuid_generate_v4() | Internal ID |
| `wallet_address` | VARCHAR(44) | UNIQUE, NOT NULL | Solana pubkey (base58) |
| `nonce` | VARCHAR(64) | | Current auth challenge |
| `nonce_expires_at` | TIMESTAMP | | Nonce expiration |
| `created_at` | TIMESTAMP | DEFAULT NOW() | First connection |
| `last_login_at` | TIMESTAMP | | Last successful auth |
| `total_volume` | DECIMAL(20,6) | DEFAULT 0 | Lifetime trading volume |
| `total_trades` | INTEGER | DEFAULT 0 | Lifetime trade count |
| `fee_tier` | SMALLINT | DEFAULT 0 | Volume-based fee tier |
| `is_banned` | BOOLEAN | DEFAULT FALSE | Account suspension |
| `metadata` | JSONB | | Preferences, settings |

**Indexes:**
- `idx_users_wallet` ON `wallet_address`

---

### `markets`
Defines each binary outcome market.

| Column | Type | Constraints | Notes |
| :--- | :--- | :--- | :--- |
| `id` | UUID | PK | Internal ID |
| `pubkey` | VARCHAR(44) | UNIQUE, NOT NULL | On-chain PDA address |
| `asset` | VARCHAR(10) | NOT NULL | "BTC", "ETH", "SOL" |
| `timeframe` | VARCHAR(10) | NOT NULL | "5m", "15m", "1h", "4h" |
| `strike_price` | DECIMAL(20,8) | NOT NULL | Price at market creation |
| `final_price` | DECIMAL(20,8) | | Price at resolution |
| `created_at` | TIMESTAMP | DEFAULT NOW() | Market creation time |
| `expiry_at` | TIMESTAMP | NOT NULL | When trading stops |
| `resolved_at` | TIMESTAMP | | When outcome was set |
| `settled_at` | TIMESTAMP | | When all payouts complete |
| `status` | VARCHAR(20) | DEFAULT 'OPEN' | OPEN, CLOSED, RESOLVED, SETTLED |
| `outcome` | VARCHAR(10) | | NULL, 'YES', 'NO' |
| `total_volume` | DECIMAL(20,6) | DEFAULT 0 | Total USDC traded |
| `total_trades` | INTEGER | DEFAULT 0 | Number of executions |
| `open_interest` | DECIMAL(20,6) | DEFAULT 0 | Outstanding contracts |
| `yes_price` | DECIMAL(10,6) | | Last YES trade price |
| `no_price` | DECIMAL(10,6) | | Last NO trade price |

**Indexes:**
- `idx_markets_status` ON `status`
- `idx_markets_asset_expiry` ON `(asset, expiry_at)`
- `idx_markets_expiry` ON `expiry_at` WHERE `status = 'OPEN'`

---

### `orders`
Order book entries (both active and historical).

| Column | Type | Constraints | Notes |
| :--- | :--- | :--- | :--- |
| `id` | UUID | PK | Internal ID |
| `client_order_id` | BIGINT | NOT NULL | User-provided (replay protection) |
| `market_id` | UUID | FK → markets.id | Which market |
| `user_id` | UUID | FK → users.id | Order owner |
| `side` | VARCHAR(10) | NOT NULL | 'BID' or 'ASK' |
| `outcome` | VARCHAR(10) | NOT NULL | 'YES' or 'NO' |
| `order_type` | VARCHAR(10) | DEFAULT 'LIMIT' | LIMIT, MARKET, IOC, FOK |
| `price` | DECIMAL(10,6) | NOT NULL | Limit price (0.01-0.99) |
| `size` | DECIMAL(20,6) | NOT NULL | Original order size |
| `filled_size` | DECIMAL(20,6) | DEFAULT 0 | Amount executed |
| `remaining_size` | DECIMAL(20,6) | | Computed: size - filled |
| `status` | VARCHAR(20) | DEFAULT 'OPEN' | OPEN, PARTIAL, FILLED, CANCELLED |
| `signature` | TEXT | NOT NULL | Ed25519 signed instruction |
| `encoded_instruction` | TEXT | NOT NULL | Base64 Solana instruction |
| `expires_at` | TIMESTAMP | | Order expiration (GTT) |
| `created_at` | TIMESTAMP | DEFAULT NOW() | Order submission time |
| `updated_at` | TIMESTAMP | DEFAULT NOW() | Last fill/cancel time |
| `cancelled_at` | TIMESTAMP | | When cancelled |
| `cancel_reason` | VARCHAR(50) | | USER, EXPIRED, MARKET_CLOSED |

**Indexes:**
- `idx_orders_market_status` ON `(market_id, status)`
- `idx_orders_user_status` ON `(user_id, status)`
- `idx_orders_book` ON `(market_id, outcome, side, price, created_at)` WHERE `status IN ('OPEN', 'PARTIAL')`

**Unique Constraint:**
- `uq_orders_client_id` ON `(user_id, client_order_id)` — Prevents replay

---

### `trades`
Executed matches between maker and taker orders.

| Column | Type | Constraints | Notes |
| :--- | :--- | :--- | :--- |
| `id` | UUID | PK | Internal ID |
| `market_id` | UUID | FK → markets.id | Which market |
| `maker_order_id` | UUID | FK → orders.id | Resting order |
| `taker_order_id` | UUID | FK → orders.id | Aggressor order |
| `maker_user_id` | UUID | FK → users.id | Maker's user |
| `taker_user_id` | UUID | FK → users.id | Taker's user |
| `outcome` | VARCHAR(10) | NOT NULL | 'YES' or 'NO' |
| `price` | DECIMAL(10,6) | NOT NULL | Execution price |
| `size` | DECIMAL(20,6) | NOT NULL | Contracts traded |
| `notional` | DECIMAL(20,6) | NOT NULL | price × size (USDC) |
| `maker_fee` | DECIMAL(20,6) | DEFAULT 0 | Fee charged to maker |
| `taker_fee` | DECIMAL(20,6) | NOT NULL | Fee charged to taker |
| `tx_signature` | VARCHAR(88) | | Solana transaction sig |
| `tx_status` | VARCHAR(20) | DEFAULT 'PENDING' | PENDING, CONFIRMED, FAILED |
| `executed_at` | TIMESTAMP | DEFAULT NOW() | Match timestamp |
| `confirmed_at` | TIMESTAMP | | On-chain confirmation |

**Indexes:**
- `idx_trades_market` ON `(market_id, executed_at DESC)`
- `idx_trades_maker` ON `(maker_user_id, executed_at DESC)`
- `idx_trades_taker` ON `(taker_user_id, executed_at DESC)`
- `idx_trades_pending` ON `tx_status` WHERE `tx_status = 'PENDING'`

---

### `positions`
Aggregated user holdings per market (derived from trades).

| Column | Type | Constraints | Notes |
| :--- | :--- | :--- | :--- |
| `id` | UUID | PK | Internal ID |
| `user_id` | UUID | FK → users.id | Position owner |
| `market_id` | UUID | FK → markets.id | Which market |
| `pubkey` | VARCHAR(44) | UNIQUE | On-chain position PDA |
| `yes_shares` | DECIMAL(20,6) | DEFAULT 0 | YES token balance |
| `no_shares` | DECIMAL(20,6) | DEFAULT 0 | NO token balance |
| `avg_entry_yes` | DECIMAL(10,6) | | Avg price paid for YES |
| `avg_entry_no` | DECIMAL(10,6) | | Avg price paid for NO |
| `total_cost` | DECIMAL(20,6) | DEFAULT 0 | USDC spent on position |
| `realized_pnl` | DECIMAL(20,6) | DEFAULT 0 | P&L from sells |
| `status` | VARCHAR(20) | DEFAULT 'OPEN' | OPEN, SETTLED |
| `payout` | DECIMAL(20,6) | | Amount received at settle |
| `created_at` | TIMESTAMP | DEFAULT NOW() | First trade in market |
| `updated_at` | TIMESTAMP | DEFAULT NOW() | Last trade/settle |
| `settled_at` | TIMESTAMP | | When payout sent |

**Indexes:**
- `idx_positions_user` ON `(user_id, status)`
- `idx_positions_market` ON `(market_id, status)`
- `idx_positions_unsettled` ON `market_id` WHERE `status = 'OPEN'`

**Unique Constraint:**
- `uq_positions_user_market` ON `(user_id, market_id)`

---

### `settlements`
Record of automatic payouts after market resolution.

| Column | Type | Constraints | Notes |
| :--- | :--- | :--- | :--- |
| `id` | UUID | PK | Internal ID |
| `position_id` | UUID | FK → positions.id | Which position |
| `user_id` | UUID | FK → users.id | Recipient |
| `market_id` | UUID | FK → markets.id | Which market |
| `outcome` | VARCHAR(10) | NOT NULL | Market outcome (YES/NO) |
| `winning_shares` | DECIMAL(20,6) | NOT NULL | Shares that won |
| `payout_amount` | DECIMAL(20,6) | NOT NULL | USDC transferred |
| `profit` | DECIMAL(20,6) | NOT NULL | payout - cost basis |
| `tx_signature` | VARCHAR(88) | | Solana transaction sig |
| `tx_status` | VARCHAR(20) | DEFAULT 'PENDING' | PENDING, CONFIRMED, FAILED |
| `batch_id` | UUID | | Group settlements in same tx |
| `created_at` | TIMESTAMP | DEFAULT NOW() | When queued |
| `confirmed_at` | TIMESTAMP | | On-chain confirmation |

**Indexes:**
- `idx_settlements_user` ON `(user_id, created_at DESC)`
- `idx_settlements_market` ON `market_id`
- `idx_settlements_pending` ON `tx_status` WHERE `tx_status = 'PENDING'`

---

### `balance_ledger`
Tracks all balance changes (deposits, withdrawals, trades, settlements).

| Column | Type | Constraints | Notes |
| :--- | :--- | :--- | :--- |
| `id` | UUID | PK | Internal ID |
| `user_id` | UUID | FK → users.id | Account owner |
| `type` | VARCHAR(20) | NOT NULL | DEPOSIT, WITHDRAW, TRADE, SETTLE, FEE |
| `amount` | DECIMAL(20,6) | NOT NULL | Positive = credit, Negative = debit |
| `balance_before` | DECIMAL(20,6) | NOT NULL | Balance before change |
| `balance_after` | DECIMAL(20,6) | NOT NULL | Balance after change |
| `reference_type` | VARCHAR(20) | | 'trade', 'settlement', etc. |
| `reference_id` | UUID | | FK to related record |
| `tx_signature` | VARCHAR(88) | | On-chain tx (if applicable) |
| `description` | TEXT | | Human-readable note |
| `created_at` | TIMESTAMP | DEFAULT NOW() | Transaction time |

**Indexes:**
- `idx_ledger_user` ON `(user_id, created_at DESC)`
- `idx_ledger_type` ON `(user_id, type)`

---

### `market_snapshots`
OHLCV data for charts (aggregated from trades).

| Column | Type | Constraints | Notes |
| :--- | :--- | :--- | :--- |
| `id` | UUID | PK | Internal ID |
| `market_id` | UUID | FK → markets.id | Which market |
| `outcome` | VARCHAR(10) | NOT NULL | 'YES' or 'NO' |
| `interval` | VARCHAR(10) | NOT NULL | '1m', '5m', '1h' |
| `timestamp` | TIMESTAMP | NOT NULL | Candle start time |
| `open` | DECIMAL(10,6) | | First price in interval |
| `high` | DECIMAL(10,6) | | Highest price |
| `low` | DECIMAL(10,6) | | Lowest price |
| `close` | DECIMAL(10,6) | | Last price |
| `volume` | DECIMAL(20,6) | DEFAULT 0 | Total contracts |
| `trades` | INTEGER | DEFAULT 0 | Number of trades |

**Indexes:**
- `idx_snapshots_market` ON `(market_id, outcome, interval, timestamp DESC)`

**Unique Constraint:**
- `uq_snapshots` ON `(market_id, outcome, interval, timestamp)`

---

### Database Views

#### `v_orderbook`
Real-time orderbook aggregation (though Redis is primary source).
```sql
CREATE VIEW v_orderbook AS
SELECT 
  market_id,
  outcome,
  side,
  price,
  SUM(remaining_size) as total_size,
  COUNT(*) as order_count
FROM orders
WHERE status IN ('OPEN', 'PARTIAL')
GROUP BY market_id, outcome, side, price
ORDER BY 
  CASE WHEN side = 'BID' THEN price END DESC,
  CASE WHEN side = 'ASK' THEN price END ASC;
```

#### `v_user_portfolio`
User's current portfolio summary.
```sql
CREATE VIEW v_user_portfolio AS
SELECT 
  u.id as user_id,
  u.wallet_address,
  COALESCE(SUM(CASE WHEN p.status = 'OPEN' THEN p.total_cost END), 0) as locked_value,
  COALESCE(SUM(p.realized_pnl), 0) as realized_pnl,
  COUNT(DISTINCT CASE WHEN p.status = 'OPEN' THEN p.market_id END) as open_positions
FROM users u
LEFT JOIN positions p ON u.id = p.user_id
GROUP BY u.id, u.wallet_address;
```

---

### Enums
```sql
CREATE TYPE order_side AS ENUM ('BID', 'ASK');
CREATE TYPE order_outcome AS ENUM ('YES', 'NO');
CREATE TYPE order_type AS ENUM ('LIMIT', 'MARKET', 'IOC', 'FOK');
CREATE TYPE order_status AS ENUM ('OPEN', 'PARTIAL', 'FILLED', 'CANCELLED');
CREATE TYPE market_status AS ENUM ('OPEN', 'CLOSED', 'RESOLVED', 'SETTLED');
CREATE TYPE tx_status AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');
CREATE TYPE ledger_type AS ENUM ('DEPOSIT', 'WITHDRAW', 'TRADE', 'SETTLE', 'FEE');
```

## 7. On-Chain Program Architecture (Anchor)

We use a **Single Program (Factory Pattern)**. We do NOT deploy new contracts for new markets.

### 7.1 Account Hierarchy
One Program (`DegenProgram`) manages thousands of Market Accounts (PDAs).

```
[ DegenProgram (Executable Code) ]
       |
       +---> [ GlobalState Account ] (Admin settings, Fee recipient)
       |
       +---> [ Market Account (PDA) ] "BTC-5m-12:00"
       |       - Strike: $98,500
       |       - Expiry: 12:05
       |       - Status: OPEN
       |
       +---> [ Market Account (PDA) ] "BTC-1h-12:00"
       |       - Strike: $98,500
       |       - Expiry: 13:00
       |
       +---> [ UserPosition Account (PDA) ]
               - Owner: User123
               - Market: "BTC-5m-12:00"
               - Balance: 10 YES
```

### 7.2 Market Creation Strategy (PDAs)
We use **Program Derived Addresses (PDAs)** to deterministically generate market addresses.

- **Seeds:** `[b"market", asset_symbol, timeframe, timestamp_start]`
- **Example:** `pubkey = find_program_address(["market", "BTC", "5m", "1709990000"])`

This allows the Frontend to find the exact market address without needing an indexer.

### 7.3 Settlement Mechanism (Auto-Payout)
The Solana program cannot "wake up" itself. An external agent must trigger settlement.
**Key Design:** Settlement is **automatic** - winners receive USDC instantly, no manual claim required.

**Settlement Flow:**
```
1. Market Expires (e.g., BTC-5m at 12:05)
           |
           v
2. Keeper checks: "Any markets past expiry?"
           |
           v
3. Keeper calls: resolve_market(market_pda, final_price)
           |
           v
4. On-Chain Program:
   ├── Receives final price from relayer
   ├── Compares to strike price
   ├── Sets outcome (YES or NO)
           |
           v
5. Keeper calls: settle_positions(market_pda, [user_positions...])
           |
           v
6. On-Chain Program (for each position):
   ├── If user holds winning shares → Transfer USDC to user wallet
   ├── Mark position as settled
   └── Close position account (reclaim rent)
           |
           v
7. Frontend receives WebSocket event → Updates UI instantly
```

**Keeper Responsibilities:**
| Task | Frequency | Description |
|------|-----------|-------------|
| `resolve_market` | Every 10s | Check for expired markets, set outcome |
| `settle_positions` | After resolve | Batch settle all positions (max ~20 per tx) |
| `create_market` | Per timeframe | Create upcoming markets |

**Batched Settlement:**
- Solana tx size limits ~20-30 position accounts per instruction
- Keeper iterates through all positions in batches
- Protocol pays tx fees (funded from fee revenue)

**Why No Manual Claims?**
| Manual Claim | Auto-Settlement |
|--------------|-----------------|
| User pays gas | Protocol pays gas |
| User must remember | Seamless UX |
| Funds stuck until claimed | Instant liquidity |
| Extra frontend complexity | Just show balance |

### 7.4 Anchor Data Structures

```rust
#[account]
pub struct Market {
    pub id: u64,
    pub authority: Pubkey,
    pub asset_symbol: String,
    pub strike_price: u64,
    pub expiry_ts: i64,
    pub resolution_ts: i64,    // When outcome was set
    pub outcome: u8,           // 0=Pending, 1=Yes, 2=No
    pub settlement_complete: bool, // All positions paid out?
    pub total_volume: u64,
    pub total_positions: u32,  // For settlement progress tracking
    pub settled_positions: u32,
    pub bump: u8,
}

#[account]
pub struct UserPosition {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub yes_shares: u64,
    pub no_shares: u64,
    pub entry_value: u64,      // Total USDC paid for position
    pub settled: bool,         // Has payout been sent?
    pub payout: u64,           // Amount received (0 if lost)
    pub bump: u8,
}

## 8. The Order Protocol (Hybrid Model)

The platform uses a **Hybrid Order Model** where user orders are on-chain (trustless) and MM orders are off-chain (cost-efficient).

### 8.0 Order Types by Source

| Source | Storage | Signing | Execution |
|--------|---------|---------|-----------|
| **User** | On-chain Order PDA | Solana Transaction | Reference PDA in execute_match |
| **MM Bot** | Off-chain (Redis/DB) | Ed25519 Message | Relayer validates signature |

### 8.1 On-Chain Order Account (User Orders)

When a user places an order, it creates an **Order PDA** on-chain:

```rust
#[account]
pub struct Order {
    pub owner: Pubkey,           // User's wallet
    pub market: Pubkey,          // Market PDA this order is for
    pub side: Side,              // Bid or Ask
    pub outcome: Outcome,        // Yes or No
    pub order_type: OrderType,   // Limit, Market, IOC, FOK
    pub price: u64,              // Price in basis points (4000 = $0.40)
    pub size: u64,               // Original order size
    pub filled_size: u64,        // Amount already filled
    pub status: OrderStatus,     // Open, PartialFill, Filled, Cancelled
    pub client_order_id: u64,    // User-provided ID for tracking
    pub expiry_ts: i64,          // When order expires
    pub created_at: i64,         // Timestamp of creation
    pub bump: u8,                // PDA bump seed
}

// PDA Seeds: ["order", market.key(), owner.key(), client_order_id]
```

**Storage Cost:** ~0.002 SOL (rent-exempt, returned on close)

### 8.2 The `PlaceOrder` Instruction (User Flow)
Users sign and submit this as a **real Solana transaction**.

**Context Accounts:**
- `market`: The specific Market PDA (e.g., "BTC-5m-12:00")
- `user`: The trader's wallet (**SIGNER**)
- `order`: The Order PDA to be created (**init**)
- `user_usdc_ata`: User's USDC token account (for balance check)
- `system_program`: For account creation

**Instruction Arguments:**
```rust
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct PlaceOrderArgs {
    pub side: Side,          // Bid (Buy) or Ask (Sell)
    pub outcome: Outcome,    // Yes or No
    pub order_type: OrderType, // Limit or Market
    pub price: u64,          // Limit Price (e.g., 400000 for $0.40)
    pub size: u64,           // Number of contracts
    pub expiry_ts: i64,      // Order expiration (for the Book, not Market)
    pub client_order_id: u64 // Random ID to prevent replay attacks
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub enum OrderType {
    Limit,      // Standard Limit Order
    Market,     // Execute immediately at best price (with slippage protection)
    IOC,        // Immediate-Or-Cancel
    FOK,        // Fill-Or-Kill
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub enum Side {
    Bid,
    Ask,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub enum Outcome {
    Yes,
    No,
}
```

### 8.3 The Execute Match Transaction
The Relayer constructs a single transaction for settlement:

**For User vs User Match:**
```
Transaction:
├── IX 1: execute_match
│   ├── maker_order: PDA (on-chain order account)
│   ├── taker_order: PDA (on-chain order account)
│   ├── relayer: SIGNER (authorized relayer)
│   ├── maker_position: PDA
│   ├── taker_position: PDA
│   └── ... (vault, token accounts, etc.)
```

**For User vs MM Match:**
```
Transaction:
├── IX 1: execute_match
│   ├── user_order: PDA (on-chain order account)
│   ├── mm_order: NULL (MM order is off-chain)
│   ├── mm_order_args: Inline args (side, price, size, etc.)
│   ├── relayer: SIGNER (validates MM signature off-chain)
│   ├── user_position: PDA
│   ├── mm_position: PDA
│   └── ... (vault, token accounts, etc.)
```

**Security Model:**
- User orders are verified by their on-chain Order PDA existence
- MM orders are verified by relayer (off-chain signature check)
- Relayer cannot create fake user orders (PDA must exist)
- Relayer is trusted for MM orders (it's the platform's own bot)

### 8.4 MM Bot Order Signing (Off-Chain)

MM bot orders use Ed25519 message signing (same algorithm as Solana):

```typescript
// MM Bot signs this message
const orderMessage = {
  market: "BTC-5m-12:00",
  side: "bid",
  outcome: "yes",
  price: 400000,       // $0.40
  size: 100,
  expiry_ts: 1709999999,
  client_order_id: 12345,
  nonce: Date.now()    // Replay protection
};

// Create deterministic message bytes
const messageBytes = Buffer.from(JSON.stringify(orderMessage));

// Sign with MM bot's Ed25519 private key
const signature = nacl.sign.detached(messageBytes, mmKeypair.secretKey);

// Send to backend API
POST /orders {
  order: orderMessage,
  signature: base64(signature),
  signerPubkey: mmKeypair.publicKey
}
```

**Backend Validation:**
```typescript
// Verify MM signature before adding to orderbook
const isValid = nacl.sign.detached.verify(
  messageBytes,
  signature,
  mmPubkey
);

if (isValid && signerPubkey === AUTHORIZED_MM_PUBKEY) {
  // Add to Redis orderbook
  orderbook.add(orderMessage);
}
```

### 8.5 Asset Flow (Long vs Short)
To simplify the UX, we map "Trading" terms to "Prediction" terms:

- **"Long" (Bullish)** = Buying `YES` Outcome.
- **"Short" (Bearish)** = Buying `NO` Outcome.

**Flow A: Opening a Long**
1. User pays **$0.40 USDC**.
2. Contract mints **1.0 YES** (User) and **1.0 NO** (held by Counterparty).
3. Contract holds **$1.00 USDC** total ($0.40 from User + $0.60 from Counterparty).

**Flow B: Selling to Close (Profit Taking)**
1. User holds **1.0 YES**. Current Market Price is **$0.70**.
2. User sells to new Buyer.
3. User receives **$0.70 USDC**.
4. New Buyer receives **1.0 YES**.
5. Vault balance is unchanged (still holds the $1.00 backing the pair).

**Flow C: Settlement (Expiry)**
1. Market resolves **YES** (price > strike).
2. `YES` holders claim **$1.00 USDC** per share.
3. `NO` holders get **$0.00**.

## 9. Deposit & Withdrawal Flow

### 9.1 How USDC Enters the System
Users don't deposit into a platform wallet. Instead, trades are settled directly from their **wallet's USDC Associated Token Account (ATA)**.

**On First Trade:**
```
1. User connects wallet (has USDC in their ATA)
2. User places order → Signs Solana instruction
3. On match → execute_match instruction:
   ├── Transfers USDC from User's ATA → Program Vault
   ├── Creates UserPosition PDA (if first trade in market)
   └── User now holds YES/NO shares
```

**No Separate Deposit Step:**
- Unlike CEXs, there's no "deposit" action
- USDC stays in user's wallet until a trade executes
- Better UX: Users see their full balance, not "platform balance"

### 9.2 Withdrawal (Closing Positions)
Users can exit positions two ways:

**Option A: Sell Before Expiry**
```
User holds 100 YES @ avg $0.40
├── Places ASK order: Sell 100 YES @ $0.55
├── Another user buys (matches)
├── User receives $55 USDC directly to their wallet ATA
└── Position closed (or reduced)
```

**Option B: Wait for Settlement**
```
Market expires → Keeper resolves → Keeper settles
├── If user won: $1.00/share transferred to wallet ATA
└── If user lost: $0.00 (counterparty gets the collateral)
```

### 9.3 ATA Requirements
Users must have a USDC Associated Token Account. If they don't:
- Frontend checks and prompts to create ATA (~0.002 SOL rent)
- Or program can create ATA during first trade (user pays rent)

---

## 10. Order Constraints & Limits

### 10.0 On-Chain Storage Costs (User Orders)

| Item | Cost | Notes |
|------|------|-------|
| **Order PDA rent** | ~0.002 SOL | Rent-exempt minimum |
| **At $150/SOL** | ~$0.30 | Per active order |
| **Rent recovery** | 100% returned | When order fills/cancels |

**User Cost Breakdown:**
```
Place Limit Order:
├── Transaction fee: ~0.000005 SOL ($0.00075)
├── Priority fee: ~0.0001 SOL ($0.015)
├── Rent deposit: ~0.002 SOL ($0.30) ← RETURNED on fill/cancel
└── Net cost: ~$0.02 (if order fills)

Cancel Order:
├── Transaction fee: ~0.000005 SOL
├── Rent returned: +0.002 SOL
└── Net: User gets rent back
```

**Why This Is Acceptable:**
- Users typically place 5-20 orders at a time
- Rent is RETURNED when orders complete
- Much cheaper than gas on Ethereum L1
- Provides real security guarantees

### 10.1 Order Size Limits
| Constraint | Value | Rationale |
|------------|-------|-----------|
| Min Order Size | 1 contract | Prevent dust |
| Max Order Size | 100,000 contracts | Risk management |
| Max Open Orders | 100 per user per market | Prevent spam |
| Max Position Size | 500,000 contracts | Concentration limit |

### 10.2 Price Constraints
| Constraint | Value | Notes |
|------------|-------|-------|
| Min Price | $0.01 | 1% implied probability |
| Max Price | $0.99 | 99% implied probability |
| Tick Size | $0.01 | Minimum price increment |

### 10.3 Self-Trade Prevention (STP)
Users cannot match against their own orders.

**Behavior:**
```
User has resting BID @ $0.50
User places crossing ASK @ $0.50
├── System detects same wallet
├── Newer order is REJECTED
└── Error: SELF_TRADE_PREVENTED
```

**Why?** Prevents wash trading and accidental self-matching.

### 10.4 Market Trading Window
| Event | Time Before Expiry | Action |
|-------|-------------------|--------|
| Trading Open | Market creation | Orders accepted |
| Last Trade | 30 seconds | New orders rejected |
| Market Close | 0 seconds | All open orders cancelled |
| Resolution | +10 seconds | Final price fetched, outcome set |
| Settlement | +60 seconds | All positions paid out |

**Example Timeline (BTC-5m-12:00):**
```
11:55:00 - Market created (strike = current BTC price)
11:59:30 - Trading closes (no new orders)
12:00:00 - Market expires (open orders auto-cancelled)
12:00:10 - Keeper resolves (fetches final price from exchange)
12:00:30 - Keeper settles (payouts sent)
```

### 10.5 What Happens to Open Orders at Close?
```
Market approaches expiry (T-30s):
├── New orders: REJECTED (MARKET_CLOSING)
├── Existing orders: Can be cancelled
└── Matches: Still processed if both sides valid

At expiry (T=0):
├── All open orders: AUTO-CANCELLED
├── Cancel reason: MARKET_CLOSED
└── No partial fills possible after close
```

---

## 11. Risk Management & Circuit Breakers

### 11.1 Emergency Pause
The protocol can be paused by admin in case of:
- Price feed manipulation detected
- Smart contract vulnerability discovered
- Unusual market activity

```rust
#[account]
pub struct GlobalState {
    pub admin: Pubkey,
    pub protocol_paused: bool,  // If true, all trading halted
    pub pause_reason: String,
    pub paused_at: i64,
}
```

**When Paused:**
- No new orders accepted
- No matches executed
- Existing positions remain (not liquidated)
- Settlements continue (already resolved markets)

### 11.2 Price Feed Failure Handling
If price feed returns stale/invalid price at resolution:

**Scenario A: Stale Price (>60s old)**
```
Keeper detects stale price
├── Does NOT resolve market
├── Retries every 10 seconds
├── After 5 minutes: Alerts admin
└── Admin can manually set outcome (with delay)
```

**Scenario B: Price Unavailable**
```
Price feed down
├── Market resolution delayed
├── All positions remain open
├── Trading continues until close time
└── Settles when feed recovers
```

### 11.3 Transaction Failure & Retries

**Match Transaction Failure:**
```
Matching engine creates tx → Submits to Solana
├── Success: Update DB, notify users
├── Failure (network): Retry 3x with backoff
├── Failure (on-chain error): 
│   ├── Insufficient funds? → Cancel taker order
│   ├── Position limit? → Cancel taker order
│   └── Unknown? → Alert, manual review
```

**Settlement Transaction Failure:**
```
Keeper settles position → Tx fails
├── Position remains "pending_settlement"
├── Keeper retries in next batch
├── After 10 failures: Alert admin
└── User can see "settlement pending" in UI
```

### 11.4 Relayer Key Security
The relayer signs `execute_match` instructions. If compromised:

**Mitigations:**
- Relayer can ONLY match, not steal funds
- User orders require valid on-chain Order PDA
- MM bot orders are internal (platform-controlled)
- Multisig for admin functions
- Key rotation procedure documented

### 11.5 Hybrid Model Security Analysis

The hybrid model provides different security guarantees for different participants:

**User Order Security (Trustless):**
```
┌────────────────────────────────────────────────────────────────────┐
│  USER ORDERS ARE FULLY TRUSTLESS                                   │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ✅ Order exists on-chain as PDA (cannot be fabricated)            │
│  ✅ User signed real Solana transaction                            │
│  ✅ Order can only be matched if PDA exists                        │
│  ✅ Relayer cannot create fake user orders                         │
│  ✅ Full audit trail on blockchain                                 │
│  ✅ User can cancel directly on-chain                              │
│                                                                    │
│  Attack vectors BLOCKED:                                           │
│  ❌ Relayer cannot match non-existent user orders                  │
│  ❌ Relayer cannot modify user order terms                         │
│  ❌ Relayer cannot prevent user from canceling                     │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**MM Bot Order Security (Trusted):**
```
┌────────────────────────────────────────────────────────────────────┐
│  MM ORDERS ARE PLATFORM-CONTROLLED                                 │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ⚠️  MM orders are off-chain (verified by relayer)                 │
│  ⚠️  Relayer could theoretically fake MM orders                    │
│                                                                    │
│  WHY THIS IS ACCEPTABLE:                                           │
│  ✅ MM bot is OWNED by the platform (it's our wallet)              │
│  ✅ MM bot trades against USER funds, not vice versa               │
│  ✅ If relayer fakes MM orders, platform loses money               │
│  ✅ Users can ONLY benefit from fake MM orders (free money)        │
│  ✅ Settlement is still on-chain (atomic, verifiable)              │
│                                                                    │
│  Worst case (compromised relayer + MM key):                        │
│  - Could match users at bad prices against fake MM orders          │
│  - But funds still go to REAL user wallets (settlement on-chain)   │
│  - Platform (MM) loses money, users at worst get fair settlement   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Settlement Security (Trustless):**
```
┌────────────────────────────────────────────────────────────────────┐
│  SETTLEMENT IS ALWAYS ON-CHAIN                                     │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ✅ execute_match is atomic (all-or-nothing)                       │
│  ✅ USDC transfers verified by SPL Token program                   │
│  ✅ Positions updated deterministically                            │
│  ✅ Cannot be reversed or modified after confirmation              │
│  ✅ Full transparency via Solana Explorer                          │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Comparison with Other Platforms:**
| Platform | User Orders | MM Orders | Settlement | Trust Level |
|----------|-------------|-----------|------------|-------------|
| **Polymarket** | Off-chain | Off-chain | On-chain | Medium |
| **dYdX v3** | Off-chain | Off-chain | StarkEx L2 | Medium |
| **OpenBook** | On-chain | On-chain | On-chain | High |
| **Binance** | Off-chain | Off-chain | Off-chain | Centralized |
| **Degen Terminal** | **On-chain** | **Off-chain** | **On-chain** | **High** |

---

## 12. Collateral & Settlement Model

### 12.1 The Core Invariant: YES + NO = $1.00
The system maintains **full collateralization** through a fundamental invariant:

```
┌────────────────────────────────────────────────────────────────────┐
│                    COLLATERALIZATION INVARIANT                     │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│   For every market:                                                │
│                                                                    │
│   Total YES Shares = Total NO Shares = Open Interest               │
│                                                                    │
│   Vault Balance = Open Interest × $1.00                            │
│                                                                    │
│   Therefore: Every share can ALWAYS be redeemed at settlement      │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Why This Works:**
- YES and NO shares are **always created in pairs**
- $1.00 USDC is deposited for every pair minted
- At settlement, exactly $1.00 is paid out per pair (all to winner)
- The vault can never be undercollateralized

### 12.2 Share Creation: "Minting Pairs"
Shares don't exist in isolation. When a trade creates NEW positions, it mints a YES/NO pair:

```
MINTING NEW SHARES (Opening Trade)
══════════════════════════════════

User A: "Buy 100 YES @ $0.40"     User B: "Buy 100 NO @ $0.60"
         │                                  │
         └──────────┬───────────────────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │   MATCH @ $0.40/YES  │
         │        $0.60/NO      │
         └──────────────────────┘
                    │
    ┌───────────────┼───────────────┐
    │               │               │
    ▼               ▼               ▼
User A          VAULT           User B
+100 YES      +$100 USDC       +100 NO
-$40 USDC    (40 + 60)        -$60 USDC

Open Interest: +100 contracts
Vault Balance: +$100.00
```

**Key Point:** Both sides MUST deposit. The sum is always $1.00 per contract.

### 12.3 Two Types of Trades

**Type 1: OPENING TRADE (Mints New Shares)**
When NEITHER party has existing shares in that outcome:

```
Scenario: Fresh market, no positions exist

User A: BID YES @ $0.40 (wants to BUY YES)
User B: ASK YES @ $0.40 (wants to SELL YES = BUY NO)

Since User B has no YES to sell, system:
├── Creates 100 YES for User A
├── Creates 100 NO for User B
├── Takes $40 from A, $60 from B
└── Vault += $100

Result:
├── User A: +100 YES shares, -$40
├── User B: +100 NO shares, -$60
└── Vault: +$100
```

**Type 2: CLOSING TRADE (Transfers Existing Shares)**
When the SELLER already owns the shares they're selling:

```
Scenario: User B already owns 100 YES from earlier trade

User A: BID YES @ $0.50 (wants to BUY YES)
User B: ASK YES @ $0.50 (selling their existing YES)

Since User B HAS 100 YES:
├── Transfer 100 YES from B → A
├── Transfer $50 from A → B
└── Vault unchanged (collateral already there)

Result:
├── User A: +100 YES shares, -$50
├── User B: -100 YES shares, +$50
└── Vault: unchanged
└── Open Interest: unchanged
```

### 12.4 The Matching Logic (Critical)
The `execute_match` instruction must determine which type of trade this is:

```rust
// Pseudocode for execute_match
fn execute_match(maker: Order, taker: Order) {
    let maker_position = get_position(maker.user, market);
    let taker_position = get_position(taker.user, market);
    
    // Determine if this is opening or closing for each side
    let maker_is_closing = can_close(&maker, &maker_position);
    let taker_is_closing = can_close(&taker, &taker_position);
    
    match (maker_is_closing, taker_is_closing) {
        // CASE 1: Both opening → Mint new pair
        (false, false) => {
            let yes_buyer = if maker.outcome == YES { maker } else { taker };
            let no_buyer = if maker.outcome == NO { maker } else { taker };
            
            // Transfer collateral from BOTH parties
            transfer(yes_buyer.wallet, vault, price * size);
            transfer(no_buyer.wallet, vault, (1 - price) * size);
            
            // Mint shares to both
            mint_shares(yes_buyer, YES, size);
            mint_shares(no_buyer, NO, size);
            
            market.open_interest += size;
        }
        
        // CASE 2: Seller closing, Buyer opening → Transfer shares
        (true, false) | (false, true) => {
            let (closer, opener) = ...;
            
            // Transfer shares from closer to opener
            transfer_shares(closer, opener, outcome, size);
            
            // Transfer USDC from opener to closer
            transfer(opener.wallet, closer.wallet, price * size);
            
            // Open interest unchanged, vault unchanged
        }
        
        // CASE 3: Both closing → Burn the pair, return collateral
        (true, true) => {
            // This means one has YES, other has NO, they're swapping
            // Actually this collapses to Case 2 effectively
            // Or they could both redeem early (rare case)
        }
    }
}

fn can_close(order: &Order, position: &Position) -> bool {
    // Seller can close if they have enough shares
    if order.side == ASK {
        match order.outcome {
            YES => position.yes_shares >= order.size,
            NO => position.no_shares >= order.size,
        }
    } else {
        false  // Buyer is always "opening" or adding to position
    }
}
```

### 12.5 Collateral Verification (On-Chain Check)
The smart contract ENFORCES collateralization:

```rust
#[account]
pub struct Market {
    // ... other fields ...
    pub open_interest: u64,        // Total pairs minted
    pub vault_balance: u64,        // Actual USDC in vault
}

// INVARIANT CHECK (can be called by anyone)
pub fn verify_collateral(market: &Market) -> bool {
    market.vault_balance >= market.open_interest * 1_000_000  // $1 per pair
}

// On every trade, this is checked:
// After execute_match, assert!(verify_collateral(market))
```

### 12.6 Settlement: Guaranteed Payout

```
SETTLEMENT EXAMPLE
══════════════════

Market: BTC-5m, Open Interest = 1,000 contracts
Vault Balance: $1,000.00 USDC

Holders:
├── Alice: 300 YES
├── Bob: 200 YES  
├── Carol: 500 NO
├── Dave: 300 NO
├── Eve: 200 NO
│
│   Total YES: 500 ✓
│   Total NO: 500 ✓
│   (Wait, that's only 500 pairs? Let me recalculate...)
│
│   Actually: Open Interest = 500 pairs
│   Alice 300 YES = she's counterparty to 300 NO (split among Carol/Dave/Eve)
│   Bob 200 YES = counterparty to 200 NO
│
│   Total YES: 500, Total NO: 500 ✓
│   Vault: $500.00 ✓

Market resolves: YES WINS

Payouts:
├── Alice: 300 × $1.00 = $300.00
├── Bob: 200 × $1.00 = $200.00
├── Carol: 0 × $1.00 = $0.00
├── Dave: 0 × $1.00 = $0.00
├── Eve: 0 × $1.00 = $0.00
│
│   Total Payout: $500.00
│   Vault Balance: $500.00
│
└── ✓ FULLY COLLATERALIZED - Everyone gets paid
```

### 12.7 Edge Cases Handled

**Q: What if someone tries to sell shares they don't have?**
```
User A: ASK 100 YES @ $0.50 (but has 0 YES shares)

System interprets this as:
├── User A wants to BUY 100 NO @ $0.50
├── Waits for counterparty who wants to BUY YES
├── When matched: Mints new pair (both deposit)
└── User A gets NO shares, not "naked short" YES
```

**Q: What if vault is somehow drained (exploit)?**
```
├── Contract only allows vault withdrawals via:
│   ├── settle_positions (after resolution)
│   └── No other method exists
├── Relayer cannot withdraw (only match)
├── Users cannot withdraw directly
└── Only program authority (admin multisig) could theoretically pause
```

**Q: What if more trades happen than vault can cover?**
```
Impossible because:
├── Every opening trade REQUIRES deposit first
├── execute_match atomically: deposit → mint shares
├── If deposit fails (insufficient balance), whole tx reverts
└── Shares cannot exist without backing collateral
```

### 12.8 On-Chain Data Structures for Collateral

```rust
#[account]
pub struct Market {
    pub id: u64,
    pub asset_symbol: String,
    pub strike_price: u64,
    pub expiry_ts: i64,
    pub outcome: u8,
    
    // COLLATERAL TRACKING
    pub open_interest: u64,          // Total YES/NO pairs minted
    pub vault: Pubkey,               // Associated token account for USDC
    
    // Derived: vault.amount should ALWAYS equal open_interest * 1_000_000
    pub bump: u8,
}

#[account]
pub struct UserPosition {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub yes_shares: u64,
    pub no_shares: u64,
    
    // For P&L tracking (not collateral)
    pub yes_cost_basis: u64,         // Total USDC spent on YES
    pub no_cost_basis: u64,          // Total USDC spent on NO
    pub bump: u8,
}
```

### 12.9 Summary: Why It's Always Fully Collateralized

| Guarantee | How It's Enforced |
|-----------|-------------------|
| Every pair has $1.00 | Opening trades require both sides to deposit |
| Can't sell what you don't own | ASK without shares = interpreted as buying opposite |
| Vault can't be drained | Only settlement instruction can withdraw |
| Settlement always works | Vault = Open Interest × $1.00 (invariant) |
| No fractional reserve | Atomic: deposit + mint happen together or revert |

---

### 12.10 Current Model (v1 - No Leverage)
In v1, all positions are **fully collateralized**. Users cannot lose more than they deposit.

**Opening a Position:**
```
User wants to buy 10 YES @ $0.40 each
├── Total Cost: 10 × $0.40 = $4.00 USDC
├── Max Payout: 10 × $1.00 = $10.00 USDC (if YES wins)
└── Max Loss: $4.00 USDC (if NO wins)
```

**Collateral Locking:**
- USDC is locked **at match time**, not order placement
- This allows users to place multiple orders with same capital (only one can fill)
- On match: Relayer's atomic tx transfers USDC from both parties to Vault

**Settlement Payouts:**
```
Market Resolves YES:
├── YES holder: Claims $1.00 per share
└── NO holder: Claims $0.00 per share

Market Resolves NO:
├── YES holder: Claims $0.00 per share
└── NO holder: Claims $1.00 per share
```

### 12.2 Future Model (v2 - Margin Trading)
*Architecture is designed to support margin, but NOT enabled at launch.*

**Leverage Mechanics:**
```
5x Leverage Example:
├── User deposits $100 USDC as margin
├── Can open position worth $500 notional
├── Liquidation at ~80% loss ($80 loss = margin depleted)
└── Requires liquidation engine + insurance fund
```

**Required Components for v2:**
| Component | Purpose |
|-----------|---------|
| Margin Account | Track user's deposited collateral |
| Mark Price Feed | Real-time position valuation |
| Liquidation Engine | Close underwater positions |
| Insurance Fund | Cover shortfalls from bad liquidations |
| Funding Rate | Balance long/short open interest |

**Account Changes for v2:**
```rust
#[account]
pub struct MarginAccount {
    pub owner: Pubkey,
    pub collateral: u64,       // Deposited USDC
    pub unrealized_pnl: i64,   // Current P&L
    pub margin_ratio: u64,     // collateral / notional exposure
    pub liquidation_price: u64,
}
```

---

## 13. Fee Structure

### 13.1 Trading Fees
| Party | Fee | Notes |
|-------|-----|-------|
| Maker | 0.00% | Incentivize limit orders |
| Taker | 0.10% | Charged on notional |

**Example:**
```
Buy 100 YES @ $0.50 (Taker)
├── Notional: 100 × $0.50 = $50.00
├── Fee: $50.00 × 0.10% = $0.05
└── Total Debit: $50.05 USDC
```

### 13.2 Fee Collection (On-Chain)
```rust
#[account]
pub struct GlobalState {
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,  // Treasury PDA
    pub maker_fee_bps: u16,     // 0 = 0.00%
    pub taker_fee_bps: u16,     // 10 = 0.10%
    pub protocol_paused: bool,
}
```

Fees are deducted atomically during `execute_match` instruction:
1. Calculate maker_fee and taker_fee
2. Transfer fees to `fee_recipient` PDA
3. Transfer remaining to position/counterparty

### 13.3 Fee Benchmarks
| Platform | Maker | Taker | Type |
|----------|-------|-------|------|
| Binance Spot | 0.10% | 0.10% | CEX |
| Binance Futures | 0.02% | 0.04% | Derivatives |
| Coinbase Advanced | 0.40% | 0.60% | CEX |
| Polymarket | 0% | 0% | Prediction |
| **Degen Terminal** | **0%** | **0.10%** | Prediction |

---

## 14. API Specification (Frontend <-> Relayer)

### Overview
The API handles two types of order sources differently:

| Source | Endpoint | Flow |
|--------|----------|------|
| **User Orders** | On-chain tx → Event listener | Backend listens for `OrderPlaced` events |
| **MM Bot Orders** | `POST /internal/mm-orders` | Direct API submission with Ed25519 signature |

### User Order Flow (On-Chain)

Users do NOT call the API to place orders. Instead:

1. **Frontend** builds and submits `place_order` transaction to Solana
2. **Backend** listens for `OrderPlaced` events via WebSocket/polling
3. **Backend** adds order to matching engine automatically

```
Frontend → Solana RPC → On-chain execution → Event emitted → Backend listener
```

### `GET /orders/user/:walletAddress`
**Description:** Get user's orders (reads from on-chain + database).

**Response:**
```json
{
  "orders": [
    {
      "id": "order-pda-address",
      "market": "BTC-5m-12:00",
      "side": "bid",
      "outcome": "yes",
      "price": 0.50,
      "size": 100,
      "filledSize": 25,
      "status": "partial",
      "createdAt": "2024-03-10T12:00:00Z"
    }
  ]
}
```

### `POST /orders/cancel` (User initiated)
**Description:** User signs a cancel_order transaction on-chain.

*Note: Cancellation is also on-chain. Frontend submits `cancel_order` tx.*

### `POST /internal/mm-orders` (MM Bot Only)
**Description:** Internal endpoint for MM bot to submit off-chain orders.

**Request Body:**
```json
{
  "marketAddress": "So111... (The specific BTC-5m Market PDA)",
  "order": {
    "side": "bid",
    "outcome": "yes",
    "type": "limit",
    "price": 500000,
    "size": 10000000,
    "expiry": 1709999999,
    "clientOrderId": 123456789
  },
  "signature": "Base64EncodedEd25519Signature...",
  "signerPubkey": "MMBotWalletPubkey..."
}
```

**Response:**
```json
{
  "status": "accepted",
  "orderId": "mm-order-uuid-123"
}
```

**Authentication:** Internal API key or restricted to localhost/internal network.

```


