#!/bin/bash
RELAYER="7sxA2RCuQfFBihTc6L3aPkktEUXwFYabehHPVeFmHYUm"
echo "Trying Solana faucet API..."
curl -s -X POST "https://faucet.solana.com/api/fund" \
  -H 'Content-Type: application/json' \
  -d "{\"walletAddress\":\"$RELAYER\",\"network\":\"devnet\",\"amount\":5}"
echo ""
sleep 2
echo "Trying alternate faucet..."
curl -s -X POST "https://faucet-devnet.solflare.com/" \
  -H 'Content-Type: application/json' \
  -d "{\"pubkey\":\"$RELAYER\"}"
echo ""
sleep 2
echo "Checking balance..."
curl -s -X POST https://api.devnet.solana.com \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$RELAYER\"]}"
echo ""
