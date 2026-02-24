# Known Issues, Limitations & Future Improvements

This document tracks bugs, known limitations, and planned improvements for the Degen Terminal platform.

---

## Table of Contents

1. [Known Limitations](#known-limitations)
2. [Fixed Bugs](#fixed-bugs)
3. [Future Improvements](#future-improvements)
   - [F6: Performance & Horizontal Scaling](#f6-performance--horizontal-scaling) ⭐ NEW

---

## Known Limitations

### L1: ~~execute_close User-to-User Matching~~ (RESOLVED - Not an Issue)

**Status:** ✅ Not an issue - original analysis was incorrect  
**Priority:** N/A  
**Affects:** N/A

**Original (incorrect) concern:** Thought that "User A closing + User B opening via execute_close" would leave the vault underfunded.

**Why this was wrong:** The vault is a **pool**, not individually tracked deposits.

```
Example: User A bought YES @ $0.48, sells to User C @ $0.55

Trade 1 (execute_match): A buys YES from MM
├── A deposits $0.48 → gets 1 YES
├── MM deposits $0.52 → gets 1 NO
├── Vault: $1.00, Open Interest: 1

Trade 2 (execute_close): A sells YES to C
├── A transfers 1 YES → C
├── C pays $0.55 → A (direct p2p)
├── Vault: $1.00 (unchanged)
├── Open Interest: 1 (unchanged)

At settlement (YES wins):
├── C owns 1 YES → gets $1.00 from vault
├── Vault needs: $1.00, Vault has: $1.00 ✅
```

**Key insight:** The invariant `Vault = Open Interest × $1.00` is maintained because:
- `execute_close` doesn't change open interest (shares transfer, not mint/burn)
- The vault collateral backs the SHARES, not the original depositors
- It doesn't matter WHO deposited - only that total collateral = total outstanding contracts

**Conclusion:** The `execute_close` model for "closer + opener" is economically sound. Any implementation issues would be bugs, not design flaws.

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

### L3: Partial Fill Margin Over-Collection (Leveraged Orders)

**Status:** Known Bug  
**Priority:** Medium  
**Affects:** Leveraged market orders that partially fill due to orderbook exhaustion

**Issue:** For leveraged orders, margin is calculated based on FULL order amount and collected BEFORE we know how much will actually fill. If orderbook is exhausted and order only partially fills, excess margin is stuck in Lending Pool.

**Example (from real logs 2026-01-17):**
```
User places $25 order with 5x leverage:
├── marginRequired = $5.00 (based on $25)
├── loanAmount = $20.00 (based on $25)
├── Orderbook exhausted after 55 fills
├── Only $16.30 filled, $8.70 unfilled
├── Margin COLLECTED: $5.00 + fee  ← Based on $25
├── Margin NEEDED: $3.26 + fee     ← Based on $16.30
├── STUCK IN LENDING POOL: ~$1.74
```

**Root Cause:**
1. `orders.ts` calculates `marginRequired` based on full `orderNotional`
2. This is passed to `processMarketOrderByDollar` as `order.marginAmount`
3. Each fill is created with `marginAmount: order.marginAmount` (the full amount)
4. `executeLeveragedMatch` collects `params.marginAmount` BEFORE on-chain execution
5. Margin account is created with correct `actualMargin` based on filled amount
6. **Gap between collected and needed is never refunded**

**Why It Happens:**
- Orderbook exhaustion (MM can't replenish fast enough)
- Very low-priced orders that exhaust thin orderbooks
- High volatility causing MM to pull quotes

**Non-Leveraged Orders: ✅ Not Affected**
- User pays on-chain per-fill for exactly what they receive
- Unfilled dollars simply aren't spent

**Potential Fixes:**

1. **Collect margin AFTER matching (Recommended)**
   - Match against orderbook FIRST (no margin collected yet)
   - Calculate actual margin based on `result.totalSpent`
   - THEN collect margin and execute on-chain
   - **Pros:** Clean, no excess collection
   - **Cons:** More refactoring, changes execution order

2. **Refund excess after matching**
   - Keep current flow but add refund logic after order completes
   - `excess = expectedMargin - actualMargin; if (excess > 0.01) refund()`
   - **Pros:** Minimal code changes
   - **Cons:** Extra on-chain tx for refund (fees)

3. **Limit leveraged orders to limit-only**
   - Disable market orders for leveraged positions
   - Only allow limit orders where fill amount is known upfront
   - **Pros:** Simplest, no partial fill issue
   - **Cons:** Worse UX for leveraged traders

**Related Files:**
- `apps/api/src/routes/orders.ts` (margin calculation)
- `apps/api/src/services/matching.service.ts` (fill creation with marginAmount)
- `apps/api/src/services/transaction.service.ts` (margin collection)

---

### L4: MM Metrics P&L Approximation for Mixed Counterparties

**Status:** Known Limitation  
**Priority:** Low  
**Affects:** MM performance tracking accuracy

**Issue:** The MM metrics calculation uses zero-sum principle: `MM P&L = -(sum of counterparty profits)`. However, if a user traded with BOTH MM and other users, their settlement profit includes P&L from both sources, making the MM P&L slightly inaccurate.

**Example:**
```
Market has 3 participants: MM, User A, User B

Trades:
├── MM sells 100 YES to User A @ $0.50
├── User B sells 50 YES to User A @ $0.48 (user-to-user limit order)

At settlement (YES wins):
├── User A profit: -$2 (from 150 shares, mixed sources)
├── User B profit: +$26 (from selling to User A)
├── MM actual P&L: +$50 (from 100 shares sold to User A)

Current calculation:
├── MM counterparties: [User A] (traded with MM)
├── User A settlement profit: -$2
├── Calculated MM P&L: -(-$2) = +$2  ❌ Should be +$50
```

**Why It Happens:**
- Settlement profit is calculated per-user, not per-trade
- A user's profit includes gains/losses from ALL their trades
- We can't isolate "profit from MM trades" vs "profit from user trades"

**Current Behavior:**
- MM metrics are accurate when MM is the sole liquidity provider
- Inaccurate when users trade with each other via limit orders

**Potential Fix (Future):**
Track per-trade realized P&L instead of per-user settlement profit:
```typescript
// For each trade where MM was counterparty:
// Calculate what MM gained/lost on that specific trade
// Sum those per-trade P&Ls for accurate MM metrics
```

**Workaround:** In practice, MM provides ~95%+ of liquidity, so the approximation is usually close enough for monitoring purposes.

**Location:** `apps/api/src/jobs/position-settler.ts` (`calculateAndStoreMmMetrics`)

---

### L5: Leveraged Position Settlement After Manual Close (FIXED)

**Status:** ✅ Fixed  
**Priority:** High  
**Affects:** Position settlement after manually closing leveraged positions

**Issue:** When a user manually closes a leveraged position (sells before market expiry), the DB position record is not marked as settled. When the market later resolves, the position-settler tries to settle an already-closed on-chain position, causing failures.

**Timeline of Bug:**
```
1. User opens 10x leveraged YES position
2. Lending Pool buys shares on-chain (position PDA created)
3. User manually closes position (sells)
4. execute_close runs → Lending Pool's on-chain position CLOSED
5. Margin account closed in DB ✅
6. User equity transferred ✅
7. DB position record NOT marked as settled ❌
8. Market resolves
9. Position-settler finds "unsettled" position in DB
10. Tries settle_positions on-chain → AccountNotInitialized error
11. Market marked as "archived" with null pubkey
12. Subsequent attempts → "Non-base58 character" errors
```

**Error Messages:**
```
AccountNotInitialized - position account not initialized
Non-base58 character (after market marked archived)
```

**Impact:** 
- Settlement fails for all positions in the batch
- Market gets stuck in RESOLVED state
- MM position also fails to settle (batched with broken one)

**Potential Fixes:**

1. **Mark position as settled when leveraged close completes**
   - In `orders.ts`, after successful leveraged close, update position `settled = true`
   - Prevents position-settler from attempting settlement

2. **Filter out positions with closed margin accounts from settlement**
   - In `position-settler.ts`, check if position has associated margin account
   - If margin account status = 'CLOSED', skip that position

3. **Check on-chain position exists before settlement**
   - Before calling `settle_positions`, verify the position PDA exists
   - Skip positions where on-chain account is already closed

4. **Handle batch failures gracefully**
   - Don't let one invalid position fail the entire batch
   - Process positions individually or filter invalid ones first
   - Better error recovery for partial batch failures

**Workaround:** ~~Don't manually close leveraged positions~~ No longer needed - fixed!

**Fixes Implemented (2026-01-17):**

1. ✅ **Mark position as settled after leveraged close**
   - Location: `apps/api/src/routes/orders.ts`
   - After on-chain equity transfer succeeds, mark position `status = 'SETTLED'`
   - Follows "on-chain first, DB after" principle

2. ✅ **Skip positions with CLOSED margin accounts**
   - Location: `apps/api/src/jobs/position-settler.ts`
   - Query ALL margin accounts (not just OPEN)
   - If margin account is CLOSED, skip settlement (already handled)

3. ✅ **Handle batch failures gracefully**
   - Location: `apps/api/src/jobs/position-settler.ts`
   - If batch settlement fails, retry positions individually
   - One bad position no longer kills the whole batch
   - Positions with `AccountNotInitialized` are marked as settled

4. ✅ **Settle Lending Pool's on-chain position**
   - Location: `apps/api/src/jobs/position-settler.ts`
   - After market resolves, check if any margin accounts exist for that market
   - If yes, include Lending Pool wallet in settlement batch
   - This closes Lending Pool's on-chain position account (even with 0 shares)
   - Ensures `settled_positions == total_positions` on-chain, allowing market to close

**Related Files:**
- `apps/api/src/routes/orders.ts` (leveraged close handling)
- `apps/api/src/jobs/position-settler.ts` (settlement logic)
- `apps/api/src/services/position.service.ts` (position updates)

---

## Fixed Bugs

### B13: Token-2022 Migration for YES/NO Mint Rent Recovery (Fixed)

**Date Fixed:** 2026-02-07  
**Affected:** All V2 markets - YES/NO mint rent was previously unrecoverable

**Issue:** YES/NO token mints used the standard SPL Token program which has no `CloseAccount` instruction for mints. This leaked ~0.003 SOL per market (2 mints × ~0.0015 SOL each) in unrecoverable rent.

**Fix:** Migrated YES/NO share token mints from SPL Token to **Token-2022** with the **MintCloseAuthority** extension. The market PDA is set as the close authority, enabling rent recovery when markets are closed/finalized.

**Changes:**
| File | Change |
|------|--------|
| `initialize_market_v2.rs` | Manual Token-2022 mint creation with MintCloseAuthority extension (replaces Anchor `init` with `mint::`) |
| `initialize_market_v2.rs` (finalize) | Same for NO mint |
| `execute_match_v2.rs` | Uses `token_interface::mint_to` with `share_token_program` (Token-2022) for YES/NO minting |
| `execute_close_v2.rs` | Uses `token_interface::transfer_checked` with `share_token_program` for YES/NO transfers |
| `close_market_v2.rs` | Closes YES/NO mints via `token_interface::close_account` with MintCloseAuthority |
| `finalize_market_v2.rs` | Same mint close + vault close |
| `anchor-client.ts` | Passes `TOKEN_2022_PROGRAM_ID` for share token operations, computes Token-2022 ATAs |

**Rent Recovery After Fix (per market):**
| Account | Rent (~) | Recovered? |
|---------|----------|------------|
| USDC Vault (ATA) | ~0.002 SOL | Yes |
| MarketV2 PDA | ~0.003 SOL | Yes |
| YES Mint (Token-2022) | ~0.0015 SOL | **Yes** |
| NO Mint (Token-2022) | ~0.0015 SOL | **Yes** |
| **Total** | **~0.009 SOL** | **100%** |

**Note:** Deployed to devnet 2026-02-07. Program ID: `5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk`

---

### B12: V2 Market PDA Rent Not Recovered on Close/Finalize (Fixed)

**Date Fixed:** 2026-02-07  
**Affected:** All V2 markets - rent leaked on close/finalize

**Issue:** `close_market_v2` and `finalize_market_v2` only closed the USDC vault, but left the MarketV2 PDA open on-chain. This leaked ~0.003 SOL per market.

**Fix:** Added Anchor `close = rent_recipient` constraint to both instructions. The MarketV2 PDA is now automatically closed after the handler completes.

**Note:** Superseded by B13 (Token-2022 migration) which also recovers YES/NO mint rent.

**Location:**
- `packages/contracts/programs/degen-terminal/src/instructions/close_market_v2.rs`
- `packages/contracts/programs/degen-terminal/src/instructions/finalize_market_v2.rs`

---

### B11: FEE_RECIPIENT Undefined Crash in executeCloseV2 (Fixed)

**Date Fixed:** 2026-02-07  
**Affected:** All V2 closing trades (selling positions)

**Issue:** `buildExecuteCloseV2Instruction()` in `anchor-client.ts` referenced an undefined `FEE_RECIPIENT` constant instead of using `config.feeRecipient` (the pattern used by all other V2 methods). This caused a runtime crash (`ReferenceError: FEE_RECIPIENT is not defined`) whenever a V2 closing trade was attempted.

**Root Cause:** Copy-paste error during V2 implementation. The `buildExecuteMatchV2Instruction` method correctly used:
```typescript
const feeRecipientWallet = config.feeRecipient
  ? new PublicKey(config.feeRecipient)
  : this.relayerKeypair.publicKey;
```

But `buildExecuteCloseV2Instruction` incorrectly used:
```typescript
const feeRecipientPk = new PublicKey(FEE_RECIPIENT); // undefined!
```

**Fix:** Replaced with the same `config.feeRecipient` pattern used in other V2 methods.

**Location:** `apps/api/src/lib/anchor-client.ts` (buildExecuteCloseV2Instruction)

---

### B10: DB Pool Exhaustion Cascade During Market Lifecycle (Fixed)

**Date Fixed:** 2026-01-19  
**Affected:** Backend stability during market create/activate/resolve/settle events

**Issue:** Market lifecycle events (create, activate, resolve, settle) triggered cache invalidation which caused frontend polling to hit the database directly. With multiple connected clients, this created a "thundering herd" that exhausted the connection pool, causing backend crashes.

**Cascade Timeline:**
```
T+0ms:   Market activates → clearMarketsCache()
T+10ms:  Cache empty → Next frontend poll hits DB
T+50ms:  Multiple clients poll → 20+ concurrent DB queries
T+100ms: Pool exhausted (waiting > 50)
T+200ms: Keeper jobs skip due to HIGH LOAD SHIELD
T+500ms: New queries queue, timeouts begin
T+2000ms: Backend unresponsive, potential crash
```

**Root Causes:**
1. **Cache invalidation storm**: Every market state change cleared cache
2. **Frontend polling without backpressure**: `useMarkets` hook polled every 10s AND refetched on WebSocket events
3. **No request coalescing**: 10 identical `/markets` requests = 10 DB queries
4. **Insufficient pool size**: 75 connections too few for concurrent load
5. **Keeper jobs competing**: Jobs added DB pressure during recovery

**Fixes Implemented:**

1. **Database Index** - Partial index for common query pattern:
   ```sql
   CREATE INDEX idx_markets_not_settled_created 
   ON markets(created_at DESC) WHERE status != 'SETTLED';
   ```

2. **Request Coalescing** - `/markets` endpoint batches identical requests:
   ```typescript
   // Requests within 100ms share same DB query
   const coalesceKey = `markets:${JSON.stringify(query.data)}`;
   const markets = await coalesceRequest(coalesceKey, () => 
     marketService.getMarkets(query.data)
   );
   ```

3. **Circuit Breaker** - Self-healing system that:
   - Monitors pool health every 1 second
   - Trips at 50 waiting connections (OPEN state)
   - Returns 503 to shed load
   - Gradually recovers (HALF_OPEN → CLOSED)
   - Auto-retries on frontend with exponential backoff

4. **Increased Pool Size** - 75 → 100 connections

5. **Frontend Debounced Refetch** - WebSocket-triggered refetch now debounced with random jitter (500-1000ms)

6. **Extended Cache TTL** - 10s → 15s to reduce DB pressure

**Self-Healing Flow:**
```
Cascade Detected → Circuit Breaker OPEN
├── New requests get 503 + Retry-After header
├── Frontend auto-retries with exponential backoff
├── Keeper jobs skip (HIGH LOAD SHIELD)
├── Pool drains (waiting count drops)
├── 10s cooldown → HALF_OPEN (allow 5 test requests)
├── Success → CLOSED (normal operation)
└── Failure → Back to OPEN (extend cooldown)
```

**Monitoring:**
```bash
GET /debug/circuit-breaker    # View state and metrics
POST /debug/circuit-breaker/recover  # Force recovery (ops)
GET /health  # Includes circuitBreaker.state in response
```

**Location:**
- `apps/api/src/lib/circuit-breaker.ts` (new)
- `apps/api/src/routes/markets.ts` (request coalescing + circuit breaker)
- `apps/api/src/services/market.service.ts` (internal circuit breaker)
- `apps/api/src/db/index.ts` (pool size increase)
- `apps/web/src/hooks/useMarkets.ts` (debounced refetch)
- `apps/web/src/lib/api.ts` (503 auto-retry)

---

### B9: FeeTooHigh Error on Aggregated Fills (Fixed)

**Date Fixed:** 2026-01-18  
**Affected:** On-chain execution of orders with many small fills

**Issue:** When backend aggregated multiple small fills into one on-chain transaction, it summed all individual fees. But the smart contract validated against the AGGREGATED notional, causing "FeeTooHigh" errors.

**Example:**
```
55 fills × $0.02 min fee = $1.10 total fee sent
Aggregated notional = $16.30
At 2% max: max_fee = $0.33 allowed
$1.10 > $0.33 → FeeTooHigh!
```

**Smart Contract Validation (before fix):**
```rust
let max_fee = taker_notional * taker_fee_bps / 10_000;
require!(taker_fee <= max_fee.max(MIN_TAKER_FEE), DegenError::FeeTooHigh);
```

**Impact:** 
- On-chain execution failed completely
- User's position never created on-chain
- DB position showed shares that didn't exist
- Settlement later failed with AccountNotInitialized

**Fix:** Removed FeeTooHigh validation from smart contract. The relayer is trusted and the fee aggregation for multiple fills can legitimately exceed per-trade percentage limits. Kept FeeTooLow check to ensure minimum protocol revenue.

**Location:**
- `packages/contracts/programs/degen-terminal/src/instructions/execute_match.rs`
- `packages/contracts/programs/degen-terminal/src/instructions/execute_close.rs`

**Note:** Requires smart contract redeployment.

---

### B8: Keeper Job Thundering Herd at Startup (Fixed)

**Date Fixed:** 2026-01-17  
**Affected:** Backend startup - DB pool exhaustion within seconds of boot

**Issue:** All keeper jobs fired immediately at startup, creating a thundering herd of DB queries that exhausted the connection pool before any user activity.

**Symptoms:**
```
[15:00:39] WARN (system): Database connection pool high load: total=67, idle=19, waiting=11
```

This happened ~13 seconds after server start, before any trading.

**Root Cause:**

1. **8 keeper jobs all started simultaneously:**
   - Liquidation Checker (every 1s)
   - Market Resolver (every 2s)
   - Market Activator (every 5s)
   - Position Settler (every 5s)
   - Order Expirer (every 10s)
   - Market Closer (every 20s)
   - Market Creator (every 30s)
   - Lending Pool Sync (every 60s)

2. **`clearMarketsCache()` used `redis.keys()`:**
   - O(n) scan operation called after EVERY market update
   - Multiple market creations at startup = multiple slow scans

3. **Market Creator pre-creates multiple markets at boot:**
   - Each market = on-chain tx + DB insert + cache clear
   - 3+ markets created in first few seconds

**Fixes:**

1. **Added startup delays to stagger jobs:**
   - Lending Pool Sync: 1s (needs to init early)
   - Market Activator: 2s
   - Market Resolver: 3s
   - Liquidation Checker: 3s
   - Position Settler: 4s
   - Market Creator: 5s
   - Order Expirer: 6s
   - Market Closer: 10s

2. **Slowed down aggressive intervals:**
   - Liquidation Checker: 1s → 2s (still fast enough)
   - Market Resolver: 2s → 3s
   - Market Closer: 20s → 30s

3. **Replaced `redis.keys()` with direct key deletion:**
   - Pre-computed list of known cache key patterns
   - Debounced to batch rapid updates (100ms window)
   - No more O(n) scans

4. **Optimized Market Resolver:**
   - Early exit when no markets to process
   - Only query CLOSED markets if no expired OPEN ones

**Location:** 
- `apps/api/src/jobs/index.ts` (startup delays, intervals)
- `apps/api/src/services/market.service.ts` (cache clearing)
- `apps/api/src/jobs/market-resolver.ts` (early exit optimization)

---

### B7: Frontend Request Flood Causing DB Connection Pool Exhaustion (Fixed)

**Date Fixed:** 2026-01-17  
**Affected:** Backend stability - complete freezes under normal usage

**Issue:** The frontend's `handleFill` and `handleSettlement` in `userStore.ts` triggered cascading API requests that overwhelmed the database connection pool, causing the entire backend to freeze.

**Symptoms:**
```
Database connection pool high load: total=100, idle=0, waiting=899
[KEEPER] Skipping "Liquidation Checker" - DB load high (waiting=899)
[KEEPER] Skipping "Position Settler" - DB load high (waiting=899)
```

**Root Cause (multiple compounding issues):**

1. **handleFill/handleSettlement double-fetched:**
   - Each event triggered `fetchAllImmediate()` immediately
   - Then triggered another `fetchAllImmediate()` after 1.5-2 seconds
   - Each `fetchAllImmediate()` = 5 parallel API calls

2. **No coordination between events:**
   - Fill + Settlement events often fire close together
   - Result: 20+ API calls from a single trade

3. **React StrictMode doubled effects:**
   - In development, all useEffects run twice
   - Result: 40+ API calls from a single trade

4. **Duplicate fetchAll calls:**
   - Both `useAuth` and `useUser` hooks called `fetchAll()` on authentication
   - Result: 10 extra API calls per auth

5. **Multiple WebSocket auth messages:**
   - Multiple components mounting caused multiple `ws.authenticate()` calls
   - Each reconnect triggered data refetches

**Calculation for single trade (worst case):**
```
Fill immediate:        5 calls
Fill delayed (1.5s):   5 calls
Settlement immediate:  5 calls
Settlement delayed:    5 calls
StrictMode 2x:         x2
--------------------------
Total:                 40 API calls → 40 DB connections
```

With multiple trades or WebSocket reconnects, this quickly exceeded the 100 connection pool limit.

**Fixes:**

1. **Added global request throttle** (`MIN_FETCH_INTERVAL = 2000ms`):
   - Coalesces rapid `fetchAllImmediate()` calls into single batches
   - Prevents connection pool exhaustion

2. **Cancel previous delayed refetch on new event:**
   - Only ONE delayed refetch outstanding at a time
   - Prevents cascading fetches from multiple events

3. **Removed duplicate fetchAll from useUser:**
   - `useAuth` already fetches user data after sign-in
   - `useUser` no longer duplicates this

**Location:** 
- `apps/web/src/stores/userStore.ts` (throttling + event handlers)
- `apps/web/src/hooks/useUser.ts` (removed duplicate fetch)

---

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

### F6: Performance & Horizontal Scaling

**Priority:** High  
**Complexity:** High  
**Target:** 50K+ concurrent users, $2M+ volume per 15-minute market

**Full documentation:** [`docs/PERFORMANCE_SCALING.md`](./PERFORMANCE_SCALING.md)

**Summary of bottlenecks identified:**

| Component | Current Limit | Target | Gap |
|-----------|---------------|--------|-----|
| DB Connections | 75 | 150+ | 2x |
| WebSocket Broadcast | O(n) per message | O(subscribers) | 50x |
| Settlement (50K positions) | ~5 min | <60 sec | 5x |
| Relayer Wallets | 1 (sequential) | 3+ (parallel) | 3x |

**Implementation Phases:**

| Phase | Description | Effort | Status |
|-------|-------------|--------|--------|
| 1 | Quick Wins (pool size, batch size) | 1-2 days | 📋 Planned |
| 2 | WebSocket Redesign (indexing, batching, Redis Pub/Sub) | 3-5 days | 📋 Planned |
| 3 | Database Optimization (read replicas, caching, indexes) | 2-3 days | 📋 Planned |
| 4 | Settlement Parallelization (multi-wallet, parallel batches) | 3-5 days | 📋 Planned |
| 5 | Horizontal Scaling (Kubernetes, distributed locks) | 1-2 weeks | 📋 Planned |
| 6 | On-Chain Optimization (batched settlement instruction) | 2-4 weeks | 📋 Planned |

**Quick wins (can do immediately):**
1. Increase `DB_POOL_MAX` from 75 → 150
2. Increase `SETTLEMENT_BATCH_SIZE` from 20 → 50
3. Add server-side request coalescing
4. Implement WebSocket subscription indexing

---

## Reporting Issues

When reporting new issues, include:
1. Steps to reproduce
2. Expected vs actual behavior
3. Relevant logs
4. Transaction signatures (if on-chain)

