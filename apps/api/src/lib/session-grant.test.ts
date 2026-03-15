import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';

import { buildCanonicalSessionGrantMessage, canonicalSessionGrantMessageToBase64 } from './session-grant.js';

describe('session grant auth', () => {
  it('encodes a stable canonical session grant payload', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const sessionPubkey = Keypair.generate().publicKey.toBase58();

    const bytes = buildCanonicalSessionGrantMessage({
      walletAddress: wallet,
      sessionPublicKey: sessionPubkey,
      expiresAt: 1_700_000_000,
    });

    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('DT_SESSION_GRANT_V1\n')).toBe(true);
    expect(text).toContain(`wallet=${wallet}`);
    expect(text).toContain(`session_pubkey=${sessionPubkey}`);
    expect(text).toContain('expires_at=1700000000');
    expect(canonicalSessionGrantMessageToBase64({
      walletAddress: wallet,
      sessionPublicKey: sessionPubkey,
      expiresAt: 1_700_000_000,
    })).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('changes the payload when the session key changes', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const sessionA = Keypair.generate().publicKey.toBase58();
    const sessionB = Keypair.generate().publicKey.toBase58();

    const messageA = canonicalSessionGrantMessageToBase64({
      walletAddress: wallet,
      sessionPublicKey: sessionA,
      expiresAt: 1_700_000_123,
    });
    const messageB = canonicalSessionGrantMessageToBase64({
      walletAddress: wallet,
      sessionPublicKey: sessionB,
      expiresAt: 1_700_000_123,
    });

    expect(messageA).not.toBe(messageB);
  });
});
