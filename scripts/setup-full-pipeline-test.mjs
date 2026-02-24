#!/usr/bin/env node
/**
 * Full Pipeline Performance Test Setup
 *
 * Prepares everything needed for a full pipeline perf test:
 *   1. Resets stale relayer state in DB
 *   2. Funds relayer wallets with SOL
 *   3. Loads (or generates) test wallets
 *   4. Funds test wallets with SOL + USDC
 *   5. Sets up USDC delegation to relayer for each test wallet
 *   6. Registers test users in Supabase DB
 *
 * Usage:
 *   node scripts/setup-full-pipeline-test.mjs [numTestUsers]
 *
 * Requires in .env:
 *   FUNDING_WALLET_PRIVATE_KEY, SOLANA_RPC_URL, USDC_MINT,
 *   RELAYER_PRIVATE_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
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
  createApproveInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Load .env ───────────────────────────────────────────────────────────────

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

// ─── Config ──────────────────────────────────────────────────────────────────

const NUM_TEST_USERS = parseInt(process.argv[2] || '50');
const SOL_PER_RELAYER = 0.15;           // 0.15 SOL per relayer (~300 TXs)
const SOL_PER_USER = 0.01;              // 0.01 SOL per test user (ATA creation)
const USDC_PER_USER = 500;              // $500 USDC per test user
const USDC_DECIMALS = 6;
const DELEGATION_AMOUNT = 1_000_000;    // $1M USDC delegation (effectively unlimited)
const BATCH_SIZE = 10;
const TX_DELAY_MS = 400;

let RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
if (RPC_URL.startsWith('wss://')) RPC_URL = RPC_URL.replace('wss://', 'https://');
if (RPC_URL.startsWith('ws://')) RPC_URL = RPC_URL.replace('ws://', 'http://');

const USDC_MINT = new PublicKey(process.env.USDC_MINT || 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr');
const FUNDING_KEY = process.env.FUNDING_WALLET_PRIVATE_KEY;
const RELAYER_KEY = process.env.RELAYER_PRIVATE_KEY;

if (!FUNDING_KEY) {
  console.error('FUNDING_WALLET_PRIVATE_KEY not set in .env');
  process.exit(1);
}
if (!RELAYER_KEY) {
  console.error('RELAYER_PRIVATE_KEY not set in .env');
  process.exit(1);
}

// ─── Setup ───────────────────────────────────────────────────────────────────

const connection = new Connection(RPC_URL, 'confirmed');
const fundingWallet = Keypair.fromSecretKey(bs58.decode(FUNDING_KEY));
const relayerKeypair = Keypair.fromSecretKey(bs58.decode(RELAYER_KEY));
const relayerPubkey = relayerKeypair.publicKey;

console.log('');
console.log('==========================================================');
console.log('  FULL PIPELINE TEST SETUP');
console.log('==========================================================');
console.log(`  Funding wallet:   ${fundingWallet.publicKey.toBase58().slice(0, 20)}...`);
console.log(`  Relayer:          ${relayerPubkey.toBase58().slice(0, 20)}...`);
console.log(`  RPC:              ${RPC_URL.slice(0, 50)}`);
console.log(`  USDC Mint:        ${USDC_MINT.toBase58()}`);
console.log(`  Test users:       ${NUM_TEST_USERS}`);
console.log(`  USDC/user:        $${USDC_PER_USER}`);
console.log(`  Delegation:       $${DELEGATION_AMOUNT.toLocaleString()}`);
console.log('==========================================================');
console.log('');

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // ── Check balances ──
  const solBalance = await connection.getBalance(fundingWallet.publicKey);
  console.log(`Funding wallet SOL: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const fundingAta = await getAssociatedTokenAddress(USDC_MINT, fundingWallet.publicKey);
  let usdcBalance = 0;
  try {
    const ataInfo = await connection.getTokenAccountBalance(fundingAta);
    usdcBalance = parseFloat(ataInfo.value.uiAmountString || '0');
  } catch {
    console.warn('Could not read USDC balance (ATA may not exist)');
  }
  console.log(`Funding wallet USDC: $${usdcBalance.toFixed(2)}`);
  console.log('');

  // ── Step 1: Reset relayer state in DB ──
  console.log('-- Step 1: Resetting relayer state in DB --');
  await resetRelayerState();

  // ── Step 2: Load relayer pubkeys and fund with SOL ──
  console.log('\n-- Step 2: Funding relayer wallets with SOL --');
  const relayerPubkeys = await loadRelayerPubkeys();
  console.log(`  Found ${relayerPubkeys.length} relayer wallets`);
  await fundWalletsWithSol(relayerPubkeys, SOL_PER_RELAYER, 'relayer');

  // ── Step 3: Load or generate test wallets ──
  console.log(`\n-- Step 3: Loading test wallets --`);
  const testWallets = loadOrGenerateTestWallets();
  console.log(`  ${testWallets.length} test wallets ready`);

  // ── Step 4: Fund test wallets with SOL + USDC ──
  console.log(`\n-- Step 4: Funding test wallets with SOL --`);
  const userPubkeys = testWallets.map(w => w.pubkey);
  await fundWalletsWithSol(userPubkeys, SOL_PER_USER, 'test user');

  console.log(`\n-- Step 5: Funding test wallets with USDC --`);
  await fundWalletsWithUsdc(testWallets, USDC_PER_USER);

  // ── Step 6: Set up USDC delegation to relayer ──
  console.log(`\n-- Step 6: Setting up USDC delegation to relayer --`);
  await setupDelegation(testWallets);

  // ── Step 7: Register test users in DB ──
  console.log(`\n-- Step 7: Registering test users in DB --`);
  await registerTestUsersInDB(testWallets);

  // ── Done ──
  console.log('\n==========================================================');
  console.log('  SETUP COMPLETE');
  console.log('==========================================================');
  console.log(`  Relayers funded:    ${relayerPubkeys.length}`);
  console.log(`  Test users funded:  ${testWallets.length}`);
  console.log(`  USDC delegated:     Yes (to relayer)`);
  console.log(`  DB users created:   Yes`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. pnpm run start:fresh');
  console.log('  2. curl -X POST http://localhost:4000/perf/full-pipeline');
  console.log('');
}

// ─── Step 1: Reset relayer state ─────────────────────────────────────────────

async function resetRelayerState() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('  No Supabase credentials - skip DB reset');
    return;
  }

  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/relayer_wallets?status=eq.active`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        active_jobs: 0,
        consecutive_failures: 0,
        cooldown_until: null,
      }),
    });
    console.log(`  Reset relayer state: ${resp.ok ? 'OK' : resp.status}`);
  } catch (err) {
    console.warn(`  Failed to reset relayer state: ${err.message}`);
  }
}

// ─── Load relayer pubkeys from DB ────────────────────────────────────────────

async function loadRelayerPubkeys() {
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
    } catch (err) {
      console.warn(`  Supabase fetch failed: ${err.message}`);
    }
  }

  console.warn('  No Supabase credentials or no relayers found');
  return [];
}

// ─── Load or generate test wallets ───────────────────────────────────────────

function loadOrGenerateTestWallets() {
  const walletsFile = resolve(process.cwd(), 'scripts', 'test-wallets.json');

  if (existsSync(walletsFile)) {
    try {
      const data = JSON.parse(readFileSync(walletsFile, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        console.log(`  Loaded ${data.length} existing wallets from ${walletsFile}`);
        return data.slice(0, NUM_TEST_USERS).map(w => ({
          pubkey: w.pubkey,
          secretKey: w.secretKey,
          keypair: Keypair.fromSecretKey(bs58.decode(w.secretKey)),
        }));
      }
    } catch (err) {
      console.warn(`  Failed to parse ${walletsFile}: ${err.message}`);
    }
  }

  // Generate new wallets
  console.log(`  Generating ${NUM_TEST_USERS} new wallets...`);
  const wallets = [];
  for (let i = 0; i < NUM_TEST_USERS; i++) {
    const kp = Keypair.generate();
    wallets.push({
      pubkey: kp.publicKey.toBase58(),
      secretKey: bs58.encode(kp.secretKey),
      keypair: kp,
    });
  }

  // Save to file
  writeFileSync(walletsFile, JSON.stringify(wallets.map(w => ({
    pubkey: w.pubkey,
    secretKey: w.secretKey,
  })), null, 2));
  console.log(`  Saved ${wallets.length} wallets to ${walletsFile}`);

  return wallets;
}

// ─── Fund wallets with SOL ───────────────────────────────────────────────────

async function fundWalletsWithSol(pubkeys, solAmount, label) {
  if (pubkeys.length === 0) return;
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

  // Check which wallets need funding (balance < threshold)
  const needsFunding = [];
  for (const pk of pubkeys) {
    try {
      const balance = await connection.getBalance(new PublicKey(pk));
      if (balance < lamports * 0.5) {
        needsFunding.push(pk);
      }
    } catch {
      needsFunding.push(pk);
    }
  }

  if (needsFunding.length === 0) {
    console.log(`  All ${pubkeys.length} ${label}s already funded with SOL`);
    return;
  }

  console.log(`  Funding ${needsFunding.length}/${pubkeys.length} ${label}s with ${solAmount} SOL each...`);

  for (let i = 0; i < needsFunding.length; i += BATCH_SIZE) {
    const batch = needsFunding.slice(i, i + BATCH_SIZE);
    const tx = new Transaction();

    for (const pubkey of batch) {
      tx.add(SystemProgram.transfer({
        fromPubkey: fundingWallet.publicKey,
        toPubkey: new PublicKey(pubkey),
        lamports,
      }));
    }

    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [fundingWallet], {
        commitment: 'confirmed',
        maxRetries: 3,
      });
      console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: funded ${batch.length} ${label}s (${sig.slice(0, 16)}...)`);
    } catch (err) {
      console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err.message}`);
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
        } catch (retryErr) {
          console.error(`  Failed ${pubkey.slice(0, 12)}: ${retryErr.message}`);
        }
        await sleep(TX_DELAY_MS);
      }
    }

    if (i + BATCH_SIZE < needsFunding.length) {
      await sleep(TX_DELAY_MS);
    }
  }
}

// ─── Fund wallets with USDC ─────────────────────────────────────────────────

async function fundWalletsWithUsdc(testWallets, usdcAmount) {
  const amount = BigInt(Math.floor(usdcAmount * (10 ** USDC_DECIMALS)));
  const fundingAta = await getAssociatedTokenAddress(USDC_MINT, fundingWallet.publicKey);

  // Check which wallets need USDC
  const needsFunding = [];
  for (const w of testWallets) {
    try {
      const ata = await getAssociatedTokenAddress(USDC_MINT, new PublicKey(w.pubkey));
      const balance = await connection.getTokenAccountBalance(ata);
      const uiAmount = parseFloat(balance.value.uiAmountString || '0');
      if (uiAmount < usdcAmount * 0.5) {
        needsFunding.push(w);
      }
    } catch {
      needsFunding.push(w); // ATA doesn't exist
    }
  }

  if (needsFunding.length === 0) {
    console.log(`  All ${testWallets.length} wallets already funded with USDC`);
    return;
  }

  console.log(`  Funding ${needsFunding.length}/${testWallets.length} wallets with $${usdcAmount} USDC each...`);
  let funded = 0;

  for (const w of needsFunding) {
    try {
      const recipientAta = await getOrCreateAssociatedTokenAccount(
        connection,
        fundingWallet,
        USDC_MINT,
        new PublicKey(w.pubkey),
      );

      const tx = new Transaction().add(
        createTransferInstruction(
          fundingAta,
          recipientAta.address,
          fundingWallet.publicKey,
          amount,
        )
      );

      await sendAndConfirmTransaction(connection, tx, [fundingWallet], {
        commitment: 'confirmed',
        maxRetries: 3,
      });
      funded++;

      if (funded % 10 === 0 || funded === needsFunding.length) {
        console.log(`  ${funded}/${needsFunding.length} wallets funded with $${usdcAmount} USDC`);
      }
    } catch (err) {
      console.error(`  Failed ${w.pubkey.slice(0, 12)}: ${err.message}`);
    }

    await sleep(200);
  }
}

// ─── Set up USDC delegation to relayer ───────────────────────────────────────

async function setupDelegation(testWallets) {
  const delegationAmountRaw = BigInt(DELEGATION_AMOUNT * (10 ** USDC_DECIMALS));
  let delegated = 0;
  let skipped = 0;

  for (const w of testWallets) {
    try {
      const walletPk = new PublicKey(w.pubkey);
      const userAta = await getAssociatedTokenAddress(USDC_MINT, walletPk);

      // Check if already delegated
      try {
        const accountInfo = await connection.getTokenAccountBalance(userAta);
        // We can't easily check delegate via getTokenAccountBalance,
        // so we'll just approve every time (idempotent, cheap)
      } catch {
        // ATA doesn't exist yet - skip (shouldn't happen after funding)
        skipped++;
        continue;
      }

      // Create approve instruction: user approves relayer to spend USDC
      const approveIx = createApproveInstruction(
        userAta,              // token account
        relayerPubkey,        // delegate
        walletPk,             // owner
        delegationAmountRaw,  // amount
        [],                   // multiSigners (none)
        TOKEN_PROGRAM_ID,     // programId
      );

      const tx = new Transaction().add(approveIx);
      await sendAndConfirmTransaction(connection, tx, [w.keypair], {
        commitment: 'confirmed',
        maxRetries: 3,
      });
      delegated++;

      if (delegated % 10 === 0 || delegated === testWallets.length - skipped) {
        console.log(`  ${delegated}/${testWallets.length} wallets delegated to relayer`);
      }
    } catch (err) {
      console.error(`  Delegation failed for ${w.pubkey.slice(0, 12)}: ${err.message}`);
    }

    await sleep(150);
  }

  console.log(`  Delegation complete: ${delegated} delegated, ${skipped} skipped`);
}

// ─── Register test users in DB ───────────────────────────────────────────────

async function registerTestUsersInDB(testWallets) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('  No Supabase credentials - skip DB registration');
    return;
  }

  let inserted = 0;
  for (let i = 0; i < testWallets.length; i += BATCH_SIZE) {
    const batch = testWallets.slice(i, i + BATCH_SIZE);
    const records = batch.map(w => ({
      wallet_address: w.pubkey,
      is_banned: false,
    }));

    try {
      const resp = await fetch(`${supabaseUrl}/rest/v1/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify(records),
      });

      if (resp.ok) {
        inserted += batch.length;
      } else {
        const err = await resp.text();
        console.warn(`  Batch warning: ${err.slice(0, 100)}`);
        // Try individual
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
      console.error(`  DB insert failed: ${err.message}`);
    }
  }

  console.log(`  ${inserted}/${testWallets.length} users registered in DB`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
