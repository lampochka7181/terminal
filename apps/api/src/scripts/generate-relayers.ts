/**
 * Generate Relayer Wallets
 *
 * Creates N Solana keypairs and inserts them into the relayer_wallets table.
 *
 * Usage:
 *   tsx src/scripts/generate-relayers.ts [count]
 *   Default count: 5
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { logger } from '../lib/logger.js';

const count = parseInt(process.argv[2] || '5');

async function main() {
  console.log(`\nGenerating ${count} relayer wallets...\n`);

  for (let i = 0; i < count; i++) {
    const keypair = Keypair.generate();
    const pubkey = keypair.publicKey.toBase58();
    const secretKey = bs58.encode(keypair.secretKey);

    await db.execute(sql`
      INSERT INTO relayer_wallets (pubkey, secret_key, status)
      VALUES (${pubkey}, ${secretKey}, 'active')
      ON CONFLICT (pubkey) DO NOTHING
    `);

    console.log(`  [${i + 1}] ${pubkey}`);
  }

  console.log(`\n✅ ${count} relayer wallets generated and stored in database.`);
  console.log(`\nNext step: Fund them on devnet with:`);
  console.log(`  tsx src/scripts/fund-relayers.ts\n`);

  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
