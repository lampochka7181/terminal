import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, createTransferInstruction, getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Load .env
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const USDC = new PublicKey('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr');
let rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
if (rpc.startsWith('wss://')) rpc = rpc.replace('wss://', 'https://');
const conn = new Connection(rpc, 'confirmed');
const funder = Keypair.fromSecretKey(bs58.decode(process.env.FUNDING_WALLET_PRIVATE_KEY));
const fundingAta = await getAssociatedTokenAddress(USDC, funder.publicKey);

const unfunded = [
  'EixLtjnYcwgyK2aUpCxenUMDKSvaVZedk2bS1vJ9tSNm',
  'DzGtDtNWT7datM9ACVx8o6QZVM9kU5fD8xhinJdiEA9A',
  '2VLieQS8jjpL1C7PjQbmLMH5gD6WRiJb5ovptEckpBqH',
  'D3batVidp1v8tEKsMNcy5ZqTvRuJvRigPjVZ2EnVh7Bt',
  '57uF2bH1dfnX6tVeA9Xt6KPWMxSe4FWKquWqqZKccxj2',
  'DGknQwecdhwtan3BTFiDJAWXZX9Sk1iwfy92PeX4KJDJ',
  'B6fFQA5qcgnaygyBMsY5RPzbApNb3WHvSzdjsEgexaHw',
  'CANwEyrDhYMHn6A6MD4gb8ZEf4BTQPSS8yrVasTJxZYJ',
];

const amount = BigInt(2000 * 1_000_000); // 2000 USDC

for (const pubkey of unfunded) {
  try {
    console.log(`Funding ${pubkey.slice(0, 16)}...`);
    const recipientAta = await getOrCreateAssociatedTokenAccount(conn, funder, USDC, new PublicKey(pubkey));
    const tx = new Transaction().add(createTransferInstruction(fundingAta, recipientAta.address, funder.publicKey, amount));
    const sig = await sendAndConfirmTransaction(conn, tx, [funder], { commitment: 'confirmed', maxRetries: 5 });
    console.log(`  ✅ ${sig.slice(0, 20)}...`);
  } catch (err) {
    console.log(`  ❌ ${err.message}`);
  }
  await new Promise(r => setTimeout(r, 2000)); // 2s delay between transfers
}

console.log('Done');
