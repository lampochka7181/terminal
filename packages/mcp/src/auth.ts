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
let agentName: string = '';

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

export function getAgentName(): string {
  return agentName;
}

export function getKeypair(): Keypair | null {
  return keypair;
}

export function isAuthInitialized(): boolean {
  return !!keypair;
}

/**
 * Authenticate with the API using the wallet private key.
 * Uses the standard SIWS flow: GET /auth/nonce → sign → POST /auth/verify → store JWT.
 * This is the normal user auth path (not the /auth/agent path which is blocked for orders).
 */
export async function authenticate(name?: string): Promise<void> {
  if (!keypair) {
    throw new Error('Auth not initialized. Call initAuth() first.');
  }

  if (name) agentName = name;

  if (isAuthenticated()) {
    return;
  }

  const nonceResult = await api.get<{ nonce: string }>(
    '/auth/nonce',
    { address: walletAddress },
  );

  const messageBytes = new TextEncoder().encode(nonceResult.nonce);
  const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
  const signature = bs58.encode(signatureBytes);

  const verifyResult = await api.post<{ token: string; expiresAt: number }>(
    '/auth/verify',
    {
      address: walletAddress,
      signature,
      message: nonceResult.nonce,
    },
  );

  setAuthToken(verifyResult.token, verifyResult.expiresAt);
  console.error(`[degen-terminal] Authenticated${agentName ? ` as "${agentName}"` : ''} (wallet: ${walletAddress})`);
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
