#!/usr/bin/env node
/**
 * Load Test Setup
 *
 * Generates wallets, funds them with SOL + USDC, sets up delegation,
 * and registers them as users in the DB.
 *
 * Usage:
 *   pnpm --filter @degen/loadtest setup
 *   # or from repo root:
 *   npx tsx apps/loadtest/src/setup.ts
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
import { config } from './config.js';
import { loadOrGenerateWallets, type LoadedWallet } from './wallet.js';

const connection = new Connection(config.rpcUrl, 'confirmed');
const fundingWallet = Keypair.fromSecretKey(bs58.decode(config.fundingPrivateKey));
const relayerKeypair = Keypair.fromSecretKey(bs58.decode(config.relayerPrivateKey));

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('==========================================================');
  console.log('  LOAD TEST SETUP');
  console.log('==========================================================');
  console.log(`  Funding wallet:   ${fundingWallet.publicKey.toBase58().slice(0, 20)}...`);
  console.log(`  Relayer:          ${relayerKeypair.publicKey.toBase58().slice(0, 20)}...`);
  console.log(`  RPC:              ${config.rpcUrl.slice(0, 50)}`);
  console.log(`  USDC Mint:        ${config.usdcMint}`);
  console.log(`  Wallets:          ${config.numWallets}`);
  console.log(`  SOL/wallet:       ${config.solPerUser}`);
  console.log(`  USDC/wallet:      $${config.usdcPerUser}`);
  console.log('==========================================================');
  console.log('');

  // Check funding wallet balance
  const solBalance = await connection.getBalance(fundingWallet.publicKey);
  console.log(`Funding wallet SOL: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const usdcMint = new PublicKey(config.usdcMint);
  const fundingAta = await getAssociatedTokenAddress(usdcMint, fundingWallet.publicKey);
  let usdcBalance = 0;
  try {
    const ataInfo = await connection.getTokenAccountBalance(fundingAta);
    usdcBalance = parseFloat(ataInfo.value.uiAmountString || '0');
  } catch {
    console.warn('Could not read USDC balance (ATA may not exist)');
  }
  console.log(`Funding wallet USDC: $${usdcBalance.toFixed(2)}`);

  const requiredSol = config.numWallets * config.solPerUser + 0.1; // extra for fees
  const requiredUsdc = config.numWallets * config.usdcPerUser;
  if (solBalance / LAMPORTS_PER_SOL < requiredSol) {
    console.warn(`\n  WARNING: May need more SOL. Have ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)}, need ~${requiredSol.toFixed(4)}`);
  }
  if (usdcBalance < requiredUsdc) {
    console.warn(`\n  WARNING: May need more USDC. Have $${usdcBalance.toFixed(2)}, need $${requiredUsdc}`);
  }

  // Step 1: Generate/load wallets
  console.log('\n-- Step 1: Loading/generating wallets --');
  const wallets = loadOrGenerateWallets(config.numWallets);

  // Step 2: Fund with SOL
  console.log('\n-- Step 2: Funding wallets with SOL --');
  await fundWalletsWithSol(wallets);

  // Step 3: Fund with USDC
  console.log('\n-- Step 3: Funding wallets with USDC --');
  await fundWalletsWithUsdc(wallets);

  // Step 4: Set up delegation
  console.log('\n-- Step 4: Setting up USDC delegation to relayer --');
  await setupDelegation(wallets);

  // Step 5: Register in DB
  console.log('\n-- Step 5: Registering users in DB --');
  await registerUsers(wallets);

  console.log('\n==========================================================');
  console.log('  SETUP COMPLETE');
  console.log('==========================================================');
  console.log(`  Wallets ready:    ${wallets.length}`);
  console.log('');
  console.log('Next: pnpm --filter @degen/loadtest run');
  console.log('');
}

// ─── Fund with SOL ──────────────────────────────────────────────────────────

async function fundWalletsWithSol(wallets: LoadedWallet[]) {
  const lamports = Math.floor(config.solPerUser * LAMPORTS_PER_SOL);

  // Check which need funding
  const needsFunding: LoadedWallet[] = [];
  for (const w of wallets) {
    try {
      const balance = await connection.getBalance(new PublicKey(w.pubkey));
      if (balance < lamports * 0.5) needsFunding.push(w);
    } catch {
      needsFunding.push(w);
    }
  }

  if (needsFunding.length === 0) {
    console.log(`  All ${wallets.length} wallets already funded with SOL`);
    return;
  }

  console.log(`  Funding ${needsFunding.length}/${wallets.length} wallets with ${config.solPerUser} SOL each...`);

  for (let i = 0; i < needsFunding.length; i += config.batchSize) {
    const batch = needsFunding.slice(i, i + config.batchSize);
    const tx = new Transaction();
    for (const w of batch) {
      tx.add(SystemProgram.transfer({
        fromPubkey: fundingWallet.publicKey,
        toPubkey: new PublicKey(w.pubkey),
        lamports,
      }));
    }

    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [fundingWallet], {
        commitment: 'confirmed',
        maxRetries: 3,
      });
      console.log(`  Batch ${Math.floor(i / config.batchSize) + 1}: funded ${batch.length} wallets (${sig.slice(0, 16)}...)`);
    } catch (err: any) {
      console.error(`  Batch failed, retrying individually: ${err.message}`);
      for (const w of batch) {
        try {
          const retryTx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: fundingWallet.publicKey,
              toPubkey: new PublicKey(w.pubkey),
              lamports,
            })
          );
          await sendAndConfirmTransaction(connection, retryTx, [fundingWallet], { commitment: 'confirmed' });
        } catch (retryErr: any) {
          console.error(`  Failed ${w.pubkey.slice(0, 12)}: ${retryErr.message}`);
        }
        await sleep(config.txDelayMs);
      }
    }

    if (i + config.batchSize < needsFunding.length) await sleep(config.txDelayMs);
  }
}

// ─── Fund with USDC ─────────────────────────────────────────────────────────

async function fundWalletsWithUsdc(wallets: LoadedWallet[]) {
  const usdcMint = new PublicKey(config.usdcMint);
  const amount = BigInt(Math.floor(config.usdcPerUser * (10 ** config.usdcDecimals)));
  const fundingAta = await getAssociatedTokenAddress(usdcMint, fundingWallet.publicKey);

  // Check which need USDC
  const needsFunding: LoadedWallet[] = [];
  for (const w of wallets) {
    try {
      const ata = await getAssociatedTokenAddress(usdcMint, new PublicKey(w.pubkey));
      const balance = await connection.getTokenAccountBalance(ata);
      const uiAmount = parseFloat(balance.value.uiAmountString || '0');
      if (uiAmount < config.usdcPerUser * 0.5) needsFunding.push(w);
    } catch {
      needsFunding.push(w);
    }
  }

  if (needsFunding.length === 0) {
    console.log(`  All ${wallets.length} wallets already funded with USDC`);
    return;
  }

  console.log(`  Funding ${needsFunding.length}/${wallets.length} wallets with $${config.usdcPerUser} USDC each...`);
  let funded = 0;

  for (const w of needsFunding) {
    try {
      const recipientAta = await getOrCreateAssociatedTokenAccount(
        connection, fundingWallet, usdcMint, new PublicKey(w.pubkey),
      );

      const tx = new Transaction().add(
        createTransferInstruction(fundingAta, recipientAta.address, fundingWallet.publicKey, amount),
      );

      await sendAndConfirmTransaction(connection, tx, [fundingWallet], {
        commitment: 'confirmed',
        maxRetries: 3,
      });
      funded++;

      if (funded % 10 === 0 || funded === needsFunding.length) {
        console.log(`  ${funded}/${needsFunding.length} wallets funded with USDC`);
      }
    } catch (err: any) {
      console.error(`  Failed ${w.pubkey.slice(0, 12)}: ${err.message}`);
    }
    await sleep(200);
  }
}

// ─── USDC delegation ────────────────────────────────────────────────────────

async function setupDelegation(wallets: LoadedWallet[]) {
  const usdcMint = new PublicKey(config.usdcMint);
  const delegationAmountRaw = BigInt(config.delegationAmount * (10 ** config.usdcDecimals));
  let delegated = 0;
  let skipped = 0;

  for (const w of wallets) {
    try {
      const walletPk = new PublicKey(w.pubkey);
      const userAta = await getAssociatedTokenAddress(usdcMint, walletPk);

      // Verify ATA exists
      try {
        await connection.getTokenAccountBalance(userAta);
      } catch {
        skipped++;
        continue;
      }

      const approveIx = createApproveInstruction(
        userAta,
        relayerKeypair.publicKey,
        walletPk,
        delegationAmountRaw,
        [],
        TOKEN_PROGRAM_ID,
      );

      const tx = new Transaction().add(approveIx);
      await sendAndConfirmTransaction(connection, tx, [w.keypair], {
        commitment: 'confirmed',
        maxRetries: 3,
      });
      delegated++;

      if (delegated % 10 === 0 || delegated === wallets.length - skipped) {
        console.log(`  ${delegated}/${wallets.length} wallets delegated to relayer`);
      }
    } catch (err: any) {
      console.error(`  Delegation failed for ${w.pubkey.slice(0, 12)}: ${err.message}`);
    }
    await sleep(150);
  }

  console.log(`  Delegation complete: ${delegated} delegated, ${skipped} skipped`);
}

// ─── Register users in DB ───────────────────────────────────────────────────

async function registerUsers(wallets: LoadedWallet[]) {
  if (!config.supabaseUrl || !config.supabaseKey) {
    console.warn('  No Supabase credentials — skipping DB registration');
    console.warn('  Users will be auto-created on first auth');
    return;
  }

  let inserted = 0;
  for (let i = 0; i < wallets.length; i += config.batchSize) {
    const batch = wallets.slice(i, i + config.batchSize);
    const records = batch.map(w => ({ wallet_address: w.pubkey, is_banned: false }));

    try {
      const resp = await fetch(`${config.supabaseUrl}/rest/v1/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.supabaseKey,
          'Authorization': `Bearer ${config.supabaseKey}`,
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify(records),
      });

      if (resp.ok) {
        inserted += batch.length;
      } else {
        const err = await resp.text();
        console.warn(`  Batch warning: ${err.slice(0, 100)}`);
      }
    } catch (err: any) {
      console.error(`  DB insert failed: ${err.message}`);
    }
  }

  console.log(`  ${inserted}/${wallets.length} users registered in DB`);
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
