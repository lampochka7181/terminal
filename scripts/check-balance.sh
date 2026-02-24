#!/bin/bash
# Check relayer wallet balance on devnet
RELAYER="7sxA2RCuQfFBihTc6L3aPkktEUXwFYabehHPVeFmHYUm"
echo "Checking relayer balance..."
curl -s -X POST https://api.devnet.solana.com \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$RELAYER\"]}"
echo ""
echo "Checking recent TX..."
curl -s -X POST https://api.devnet.solana.com \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignaturesForAddress\",\"params\":[\"$RELAYER\",{\"limit\":3}]}"
