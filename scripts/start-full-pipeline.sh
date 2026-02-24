#!/bin/bash
curl -s -X POST http://localhost:4000/perf/full-pipeline \
  -H "Content-Type: application/json" \
  -d '{"orderCount": 100, "durationMs": 60000, "dollarPerOrder": 25}' | python3 -m json.tool
