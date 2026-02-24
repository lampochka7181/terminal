import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
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

let rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
if (rpc.startsWith('wss://')) rpc = rpc.replace('wss://', 'https://');

const conn = new Connection(rpc, 'confirmed');
const relayer = Keypair.fromSecretKey(bs58.decode(process.env.RELAYER_PRIVATE_KEY));
const funding = Keypair.fromSecretKey(bs58.decode(process.env.FUNDING_WALLET_PRIVATE_KEY));

const relBal = await conn.getBalance(relayer.publicKey);
const fundBal = await conn.getBalance(funding.publicKey);

console.log(`Relayer: ${relayer.publicKey.toBase58()} Balance: ${(relBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
console.log(`Funding: ${funding.publicKey.toBase58()} Balance: ${(fundBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
