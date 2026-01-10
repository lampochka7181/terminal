# Market Maker Spread Economics

## Overview

This document analyzes the profit potential of different spread settings for the Market Maker (MM) bot, and outlines the technical changes required to support sub-cent (3-decimal) pricing.

---

## Current System: 2-Decimal Precision (Cents)

The system currently uses **cent-level tick sizes** ($0.01 increments).

| Spread Value | In Cents | Supported? |
|--------------|----------|------------|
| `0.04` | 4¢ | ✅ Yes |
| `0.02` | 2¢ | ✅ Yes |
| `0.01` | 1¢ | ✅ Yes (minimum) |
| `0.002` | 0.2¢ | ❌ No (sub-cent) |

---

## Spread Economics

### How MM Captures Spread

For a spread `S` around fair value `F`:
- MM posts: **Bid @ (F - S/2)** / **Ask @ (F + S/2)**
- When someone buys at ask and someone sells at bid, MM earns `S` per contract
- Example: Fair value = $0.50, Spread = $0.02
  - Bid: $0.49, Ask: $0.51
  - Round-trip profit: $0.02 per contract

### Profit Formula

```
Daily Profit = (Daily Volume) × (MM Market Share) × (Spread / 2) / (Avg Contract Price)
```

- **MM Market Share**: ~80% (MM provides most liquidity)
- **Spread / 2**: Conservative estimate (half-spread per side)
- **Avg Contract Price**: ~$0.50 (varies by market)

---

## Profit at Different Volume Levels

### Spread = $0.002 (0.2¢ / Sub-cent)

| Daily Volume | MM Share | MM Volume | Round Trips | Daily Profit | Monthly |
|--------------|----------|-----------|-------------|--------------|---------|
| $10,000 | 80% | $8,000 | 4,000 | **$8** | $240 |
| $50,000 | 80% | $40,000 | 20,000 | **$40** | $1,200 |
| $100,000 | 80% | $80,000 | 40,000 | **$80** | $2,400 |
| $500,000 | 80% | $400,000 | 200,000 | **$400** | $12,000 |
| $1,000,000 | 80% | $800,000 | 400,000 | **$800** | $24,000 |

### Spread = $0.01 (1¢)

| Daily Volume | MM Share | MM Volume | Round Trips | Daily Profit | Monthly |
|--------------|----------|-----------|-------------|--------------|---------|
| $10,000 | 80% | $8,000 | 4,000 | **$40** | $1,200 |
| $50,000 | 80% | $40,000 | 20,000 | **$200** | $6,000 |
| $100,000 | 80% | $80,000 | 40,000 | **$400** | $12,000 |
| $500,000 | 80% | $400,000 | 200,000 | **$2,000** | $60,000 |
| $1,000,000 | 80% | $800,000 | 400,000 | **$4,000** | $120,000 |

### Spread = $0.02 (2¢)

| Daily Volume | MM Share | MM Volume | Round Trips | Daily Profit | Monthly |
|--------------|----------|-----------|-------------|--------------|---------|
| $10,000 | 80% | $8,000 | 4,000 | **$80** | $2,400 |
| $50,000 | 80% | $40,000 | 20,000 | **$400** | $12,000 |
| $100,000 | 80% | $80,000 | 40,000 | **$800** | $24,000 |
| $500,000 | 80% | $400,000 | 200,000 | **$4,000** | $120,000 |
| $1,000,000 | 80% | $800,000 | 400,000 | **$8,000** | $240,000 |

### Spread = $0.04 (4¢) - Current Default

| Daily Volume | MM Share | MM Volume | Round Trips | Daily Profit | Monthly |
|--------------|----------|-----------|-------------|--------------|---------|
| $10,000 | 80% | $8,000 | 4,000 | **$160** | $4,800 |
| $50,000 | 80% | $40,000 | 20,000 | **$800** | $24,000 |
| $100,000 | 80% | $80,000 | 40,000 | **$1,600** | $48,000 |
| $500,000 | 80% | $400,000 | 200,000 | **$8,000** | $240,000 |
| $1,000,000 | 80% | $800,000 | 400,000 | **$16,000** | $480,000 |

---

## Spread Comparison Summary

| Spread | Per Contract | $100K/day | $1M/day | Min Volume for $1K/day |
|--------|--------------|-----------|---------|------------------------|
| **0.002** | $0.002 | $80 | $800 | ~$1.25M |
| **0.01** | $0.01 | $400 | $4,000 | ~$250K |
| **0.02** | $0.02 | $800 | $8,000 | ~$125K |
| **0.04** | $0.04 | $1,600 | $16,000 | ~$62K |

---

## The Tradeoff

| Tight Spread (0.002) | Wide Spread (0.04) |
|---------------------|-------------------|
| Better UX (tighter prices) | Worse UX |
| More volume (attracts traders) | Less volume |
| Lower profit per trade | Higher profit per trade |
| Higher competition risk | More defensible margin |
| Needs very high volume | Works at lower volume |
| Requires 3-decimal precision | Current system supports |

### Recommendation by Stage

| Stage | Daily Volume | Recommended Spread | Rationale |
|-------|--------------|-------------------|-----------|
| **Launch** | <$10K | 0.04-0.06 | Need margin to cover costs |
| **Growth** | $10K-$100K | 0.02-0.04 | Balance UX and profit |
| **Scale** | $100K-$1M | 0.01-0.02 | Compete on UX |
| **Mature** | >$1M | 0.002-0.01 | Maximize volume |

---

## Industry Benchmarks

| Platform | Typical Spread | Daily Volume | Notes |
|----------|---------------|--------------|-------|
| **Polymarket** | 1-2¢ | $5-20M | Largest prediction market |
| **Kalshi** | 2-5¢ | $1-5M | Regulated US market |
| **Binance Futures** | 0.01% | $50B+ | Crypto derivatives |
| **Degen Terminal** | 4¢ (current) | TBD | Our platform |

---

## Technical Requirements for Sub-Cent Pricing

To support spreads like 0.002 (3-decimal precision), the following changes are required:

### 1. MM Bot (`apps/api/src/bot/mm-bot-v2.ts`)

Change price rounding from 2 to 3 decimals in 4 places:

```typescript
// Current (2 decimals):
price: Math.round(bidPrice * 100) / 100

// Updated (3 decimals):
price: Math.round(bidPrice * 1000) / 1000
```

**Lines to update:** 384, 397, 427, 442

### 2. Frontend Price Display

Update `toFixed(2)` to `toFixed(3)` in ~69 places across:

- `apps/web/src/components/trading/SingleOrderbook.tsx`
- `apps/web/src/components/trading/TradeModal.tsx`
- `apps/web/src/components/trading/TradingPanel.tsx`
- `apps/web/src/components/trading/Orderbook.tsx`
- `apps/web/src/components/trading/Positions.tsx`
- `apps/web/src/components/trading/RecentTrades.tsx`
- `apps/web/src/components/trading/MarketPosition.tsx`

**Alternative:** Create a `formatPrice()` utility that checks magnitude:
```typescript
function formatPrice(price: number): string {
  // Show 3 decimals only when needed
  if (price % 0.01 !== 0) {
    return price.toFixed(3);
  }
  return price.toFixed(2);
}
```

### 3. Orderbook Service

Verify Redis sorted sets handle 3-decimal prices correctly (likely no changes needed - prices are stored as floats).

### 4. Database Schema

Current `DECIMAL(10,6)` for prices already supports 6 decimals - no changes needed.

### 5. Environment Variables

Add/update in `.env`:
```bash
MM_BASE_SPREAD=0.002      # New tighter spread
MM_MIN_SPREAD=0.001       # Minimum spread (half of base)
MM_LEVEL_SPACING=0.001    # Space between price levels
```

---

## Implementation Checklist

- [ ] Update MM bot price rounding (4 places)
- [ ] Create `formatPrice()` utility function
- [ ] Update frontend price displays (~69 places)
- [ ] Add new env vars for spread configuration
- [ ] Test orderbook with 3-decimal prices
- [ ] Update seed scripts for testing
- [ ] Update API documentation

---

## Notes

- The on-chain contract already uses 6-decimal precision (`price * 1_000_000`)
- Sub-cent pricing mainly affects the off-chain orderbook and UI
- Consider making precision configurable rather than hardcoding 3 decimals
- Monitor gas costs - tighter spreads mean more frequent requotes

---

*Last updated: January 2026*

