# Known Issues, Limitations & Future Improvements

This document tracks bugs, known limitations, and planned improvements for the Degen Terminal platform.

---

## Table of Contents

1. [Known Limitations](#known-limitations)
2. [Fixed Bugs](#fixed-bugs)
3. [Future Improvements](#future-improvements)

---

## Known Limitations

### L1: execute_close User-to-User Matching

**Status:** Known Limitation  
**Priority:** Low  
**Affects:** Peer-to-peer trading

**Issue:** The current `execute_close` instruction only works correctly when:
- MM is the counterparty (virtual liquidity)
- Both parties are CLOSING positions (offsetting shares)

**Does NOT work for:**
- User A closing (sell) + User B opening (buy limit)

**Why:**
1. User B pays User A directly for shares via execute_close
2. User B gets shares but deposits NO collateral into market vault
3. User A's original collateral is stuck in vault (no shares to claim it)
4. At settlement, vault is underfunded for User B's payout

**Solution needed:** A hybrid smart contract instruction that:
1. Releases closer's collateral from vault → closer
2. Opener deposits new collateral → vault
3. Shares transfer: closer → opener

**Current workaround:** All opening trades route through `execute_match` with MM as counterparty. MM provides sufficient liquidity for v1.

---

### L2: Liquidation Settles Naturally for Complex Cases

**Status:** Known Limitation  
**Priority:** Medium  
**Affects:** Leverage liquidations

**Issue:** Some edge cases in liquidation may skip on-chain close and let positions settle naturally when market resolves.

**When this happens:**
- On-chain close fails due to account state issues
- Position remains on-chain until market settlement

**Impact:** Accounting may be slightly delayed but eventually resolves correctly.

---

## Fixed Bugs

### B1: NO Position Liquidation Price Conversion (Fixed)

**Date Fixed:** 2026-01-12  
**Affected:** Leverage liquidations for NO positions

**Issue:** When liquidating NO positions, we passed YES price to `execute_close` instead of NO price.

**Symptom:** 
- DB calculated correct proceeds using `1 - executionPrice`
- On-chain used raw `executionPrice` (YES price)
- Result: MM overpaid, user underpaid on liquidation

**Fix:** Convert price before passing to execute_close:
```typescript
const closePrice = side === 'NO' 
  ? (1 - executionPrice)  // Convert YES→NO price
  : executionPrice;
```

**Location:** `apps/api/src/jobs/liquidation-checker.ts`

---

### B2: Liquidation Fee Too Low (Fixed)

**Date Fixed:** 2026-01-12  
**Affected:** Leverage liquidations

**Issue:** Passed `takerFee: 0` to execute_close, but smart contract requires minimum $0.02 fee.

**Fix:** Added `MIN_LIQUIDATION_FEE = 0.02` for liquidation closes.

**Location:** `apps/api/src/jobs/liquidation-checker.ts`

---

### B3: NO Liquidation Price Display (Fixed)

**Date Fixed:** 2026-01-12  
**Affected:** Frontend liquidation price display

**Issue:** For NO positions, liquidation price was displayed as YES price instead of NO price.

**Fix:** Corrected `liquidationPriceNo()` in margin.service.ts to return actual NO liquidation price.

---

### B4: Leveraged P&L Percentage (Fixed)

**Date Fixed:** 2026-01-12  
**Affected:** Frontend positions display

**Issue:** P&L percentage showed price return instead of leveraged return on margin.

**Fix:** For leveraged positions, calculate `pnlPercent = (pnl / marginDeposited) * 100`

**Location:** `apps/web/src/components/trading/Positions.tsx`

---

### B5: Share Precision Mismatch - InsufficientShares (Fixed)

**Date Fixed:** 2026-01-12  
**Affected:** Leverage liquidation close

**Issue:** Liquidation close failed with "InsufficientShares" error even though position had shares.

**Root cause:** Backend calculated shares (e.g., 480.769231) with `Math.round()`, but smart contract used floor rounding, resulting in 1 microshare less (480.769230). When trying to sell 480.769231 shares from a position with only 480.769230, the contract rejected it.

**Fix:** 
1. Floor shares to 6 decimals when storing in margin account
2. Floor shares when reading for liquidation

```typescript
// Floor to match on-chain SHARE_MULTIPLIER = 10^6
const shares = Math.floor(params.shares * 1_000_000) / 1_000_000;
```

**Location:** 
- `apps/api/src/services/margin.service.ts` (createMarginAccount)
- `apps/api/src/jobs/liquidation-checker.ts` (liquidation loop)

---

### B6: Liquidation Causing Bad Debt (Fixed)

**Date Fixed:** 2026-01-12  
**Affected:** Leverage liquidations

**Issues:**
1. Execution price used MM orderbook bid (e.g., $0.40) instead of market price ($0.405) or liquidation price ($0.4175)
2. Penalty calculated on entry position value ($500), not remaining equity (~$14)

**Result:** Every liquidation generated bad debt and returned $0 to users.

**Fixes:**
1. Execute liquidation at **liquidation price**, not orderbook price - guarantees solvency
2. Calculate penalty as **2% of remaining equity**, not position value

**New Math (for 10x, $50 margin, 3% maintenance):**
```
At liquidation price:
- Proceeds: $463.89
- Loan repay: $450.00
- Remaining equity: $13.89
- Penalty (2% of equity): $0.28
- Returned to user: $13.61 (~27% of margin) ✓
```

**Location:**
- `apps/api/src/jobs/liquidation-checker.ts` (execution price)
- `apps/api/src/services/margin.service.ts` (penalty calculation)

---

## Future Improvements

### F1: On-Chain Margin Accounts (v2)

**Priority:** Medium  
**Complexity:** High

Move margin tracking on-chain for full DeFi-native experience:
- Margin accounts as PDAs
- On-chain liquidation logic
- Reduced trust assumptions

**See:** `docs/LEVERAGE.md` Section 14 - Option 2 analysis

---

### F2: Cross-Market Margin

**Priority:** Low  
**Complexity:** Medium

Allow margin from one position to cover another position's requirements.

**Current:** Each leveraged position requires isolated margin.

---

### F3: Add Margin to Existing Positions

**Priority:** Medium  
**Complexity:** Low

Allow users to deposit additional margin to avoid liquidation.

**API endpoint exists:** `POST /margin/deposit` (needs frontend UI)

---

### F4: Liquidation Warning WebSocket

**Priority:** Medium  
**Complexity:** Low

Send WebSocket notifications when positions approach liquidation threshold (e.g., at 150% of maintenance margin).

---

### F5: Real-Time Liquidation Price on Trade Modal

**Priority:** Low  
**Complexity:** Low

Show estimated liquidation price before trade is placed, based on intended leverage and position size.

---

## Reporting Issues

When reporting new issues, include:
1. Steps to reproduce
2. Expected vs actual behavior
3. Relevant logs
4. Transaction signatures (if on-chain)

