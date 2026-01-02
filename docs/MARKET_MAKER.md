## MM Bot V2 - Implementation Notes

**Status: ✅ IMPLEMENTED** (see `apps/api/src/bot/mm-bot-v2.ts`)

### Requirements Implemented:

1. ✅ **Spread configurable** - `MM_BASE_SPREAD`, `MM_MIN_SPREAD`, `MM_MAX_SPREAD`
2. ✅ **Size configurable** - `MM_BASE_SIZE`, `MM_MAX_SIZE`, `MM_MIN_SIZE`, `MM_LEVELS`
3. ✅ **Price relative to underlying** - Black-Scholes N(d2) fair value calculation
4. ✅ **Time decay (theta)** - Quotes adjust based on time remaining, stops quoting losing side near expiry
5. ✅ **Delta neutral** - Inventory skewing with configurable thresholds and aggressive rebalancing
6. ✅ **WebSocket integration** - Real-time price updates via WebSocket
7. ⏳ **Dashboard** - Debug endpoint at `/debug/mm`, GUI dashboard TBD

### Environment Variables

```bash
# Enable MM bot v2 (default)
MM_VERSION=v2              # Use 'v1' for legacy bot
MM_ENABLED=true

# Spread Configuration
MM_BASE_SPREAD=0.04        # Base spread (4 cents total)
MM_MIN_SPREAD=0.02         # Minimum spread (never tighter)
MM_MAX_SPREAD=0.20         # Maximum spread (widen in uncertainty)

# Size Configuration
MM_BASE_SIZE=100           # Base contracts per level
MM_MAX_SIZE=1000           # Maximum size per level
MM_MIN_SIZE=10             # Minimum size to quote
MM_LEVELS=3                # Number of price levels on each side
MM_LEVEL_SPACING=0.01      # Price increment between levels

# Inventory / Delta Neutral Settings
MM_MAX_POSITION=10000      # Maximum position per outcome
MM_MAX_IMBALANCE=5000      # Maximum YES - NO imbalance
MM_SKEW_FACTOR=0.02        # How aggressively to skew (max 2 cents)
MM_REBALANCE_START_PCT=0.70      # Start aggressive rebalancing (70% time elapsed)
MM_CRITICAL_REBALANCE_PCT=0.90   # Critical rebalancing (90% time elapsed)

# Time Settings
MM_QUOTE_UPDATE_MS=1000           # Update quotes every 1 second
MM_CLOSE_BEFORE_EXPIRY_MS=30000   # Stop quoting 30s before expiry
MM_STOP_QUOTING_LOSER_PCT=0.10    # Stop quoting losing side in last 10%

# Volatility
MM_DEFAULT_VOLATILITY=0.50        # 50% annualized volatility
MM_VOLATILITY_OVERRIDES='{"BTC":0.40,"ETH":0.60}'  # Per-asset overrides (JSON)

# Assets
MM_ASSETS=BTC,ETH,SOL             # Which assets to market make

# WebSocket
MM_USE_WEBSOCKET=true             # Enable WebSocket for price updates
MM_WS_RECONNECT_MS=5000           # Reconnect interval on disconnect
```

### Key Algorithms

#### Fair Value (Black-Scholes d2)
```
P(YES wins) = N(d2)
where d2 = ln(current_price / strike) / (σ × √T)
```

#### Inventory Skewing
- Positive skew when holding too much YES → lowers all prices
- Negative skew when holding too much NO → raises all prices
- Skew multiplied by 2x after 70% time elapsed, 4x after 90%

#### Dynamic Spread
- Widens 50% when fair value > 0.85 or < 0.15
- Widens 50% in last 20%, 100% in last 10%
- Widens with inventory imbalance

#### Time-Decay Quote Reduction
- Stops quoting bids on losing side when < 10% time remains
- Example: If YES = 0.10 with 5% time left, won't bid on YES

_____________________________________

# Market Maker Architecture

## 1. Overview

The Market Maker (MM) bot provides liquidity to the Degen Terminal orderbook. Without it, users would have no counterparty to trade against.

**Key Principle:** The MM never "sells" tokens it doesn't own. When a user buys YES, the MM is actually **buying NO** (the opposite outcome).

```
┌─────────────────────────────────────────────────────────────────┐
│                    MARKET MAKER SYSTEM                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────┐    ┌─────────────────────────────────┐   │
│   │  PRICE FEEDS    │    │         MM BOT                  │   │
│   │  ─────────────  │    │         ──────                  │   │
│   │  • Binance WS   │───▶│  1. Calculate fair value        │   │
│   │  • Coinbase WS  │    │  2. Determine bid/ask spread    │   │
│   │                 │    │  3. Check inventory limits      │   │
│   └─────────────────┘    │  4. Place/update orders         │   │
│                          └──────────────┬──────────────────┘   │
│                                         │                       │
│                                         ▼                       │
│                          ┌─────────────────────────────────┐   │
│                          │      DEGEN TERMINAL API         │   │
│                          │      ──────────────────         │   │
│                          │  POST /orders                   │   │
│                          │  DELETE /orders/:id             │   │
│                          │  WS: orderbook, trades          │   │
│                          └─────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Concept: Buying the Opposite

When you "sell YES", you're actually "buying NO":

```
USER ACTION              MM'S ACTUAL TRADE          MM RECEIVES
───────────────────────────────────────────────────────────────
User buys YES @ $0.40    MM buys NO @ $0.60        NO shares
User sells YES @ $0.38   MM buys YES @ $0.38       YES shares
User buys NO @ $0.55     MM buys YES @ $0.45       YES shares
User sells NO @ $0.58    MM buys NO @ $0.58        NO shares
```

**Why?** Because YES + NO = $1.00 always. There's no "selling from inventory" unless MM already owns those shares.

---

## 3. Fair Value Calculation

The MM must estimate the probability that YES wins (price > strike at expiry).

### 3.1 Simple Model (V1)

```python
import math
from scipy.stats import norm

def calculate_fair_value(
    current_price: float,    # Current BTC price
    strike_price: float,     # Market strike
    time_to_expiry: float,   # Seconds until expiry
    volatility: float        # Annualized volatility (e.g., 0.50 = 50%)
) -> float:
    """
    Calculate probability that price > strike at expiry.
    Uses simplified Black-Scholes for binary options.
    """
    if time_to_expiry <= 0:
        # Already expired
        return 1.0 if current_price > strike_price else 0.0
    
    # Convert to annualized time
    T = time_to_expiry / (365 * 24 * 60 * 60)
    
    # d2 from Black-Scholes (simplified, no drift)
    d2 = math.log(current_price / strike_price) / (volatility * math.sqrt(T))
    
    # Probability of finishing above strike
    fair_value = norm.cdf(d2)
    
    # Clamp to valid range
    return max(0.01, min(0.99, fair_value))
```

### 3.2 Volatility Estimation

```python
def estimate_volatility(price_history: list, window: int = 100) -> float:
    """
    Estimate volatility from recent price data.
    Returns annualized volatility.
    """
    returns = []
    for i in range(1, len(price_history)):
        ret = math.log(price_history[i] / price_history[i-1])
        returns.append(ret)
    
    # Standard deviation of returns
    std_dev = statistics.stdev(returns[-window:])
    
    # Annualize (assuming 1-second intervals)
    annualized = std_dev * math.sqrt(365 * 24 * 60 * 60)
    
    return annualized
```

---

## 4. Quoting Strategy

### 4.1 Basic Two-Sided Quotes

```python
class QuoteCalculator:
    def __init__(self, config: dict):
        self.base_spread = config.get('spread', 0.04)      # 4 cents total
        self.size_per_level = config.get('size', 100)      # contracts
        self.num_levels = config.get('levels', 3)          # depth
        self.level_spacing = config.get('spacing', 0.01)   # 1 cent between levels
        
    def calculate_quotes(self, fair_value: float) -> dict:
        """
        Generate bid and ask quotes around fair value.
        """
        half_spread = self.base_spread / 2
        
        bids = []
        asks = []
        
        for i in range(self.num_levels):
            offset = i * self.level_spacing
            
            bid_price = fair_value - half_spread - offset
            ask_price = fair_value + half_spread + offset
            
            bids.append({
                'price': max(0.01, round(bid_price, 2)),
                'size': self.size_per_level
            })
            asks.append({
                'price': min(0.99, round(ask_price, 2)),
                'size': self.size_per_level
            })
        
        return {'bids': bids, 'asks': asks}
```

**Example Output:**
```
Fair Value: $0.50

ASKS (MM "sells" YES = buys NO)
$0.54  │ 100 │  level 2
$0.53  │ 100 │  level 1  
$0.52  │ 100 │  level 0  ← tightest ask
────── SPREAD ──────
$0.48  │ 100 │  level 0  ← tightest bid
$0.47  │ 100 │  level 1
$0.46  │ 100 │  level 2
BIDS (MM buys YES)
```

---

## 5. Inventory Management

### 5.1 The Problem

If MM keeps buying NO shares, they become exposed to YES winning:

```
MM Inventory:
├── YES: 100 shares (cost: $40)
├── NO: 500 shares (cost: $275)
│
├── Net: -400 NO shares (bearish exposure)
│
├── If YES wins: MM loses $400 - $40 = -$360
└── If NO wins: MM gains $500 - $275 = +$225
```

### 5.2 Inventory Skewing

Adjust quotes to reduce unwanted inventory:

```python
class InventoryManager:
    def __init__(self, config: dict):
        self.max_position = config.get('max_position', 1000)
        self.skew_factor = config.get('skew_factor', 0.02)
    
    def calculate_skew(self, yes_shares: int, no_shares: int) -> float:
        """
        Returns adjustment to apply to quotes.
        Positive = skew asks lower (want to accumulate NO)
        Negative = skew bids lower (want to accumulate YES)
        """
        net_position = yes_shares - no_shares
        
        # Normalize by max position
        imbalance = net_position / self.max_position
        
        # Skew amount (max 2 cents)
        skew = imbalance * self.skew_factor
        
        return skew
    
    def apply_skew(self, quotes: dict, skew: float) -> dict:
        """
        Adjust quotes based on inventory skew.
        """
        for bid in quotes['bids']:
            bid['price'] = max(0.01, bid['price'] - skew)
        
        for ask in quotes['asks']:
            ask['price'] = min(0.99, ask['price'] - skew)
        
        return quotes
```

**Effect:**
```
Inventory: 500 YES, 100 NO (too much YES)
Skew: +0.008 (shift quotes DOWN)

Before Skew          After Skew
─────────────        ──────────────
Ask: $0.52           Ask: $0.512  ← Cheaper for users to buy YES (MM gets NO)
Bid: $0.48           Bid: $0.472  ← MM pays less for YES
```

### 5.3 Position Limits

```python
def should_quote(self, side: str, outcome: str) -> bool:
    """
    Check if MM should place this quote.
    """
    if outcome == 'YES':
        current = self.yes_shares
    else:
        current = self.no_shares
    
    if side == 'BID':
        # Buying more - check if under limit
        return current < self.max_position
    else:
        # "Selling" = buying opposite
        opposite = self.no_shares if outcome == 'YES' else self.yes_shares
        return opposite < self.max_position
```

---

## 6. Bot Architecture

### 6.1 Main Loop

```python
import asyncio
from datetime import datetime

class MarketMakerBot:
    def __init__(self, config: dict):
        self.api = DegenTerminalAPI(config['api_key'])
        self.price_feed = PriceFeed(config['feeds'])
        self.quote_calc = QuoteCalculator(config['quoting'])
        self.inventory = InventoryManager(config['inventory'])
        
        self.markets = {}          # Active markets
        self.orders = {}           # Current open orders
        self.positions = {}        # Current positions
        
        self.running = False
    
    async def start(self):
        self.running = True
        
        # Start parallel tasks
        await asyncio.gather(
            self.price_feed_loop(),
            self.quote_update_loop(),
            self.fill_handler_loop(),
            self.market_monitor_loop()
        )
    
    async def price_feed_loop(self):
        """
        Receive real-time prices from exchanges.
        """
        async for price in self.price_feed.stream():
            self.current_prices[price['asset']] = price['value']
            self.last_price_update = datetime.now()
    
    async def quote_update_loop(self):
        """
        Update quotes every 100ms.
        """
        while self.running:
            try:
                await self.update_all_quotes()
            except Exception as e:
                log.error(f"Quote update failed: {e}")
            
            await asyncio.sleep(0.1)  # 100ms
    
    async def update_all_quotes(self):
        """
        Recalculate and update quotes for all active markets.
        """
        for market_id, market in self.markets.items():
            # Skip if market closing soon
            if market['seconds_to_expiry'] < 30:
                await self.cancel_market_orders(market_id)
                continue
            
            # Get current price
            current_price = self.current_prices.get(market['asset'])
            if not current_price:
                continue
            
            # Calculate fair value
            fair_value = calculate_fair_value(
                current_price=current_price,
                strike_price=market['strike'],
                time_to_expiry=market['seconds_to_expiry'],
                volatility=self.get_volatility(market['asset'])
            )
            
            # Get inventory for this market
            position = self.positions.get(market_id, {'yes': 0, 'no': 0})
            skew = self.inventory.calculate_skew(position['yes'], position['no'])
            
            # Calculate quotes
            quotes = self.quote_calc.calculate_quotes(fair_value)
            quotes = self.inventory.apply_skew(quotes, skew)
            
            # Update orders
            await self.update_market_orders(market_id, quotes)
    
    async def update_market_orders(self, market_id: str, quotes: dict):
        """
        Cancel stale orders and place new ones.
        """
        current_orders = self.orders.get(market_id, [])
        
        # Determine which orders need updating
        orders_to_cancel = []
        orders_to_place = []
        
        # Simple approach: cancel all, replace all
        # (Production would diff and only update changed)
        for order in current_orders:
            orders_to_cancel.append(order['id'])
        
        for bid in quotes['bids']:
            orders_to_place.append({
                'market': market_id,
                'side': 'bid',
                'outcome': 'yes',
                'price': bid['price'],
                'size': bid['size']
            })
        
        for ask in quotes['asks']:
            orders_to_place.append({
                'market': market_id,
                'side': 'ask',
                'outcome': 'yes',
                'price': ask['price'],
                'size': ask['size']
            })
        
        # Execute cancels then places
        await self.api.cancel_orders(orders_to_cancel)
        new_orders = await self.api.place_orders(orders_to_place)
        
        self.orders[market_id] = new_orders
```

### 6.2 Configuration

```python
CONFIG = {
    'api_key': 'your_jwt_token',
    
    'feeds': {
        'binance': {
            'ws_url': 'wss://stream.binance.com:9443/ws',
            'symbols': ['btcusdt', 'ethusdt', 'solusdt']
        },
    },
    
    'quoting': {
        'spread': 0.04,           # 4 cent total spread
        'size': 100,              # contracts per level
        'levels': 3,              # depth on each side
        'spacing': 0.01           # 1 cent between levels
    },
    
    'inventory': {
        'max_position': 1000,     # max contracts per outcome
        'skew_factor': 0.02,      # max 2 cent skew
        'close_threshold': 30     # seconds before expiry to stop quoting
    },
    
    'risk': {
        'max_markets': 10,        # max concurrent markets
        'max_daily_loss': 1000,   # USD, stop if exceeded
        'min_spread': 0.02        # never quote tighter than 2 cents
    }
}
```

---

## 7. Risk Management

### 7.1 Pre-Trade Checks

```python
def pre_trade_check(self, order: dict) -> bool:
    """
    Validate order before placing.
    """
    # Check daily loss limit
    if self.daily_pnl < -self.config['risk']['max_daily_loss']:
        log.warning("Daily loss limit reached, stopping")
        return False
    
    # Check position limits
    if not self.inventory.should_quote(order['side'], order['outcome']):
        log.warning(f"Position limit reached for {order['outcome']}")
        return False
    
    # Check spread minimum
    if order['side'] == 'ask':
        best_bid = self.get_best_bid(order['market'])
        if best_bid and (order['price'] - best_bid) < self.config['risk']['min_spread']:
            log.warning("Spread too tight")
            return False
    
    return True
```

### 7.2 Settlement Handling

```python
async def on_market_resolved(self, market_id: str, outcome: str):
    """
    Handle market resolution.
    """
    position = self.positions.get(market_id)
    if not position:
        return
    
    # Calculate P&L
    if outcome == 'YES':
        pnl = position['yes'] * 1.0 - position['yes_cost']
        pnl -= position['no_cost']  # NO shares worth $0
    else:
        pnl = position['no'] * 1.0 - position['no_cost']
        pnl -= position['yes_cost']  # YES shares worth $0
    
    self.daily_pnl += pnl
    log.info(f"Market {market_id} settled. P&L: ${pnl:.2f}")
    
    # Clean up
    del self.positions[market_id]
    del self.orders[market_id]
```

---

## 8. Multi-Market Strategy

### 8.1 Market Selection

```python
def select_markets(self, available_markets: list) -> list:
    """
    Choose which markets to provide liquidity.
    """
    selected = []
    
    for market in available_markets:
        # Skip if already at max markets
        if len(selected) >= self.config['risk']['max_markets']:
            break
        
        # Skip if closing soon
        if market['seconds_to_expiry'] < 60:
            continue
        
        # Prefer markets with more time (more trading opportunity)
        # Prefer markets we don't have large exposure in
        score = self.calculate_market_score(market)
        
        selected.append((score, market))
    
    # Sort by score, return top N
    selected.sort(reverse=True)
    return [m for _, m in selected[:self.config['risk']['max_markets']]]
```

### 8.2 Cross-Market Hedging (Future)

```
If MM is long YES on BTC-5m-12:00 and short YES on BTC-5m-12:05,
the exposure partially cancels out (both depend on BTC direction).

Future enhancement: Track net exposure across all markets.
```

---

## 9. Monitoring & Alerts

### 9.1 Key Metrics

```python
METRICS = {
    'pnl_realized': Gauge('mm_pnl_realized', 'Realized P&L'),
    'pnl_unrealized': Gauge('mm_pnl_unrealized', 'Unrealized P&L'),
    'position_yes': Gauge('mm_position_yes', 'YES shares held'),
    'position_no': Gauge('mm_position_no', 'NO shares held'),
    'orders_open': Gauge('mm_orders_open', 'Open orders'),
    'fills_count': Counter('mm_fills_total', 'Total fills'),
    'quote_updates': Counter('mm_quote_updates', 'Quote update count'),
}
```

### 9.2 Alerts

| Condition | Alert |
|-----------|-------|
| Daily loss > 50% of limit | Warning |
| Daily loss > 100% of limit | Critical, stop trading |
| Position > 80% of limit | Warning |
| No fills in 10 minutes | Check connectivity |
| Price feed stale > 5s | Stop quoting |

---

## 10. Future Improvements

- [ ] **Smarter fair value:** Use implied volatility surface, not flat vol
- [ ] **Order flow signals:** Detect informed traders, widen spread
- [ ] **Cross-market hedging:** Net exposure across timeframes
- [ ] **Dynamic spread:** Widen in high volatility, tighten when quiet
- [ ] **Maker rebates:** If platform adds maker rebates, factor into pricing
- [ ] **Multiple price sources:** Arbitrage between Binance/Coinbase
- [ ] **Backtesting framework:** Test strategies on historical data

---

## 11. Quick Start

```bash
# 1. Install dependencies
pip install websockets aiohttp scipy

# 2. Set environment variables
export DEGEN_API_KEY="your_jwt_token"
export DEGEN_WALLET_KEY="your_private_key"

# 3. Run the bot
python mm_bot.py --config config.yaml
```

**Minimum Viable MM:**
```python
# Simplest possible MM - quote fixed spread around mid
async def simple_mm():
    api = DegenAPI()
    
    while True:
        markets = await api.get_markets(status='OPEN')
        
        for market in markets:
            mid = (market['yes_price'] + (1 - market['no_price'])) / 2
            
            await api.place_order(market['id'], 'bid', 'yes', mid - 0.02, 100)
            await api.place_order(market['id'], 'ask', 'yes', mid + 0.02, 100)
        
        await asyncio.sleep(1)
```

---

## Orderbook Display: Option 3 Implemented ✅

### Design Decision
We implemented **Option 3: Single YES-Focused Book** as it provides the simplest UX for binary markets.

### Current Implementation (`SingleOrderbook.tsx`)
```
          ORDER BOOK
  Size    ABOVE    BELOW    Total
  ─────────────────────────────────
  100     $0.62    $0.38    100    ← Asks (sells)
  100     $0.64    $0.36    200
  ────────── SPREAD $0.04 ──────────
  100     $0.58    $0.42    100    ← Bids (buys)
  100     $0.56    $0.44    200
```

**Key Features:**
- Shows YES (ABOVE) prices in green, NO (BELOW) prices in red
- NO price is always calculated as `1 - YES price` (implied)
- Clicking a price level sets it as limit price in the trade panel
- Real-time updates via WebSocket with flash animations
- Spread indicator between bids and asks

### Why Option 3?
| Option | Pros | Cons |
|--------|------|------|
| Full (4 lists) | Complete info | Redundant, overwhelming |
| Bids Only | Shows demand | Hides liquidity |
| **YES-Focused** ✅ | Simple, intuitive | Industry standard |

### Key Insight: Sell YES ≈ Buy NO
| User Action | Economically Equivalent To |
|-------------|---------------------------|
| Sell YES | Reduces YES exposure (or increases NO) |
| Buy NO | Increases NO exposure |
| Bid YES @ 0.60 | Willing to take YES risk at 60% implied prob |
| Bid NO @ 0.40 | Willing to take NO risk at 40% implied prob |

