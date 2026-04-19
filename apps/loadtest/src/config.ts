import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Load .env from repo root ───────────────────────────────────────────────

function loadEnv() {
  const envPaths = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '..', '..', '.env'),
    resolve(process.cwd(), 'apps', 'api', '.env'),
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
        const val = trimmed.slice(eqIdx + 1).trim();
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

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return val;
}

function sanitizeRpcUrl(url: string): string {
  if (url.startsWith('wss://')) return url.replace('wss://', 'https://');
  if (url.startsWith('ws://')) return url.replace('ws://', 'http://');
  return url;
}

export const config = {
  apiUrl: process.env.LOADTEST_API_URL || 'http://localhost:4000',
  rpcUrl: sanitizeRpcUrl(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com'),
  usdcMint: process.env.USDC_MINT || 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
  fundingPrivateKey: requireEnv('FUNDING_WALLET_PRIVATE_KEY'),
  relayerPrivateKey: requireEnv('RELAYER_PRIVATE_KEY'),

  // Supabase (for user registration)
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '',

  // Tuning
  // Default 100 wallets so the runner can split the cohort 50/50 between YES
  // buyers and NO buyers — exercises both sides of the book and avoids the
  // single-outcome bias that previously masked symmetric position-tracking
  // bugs on the unused side.
  numWallets: parseInt(process.env.LOADTEST_NUM_WALLETS || '100'),
  ratePerSec: parseInt(process.env.LOADTEST_RATE || '7'),
  dollarPerOrder: parseFloat(process.env.LOADTEST_DOLLAR_AMOUNT || '5'),
  solPerUser: 0.01,
  usdcPerUser: 50,
  delegationAmount: 1_000_000, // $1M effectively unlimited
  usdcDecimals: 6,
  batchSize: 10,
  txDelayMs: 400,
};
