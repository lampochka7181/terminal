# Degen Terminal MCP Server

An MCP (Model Context Protocol) server that lets AI agents trade on Degen Terminal prediction markets. Supports Claude Desktop, Cursor, and any MCP-compatible client.

## Overview

The MCP server exposes the Degen Terminal API as a set of tools that an AI agent can call. Agents can browse markets, check prices, manage their portfolio, and place/cancel orders — all through natural conversation.

**Available tools:**

| Category | Tools | Wallet required? |
|---|---|---|
| Market data | `get_prices`, `list_markets`, `get_market`, `get_orderbook` | No |
| Account | `get_balance`, `get_positions`, `get_trades`, `get_orders`, `get_account_status` | Yes |
| Trading | `place_order`, `cancel_order`, `cancel_all_orders`, `setup_delegation` | Yes |
| Auth | `authenticate_wallet`, `get_auth_status` | — |

Read-only market tools work immediately. Account and trading tools require a Solana wallet loaded either at startup (via env var) or at runtime (via `authenticate_wallet`).

## Prerequisites

- Node.js 18+
- The Degen Terminal API server running (default: `http://localhost:4000`)
- A Solana wallet with USDC for trading

## Installation

```bash
# From the repo root
cd packages/mcp
pnpm install
pnpm build
```

The compiled server will be at `dist/index.js`.

## Configuration

| Env var | Required | Description |
|---|---|---|
| `WALLET_PRIVATE_KEY` | No | Base58-encoded Solana wallet private key. If provided, the server authenticates on startup. |
| `API_URL` | No | Degen Terminal API URL. Defaults to `http://localhost:4000`. |
| `AGENT_NAME` | No | Display name for this agent session (used in server logs). Defaults to `mcp-agent`. |
| `DELEGATION_AMOUNT` | No | USDC amount to pre-authorize on startup. If set and the wallet is not already delegated (or the current delegation is below this amount), an on-chain `approve` transaction is sent automatically. Skipped if omitted. |
| `SOLANA_RPC_URL` | No | Override the Solana RPC endpoint. Defaults to the value from the API's `/config` endpoint. |

## Connecting from Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "degen-terminal": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js"],
      "env": {
        "WALLET_PRIVATE_KEY": "your-base58-private-key",
        "API_URL": "http://localhost:4000",
        "AGENT_NAME": "claude-desktop"
      }
    }
  }
}
```

Restart Claude Desktop after saving. The Degen Terminal tools will appear in the tools panel.

## Connecting from Cursor

Add to your Cursor MCP config (`.cursor/mcp.json` or global settings):

```json
{
  "mcpServers": {
    "degen-terminal": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js"],
      "env": {
        "WALLET_PRIVATE_KEY": "your-base58-private-key",
        "API_URL": "http://localhost:4000"
      }
    }
  }
}
```

## Running Standalone

For testing or debugging:

```bash
# With wallet configured via env
WALLET_PRIVATE_KEY=your-key API_URL=http://localhost:4000 node dist/index.js

# Without wallet (read-only market tools only)
API_URL=http://localhost:4000 node dist/index.js
```

The server communicates over stdio and logs status messages to stderr.

## Available Tools

### Read-only (no wallet needed)

**`get_prices`**
Get current crypto prices (BTC, ETH, SOL) from the platform price feed.

---

**`list_markets`**
List active prediction markets with current prices and volumes.

Parameters:
- `asset` (optional) — `BTC`, `ETH`, or `SOL`
- `status` (optional) — `OPEN`, `CLOSED`, or `RESOLVED` (default: `OPEN`)
- `timeframe` (optional) — e.g. `1H`, `4H`, `1D`

---

**`get_market`**
Get detailed information about a specific market.

Parameters:
- `address` (required) — market on-chain address (pubkey)

---

**`get_orderbook`**
Get the current orderbook for a market.

Parameters:
- `address` (required) — market on-chain address (pubkey)

---

### Account (wallet required)

**`get_account_status`**
Get wallet address, on-chain USDC balance, delegation status, and platform balance. Good first call to check everything is ready before trading.

**`get_balance`**
Get USDC balance breakdown: total, available, and locked in open orders/positions.

**`get_positions`**
Get all open positions across all markets — shares held, entry prices, current P&L.

**`get_orders`**
Get open/pending orders.

**`get_trades`**
Get recent trade history.

Parameters:
- `limit` (optional) — number of trades to return (default: 20, max: 100)

---

### Trading (wallet required)

**`place_order`**
Place a buy or sell order on a prediction market. Agents receive reduced trading fees automatically.

Parameters:
- `marketAddress` (required) — market on-chain address
- `side` (required) — `bid` to buy, `ask` to sell
- `outcome` (required) — `yes` or `no`
- `type` (optional) — `limit` or `market` (default: `limit`)
- `price` (required) — price per contract ($0.01–$0.99)
- `size` (required) — number of contracts (0.001–100000)
- `dollarAmount` (optional) — total dollar amount for market orders ($0.02–$1,000,000)

Returns: `orderId`, `status`, `fills`, `filledSize`, `avgPrice`, `position`

---

**`cancel_order`**
Cancel a specific open order.

Parameters:
- `orderId` (required) — order UUID

---

**`cancel_all_orders`**
Cancel all open orders, optionally filtered to a single market.

Parameters:
- `marketAddress` (optional) — only cancel orders in this market

---

**`setup_delegation`**
Authorize the platform relayer to execute trades using your USDC. Creates an on-chain `approve` transaction. Must be done once before placing orders.

Parameters:
- `amount` (required) — USDC amount to authorize (e.g. `1000` for $1,000)

---

### Auth

**`authenticate_wallet`**
Load a Solana wallet into the session and authenticate with the API. Use this if you did not provide `WALLET_PRIVATE_KEY` at startup.

Parameters:
- `privateKey` (required) — Base58-encoded Solana wallet private key
- `agentName` (optional) — display name for this agent session

---

**`get_auth_status`**
Check whether a wallet is loaded and whether the session is authenticated.

## Wallet Setup

There are two ways to load a wallet:

### Option 1: Env var at startup (recommended for production)

Set `WALLET_PRIVATE_KEY` in the MCP server config. The server authenticates on startup and is ready for all tools immediately.

```json
"env": {
  "WALLET_PRIVATE_KEY": "5xK2...your-private-key"
}
```

### Option 2: Runtime via `authenticate_wallet` (interactive sessions)

Start the server without a wallet env var. Market tools work immediately. When the agent needs to trade, call:

```
authenticate_wallet(privateKey: "5xK2...your-private-key", agentName: "my-agent")
```

This is useful when the user wants to provide their key interactively rather than storing it in config.

> **Security note:** Keep private keys out of logs and version control. Prefer environment variables over hardcoding.

## Trading Flow

A complete trading session looks like this:

**1. Check account status**
```
get_account_status()
```
Returns wallet, USDC balance, and whether delegation is active.

**2. Set up delegation (first time only)**

If `isDelegated` is false or `delegatedAmount` is too low:
```
setup_delegation(amount: 500)
```
This submits a Solana transaction approving the relayer to spend 500 USDC on your behalf.

**3. Find a market**
```
list_markets(asset: "BTC", timeframe: "1H")
```
Pick a market from the results and note its `address`.

**4. Check the orderbook (optional)**
```
get_orderbook(address: "AbCd...market-pubkey")
```
See current bids and asks to inform your price.

**5. Place an order**
```
place_order(
  marketAddress: "AbCd...market-pubkey",
  side: "bid",
  outcome: "yes",
  price: 0.65,
  size: 10
)
```
Buys 10 YES contracts at $0.65 each ($6.50 total).

**6. Monitor positions**
```
get_positions()
```

**7. Exit a position**

Sell your YES shares back with an ask order:
```
place_order(
  marketAddress: "AbCd...market-pubkey",
  side: "ask",
  outcome: "yes",
  price: 0.80,
  size: 10
)
```

## Example Conversations

**Browsing markets (no wallet needed):**

> User: What BTC markets are available?

The agent calls `list_markets(asset: "BTC")` and summarizes the results — strike prices, current YES/NO prices, expiry times.

---

**Checking account before trading:**

> User: Is my account ready to trade?

The agent calls `get_account_status()`. If `isDelegated` is false, it explains that `setup_delegation` is needed. If balance is zero, it notes the wallet needs USDC funding.

---

**Placing a trade:**

> User: Buy $50 worth of YES on the BTC 70k 1H market

The agent:
1. Calls `list_markets(asset: "BTC", timeframe: "1H")` to find the market address
2. Calls `get_orderbook(address: "...")` to see the best ask price
3. Calls `place_order(marketAddress: "...", side: "bid", outcome: "yes", type: "market", dollarAmount: 50)` (or a limit order near the ask)
4. Reports the fill: avg price, contracts received, position value

---

**Managing risk:**

> User: Cancel all my open orders and close my BTC position

The agent:
1. Calls `cancel_all_orders()` to pull open orders
2. Calls `get_positions()` to find the BTC market address and share count
3. Calls `place_order(..., side: "ask", ...)` to sell the position at market

## Development

```bash
# Type check
npx tsc --noEmit

# Build
pnpm build

# Watch mode
npx tsc --watch
```

The source is in `src/`. Tool implementations are in `src/tools/`. Add new tools by creating handlers in the appropriate file and registering them in `src/index.ts`.
