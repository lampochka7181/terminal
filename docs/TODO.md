# Project Roadmap: Degen Terminal

## Phase 1: Infrastructure & Setup ✅
- [x] **Init Monorepo:** Set up TurboRepo with pnpm workspaces.
  - `apps/web` (Next.js)
  - `apps/api` (Fastify)
  - `packages/contracts` (Solana Smart Contract)
  - `packages/types` (Shared TypeScript types)
- [x] **Shared Types:** TypeScript types in `packages/types`.
- [x] **Database:** Supabase PostgreSQL + Redis (docker-compose for local).
- [x] **Environment Config:** `.env.example` template created.

## Phase 2: Smart Contract (The Core) 🔄
- [x] **Data Structures:** Define `Market`, `Position`, `GlobalState` structs in Rust.
  - Added `MarketStatus`, `MarketOutcome`, `Side`, `Outcome`, `OrderType` enums
  - Added `MarketVault` account for USDC storage
  - Added constants for price bounds, size limits, decimals
- [x] **Instructions:**
  - [x] `initialize_global`: One-time setup (admin, fees, treasury).
  - [x] `initialize_market`: Create Market PDA with vault (ATA).
  - [x] `place_order`: Validate order params (price, size, tick, expiry).
  - [x] `execute_match`: Atomic trade with token transfers and fee collection.
  - [x] `resolve_market`: Set market outcome based on final price.
  - [x] `settle_positions`: Batch payout with PDA signer.
  - [x] `pause_protocol`: Emergency stop + fee updates + admin transfer.
- [x] **Fee Collection:** Implemented in `execute_match` (maker/taker fees).
- [x] **Order Constraints:** Validate min/max size ($0.01-$0.99), tick size ($0.01).
- [x] **Self-Trade Prevention:** Check in `execute_match`.
- [x] **Security Audit Fixes:** See `docs/SECURITY_AUDIT.md` for details.
  - [x] Fixed Settlement PDA seeds mismatch (P0)
  - [x] Added vault account validation (P1)
  - [x] Added user USDC owner validation (P1)
  - [x] Added market account constraints (P1)
  - [x] Added fee_recipient validation (P1)
  - [x] Added order expiry validation in execute_match (P2)
  - [x] Fixed total_trades overflow potential (P2)
- [ ] **Tests:** Write TypeScript tests to simulate a full trade cycle on Localnet.
- [ ] **Build & Deploy:** Install Anchor, build contract, deploy to localnet.

## Phase 3: Backend (The Relayer) ✅
- [x] **API Setup:** Fastify server with typed routes.
  - [x] Database layer (Drizzle ORM + Supabase PostgreSQL)
  - [x] Redis connection for orderbook cache
  - [x] Market routes (list, get, orderbook, trades)
  - [x] Order routes (place, cancel, get)
  - [x] User routes (balance, positions, orders, settlements)
- [x] **Auth:** Implement SIWS (Sign-In With Solana) & JWT generation + refresh.
  - [x] Nonce generation with expiry
  - [x] Ed25519 signature verification
  - [x] JWT token issuance and refresh
  - [x] Auth middleware for protected routes
- [x] **Orderbook Engine:**
  - [x] Implement Redis Orderbook (Bids/Asks sorted sets).
  - [x] Implement Matching Algorithm (Price/Time priority).
  - [x] Implement sequence ID for orderbook updates (WS sync).
  - [x] Self-trade prevention check before matching.
- [x] **Transaction Builder:**
  - [x] Create logic to bundle Maker+Taker instructions into one Solana Tx.
  - [x] Implement retry logic with exponential backoff.
  - [x] Handle tx failure scenarios (revert order status).
  - [x] Settlement transaction support.
- [x] **Cron Jobs (Keeper):**
  - [x] Market Creator (Every 5m, 15m, 1h, 4h).
  - [x] Market Resolver (Check expiry + fetch final price).
  - [x] Position Settler (Batch payout winners after resolution).
  - [x] Order Expirer (Cancel orders T-2s before market close).
  - [x] Stale Order Cleaner (Cancel expired GTT orders).
- [x] **Error Handling:** Standardized error codes and responses.
- [x] **Rate Limiting:** Rate limits per endpoint type (100/min public, 300/min auth).
- [x] **WebSocket Server:** 
  - [x] Heartbeat/ping-pong (30s timeout).
  - [x] Auth for user-specific channels (JWT verification).
  - [x] Reconnection with sequence gap detection.
  - [x] Broadcasting functions (orderbook, trades, prices, fills, settlements).
- [x] **Health Checks:** `/health` endpoint for all service dependencies.
- [x] **Price Feed:** Real-time prices from Coinbase WebSocket.
  - [x] BTC, ETH, SOL price streaming
  - [x] Redis caching for market creator/resolver
  - [x] WebSocket broadcast to frontend
- [x] **MM Bot (Basic):** Market maker providing base liquidity.
  - [x] Fair value calculation (simplified Black-Scholes for binary options).
  - [x] Basic two-sided quoting with configurable spread.
  - [x] Inventory management with skew adjustment.
  - [x] Auto-cancel before market expiry.
  - [x] Position tracking and limits.

## Phase 4: Frontend (The UI)
- [ ] **Scaffold:** Next.js + Tailwind + shadcn/ui.
- [ ] **Wallet:** Integrate `@solana/wallet-adapter`.
- [ ] **Market Data:** Connect to WebSocket feed for live Orderbook.
- [ ] **Charts:** Integrate TradingView Lightweight Charts.
- [ ] **Trading Form:**
  - "Buy YES" / "Buy NO" buttons.
  - Sign Order logic (Ed25519).
  - Order confirmation modal.
- [ ] **User Dashboard:**
  - Positions view with P&L.
  - Order history.
  - Trade history.
  - Balance display.
- [ ] **Market Selector:** Asset tabs (BTC/ETH/SOL) + Timeframe selection.

## Phase 5: Testing & Devnet
- [ ] **Devnet Deployment:** Deploy program to Solana Devnet.
- [ ] **API Deployment:** Deploy backend to Railway/Render (staging).
- [ ] **Integration Tests:** End-to-end tests (place order → match → settle).
- [ ] **Load Testing:** Stress test orderbook and matching engine.
- [ ] **Bug Bounty (Internal):** Team testing with fake USDC.

## Phase 6: Security & Audit
- [ ] **Code Review:** Internal security review of smart contract.
- [ ] **External Audit:** Engage auditing firm for Anchor program.
- [ ] **Penetration Testing:** API security testing.
- [ ] **Rate Limit Hardening:** DDoS protection setup.

## Phase 7: Monitoring & Observability
- [ ] **Logging:** Structured logging (Pino/Winston) with log levels.
- [ ] **Metrics:** Prometheus metrics for API latency, orderbook depth, match rate.
- [ ] **Alerting:** PagerDuty/Discord alerts for keeper failures, low liquidity.
- [ ] **Dashboard:** Grafana dashboard for system health.

## Phase 8: Mainnet Launch
- [ ] **Mainnet Deployment:** Deploy program to Solana Mainnet.
- [ ] **DNS & SSL:** Production domain setup.
- [ ] **MM Bot (Full):** Production market maker with inventory management.
- [ ] **Launch:** Go live with limited markets (BTC-5m, ETH-5m).

---

## Future Features (Post-Launch)

### Margin & Leverage Trading (v2)
*Not in initial launch, but architecture should support future integration.*

- [ ] **Collateral System Design:**
  - Define collateral requirements (e.g., 20% margin = 5x leverage).
  - Support USDC as primary collateral.
  - Plan for cross-margin vs isolated margin modes.

- [ ] **Liquidation Engine:**
  - Define liquidation threshold (e.g., margin ratio < 5%).
  - Implement liquidation bot/keeper.
  - Partial liquidation vs full liquidation logic.
  - Liquidation penalty fee (to incentivize liquidators).

- [ ] **Funding & Interest:**
  - Design funding rate mechanism (if perpetual-style).
  - Interest rates for borrowed capital.

- [ ] **Risk Management:**
  - Position limits per user.
  - Open interest limits per market.
  - Insurance fund for socialized losses.

- [ ] **Regulatory Considerations:**
  - Geo-blocking requirements.
  - KYC/AML for leveraged products.

### Fee Structure Enhancements (v2)
- [ ] **Volume-Based Tiers:** Lower fees for high-volume traders.
- [ ] **Native Token Discounts:** DEGEN token for fee discounts (if tokenomics planned).
- [ ] **Referral Program:** Fee sharing for referrals.
- [ ] **Subscription Model:** Zero-fee tier for monthly subscribers.

### Trustless Infrastructure (v2)
- [ ] **Decentralized Matching:** Move matching logic on-chain (trade-off: higher latency/cost).

### Additional Features (Backlog)
- [ ] **Mobile App:** React Native companion app.
- [ ] **Advanced Order Types:** Stop-loss, take-profit, trailing stop.
- [ ] **Social Features:** Leaderboards, copy trading.
- [ ] **More Assets:** Add forex, commodities, stock indices.
- [ ] **Longer Timeframes:** Daily, weekly markets.

---

## Fee Structure Reference

### Industry Benchmarks (2024)

| Platform | Maker Fee | Taker Fee | Notes |
|----------|-----------|-----------|-------|
| **Binance** | 0.10% | 0.10% | 25% off with BNB |
| **Binance Futures** | 0.02% | 0.04% | Lower for derivatives |
| **Coinbase Advanced** | 0.40% | 0.60% | Volume tiers down to 0% |
| **Polymarket** | 0% | 0% | Free trading, earns on spread |
| **Kalshi** | 0% | 0% | Event contracts, regulated |

### Our Initial Fee Structure
| Action | Maker | Taker | Rationale |
|--------|-------|-------|-----------|
| Trading | 0.00% | 0.10% | Incentivize liquidity provision |
| Settlement | 0% | 0% | Don't tax winnings |

**Revenue Model:**
- Primary: Taker fees (0.10% × volume)
- Secondary: Spread from house MM bot
- Future: Premium features, token utility

### Fee Implementation Notes
- Fees collected in USDC at trade execution
- Fees sent to protocol treasury PDA
- Fee rate stored on-chain in GlobalState (upgradable by admin)
