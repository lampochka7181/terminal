# Degen Terminal - TODO

## Completed
- [x] Phase 0: Add instrumentation and metrics
- [x] Phase 4: Tokenized shares on-chain program
- [x] Phase 5: Merkle batch settlement on-chain
- [x] Phase 1: Redis orderbook hot-path redesign (O(log N) mutations, O(levels) snapshots)
- [x] Phase 2: WebSocket fanout redesign (reverse indexes, batching, backpressure)
- [x] Phase 3: Durable async pipeline with BullMQ (on-chain submit, db-sync, ws-events workers)
- [x] Phase 6: Parallel relayer pool (acquire/release, circuit breaker, auto-funding)
- [x] Phase 7: Settlement orchestration (parallel batch settlement via BullMQ + relayer pool)

## In Progress / Pending
- [ ] Generate and fund relayer wallets on devnet (run: tsx src/scripts/generate-relayers.ts && tsx src/scripts/fund-relayers.ts)
- [ ] Install bullmq dependency (run: pnpm install in apps/api)

## V2 Integration Status
- [x] V2 on-chain program (tokenized YES/NO shares)
- [x] Two-phase market initialization (stack overflow fix)
- [x] ExecuteMatchV2 stack optimization (removed init_if_needed, pre-create ATAs)
- [x] ExecuteCloseV2 stack optimization
- [x] close_market_v2 instruction for zero-trade markets
- [x] Market closer V2 support (detects V2 markets, uses close_market_v2)
- [x] API integration: executeMatchV2, executeCloseV2, activateMarketV2, resolveMarketV2
- [x] Feature flag: USE_V2=true to toggle V1/V2 flows
- [x] V2 merkle settlement API integration (merkle-settler.ts keeper job)
- [x] Anchor client: postMerkleRoot, batchSettleV2, finalizeMarketV2
- [x] Merkle tree library (merkle-tree.ts - keccak256, proof generation)
- [x] Fix: FEE_RECIPIENT undefined crash in executeCloseV2 (2026-02-07)
- [x] Fix: V2 market PDA rent not recovered on close/finalize (2026-02-07)
- [x] Token-2022 migration: YES/NO mints now use Token-2022 + MintCloseAuthority (2026-02-07)
- [x] Redeployed smart contract to devnet with Token-2022 + rent recovery (2026-02-07)
- [x] End-to-end V2 testing with trades

## V2 Known Limitations
- [x] ~~YES/NO mint rent cannot be recovered~~ → Fixed: Migrated to Token-2022 with MintCloseAuthority
- [ ] On-chain: SettlementBitmap only creates chunk 0 (supports up to 8,192 settlements per market)
- [ ] On-chain: post_merkle_root validation may be too restrictive (total_amount vs open_interest scale)
- [ ] On-chain: resolve_market_v2 missing authority check
