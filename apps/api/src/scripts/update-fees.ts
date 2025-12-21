import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { config } from '../config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function updateFees() {
  console.log('🔄 Updating On-Chain Protocol Fees...\n');

  if (!config.relayerPrivateKey) {
    console.error('❌ RELAYER_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  // Load IDL
  const idlPath = path.resolve(__dirname, '../../../../packages/contracts/target/idl/degen_terminal.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));

  // Setup Connection & Provider
  const connection = new Connection(config.solanaRpcUrl, 'confirmed');
  const relayerKeypair = Keypair.fromSecretKey(bs58.decode(config.relayerPrivateKey));
  const wallet = new anchor.Wallet(relayerKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  
  const programId = new PublicKey(config.programId);
  const program = new anchor.Program(idl, programId, provider);

  // Derive Global State PDA
  const [globalStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('global')],
    program.programId
  );

  console.log('Program ID:', program.programId.toBase58());
  console.log('Global State PDA:', globalStatePda.toBase58());
  console.log('Admin (Relayer):', relayerKeypair.publicKey.toBase58());
  console.log(`Setting Maker Fee: ${config.makerFeeBps} bps`);
  console.log(`Setting Taker Fee: ${config.takerFeeBps} bps`);

  try {
    const tx = await program.methods
      .updateConfig(
        config.makerFeeBps,
        config.takerFeeBps
      )
      .accounts({
        globalState: globalStatePda,
        admin: relayerKeypair.publicKey,
        newFeeRecipient: null,
      } as any)
      .rpc();

    console.log('\n✅ Fees updated successfully!');
    console.log('Transaction:', tx);
    console.log('Explorer:', `https://explorer.solana.com/tx/${tx}?cluster=devnet`);

    // Verify
    const state: any = await program.account.globalState.fetch(globalStatePda);
    console.log('\nUpdated State:');
    console.log('  Maker Fee:', state.makerFeeBps, 'bps');
    console.log('  Taker Fee:', state.takerFeeBps, 'bps');
    console.log('  Fee Recipient:', state.feeRecipient.toBase58());

  } catch (err: any) {
    console.error('\n❌ Transaction failed:', err.message);
    if (err.logs) {
      console.error('\nProgram logs:', err.logs);
    }
  }
}

updateFees().catch(console.error);

