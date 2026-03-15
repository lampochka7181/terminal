import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';

import { buildCanonicalOrderMessage, canonicalOrderMessageToBase64 } from './order-auth.js';

describe('order auth', () => {
  it('encodes a stable canonical message payload', () => {
    const market = Keypair.generate().publicKey.toBase58();
    const wallet = Keypair.generate().publicKey.toBase58();
    const signer = Keypair.generate().publicKey.toBase58();

    const bytes = buildCanonicalOrderMessage({
      marketAddress: market,
      walletAddress: wallet,
      signerPublicKey: signer,
      side: 'BID',
      outcome: 'YES',
      orderType: 'LIMIT',
      price: 0.52,
      size: 10.25,
      expiryTs: 1_700_000_000,
      clientOrderId: 42,
    });

    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('DT_ORDER_V1');
    expect(text).toMatch(/^DT_ORDER_V1\nctx=[0-9a-f]{64}\np=520000\ns=10250000\ne=1700000000\nc=42$/);
    expect(canonicalOrderMessageToBase64({
      marketAddress: market,
      walletAddress: wallet,
      signerPublicKey: signer,
      side: 'BID',
      outcome: 'YES',
      orderType: 'LIMIT',
      price: 0.52,
      size: 10.25,
      expiryTs: 1_700_000_000,
      clientOrderId: 42,
    })).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('changes the payload when the signer changes', () => {
    const market = Keypair.generate().publicKey.toBase58();
    const wallet = Keypair.generate().publicKey.toBase58();
    const signerA = Keypair.generate().publicKey.toBase58();
    const signerB = Keypair.generate().publicKey.toBase58();

    const messageA = canonicalOrderMessageToBase64({
      marketAddress: market,
      walletAddress: wallet,
      signerPublicKey: signerA,
      side: 'ASK',
      outcome: 'NO',
      orderType: 'MARKET',
      price: 0.61,
      size: 25,
      expiryTs: 1_700_000_123,
      clientOrderId: 7,
    });
    const messageB = canonicalOrderMessageToBase64({
      marketAddress: market,
      walletAddress: wallet,
      signerPublicKey: signerB,
      side: 'ASK',
      outcome: 'NO',
      orderType: 'MARKET',
      price: 0.61,
      size: 25,
      expiryTs: 1_700_000_123,
      clientOrderId: 7,
    });

    expect(messageA).not.toBe(messageB);
  });
});
