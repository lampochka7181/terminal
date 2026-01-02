# Ethereum Feasibility Analysis

This document analyzes whether the Degen Terminal architecture can be ported to the Ethereum network, comparing the trade-offs between Solana, Ethereum L1, and Ethereum L2s.

---

## 1. Executive Summary

The **hybrid order model** (trustless user orders + trusted MM orders + on-chain settlement) is conceptually platform-agnostic. However, Ethereum's higher gas costs and slower block times require significant architectural modifications.

| Verdict | Platform | Feasibility |
|---------|----------|-------------|
| ❌ | Ethereum L1 | Not economically viable |
| ✅ | Ethereum L2 (Arbitrum, Base) | Viable with modifications |
| ✅ | ZK Rollups (StarkEx, zkSync) | Viable, more complex |

---

## 2. Platform Comparison

### 2.1 Cost Structure

| Operation | Solana | Ethereum L1 | Arbitrum/Base | StarkEx |
|-----------|--------|-------------|---------------|---------|
| **User order creation** | ~$0.30 (rent, returnable) | $10-50+ | $0.05-0.50 | ~$0.01 |
| **Order cancellation** | ~$0.01 + rent return | $5-20 | $0.02-0.10 | ~$0.005 |
| **Settlement tx** | ~$0.015 | $5-20+ | $0.05-0.20 | ~$0.001 (batched) |
| **MM quote update** | FREE (off-chain) | FREE | FREE | FREE |

### 2.2 Performance Characteristics

| Metric | Solana | Ethereum L1 | Arbitrum | Base | StarkEx |
|--------|--------|-------------|----------|------|---------|
| **Block time** | 400ms | 12s | 250ms | 2s | N/A (off-chain) |
| **Finality** | ~400ms | ~15min (safe) | ~1 week (L1) | ~1 week (L1) | Immediate (L2) |
| **Throughput** | ~65K TPS | ~15-30 TPS | ~40K TPS | ~2K TPS | ~9K TPS |
| **Min viable timeframe** | 5m | 1h+ | 15m | 15m | 5m |

### 2.3 Trust Model Comparison

| Aspect | Current (Solana) | L2 (Optimistic) | ZK Rollup |
|--------|------------------|-----------------|-----------|
| **User order storage** | On-chain PDA (trustless) | Off-chain signed | Off-chain signed |
| **MM order storage** | Off-chain (trusted) | Off-chain (trusted) | Off-chain (trusted) |
| **Matching** | Off-chain (trusted) | Off-chain (trusted) | Off-chain (trusted) |
| **Settlement** | On-chain (trustless) | On-chain L2 (trustless) | ZK proof (trustless) |
| **Data availability** | Solana validators | L1 calldata | L1 calldata/DAC |

---

## 3. What Transfers Directly

These components work identically across platforms:

### ✅ Collateral Model (YES + NO = $1.00)
The fundamental invariant is platform-agnostic:
```
Total YES Shares = Total NO Shares = Open Interest
Vault Balance = Open Interest × $1.00
```

### ✅ MM Bot Off-Chain Quoting
Already off-chain, no changes needed. In fact, more important on Ethereum where on-chain MM orders would be prohibitively expensive.

### ✅ Matching Engine
Pure off-chain service - transfers directly.

### ✅ Keeper/Cron Jobs
Market creation, resolution, settlement batching - same pattern works.

### ✅ WebSocket Real-Time Updates
Frontend architecture unchanged.

### ✅ SIWS → SIWE Authentication
Sign-In With Solana becomes Sign-In With Ethereum (same pattern).

---

## 4. What Requires Modification

### 4.1 User Order Storage

**Current (Solana):** Each user order creates an on-chain PDA
```
Cost: ~0.002 SOL rent (~$0.30) - RETURNED when order fills/cancels
Security: Fully trustless - order exists on-chain
```

**Problem on Ethereum L1:**
```
Cost: ~$20+ gas - GONE forever (no rent return)
10 orders = $200+ (vs $3 on Solana)
```

**Solution: Off-Chain Signed Orders (EIP-712)**

Users sign order intents off-chain. The relayer holds these until matched, then settles on-chain.

```
┌─────────────────────────────────────────────────────────────────┐
│                    EIP-712 Order Intent                          │
├─────────────────────────────────────────────────────────────────┤
│  User signs structured data containing:                          │
│  - Market address                                                │
│  - Side (bid/ask)                                                │
│  - Outcome (yes/no)                                              │
│  - Price                                                         │
│  - Size                                                          │
│  - Expiry timestamp                                              │
│  - Nonce (replay protection)                                     │
│                                                                  │
│  Signature is verified on-chain during settlement                │
└─────────────────────────────────────────────────────────────────┘
```

**Trade-off:** Less trustless than on-chain PDAs. Relayer could theoretically:
- Censor orders (not include them)
- Front-run (see orders before execution)

**Mitigation:** 
- Time-locked order reveals
- Commit-reveal schemes
- Decentralized sequencer (future)

### 4.2 Smart Contract Architecture

**Current (Solana/Anchor):**
```rust
#[account]
pub struct Market { ... }

#[account]  
pub struct UserPosition { ... }

#[account]
pub struct Order { ... }  // On-chain PDAs
```

**Ethereum (Solidity):**
```solidity
contract DegenTerminal {
    struct Market { ... }
    struct Position { ... }
    
    mapping(bytes32 => Market) public markets;
    mapping(address => mapping(bytes32 => Position)) public positions;
    
    // No on-chain Order storage - verified from signature at settlement
    function executeMatch(
        Order calldata makerOrder,
        bytes calldata makerSignature,
        Order calldata takerOrder,
        bytes calldata takerSignature
    ) external;
}
```

### 4.3 Settlement Economics

**Current Break-Even (Solana):**
```
Settlement cost: ~$0.015
Taker fee: 0.10%
Break-even: $15 notional
Enforced minimum: $10 notional
```

**Ethereum L1 Break-Even:**
```
Settlement cost: ~$15 (at 50 gwei, moderate complexity)
Taker fee: 0.10%
Break-even: $15,000 notional  ← Kills retail
```

**Ethereum L2 Break-Even:**
```
Settlement cost: ~$0.10
Taker fee: 0.10%
Break-even: $100 notional
Enforced minimum: $50-100 notional
```

### 4.4 Market Timeframes

| Timeframe | Solana | Eth L1 | Arbitrum | Base |
|-----------|--------|--------|----------|------|
| 5m | ✅ | ❌ | ⚠️ | ❌ |
| 15m | ✅ | ❌ | ✅ | ⚠️ |
| 1h | ✅ | ⚠️ | ✅ | ✅ |
| 4h | ✅ | ✅ | ✅ | ✅ |

**Why 5m doesn't work on slow chains:**
- 12s blocks = only 25 blocks in 5 minutes
- Price manipulation easier with fewer settlement opportunities
- UX suffers from settlement latency

---

## 5. Recommended Architecture for Ethereum

### 5.1 Target: Arbitrum or Base (L2)

**Why L2?**
- 100-1000x cheaper than L1
- Fast enough for 15m+ markets
- Same security model (settles to L1)
- Large existing DeFi ecosystem

### 5.2 Modified Hybrid Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ETHEREUM L2 ARCHITECTURE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    USER ORDERS (Off-Chain Signed)                     │   │
│  │                                                                       │   │
│  │  [User] → Sign EIP-712 Intent → Send to Relayer API                  │   │
│  │                            │                                          │   │
│  │                            ▼                                          │   │
│  │              Stored off-chain (Redis + PostgreSQL)                    │   │
│  │              Added to matching engine                                 │   │
│  │                                                                       │   │
│  │  Change from Solana: No on-chain order PDA                           │   │
│  │  Trade-off: Relayer can censor (but not steal funds)                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                      MM BOT ORDERS (Unchanged)                        │   │
│  │                                                                       │   │
│  │  [MM Bot] → Sign Order Message → Send to Backend API                 │   │
│  │              (Exactly same as Solana implementation)                  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    SETTLEMENT (On-Chain L2)                           │   │
│  │                                                                       │   │
│  │  [Relayer] → Build executeMatch() tx → Submit to Arbitrum/Base       │   │
│  │                            │                                          │   │
│  │                            ▼                                          │   │
│  │  Smart contract verifies:                                             │   │
│  │  ├── Maker signature (EIP-712 or ECDSA)                              │   │
│  │  ├── Taker signature                                                  │   │
│  │  ├── Order parameters match                                           │   │
│  │  ├── Sufficient USDC balance                                          │   │
│  │  └── Atomic: Transfer USDC + Update positions                         │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Solidity Contract Sketch

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract DegenTerminal is EIP712 {
    using ECDSA for bytes32;
    
    // ============ Structs ============
    
    struct Market {
        string asset;           // "BTC", "ETH", "SOL"
        string timeframe;       // "15m", "1h", "4h"
        uint256 strikePrice;    // 8 decimals
        uint256 expiryTs;
        uint256 finalPrice;
        MarketStatus status;
        Outcome outcome;
        uint256 openInterest;
    }
    
    struct Position {
        uint256 yesShares;
        uint256 noShares;
        uint256 costBasis;
        bool settled;
    }
    
    struct Order {
        address trader;
        bytes32 marketId;
        Side side;
        Outcome outcome;
        uint256 price;          // 6 decimals (0.40 = 400000)
        uint256 size;
        uint256 expiry;
        uint256 nonce;
    }
    
    // ============ Storage ============
    
    IERC20 public immutable usdc;
    address public relayer;
    
    mapping(bytes32 => Market) public markets;
    mapping(address => mapping(bytes32 => Position)) public positions;
    mapping(address => mapping(uint256 => bool)) public usedNonces;
    
    // ============ EIP-712 ============
    
    bytes32 constant ORDER_TYPEHASH = keccak256(
        "Order(address trader,bytes32 marketId,uint8 side,uint8 outcome,uint256 price,uint256 size,uint256 expiry,uint256 nonce)"
    );
    
    constructor(address _usdc) EIP712("DegenTerminal", "1") {
        usdc = IERC20(_usdc);
        relayer = msg.sender;
    }
    
    // ============ Settlement ============
    
    function executeMatch(
        Order calldata makerOrder,
        bytes calldata makerSig,
        Order calldata takerOrder,
        bytes calldata takerSig,
        uint256 matchSize
    ) external onlyRelayer {
        // 1. Verify signatures
        require(_verifyOrder(makerOrder, makerSig), "Invalid maker sig");
        require(_verifyOrder(takerOrder, takerSig), "Invalid taker sig");
        
        // 2. Validate match
        require(makerOrder.marketId == takerOrder.marketId, "Market mismatch");
        require(makerOrder.outcome == takerOrder.outcome, "Outcome mismatch");
        require(makerOrder.side != takerOrder.side, "Same side");
        require(makerOrder.price == takerOrder.price, "Price mismatch");
        
        // 3. Mark nonces used (replay protection)
        require(!usedNonces[makerOrder.trader][makerOrder.nonce], "Maker nonce used");
        require(!usedNonces[takerOrder.trader][takerOrder.nonce], "Taker nonce used");
        usedNonces[makerOrder.trader][makerOrder.nonce] = true;
        usedNonces[takerOrder.trader][takerOrder.nonce] = true;
        
        // 4. Determine buyer/seller
        (address yesBuyer, address noBuyer) = _determineBuyers(makerOrder, takerOrder);
        
        // 5. Transfer collateral and mint shares
        uint256 yesCollateral = (makerOrder.price * matchSize) / 1e6;
        uint256 noCollateral = matchSize - yesCollateral;
        
        usdc.transferFrom(yesBuyer, address(this), yesCollateral);
        usdc.transferFrom(noBuyer, address(this), noCollateral);
        
        positions[yesBuyer][makerOrder.marketId].yesShares += matchSize;
        positions[noBuyer][makerOrder.marketId].noShares += matchSize;
        
        markets[makerOrder.marketId].openInterest += matchSize;
        
        emit MatchExecuted(makerOrder.marketId, yesBuyer, noBuyer, makerOrder.price, matchSize);
    }
    
    function _verifyOrder(Order calldata order, bytes calldata sig) internal view returns (bool) {
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPEHASH,
            order.trader,
            order.marketId,
            order.side,
            order.outcome,
            order.price,
            order.size,
            order.expiry,
            order.nonce
        ));
        bytes32 digest = _hashTypedDataV4(structHash);
        return digest.recover(sig) == order.trader;
    }
    
    // ... (settlement, market resolution, etc.)
}
```

### 5.4 EIP-712 Order Signing (Frontend)

```typescript
// TypeScript - Frontend order signing

const ORDER_TYPES = {
  Order: [
    { name: 'trader', type: 'address' },
    { name: 'marketId', type: 'bytes32' },
    { name: 'side', type: 'uint8' },
    { name: 'outcome', type: 'uint8' },
    { name: 'price', type: 'uint256' },
    { name: 'size', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

const DOMAIN = {
  name: 'DegenTerminal',
  version: '1',
  chainId: 42161, // Arbitrum
  verifyingContract: '0x...',
};

async function signOrder(order: Order): Promise<string> {
  const signature = await wallet._signTypedData(DOMAIN, ORDER_TYPES, order);
  return signature;
}

// Usage
const order = {
  trader: walletAddress,
  marketId: ethers.utils.id('BTC-1h-1709999999'),
  side: 0, // Bid
  outcome: 0, // Yes
  price: 400000n, // $0.40
  size: 100n * 10n ** 6n, // 100 contracts
  expiry: Math.floor(Date.now() / 1000) + 3600,
  nonce: Date.now(),
};

const signature = await signOrder(order);

// Send to relayer API
await fetch('/api/orders', {
  method: 'POST',
  body: JSON.stringify({ order, signature }),
});
```

---

## 6. Migration Effort Estimate

### 6.1 Components to Rewrite

| Component | Effort | Notes |
|-----------|--------|-------|
| Smart contracts | High | Anchor → Solidity |
| Frontend wallet integration | Medium | Solana Adapter → wagmi/viem |
| Backend order validation | Low | Ed25519 → ECDSA/EIP-712 |
| Matching engine | None | Pure TypeScript, unchanged |
| MM bot | Low | Signature format change only |
| Keeper jobs | Low | RPC calls change |
| Database schema | None | Platform agnostic |

### 6.2 New Components Required

| Component | Purpose |
|-----------|---------|
| EIP-712 signature verification | Order intent validation |
| L2 gas estimation | Dynamic break-even calculation |
| Bridge integration | USDC in/out of L2 |
| L1 finality monitoring | Track settlement finality |

### 6.3 Timeline Estimate

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| Smart contract development | 3-4 weeks | Core Solidity contracts |
| Contract auditing | 2-4 weeks | Security review |
| Frontend migration | 2 weeks | Wallet + signing |
| Backend adaptation | 1-2 weeks | Signature validation |
| Testing + QA | 2 weeks | Testnet deployment |
| **Total** | **10-14 weeks** | Production ready |

---

## 7. Risk Analysis

### 7.1 Increased Trust Assumptions

| Risk | Solana (Current) | Ethereum L2 |
|------|------------------|-------------|
| Order censorship | ❌ (on-chain) | ⚠️ (relayer can omit) |
| Front-running | ⚠️ (relayer sees) | ⚠️ (relayer sees) |
| Settlement manipulation | ❌ (atomic on-chain) | ❌ (atomic on-chain) |
| Fund theft | ❌ (contract controlled) | ❌ (contract controlled) |

**Mitigation for censorship:**
- Publish order hashes on-chain (commit-reveal)
- Decentralized sequencer (future)
- Social/reputation penalties

### 7.2 L2-Specific Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Sequencer downtime | Trading halts | Multi-sequencer setup |
| L1 congestion | Settlement delays | Longer market timeframes |
| Bridge hack | Fund loss | Use canonical bridges only |
| Reorg risk | Double settlement | Wait for L1 finality |

---

## 8. Recommendation

### For Ethereum Deployment:

1. **Target Arbitrum One** as primary L2
   - Lowest fees among major L2s
   - 250ms block time (suitable for 15m markets)
   - Large DeFi ecosystem (USDC liquidity)

2. **Move user orders off-chain** (EIP-712 signed intents)
   - Accept reduced trustlessness for viable economics
   - Document trust model clearly for users

3. **Increase minimum timeframes** to 15m+
   - Remove 5m markets (not viable)
   - 1h as recommended default

4. **Raise minimum notional** to $50-100
   - Ensure profitability per settlement
   - Batch aggressively for smaller orders

5. **Consider dual deployment**
   - Keep Solana for high-frequency (5m) markets
   - Use Arbitrum for larger, institutional markets

---

## 9. Alternative: Keep Solana, Add EVM Bridge

Instead of full migration, consider:

```
┌─────────────────────────────────────────────────────────────────┐
│                    HYBRID DEPLOYMENT                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Ethereum L1/L2                          Solana                  │
│  ────────────                            ──────                  │
│  USDC deposits via ──────────────────►   Bridge contract        │
│  Wormhole/Portal                         receives USDC          │
│                                                                  │
│  Users can:                              All trading happens    │
│  • Deposit from ETH                      on Solana (current     │
│  • Withdraw to ETH                       architecture)          │
│                                                                  │
│  Benefits:                                                       │
│  • Keep Solana's cheap on-chain orders                          │
│  • Access Ethereum liquidity                                     │
│  • No smart contract rewrite                                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

This preserves the current trustless model while expanding user access.

---

## 10. Conclusion

The Degen Terminal architecture **can** be adapted for Ethereum, but requires:

1. **Accepting higher trust assumptions** (off-chain user orders)
2. **Targeting L2s** (L1 is not economically viable)
3. **Adjusting market parameters** (longer timeframes, higher minimums)
4. **Significant development effort** (10-14 weeks)

The core business logic (matching, collateral, settlement) transfers cleanly. The main architectural change is moving from "trustless user orders" to "trust-minimized user intents" - a trade-off most Ethereum-based prediction markets have already made.


