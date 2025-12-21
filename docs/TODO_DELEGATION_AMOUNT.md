# Customizable Delegation Amount - TODO

## Problem
Currently, the delegation amount is hardcoded to 10,000 USDC. Users should be able to select how much USDC they want to delegate to the relayer for trading.

## Current Behavior
```javascript
// Default delegation amount: 10,000 USDC (in smallest units)
const DEFAULT_DELEGATION_AMOUNT = 10_000 * 1_000_000;
```

## Desired Behavior
- User can input/select delegation amount (e.g., $100, $500, $1000, $5000, custom)
- Show current delegated amount in UI
- Allow increasing/decreasing delegation
- Show warning if order amount exceeds delegated amount

## Implementation Plan

### Frontend Changes
1. **Update `useDelegation` hook:**
   - Already accepts `amount` parameter in `approve(amount)`
   - Need to expose `delegatedAmount` in UI (already available)

2. **Update TradeModal UI:**
   - Add delegation amount selector/input
   - Show current delegation status: "Delegated: $1,000 USDC"
   - Warning if order exceeds delegation

3. **New DelegationSettings component:**
   - Slider or preset buttons: $100, $500, $1000, $5000, Custom
   - Input for custom amount
   - "Update Delegation" button

### Files to Modify
- `apps/web/src/hooks/useDelegation.ts` - Already supports custom amounts
- `apps/web/src/app/market/[asset]/page.tsx` - Add delegation UI
- Consider new component: `apps/web/src/components/DelegationSettings.tsx`

## Priority
Medium - UX improvement, current 10k default works for testing

## Related
- Relayer delegation flow (implemented)
- SPL Token approve instruction


