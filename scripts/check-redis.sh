#!/bin/bash
KEY="orderbook:36b2b461-4a58-4450-851e-26deefb9f8f0:YES:ASK"
echo "Total ASK orders: $(redis-cli zcard "$KEY")"
echo ""
echo "Checking first 5 orders for hash existence:"
for id in $(redis-cli zrange "$KEY" 0 4); do
  exists=$(redis-cli exists "order:$id")
  size=$(redis-cli hget "order:$id" size)
  echo "  $id exists=$exists size=$size"
done
echo ""
echo "Score distribution:"
redis-cli zrange "$KEY" 0 4 WITHSCORES
