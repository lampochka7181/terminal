# Selling Functionality Implementation Plan

**Status:** ✅ Backend Complete, Frontend Complete (Contract deployment pending)  
**Priority:** High  
**Complexity:** High (touches all layers)

## Overview

Currently, users can only **buy** YES/NO shares. This plan adds the ability to **sell** existing shares back to the market, enabling:
- Taking profit before market expires
- Cutting losses early
- Trading in/out of positions

## Current State Analysis

### Smart Contract (`execute_match.rs`)
- ✅ Handles opening trades (minting YES/NO pairs)
- ❌ No closing trade logic (selling existing shares) **[NEEDS DEPLOYMENT]**
- ❌ Open interest always increases, never decreases
- ❌ No collateral release to sellers

### Backend ✅ COMPLETE
- ✅ Order service supports ASK side (database schema)
- ✅ Position service has sell logic with realized PnL tracking
- ✅ Matching engine handles sell orders (ASK validation)
- ✅ Orderbook supports both BID and ASK sides
- ✅ `/user/positions/:marketAddress` endpoint added

### Frontend ✅ COMPLETE
- ✅ "Buy/Sell" buttons on market page via MarketPosition component
- ✅ Position display on market screen per timeframe
- ✅ TradeModal supports both buy and sell modes
- ✅ Positions component uses real API data (not mock)

---

## Trade Types in Prediction Markets

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TRADE TYPE MATRIX                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  BUYER (BID)           SELLER (ASK)           TRADE TYPE                    │
│  ────────────          ───────────            ──────────                    │
│  Wants YES             Has YES shares    →    CLOSING TRADE                 │
│  Wants YES             Has 0 YES shares  →    OPENING TRADE (mint pair)     │
│  Wants NO              Has NO shares     →    CLOSING TRADE                 │
│  Wants NO              Has 0 NO shares   →    OPENING TRADE (mint pair)     │
│                                                                              │
│  OPENING TRADE: Both parties deposit USDC, mint YES/NO pair                 │
│  CLOSING TRADE: Transfer existing shares, USDC goes to seller               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Example: Closing Trade

```
Alice owns 100 YES @ $0.40 avg entry
Current market: YES trading at $0.55

Alice: ASK 100 YES @ $0.55 (wants to sell)
Bob: BID 100 YES @ $0.55 (wants to buy)

MATCH:
├── Alice transfers 100 YES shares → Bob
├── Bob transfers $55 USDC → Alice
├── Vault unchanged (collateral stays for Bob's position)
├── Open interest unchanged (shares transferred, not burned)
└── Alice realizes +$15 profit

Result:
├── Alice: 0 YES, +$55 USDC received, +$15 PnL
├── Bob: 100 YES, -$55 USDC spent
└── Market: same open interest
```

### Example: Opening Trade (Current Implementation)

```
Carol: BID 100 YES @ $0.40 (no position)
Dave: ASK 100 YES @ $0.40 (no YES shares - wants to short)

MATCH (Opening):
├── Carol deposits $40 USDC → Vault
├── Dave deposits $60 USDC → Vault (NO cost = $1 - $0.40)
├── Mint 100 YES → Carol
├── Mint 100 NO → Dave
└── Open interest +100

Result:
├── Carol: 100 YES, -$40
├── Dave: 100 NO, -$60
├── Vault: +$100
└── Market: +100 open interest
```

---

## Implementation Plan

### Phase 1: Smart Contract Changes

**File:** `packages/contracts/programs/degen-terminal/src/instructions/execute_match.rs`

#### 1.1 Add Trade Type Detection

```rust
enum TradeType {
    Opening,   // Both parties mint new shares
    Closing,   // Seller transfers existing shares to buyer
    Mixed,     // Partial close + partial open (advanced)
}

fn determine_trade_type(
    seller_position: &UserPosition,
    outcome: Outcome,
    size: u64
) -> TradeType {
    let seller_shares = match outcome {
        Outcome::Yes => seller_position.yes_shares,
        Outcome::No => seller_position.no_shares,
    };
    
    if seller_shares >= size {
        TradeType::Closing
    } else if seller_shares == 0 {
        TradeType::Opening
    } else {
        TradeType::Mixed  // Partial close
    }
}
```

#### 1.2 Closing Trade Logic

```rust
// For CLOSING trades:
// - Seller already has shares, buyer pays USDC
// - No new shares minted
// - USDC flows: buyer → seller (not vault)
// - Shares flow: seller → buyer
// - Open interest unchanged

fn execute_closing_trade(
    buyer: &mut UserPosition,
    seller: &mut UserPosition,
    outcome: Outcome,
    price: u64,
    size: u64,
) -> Result<()> {
    let cost = price * size / SHARE_MULTIPLIER;
    
    // Transfer shares: seller → buyer
    match outcome {
        Outcome::Yes => {
            seller.yes_shares -= size;
            buyer.yes_shares += size;
        }
        Outcome::No => {
            seller.no_shares -= size;
            buyer.no_shares += size;
        }
    }
    
    // Transfer USDC: buyer_wallet → seller_wallet (not through vault)
    // This requires additional accounts in the instruction
    
    Ok(())
}
```

#### 1.3 New Accounts Required

```rust
#[derive(Accounts)]
pub struct ExecuteMatch<'info> {
    // ... existing accounts ...
    
    /// Seller's wallet to receive USDC (for closing trades)
    /// Only needed when trade_type == Closing
    #[account(mut)]
    pub seller_usdc_receive: Option<Account<'info, TokenAccount>>,
}
```

### Phase 2: Backend Changes

**Files:**
- `apps/api/src/services/orderbook.service.ts`
- `apps/api/src/services/matching.service.ts`
- `apps/api/src/services/position.service.ts`

#### 2.1 Support ASK Orders in Orderbook

```typescript
// orderbook.service.ts
async addOrder(order: OrderInput): Promise<void> {
  const { marketId, outcome, side, price, size, userId } = order;
  
  if (side === 'ASK') {
    // Validate seller has enough shares
    const position = await positionService.getPosition(userId, marketId);
    const shares = outcome === 'YES' ? position?.yesShares : position?.noShares;
    
    if (!shares || parseFloat(shares) < size) {
      throw new Error('INSUFFICIENT_SHARES');
    }
  }
  
  // Add to Redis orderbook
  await this.redis.zadd(
    `orderbook:${marketId}:${outcome}:${side}`,
    price,
    JSON.stringify(order)
  );
}
```

#### 2.2 Matching Engine Updates

```typescript
// matching.service.ts
async matchOrder(takerOrder: Order): Promise<Match[]> {
  const matches: Match[] = [];
  
  // Find crossing orders on opposite side
  const oppositeSide = takerOrder.side === 'BID' ? 'ASK' : 'BID';
  const makerOrders = await this.orderbook.getOrders(
    takerOrder.marketId,
    takerOrder.outcome,
    oppositeSide
  );
  
  for (const makerOrder of makerOrders) {
    if (!this.pricesCross(takerOrder, makerOrder)) break;
    
    // Determine trade type
    const tradeType = await this.determineTradeType(makerOrder, takerOrder);
    
    const match = {
      maker: makerOrder,
      taker: takerOrder,
      price: makerOrder.price, // Maker price
      size: Math.min(makerOrder.remainingSize, takerOrder.remainingSize),
      tradeType,
    };
    
    matches.push(match);
  }
  
  return matches;
}
```

### Phase 3: Frontend Changes

#### 3.1 Position Display on Market Page

**File:** `apps/web/src/app/market/[asset]/page.tsx`

Add a `MarketPosition` component showing user's holdings:

```tsx
function MarketPosition({ marketAddress }: { marketAddress: string }) {
  const { positions } = useUser();
  const position = positions.find(p => p.marketAddress === marketAddress);
  
  if (!position || (position.yesShares === 0 && position.noShares === 0)) {
    return null;
  }
  
  return (
    <div className="bg-surface rounded-xl border border-border p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Your Position</h3>
        <span className={cn(
          'text-sm font-mono',
          position.unrealizedPnl >= 0 ? 'text-long' : 'text-short'
        )}>
          {position.unrealizedPnl >= 0 ? '+' : ''}${position.unrealizedPnl.toFixed(2)}
        </span>
      </div>
      
      <div className="grid grid-cols-2 gap-4">
        {position.yesShares > 0 && (
          <div className="bg-long/10 rounded-lg p-3">
            <div className="text-xs text-text-muted">ABOVE STRIKE</div>
            <div className="font-mono font-bold text-long">{position.yesShares}</div>
            <div className="text-xs text-text-muted">
              Avg: ${position.avgEntryYes?.toFixed(2)}
            </div>
            <button 
              onClick={() => onSell('YES', position.yesShares)}
              className="mt-2 w-full py-1.5 bg-short/20 hover:bg-short/30 text-short text-sm rounded-lg"
            >
              Sell
            </button>
          </div>
        )}
        
        {position.noShares > 0 && (
          <div className="bg-short/10 rounded-lg p-3">
            <div className="text-xs text-text-muted">BELOW STRIKE</div>
            <div className="font-mono font-bold text-short">{position.noShares}</div>
            <div className="text-xs text-text-muted">
              Avg: ${position.avgEntryNo?.toFixed(2)}
            </div>
            <button 
              onClick={() => onSell('NO', position.noShares)}
              className="mt-2 w-full py-1.5 bg-long/20 hover:bg-long/30 text-long text-sm rounded-lg"
            >
              Sell
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

#### 3.2 Sell Modal

**File:** `apps/web/src/app/market/[asset]/page.tsx` (update TradeModal)

Add sell mode to TradeModal:

```tsx
type TradeMode = 'BUY' | 'SELL';

function TradeModal({
  mode,  // NEW: 'BUY' or 'SELL'
  maxSellSize,  // NEW: max shares user can sell
  // ... existing props
}) {
  const isSelling = mode === 'SELL';
  
  // For selling, size is in contracts (not dollars)
  const [sellSize, setSellSize] = useState(maxSellSize?.toString() || '0');
  
  // Calculate sell proceeds
  const sellProceeds = parseFloat(sellSize) * price;
  
  return (
    <div>
      {isSelling ? (
        <>
          <h2>Sell {outcome === 'YES' ? 'ABOVE' : 'BELOW'} STRIKE</h2>
          
          {/* Contracts to sell */}
          <div>
            <label>Contracts to Sell</label>
            <input
              type="number"
              value={sellSize}
              onChange={(e) => setSellSize(e.target.value)}
              max={maxSellSize}
            />
            <button onClick={() => setSellSize(maxSellSize.toString())}>
              Sell All
            </button>
          </div>
          
          {/* Sell Summary */}
          <div>
            <div>Selling: {sellSize} contracts</div>
            <div>Price: ${price.toFixed(2)}</div>
            <div>Proceeds: ${sellProceeds.toFixed(2)}</div>
          </div>
          
          <button onClick={handleSell}>
            Sell {sellSize} {outcome}
          </button>
        </>
      ) : (
        // Existing buy UI
      )}
    </div>
  );
}
```

#### 3.3 Update useQuickOrder Hook

**File:** `apps/web/src/hooks/useOrder.ts`

```typescript
export function useQuickOrder() {
  // ... existing code
  
  const sellOrder = async (params: {
    marketAddress: string;
    outcome: 'yes' | 'no';
    size: number;
    price: number;
    expiryTimestamp: number;
  }) => {
    setIsPlacing(true);
    
    try {
      const result = await api.placeOrder({
        marketAddress: params.marketAddress,
        side: 'ask',  // Selling = ASK
        outcome: params.outcome,
        orderType: 'limit',
        price: params.price,
        size: params.size,
        expiryTimestamp: params.expiryTimestamp,
      });
      
      return result;
    } catch (error) {
      setError(error.message);
      return null;
    } finally {
      setIsPlacing(false);
    }
  };
  
  return { placeOrder, sellOrder, isPlacing, error, clearError };
}
```

---

## File Changes Summary

### Smart Contract
| File | Changes |
|------|---------|
| `execute_match.rs` | Add trade type detection, closing trade logic, USDC routing |
| `state.rs` | May need position size tracking improvements |

### Backend
| File | Changes |
|------|---------|
| `orderbook.service.ts` | Validate sell orders have shares, add to ASK side |
| `matching.service.ts` | Match ASK vs BID, determine trade type |
| `position.service.ts` | Update positions for closing trades |
| `anchor-client.ts` | Build execute_match with trade type args |

### Frontend
| File | Changes |
|------|---------|
| `market/[asset]/page.tsx` | Add MarketPosition component, sell buttons, update TradeModal |
| `hooks/useOrder.ts` | Add sellOrder function |
| `hooks/useUser.ts` | Filter positions by market |
| `components/trading/Positions.tsx` | Connect to real data instead of mock |
| `stores/userStore.ts` | Add position-by-market selector |

---

## Testing Plan

1. **Unit Tests**
   - Trade type detection (opening vs closing)
   - Price validation for sell orders
   - Position balance checks

2. **Integration Tests**
   - Full sell flow: position → sell order → match → settlement
   - Mixed trades (partial closing + partial opening)
   - Edge cases: selling more than owned, selling at expiry

3. **E2E Tests**
   - User buys YES, price goes up, user sells for profit
   - User buys NO, price goes down, user sells for loss
   - Multiple partial sells

---

## Estimated Effort

| Component | Effort | Status |
|-----------|--------|--------|
| Smart Contract | 3-4 days | ❌ Pending |
| Backend | 2-3 days | ✅ Complete |
| Frontend | 2-3 days | ✅ Complete |
| Testing | 2 days | ⏳ Pending contract |
| **Total** | **9-12 days** | |

---

## Open Questions

1. **Market Orders for Selling**: Should we support market sell orders (sell at best bid)?
2. **Partial Sells**: Support selling partial position or only full position?
3. **Stop Loss**: Future feature to auto-sell at certain price?

---

## Related Docs

- [Architecture](./ARCHITECTURE.md) - Collateral model section 12
- [Market Maker](./MARKET_MAKER.md) - MM already handles both sides

