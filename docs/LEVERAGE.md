# Leverage Feature Design

## Overview

Users can trade with up to **10x leverage** on prediction market positions. The protocol provides loans from a dedicated lending pool, and positions are automatically liquidated if margin falls below maintenance requirements.

---

## 1. Wallets Required

| Wallet | Purpose | Env Variable |
|--------|---------|--------------|
| **Lending Pool** | Holds USDC for user loans | `LENDING_POOL_PRIVATE_KEY` |
| **Insurance Fund** | Receives liquidation penalties, covers bad debt | `INSURANCE_FUND_PRIVATE_KEY` |

Both wallets need USDC Associated Token Accounts (ATAs).

---

## 2. Key Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `MAX_LEVERAGE` | 10x | Maximum leverage multiplier |
| `MIN_LEVERAGE` | 1x | No leverage (cash position) |
| `INITIAL_MARGIN` | 1/leverage | e.g., 10% for 10x |
| `MAINTENANCE_MARGIN` | 3% | Liquidation trigger (liquidate later, return ~35% of margin) |
| `LIQUIDATION_PENALTY` | 2% | Goes to insurance fund |
| `INTEREST_RATE` | 0% | No interest on loans |

---

## 3. Leverage Mechanics

### 3.1 Opening a Leveraged Position

**User Input:**
- Amount of USDC (margin)
- Leverage multiplier (1x - 10x slider)
- Side (YES or NO)
- Price (limit) or market order

**Calculation:**
```
margin          = User's USDC deposit
leverage        = Selected multiplier (1-10)
buying_power    = margin × leverage
loan_amount     = buying_power - margin
shares          = buying_power ÷ price
```

**Example: 5x leverage on YES @ $0.50**
```
User deposits:    $10 (margin)
Leverage:         5x
Buying power:     $10 × 5 = $50
Loan from pool:   $50 - $10 = $40
Shares acquired:  $50 ÷ $0.50 = 100 YES
```

### 3.2 Position Value & Equity

```
position_value = shares × current_price
equity         = position_value - loan_amount
margin_ratio   = equity ÷ position_value
```

**Continuing example (price rises to $0.60):**
```
Position Value:  100 × $0.60 = $60
Equity:          $60 - $40 = $20
Margin Ratio:    $20 ÷ $60 = 33.3%
Unrealized PnL:  $20 - $10 = +$10 (100% return on margin!)
```

**If price drops to $0.45:**
```
Position Value:  100 × $0.45 = $45
Equity:          $45 - $40 = $5
Margin Ratio:    $5 ÷ $45 = 11.1%
Unrealized PnL:  $5 - $10 = -$5 (50% loss on margin)
```

---

## 4. Liquidation

### 4.1 Liquidation Price Formula

**For LONG (YES) positions:**
```
liquidation_price = loan_amount ÷ (shares × (1 - maintenance_margin))
```

**For SHORT (NO) positions:**
```
liquidation_price = 1 - (loan_amount ÷ (shares × (1 - maintenance_margin)))
```

**Example (continuing from above):**
```
Loan:               $40
Shares:             100 YES
Maintenance Margin: 10%

Liquidation Price = $40 ÷ (100 × 0.90)
                  = $40 ÷ 90
                  = $0.444

At $0.444:
├── Position Value: 100 × $0.444 = $44.44
├── Equity: $44.44 - $40 = $4.44
└── Margin Ratio: $4.44 ÷ $44.44 = 10% ← LIQUIDATION TRIGGERED
```

### 4.2 Liquidation Process

```
┌─────────────────────────────────────────────────────────────────────┐
│                      LIQUIDATION FLOW                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Liquidation Keeper (every 2 seconds):                           │
│     - Query all margin_accounts with status = 'OPEN'                │
│     - Get current price for each position's market                  │
│     - Calculate margin_ratio for each                               │
│                                                                      │
│  2. If margin_ratio < 10%:                                          │
│     - Lock the margin account (prevent user actions)                │
│     - Execute liquidation                                           │
│                                                                      │
│  3. Liquidation Execution:                                          │
│     a. Market sell all shares at current price                      │
│     b. Calculate proceeds = shares × execution_price                │
│     c. Repay loan_amount to Lending Pool                            │
│     d. Calculate penalty = proceeds × 2%                            │
│     e. Send penalty to Insurance Fund                               │
│     f. Return remaining = proceeds - loan - penalty to User         │
│                                                                      │
│  4. If proceeds < loan_amount (bad debt):                           │
│     a. Lending Pool receives all proceeds                           │
│     b. Insurance Fund covers the shortfall                          │
│     c. Log bad debt event for monitoring                            │
│                                                                      │
│  5. Update records:                                                  │
│     - margin_account.status = 'LIQUIDATED'                          │
│     - Create liquidation record                                     │
│     - Update position (shares = 0)                                  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.3 Liquidation Example

**Before Liquidation (at $0.444):**
```
Position Value:  $44.44
Loan Amount:     $40.00
Equity:          $4.44
```

**Liquidation Execution:**
```
Sell 100 YES @ $0.444:
├── Proceeds:              $44.44
├── Repay Loan:           -$40.00
├── Remaining:             $4.44
├── Penalty (2%):         -$0.89  → Insurance Fund
└── Return to User:        $3.55
```

---

## 5. Adding Margin

Users can deposit additional USDC to:
1. Lower their liquidation price
2. Reduce effective leverage
3. Survive drawdowns

### 5.1 Adding Margin (Reduce Loan)

When user adds margin, it's applied to **reduce the loan amount**:

```
add_margin(amount):
    margin_account.loan_amount -= amount
    margin_account.margin_deposited += amount
    recalculate_liquidation_price()
```

**Example:**
```
Before:
├── Margin:             $10
├── Loan:               $40
├── Leverage:           5x
├── Liquidation Price:  $0.444

User Adds $10:
├── Margin:             $20 (increased)
├── Loan:               $30 (reduced by $10)
├── Leverage:           2.5x (effectively de-leveraged)
├── Liquidation Price:  $30 ÷ (100 × 0.90) = $0.333 (safer)
```

### 5.2 Withdrawing Excess Margin

Users can withdraw margin IF it doesn't push them below initial margin requirements:

```
withdraw_margin(amount):
    new_equity = current_equity - amount
    new_margin_ratio = new_equity / position_value
    
    if new_margin_ratio >= initial_margin_for_leverage:
        allow_withdrawal
    else:
        reject (would exceed leverage limit)
```

---

## 6. Closing Leveraged Positions

### 6.1 Manual Close (User Initiated)

```
close_position():
    1. Sell all shares at market price (Lending Pool → MM via execute_close)
    2. Repay loan to Lending Pool
    3. Return remaining equity to User
    4. Close margin account (DB status → CLOSED)
    5. Mark user's DB position as SETTLED
    6. [On market resolve] Lending Pool's on-chain position is settled (cleanup)
```

**Example (price rose to $0.70):**
```
Sell 100 YES @ $0.70:
├── Proceeds:      $70.00
├── Repay Loan:   -$40.00
└── Profit:        $30.00 → User (3x return on $10 margin!)
```

**Important:** When a leveraged position is manually closed, the Lending Pool's
on-chain position account still exists (with 0 shares). This account is settled
automatically when the market resolves (position-settler includes Lending Pool
in the settlement batch if any margin accounts exist for that market). This
ensures `settled_positions == total_positions` on-chain, allowing `close_market`
to succeed.

### 6.2 Settlement (Market Expiry)

If market settles before user closes:

**If user wins (YES wins, user held YES):**
```
Payout = shares × $1.00 = 100 × $1.00 = $100
Repay Loan: -$40
Net Profit: $60 → User
```

**If user loses (NO wins, user held YES):**
```
Payout = shares × $0.00 = $0
Loan Loss: $40 → Insurance Fund covers
User Loss: $10 (their margin)
```

---

## 7. Database Schema

### 7.1 New Tables

```sql
-- Lending Pool State
CREATE TABLE lending_pool (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address VARCHAR(44) NOT NULL,
    total_deposited DECIMAL(20,6) DEFAULT 0,    -- Total USDC deposited
    total_loaned DECIMAL(20,6) DEFAULT 0,        -- Currently on loan
    available DECIMAL(20,6) DEFAULT 0,           -- Available to lend
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Insurance Fund State
CREATE TABLE insurance_fund (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address VARCHAR(44) NOT NULL,
    balance DECIMAL(20,6) DEFAULT 0,             -- Current balance
    total_received DECIMAL(20,6) DEFAULT 0,      -- Total penalties received
    total_paid_out DECIMAL(20,6) DEFAULT 0,      -- Total bad debt covered
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Margin Accounts (one per leveraged position)
CREATE TABLE margin_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    position_id UUID NOT NULL REFERENCES positions(id),
    market_id UUID NOT NULL REFERENCES markets(id),
    
    -- Position details
    side VARCHAR(10) NOT NULL,                   -- 'YES' or 'NO'
    shares DECIMAL(20,6) NOT NULL,               -- Number of contracts
    entry_price DECIMAL(10,6) NOT NULL,          -- Avg entry price
    
    -- Margin & Loan
    margin_deposited DECIMAL(20,6) NOT NULL,     -- User's collateral
    loan_amount DECIMAL(20,6) NOT NULL,          -- Amount borrowed
    leverage DECIMAL(4,2) NOT NULL,              -- 1.00 to 10.00
    
    -- Liquidation
    liquidation_price DECIMAL(10,6) NOT NULL,    -- Auto-calculated
    
    -- Status
    status VARCHAR(20) DEFAULT 'OPEN',           -- OPEN, LIQUIDATED, CLOSED
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Liquidation History
CREATE TABLE liquidations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    margin_account_id UUID NOT NULL REFERENCES margin_accounts(id),
    user_id UUID NOT NULL REFERENCES users(id),
    market_id UUID NOT NULL REFERENCES markets(id),
    
    -- Liquidation details
    trigger_price DECIMAL(10,6) NOT NULL,        -- Price that triggered liquidation
    execution_price DECIMAL(10,6) NOT NULL,      -- Actual execution price
    shares_liquidated DECIMAL(20,6) NOT NULL,
    
    -- Financial breakdown
    proceeds DECIMAL(20,6) NOT NULL,             -- Total from selling shares
    loan_repaid DECIMAL(20,6) NOT NULL,          -- Amount returned to lending pool
    penalty DECIMAL(20,6) NOT NULL,              -- 2% penalty to insurance
    returned_to_user DECIMAL(20,6) NOT NULL,     -- Remaining to user
    bad_debt DECIMAL(20,6) DEFAULT 0,            -- If proceeds < loan
    
    tx_signature VARCHAR(88),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Margin Transactions (deposits/withdrawals)
CREATE TABLE margin_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    margin_account_id UUID NOT NULL REFERENCES margin_accounts(id),
    user_id UUID NOT NULL REFERENCES users(id),
    
    type VARCHAR(20) NOT NULL,                   -- 'DEPOSIT', 'WITHDRAW'
    amount DECIMAL(20,6) NOT NULL,
    
    -- Impact
    loan_before DECIMAL(20,6) NOT NULL,
    loan_after DECIMAL(20,6) NOT NULL,
    liq_price_before DECIMAL(10,6) NOT NULL,
    liq_price_after DECIMAL(10,6) NOT NULL,
    
    tx_signature VARCHAR(88),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_margin_accounts_user ON margin_accounts(user_id);
CREATE INDEX idx_margin_accounts_status ON margin_accounts(status);
CREATE INDEX idx_margin_accounts_market ON margin_accounts(market_id);
CREATE INDEX idx_liquidations_user ON liquidations(user_id);
```

### 7.2 New Enums

```sql
CREATE TYPE margin_account_status AS ENUM ('OPEN', 'LIQUIDATED', 'CLOSED');
CREATE TYPE margin_tx_type AS ENUM ('DEPOSIT', 'WITHDRAW');
```

---

## 8. API Endpoints

### 8.1 Leverage Trading

**POST /orders/notify** (modified)
```json
{
  "marketAddress": "So111...",
  "side": "bid",
  "outcome": "yes",
  "type": "limit",
  "price": 0.50,
  "size": 100,
  "leverage": 5.0,          // NEW: 1.0 to 10.0
  "margin": 10.0,           // NEW: User's collateral in USDC
  ...
}
```

**Response:**
```json
{
  "orderId": "uuid",
  "marginAccountId": "uuid",    // NEW
  "liquidationPrice": 0.444,    // NEW
  "status": "open"
}
```

### 8.2 Margin Management

**POST /margin/deposit**
```json
{
  "marginAccountId": "uuid",
  "amount": 10.0,
  "signature": "..."
}
```

**POST /margin/withdraw**
```json
{
  "marginAccountId": "uuid",
  "amount": 5.0,
  "signature": "..."
}
```

### 8.3 User Margin Data

**GET /user/margin-accounts**
```json
{
  "accounts": [
    {
      "id": "uuid",
      "market": "BTC-5m",
      "side": "yes",
      "shares": 100,
      "entryPrice": 0.50,
      "currentPrice": 0.55,
      "marginDeposited": 10.0,
      "loanAmount": 40.0,
      "leverage": 5.0,
      "liquidationPrice": 0.444,
      "equity": 15.0,
      "marginRatio": 0.273,
      "unrealizedPnl": 5.0,
      "status": "OPEN"
    }
  ]
}
```

---

## 9. Keeper Jobs

### 9.1 Liquidation Checker

```typescript
// Check every 2 seconds
const liquidationCheckerJob = {
  name: 'Liquidation Checker',
  intervalMs: 2 * 1000,
  job: async () => {
    // 1. Get all OPEN margin accounts
    const accounts = await getOpenMarginAccounts();
    
    // 2. For each account, check margin ratio
    for (const account of accounts) {
      const currentPrice = await getCurrentPrice(account.marketId, account.side);
      const positionValue = account.shares * currentPrice;
      const equity = positionValue - account.loanAmount;
      const marginRatio = equity / positionValue;
      
      // 3. If below maintenance margin, liquidate
      if (marginRatio < MAINTENANCE_MARGIN) {
        await liquidatePosition(account);
      }
    }
  },
  enabled: true,
};
```

---

## 10. Frontend UI

### 10.1 Leverage Slider

```
Trade Panel:
┌─────────────────────────────────────────┐
│  BUY YES                                │
├─────────────────────────────────────────┤
│  Amount: [$10.00        ]               │
│                                         │
│  Leverage: 1x ──────●────────── 10x     │
│            [        5.0x        ]       │
│                                         │
│  ─────────────────────────────────────  │
│  Buying Power:     $50.00               │
│  Contracts:        100 YES @ $0.50      │
│  Loan Amount:      $40.00               │
│  ─────────────────────────────────────  │
│  Liquidation Price: $0.444              │
│  ─────────────────────────────────────  │
│                                         │
│  [        CONFIRM TRADE        ]        │
└─────────────────────────────────────────┘
```

### 10.2 Position Card (Leveraged)

```
┌─────────────────────────────────────────┐
│  BTC-5m  │  YES  │  5x LEVERAGE         │
├─────────────────────────────────────────┤
│  100 contracts @ $0.50                  │
│                                         │
│  Current Price:    $0.55                │
│  Position Value:   $55.00               │
│  Equity:           $15.00               │
│  Unrealized PnL:   +$5.00 (+50%)  🟢    │
│                                         │
│  Margin:           $10.00               │
│  Loan:             $40.00               │
│  Margin Ratio:     27.3%    ████████░░  │
│                                         │
│  ⚠️ Liquidation at: $0.444              │
│                                         │
│  [Add Margin] [Close Position]          │
└─────────────────────────────────────────┘
```

---

## 11. Risk Management

### 11.1 Lending Pool Limits

| Metric | Limit |
|--------|-------|
| Max single loan | 10% of pool |
| Max total exposure to one user | 20% of pool |
| Min pool reserve | 10% always available |

### 11.2 Insurance Fund Monitoring

Alert thresholds:
- Insurance Fund < 10% of total loans → Warning
- Insurance Fund < 5% of total loans → Critical
- Bad debt event > $1000 → Alert

### 11.3 Circuit Breakers

- If Insurance Fund depleted → Pause new leveraged orders
- If Lending Pool < 10% available → Pause new leveraged orders
- If bad debt rate > 5% in 24h → Pause and review

---

## 12. Environment Variables

```env
# Lending Pool Wallet (provides USDC loans for leveraged positions)
LENDING_WALLET=base58_encoded_private_key
# or
LENDING_WALLET_PRIVATE_KEY=base58_encoded_private_key

# Insurance Fund Wallet (receives liquidation penalties, covers bad debt)
INSURANCE_WALLET=base58_encoded_private_key
# or
INSURANCE_WALLET_PRIVATE_KEY=base58_encoded_private_key

# Leverage Settings (all have defaults)
MAX_LEVERAGE=10                    # Default: 10
MAINTENANCE_MARGIN_PCT=3           # Default: 3 (percentage) - lower = liquidate later, return more
LIQUIDATION_PENALTY_PCT=2          # Default: 2 (percentage)
MIN_MARGIN_USD=5                   # Default: 5 (dollars)
MAX_SINGLE_LOAN_PCT=10             # Default: 10 (max 10% of pool per loan)
MAX_USER_EXPOSURE_PCT=20           # Default: 20 (max 20% of pool per user)
MIN_POOL_RESERVE_PCT=10            # Default: 10 (keep 10% always available)
```

**Note:** Both wallets need USDC Associated Token Accounts (ATAs) funded with USDC to provide loans and receive penalties.

---

## 13. Implementation Phases

### Phase 1: Database & Core Logic ✅
- [x] Create database migrations
- [x] Implement margin account service (`margin.service.ts`)
- [x] Implement liquidation price calculator (`leverageCalc`)
- [x] Add lending pool service (`lending.service.ts`)

### Phase 2: API & Order Flow ✅
- [x] Modify order endpoint for leverage (`/orders/notify` with `leverage` param)
- [x] Add margin deposit endpoint (`/margin/add`)
- [x] Add margin account query endpoints (`/margin/accounts`, `/margin/accounts/:id`)
- [x] Add leverage calculation endpoint (`/margin/calculate`)
- [x] Add liquidation history endpoint (`/margin/liquidations`)
- [x] Add pool status endpoint (`/margin/pool`)

### Phase 3: Keeper & Liquidations ✅
- [x] Implement liquidation checker job (runs every 1 second)
- [x] Implement liquidation execution logic
- [x] Add insurance fund integration
- [x] Add lending pool sync job (runs every 60 seconds)
- [x] Loan repayment on position settlement

### Phase 4: Frontend ✅
- [x] Add leverage slider to trade panel (popup modal)
- [x] Display leverage/liquidation price in positions table
- [x] Show leverage stats (buying power, loan, liq price) in trade modal
- [ ] Add margin management UI (add margin dialog)
- [ ] Add liquidation warnings (WebSocket notifications)

### Phase 5: On-Chain Implementation (Option 1) ✅
- [x] Execute leveraged trades from Lending Pool wallet (not user wallet)
- [x] Handle settlement payouts through Lending Pool
- [x] Distribute profits: loan repayment + user share tracking
- [ ] On-chain USDC transfer: user margin → Lending Pool (production)
- [ ] On-chain USDC transfer: user profit ← Lending Pool (production)
- [ ] Handle bad debt coverage from Insurance Fund on-chain

### Phase 6: Testing & Monitoring ✅
- [x] Unit tests for liquidation math (81 leverage tests)
- [x] Unit tests for margin service, lending service, leverage flow
- [ ] Integration tests for full leverage flow
- [ ] End-to-end test: margin → trade → settlement → payout
- [ ] Set up monitoring dashboards
- [ ] Load testing

---

## 14. On-Chain Implementation (Lending Pool Execution Model)

### 14.1 The Challenge

For regular trades, the user's wallet sends USDC directly to the market escrow:
```
User Wallet → $250 USDC → Market Escrow → 500 shares back to User
```

For leveraged trades, the user only has $25 (margin), but needs $250 (buying power):
```
User Wallet → $25 USDC → ??? → Need $250 total
```

**We can't transfer $250 from a wallet that only has $25.**

### 14.2 Solution: Lending Pool Executes Trades

The Lending Pool wallet executes leveraged trades on behalf of users:

```
┌─────────────────────────────────────────────────────────────────────────┐
│              LENDING POOL EXECUTION MODEL (Option 1)                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  KEY INSIGHT: For leveraged trades, the Lending Pool wallet executes    │
│  the on-chain transaction, NOT the user's wallet.                       │
│                                                                          │
│  - User's $25 margin is transferred to Lending Pool (collateral)        │
│  - Lending Pool executes $250 trade from its own wallet                 │
│  - Position is owned by Lending Pool on-chain, tracked to user in DB    │
│  - On settlement, Lending Pool distributes funds appropriately          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 14.3 Leveraged Trade Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    LEVERAGED TRADE EXECUTION FLOW                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  STEP 1: User places 10x leveraged order ($25 margin)                   │
│                                                                          │
│  ┌──────────┐                        ┌─────────────────┐                │
│  │   User   │ ── $25 margin ──────▶  │  Lending Pool   │                │
│  │  Wallet  │    (collateral)        │     Wallet      │                │
│  └──────────┘                        │   +$25 (user)   │                │
│                                      │   +$225 (loan)  │                │
│                                      │   =$250 total   │                │
│                                      └────────┬────────┘                │
│                                               │                          │
│  STEP 2: Lending Pool executes trade on-chain                           │
│                                               │                          │
│                                               ▼                          │
│                                      ┌─────────────────┐                │
│                                      │     Market      │                │
│                                      │    (on-chain)   │                │
│                                      └────────┬────────┘                │
│                                               │                          │
│  STEP 3: Position created (owned by Lending Pool on-chain)              │
│                                               │                          │
│                                               ▼                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Position (on-chain)           │  Margin Account (database)      │   │
│  │  ─────────────────────         │  ───────────────────────────    │   │
│  │  Owner: Lending Pool Wallet    │  User: alice.wallet             │   │
│  │  Market: BTC-5m                │  Position: linked               │   │
│  │  Shares: 500 YES               │  Margin: $25                    │   │
│  │                                │  Loan: $225                     │   │
│  │                                │  Leverage: 10x                  │   │
│  │                                │  Liq Price: $0.464              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 14.4 Settlement Flow (Market Resolves)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    SETTLEMENT FLOW (User Wins)                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Market resolves YES (user had YES position):                           │
│                                                                          │
│  ┌─────────────────┐                ┌─────────────────┐                 │
│  │     Market      │ ── $500 ────▶  │  Lending Pool   │                 │
│  │   (settled)     │    payout      │     Wallet      │                 │
│  └─────────────────┘                │  receives $500  │                 │
│                                     └────────┬────────┘                 │
│                                              │                           │
│                          ┌───────────────────┴───────────────────┐      │
│                          │         DISTRIBUTION LOGIC            │      │
│                          │                                       │      │
│                          │  Payout received:        $500.00      │      │
│                          │  - Loan repayment:      -$225.00      │      │
│                          │  ─────────────────────────────────    │      │
│                          │  User's share:           $275.00      │      │
│                          │  (margin $25 + profit $250)           │      │
│                          │                                       │      │
│                          └───────────────────┬───────────────────┘      │
│                                              │                           │
│                                              ▼                           │
│                                     ┌─────────────────┐                 │
│                                     │   User Wallet   │                 │
│                                     │  receives $275  │                 │
│                                     │  (10x return!)  │                 │
│                                     └─────────────────┘                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                    SETTLEMENT FLOW (User Loses)                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Market resolves NO (user had YES position):                            │
│                                                                          │
│  ┌─────────────────┐                ┌─────────────────┐                 │
│  │     Market      │ ── $0 ──────▶  │  Lending Pool   │                 │
│  │   (settled)     │    payout      │     Wallet      │                 │
│  └─────────────────┘                │  receives $0    │                 │
│                                     └────────┬────────┘                 │
│                                              │                           │
│                          ┌───────────────────┴───────────────────┐      │
│                          │         DISTRIBUTION LOGIC            │      │
│                          │                                       │      │
│                          │  Payout received:          $0.00      │      │
│                          │  Loan owed:              $225.00      │      │
│                          │  User margin held:        $25.00      │      │
│                          │  ─────────────────────────────────    │      │
│                          │  Bad debt: $225 - $25 = $200.00       │      │
│                          │  → Covered by Insurance Fund          │      │
│                          │                                       │      │
│                          └───────────────────────────────────────┘      │
│                                                                          │
│  User: Lost $25 margin (expected)                                       │
│  Insurance Fund: Covers $200 bad debt                                   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 14.5 Liquidation Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    LIQUIDATION FLOW (Price drops)                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Price drops to liquidation price ($0.464 for this example):            │
│                                                                          │
│  1. Liquidation Keeper detects margin_ratio < 3%                        │
│                                                                          │
│  2. Lending Pool sells shares on market:                                │
│     - Shares: 500 YES                                                   │
│     - Execution price: $0.464                                           │
│     - Proceeds: 500 × $0.464 = $232                                     │
│                                                                          │
│  3. Distribution:                                                        │
│     ┌─────────────────────────────────────────────────────────────┐    │
│     │  Proceeds:                    $232.00                        │    │
│     │  - Loan repayment:           -$225.00 → Lending Pool         │    │
│     │  ─────────────────────────────────────                       │    │
│     │  Remaining:                    $7.00                         │    │
│     │  - Penalty (2% of $250):      -$5.00 → Insurance Fund        │    │
│     │  ─────────────────────────────────────                       │    │
│     │  Return to user:               $2.00 → User Wallet           │    │
│     │                                                              │    │
│     │  User started with $25, gets back $2 (8% of margin)         │    │
│     │  Lost 92% but avoided total wipeout                          │    │
│     └─────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 14.6 Implementation Details

**Key Wallet Roles:**

| Wallet | Role | On-Chain Actions |
|--------|------|------------------|
| **User Wallet** | Provides margin | Transfers $25 to Lending Pool |
| **Lending Pool** | Executes trades | Signs all leveraged trade txs |
| **Relayer** | Coordinates | Signs match execution |
| **Insurance Fund** | Risk buffer | Receives penalties, covers bad debt |

**Code Changes Required:**

1. **`anchor-client.ts`** - Add method to execute trades from Lending Pool wallet:
   ```typescript
   async executeLeveragedMatch(params: {
     marketPubkey: string;
     takerWallet: string;      // User's wallet (for DB tracking)
     executorWallet: string;   // Lending Pool (actual signer)
     makerWallet: string;
     size: number;
     price: number;
     takerSide: 'YES' | 'NO';
   })
   ```

2. **`matching.service.ts`** - Detect leveraged orders and route to Lending Pool:
   ```typescript
   if (order.leverage > 1) {
     // Transfer user margin to lending pool
     await transferMarginToPool(order.userId, order.marginAmount);
     // Execute trade from lending pool wallet
     await anchorClient.executeLeveragedMatch({...});
   }
   ```

3. **`position-settler.ts`** - Handle leveraged position settlements:
   ```typescript
   if (position.marginAccountId) {
     // Payout goes to Lending Pool
     // Lending Pool distributes: loan repayment + user profit
     await distributeLeveragedPayout(position, payout);
   }
   ```

### 14.7 Tradeoffs vs On-Chain Margin Accounts

| Aspect | Option 1 (Lending Pool Executes) | Option 2 (On-Chain Margin) |
|--------|----------------------------------|---------------------------|
| **Transparency** | Medium (DB tracking) | High (all on-chain) |
| **Implementation** | **1-2 days** | 2-3 weeks |
| **Gas costs** | **Lower** (same as regular trade) | Higher (extra accounts) |
| **User custody** | Pool holds during trade | User's margin in PDA |
| **Auditability** | Off-chain DB + on-chain txs | Fully on-chain |
| **Complexity** | Low | High |
| **Upgrade path** | Can migrate to Option 2 later | N/A |

**Recommendation:** Start with Option 1 for v1, consider Option 2 for v2 if volume/transparency demands it.

---

## 15. Formulas Quick Reference

```
# Basic
buying_power = margin × leverage
loan_amount = buying_power - margin
shares = buying_power ÷ price

# Position Health
position_value = shares × current_price
equity = position_value - loan_amount
margin_ratio = equity ÷ position_value
unrealized_pnl = equity - margin_deposited

# Liquidation Price
liq_price_long = loan ÷ (shares × (1 - maint_margin))
liq_price_short = 1 - (loan ÷ (shares × (1 - maint_margin)))

# Liquidation Payout
proceeds = shares × execution_price
penalty = proceeds × 0.02
return_to_user = max(0, proceeds - loan - penalty)
bad_debt = max(0, loan - proceeds)
```


