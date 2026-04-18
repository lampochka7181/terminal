-- Performance indexes to prevent DB pool exhaustion
-- Run this script against your database to add missing indexes

-- 1. CRITICAL: Partial index for getMarkets() default query
-- The default query excludes SETTLED markets: WHERE status != 'SETTLED' ORDER BY created_at DESC
-- Without this index, the query does a table scan as SETTLED markets accumulate
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_markets_not_settled_created
ON markets (created_at DESC)
WHERE status != 'SETTLED';

-- 2. Compound index for filtered active markets queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_markets_active_created
ON markets (status, created_at DESC)
WHERE status != 'SETTLED';

-- 3. Index for pending market activation query
-- Optimizes: SELECT * FROM markets WHERE status = 'OPEN' AND strike_price = '0'
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_markets_pending_activation
ON markets (status)
WHERE status = 'OPEN' AND strike_price = '0';

-- Verify indexes were created
SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'markets'
AND indexname LIKE 'idx_%'
ORDER BY indexname;
