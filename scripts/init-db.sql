-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create custom types
CREATE TYPE order_side AS ENUM ('BID', 'ASK');
CREATE TYPE order_outcome AS ENUM ('YES', 'NO');
CREATE TYPE order_type AS ENUM ('LIMIT', 'MARKET', 'IOC', 'FOK');
CREATE TYPE order_status AS ENUM ('OPEN', 'PARTIAL', 'FILLED', 'CANCELLED');
CREATE TYPE market_status AS ENUM ('OPEN', 'CLOSED', 'RESOLVED', 'SETTLED');
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
    metadata JSONB
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
    confirmed_at TIMESTAMP
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

-- Grant permissions (for local dev)
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres;



