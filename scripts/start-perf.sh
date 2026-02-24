#!/bin/bash
# Start perf test with configurable params
# Usage: bash start-perf.sh [orderCount] [durationSec] [dollarPerOrder]
ORDER_COUNT=${1:-100}
DURATION_SEC=${2:-60}
DOLLAR_PER=${3:-25}
DURATION_MS=$((DURATION_SEC * 1000))

echo "Starting perf test: $ORDER_COUNT orders over ${DURATION_SEC}s..."
curl -s -X POST http://localhost:4000/perf/start \
  -H "Content-Type: application/json" \
  -d "{\"orderCount\":$ORDER_COUNT,\"durationMs\":$DURATION_MS,\"dollarPerOrder\":$DOLLAR_PER}" \
  --max-time 120
echo ""
