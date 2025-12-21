/**
 * Initialize Protocol Script
 * 
 * Run this ONCE to set up the on-chain global state before trading can begin.
 * 
 * Usage: npx tsx src/scripts/init-protocol.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { createHash } from 'crypto';
import { config } from '../config.js';

const PROGRAM_ID = new PublicKey(config.programId);

function computeDiscriminator(instructionName: string): Buffer {
  const hash = createHash('sha256')
    .update(`global:${instructionName}`)
    .digest();
  return hash.slice(0, 8);
}

function getGlobalStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global')],
    PROGRAM_ID
  );
}

async function initializeProtocol() {
  console.log('🚀 Initializing Degen Terminal Protocol...\n');

  // Check config
  if (!config.relayerPrivateKey) {
    console.error('❌ RELAYER_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  // Load relayer keypair (will be the admin)
  const relayerKeypair = Keypair.fromSecretKey(bs58.decode(config.relayerPrivateKey));
  console.log('Admin wallet:', relayerKeypair.publicKey.toBase58());

  // Fee recipient (use relayer if not set)
  const feeRecipient = config.feeRecipient 
    ? new PublicKey(config.feeRecipient)
    : relayerKeypair.publicKey;
  console.log('Fee recipient:', feeRecipient.toBase58());

  // Connect to Solana
  const connection = new Connection(config.solanaRpcUrl, 'confirmed');
  console.log('RPC:', config.solanaRpcUrl);
  console.log('Program ID:', PROGRAM_ID.toBase58());

  // Check relayer balance
  const balance = await connection.getBalance(relayerKeypair.publicKey);
  console.log('Relayer SOL balance:', (balance / 1e9).toFixed(4), 'SOL');

  if (balance < 0.01 * 1e9) {
    console.error('❌ Relayer has insufficient SOL. Need at least 0.01 SOL.');
    process.exit(1);
  }

  // Get global state PDA
  const [globalStatePda, bump] = getGlobalStatePda();
  console.log('Global State PDA:', globalStatePda.toBase58());
  console.log('Bump:', bump);

  // Check if already initialized
  const accountInfo = await connection.getAccountInfo(globalStatePda);
  if (accountInfo) {
    console.log('\n✅ Global state already initialized!');
    console.log('Account size:', accountInfo.data.length, 'bytes');
    console.log('Owner:', accountInfo.owner.toBase58());
    return;
  }

  console.log('\n📝 Building initialize_global instruction...');

  // Build instruction
  const discriminator = computeDiscriminator('initialize_global');
  console.log('Discriminator:', discriminator.toString('hex'));

  // Args: maker_fee_bps (u16) + taker_fee_bps (u16)
  const makerFeeBps = config.makerFeeBps || 0;   // 0%
  const takerFeeBps = config.takerFeeBps || 10;  // 0.10%
  
  const argsBuffer = Buffer.alloc(4);
  argsBuffer.writeUInt16LE(makerFeeBps, 0);
  argsBuffer.writeUInt16LE(takerFeeBps, 2);

  const data = Buffer.concat([discriminator, argsBuffer]);

  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: globalStatePda, isSigner: false, isWritable: true },
      { pubkey: relayerKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: feeRecipient, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  // Build and send transaction
  const transaction = new Transaction().add(instruction);
  
  console.log('\n📤 Sending transaction...');

  try {
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [relayerKeypair],
      { commitment: 'confirmed' }
    );

    console.log('\n✅ Protocol initialized successfully!');
    console.log('Transaction:', signature);
    console.log('Explorer:', `https://explorer.solana.com/tx/${signature}?cluster=devnet`);

    // Verify
    const newAccountInfo = await connection.getAccountInfo(globalStatePda);
    if (newAccountInfo) {
      console.log('\nGlobal state account created:');
      console.log('  Size:', newAccountInfo.data.length, 'bytes');
      console.log('  Owner:', newAccountInfo.owner.toBase58());
    }

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
initializeProtocol().catch(console.error);


