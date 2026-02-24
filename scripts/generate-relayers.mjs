/**
 * Generate Relayer Wallets (standalone — no tsx required)
 * 
 * Usage: node scripts/generate-relayers.mjs [count]
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import crypto from 'crypto';

// ─── Load .env manually ────────────────────────────────────────────────────
function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), '.env');
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}
loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not found in .env');
  process.exit(1);
}

// ─── Ed25519 keypair generation using Node.js crypto ───────────────────────
function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  
  // Export raw key bytes
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' });
  
  // Ed25519 SPKI DER has a 12-byte prefix, then 32 bytes of public key
  const pubBytes = pubRaw.slice(pubRaw.length - 32);
  
  // Ed25519 PKCS8 DER has a 16-byte prefix, then 34 bytes (2 byte wrapper + 32 byte seed)
  // The actual seed starts at offset 16+2 = 18
  const privSeed = privRaw.slice(16 + 2, 16 + 2 + 32);
  
  // Solana keypair format: 64 bytes = [32-byte seed][32-byte pubkey]
  const secretKey = Buffer.concat([privSeed, pubBytes]);
  
  return { publicKey: pubBytes, secretKey };
}

// ─── Base58 encoding ───────────────────────────────────────────────────────
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer) {
  const bytes = Buffer.from(buffer);
  const digits = [0];
  
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  
  // leading zeros
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    digits.push(0);
  }
  
  return digits.reverse().map(d => ALPHABET[d]).join('');
}

// ─── Direct Postgres query via pg (available in node_modules) ──────────────
// We'll use dynamic import to load pg from the workspace

async function main() {
  const count = parseInt(process.argv[2] || '5');
  
  console.log(`\nGenerating ${count} relayer wallets...\n`);
  
  const wallets = [];
  for (let i = 0; i < count; i++) {
    const kp = generateKeypair();
    const pubkey = base58Encode(kp.publicKey);
    const secretKey = base58Encode(kp.secretKey);
    wallets.push({ pubkey, secretKey });
    console.log(`  [${i + 1}] ${pubkey}`);
  }
  
  // Insert into database using the Supabase REST API or direct pg
  // Try to use native fetch with Supabase REST first
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (supabaseUrl && supabaseKey) {
    console.log('\nInserting into database via Supabase REST API...');
    
    for (const wallet of wallets) {
      const resp = await fetch(`${supabaseUrl}/rest/v1/relayer_wallets`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=ignore-duplicates',
        },
        body: JSON.stringify({
          pubkey: wallet.pubkey,
          secret_key: wallet.secretKey,
          status: 'active',
          balance_lamports: 0,
          active_jobs: 0,
          total_submitted: 0,
          total_failed: 0,
          consecutive_failures: 0,
        }),
      });
      
      if (!resp.ok) {
        const text = await resp.text();
        console.error(`  ❌ Failed to insert ${wallet.pubkey.slice(0, 12)}...: ${text}`);
      }
    }
  } else {
    console.log('\nNo SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY found.');
    console.log('Printing SQL for manual insertion:\n');
    
    for (const wallet of wallets) {
      console.log(`INSERT INTO relayer_wallets (pubkey, secret_key, status) VALUES ('${wallet.pubkey}', '${wallet.secretKey}', 'active') ON CONFLICT DO NOTHING;`);
    }
  }
  
  console.log(`\n✅ ${count} relayer wallets generated.`);
  console.log('\nPublic keys to fund on devnet:');
  for (const w of wallets) {
    console.log(`  ${w.pubkey}`);
  }
  console.log('');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
