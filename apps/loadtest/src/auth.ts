import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

/**
 * Authenticate a wallet via SIWS flow:
 *   GET /auth/nonce → sign message → POST /auth/verify → JWT
 */
export async function authenticateWallet(
  keypair: Keypair,
  apiUrl: string,
): Promise<string> {
  const address = keypair.publicKey.toBase58();

  // Step 1: Get nonce
  const nonceResp = await fetch(`${apiUrl}/auth/nonce?address=${address}`);
  if (!nonceResp.ok) {
    throw new Error(`Nonce request failed (${nonceResp.status}): ${await nonceResp.text()}`);
  }
  const { nonce } = await nonceResp.json() as { nonce: string };

  // Step 2: Sign the nonce message with wallet keypair
  const messageBytes = new TextEncoder().encode(nonce);
  const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
  const signature = bs58.encode(signatureBytes);

  // Step 3: Verify and get JWT
  const verifyResp = await fetch(`${apiUrl}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, signature, message: nonce }),
  });

  if (!verifyResp.ok) {
    throw new Error(`Verify failed (${verifyResp.status}): ${await verifyResp.text()}`);
  }

  const { token } = await verifyResp.json() as { token: string; expiresAt: number };
  return token;
}

/**
 * Authenticate multiple wallets with concurrency limit.
 */
export async function authenticateAll(
  wallets: { keypair: Keypair; pubkey: string }[],
  apiUrl: string,
  concurrency: number = 10,
): Promise<Map<string, string>> {
  const tokens = new Map<string, string>(); // pubkey → JWT
  let idx = 0;

  async function worker() {
    while (idx < wallets.length) {
      const i = idx++;
      const w = wallets[i];
      try {
        const jwt = await authenticateWallet(w.keypair, apiUrl);
        tokens.set(w.pubkey, jwt);
      } catch (err: any) {
        console.error(`  Auth failed for ${w.pubkey.slice(0, 12)}...: ${err.message}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, wallets.length) }, () => worker());
  await Promise.all(workers);

  console.log(`  Authenticated ${tokens.size}/${wallets.length} wallets`);
  return tokens;
}
