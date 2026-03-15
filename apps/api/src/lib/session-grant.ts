import { encodeCanonicalSessionGrantMessage } from '@degen/types';
import { PublicKey } from '@solana/web3.js';

import { PROGRAM_ID, getSessionAuthorityPda } from './anchor-client.js';

export interface CanonicalSessionGrantParams {
  walletAddress: string;
  sessionPublicKey: string;
  expiresAt: number;
}

export function buildCanonicalSessionGrantMessage(
  params: CanonicalSessionGrantParams
): Uint8Array {
  const wallet = new PublicKey(params.walletAddress);
  const sessionPubkey = new PublicKey(params.sessionPublicKey);
  const sessionAuthority = getSessionAuthorityPda(wallet, sessionPubkey);

  return encodeCanonicalSessionGrantMessage({
    programId: PROGRAM_ID.toBytes(),
    wallet: wallet.toBytes(),
    sessionPubkey: sessionPubkey.toBytes(),
    sessionAuthority: sessionAuthority.toBytes(),
    expiresAt: BigInt(params.expiresAt),
  });
}

export function canonicalSessionGrantMessageToBase64(
  params: CanonicalSessionGrantParams
): string {
  return Buffer.from(buildCanonicalSessionGrantMessage(params)).toString('base64');
}
