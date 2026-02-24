#!/bin/bash
curl -s "http://localhost:4000/perf/status/perf-1770826371981" | python3 -m json.tool
