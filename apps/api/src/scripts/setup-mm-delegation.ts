#!/usr/bin/env node
console.log('Script starting...');
/**
 * Setup MM Token Delegation
 * 
 * This script approves the relayer to spend USDC from the MM wallet.
 * This is required for the relayer to submit execute_match transactions
 * where the MM is a party (as MM orders don't go through place_order escrow).
 * 
 * Run: npx ts-node apps/api/src/scripts/setup-mm-delegation.ts
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
  console.log('MM Token Delegation Setup');
  console.log('='.repeat(60));
  
  // Load MM private key
  const mmPrivateKey = process.env.MM_PRIVATE_KEY || process.env.MM_WALLET_PRIVATE_KEY;
  if (!mmPrivateKey) {
    throw new Error('MM_PRIVATE_KEY environment variable not set');
  }
  
  // Load relayer private key
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerPrivateKey) {
    throw new Error('RELAYER_PRIVATE_KEY environment variable not set');
  }
  
  // Parse keypairs
  let mmKeypair: Keypair;
  let relayerKeypair: Keypair;
  
  try {
    // Try base58 first
    mmKeypair = Keypair.fromSecretKey(bs58.decode(mmPrivateKey));
  } catch {
    // Try JSON array
    try {
      const secretKey = JSON.parse(mmPrivateKey);
      mmKeypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
    } catch {
      throw new Error('Invalid MM_PRIVATE_KEY format. Must be base58 or JSON array.');
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
  console.log('- MM Wallet:', mmKeypair.publicKey.toBase58());
  console.log('- Relayer (Delegate):', relayerKeypair.publicKey.toBase58());
  console.log('- Delegation Amount:', (DELEGATION_AMOUNT / 1_000_000).toLocaleString(), 'USDC');
  
  // Connect to Solana
  const connection = new Connection(SOLANA_RPC, 'confirmed');
  
  // Get MM's USDC ATA
  const mmUsdcAta = await getAssociatedTokenAddress(
    USDC_MINT,
    mmKeypair.publicKey
  );
  
  console.log('\n- MM USDC ATA:', mmUsdcAta.toBase58());
  
  // Check if ATA exists and get balance
  try {
    const accountInfo = await connection.getTokenAccountBalance(mmUsdcAta);
    console.log('- Current USDC Balance:', accountInfo.value.uiAmountString, 'USDC');
  } catch {
    console.error('\nError: MM USDC ATA does not exist. Please fund the MM wallet first.');
    process.exit(1);
  }
  
  console.log('\nApproving relayer as delegate...');
  
  try {
    const signature = await approve(
      connection,
      mmKeypair,                    // Payer (MM signs)
      mmUsdcAta,                    // Token account to approve
      relayerKeypair.publicKey,    // Delegate (relayer)
      mmKeypair.publicKey,         // Owner (MM)
      DELEGATION_AMOUNT,           // Amount to approve
      [],                          // No additional signers
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
  console.log('Setup complete! The relayer can now transfer USDC from MM wallet.');
  console.log('='.repeat(60));
}

main().catch(console.error);

