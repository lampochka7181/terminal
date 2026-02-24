#!/bin/bash
RELAYER="7sxA2RCuQfFBihTc6L3aPkktEUXwFYabehHPVeFmHYUm"
HELIUS="https://devnet.helius-rpc.com/?api-key=b4d0d438-5540-455d-a24e-5563f1807102"

echo "Trying Helius airdrop..."
curl -s -X POST "$HELIUS" \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"requestAirdrop\",\"params\":[\"$RELAYER\", 2000000000]}"
echo ""
sleep 5
echo "Checking balance..."
curl -s -X POST https://api.devnet.solana.com \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$RELAYER\"]}"
echo ""

echo ""
echo "Also checking MM wallet balance..."
curl -s -X POST https://api.devnet.solana.com \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"EbppxpqqXbsyZMTUYJuXjCqehE7WajTUYf4nJ922FQhX\"]}"
echo ""
