#!/bin/bash
RELAYER="7sxA2RCuQfFBihTc6L3aPkktEUXwFYabehHPVeFmHYUm"
HELIUS="https://devnet.helius-rpc.com/?api-key=b4d0d438-5540-455d-a24e-5563f1807102"
echo "Checking balance..."
curl -s -X POST "$HELIUS" \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$RELAYER\"]}"
echo ""
echo "Trying airdrop..."
curl -s -X POST "$HELIUS" \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"requestAirdrop\",\"params\":[\"$RELAYER\", 2000000000]}"
echo ""
sleep 5
echo "Trying another..."
curl -s -X POST "$HELIUS" \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"requestAirdrop\",\"params\":[\"$RELAYER\", 2000000000]}"
echo ""
sleep 10
echo "Final balance:"
curl -s -X POST "$HELIUS" \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"getBalance\",\"params\":[\"$RELAYER\"]}"
echo ""
