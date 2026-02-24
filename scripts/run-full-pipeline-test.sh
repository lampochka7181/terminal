#!/bin/bash
# Full Pipeline Performance Test Trigger
set -e

ORDER_COUNT=${1:-50}
DURATION_MS=${2:-30000}
DOLLAR_PER_ORDER=${3:-10}
CONCURRENCY=${4:-1}
TIMEFRAME=${5:-5m}
PACE_PER_SEC=${6:-0}

echo "Starting full pipeline test: ${ORDER_COUNT} orders, ${DURATION_MS}ms, \$${DOLLAR_PER_ORDER}/order, ${CONCURRENCY}x concurrency, ${TIMEFRAME} timeframe, pace=${PACE_PER_SEC}/s"

curl -s -X POST http://localhost:4000/perf/full-pipeline \
  -H "Content-Type: application/json" \
  -d "{\"orderCount\":${ORDER_COUNT},\"durationMs\":${DURATION_MS},\"dollarPerOrder\":${DOLLAR_PER_ORDER},\"concurrency\":${CONCURRENCY},\"preferredTimeframe\":\"${TIMEFRAME}\",\"pacePerSec\":${PACE_PER_SEC}}" | python3 -m json.tool 2>/dev/null || echo "(raw response above)"

echo ""
echo "Test started! Monitor with:"
echo "  curl -s http://localhost:4000/perf/status/<testId> | python3 -m json.tool"
