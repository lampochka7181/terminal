import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export interface WalletEntry {
  pubkey: string;
  secretKey: string;
}

export interface LoadedWallet extends WalletEntry {
  keypair: Keypair;
}

// Detect whether cwd is already apps/loadtest or the repo root
function getWalletsDir(): string {
  // If cwd already contains package.json with our name, we're in apps/loadtest
  const cwdPkg = resolve(process.cwd(), 'package.json');
  if (existsSync(cwdPkg)) {
    try {
      const pkg = JSON.parse(readFileSync(cwdPkg, 'utf8'));
      if (pkg.name === '@degen/loadtest') return process.cwd();
    } catch {}
  }
  // Otherwise assume repo root
  return resolve(process.cwd(), 'apps', 'loadtest');
}

function getWalletsPath(): string {
  return resolve(getWalletsDir(), 'wallets.json');
}

export function generateWallets(count: number): LoadedWallet[] {
  console.log(`  Generating ${count} new wallets...`);
  const wallets: LoadedWallet[] = [];
  for (let i = 0; i < count; i++) {
    const kp = Keypair.generate();
    wallets.push({
      pubkey: kp.publicKey.toBase58(),
      secretKey: bs58.encode(kp.secretKey),
      keypair: kp,
    });
  }
  return wallets;
}

export function saveWallets(wallets: LoadedWallet[]): void {
  const data: WalletEntry[] = wallets.map(w => ({
    pubkey: w.pubkey,
    secretKey: w.secretKey,
  }));
  const outPath = getWalletsPath();
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`  Saved ${wallets.length} wallets to ${outPath}`);
}

export function loadWallets(): LoadedWallet[] {
  const path = getWalletsPath();
  if (!existsSync(path)) {
    return [];
  }
  const data: WalletEntry[] = JSON.parse(readFileSync(path, 'utf8'));
  console.log(`  Loaded ${data.length} wallets from ${path}`);
  return data.map(w => ({
    pubkey: w.pubkey,
    secretKey: w.secretKey,
    keypair: Keypair.fromSecretKey(bs58.decode(w.secretKey)),
  }));
}

export function loadOrGenerateWallets(count: number): LoadedWallet[] {
  const existing = loadWallets();
  if (existing.length >= count) {
    return existing.slice(0, count);
  }
  const wallets = generateWallets(count);
  saveWallets(wallets);
  return wallets;
}
