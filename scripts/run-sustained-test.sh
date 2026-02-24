#!/bin/bash
curl -s -X POST http://localhost:4000/perf/full-pipeline \
  -H "Content-Type: application/json" \
  -d '{"orderCount":5000,"durationMs":300000,"dollarPerOrder":10,"concurrency":50,"preferredTimeframe":"5m","pacePerSec":10}'
