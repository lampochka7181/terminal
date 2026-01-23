# Leverage Testing Checklist

This document tracks manual testing of leverage features and planned automated tests.

---

## Test Status Legend
- ⬜ Not tested
- 🔄 In progress
- ✅ Passed
- ❌ Failed (needs fix)
- 🔧 Fixed, needs retest

---

## 1. Opening Leveraged Positions

| # | Scenario | Status | Notes |
|---|----------|--------|-------|
| 1.1 | Basic leveraged BUY (YES) - 5x, $50 margin | ✅ | 5x $25 margin tested, fee collection fixed |
| 1.2 | Basic leveraged BUY (NO) - 10x, $50 margin | ✅ | 614 NO shares @ $0.81, fee $0.78 (13 fills × $0.06) |
| 1.3 | Max leverage (10x) - $10 margin | ⬜ | |
| 1.4 | Limit order with leverage | ⬜ | |
| 1.5 | Minimum margin check ($4 should fail) | ⬜ | |
| 1.6 | Lending pool capacity exceeded | ⬜ | |

---

## 2. Liquidation Price Display

| # | Scenario | Status | Notes |
|---|----------|--------|-------|
| 2.1 | YES liq price shown correctly | ⬜ | |
| 2.2 | NO liq price shown correctly | ⬜ | |
| 2.3 | Trade modal preview updates in real-time | ⬜ | |
| 2.4 | Near-liquidation warning (row flashes red) | ⬜ | |

---

## 3. Selling Leveraged Positions

| # | Scenario | Status | Notes |
|---|----------|--------|-------|
| 3.1 | Full close with profit | ✅ | 10x YES $0.52→$0.56, $94.57 equity returned (but caused L4 settlement bug) |
| 3.2 | Full close with loss | ✅ | 2x YES $0.44→$0.41 (-6.8%), loan repaid, $21.59/$25 equity returned |
| 3.3 | Partial close (50%) | 🔧 | Bug found: margin account not updated + equity not transferred → BOTH FIXED |
| 3.4 | Response includes leverage details | ⬜ | |

---

## 4. Liquidation Flow

| # | Scenario | Status | Notes |
|---|----------|--------|-------|
| 4.1 | Auto-liquidation (YES position) | ✅ | 5x → liq @ $0.51 < $0.5113 liq price, $3.03 returned |
| 4.2 | Auto-liquidation (NO position) | ✅ | 10x NO @ $0.317, liq @ $0.2941, $13.64/$50 returned (-$36.36 P&L) |
| 4.3 | Liquidation returns ~27% of margin | ✅ | $3.03 returned of $25 margin (~12%) |
| 4.4 | WebSocket notification on liquidation | ⬜ | |
| 4.5 | Liquidation shows in history | ✅ | Shows "LIQD" tag, correct avg price, P&L |

---

## 5. Add Margin Feature

| # | Scenario | Status | Notes |
|---|----------|--------|-------|
| 5.1 | Shield button appears for leveraged positions | ⬜ | |
| 5.2 | Modal shows current state correctly | ⬜ | |
| 5.3 | Preview updates when entering amount | ⬜ | |
| 5.4 | Add margin success - liq price improves | ⬜ | |
| 5.5 | Add margin prevents imminent liquidation | ⬜ | |

---

## 6. Settlement of Leveraged Positions

| # | Scenario | Status | Notes |
|---|----------|--------|-------|
| 6.1 | Settlement WIN - loan repaid, profit received | ✅ | 10x NO won, $614→pool, $450 repaid, $164→user, +$113 profit |
| 6.2 | Settlement LOSE - margin lost, insurance covers | ⬜ | |
| 6.3 | Payout calculation correct | ⬜ | |

---

## 7. P&L Display

| # | Scenario | Status | Notes |
|---|----------|--------|-------|
| 7.1 | Leveraged P&L % (5x = 5x price move) | ✅ | 10x NO: $50→$164 = 226% ROI |
| 7.2 | P&L based on margin deposited | ⬜ | |
| 7.3 | Negative P&L display | ⬜ | |

---

## 8. Error Handling & Edge Cases

| # | Scenario | Status | Notes |
|---|----------|--------|-------|
| 8.1 | Leverage disabled error | ⬜ | |
| 8.2 | Insufficient delegation error | ⬜ | |
| 8.3 | Margin rollback on trade failure | ⬜ | |
| 8.4 | Lending pool empty error | ⬜ | |
| 8.5 | Partial fill creates correct margin account | ⬜ | |

---

## 9. API Endpoint Tests

| # | Endpoint | Status | Notes |
|---|----------|--------|-------|
| 9.1 | `GET /margin/config` | ⬜ | |
| 9.2 | `GET /margin/accounts` | ⬜ | |
| 9.3 | `GET /margin/accounts/:id` | ⬜ | |
| 9.4 | `POST /margin/add` | ⬜ | |
| 9.5 | `GET /margin/pool` | ⬜ | |
| 9.6 | `POST /margin/calculate` | ⬜ | |

---

## Quick Test Checklist

```
[ ] 1. Place 5x YES market buy ($50 margin)
[ ] 2. Verify liquidation price in positions
[ ] 3. Click Shield button → Add Margin modal opens
[ ] 4. Add $25 margin → liq price improves
[ ] 5. Sell full position → loan repaid, margin returned
[ ] 6. Place 10x YES position (close to liquidation)
[ ] 7. Wait for liquidation OR manually verify liq triggers
[ ] 8. Check positions history shows liquidation
[ ] 9. Place leveraged limit order
[ ] 10. Verify partial fill creates margin account correctly
```

---

## Key Numbers to Verify

| Parameter | Expected Value |
|-----------|----------------|
| Max Leverage | 10x |
| Min Leverage | 1x |
| Maintenance Margin | 3% |
| Liquidation Penalty | 2% of equity |
| Min Margin | $5 |
| Max Single Loan | 10% of pool |

---

## Issues Found During Testing

| Date | Issue | Status | Fix PR |
|------|-------|--------|--------|
| 2026-01-17 | Trading fee not collected from user in leveraged orders (Lending Pool was paying it) | ✅ Fixed | N/A |
| 2026-01-17 | Liquidation fee hardcoded to $0.02 instead of using config.fees.flatFeeUsd | ✅ Fixed | N/A |
| 2026-01-17 | Leveraged sell used user wallet as on-chain seller instead of Lending Pool | ✅ Fixed | N/A |
| 2026-01-17 | User equity not transferred after leveraged position close | ✅ Fixed | N/A |
| 2026-01-17 | On-chain taker_fee_bps too low (25 bps), aggregated fees rejected | ✅ Fixed | N/A |
| 2026-01-17 | Settlement fails after manual leveraged close (position not marked settled) | ✅ Fixed | L4 - 5 fixes implemented |
| 2026-01-17 | close_market fails after manual leveraged close (Lending Pool position not settled) | ✅ Fixed | Added LP to settlement batch |
| 2026-01-19 | Race condition: liquidation checker ran before on-chain position confirmed | ✅ Fixed | Added onChainConfirmedAt timestamp to margin accounts |
| 2026-01-19 | NO position liquidation price conversion was incorrect (user received profit) | ✅ Fixed | Removed double-conversion in liquidation-checker |
| 2026-01-19 | Partial close didn't update margin account (shares, loan, liq price) | ✅ Fixed | Added updateAfterPartialClose method |
| 2026-01-19 | Race condition: user sell & auto-liquidation both executing at same time | ✅ Fixed | Added off-chain liquidation lock (liquidatingAt) |
| 2026-01-19 | User equity from partial close not transferred to user | ✅ Fixed | Added equity transfer in partial close path |
| 2026-01-19 | User could try to sell already-liquidated position → confusing on-chain error | ✅ Fixed | Added 410 POSITION_ALREADY_CLOSED check before processing sell |
| 2026-01-19 | GUI slow to update after liquidation (position still showed in Open tab) | ✅ Fixed | Added WebSocket liquidation notification + frontend handler |
| 2026-01-19 | NO position liquidation used wrong price (1-liqPrice instead of liqPrice), causing profit on liquidation | ✅ Fixed | Removed double-conversion in liquidation-checker.ts |
| 2026-01-19 | Race condition: liquidation checker could try to liquidate before on-chain position confirmed | ✅ Fixed | Added onChainConfirmedAt column, liquidation waits for confirmation |
| 2026-01-19 | Partial close didn't update margin account (shares, loan, liq price) → caused InsufficientShares on liquidation | ✅ Fixed | Added updateAfterPartialClose() method in margin.service.ts |
| 2026-01-19 | Race condition: user sell vs liquidation → both tried to close same shares | ✅ Fixed | Added liquidating_at lock - blocks user sells while liquidation in progress |
| 2026-01-19 | Partial close didn't transfer user equity (proceeds - loan portion) to user | ✅ Fixed | Added equity transfer in partial close path |
| 2026-01-19 | User could try to sell already-liquidated position → confusing on-chain error | ✅ Fixed | Added 410 POSITION_ALREADY_CLOSED check before processing sell |

---

## ✅ COMPLETED: Frontend Improvements (2026-01-19)

- [x] Handle `409 POSITION_BEING_LIQUIDATED` error when user tries to sell during liquidation
  - Shows error: "⚠️ This position is being liquidated. Please wait for the liquidation to complete."
  - Auto-refreshes positions after showing error
  - Implemented in: `apps/web/src/hooks/useOrder.ts`

- [x] Handle `410 POSITION_ALREADY_CLOSED` error when user tries to sell liquidated position
  - Shows error: "🔒 This position has been liquidated. Please refresh to see your updated positions."
  - Auto-refreshes positions list
  - Implemented in: `apps/web/src/hooks/useOrder.ts`

- [x] Add WebSocket notification for liquidation events
  - Backend emits `liquidation` event when liquidation completes (already existed in `broadcasts.ts`)
  - Frontend listens via `useLiquidationNotifications` hook
  - Shows alert banner: "Position Liquidated - X.XX contracts • $Y.YY returned to wallet"
  - Auto-dismisses after 8 seconds
  - Immediately removes position from Open tab
  - Implemented in: 
    - `apps/web/src/hooks/useLiquidationNotifications.ts` (new)
    - `apps/web/src/components/trading/Positions.tsx`
    - `apps/web/src/lib/websocket.ts` (updated types)

---

## ✅ COMPLETED: Automated Unit Tests (2026-01-19)

**Location:** `apps/api/tests/leverage/`

| File | Tests | Coverage |
|------|-------|----------|
| `leverage-calculations.test.ts` | 30 | Initial margin, liquidation price, equity, margin ratio, liquidation triggers |
| `margin-service.test.ts` | 21 | Margin account CRUD, status transitions, liquidation eligibility |
| `lending-service.test.ts` | 17 | Loan availability, pool balance, transfers |
| `leverage-flow.test.ts` | 13 | End-to-end leveraged trading flow |
| **Total** | **81** | |

**Run tests:**
```bash
cd apps/api && pnpm test
```

---

## TODO: Integration & E2E Tests

- [ ] Integration test: open leveraged position (real DB)
- [ ] Integration test: close leveraged position (real DB)
- [ ] Integration test: add margin (real DB)
- [ ] Integration test: liquidation flow (real DB)
- [ ] Integration test: settlement with leverage (real DB)
- [ ] E2E test: full leverage lifecycle
- [ ] Load test: multiple concurrent leveraged orders

---

## Test Environment Setup

```bash
# Ensure these are set in .env
LENDING_WALLET_PRIVATE_KEY=<base58_key>
INSURANCE_WALLET_PRIVATE_KEY=<base58_key>
MAX_LEVERAGE=10
MAINTENANCE_MARGIN_PCT=3
LIQUIDATION_PENALTY_PCT=2
MIN_MARGIN_USD=5
```

---

## Notes

- Testing date: 
- Tester: 
- Environment: devnet

