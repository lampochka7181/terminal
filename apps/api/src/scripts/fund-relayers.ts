/**
 * Fund Relayer Wallets (Devnet)
 *
 * Requests SOL airdrops for all relayer wallets in the database.
 * On mainnet, transfers from the master wallet instead.
 *
 * Usage:
 *   tsx src/scripts/fund-relayers.ts
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { config } from '../config.js';

const AIRDROP_AMOUNT = 2 * LAMPORTS_PER_SOL; // 2 SOL each

async function main() {
  const connection = new Connection(config.solanaRpcUrl, 'confirmed');

  console.log(`\nFunding relayer wallets on ${config.solanaRpcUrl}...\n`);

  const rows = await db.execute(sql`
    SELECT pubkey FROM relayer_wallets WHERE status != 'disabled'
  `);

  if (!rows.rows || rows.rows.length === 0) {
    console.log('No relayer wallets found. Run generate-relayers.ts first.');
    process.exit(1);
  }

  for (const row of rows.rows) {
    const pubkey = (row as any).pubkey;
    try {
      const pk = new PublicKey(pubkey);

      // Check current balance
      const balance = await connection.getBalance(pk);
      console.log(`  ${pubkey.slice(0, 12)}... balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

      if (balance >= AIRDROP_AMOUNT) {
        console.log(`  → Already funded, skipping`);
        continue;
      }

      // Request airdrop (devnet only)
      console.log(`  → Requesting ${AIRDROP_AMOUNT / LAMPORTS_PER_SOL} SOL airdrop...`);
      const sig = await connection.requestAirdrop(pk, AIRDROP_AMOUNT);
      await connection.confirmTransaction(sig);

      const newBalance = await connection.getBalance(pk);

      // Update balance in DB
      await db.execute(sql`
        UPDATE relayer_wallets SET balance_lamports = ${newBalance} WHERE pubkey = ${pubkey}
      `);

      console.log(`  ✅ Funded: ${(newBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      console.error(`  ❌ Error funding ${pubkey.slice(0, 12)}...: ${err.message}\n`);
    }
  }

  console.log('Done!\n');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
