#!/bin/bash
curl -s -X POST http://localhost:4000/perf/start \
  -H 'Content-Type: application/json' \
  -d '{"orderCount":2000,"durationMs":120000,"dollarPerOrder":25}' | python3 -m json.tool
