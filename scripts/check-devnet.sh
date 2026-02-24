#!/bin/bash
curl -s -X POST https://api.devnet.solana.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
echo ""
echo "---"
curl -s -X POST https://api.devnet.solana.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'
