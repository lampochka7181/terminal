#!/usr/bin/env node
/**
 * Fund Test Wallets Script
 *
 * Takes a single funded wallet and distributes SOL + USDC to:
 *   - 20 relayer wallets (SOL only — for TX fees)
 *   - N test user wallets (SOL + USDC — for placing orders)
 *
 * Usage:
 *   node scripts/fund-test-wallets.mjs [numTestUsers]
 *
 * Requires in .env:
 *   FUNDING_WALLET_PRIVATE_KEY=<base58 private key of wallet with SOL + USDC>
 *   SOLANA_RPC_URL=<RPC endpoint>
 *   USDC_MINT=<USDC mint address>
 *
 * Or pass as env vars:
 *   FUNDING_WALLET_PRIVATE_KEY=... node scripts/fund-test-wallets.mjs 50
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Load .env ──────────────────────────────────────────────────────────────

function loadEnv() {
  const envPaths = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), 'apps/api/.env'),
  ];
  for (const p of envPaths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Don't override existing env vars
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
      console.log(`  Loaded .env from: ${p}`);
      return;
    }
  }
  console.warn('  No .env file found');
}

loadEnv();

// ─── Config ─────────────────────────────────────────────────────────────────

const NUM_TEST_USERS = parseInt(process.argv[2] || '50');
const SOL_PER_RELAYER = 0.2;         // 0.2 SOL per relayer (enough for ~400 TXs)
const SOL_PER_USER = 0.01;           // 0.01 SOL per test user (just for ATA creation)
const USDC_PER_USER = 2000;          // $2000 USDC per test user
const USDC_DECIMALS = 6;
const BATCH_SIZE = 10;               // Send in batches to avoid TX size limits
const TX_DELAY_MS = 500;             // Delay between batches to avoid rate limits

let RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
// Auto-convert wss:// to https:// (WebSocket URLs don't work for RPC)
if (RPC_URL.startsWith('wss://')) RPC_URL = RPC_URL.replace('wss://', 'https://');
if (RPC_URL.startsWith('ws://')) RPC_URL = RPC_URL.replace('ws://', 'http://');
const USDC_MINT = new PublicKey(process.env.USDC_MINT || 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr');
const FUNDING_KEY = process.env.FUNDING_WALLET_PRIVATE_KEY;

if (!FUNDING_KEY) {
  console.error('❌ FUNDING_WALLET_PRIVATE_KEY not set in .env or environment');
  console.error('   Add it to .env: FUNDING_WALLET_PRIVATE_KEY=<base58 private key>');
  process.exit(1);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

const connection = new Connection(RPC_URL, 'confirmed');
const fundingWallet = Keypair.fromSecretKey(bs58.decode(FUNDING_KEY));

console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║       💰 FUND TEST WALLETS                           ║');
console.log('╠══════════════════════════════════════════════════════╣');
console.log(`║  Funding wallet:  ${fundingWallet.publicKey.toBase58().slice(0, 20)}...     ║`);
console.log(`║  RPC:             ${RPC_URL.slice(0, 35).padEnd(35)}  ║`);
console.log(`║  USDC Mint:       ${USDC_MINT.toBase58().slice(0, 20)}...     ║`);
console.log(`║  Relayer wallets: 20                                  ║`);
console.log(`║  Test users:      ${String(NUM_TEST_USERS).padEnd(37)}║`);
console.log(`║  SOL/relayer:     ${SOL_PER_RELAYER} SOL                              ║`);
console.log(`║  SOL/user:        ${SOL_PER_USER} SOL                             ║`);
console.log(`║  USDC/user:       $${String(USDC_PER_USER).padEnd(35)}║`);
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Check funding wallet balance
  const solBalance = await connection.getBalance(fundingWallet.publicKey);
  console.log(`💰 Funding wallet SOL balance: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const fundingAta = await getAssociatedTokenAddress(USDC_MINT, fundingWallet.publicKey);
  let usdcBalance = 0;
  try {
    const ataInfo = await connection.getTokenAccountBalance(fundingAta);
    usdcBalance = parseFloat(ataInfo.value.uiAmountString || '0');
  } catch {
    console.warn('⚠️  Could not read USDC balance (ATA may not exist yet)');
  }
  console.log(`💰 Funding wallet USDC balance: $${usdcBalance.toFixed(2)}`);

  const totalSolNeeded = (20 * SOL_PER_RELAYER) + (NUM_TEST_USERS * SOL_PER_USER) + 0.5; // +0.5 for TX fees
  const totalUsdcNeeded = NUM_TEST_USERS * USDC_PER_USER;

  console.log(`\n📊 Estimated needs:`);
  console.log(`   SOL: ${totalSolNeeded.toFixed(2)} (relayers: ${(20 * SOL_PER_RELAYER).toFixed(1)}, users: ${(NUM_TEST_USERS * SOL_PER_USER).toFixed(2)}, fees: ~0.5)`);
  console.log(`   USDC: $${totalUsdcNeeded.toLocaleString()}`);

  if (solBalance / LAMPORTS_PER_SOL < totalSolNeeded) {
    console.error(`\n❌ Insufficient SOL. Have ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)}, need ${totalSolNeeded.toFixed(2)}`);
    process.exit(1);
  }
  if (usdcBalance < totalUsdcNeeded) {
    console.error(`\n❌ Insufficient USDC. Have $${usdcBalance.toFixed(2)}, need $${totalUsdcNeeded.toLocaleString()}`);
    process.exit(1);
  }

  // ── Step 1: Load relayer wallets from DB ────────────────────────────────

  console.log('\n── Step 1: Loading relayer wallets from DB ──');
  const relayerPubkeys = await loadRelayerPubkeys();
  console.log(`   Found ${relayerPubkeys.length} relayer wallets`);

  // ── Step 2: Generate test user wallets ──────────────────────────────────

  console.log(`\n── Step 2: Generating ${NUM_TEST_USERS} test user wallets ──`);
  const testUsers = [];
  for (let i = 0; i < NUM_TEST_USERS; i++) {
    const kp = Keypair.generate();
    testUsers.push({
      pubkey: kp.publicKey.toBase58(),
      secretKey: bs58.encode(kp.secretKey),
      keypair: kp,
    });
  }
  console.log(`   Generated ${testUsers.length} keypairs`);

  // Save to file for reference
  const walletsFile = resolve(process.cwd(), 'scripts', 'test-wallets.json');
  writeFileSync(walletsFile, JSON.stringify(testUsers.map(u => ({
    pubkey: u.pubkey,
    secretKey: u.secretKey,
  })), null, 2));
  console.log(`   Saved to ${walletsFile}`);

  // ── Step 3: Fund relayer wallets with SOL ───────────────────────────────

  console.log(`\n── Step 3: Funding ${relayerPubkeys.length} relayer wallets with SOL ──`);
  await distributeSol(relayerPubkeys, SOL_PER_RELAYER, 'relayer');

  // ── Step 4: Fund test user wallets with SOL ─────────────────────────────

  console.log(`\n── Step 4: Funding ${testUsers.length} test users with SOL ──`);
  const userPubkeys = testUsers.map(u => u.pubkey);
  await distributeSol(userPubkeys, SOL_PER_USER, 'test user');

  // ── Step 5: Fund test user wallets with USDC ────────────────────────────

  console.log(`\n── Step 5: Funding ${testUsers.length} test users with USDC ──`);
  await distributeUsdc(testUsers, USDC_PER_USER);

  // ── Step 6: Save test users to DB ───────────────────────────────────────

  console.log(`\n── Step 6: Saving test users to database ──`);
  await saveTestUsersToDB(testUsers);

  // ── Done ────────────────────────────────────────────────────────────────

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  ✅ ALL WALLETS FUNDED                                ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Relayers funded: ${String(relayerPubkeys.length).padEnd(37)}║`);
  console.log(`║  Test users:      ${String(testUsers.length).padEnd(37)}║`);
  console.log(`║  Wallets file:    scripts/test-wallets.json           ║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Add PERF_TEST_MODE=true to .env');
  console.log('  2. node scripts/wipe-logs.mjs');
  console.log('  3. pnpm run start:fresh');
  console.log('  4. node scripts/perf-test.mjs 2000 120 25');
  console.log('');
}

// ─── SOL Distribution ───────────────────────────────────────────────────────

async function distributeSol(pubkeys, solAmount, label) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

  for (let i = 0; i < pubkeys.length; i += BATCH_SIZE) {
    const batch = pubkeys.slice(i, i + BATCH_SIZE);
    const tx = new Transaction();

    for (const pubkey of batch) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: fundingWallet.publicKey,
          toPubkey: new PublicKey(pubkey),
          lamports,
        })
      );
    }

    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [fundingWallet], {
        commitment: 'confirmed',
        maxRetries: 3,
      });
      console.log(`   ✅ Batch ${Math.floor(i / BATCH_SIZE) + 1}: funded ${batch.length} ${label}s (${sig.slice(0, 16)}...)`);
    } catch (err) {
      console.error(`   ❌ Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err.message}`);
      // Retry individually
      for (const pubkey of batch) {
        try {
          const retryTx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: fundingWallet.publicKey,
              toPubkey: new PublicKey(pubkey),
              lamports,
            })
          );
          await sendAndConfirmTransaction(connection, retryTx, [fundingWallet], { commitment: 'confirmed' });
          console.log(`      ✅ Retried ${pubkey.slice(0, 12)}...`);
        } catch (retryErr) {
          console.error(`      ❌ Failed ${pubkey.slice(0, 12)}...: ${retryErr.message}`);
        }
        await sleep(TX_DELAY_MS);
      }
    }

    if (i + BATCH_SIZE < pubkeys.length) {
      await sleep(TX_DELAY_MS);
    }
  }
}

// ─── USDC Distribution ─────────────────────────────────────────────────────

async function distributeUsdc(testUsers, usdcAmount) {
  const amount = BigInt(Math.floor(usdcAmount * (10 ** USDC_DECIMALS)));

  // Get funding wallet's USDC ATA
  const fundingAta = await getAssociatedTokenAddress(USDC_MINT, fundingWallet.publicKey);

  let funded = 0;
  for (let i = 0; i < testUsers.length; i += BATCH_SIZE) {
    const batch = testUsers.slice(i, i + BATCH_SIZE);

    // For USDC, we need to create ATAs first (can't batch ATA creation + transfer easily)
    for (const user of batch) {
      try {
        // getOrCreate handles ATA creation if it doesn't exist
        const recipientAta = await getOrCreateAssociatedTokenAccount(
          connection,
          fundingWallet,      // payer for ATA creation
          USDC_MINT,
          new PublicKey(user.pubkey),
        );

        // Transfer USDC
        const tx = new Transaction().add(
          createTransferInstruction(
            fundingAta,
            recipientAta.address,
            fundingWallet.publicKey,
            amount,
          )
        );

        const sig = await sendAndConfirmTransaction(connection, tx, [fundingWallet], {
          commitment: 'confirmed',
          maxRetries: 3,
        });
        funded++;

        if (funded % 10 === 0 || funded === testUsers.length) {
          console.log(`   ✅ ${funded}/${testUsers.length} users funded with $${usdcAmount} USDC`);
        }
      } catch (err) {
        console.error(`   ❌ Failed to fund ${user.pubkey.slice(0, 12)}...: ${err.message}`);
      }

      await sleep(200); // Small delay between individual transfers
    }

    if (i + BATCH_SIZE < testUsers.length) {
      await sleep(TX_DELAY_MS);
    }
  }
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

async function loadRelayerPubkeys() {
  // Use Supabase REST API or direct SQL
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      const resp = await fetch(`${supabaseUrl}/rest/v1/relayer_wallets?select=pubkey&status=eq.active`, {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      });
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) {
        return data.map(r => r.pubkey);
      }
      console.warn(`   ⚠️  Supabase returned: ${JSON.stringify(data).slice(0, 100)}`);
      console.warn('   Falling back to hardcoded relayer list');
    } catch (err) {
      console.warn(`   ⚠️  Supabase fetch failed: ${err.message}`);
    }
  }

  // Fallback: read from generate script output
  console.warn('   ⚠️  No Supabase credentials, using hardcoded relayer list');
  return [
    '7bV4YsoLyNna7TVaMw676BWNAUtvA9vzWG8Ff4fq8uhj',
    'C7JW6kMUevtuKfKPFT3Q1sdMNjJkPvVUiu27CLsBpB1m',
    'GjxzQfbCz7eb17ZaeBLwyRLfAWxHTKSLb7KDZisqFcon',
    'C6vBrk6re1n9oSv2kpCCdxfEwVUEa6zkMGALv4mAr2yt',
    'CB3RTa9ZZ9yBLu94s7k73enWu7US3AC9A7DiR2iuBW2g',
    '8MCU1GpTFKqBLyue6hwmnJwPMZbH5kC8Y3unWsgBV1KD',
    'AKjtkeN5VUtFsQku3rGS6syY1UEriF1WeAiGFsy7S1ym',
    '4QCA9e4Q6TuCN6VXwHWAQugVQvtnhHFWwWte3i4iLD3Y',
    'B1zscPYXaq7Fpu3c7SDYCEMTxscF5WWGNh9haUTuQ6uT',
    'GRWCssBagp7wt3qyaNHRCbwtDZ1KvW2YzZsczAUmg4w',
    'J6BeVzG18rFd3U3iATAYn3gFcc7GdWLAfJmxhJVFeED2',
    '35vTrnbnosoxv9qxNBKxgmrdYvrAEhqyTZLoZWL83RYy',
    '82SWmLzyj9iAdBnRdMhuWWRNdfwMyJfxNSBZNsVSfSTM',
    'AkCgMkHdQ7AbHLi8ZEhntpfgwKtPSLHv4sCReRqJVabH',
    '4bPh7anQqBhQvtX9f3B4xUCTsEa8GbKJYapdfHP54Vwz',
    '9xvQUmKtpyEmpLgMDnHtzgxzVbACR2NDfdGKoVJyjGpt',
    'FDLv8iBpFrx3YAsiYED4zfHdUX9ditRHSt9HqW1eogjH',
    'Fm4dNti5HbnBGD6NmTaMuCAEsWziCZt67dwsRNdxBBT7',
    'AcCQRpprFhQHKhgqqtvvUndwJ3oYGo9wvBKMM4NXGt7J',
    'GuSY4o39stCRJ1sniGB8cAeYXbdhMQVwGS8GQV4cYAxp',
  ];
}

async function saveTestUsersToDB(testUsers) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('   ⚠️  No Supabase credentials — skipping DB insert');
    console.warn('   Test wallets saved to scripts/test-wallets.json instead');
    return;
  }

  // Insert users into the users table
  let inserted = 0;
  for (let i = 0; i < testUsers.length; i += BATCH_SIZE) {
    const batch = testUsers.slice(i, i + BATCH_SIZE);
    const records = batch.map(u => ({
      wallet_address: u.pubkey,
      username: `perf_user_${u.pubkey.slice(0, 8)}`,
      is_banned: false,
    }));

    try {
      const resp = await fetch(`${supabaseUrl}/rest/v1/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'resolution=merge-duplicates',  // upsert on wallet_address
        },
        body: JSON.stringify(records),
      });

      if (resp.ok) {
        inserted += batch.length;
      } else {
        const err = await resp.text();
        console.warn(`   ⚠️  Batch insert warning: ${err.slice(0, 100)}`);
        // Try individual inserts
        for (const record of records) {
          try {
            await fetch(`${supabaseUrl}/rest/v1/users`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Prefer': 'resolution=merge-duplicates',
              },
              body: JSON.stringify(record),
            });
            inserted++;
          } catch {}
        }
      }
    } catch (err) {
      console.error(`   ❌ DB insert failed: ${err.message}`);
    }
  }

  console.log(`   ✅ ${inserted}/${testUsers.length} test users saved to DB`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
