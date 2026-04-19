-- Add settlement_trees table for robust merkle batch settlement.
-- Run once against existing databases to migrate. Idempotent.
--
-- Why this table exists:
-- Once a merkle root is posted on-chain, the tree is immutable. Any retry
-- must use the same leaves and proofs; rebuilding from live positions/trades
-- after any partial settlement has already executed produces a different
-- tree whose leaves don't hash into the posted root. This table persists
-- the authoritative tree at post-root time so retries and crash recovery
-- can load from here instead of rebuilding.

CREATE TABLE IF NOT EXISTS settlement_trees (
  market_id UUID PRIMARY KEY REFERENCES markets(id),
  root TEXT NOT NULL,                        -- 64-char lowercase hex (32 bytes)
  total_amount NUMERIC(20,0) NOT NULL,       -- microUSDC
  total_leaves INT NOT NULL,
  padded_size INT NOT NULL,                  -- power of 2 ≥ total_leaves
  winner_outcome VARCHAR(3) NOT NULL,        -- 'YES' | 'NO'
  leaves JSONB NOT NULL,                     -- [{index, recipient, amountMicroUsdc, positionId, userId}]
  lookup_table_pubkey VARCHAR(44),           -- ALT used for batch settle versioned TXs (NULL = legacy TX path)
  posted_tx_signature VARCHAR(88),
  posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent column add for databases created before the ALT support landed.
ALTER TABLE settlement_trees ADD COLUMN IF NOT EXISTS lookup_table_pubkey VARCHAR(44);
