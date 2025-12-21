# Batched Settlement Optimization

**Status:** Planned (Low Priority)  
**Estimated Savings:** ~5% margin improvement  
**Complexity:** Medium  

## Overview

Currently, every trade fill triggers a separate `execute_match` on-chain transaction. This optimization would batch multiple fills into a single on-chain settlement when an order is fully filled.

## Current Flow (Per-Fill Settlement)

```
User Order: Buy 100 YES @ $0.55

Fill 1: MM sells 40 @ $0.52  → execute_match tx ($0.0012)
Fill 2: MM sells 35 @ $0.53  → execute_match tx ($0.0012)
Fill 3: MM sells 25 @ $0.54  → execute_match tx ($0.0012)
                              ─────────────────────────
                              Total: 3 txs = $0.0036
```

## Proposed Flow (Batched Settlement)

```
User Order: Buy 100 YES @ $0.55

Fill 1: MM sells 40 @ $0.52  → DB only (instant)
Fill 2: MM sells 35 @ $0.53  → DB only (instant)
Fill 3: MM sells 25 @ $0.54  → DB only (instant)
Order Filled → execute_match tx with avg price $0.527
                              ─────────────────────────
                              Total: 1 tx = $0.0012
```

**Savings: 66% reduction in execute_match gas costs**

## Cost Analysis

### Current Unit Economics ($50 Taker Order)

| Scenario | Fills | Gas Cost | Fee Revenue | Profit | Margin |
|----------|-------|----------|-------------|--------|--------|
| Best case | 1 | $0.0012 | $0.05 | $0.0488 | 97.6% |
| Typical | 3 | $0.0036 | $0.05 | $0.0464 | 92.8% |
| Fragmented | 5 | $0.0060 | $0.05 | $0.0440 | 88.0% |

### With Batched Settlement

| Scenario | Fills | Gas Cost | Fee Revenue | Profit | Margin |
|----------|-------|----------|-------------|--------|--------|
| Any | 1 tx | $0.0012 | $0.05 | $0.0488 | 97.6% |

### Daily Savings at Scale

| Daily Volume | Current Gas | Batched Gas | Savings |
|--------------|-------------|-------------|---------|
| $100,000 | $7.20 | $2.40 | $4.80/day |
| $1,000,000 | $72.00 | $24.00 | $48.00/day |
| $10,000,000 | $720.00 | $240.00 | $480.00/day |

## Implementation Plan

### Backend Changes

1. **Pending Fills Queue**
   - Store fills in DB with `settled = false`
   - Track pending settlement per order

2. **Settlement Triggers**
   - Order fully filled → Settle immediately
   - Partial fill + 30s timeout → Settle partial
   - Market closing → Force settle all pending

3. **Average Price Calculation**
   - Weighted average: `Σ(price × size) / Σ(size)`
   - Store individual fill prices in DB for audit

### Smart Contract Changes

None required - existing `execute_match` works with any price.

### Data Model

```typescript
// New fields in orders table
interface Order {
  // ... existing fields
  pendingFills: number;      // Count of unsettled fills
  pendingNotional: number;   // Total unsettled notional
  avgFillPrice: number;      // Weighted average price
}

// New pending_fills table (optional)
interface PendingFill {
  orderId: string;
  price: number;
  size: number;
  timestamp: Date;
  settled: boolean;
}
```

## Trade-offs

### Pros
- 50-80% reduction in execute_match transactions
- Faster UX (off-chain fills are instant)
- Lower gas costs at scale

### Cons
- Settlement delay (mitigated by timeout)
- Increased relayer trust (users already trust relayer)
- Pending fills lost if relayer crashes before settlement
- More complex state management

## Why Low Priority?

1. **Margins already excellent** - 93%+ profit margin on trading
2. **Bigger cost problem elsewhere** - Market creation rent (~$490/day) dwarfs execute_match costs (~$7/day at $100K volume)
3. **Rent recovery implemented** - `close_market` instruction recovers 99% of costs
4. **Complexity vs benefit** - Medium implementation effort for ~5% margin improvement

## When to Implement

Consider implementing when:
- Daily volume exceeds $1M consistently
- Gas costs become >10% of fee revenue
- Need to optimize for high-frequency trading

## Related

- [Market Creation Costs](./TODO.md) - Rent recovery is higher priority
- [Settlement Speed](./API_SPEC.md) - Current 5s settlement is acceptable


