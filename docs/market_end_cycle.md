┌─────────────────────────────────────────────────────────────────────────────┐
│                    MARKET LIFECYCLE: BTC-5m (D24JU14n)                      │
│              Strike: $68,532.70 → Final: $68,372.29 → Outcome: NO          │
├─────────┬───────────────────────────────────────────────┬───────────────────┤
│  TIME   │  STEP                                         │  DURATION / JOB   │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:02│ 1. MARKET_CLOSED                              │ t=0               │
│         │    Market expires, orderbook cleared,          │ market-resolver   │
│         │    0 open orders cancelled                     │                   │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:03│ 2. RESOLVE ON-CHAIN                           │ +1s               │
│         │    Sends resolve_market_v2 tx to Solana        │ market-resolver   │
│         │    outcome=NO, price=68372.29                  │                   │
│         │    tx: 3zWrVnGk...                             │                   │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:03│ 3. DB UPDATE (chain-sync)                     │ +1s               │
│         │    ChainSync detects CLOSED→RESOLVED,          │ chain-sync        │
│         │    updates DB, emits MARKET_RESOLVED           │                   │
│         │    broadcastMarketResolved → WS to all clients │                   │
│         │    ⚡ PnL ANIMATION TRIGGERS HERE (new)        │                   │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:03│ 4. ACTIVATE NEXT MARKET (parallel)            │ +1s               │
│         │    Next market 3zLhrqhF activated              │ market-creator    │
│         │    strike=$68,380, expires 01:35 UTC            │                   │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:06│ 5. POSITION SETTLER STARTS                    │ +4s               │
│ –       │    Finds 2 positions to settle                 │ position-settler  │
│ 20:30:12│    Retries until merkle settler picks it up    │ (polling ~5s)     │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:12│ 6. MERKLE TREE BUILD                          │ +10s              │
│         │    1 leaf, totalAmount=$69.28                   │ merkle-settler    │
│         │    root=1df5db59...                             │                   │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:14│ 7. POST MERKLE ROOT ON-CHAIN                  │ +12s              │
│         │    tx: 5ceSVofk...                             │ merkle-settler    │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:14│ 8. BATCH SETTLE ENQUEUED                      │ +12s              │
│         │    1 batch created, sent to onchain queue       │ merkle-settler    │
│         │    ⚠ "No available relayers" (brief wait)      │ relayer-pool      │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:15│ 9. BATCH SETTLE ON-CHAIN                      │ +13s              │
│         │    BatchSettleV2 tx: Qx1BfEe8...               │ onchain-queue     │
│         │    1 settlement, took 1097ms                    │                   │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:24│ 10. CONFIRM ALL BATCHES COMPLETE              │ +22s              │
│         │    MerkleSettler verifies all batches done      │ merkle-settler    │
│         │    (polling delay ~9s)                          │                   │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:26│ 11. BURN REMAINING SHARES                     │ +24s              │
│         │    4 ATAs burned on-chain                       │ merkle-settler    │
│         │    tx: 2YTbB4d4...                             │                   │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:26│ 12. FINALIZE MARKET ON-CHAIN                  │ +24s              │
│         │    FinalizeMarketV2 tx: 3CFK3tqN...            │ merkle-settler    │
│         │    ChainSync marks SETTLED + archived           │ chain-sync        │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:27│ 13. POSITIONS SETTLED IN DB                   │ +25s              │
│         │    Position 1: payout=$0, profit=-$25.00       │ position-settler  │
│         │    Position 2: payout=$69.28, profit=+$24.94   │                   │
│         │    WS "settlement" event → user clients         │                   │
│         │    🐌 OLD animation triggered here              │                   │
├─────────┼───────────────────────────────────────────────┼───────────────────┤
│ 20:30:27│ 14. MARKET FULLY SETTLED                      │ +25s              │
│         │    MerkleSettler total: 2817ms                  │ merkle-settler    │
│         │    (just the merkle pipeline, not total)        │                   │
└─────────┴───────────────────────────────────────────────┴───────────────────┘

BOTTLENECKS:
  • Steps 5→6: ~6s polling gap waiting for merkle settler to pick up
  • Steps 9→10: ~9s polling gap confirming batch completion
  • Steps 10→11→12: 2s for burn + finalize txs

TOTAL: 25 seconds (close → fully settled)

With new market_resolved trigger: animation fires at Step 3 (+1s)