#!/usr/bin/env node
console.log('Script starting...');
/**
 * Setup Lending Pool Token Delegation
 * 
 * This script approves the relayer to spend USDC from the Lending Pool wallet.
 * This is required for leveraged trades where the Lending Pool executes trades
 * on behalf of users.
 * 
 * Run: npx ts-node apps/api/src/scripts/setup-lending-delegation.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import {
  approve,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from project root
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const USDC_MINT = new PublicKey(process.env.USDC_MINT || 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr');

// Delegation amount - 1 billion USDC (effectively unlimited for devnet)
// In production, you might want to set a reasonable limit and top up periodically
const DELEGATION_AMOUNT = 1_000_000_000_000_000; // 1 billion USDC (6 decimals)

async function main() {
  console.log('='.repeat(60));
  console.log('Lending Pool Token Delegation Setup');
  console.log('='.repeat(60));
  
  // Load Lending Pool private key
  const lendingPrivateKey = process.env.LENDING_WALLET_PRIVATE_KEY || process.env.LENDING_WALLET;
  if (!lendingPrivateKey) {
    throw new Error('LENDING_WALLET_PRIVATE_KEY environment variable not set');
  }
  
  // Load relayer private key
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerPrivateKey) {
    throw new Error('RELAYER_PRIVATE_KEY environment variable not set');
  }
  
  // Parse keypairs
  let lendingKeypair: Keypair;
  let relayerKeypair: Keypair;
  
  try {
    // Try base58 first
    lendingKeypair = Keypair.fromSecretKey(bs58.decode(lendingPrivateKey));
  } catch {
    // Try JSON array
    try {
      const secretKey = JSON.parse(lendingPrivateKey);
      lendingKeypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
    } catch {
      throw new Error('Invalid LENDING_WALLET_PRIVATE_KEY format. Must be base58 or JSON array.');
    }
  }
  
  try {
    relayerKeypair = Keypair.fromSecretKey(bs58.decode(relayerPrivateKey));
  } catch {
    try {
      const secretKey = JSON.parse(relayerPrivateKey);
      relayerKeypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
    } catch {
      throw new Error('Invalid RELAYER_PRIVATE_KEY format. Must be base58 or JSON array.');
    }
  }
  
  console.log('\nConfiguration:');
  console.log('- RPC:', SOLANA_RPC);
  console.log('- USDC Mint:', USDC_MINT.toBase58());
  console.log('- Lending Pool Wallet:', lendingKeypair.publicKey.toBase58());
  console.log('- Relayer (Delegate):', relayerKeypair.publicKey.toBase58());
  console.log('- Delegation Amount:', (DELEGATION_AMOUNT / 1_000_000).toLocaleString(), 'USDC');
  
  // Connect to Solana
  const connection = new Connection(SOLANA_RPC, 'confirmed');
  
  // Get Lending Pool's USDC ATA
  const lendingUsdcAta = await getAssociatedTokenAddress(
    USDC_MINT,
    lendingKeypair.publicKey
  );
  
  console.log('\n- Lending Pool USDC ATA:', lendingUsdcAta.toBase58());
  
  // Check if ATA exists and get balance
  try {
    const accountInfo = await connection.getTokenAccountBalance(lendingUsdcAta);
    console.log('- Current USDC Balance:', accountInfo.value.uiAmountString, 'USDC');
  } catch {
    console.error('\nError: Lending Pool USDC ATA does not exist. Please fund the wallet first.');
    process.exit(1);
  }
  
  console.log('\nApproving relayer as delegate for Lending Pool...');
  
  try {
    const signature = await approve(
      connection,
      lendingKeypair,               // Payer (Lending Pool signs)
      lendingUsdcAta,               // Token account to approve
      relayerKeypair.publicKey,     // Delegate (relayer)
      lendingKeypair.publicKey,     // Owner (Lending Pool)
      DELEGATION_AMOUNT,            // Amount to approve
      [],                           // No additional signers
      { commitment: 'confirmed' }
    );
    
    console.log('✓ Delegation approved!');
    console.log('- Signature:', signature);
    console.log('- Explorer:', `https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  } catch (err) {
    console.error('Error approving delegation:', err);
    process.exit(1);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Setup complete! The relayer can now transfer USDC from Lending Pool.');
  console.log('Leveraged trades will now work.');
  console.log('='.repeat(60));
}

main().catch(console.error);

