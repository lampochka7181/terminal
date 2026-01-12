# Order Validation Rules

This document summarizes all order validation rules across the Degen Terminal stack.

---

## 1. Frontend (`apps/web/src`)

### `lib/solana.ts` - Core Validation Functions

| Rule | Value | Function |
|------|-------|----------|
| **Min Price** | $0.01 | `validatePrice()` |
| **Max Price** | $0.99 | `validatePrice()` |
| **Price Tick** | $0.01 increments | `validatePrice()` |
| **Min Size** | 0.001 contracts | `validateSize()` |
| **Max Size** | 100,000 contracts | `validateSize()` |
| **Size Precision** | Max 6 decimal places | `validateSize()` |

### `hooks/useOrder.ts` - Pre-submission Checks

| Check | Action |
|-------|--------|
| Wallet connected | Error: "Please connect your wallet" |
| Wallet supports signing | Error: "Wallet does not support transaction signing" |
| User authenticated | Error: "Please sign in to place orders" |
| Price validation | Calls `validatePrice()` |
| Size validation | Calls `validateSize()` |

### `components/trading/TradeModal.tsx` - UI Validation

| Rule | Implementation |
|------|----------------|
| Limit price range | `0.01 - 0.99` (HTML input min/max) |
| Min buy amount | `$5` minimum (HTML input min) |
| Min sell amount | `$0.02` minimum (equals flat fee) |
| Sell size | Cannot exceed owned shares |
| Submit enabled | Various checks per order type |

---

## 2. Fee Structure

### Fee Charging Model

**Fees are charged per fill, not per order** (industry standard).

- Each fill is charged based on its own notional value
- Large orders split into multiple fills pay the tier rate of each fill
- This matches how traditional exchanges (Binance, Coinbase) operate

### Tiered Taker Fees (Configurable via `.env`)

| Tier | Fill Size | Fee | Example |
|------|-----------|-----|---------|
| **Flat** | $0.02 - $50 | $0.02 flat | $5 → $0.02 |
| **Tier 2** | $50 - $500 | 5 bps (0.05%) | $100 → $0.05 |
| **Tier 3** | $500 - $2,000 | 4 bps (0.04%) | $1,000 → $0.40 |
| **Tier 4** | $2,000+ | 3 bps (0.03%) | $5,000 → $1.50 |

### Environment Variables

```env
# Fee Configuration
FEE_FLAT_USD=0.02          # Flat fee for small fills
FEE_TIER1_MAX=50           # Max notional for flat fee tier
FEE_TIER2_MAX=500          # Max notional for tier 2
FEE_TIER2_BPS=5            # Basis points for tier 2 (0.05%)
FEE_TIER3_MAX=2000         # Max notional for tier 3
FEE_TIER3_BPS=4            # Basis points for tier 3 (0.04%)
FEE_TIER4_BPS=3            # Basis points for tier 4 (0.03%)

# Order Minimums
MIN_BUY_NOTIONAL=5.0       # $5 minimum for buy orders
MIN_SELL_NOTIONAL=0.02     # $0.02 minimum for sell orders

# Gas Cost Reference
GAS_COST_USD=0.0015        # Actual gas per transaction
```

### Maker vs Taker

| Order Type | Fee |
|------------|-----|
| **Maker** (Limit order adding liquidity) | **0%** |
| **Taker** (Market order taking liquidity) | Tiered (see above) |

---

## 3. Backend API (`apps/api/src`)

### `routes/orders.ts` - Zod Schema Validation

**`placeOrderSchema`:**

| Field | Validation |
|-------|------------|
| `marketAddress` | String, 32-44 chars |
| `side` | `'bid'` or `'ask'` |
| `outcome` | `'yes'` or `'no'` |
| `type` | `'limit'`, `'market'`, `'ioc'`, `'fok'` |
| `price` | **0.01 - 0.99** |
| `size` | **0.001 - 100,000** |
| `signature` | Required string |

**`notifyOrderSchema`:** (Fast mode)

| Field | Validation |
|-------|------------|
| `dollarAmount` | **$0.02 - $1,000,000** |
| `maxPrice` | 0.01 - 0.99 |

### `routes/orders.ts` - Business Logic Checks

| Check | Error Code | Response |
|-------|------------|----------|
| **Minimum buy notional** | `ORDER_TOO_SMALL` | "Minimum buy order is $5.00" |
| **Minimum sell notional** | `ORDER_TOO_SMALL` | "Minimum sell order is $0.02" |
| Market exists | `MARKET_NOT_FOUND` | 404 |
| Market is OPEN | `MARKET_CLOSED` | 409 |
| Strike price set | `MARKET_PENDING` | 409 (trading suspended) |
| Delegation approved | `DELEGATION_REQUIRED` / `DELEGATION_INSUFFICIENT` | 400 |

### `config.ts` - System Constants

| Config | Value | Notes |
|--------|-------|-------|
| `minBuyNotional` | **$5.00** | Minimum buy order |
| `minSellNotional` | **$0.02** | Minimum sell order |
| `fees.flatFeeUsd` | $0.02 | Flat fee for small fills |
| `fees.tier2Bps` | 5 | 0.05% for $50-$500 fills |
| `fees.tier3Bps` | 4 | 0.04% for $500-$2000 fills |
| `fees.tier4Bps` | 3 | 0.03% for $2000+ fills |
| `makerFeeBps` | 0 | 0.00% (free) |

### `services/fee.service.ts` - Fee Calculation

```typescript
// Fee calculated per fill, not per order
function calculateTakerFee(fillNotional: number): FeeCalculation {
  if (fillNotional < 50) return { fee: 0.02, tier: 'flat' };
  if (fillNotional < 500) return { fee: fillNotional * 0.0005, tier: 'tier2' };  // 5 bps
  if (fillNotional < 2000) return { fee: fillNotional * 0.0004, tier: 'tier3' }; // 4 bps
  return { fee: fillNotional * 0.0003, tier: 'tier4' };                          // 3 bps
}
```

### `services/matching.service.ts` - Runtime Checks

| Check | Value | Notes |
|-------|-------|-------|
| Self-trade prevention | Block | Can't match against own orders |
| Min fill size | **0.01 contracts** | Walk-the-book threshold |
| Min remaining size | **0.001 contracts** | Sell order minimum |

---

## 4. On-Chain (`packages/contracts`)

### `state.rs` - Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MIN_PRICE` | 10,000 | $0.01 (6 decimals) |
| `MAX_PRICE` | 990,000 | $0.99 (6 decimals) |
| `MIN_ORDER_SIZE` | 1,000 | 0.001 contracts (6 decimals) |
| `MAX_ORDER_SIZE` | 100,000,000,000 | 100,000 contracts |
| `MAX_POSITION_SIZE` | 500,000,000,000 | **500,000 contracts/user/market** |
| `MIN_TAKER_FEE` | 20,000 | **$0.02 minimum fee (6 decimals)** |
| `MAX_ASSET_LEN` | 10 | Asset symbol length |
| `MAX_TIMEFRAME_LEN` | 10 | Timeframe string length |

### `place_order.rs` - Order Creation Validation

| Check | Error |
|-------|-------|
| Protocol not paused | `ProtocolPaused` |
| Price in range | `InvalidPrice` |
| Order not expired (LIMIT) | `OrderExpired` |

### `execute_match.rs` - Settlement Validation

| Check | Error |
|-------|-------|
| Protocol not paused | `ProtocolPaused` |
| Market status = OPEN | `MarketNotOpen` |
| Trading window open | `MarketClosing` |
| Not self-trade | `SelfTrade` |
| Sides opposite | `SameSide` |
| Outcomes match | `OutcomeMismatch` |
| Orders not expired | `OrderExpired` |
| Prices valid | `InvalidPrice` |
| Sizes valid | `InvalidSize` |
| Prices cross (bid ≥ ask) | `PriceMismatch` |
| Position limit not exceeded | `PositionLimitExceeded` |
| **Fee >= MIN_TAKER_FEE** | `FeeTooLow` |
| **Fee <= max_fee** | `FeeTooHigh` |

### `execute_close.rs` - Closing Trade Validation

| Check | Error |
|-------|-------|
| Protocol not paused | `ProtocolPaused` |
| Market status = OPEN | `MarketNotOpen` |
| Trading window open | `MarketClosing` |
| Not self-trade | `SelfTrade` |
| Price in range | `InvalidPrice` |
| Size in range | `InvalidSize` |
| Seller has shares | `InsufficientShares` |
| Position limit not exceeded | `PositionLimitExceeded` |
| **Fee >= MIN_TAKER_FEE** | `FeeTooLow` |
| **Fee <= max_fee** | `FeeTooHigh` |

### Fee Validation Flow

```
Backend                          Contract
   │                                │
   ├─ calculateTakerFee() ─────────►│
   │  (tiered calculation)          │
   │                                │
   ├─ executeMatch(fee) ───────────►│
   │                                ├─ require!(fee >= MIN_TAKER_FEE)
   │                                ├─ require!(fee <= notional * bps / 10000)
   │                                └─ transfer fee to recipient
```

---

## Summary: Key Limits

| Constraint | Frontend | Backend | On-Chain |
|------------|----------|---------|----------|
| **Min Price** | $0.01 | $0.01 | $0.01 |
| **Max Price** | $0.99 | $0.99 | $0.99 |
| **Price Tick** | $0.01 | - | - |
| **Min Size** | 0.001 | 0.001 | 0.001 |
| **Max Size** | 100,000 | 100,000 | 100,000 |
| **Min Buy Notional** | $5 | **$5** | - |
| **Min Sell Notional** | $0.02 | **$0.02** | - |
| **Min Taker Fee** | $0.02 | $0.02 | **$0.02** |
| **Max Taker Fee** | 5% | 5% | **5%** (500 bps) |
| **Max Position** | - | - | **500,000** |
| **Maker Fee** | 0% | 0% | 0% |

---

## Fee Profitability

All fill sizes are profitable after gas costs (~$0.0015/tx):

| Fill Size | Fee | Gas | Profit |
|-----------|-----|-----|--------|
| $0.02 (min sell) | $0.02 | $0.0015 | +$0.0185 |
| $5 (min buy) | $0.02 | $0.0015 | +$0.0185 |
| $100 (5 bps) | $0.05 | $0.0015 | +$0.0485 |
| $1,000 (4 bps) | $0.40 | $0.0015 | +$0.3985 |
| $3,000 (3 bps) | $0.90 | $0.0015 | +$0.8985 |

---

## Architecture Notes

### Fee Validation Flow

Fees are calculated off-chain (tiered structure) but validated on-chain:

1. **Backend** calculates fee using `fee.service.ts` (configurable tiers via `.env`)
2. **Backend** passes calculated fee to contract via `execute_match`/`execute_close`
3. **Contract** validates fee is within bounds (`MIN_TAKER_FEE` to `max_fee`)
4. **Contract** executes the transfer with the relayer-specified fee

This design allows:
- Flexible tiered pricing (configured in `.env`, no redeploy)
- On-chain protection against under/over-charging
- Transparent fee validation

### Gaps / Observations

1. **Position limit (500K)** - Only enforced on-chain, not checked in backend pre-validation
2. **Tick size** - Only validated on frontend, not backend or on-chain
3. **Max orders per market** - Documented as 100 but not actively enforced in code

---

*Last updated: January 2026*
