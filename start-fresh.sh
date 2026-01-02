#!/bin/bash

# Ensure we are in the root directory
cd "$(dirname "$0")" || exit

echo "----------------------------------------"
echo "🌊 DEGEN TERMINAL - START FRESH"
echo "----------------------------------------"

# 1. Start Redis
echo "🚀 Starting Redis container..."
docker-compose up -d redis

# 2. Wipe and Initialize Database
echo "🗑️  Wiping and re-initializing database..."
pnpm --filter @degen/api run db:reset

# 3. Start Backend and Frontend
echo "🛰️  Starting API and Web in development mode..."
echo "----------------------------------------"
pnpm dev



