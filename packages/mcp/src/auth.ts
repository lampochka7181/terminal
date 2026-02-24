/**
 * Auto-authentication module for the MCP server.
 * Uses a Solana wallet private key to perform SIWS auth against the API.
 */

import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { api, setAuthToken, isAuthenticated } from './api-client.js';

let keypair: Keypair | null = null;
let walletAddress: string = '';

/**
 * Initialize the auth module with a wallet private key.
 */
export function initAuth(privateKeyBase58: string): string {
  const secretKey = bs58.decode(privateKeyBase58);
  keypair = Keypair.fromSecretKey(secretKey);
  walletAddress = keypair.publicKey.toBase58();
  return walletAddress;
}

export function getWalletAddress(): string {
  return walletAddress;
}

export function getKeypair(): Keypair | null {
  return keypair;
}

/**
 * Authenticate with the API using the wallet private key.
 * Calls POST /auth/agent → signs nonce → POST /auth/agent/verify → stores JWT.
 */
export async function authenticate(agentName?: string): Promise<void> {
  if (!keypair) {
    throw new Error('Auth not initialized. Call initAuth() first.');
  }

  if (isAuthenticated()) {
    return; // Already authenticated
  }

  // Step 1: Get nonce
  const nonceResult = await api.post<{ nonce: string; expiresAt: string }>(
    '/auth/agent',
    { address: walletAddress },
  );

  // Step 2: Sign the nonce message
  const messageBytes = new TextEncoder().encode(nonceResult.nonce);
  const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
  const signature = bs58.encode(signatureBytes);

  // Step 3: Verify and get JWT
  const verifyResult = await api.post<{
    token: string;
    expiresAt: number;
    isNewAgent: boolean;
    agent: { address: string; name: string | null; feeDiscountPct: number };
  }>('/auth/agent/verify', {
    address: walletAddress,
    signature,
    message: nonceResult.nonce,
    agentName,
  });

  // Store the JWT for subsequent API calls
  setAuthToken(verifyResult.token, verifyResult.expiresAt);
}

/**
 * Ensure we're authenticated before making an API call.
 * Re-authenticates if token has expired.
 */
export async function ensureAuthenticated(agentName?: string): Promise<void> {
  if (!isAuthenticated()) {
    await authenticate(agentName);
  }
}
