# Relayer Economics & Profitability Plan

## 1. The Break-Even Analysis
The relayer pays a fixed transaction fee for every on-chain settlement, while revenue is a variable percentage of the trade size.

### Key Metrics (Updated)
*   **Relayer Gas Cost:** ~0.0001 SOL (~$0.015 at $150/SOL)
*   **Protocol Revenue:** 0.20% Taker Fee ($0.002 per $1.00 traded)
*   **Break-even Trade Size:** **$7.50 Notional** ($7.50 * 0.002 = $0.015)
*   **Enforced Minimum:** **$10.00 Notional** (Ensures ~$0.005 profit minimum)

**Status:** Any trade with a notional value below $15.00 results in a net loss for the relayer.

---

## 2. Identified Vulnerabilities

### A. The "Small Fill" Attack (Fragmentation)
A user (Taker) places a $100 order that matches against 100 small $1.00 resting orders (Makers). 
*   **Revenue:** $0.10
*   **Current Cost:** $1.50 (100 transactions)
*   **Result:** **-$1.40 Loss**

### B. Long-Shot Dusting
Users buying/selling outcomes at $0.01 price. 
*   A $10.00 trade at $0.01 price only generates **$0.01** in fees.
*   **Result:** **-$0.05 Loss**

---

## 3. Mitigation Strategy: MM Batched Settlement
Since the Market Maker (MM) bot is internal and trusted, we can batch multiple MM fills into a single on-chain transaction without impacting the user's experience.

### How it works:
1.  **Off-Chain Match:** The matching engine finds 10 fills for a single User Order against 10 different MM quotes.
2.  **Aggregation:** Instead of firing 10 `execute_match` calls, the backend calculates:
    *   `Total Match Size = Sum of all fills`
    *   `Weighted Average Price = Sum(Price * Size) / Total Size`
3.  **On-Chain Settlement:** Submit **ONE** `execute_match` transaction using the aggregated values.

### Profitability Impact:
For the same $100 order matched against 100 MM quotes:
*   **Current Cost:** $1.50
*   **New Cost:** $0.015
*   **Savings:** **99% reduction in gas costs.**

---

## 4. Implementation TODOs

### Phase 1: Immediate Protection (API Layer)
- [ ] **Enforce Minimum Notional Value**: Add a check in `POST /orders` to reject any order where `Price * Size < $5.00` (initial safety buffer).
- [ ] **Dynamic Break-even Check**: Create a helper to calculate break-even based on current SOL price and gas.

### Phase 2: MM Batching (Matching Engine)
- [ ] **Refactor `MatchingService.matchOrder`**: Modify to return grouped fills where MM counterparts are pre-aggregated.
- [ ] **Weighted Average Price Logic**: Ensure precision is maintained (6 decimals) when calculating average entry prices for MM.
- [ ] **Update `TransactionService`**: Ensure it can handle the single aggregate call for multiple logical fills.

### Phase 3: General Batching (Deferred / User-to-User)
- [ ] **Pending Fills Queue**: Queue User-to-User matches and only fire when notional > $20 OR 30s timeout.
- [ ] **Settlement UI Status**: Add "Settling on-chain..." status to the UI so users understand why funds haven't hit their wallet yet.

---

## 5. Profitability Benchmarks
| Daily Volume | Current Est. Gas | Batched Est. Gas | Net Revenue (0.1%) |
| :--- | :--- | :--- | :--- |
| $100,000 | $15.00 | $1.50 | $100.00 |
| $1,000,000 | $150.00 | $15.00 | $1,000.00 |
| $10,000,000 | $1,500.00 | $150.00 | $10,000.00 |

