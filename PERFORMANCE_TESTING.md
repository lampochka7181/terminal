# Performance Testing Guide

## Overview

End-to-end performance testing for the full order → match → on-chain execution → settlement → payout pipeline.

The test creates real Solana transactions on mainnet using funded test wallets, exercises the Redis matching engine, BullMQ job queues, and the Merkle settlement system.

## Prerequisites

| Requirement | Details |
|---|---|
| **Node.js** | v20+ (via NVM) |
| **Redis** | Running locally on port 6379 |
| **Helius RPC** | Dev plan recommended (50+ RPS) |
| **Funding Wallet** | Must hold SOL + USDC for test wallet funding |
| **Environment** | `.env` configured with all required keys |

### Required `.env` Variables

```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
FUNDING_WALLET_PRIVATE_KEY=<base58 private key with SOL + USDC>
RELAYER_PRIVATE_KEY=<base58 relayer private key>
USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
SUPABASE_URL=<your supabase url>
SUPABASE_SERVICE_KEY=<your supabase service role key>
```

### Funding Requirements (per test scale)

| Scale | Test Users | USDC Needed | SOL Needed |
|---|---|---|---|
| Small | 50 | ~$25,000 | ~1 SOL |
| Medium | 200 | ~$100,000 | ~3 SOL |
| Large | 500 | ~$250,000 | ~6 SOL |

Formula: `USDC = users × $500`, `SOL = users × 0.01 + relayers × 0.15`

---

## Step 1: Generate and Fund Test Wallets

```bash
# From project root (in WSL)
cd /mnt/c/Users/<you>/degen_terminal

# Generate and fund 200 test wallets ($500 USDC + 0.01 SOL each)
node scripts/setup-full-pipeline-test.mjs 200
```

This script:
1. Resets stale relayer state in DB
2. Generates wallets and saves to `scripts/test-wallets.json`
3. Funds each wallet with SOL (for ATA creation) and USDC ($500)
4. Delegates USDC to the relayer (so it can execute trades on behalf of users)
5. Registers users in Supabase DB

To re-fund existing wallets without regenerating:
```bash
node scripts/fund-test-wallets.mjs 200
```

---

## Step 2: Start the API Server

```bash
# Start with performance test mode enabled
PERF_TEST_MODE=true pnpm dev --filter=@degen/api
```

`PERF_TEST_MODE=true` enables:
- Deep MM bot liquidity (20 levels × 100K contracts)
- Performance test API routes at `/perf/*`
- Test wallet loading from `scripts/test-wallets.json`

Wait for the server to fully start (look for `Server running on http://0.0.0.0:4000`).

---

## Step 3: Run the Performance Test

### Quick Test (20 orders, ~5 minutes)

```bash
bash scripts/run-full-pipeline-test.sh 20 120000 25
# Args: orderCount durationMs dollarPerOrder
```

### Medium Test (200 orders, 50 users)

```bash
curl -s -X POST http://localhost:4000/perf/full-pipeline \
  -H "Content-Type: application/json" \
  -d '{"orderCount":200,"durationMs":300000,"dollarPerOrder":25}' | python3 -m json.tool
```

### Large Test (2000 orders, 200 users, concurrent)

```bash
curl -s -X POST http://localhost:4000/perf/full-pipeline \
  -H "Content-Type: application/json" \
  -d '{
    "orderCount": 2000,
    "durationMs": 600000,
    "dollarPerOrder": 10,
    "concurrency": 5,
    "preferredTimeframe": "1h"
  }' | python3 -m json.tool
```

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `orderCount` | 200 | Total orders to submit across all users |
| `durationMs` | 60000 | Time window to spread order submission over |
| `dollarPerOrder` | 25 | USD amount per order |
| `concurrency` | 1 | Number of orders submitted in parallel |
| `preferredTimeframe` | `5m` | Market timeframe to target (`5m`, `15m`, `1h`, `4h`) |

### Choosing Parameters

- **orderCount / wallets** = orders per user (e.g., 2000 orders / 200 wallets = 10 per user)
- **durationMs / orderCount** = interval between orders (lower = faster throughput)
- **concurrency** > 1 enables parallel order submission (recommended for 200+ orders)
- Use `preferredTimeframe: "1h"` for large tests — 5m markets are too short for 200+ orders
- **dollarPerOrder** × **orderCount** must not exceed total USDC across all wallets

---

## Step 4: Monitor the Test

### Check Status

```bash
curl -s http://localhost:4000/perf/status/<testId> | python3 -m json.tool
```

The response includes:
- `progress`: orders submitted / total
- `metrics.ordersMatched`: successful matches
- `metrics.latency`: P50/P95/P99/avg match latency
- `onChainMetrics`: confirmed/failed/pending on-chain TXs
- `timeline`: order submission → market close → settlement timestamps
- `perUserPayoutMs`: time from settlement to each user receiving USDC

### Watch Server Logs

In a separate terminal, watch for key events:
```bash
# Match confirmations
grep "match success" <log output>

# Settlement progress
grep "MerkleSettler" <log output>

# Errors
grep "ERROR\|FAILED\|429" <log output>
```

---

## Step 5: Analyze Results

### Key Metrics to Track

| Metric | Target | Description |
|---|---|---|
| **Match Rate** | 100% | `ordersMatched / ordersSubmitted` |
| **Match Latency P50** | < 3s | Redis match + DB persist |
| **On-chain Confirm Rate** | 100% | All matched trades confirmed on Solana |
| **Settlement Time** | 2-6s | Time from market close to USDC in wallets |
| **Orders/sec** | > 1/s | Sustained throughput |

### Interpreting Timeline

```
orderSubmissionStart → orderSubmissionEnd    # Phase 1: Order matching
orderSubmissionEnd → marketClosed            # Idle: waiting for market expiry
marketClosed → settlementStart               # Market resolver runs
settlementStart → settlementEnd              # Merkle settlement pipeline
```

The critical user-facing metric is **settlement time** — how quickly users receive USDC after the market closes. Target: 2-6 seconds.

---

## Troubleshooting

### `Market expires in Xs — need at least 60s`
Wait for the next market cycle or use `preferredTimeframe: "1h"` for longer markets.

### `429 Too Many Requests` from Helius
- Upgrade to Helius Dev plan (50+ RPS)
- Reduce `concurrency`
- Set `SOLANA_EXECUTION_RPC_URL` to a second Helius API key

### `MarketNotResolved` errors in MerkleSettler
Old broken markets from previous tests. They auto-fail after 10 cycles. Or manually fix:
```sql
UPDATE markets SET status = 'SETTLEMENT_FAILED' WHERE id = '<market_id>';
DELETE FROM settlement_jobs WHERE market_id = '<market_id>';
```

### `Transaction too large: XXXX > 1232`
Batch settlement has too many recipients per TX. This is auto-handled by the batching system (15 recipients per batch). If it persists, check for markets with unusually many positions.

### `Invalid Mint` errors
The market's NO mint was not created (Phase 2 failure). Fixed by the Phase 2 retry logic. Restart the server to pick up the fix.

### Orders failing with DB timeout
Increase Supabase connection pool limit or reduce `concurrency`.

---

## Architecture Notes

### Pipeline Stages

```
User Order → Redis Matching Engine → BullMQ: onchain-submit → Solana TX
                                   → BullMQ: db-sync → PostgreSQL
                                   → BullMQ: ws-events → WebSocket

Market Expiry → Market Resolver → Merkle Tree Builder → PostMerkleRoot TX
             → BatchSettleV2 TXs → Burn Shares → Finalize Market
             → DB Sync → WebSocket Settlement Events
```

### Rate Limits (Helius Dev Plan)

| Resource | Limit | Our Usage |
|---|---|---|
| RPC requests | ~50/s | ~15-20/s at concurrency=10 |
| sendTransaction | ~50/s | ~3/s (rate-limited by BullMQ) |
| Websocket connections | N/A | Not used for RPC |

### BullMQ Worker Settings

| Queue | Concurrency | Rate Limit | Retries |
|---|---|---|---|
| `onchain-submit` | 10 | 3/s | 3 |
| `db-sync` | 10 | — | 5 |
| `ws-events` | 10 | — | 1 |
