#!/bin/bash
curl -s http://localhost:4000/perf/status/perf-full-1771005311138 | python3 -m json.tool 2>/dev/null || curl -s http://localhost:4000/perf/status/perf-full-1771005311138
