#!/bin/bash

# Ensure we are in the root directory
cd "$(dirname "$0")" || exit

echo "----------------------------------------"
echo "🌊 DEGEN TERMINAL - START FRESH"
echo "----------------------------------------"

# 1. Start Redis
echo "🚀 Starting Redis container..."
docker-compose up -d redis

# 1b. Flush Redis to clear stale BullMQ jobs, orderbook cache, etc.
echo "🗑️  Flushing Redis..."
docker-compose exec -T redis redis-cli FLUSHALL 2>/dev/null || redis-cli FLUSHALL 2>/dev/null || echo "⚠️  Could not flush Redis (non-fatal)"

# 2. Wipe and Initialize Database
echo "🗑️  Wiping and re-initializing database..."
pnpm --filter @degen/api run db:reset

# 3. Start Backend and Frontend
echo "🛰️  Starting API and Web in development mode..."
echo "----------------------------------------"
pnpm dev



