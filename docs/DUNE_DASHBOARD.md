# Dune Analytics Dashboard — Revenue Tracking

## Prerequisites
- Program must be deployed to **mainnet** (Dune does not index devnet)
- Program ID: `5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk`
- USDC Mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- Fee Recipient: set in GlobalState on-chain (the relayer wallet by default)

## How Fees Flow On-Chain
1. `execute_match_v2` — taker pays `taker_fee` USDC → vault → fee_recipient
2. `execute_close_v2` — seller pays `fee` USDC → vault → fee_recipient
3. Both emit Anchor events with fee amounts

## Approach: Track SPL Token Transfers to Fee Recipient
Simplest method — no instruction decoding. Dune indexes all SPL token transfers.

---

## Dashboard Queries

### 1. Total Protocol Revenue (All-Time)

```sql
-- Replace {{fee_recipient}} with your fee recipient wallet address
-- This tracks all USDC transfers INTO the fee recipient's ATA
-- from your program's market vaults

SELECT
  SUM(amount / 1e6) AS total_revenue_usd
FROM solana.token_transfers
WHERE to_owner = '{{fee_recipient}}'
  AND mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'  -- USDC
  AND executing_account = '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'  -- Your program
```

### 2. Daily Revenue

```sql
SELECT
  DATE_TRUNC('day', block_time) AS day,
  SUM(amount / 1e6) AS revenue_usd,
  COUNT(*) AS fee_transfers
FROM solana.token_transfers
WHERE to_owner = '{{fee_recipient}}'
  AND mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  AND executing_account = '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'
GROUP BY 1
ORDER BY 1 DESC
```

### 3. Total Trading Volume

```sql
-- Volume = all USDC flowing into market vaults (maker + taker deposits)
-- Filter: transfers TO an account owned by the program (vault PDAs)

SELECT
  SUM(amount / 1e6) AS total_volume_usd
FROM solana.token_transfers
WHERE mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  AND executing_account = '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'
  AND to_owner != '{{fee_recipient}}'  -- Exclude fee transfers
  AND from_owner != '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'  -- Only user deposits, not vault→vault
```

### 4. Daily Volume

```sql
SELECT
  DATE_TRUNC('day', block_time) AS day,
  SUM(amount / 1e6) AS volume_usd,
  COUNT(*) AS trades
FROM solana.token_transfers
WHERE mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  AND executing_account = '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'
  AND to_owner != '{{fee_recipient}}'
  AND from_owner != '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'
GROUP BY 1
ORDER BY 1 DESC
```

### 5. Unique Traders

```sql
SELECT
  COUNT(DISTINCT from_owner) AS unique_traders
FROM solana.token_transfers
WHERE mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  AND executing_account = '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'
  AND from_owner != '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'
  AND from_owner != '{{fee_recipient}}'
  AND from_owner != '{{relayer_wallet}}'
```

### 6. Daily Active Traders

```sql
SELECT
  DATE_TRUNC('day', block_time) AS day,
  COUNT(DISTINCT from_owner) AS active_traders
FROM solana.token_transfers
WHERE mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  AND executing_account = '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'
  AND from_owner != '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'
  AND from_owner != '{{fee_recipient}}'
  AND from_owner != '{{relayer_wallet}}'
GROUP BY 1
ORDER BY 1 DESC
```

### 7. Total Settlements Paid Out

```sql
-- Settlement payouts = USDC transferred from vault to users via batch_settle_v2
-- These are PDA-signed transfers from program-owned vaults

SELECT
  SUM(amount / 1e6) AS total_payouts_usd,
  COUNT(*) AS settlement_count
FROM solana.token_transfers
WHERE mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  AND executing_account = '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'
  AND from_owner = '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'  -- FROM program vault
  AND to_owner != '{{fee_recipient}}'  -- Not fee transfers
```

### 8. Revenue by Hour (for finding peak trading times)

```sql
SELECT
  EXTRACT(HOUR FROM block_time) AS hour_utc,
  SUM(amount / 1e6) AS revenue_usd,
  COUNT(*) AS trades
FROM solana.token_transfers
WHERE to_owner = '{{fee_recipient}}'
  AND mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  AND executing_account = '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'
GROUP BY 1
ORDER BY 1
```

---

## Setup Instructions

1. Go to [dune.com](https://dune.com) and create an account
2. Click "New Query" for each query above
3. Replace `{{fee_recipient}}` with your fee recipient wallet address
4. Replace `{{relayer_wallet}}` with your relayer wallet address
5. Save each query and add them to a new Dashboard
6. Recommended widgets:
   - **Counter**: Total Revenue (Query 1)
   - **Counter**: Total Volume (Query 3)
   - **Counter**: Unique Traders (Query 5)
   - **Bar Chart**: Daily Revenue (Query 2)
   - **Area Chart**: Daily Volume (Query 4)
   - **Line Chart**: Daily Active Traders (Query 6)
   - **Counter**: Total Payouts (Query 7)
   - **Bar Chart**: Revenue by Hour (Query 8)

## Parameters
All queries use the `executing_account` filter which ensures only transfers
from YOUR program's instructions are counted (not random USDC transfers).

## Notes
- Dune indexes mainnet only — these queries will return 0 on devnet
- Data lag: ~5-10 minutes behind real-time
- `solana.token_transfers` is a decoded table Dune maintains for all SPL transfers
- Fee amounts are in raw USDC units (6 decimals), divided by 1e6 for dollars
