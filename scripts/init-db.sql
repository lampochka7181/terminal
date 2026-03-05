-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create custom types
CREATE TYPE order_side AS ENUM ('BID', 'ASK');
CREATE TYPE order_outcome AS ENUM ('YES', 'NO');
CREATE TYPE order_type AS ENUM ('LIMIT', 'MARKET', 'IOC', 'FOK');
CREATE TYPE order_status AS ENUM ('OPEN', 'PARTIAL', 'FILLED', 'CANCELLED');
CREATE TYPE market_status AS ENUM ('OPEN', 'CLOSED', 'RESOLVED', 'SETTLED', 'SETTLEMENT_FAILED');
CREATE TYPE tx_status AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');
CREATE TYPE ledger_type AS ENUM ('DEPOSIT', 'WITHDRAW', 'TRADE', 'SETTLE', 'FEE');

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address VARCHAR(44) UNIQUE NOT NULL,
    nonce VARCHAR(64),
    nonce_expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    last_login_at TIMESTAMP,
    total_volume DECIMAL(20,6) DEFAULT 0,
    total_trades INTEGER DEFAULT 0,
    fee_tier SMALLINT DEFAULT 0,
    is_banned BOOLEAN DEFAULT FALSE,
    metadata JSONB,
    -- Agent API fields
    is_agent BOOLEAN DEFAULT FALSE,
    agent_name VARCHAR(100),
    fee_discount_pct SMALLINT DEFAULT 0,
    agent_metadata JSONB
);

CREATE INDEX idx_users_wallet ON users(wallet_address);

-- Markets table
CREATE TABLE markets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pubkey VARCHAR(44) UNIQUE NOT NULL,
    asset VARCHAR(10) NOT NULL,
    timeframe VARCHAR(10) NOT NULL,
    strike_price DECIMAL(20,8) NOT NULL,
    final_price DECIMAL(20,8),
    created_at TIMESTAMP DEFAULT NOW(),
    expiry_at TIMESTAMP NOT NULL,
    resolved_at TIMESTAMP,
    settled_at TIMESTAMP,
    status market_status DEFAULT 'OPEN',
    outcome VARCHAR(10),
    total_volume DECIMAL(20,6) DEFAULT 0,
    total_trades INTEGER DEFAULT 0,
    open_interest DECIMAL(20,6) DEFAULT 0,
    yes_price DECIMAL(10,6),
    no_price DECIMAL(10,6)
);

CREATE INDEX idx_markets_status ON markets(status);
CREATE INDEX idx_markets_asset_expiry ON markets(asset, expiry_at);
CREATE INDEX idx_markets_expiry ON markets(expiry_at) WHERE status = 'OPEN';
-- Optimized index for getMarkets query (excludes SETTLED, orders by created_at)
CREATE INDEX idx_markets_active_created ON markets(status, created_at DESC) WHERE status != 'SETTLED';
-- Optimized for default getMarkets() query: WHERE status != 'SETTLED' ORDER BY created_at DESC
CREATE INDEX idx_markets_not_settled_created ON markets(created_at DESC) WHERE status != 'SETTLED';
-- Optimized for getMarkets(asset=X) queries with status exclusion
CREATE INDEX idx_markets_asset_status_created ON markets(asset, status, created_at DESC) WHERE status != 'SETTLED';
-- Optimized for pending market activation: WHERE status = 'OPEN' AND strike_price = '0'
CREATE INDEX idx_markets_pending_activation ON markets(status) WHERE status = 'OPEN' AND strike_price = '0';

-- Orders table
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_order_id BIGINT NOT NULL,
    market_id UUID REFERENCES markets(id),
    user_id UUID REFERENCES users(id),
    side order_side NOT NULL,
    outcome order_outcome NOT NULL,
    order_type order_type DEFAULT 'LIMIT',
    price DECIMAL(10,6) NOT NULL,
    size DECIMAL(20,6) NOT NULL,
    filled_size DECIMAL(20,6) DEFAULT 0,
    remaining_size DECIMAL(20,6),
    status order_status DEFAULT 'OPEN',
    signature TEXT,
    encoded_instruction TEXT,
    binary_message TEXT,
    is_mm_order BOOLEAN DEFAULT FALSE NOT NULL,
    is_agent_order BOOLEAN DEFAULT FALSE NOT NULL,
    -- Dollar-based market orders: original USD amount requested (e.g., $25)
    dollar_amount DECIMAL(20,6),
    -- Leverage fields (for displaying leverage info before margin account exists)
    leverage DECIMAL(4,2) DEFAULT 1,
    margin_amount DECIMAL(20,6),
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    cancelled_at TIMESTAMP,
    cancel_reason VARCHAR(50)
);

CREATE INDEX idx_orders_market_status ON orders(market_id, status);
CREATE INDEX idx_orders_user_status ON orders(user_id, status);
CREATE INDEX idx_orders_book ON orders(market_id, outcome, side, price, created_at) 
    WHERE status IN ('OPEN', 'PARTIAL');
CREATE UNIQUE INDEX uq_orders_client_id ON orders(user_id, client_order_id);

-- Trades table
CREATE TABLE trades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_id UUID REFERENCES markets(id),
    maker_order_id UUID REFERENCES orders(id),
    taker_order_id UUID REFERENCES orders(id),
    maker_user_id UUID REFERENCES users(id),
    taker_user_id UUID REFERENCES users(id),
    
    -- Taker's perspective
    taker_side order_side NOT NULL,
    taker_outcome order_outcome NOT NULL,
    taker_price DECIMAL(10,6) NOT NULL,
    taker_notional DECIMAL(20,6) NOT NULL,
    taker_fee DECIMAL(20,6) NOT NULL,
    
    -- Maker's perspective
    maker_outcome order_outcome NOT NULL,
    maker_price DECIMAL(10,6) NOT NULL,
    maker_notional DECIMAL(20,6) NOT NULL,
    maker_fee DECIMAL(20,6) DEFAULT 0,

    -- Common fields
    size DECIMAL(20,6) NOT NULL,
    tx_signature VARCHAR(88),
    tx_status tx_status DEFAULT 'PENDING',
    error_code VARCHAR(50),
    executed_at TIMESTAMP DEFAULT NOW(),
    confirmed_at TIMESTAMP,

    -- Legacy fields
    outcome order_outcome,
    price DECIMAL(10,6),
    notional DECIMAL(20,6)
);

CREATE INDEX idx_trades_market ON trades(market_id, executed_at DESC);
CREATE INDEX idx_trades_maker ON trades(maker_user_id, executed_at DESC);
CREATE INDEX idx_trades_taker ON trades(taker_user_id, executed_at DESC);
CREATE INDEX idx_trades_pending ON trades(tx_status) WHERE tx_status = 'PENDING';

-- Positions table
CREATE TABLE positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    market_id UUID REFERENCES markets(id),
    pubkey VARCHAR(44) UNIQUE,
    yes_shares DECIMAL(20,6) DEFAULT 0,
    no_shares DECIMAL(20,6) DEFAULT 0,
    avg_entry_yes DECIMAL(10,6),
    avg_entry_no DECIMAL(10,6),
    total_cost DECIMAL(20,6) DEFAULT 0,
    realized_pnl DECIMAL(20,6) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'OPEN',
    payout DECIMAL(20,6),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    settled_at TIMESTAMP,
    UNIQUE(user_id, market_id)
);

CREATE INDEX idx_positions_user ON positions(user_id, status);
CREATE INDEX idx_positions_market ON positions(market_id, status);
CREATE INDEX idx_positions_unsettled ON positions(market_id) WHERE status = 'OPEN';

-- Settlements table
CREATE TABLE settlements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    position_id UUID REFERENCES positions(id),
    user_id UUID REFERENCES users(id),
    market_id UUID REFERENCES markets(id),
    outcome VARCHAR(10) NOT NULL,
    winning_shares DECIMAL(20,6) NOT NULL,
    payout_amount DECIMAL(20,6) NOT NULL,
    profit DECIMAL(20,6) NOT NULL,
    tx_signature VARCHAR(88),
    tx_status tx_status DEFAULT 'PENDING',
    batch_id UUID,
    created_at TIMESTAMP DEFAULT NOW(),
    confirmed_at TIMESTAMP,
    UNIQUE(position_id, market_id)
);

CREATE INDEX idx_settlements_user ON settlements(user_id, created_at DESC);
CREATE INDEX idx_settlements_market ON settlements(market_id);
CREATE INDEX idx_settlements_pending ON settlements(tx_status) WHERE tx_status = 'PENDING';

-- Balance ledger table
CREATE TABLE balance_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    type ledger_type NOT NULL,
    amount DECIMAL(20,6) NOT NULL,
    balance_before DECIMAL(20,6) NOT NULL,
    balance_after DECIMAL(20,6) NOT NULL,
    reference_type VARCHAR(20),
    reference_id UUID,
    tx_signature VARCHAR(88),
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ledger_user ON balance_ledger(user_id, created_at DESC);
CREATE INDEX idx_ledger_type ON balance_ledger(user_id, type);

-- Market snapshots table (OHLCV)
CREATE TABLE market_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_id UUID REFERENCES markets(id),
    outcome order_outcome NOT NULL,
    interval VARCHAR(10) NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    open DECIMAL(10,6),
    high DECIMAL(10,6),
    low DECIMAL(10,6),
    close DECIMAL(10,6),
    volume DECIMAL(20,6) DEFAULT 0,
    trades INTEGER DEFAULT 0,
    UNIQUE(market_id, outcome, interval, timestamp)
);

CREATE INDEX idx_snapshots_market ON market_snapshots(market_id, outcome, interval, timestamp DESC);

-- =============================================
-- LEVERAGE TABLES
-- =============================================

-- Margin Account Status Enum
CREATE TYPE margin_account_status AS ENUM ('OPEN', 'LIQUIDATED', 'CLOSED');

-- Margin Transaction Type Enum
CREATE TYPE margin_tx_type AS ENUM ('DEPOSIT', 'WITHDRAW');

-- Lending Pool Table
CREATE TABLE lending_pool (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address VARCHAR(44) NOT NULL,
    total_deposited DECIMAL(20,6) DEFAULT 0,
    total_loaned DECIMAL(20,6) DEFAULT 0,
    available DECIMAL(20,6) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Insurance Fund Table
CREATE TABLE insurance_fund (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address VARCHAR(44) NOT NULL,
    balance DECIMAL(20,6) DEFAULT 0,
    total_received DECIMAL(20,6) DEFAULT 0,
    total_paid_out DECIMAL(20,6) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Margin Accounts Table (one per leveraged position)
CREATE TABLE margin_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    position_id UUID NOT NULL REFERENCES positions(id),
    market_id UUID NOT NULL REFERENCES markets(id),
    side VARCHAR(10) NOT NULL,
    shares DECIMAL(20,6) NOT NULL,
    entry_price DECIMAL(10,6) NOT NULL,
    margin_deposited DECIMAL(20,6) NOT NULL,
    loan_amount DECIMAL(20,6) NOT NULL,
    leverage DECIMAL(4,2) NOT NULL,
    liquidation_price DECIMAL(10,6) NOT NULL,
    status margin_account_status DEFAULT 'OPEN',
    -- On-chain tracking (for race condition prevention)
    -- NULL on_chain_confirmed_at = position not yet confirmed on-chain
    on_chain_tx_signature VARCHAR(88),
    on_chain_confirmed_at TIMESTAMP,
    -- Liquidation lock (set when liquidation starts, blocks user sells)
    -- NULL = not being liquidated, timestamp = liquidation in progress
    liquidating_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_margin_accounts_user ON margin_accounts(user_id);
CREATE INDEX idx_margin_accounts_status ON margin_accounts(status);
CREATE INDEX idx_margin_accounts_market ON margin_accounts(market_id);
CREATE INDEX idx_margin_accounts_confirmed ON margin_accounts(on_chain_confirmed_at) WHERE status = 'OPEN';
-- Compound index for liquidation checker: WHERE status = 'OPEN' AND on_chain_confirmed_at IS NOT NULL
CREATE INDEX idx_margin_accounts_open_confirmed ON margin_accounts(status, on_chain_confirmed_at) WHERE status = 'OPEN';

-- Liquidations Table
CREATE TABLE liquidations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    margin_account_id UUID NOT NULL REFERENCES margin_accounts(id),
    user_id UUID NOT NULL REFERENCES users(id),
    market_id UUID NOT NULL REFERENCES markets(id),
    trigger_price DECIMAL(10,6) NOT NULL,
    execution_price DECIMAL(10,6) NOT NULL,
    shares_liquidated DECIMAL(20,6) NOT NULL,
    proceeds DECIMAL(20,6) NOT NULL,
    loan_repaid DECIMAL(20,6) NOT NULL,
    penalty DECIMAL(20,6) NOT NULL,
    returned_to_user DECIMAL(20,6) NOT NULL,
    bad_debt DECIMAL(20,6) DEFAULT 0,
    tx_signature VARCHAR(88),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_liquidations_user ON liquidations(user_id);
CREATE INDEX idx_liquidations_margin_account ON liquidations(margin_account_id);

-- Margin Transactions Table (deposits/withdrawals)
CREATE TABLE margin_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    margin_account_id UUID NOT NULL REFERENCES margin_accounts(id),
    user_id UUID NOT NULL REFERENCES users(id),
    type margin_tx_type NOT NULL,
    amount DECIMAL(20,6) NOT NULL,
    loan_before DECIMAL(20,6) NOT NULL,
    loan_after DECIMAL(20,6) NOT NULL,
    liq_price_before DECIMAL(10,6) NOT NULL,
    liq_price_after DECIMAL(10,6) NOT NULL,
    tx_signature VARCHAR(88),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_margin_transactions_account ON margin_transactions(margin_account_id);
CREATE INDEX idx_margin_transactions_user ON margin_transactions(user_id);

-- MM Market Metrics Table (tracks MM performance per market)
CREATE TABLE mm_market_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_id UUID NOT NULL REFERENCES markets(id),
    
    -- Position at settlement
    yes_shares DECIMAL(20,6) DEFAULT 0,
    no_shares DECIMAL(20,6) DEFAULT 0,
    
    -- P&L (calculated as negative of sum of user P&L - zero sum market)
    total_pnl DECIMAL(20,6) NOT NULL,
    
    -- Volume stats
    trades_count INTEGER DEFAULT 0,
    volume_traded DECIMAL(20,6) DEFAULT 0,
    
    -- Market outcome
    outcome order_outcome,
    
    -- Timing
    settled_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_mm_market_metrics_market ON mm_market_metrics(market_id);
CREATE INDEX idx_mm_market_metrics_settled ON mm_market_metrics(settled_at DESC);

-- Views
CREATE VIEW v_orderbook AS
SELECT 
    market_id,
    outcome,
    side,
    price,
    SUM(remaining_size) as total_size,
    COUNT(*) as order_count
FROM orders
WHERE status IN ('OPEN', 'PARTIAL')
GROUP BY market_id, outcome, side, price
ORDER BY 
    CASE WHEN side = 'BID' THEN price END DESC,
    CASE WHEN side = 'ASK' THEN price END ASC;

CREATE VIEW v_user_portfolio AS
SELECT 
    u.id as user_id,
    u.wallet_address,
    COALESCE(SUM(CASE WHEN p.status = 'OPEN' THEN p.total_cost END), 0) as locked_value,
    COALESCE(SUM(p.realized_pnl), 0) as realized_pnl,
    COUNT(DISTINCT CASE WHEN p.status = 'OPEN' THEN p.market_id END) as open_positions
FROM users u
LEFT JOIN positions p ON u.id = p.user_id
GROUP BY u.id, u.wallet_address;

-- Relayer pool wallets (Phase 6)
CREATE TABLE relayer_wallets (
  pubkey TEXT PRIMARY KEY,
  secret_key TEXT NOT NULL,
  balance_lamports BIGINT DEFAULT 0,
  active_jobs INT DEFAULT 0,
  total_submitted INT DEFAULT 0,
  total_failed INT DEFAULT 0,
  consecutive_failures INT DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'cooldown', 'disabled')),
  cooldown_until TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_relayer_wallets_selection ON relayer_wallets (status, active_jobs) WHERE status = 'active';

-- Settlement jobs for parallel batch settlement (Phase 7)
CREATE TABLE settlement_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL,
  batch_index INT NOT NULL,
  recipients JSONB NOT NULL,
  amounts JSONB NOT NULL,
  proofs JSONB NOT NULL,
  status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUBMITTED', 'COMPLETED', 'FAILED')),
  relayer_pubkey TEXT,
  tx_signature TEXT,
  attempts INT DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (market_id, batch_index)
);
CREATE INDEX idx_settlement_jobs_market ON settlement_jobs (market_id, status);
CREATE INDEX idx_settlement_jobs_pending ON settlement_jobs (status) WHERE status = 'PENDING';

-- Chat messages for live chatroom (Supabase Realtime)
CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read" ON chat_messages FOR SELECT USING (true);
CREATE POLICY "Anyone can insert" ON chat_messages FOR INSERT WITH CHECK (true);
ALTER publication supabase_realtime ADD TABLE chat_messages;
CREATE INDEX idx_chat_messages_created ON chat_messages (created_at);
GRANT SELECT, INSERT ON chat_messages TO anon;
GRANT SELECT, INSERT ON chat_messages TO authenticated;

-- =============================================
-- MIGRATIONS (for existing databases only)
-- These are safe to re-run (IF NOT EXISTS).
-- New installs get these columns from CREATE TABLE above.
-- =============================================

-- Agent API columns (2026-02-23)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_agent BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS fee_discount_pct SMALLINT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_metadata JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_agent_order BOOLEAN DEFAULT FALSE NOT NULL;

-- Grant permissions (for local dev)
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres;



