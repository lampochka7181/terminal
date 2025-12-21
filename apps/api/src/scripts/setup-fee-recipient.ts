/**
 * Setup Fee Recipient ATA
 * 
 * Creates the USDC Associated Token Account for the fee recipient wallet.
 * This is required before any trades can execute (fees need somewhere to go).
 * 
 * Usage: npx tsx src/scripts/setup-fee-recipient.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from '../config.js';

const USDC_MINT = new PublicKey(config.usdcMint);

async function setupFeeRecipient() {
  console.log('💰 Setting up Fee Recipient USDC Account...\n');

  // Check config
  if (!config.relayerPrivateKey) {
    console.error('❌ RELAYER_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  // Load relayer keypair (will pay for ATA creation)
  const relayerKeypair = Keypair.fromSecretKey(bs58.decode(config.relayerPrivateKey));
  console.log('Relayer (payer):', relayerKeypair.publicKey.toBase58());

  // Fee recipient wallet
  const feeRecipientWallet = config.feeRecipient 
    ? new PublicKey(config.feeRecipient)
    : relayerKeypair.publicKey;
  console.log('Fee recipient wallet:', feeRecipientWallet.toBase58());
  console.log('USDC Mint:', USDC_MINT.toBase58());

  // Connect to Solana
  const connection = new Connection(config.solanaRpcUrl, 'confirmed');
  console.log('RPC:', config.solanaRpcUrl);

  // Check relayer balance
  const balance = await connection.getBalance(relayerKeypair.publicKey);
  console.log('Relayer SOL balance:', (balance / 1e9).toFixed(4), 'SOL');

  if (balance < 0.01 * 1e9) {
    console.error('❌ Relayer has insufficient SOL. Need at least 0.01 SOL.');
    process.exit(1);
  }

  // Get the ATA address
  const feeRecipientAta = await getAssociatedTokenAddress(
    USDC_MINT,
    feeRecipientWallet
  );
  console.log('\nFee recipient ATA:', feeRecipientAta.toBase58());

  // Check if ATA already exists
  try {
    const accountInfo = await getAccount(connection, feeRecipientAta);
    console.log('\n✅ Fee recipient ATA already exists!');
    console.log('   Balance:', accountInfo.amount.toString(), 'raw units');
    console.log('   Owner:', accountInfo.owner.toBase58());
    return;
  } catch (err: any) {
    if (err.name !== 'TokenAccountNotFoundError') {
      throw err;
    }
    console.log('\nATA does not exist, creating...');
  }

  // Create the ATA
  const createAtaIx = createAssociatedTokenAccountInstruction(
    relayerKeypair.publicKey,  // payer
    feeRecipientAta,           // ata
    feeRecipientWallet,        // owner
    USDC_MINT                  // mint
  );

  const transaction = new Transaction().add(createAtaIx);

  console.log('\n📤 Sending transaction...');

  try {
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [relayerKeypair],
      { commitment: 'confirmed' }
    );

    console.log('\n✅ Fee recipient ATA created successfully!');
    console.log('Transaction:', signature);
    console.log('Explorer:', `https://explorer.solana.com/tx/${signature}?cluster=devnet`);

    // Verify
    const newAccount = await getAccount(connection, feeRecipientAta);
    console.log('\nATA details:');
    console.log('  Address:', feeRecipientAta.toBase58());
    console.log('  Owner:', newAccount.owner.toBase58());
    console.log('  Mint:', newAccount.mint.toBase58());

  } catch (err: any) {
    console.error('\n❌ Transaction failed:', err.message);
    if (err.logs) {
      console.error('\nProgram logs:');
      err.logs.forEach((log: string) => console.error('  ', log));
    }
    process.exit(1);
  }
}

// Run
setupFeeRecipient().catch(console.error);

