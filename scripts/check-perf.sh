#!/bin/bash
curl -s "http://localhost:4000/perf/status/$1" | python3 -m json.tool 2>/dev/null || curl -s "http://localhost:4000/perf/status/$1"
