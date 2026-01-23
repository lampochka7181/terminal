# MM Bot V3 Design: RN-JD with Velocity-Aware Liquidity

**Status:** ✅ PHASE 1, 2 & 3 IMPLEMENTED  
**Based on:** [arXiv:2510.15205 - Toward Black-Scholes for Prediction Markets](https://arxiv.org/pdf/2510.15205)

## Implementation Status

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Velocity Detection & Quote Pulling | ✅ Complete |
| 1.5 | Timeframe-Aware Volatility | ✅ Complete |
| 2 | Log-Odds Space (A-S Quoting) | ✅ Complete |
| 3 | Belief Volatility Calibration | ✅ Complete |
| 4 | Toxicity Guards (VPIN) | 📋 Planned |

---

## 1. Executive Summary

The current MM Bot V2 uses Black-Scholes d2 with static annualized volatility. This approach has critical weaknesses for 15-minute and 1-hour BTC binary markets:

| Problem | V2 Behavior | V3 Solution |
|---------|-------------|-------------|
| Static volatility | 50% annualized, always | Calibrated σ_b from recent data |
| No jump modeling | Assumes continuous paths | Explicit jump detection & pricing |
| Boundary instability | Unstable as p→0/1 | Log-odds space with S'(x) compression |
| Slow reaction to velocity | Fixed 250ms updates | Velocity-triggered quote pulls |
| Adverse selection on fast moves | Gets picked off | Pull losing side on high velocity |

---

## 2. The Velocity Problem (Critical for BTC)

### 2.1 Scenario: Fast Move Away from Strike

```
Market: BTC 15m, Strike = $100,000
Time: T-5 minutes

t=0:    BTC = $100,000, Fair Value = 0.50
t=2s:   BTC = $99,800,  Fair Value = 0.42  (MM updates quotes)
t=4s:   BTC = $99,500,  Fair Value = 0.31  (MM updates quotes)
t=6s:   BTC = $99,000,  Fair Value = 0.18  ← DANGER ZONE
t=8s:   BTC = $98,500,  Fair Value = 0.08  ← YES is nearly dead

Problem: In 8 seconds, YES went from 50% to 8%.
If MM was quoting YES bids at $0.30, traders sniped them at t=6s.
MM bought worthless YES contracts → LOSS
```

### 2.2 Why Velocity Matters

It's not just WHERE the price is, but HOW FAST it's moving:

```
Scenario A: BTC drifts from $100,000 → $99,500 over 60 seconds
  - Fair value: 0.50 → 0.31 (gradual)
  - MM has time to adjust quotes
  - Low adverse selection risk

Scenario B: BTC drops from $100,000 → $99,500 in 3 seconds
  - Fair value: 0.50 → 0.31 (instant)
  - Informed traders see it first
  - They hit MM's stale YES bids before MM can cancel
  - HIGH adverse selection risk
```

### 2.3 Velocity-Based Liquidity Rules

| Velocity State | Behavior |
|----------------|----------|
| **Low** (< 0.1%/sec) | Normal quoting, full size |
| **Medium** (0.1-0.3%/sec) | Widen spread 50%, reduce size 50% |
| **High** (0.3-0.5%/sec) | Widen spread 100%, reduce size 75% |
| **Extreme** (> 0.5%/sec) | **PULL QUOTES** on losing side entirely |

### 2.4 Directional Velocity (Away from Strike)

Not all velocity is equal. What matters is velocity **toward making one side lose**:

```typescript
// Velocity that hurts YES (price moving down, away from above-strike)
velocityHurtsYes = (price < strike) && (velocity < 0)  // falling further below
                || (price > strike) && (velocity < 0)  // falling toward strike

// Velocity that hurts NO (price moving up, away from below-strike)  
velocityHurtsNo = (price > strike) && (velocity > 0)   // rising further above
               || (price < strike) && (velocity > 0)   // rising toward strike
```

**Example:**
- Strike = $100,000
- Current price = $99,200 (below strike, YES is losing)
- Velocity = -$100/second (falling further)
- Action: **PULL YES BIDS IMMEDIATELY** - YES is dying fast

---

## 3. Core Architecture Changes

### 3.1 State Space: Log-Odds Instead of Probability

**Current V2:**
```typescript
// Works directly in probability space
fairValue = N(d2)  // 0 to 1
bid = fairValue - spread/2
ask = fairValue + spread/2
```

**V3 Design:**
```typescript
// Work in log-odds space
x = log(p / (1-p))     // -∞ to +∞

// Quote in x-space
x_bid = reservation_x - delta_x
x_ask = reservation_x + delta_x

// Convert back to probability for display
p_bid = 1 / (1 + exp(-x_bid))
p_ask = 1 / (1 + exp(-x_ask))
```

**Why this matters:**
- At p=0.50: x=0, changes are linear
- At p=0.01: x=-4.6, small x changes = tiny p changes (automatic compression)
- At p=0.99: x=+4.6, same compression
- **Boundary behavior is built into the math**

### 3.2 Belief Volatility (σ_b) Instead of Static Vol

**Current V2:**
```typescript
const volatility = 0.50;  // Static 50% annualized, always
```

**V3 Design:**
```typescript
interface BeliefVolatility {
  sigma_b: number;        // Diffusive component (smooth moves)
  lambda: number;         // Jump intensity (jumps per hour)
  jumpMean: number;       // Average jump size in x-space
  jumpStd: number;        // Jump size std deviation
  
  // Calibrated from rolling window (e.g., 5 minutes)
  calibratedAt: number;
  windowSeconds: number;
}
```

Calibrate continuously from recent price/fair-value dynamics:
1. Convert recent prices → fair values → log-odds (x)
2. Calculate changes in x: Δx = x(t) - x(t-1)
3. Separate jumps (|Δx| > threshold) from diffusion
4. σ_b = std(diffusion changes), annualized
5. λ = count(jumps) / time window

### 3.3 Velocity Tracker

```typescript
interface VelocityState {
  // Raw price velocity
  priceVelocity: number;          // $/second (e.g., -50 = falling $50/sec)
  priceVelocityPct: number;       // %/second (e.g., -0.05% = -0.0005)
  
  // Fair value velocity
  fairValueVelocity: number;      // Δp/second (e.g., -0.02 = losing 2 cents/sec)
  
  // Log-odds velocity (most stable)
  xVelocity: number;              // Δx/second
  
  // Direction relative to strike
  movingAwayFromStrike: boolean;  // true if price diverging from strike
  
  // Which side is getting hurt
  hurtingSide: 'YES' | 'NO' | 'NEITHER';
  
  // Urgency level
  urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  
  // Timestamps
  calculatedAt: number;
  priceHistory: { price: number; timestamp: number }[];
}
```

### 3.4 Quote Decision Engine

```typescript
interface QuoteDecision {
  // For YES side
  yes: {
    shouldQuoteBids: boolean;
    shouldQuoteAsks: boolean;
    bidSpreadMultiplier: number;   // 1.0 = normal, 2.0 = double spread
    askSpreadMultiplier: number;
    sizeMultiplier: number;        // 1.0 = normal, 0.0 = no quotes
  };
  
  // For NO side (derived from YES in single-book model)
  no: {
    shouldQuoteBids: boolean;
    shouldQuoteAsks: boolean;
    bidSpreadMultiplier: number;
    askSpreadMultiplier: number;
    sizeMultiplier: number;
  };
  
  // Reasoning
  reason: string;
}
```

---

## 4. Velocity Calculation Algorithm

### 4.1 Price Velocity (Raw)

```typescript
function calculatePriceVelocity(
  priceHistory: { price: number; timestamp: number }[],
  windowMs: number = 5000  // 5 second window
): { velocity: number; velocityPct: number } {
  const now = Date.now();
  const recent = priceHistory.filter(p => p.timestamp > now - windowMs);
  
  if (recent.length < 2) {
    return { velocity: 0, velocityPct: 0 };
  }
  
  // Linear regression for velocity (more stable than point-to-point)
  const n = recent.length;
  let sumT = 0, sumP = 0, sumTP = 0, sumTT = 0;
  
  for (const { price, timestamp } of recent) {
    const t = (timestamp - now) / 1000;  // seconds ago (negative)
    sumT += t;
    sumP += price;
    sumTP += t * price;
    sumTT += t * t;
  }
  
  // Slope = velocity in $/second
  const velocity = (n * sumTP - sumT * sumP) / (n * sumTT - sumT * sumT);
  
  // As percentage
  const avgPrice = sumP / n;
  const velocityPct = velocity / avgPrice;
  
  return { velocity, velocityPct };
}
```

### 4.2 Fair Value Velocity

```typescript
function calculateFairValueVelocity(
  strike: number,
  timeToExpirySec: number,
  sigma_b: number,
  priceHistory: { price: number; timestamp: number }[],
  windowMs: number = 3000  // 3 second window for faster reaction
): number {
  const now = Date.now();
  const recent = priceHistory.filter(p => p.timestamp > now - windowMs);
  
  if (recent.length < 2) return 0;
  
  // Calculate fair values for each price point
  const fvHistory = recent.map(({ price, timestamp }) => ({
    fv: calculateFairValueBS(price, strike, timeToExpirySec, sigma_b),
    timestamp
  }));
  
  // Linear regression for FV velocity
  const n = fvHistory.length;
  let sumT = 0, sumFV = 0, sumTFV = 0, sumTT = 0;
  
  for (const { fv, timestamp } of fvHistory) {
    const t = (timestamp - now) / 1000;
    sumT += t;
    sumFV += fv;
    sumTFV += t * fv;
    sumTT += t * t;
  }
  
  // Slope = fair value change per second
  return (n * sumTFV - sumT * sumFV) / (n * sumTT - sumT * sumT);
}
```

### 4.3 Urgency Classification

```typescript
function classifyUrgency(
  priceVelocityPct: number,
  fairValueVelocity: number,
  currentFairValue: number,
  timeToExpirySec: number
): 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' {
  const absPriceVel = Math.abs(priceVelocityPct);
  const absFvVel = Math.abs(fairValueVelocity);
  
  // Time factor: urgency increases as expiry approaches
  const timeFactor = timeToExpirySec < 300 ? 2.0 :  // < 5 min
                     timeToExpirySec < 900 ? 1.5 :  // < 15 min
                     1.0;
  
  // Boundary factor: urgency increases near 0 or 1
  const boundaryFactor = (currentFairValue < 0.15 || currentFairValue > 0.85) ? 1.5 : 1.0;
  
  const effectiveVelocity = absFvVel * timeFactor * boundaryFactor;
  
  // Classification thresholds (tunable)
  if (effectiveVelocity > 0.05) return 'EXTREME';  // 5 cents/sec adjusted
  if (effectiveVelocity > 0.02) return 'HIGH';     // 2 cents/sec adjusted
  if (effectiveVelocity > 0.01) return 'MEDIUM';   // 1 cent/sec adjusted
  return 'LOW';
}
```

### 4.4 Which Side is Hurting

```typescript
function determineHurtingSide(
  currentPrice: number,
  strike: number,
  priceVelocity: number,
  currentFairValue: number
): 'YES' | 'NO' | 'NEITHER' {
  const isAboveStrike = currentPrice > strike;
  const isRising = priceVelocity > 0;
  const isFalling = priceVelocity < 0;
  
  // YES wins if price > strike at expiry
  // NO wins if price < strike at expiry
  
  if (isAboveStrike && isRising) {
    // Price above strike and rising further → YES getting stronger, NO hurting
    return 'NO';
  }
  
  if (isAboveStrike && isFalling) {
    // Price above strike but falling toward it → YES weakening
    // Only hurting if falling fast enough to cross
    return Math.abs(priceVelocity) > 10 ? 'YES' : 'NEITHER';
  }
  
  if (!isAboveStrike && isFalling) {
    // Price below strike and falling further → NO getting stronger, YES hurting
    return 'YES';
  }
  
  if (!isAboveStrike && isRising) {
    // Price below strike but rising toward it → NO weakening
    return Math.abs(priceVelocity) > 10 ? 'NO' : 'NEITHER';
  }
  
  return 'NEITHER';
}
```

---

## 5. Quote Decision Logic

### 5.1 Main Decision Function

```typescript
function makeQuoteDecision(
  fairValue: number,
  velocity: VelocityState,
  inventory: { yes: number; no: number },
  timeToExpirySec: number,
  config: MMConfig
): QuoteDecision {
  const decision: QuoteDecision = {
    yes: {
      shouldQuoteBids: true,
      shouldQuoteAsks: true,
      bidSpreadMultiplier: 1.0,
      askSpreadMultiplier: 1.0,
      sizeMultiplier: 1.0,
    },
    no: {
      shouldQuoteBids: true,
      shouldQuoteAsks: true,
      bidSpreadMultiplier: 1.0,
      askSpreadMultiplier: 1.0,
      sizeMultiplier: 1.0,
    },
    reason: 'Normal quoting',
  };
  
  // === VELOCITY-BASED ADJUSTMENTS ===
  
  if (velocity.urgency === 'EXTREME') {
    // PULL QUOTES on the hurting side entirely
    if (velocity.hurtingSide === 'YES') {
      decision.yes.shouldQuoteBids = false;  // Don't buy dying YES
      decision.yes.sizeMultiplier = 0.1;     // Minimal ask size
      decision.yes.askSpreadMultiplier = 3.0; // Wide asks if we quote
      decision.reason = 'EXTREME velocity hurting YES - pulled YES bids';
    } else if (velocity.hurtingSide === 'NO') {
      decision.no.shouldQuoteBids = false;   // Don't buy dying NO
      decision.no.sizeMultiplier = 0.1;
      decision.no.askSpreadMultiplier = 3.0;
      decision.reason = 'EXTREME velocity hurting NO - pulled NO bids';
    }
  }
  
  else if (velocity.urgency === 'HIGH') {
    // Widen spreads significantly, reduce size
    const multiplier = 2.0;
    const sizeReduction = 0.25;
    
    if (velocity.hurtingSide === 'YES') {
      decision.yes.bidSpreadMultiplier = multiplier;
      decision.yes.sizeMultiplier = sizeReduction;
    } else if (velocity.hurtingSide === 'NO') {
      decision.no.bidSpreadMultiplier = multiplier;
      decision.no.sizeMultiplier = sizeReduction;
    }
    decision.reason = `HIGH velocity - widened ${velocity.hurtingSide} side`;
  }
  
  else if (velocity.urgency === 'MEDIUM') {
    // Moderate spread widening
    const multiplier = 1.5;
    const sizeReduction = 0.5;
    
    if (velocity.hurtingSide === 'YES') {
      decision.yes.bidSpreadMultiplier = multiplier;
      decision.yes.sizeMultiplier = sizeReduction;
    } else if (velocity.hurtingSide === 'NO') {
      decision.no.bidSpreadMultiplier = multiplier;
      decision.no.sizeMultiplier = sizeReduction;
    }
    decision.reason = `MEDIUM velocity - adjusted ${velocity.hurtingSide} side`;
  }
  
  // === TIME-BASED ADJUSTMENTS ===
  
  // Near expiry with clear winner
  if (timeToExpirySec < 60 && (fairValue < 0.10 || fairValue > 0.90)) {
    const loser = fairValue < 0.10 ? 'YES' : 'NO';
    if (loser === 'YES') {
      decision.yes.shouldQuoteBids = false;
      decision.yes.sizeMultiplier = 0;
    } else {
      decision.no.shouldQuoteBids = false;
      decision.no.sizeMultiplier = 0;
    }
    decision.reason = `Near expiry, ${loser} is dead - no ${loser} bids`;
  }
  
  // === INVENTORY-BASED ADJUSTMENTS ===
  
  const imbalance = inventory.yes - inventory.no;
  const maxImbalance = config.maxImbalance;
  
  if (Math.abs(imbalance) > maxImbalance * 0.8) {
    // Heavy on one side - reduce buying that side
    if (imbalance > 0) {
      // Too much YES - reduce YES bids
      decision.yes.sizeMultiplier *= 0.5;
      decision.yes.bidSpreadMultiplier *= 1.3;
    } else {
      // Too much NO - reduce NO bids
      decision.no.sizeMultiplier *= 0.5;
      decision.no.bidSpreadMultiplier *= 1.3;
    }
  }
  
  return decision;
}
```

### 5.2 Emergency Quote Pull (Sub-Second)

When velocity is extreme, we can't wait for the next quote cycle:

```typescript
class VelocityMonitor {
  private lastPrice: number = 0;
  private lastTimestamp: number = 0;
  private onEmergencyPull: (side: 'YES' | 'NO') => Promise<void>;
  
  constructor(emergencyCallback: (side: 'YES' | 'NO') => Promise<void>) {
    this.onEmergencyPull = emergencyCallback;
  }
  
  // Called on EVERY price update (via WebSocket)
  async onPriceUpdate(
    price: number, 
    strike: number,
    timestamp: number = Date.now()
  ): Promise<void> {
    if (this.lastTimestamp === 0) {
      this.lastPrice = price;
      this.lastTimestamp = timestamp;
      return;
    }
    
    const dt = (timestamp - this.lastTimestamp) / 1000;  // seconds
    if (dt < 0.1) return;  // Need at least 100ms for meaningful velocity
    
    const priceChange = price - this.lastPrice;
    const velocity = priceChange / dt;  // $/second
    const velocityPct = velocity / price;
    
    // EXTREME threshold: 0.5%/second = would move 30% in 1 minute
    const EXTREME_THRESHOLD = 0.005;
    
    if (Math.abs(velocityPct) > EXTREME_THRESHOLD) {
      // Determine which side to pull
      const isAboveStrike = price > strike;
      const isFalling = velocity < 0;
      
      if ((isAboveStrike && isFalling) || (!isAboveStrike && isFalling)) {
        // YES is getting hurt
        await this.onEmergencyPull('YES');
      } else {
        // NO is getting hurt
        await this.onEmergencyPull('NO');
      }
    }
    
    this.lastPrice = price;
    this.lastTimestamp = timestamp;
  }
}
```

---

## 6. Avellaneda-Stoikov Quoting in X-Space

### 6.1 Reservation Price (Inventory-Adjusted Mid)

```typescript
function calculateReservationX(
  x: number,           // Current log-odds
  q: number,           // Net inventory (YES - NO)
  gamma: number,       // Risk aversion parameter (0.01 - 0.1)
  k: number,           // Order arrival intensity
  T: number            // Time to expiry in seconds
): number {
  // r_x = x - (γ * q) / (k * T)
  // 
  // Interpretation:
  // - If q > 0 (long YES), shift reservation DOWN to attract sellers
  // - If q < 0 (long NO), shift reservation UP to attract buyers
  
  const safeT = Math.max(T, 1);  // Avoid division by zero
  const inventoryAdjustment = (gamma * q) / (k * safeT);
  
  return x - inventoryAdjustment;
}
```

### 6.2 Half-Spread in X-Space

```typescript
function calculateHalfSpreadX(
  sigma_b: number,     // Belief volatility
  gamma: number,       // Risk aversion
  k: number,           // Order arrival intensity
  T: number,           // Time to expiry
  lambda: number,      // Jump intensity
  jumpStd: number      // Jump size std dev
): number {
  // Base A-S spread:
  // δ_x ≈ 0.5 * [γ * σ_b² * T + (2/k) * log(1 + γ/k)]
  
  const safeT = Math.max(T, 1);
  
  const varianceTerm = gamma * sigma_b * sigma_b * safeT;
  const liquidityTerm = (2 / k) * Math.log(1 + gamma / k);
  const baseHalfSpread = 0.5 * (varianceTerm + liquidityTerm);
  
  // Jump risk premium
  // Add extra spread for jump risk
  const jumpPremium = lambda * jumpStd * 0.3;  // tunable
  
  return baseHalfSpread + jumpPremium;
}
```

### 6.3 Convert X-Space Quotes to Probability

```typescript
function xQuotesToProbability(
  x_bid: number,
  x_ask: number,
  minSpread: number = 0.02,
  maxSpread: number = 0.20
): { p_bid: number; p_ask: number; spread: number } {
  // Logistic transform: p = 1 / (1 + e^(-x))
  let p_bid = 1 / (1 + Math.exp(-x_bid));
  let p_ask = 1 / (1 + Math.exp(-x_ask));
  
  // Clamp to valid range
  p_bid = Math.max(0.01, Math.min(0.98, p_bid));
  p_ask = Math.max(0.02, Math.min(0.99, p_ask));
  
  // Enforce spread constraints
  let spread = p_ask - p_bid;
  
  if (spread < minSpread) {
    const mid = (p_bid + p_ask) / 2;
    p_bid = mid - minSpread / 2;
    p_ask = mid + minSpread / 2;
    spread = minSpread;
  }
  
  if (spread > maxSpread) {
    const mid = (p_bid + p_ask) / 2;
    p_bid = mid - maxSpread / 2;
    p_ask = mid + maxSpread / 2;
    spread = maxSpread;
  }
  
  return { p_bid, p_ask, spread };
}
```

---

## 7. Belief Volatility Calibration

### 7.1 Rolling Window Calibration

```typescript
interface CalibrationResult {
  sigma_b: number;          // Belief diffusive volatility
  lambda: number;           // Jump intensity (per hour)
  jumpMean: number;         // Average jump size in x-space
  jumpStd: number;          // Jump std dev
  sampleCount: number;      // Data points used
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

function calibrateBeliefDynamics(
  priceHistory: { price: number; timestamp: number }[],
  strike: number,
  timeToExpiry: number,
  windowSeconds: number = 300  // 5 minutes
): CalibrationResult {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const recent = priceHistory.filter(p => p.timestamp > windowStart);
  
  if (recent.length < 20) {
    // Insufficient data - return conservative defaults
    return {
      sigma_b: 0.80,      // High vol assumption (conservative)
      lambda: 1.0,        // Assume some jumps
      jumpMean: 0,
      jumpStd: 0.5,
      sampleCount: recent.length,
      confidence: 'LOW'
    };
  }
  
  // 1. Convert prices to log-odds
  const xValues: { x: number; timestamp: number }[] = [];
  for (const { price, timestamp } of recent) {
    const fv = calculateFairValueBS(price, strike, timeToExpiry, 0.5);
    const x = probToLogOdds(fv);
    xValues.push({ x, timestamp });
  }
  
  // 2. Calculate changes
  const changes: { dx: number; dt: number }[] = [];
  for (let i = 1; i < xValues.length; i++) {
    const dx = xValues[i].x - xValues[i-1].x;
    const dt = (xValues[i].timestamp - xValues[i-1].timestamp) / 1000;
    if (dt > 0) {
      changes.push({ dx, dt });
    }
  }
  
  // 3. Separate jumps from diffusion
  const allDx = changes.map(c => c.dx);
  const dxStd = std(allDx);
  const jumpThreshold = 2.5 * dxStd;  // 2.5 sigma = jump
  
  const diffusion = changes.filter(c => Math.abs(c.dx) < jumpThreshold);
  const jumps = changes.filter(c => Math.abs(c.dx) >= jumpThreshold);
  
  // 4. Estimate diffusive volatility
  const diffusionDx = diffusion.map(c => c.dx);
  const totalDiffusionTime = diffusion.reduce((s, c) => s + c.dt, 0);
  const avgDt = totalDiffusionTime / diffusion.length;
  
  // Variance per second, then annualize
  const variancePerSec = variance(diffusionDx) / avgDt;
  const sigma_b = Math.sqrt(variancePerSec * 365 * 24 * 3600);
  
  // 5. Estimate jump parameters
  const totalTime = windowSeconds;
  const lambda = (jumps.length / totalTime) * 3600;  // per hour
  
  const jumpSizes = jumps.map(j => j.dx);
  const jumpMean = jumpSizes.length > 0 ? mean(jumpSizes) : 0;
  const jumpStd = jumpSizes.length > 1 ? std(jumpSizes) : 0.5;
  
  return {
    sigma_b: clamp(sigma_b, 0.1, 3.0),
    lambda: clamp(lambda, 0, 20),
    jumpMean,
    jumpStd: clamp(jumpStd, 0.1, 2.0),
    sampleCount: recent.length,
    confidence: recent.length > 100 ? 'HIGH' : recent.length > 50 ? 'MEDIUM' : 'LOW'
  };
}
```

### 7.2 Implementation Notes (Phase 3 Complete)

**Implemented in `mm-bot-v2.ts`:**

1. **Fair Value History Tracking**
   - `FairValuePoint` interface stores `{ fairValue, logOdds, timestamp, price }`
   - Rolling window maintained per market (5min + buffer)
   - Updated every quote cycle (~250ms)

2. **Calibration Function**
   - `calibrateBeliefDynamics()` processes fair value history
   - Separates jumps (>2.5σ moves) from diffusion
   - Estimates σ_b from diffusive component only
   - Returns `CalibrationResult` with confidence scoring

3. **Belief Volatility Selection**
   - `getBeliefVolatility()` chooses between calibrated vs estimated
   - Uses calibration if confidence is MEDIUM or HIGH
   - Falls back to `estimateBeliefVolatilityFallback()` otherwise

4. **Configuration**
   ```env
   MM_CALIBRATION_ENABLED=true          # Enable calibration (default: true)
   MM_CALIBRATION_WINDOW_SEC=300        # 5-minute rolling window
   MM_CALIBRATION_MIN_SAMPLES=20        # Minimum data points needed
   MM_CALIBRATION_JUMP_SIGMA=2.5        # Threshold for jump classification
   MM_CALIBRATION_DEFAULT_SIGMA=0.25    # Fallback σ_b
   MM_CALIBRATION_MIN_SIGMA=0.05        # Floor
   MM_CALIBRATION_MAX_SIGMA=1.0         # Cap
   ```

5. **Monitoring**
   - Calibration state exposed via `/api/mm/status` and `/api/mm/quotes/:marketId`
   - Includes: σ_b, confidence, sampleCount, jumpCount, λ (jumps/hour)

---

## 8. Toxicity Detection (VPIN-Style)

### 8.1 Volume-Synchronized Probability of Informed Trading

```typescript
interface ToxicityState {
  vpin: number;              // 0 to 1, higher = more toxic
  orderImbalance: number;    // -1 to 1
  recentAdverseRate: number; // % of fills that moved against us
  toxicityLevel: 'SAFE' | 'ELEVATED' | 'DANGEROUS';
}

function calculateToxicity(
  recentTrades: { 
    side: 'buy' | 'sell'; 
    size: number; 
    price: number;
    wasOurOrder: boolean;
    priceAfter: number;  // price 1 second after fill
  }[],
  windowMs: number = 60000
): ToxicityState {
  const now = Date.now();
  const recent = recentTrades.filter(t => t.timestamp > now - windowMs);
  
  if (recent.length < 10) {
    return { vpin: 0, orderImbalance: 0, recentAdverseRate: 0, toxicityLevel: 'SAFE' };
  }
  
  // Order imbalance
  const buyVol = recent.filter(t => t.side === 'buy').reduce((s, t) => s + t.size, 0);
  const sellVol = recent.filter(t => t.side === 'sell').reduce((s, t) => s + t.size, 0);
  const total = buyVol + sellVol;
  const orderImbalance = total > 0 ? (buyVol - sellVol) / total : 0;
  
  // VPIN approximation
  const vpin = Math.abs(orderImbalance);
  
  // Adverse selection rate (for our fills)
  const ourFills = recent.filter(t => t.wasOurOrder);
  if (ourFills.length > 0) {
    const adverseFills = ourFills.filter(t => {
      // We bought and price fell, or we sold and price rose
      const weBought = t.side === 'sell';  // if they sold, we bought
      const priceFell = t.priceAfter < t.price;
      return (weBought && priceFell) || (!weBought && !priceFell);
    });
    const recentAdverseRate = adverseFills.length / ourFills.length;
  }
  
  // Classification
  const toxicityLevel = vpin > 0.7 ? 'DANGEROUS' :
                        vpin > 0.4 ? 'ELEVATED' : 'SAFE';
  
  return { vpin, orderImbalance, recentAdverseRate, toxicityLevel };
}
```

### 8.2 Apply Toxicity Guards

```typescript
function applyToxicityGuards(
  baseHalfSpread: number,
  baseSize: number,
  toxicity: ToxicityState
): { adjustedSpread: number; adjustedSize: number } {
  let spreadMultiplier = 1.0;
  let sizeMultiplier = 1.0;
  
  switch (toxicity.toxicityLevel) {
    case 'DANGEROUS':
      spreadMultiplier = 2.5;
      sizeMultiplier = 0.2;
      break;
    case 'ELEVATED':
      spreadMultiplier = 1.5;
      sizeMultiplier = 0.5;
      break;
    case 'SAFE':
    default:
      break;
  }
  
  // Additional adjustment based on adverse selection
  if (toxicity.recentAdverseRate > 0.6) {
    spreadMultiplier *= 1.3;
    sizeMultiplier *= 0.7;
  }
  
  return {
    adjustedSpread: baseHalfSpread * spreadMultiplier,
    adjustedSize: baseSize * sizeMultiplier
  };
}
```

---

## 9. Implementation Phases

### Phase 1: Velocity Detection & Quote Pulling (High Priority)
- [ ] Implement `VelocityState` tracking
- [ ] Add velocity calculation on each price update
- [ ] Implement emergency quote pull on extreme velocity
- [ ] Add directional velocity detection (which side is hurting)
- [ ] Test with simulated fast BTC moves

### Phase 2: Log-Odds Space Quoting
- [ ] Implement `probToLogOdds` and `logOddsToProb`
- [ ] Port quoting logic to x-space
- [ ] Implement A-S reservation price with inventory
- [ ] Implement A-S half-spread formula
- [ ] Test boundary behavior (p near 0 or 1)

### Phase 3: Belief Volatility Calibration ✅
- [x] Implement rolling window calibrator (`calibrateBeliefDynamics()`)
- [x] Add jump/diffusion separation (2.5σ threshold)
- [x] Replace static vol with calibrated σ_b (`getBeliefVolatility()`)
- [x] Add confidence scoring (HIGH/MEDIUM/LOW based on sample count)
- [ ] Back-test against historical data (ongoing)

### Phase 4: Toxicity Guards
- [ ] Implement VPIN calculation
- [ ] Track adverse selection rate
- [ ] Add toxicity-based spread widening
- [ ] Add toxicity-based size reduction

### Phase 5: Testing & Tuning
- [ ] A/B test V3 vs V2
- [ ] Measure: adverse selection, P&L, inventory excursions
- [ ] Tune parameters: γ, k, thresholds
- [ ] Document final configuration

---

## 10. Configuration (V3)

```typescript
interface MMConfigV3 {
  // === VELOCITY SETTINGS ===
  velocity: {
    windowMs: number;              // Velocity calculation window (default: 5000)
    mediumThreshold: number;       // %/sec for MEDIUM (default: 0.001)
    highThreshold: number;         // %/sec for HIGH (default: 0.003)
    extremeThreshold: number;      // %/sec for EXTREME/PULL (default: 0.005)
    emergencyPullEnabled: boolean; // Enable sub-cycle emergency pulls
  };
  
  // === BELIEF VOLATILITY ===
  beliefVol: {
    calibrationWindowSec: number;  // Rolling window (default: 300)
    minSigmaB: number;             // Floor (default: 0.10)
    maxSigmaB: number;             // Cap (default: 3.0)
    jumpThresholdSigmas: number;   // Jump detection threshold (default: 2.5)
    fallbackSigmaB: number;        // When data insufficient (default: 0.80)
  };
  
  // === AVELLANEDA-STOIKOV ===
  quoting: {
    gamma: number;                 // Risk aversion (default: 0.05)
    k: number;                     // Order arrival intensity (default: 1.0)
    minSpread: number;             // Floor spread (default: 0.02)
    maxSpread: number;             // Cap spread (default: 0.20)
    jumpSpreadPremium: number;     // Jump risk premium factor (default: 0.3)
  };
  
  // === TOXICITY ===
  toxicity: {
    vpinWindowMs: number;          // VPIN calculation window (default: 60000)
    elevatedThreshold: number;     // VPIN for ELEVATED (default: 0.4)
    dangerousThreshold: number;    // VPIN for DANGEROUS (default: 0.7)
    adverseRateThreshold: number;  // Adverse selection concern (default: 0.6)
  };
  
  // === INHERITED FROM V2 ===
  // ... spread, size, inventory, time settings ...
}
```

---

## 11. Risk Considerations

### 11.1 What Can Still Go Wrong

| Risk | Mitigation |
|------|------------|
| Model mis-specification | Conservative defaults, continuous calibration |
| Velocity detection lag | Sub-100ms price processing, emergency pulls |
| Flash crash (instant move) | Accept some loss, position limits |
| API/WebSocket latency | Local price caching, pessimistic assumptions |
| Calibration on bad data | Confidence scoring, fallback to conservative |

### 11.2 Position Limits by Fair Value

More conservative limits when probability is extreme:

```typescript
function getMaxPosition(fairValue: number, baseMax: number): number {
  // S'(x) = p(1-p) gives boundary sensitivity
  const sPrime = fairValue * (1 - fairValue);
  
  // At p=0.5: sPrime=0.25, full position allowed
  // At p=0.1: sPrime=0.09, ~36% position allowed
  // At p=0.01: sPrime=0.0099, ~4% position allowed
  
  const boundaryFactor = sPrime / 0.25;
  return Math.round(baseMax * boundaryFactor);
}
```

---

## 12. References

- [Toward Black–Scholes for Prediction Markets](https://arxiv.org/pdf/2510.15205) - Core RN-JD framework
- Avellaneda & Stoikov (2008) - High-frequency market making with inventory
- Guéant, Lehalle, Fernandez-Tapia (2013) - Optimal market making
- Easley et al. (2012) - VPIN and flow toxicity

---

*Last updated: January 2026*

