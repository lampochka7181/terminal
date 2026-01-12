# Relayer Economics & Fee Structure

## 1. Gas Cost Analysis

The relayer pays gas for every on-chain settlement. All costs are configurable via `.env`.

### Current Configuration

| Metric | Value | Notes |
|--------|-------|-------|
| **Compute Units** | 400,000 | Per transaction limit |
| **Priority Fee** | 10,000 µL/CU | For faster slot inclusion |
| **Base Fee** | ~5,000 lamports | Per signature |
| **Total Gas** | ~0.000009 SOL | ~$0.00135 at $150/SOL |

### Environment Variables

```env
GAS_COST_USD=0.00135      # Actual gas cost per transaction
FLAT_FEE_USD=0.02         # Minimum fee for small orders
MIN_BUY_NOTIONAL=5.0      # Minimum buy order size
MIN_SELL_NOTIONAL=0.02    # Minimum sell order size (= flat fee)
```

---

## 2. Tiered Fee Structure

Fees are charged on **taker orders only** (market orders). Maker orders (limit orders) are free to encourage liquidity.

### Fee Charging Model

**Fees are charged per fill, not per order.** This is consistent with industry standard (Binance, Coinbase, etc.).

If a large order is split into multiple fills due to liquidity fragmentation:
- Each fill is charged based on its own notional value
- A $4,000 order split into 4 × $1,000 fills pays Tier 3 rate on each fill
- A $4,000 order filled atomically pays Tier 4 rate

### Fee Tiers (Configurable via `.env`)

| Fill Size | Fee | Example | Net Profit |
|-----------|-----|---------|------------|
| **$0.02 - $50** | $0.02 flat | $5 → $0.02 fee | +$0.01865 |
| **$50 - $500** | 5 bps (0.05%) | $100 → $0.05 fee | +$0.04865 |
| **$500 - $2,000** | 4 bps (0.04%) | $1000 → $0.40 fee | +$0.39865 |
| **$2,000+** | 3 bps (0.03%) | $5000 → $1.50 fee | +$1.49865 |

### Order Minimums

| Order Type | Minimum | Rationale |
|------------|---------|-----------|
| **Buy** | $5.00 | Ensures meaningful orders |
| **Sell** | $0.02 | Equals flat fee; allows exiting dust positions |

### Fee Calculation Logic

```typescript
// Fee calculated per fill based on fill notional
function calculateTakerFee(fillNotional: number): number {
  const FLAT_FEE = 0.02;
  
  if (fillNotional < 50) {
    return FLAT_FEE;
  } else if (fillNotional < 500) {
    return Math.max(fillNotional * 0.0005, FLAT_FEE); // 5 bps
  } else if (fillNotional < 2000) {
    return fillNotional * 0.0004; // 4 bps
  } else {
    return fillNotional * 0.0003; // 3 bps
  }
}
```

---

## 3. Transaction Cost Breakdown

### Per-Trade Costs (Covered by Taker Fee)

| Operation | Instruction | Transactions | Gas Cost |
|-----------|-------------|--------------|----------|
| Opening Trade | `execute_match` | 1 | ~$0.00135 |
| Closing Trade | `execute_close` | 1 | ~$0.00135 |

**Note:** Each trade is ONE atomic transaction that includes:
- USDC transfers (user → vault)
- Position updates (shares credited)
- Fee transfer to fee recipient

### Per-Market Costs (Protocol Operational)

| Operation | Instruction | When | Gas Cost |
|-----------|-------------|------|----------|
| Initialize Market | `initialize_market` | Market creation | ~$0.00135 |
| Activate Market | `activate_market` | Strike price set | ~$0.00135 |
| Resolve Market | `resolve_market` | At expiry | ~$0.00135 |
| Settle Position | `settle_position` | Per winner | ~$0.00135 |
| Close Market | `close_market` | Reclaim rent | ~$0.00135 |

---

## 4. Profitability Analysis

### Per-Fill Profitability

| Fill Size | Fee Revenue | Gas Cost | **Net Profit** | Margin |
|-----------|-------------|----------|----------------|--------|
| $0.02 (min sell) | $0.02 | $0.00135 | **+$0.01865** | 1382% |
| $5.00 (min buy) | $0.02 | $0.00135 | **+$0.01865** | 1382% |
| $50 | $0.02 | $0.00135 | **+$0.01865** | 1382% |
| $100 (5 bps) | $0.05 | $0.00135 | **+$0.04865** | 3604% |
| $500 (4 bps) | $0.20 | $0.00135 | **+$0.19865** | 14715% |
| $2,000 (3 bps) | $0.60 | $0.00135 | **+$0.59865** | 44344% |

**All tiers are profitable!** ✓

### Daily Volume Projections

| Daily Volume | Settlements | Gas Cost | Fee Revenue | **Net Profit** |
|--------------|-------------|----------|-------------|----------------|
| $10,000 | ~200 | ~$0.27 | ~$30 | **~$30** |
| $50,000 | ~1,000 | ~$1.35 | ~$125 | **~$124** |
| $100,000 | ~2,000 | ~$2.70 | ~$230 | **~$227** |
| $500,000 | ~10,000 | ~$13.50 | ~$1,050 | **~$1,036** |
| $1,000,000 | ~20,000 | ~$27.00 | ~$2,000 | **~$1,973** |

*Assumes average order size ~$50 (weighted toward flat fee tier), with MM batching active.*

---

## 5. Anti-Dusting Protection

### The Problem

Without minimums, malicious users could "dust" the relayer by submitting many tiny orders, forcing gas expenditure without generating revenue.

### The Solution

1. **Minimum Buy: $5.00** - Prevents buy-side dusting
2. **Minimum Sell: $0.02** - Equals flat fee; allows exiting any position
3. **Flat Fee: $0.02** - Ensures profitability on ALL orders

Even the smallest possible order ($0.02 sell) generates profit:
- Fee: $0.02
- Gas: $0.00135
- **Profit: $0.01865**

### Trapped Position Scenario (Solved)

**Problem:** User buys $10 worth of contracts, price drops to $3 value → can't sell (below $5 min).

**Solution:** Sell minimum is $0.02, not $5. User can always exit:
- Sell $3 worth → pay $0.02 flat fee → receive $2.98

---

## 6. MM Batched Settlement

**Status: ✅ IMPLEMENTED** (see `matching.service.ts`)

When a user order matches against multiple MM quotes, we aggregate into a single on-chain transaction.

### How it Works

```typescript
// apps/api/src/services/matching.service.ts
private aggregateMmFills(fills: Fill[]): Fill[] {
  // Groups fills by taker order + MM user
  // Calculates weighted average price
  // Returns single aggregated fill
}
```

### Impact

| Scenario | Without Batching | With Batching |
|----------|------------------|---------------|
| $100 order vs 100 MM quotes | 100 txs × $0.00135 = $0.135 | 1 tx = $0.00135 |
| **Savings** | - | **99% reduction** |

---

## 7. Implementation Status

### Completed ✅
- [x] Tiered fee structure (flat + percentage tiers)
- [x] Minimum buy/sell validation
- [x] MM fill batching
- [x] Configurable gas cost via `.env`

### Future Optimizations
- [ ] Dynamic gas cost based on real-time SOL price feed
- [ ] User-to-User fill batching (queue fills until threshold)
- [ ] Priority fee optimization based on network congestion

---

## 8. On-Chain Fee Validation

The Solana contract validates fees passed by the relayer to prevent under/over-charging.

### Contract Constants (`packages/contracts/programs/degen-terminal/src/state.rs`)

```rust
/// Minimum taker fee in USDC (6 decimals: 20000 = $0.02)
pub const MIN_TAKER_FEE: u64 = 20_000;
```

### Validation Logic (`execute_match.rs`, `execute_close.rs`)

```rust
// Fee must be at least MIN_TAKER_FEE ($0.02)
require!(taker_fee >= MIN_TAKER_FEE, DegenError::FeeTooLow);

// Fee cannot exceed taker_fee_bps% of notional (max 5% = 500 bps in GlobalState)
require!(taker_fee <= max_fee.max(MIN_TAKER_FEE), DegenError::FeeTooHigh);
```

### How It Works

1. **Backend calculates fee** using tiered structure in `fee.service.ts`
2. **Backend passes fee** as parameter to `execute_match`/`execute_close`
3. **Contract validates** fee is within bounds before executing
4. **Contract charges** the relayer-specified fee

This ensures:
- Relayer can't under-charge (fee >= $0.02)
- Relayer can't over-charge (fee <= GlobalState.taker_fee_bps% of notional)
- Fee tiers are enforced off-chain but protected on-chain

### Updating Minimum Fee

The minimum fee is a constant in the contract. To change it:
1. Update `MIN_TAKER_FEE` in `state.rs`
2. Rebuild and redeploy the contract

---

## 9. Code Locations

| Component | File | Function |
|-----------|------|----------|
| Fee config | `apps/api/src/config.ts` | `config.flatFeeUsd`, `config.feeTiers` |
| Fee calculation | `apps/api/src/services/fee.service.ts` | `calculateTakerFee()` |
| Order validation | `apps/api/src/routes/orders.ts` | Min notional checks |
| MM batching | `apps/api/src/services/matching.service.ts` | `aggregateMmFills()` |
| On-chain settlement | `apps/api/src/lib/anchor-client.ts` | `executeMatch()`, `executeClose()` |
| On-chain validation | `packages/contracts/.../execute_match.rs` | `MIN_TAKER_FEE` validation |
| Min fee constant | `packages/contracts/.../state.rs` | `MIN_TAKER_FEE = 20_000` |

---

*Last updated: January 2026*
