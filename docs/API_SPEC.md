# API Specification

**Base URL:** `https://api.degenterminal.com/v1`
**WebSocket:** `wss://api.degenterminal.com/v1/ws`

---

## 0. System Endpoints

### `GET /health`
Health check for load balancers and monitoring.
- **Response:**
```json
{
  "status": "ok",
  "timestamp": 1709999999,
  "version": "1.0.0",
  "services": {
    "database": "ok",
    "redis": "ok",
    "solana": "ok"
  }
}
```

### `GET /time`
Server time (for clock sync).
- **Response:**
```json
{
  "serverTime": 1709999999000
}
```

---

## 1. Authentication (SIWS)

### `GET /auth/nonce`
Generates a random nonce for the user to sign.
- **Query Params:** `address` (Solana Pubkey)
- **Response:**
```json
{
  "nonce": "SignIn with DegenTerminal: 839201..."
}
```

### `POST /auth/verify`
Verifies the signature and issues a JWT.
- **Body:**
```json
{
  "address": "So111...",
  "signature": "base58_signature...",
  "message": "The full message string signed"
}
```
- **Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1Ni...",
  "expiresAt": 1710086399
}
```

### `POST /auth/refresh`
Refresh an expiring JWT (must call before expiry).
- **Headers:** `Authorization: Bearer <token>`
- **Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1Ni...",
  "expiresAt": 1710172799
}
```

### `POST /auth/logout`
Invalidate current session.
- **Headers:** `Authorization: Bearer <token>`
- **Response:**
```json
{
  "success": true
}
```

---

## 2. Market Data (Snapshots)
*Use these for initial page load. Use Websockets for live updates.*

### `GET /markets`
List active markets.
- **Query Params:** `asset` (BTC, ETH, SOL), `status` (OPEN, CLOSED, RESOLVED), `timeframe` (5m, 15m, 1h, 4h)
- **Response:**
```json
[
  {
    "id": "uuid",
    "address": "So111...",
    "asset": "BTC",
    "timeframe": "5m",
    "strike": 95000.00,
    "expiry": 1709999999,
    "status": "OPEN",
    "volume24h": 125000.00,
    "yesPrice": 0.42,
    "noPrice": 0.58
  }
]
```

### `GET /markets/:address`
Get detailed info for a single market.
- **Response:**
```json
{
  "id": "uuid",
  "address": "So111...",
  "asset": "BTC",
  "timeframe": "5m",
  "strike": 95000.00,
  "expiry": 1709999999,
  "status": "OPEN",
  "outcome": null,
  "totalVolume": 500000.00,
  "openInterest": 12500,
  "createdAt": 1709996399
}
```

### `GET /markets/:address/orderbook`
Get the initial **Snapshot** of the book.
- **Response:**
```json
{
  "bids": [[0.40, 1000], [0.39, 5000]],
  "asks": [[0.42, 2000], [0.45, 1000]],
  "midPrice": 0.41,
  "spread": 0.02,
  "sequenceId": 1054
}
```

### `GET /markets/:address/trades`
Get recent trade history for a market.
- **Query Params:** `limit` (default: 50, max: 200), `before` (cursor for pagination)
- **Response:**
```json
{
  "trades": [
    {
      "id": "uuid",
      "price": 0.42,
      "size": 100,
      "outcome": "yes",
      "side": "buy",
      "timestamp": 1709999000,
      "txSignature": "5K2x..."
    }
  ],
  "nextCursor": "uuid-of-last-trade"
}
```

### `GET /prices`
Get current prices for all supported assets.
- **Response:**
```json
{
  "BTC": {
    "price": 95432.50,
    "timestamp": 1709999999,
    "source": "binance"
  },
  "ETH": {
    "price": 3245.80,
    "timestamp": 1709999999,
    "source": "binance"
  },
  "SOL": {
    "price": 142.35,
    "timestamp": 1709999999,
    "source": "binance"
  }
}
```

### `GET /stats`
Get platform-wide statistics.
- **Response:**
```json
{
  "totalVolume24h": 2500000.00,
  "totalTrades24h": 15420,
  "activeMarkets": 48,
  "totalUsers": 3200
}
```

---

## 3. WebSocket Feed (Real-time)

### Connect: `wss://api.degenterminal.com/ws`

### Messages

**Subscribe to Orderbook:**
```json
{ "op": "subscribe", "channel": "orderbook", "market": "So111..." }
```

**Subscribe to Trades:**
```json
{ "op": "subscribe", "channel": "trades", "market": "So111..." }
```

**Subscribe to Prices:**
```json
{ "op": "subscribe", "channel": "prices", "assets": ["BTC", "ETH", "SOL"] }
```

**Orderbook Update (Delta):**
```json
{
  "channel": "orderbook",
  "market": "So111...",
  "data": {
    "bids": [[0.40, 1200]],
    "asks": [],
    "sequenceId": 1055
  }
}
```

**Trade Update:**
```json
{
  "channel": "trades",
  "market": "So111...",
  "data": {
    "price": 0.42,
    "size": 100,
    "outcome": "yes",
    "side": "buy",
    "timestamp": 1709999000
  }
}
```

**Price Update:**
```json
{
  "channel": "prices",
  "data": {
    "asset": "BTC",
    "price": 95432.50,
    "timestamp": 1709999999
  }
}
```

**Market Resolved:**
```json
{
  "channel": "market",
  "market": "So111...",
  "event": "resolved",
  "data": {
    "outcome": "yes",
    "finalPrice": 95500.00,
    "strikePrice": 95000.00,
    "resolvedAt": 1709999999
  }
}
```

**Position Settled (User-specific, requires auth):**
```json
{
  "channel": "user",
  "event": "settlement",
  "data": {
    "marketAddress": "So111...",
    "outcome": "yes",
    "yourShares": 100,
    "payout": 100.00,
    "profit": 55.00,
    "newBalance": 1055.00,
    "txSignature": "5K2x..."
  }
}
```

**Heartbeat (Keep-Alive):**
Client must send ping every 30 seconds to maintain connection.
```json
{ "op": "ping" }
```
Server responds:
```json
{ "op": "pong", "serverTime": 1709999999 }
```
*Connection closes after 60s without ping.*

**Reconnection & Gap Fill:**
When reconnecting, client should:
1. Resubscribe to channels
2. Request snapshot with last known `sequenceId`
3. Server sends full snapshot if gap detected

```json
{ "op": "snapshot", "channel": "orderbook", "market": "So111...", "lastSeqId": 1050 }
```

**Authentication for User Channel:**
To subscribe to personal events (settlements, order fills):
```json
{ "op": "auth", "token": "eyJhbGciOiJIUzI1Ni..." }
```
Response:
```json
{ "op": "auth", "status": "authenticated", "wallet": "So111..." }
```

**Order Fill Notification (User-specific):**
```json
{
  "channel": "user",
  "event": "fill",
  "data": {
    "orderId": "uuid",
    "marketAddress": "So111...",
    "side": "bid",
    "outcome": "yes",
    "price": 0.42,
    "filledSize": 50,
    "remainingSize": 50,
    "status": "partial",
    "timestamp": 1709999000
  }
}
```

---

## 4. Trading (Authenticated)

### `POST /orders`
Place a signed order.
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
```json
{
  "marketAddress": "So111...",
  "side": "bid",
  "outcome": "yes",
  "type": "limit",
  "price": 400000,
  "size": 1000000,
  "expiry": 1790000,
  "signature": "base58_signature_of_instruction",
  "encodedInstruction": "base64_instruction_data"
}
```
- **Response:**
```json
{
  "orderId": "uuid",
  "status": "open",
  "createdAt": 1709999000
}
```

### `DELETE /orders/:id`
Cancel an open order.
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
```json
{
  "signature": "base58_cancel_signature"
}
```
- **Response:**
```json
{
  "orderId": "uuid",
  "status": "cancelled"
}
```

### `DELETE /orders`
Cancel all open orders (emergency kill switch).
- **Headers:** `Authorization: Bearer <token>`
- **Query Params:** `marketAddress` (optional - cancel only for specific market)
- **Body:**
```json
{
  "signature": "base58_cancel_all_signature"
}
```
- **Response:**
```json
{
  "cancelledCount": 5,
  "orderIds": ["uuid1", "uuid2", "uuid3", "uuid4", "uuid5"]
}
```

### `GET /orders/:id`
Get details of a specific order.
- **Headers:** `Authorization: Bearer <token>`
- **Response:**
```json
{
  "id": "uuid",
  "marketAddress": "So111...",
  "side": "bid",
  "outcome": "yes",
  "type": "limit",
  "price": 0.40,
  "size": 100,
  "filledSize": 50,
  "remainingSize": 50,
  "status": "partial",
  "createdAt": 1709999000,
  "updatedAt": 1709999500
}
```

---

## 5. User Data (Authenticated)

### `GET /user/balance`
Get user's USDC balance (deposited, available, locked in orders).
- **Headers:** `Authorization: Bearer <token>`
- **Response:**
```json
{
  "total": 10000.00,
  "available": 7500.00,
  "lockedInOrders": 2500.00,
  "pendingSettlement": 0.00
}
```

### `GET /user/positions`
Get all open positions (on-chain + unsettled matches).
- **Headers:** `Authorization: Bearer <token>`
- **Query Params:** `status` (open, settled, all)
- **Response:**
```json
[
  {
    "marketAddress": "So111...",
    "market": "BTC-5m-1709999999",
    "yesShares": 100,
    "noShares": 0,
    "avgEntryPrice": 0.45,
    "currentPrice": 0.52,
    "unrealizedPnL": 7.00,
    "status": "open"
  }
]
```

### `GET /user/orders`
Get active and past orders.
- **Headers:** `Authorization: Bearer <token>`
- **Query Params:** `status` (open, filled, cancelled, all), `limit`, `offset`
- **Response:**
```json
{
  "orders": [
    {
      "id": "uuid",
      "marketAddress": "So111...",
      "market": "BTC-5m",
      "side": "bid",
      "outcome": "yes",
      "price": 0.40,
      "size": 100,
      "filledSize": 50,
      "status": "partial",
      "createdAt": 1709999000
    }
  ],
  "total": 150,
  "limit": 20,
  "offset": 0
}
```

### `GET /user/trades`
Get user's trade history.
- **Headers:** `Authorization: Bearer <token>`
- **Query Params:** `limit`, `offset`, `from` (timestamp), `to` (timestamp)
- **Response:**
```json
{
  "trades": [
    {
      "id": "uuid",
      "orderId": "uuid",
      "marketAddress": "So111...",
      "market": "BTC-5m",
      "side": "buy",
      "outcome": "yes",
      "price": 0.42,
      "size": 50,
      "fee": 0.021,
      "timestamp": 1709999000,
      "txSignature": "5K2x..."
    }
  ],
  "total": 500,
  "limit": 20,
  "offset": 0
}
```

### `GET /user/settlements`
Get history of auto-settled positions.
- **Headers:** `Authorization: Bearer <token>`
- **Query Params:** `limit`, `offset`
- **Response:**
```json
{
  "settlements": [
    {
      "marketAddress": "So111...",
      "market": "BTC-5m-1709999999",
      "outcome": "yes",
      "yourPosition": "yes",
      "shares": 100,
      "payout": 100.00,
      "profit": 55.00,
      "settledAt": 1709999999,
      "txSignature": "5K2x..."
    }
  ],
  "total": 25
}
```

*Note: Settlements are automatic. When a market resolves, winnings are instantly transferred to your wallet. No claim action required.*

---

## 6. Fee Schedule

### Current Fee Structure

| Action | Maker Fee | Taker Fee |
|--------|-----------|-----------|
| Trade  | 0.00%     | 0.10%     |

**Notes:**
- Fees are charged on the notional value of the trade
- Maker = adds liquidity (limit order that rests on book)
- Taker = removes liquidity (market order or crossing limit)
- Settlement/claim is free (no fee on winnings)

### `GET /fees`
Get current fee schedule.
- **Response:**
```json
{
  "trading": {
    "makerFee": 0.0000,
    "takerFee": 0.0010
  },
  "settlement": {
    "claimFee": 0.0000
  },
  "discounts": {
    "volumeTiers": [
      { "minVolume": 0, "makerDiscount": 0, "takerDiscount": 0 },
      { "minVolume": 100000, "makerDiscount": 0, "takerDiscount": 0.10 },
      { "minVolume": 1000000, "makerDiscount": 0, "takerDiscount": 0.25 }
    ]
  }
}
```

---

## 7. Error Handling

### Error Response Format
All errors follow this structure:
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable description",
    "details": {}
  }
}
```

### Error Codes

| HTTP | Code | Description |
|------|------|-------------|
| 400 | `INVALID_REQUEST` | Malformed request body |
| 400 | `INVALID_SIGNATURE` | Signature verification failed |
| 400 | `INVALID_PRICE` | Price out of valid range (0.01-0.99) |
| 400 | `INVALID_SIZE` | Size below minimum (1) or above maximum (100,000) |
| 400 | `INVALID_TICK` | Price not on tick grid ($0.01 increments) |
| 400 | `ORDER_EXPIRED` | Order expiry timestamp has passed |
| 401 | `UNAUTHORIZED` | Missing or invalid JWT token |
| 401 | `TOKEN_EXPIRED` | JWT has expired, re-authenticate |
| 403 | `INSUFFICIENT_BALANCE` | Not enough USDC for this order |
| 403 | `POSITION_LIMIT_EXCEEDED` | Would exceed max position (500,000 contracts) |
| 403 | `ORDER_LIMIT_EXCEEDED` | Too many open orders (max 100 per market) |
| 404 | `MARKET_NOT_FOUND` | Market address does not exist |
| 404 | `ORDER_NOT_FOUND` | Order ID does not exist |
| 409 | `ORDER_ALREADY_FILLED` | Cannot cancel, order already filled |
| 409 | `MARKET_CLOSED` | Market no longer accepting orders |
| 409 | `MARKET_CLOSING` | Market closes in <30s, orders rejected |
| 409 | `DUPLICATE_ORDER` | Order with this client_order_id exists |
| 409 | `SELF_TRADE_PREVENTED` | Would match against your own order |
| 429 | `RATE_LIMITED` | Too many requests, slow down |
| 500 | `INTERNAL_ERROR` | Server error, try again |
| 503 | `SERVICE_UNAVAILABLE` | System maintenance |
| 503 | `PROTOCOL_PAUSED` | Trading halted by admin |

### Example Error Response
```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Your available balance of 50.00 USDC is less than the required 100.00 USDC for this order",
    "details": {
      "available": 50.00,
      "required": 100.00
    }
  }
}
```

---

## 8. Rate Limits

| Endpoint Type | Limit |
|---------------|-------|
| Public (markets, prices) | 100 req/min |
| Authenticated (orders, user) | 300 req/min |
| WebSocket messages | 50 msg/sec |

Rate limit headers included in responses:
```
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 295
X-RateLimit-Reset: 1709999999
```
