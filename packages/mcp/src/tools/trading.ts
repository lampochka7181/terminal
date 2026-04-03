/**
 * Trading tools for AI agents.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { api } from '../api-client.js';
import { ensureAuthenticated, getKeypair, getWalletAddress } from '../auth.js';
import { ensureDelegation, setupDelegation } from '../delegation.js';

// ── Canonical order message encoding (mirrors packages/types/src/sessionAuth.ts) ──

const ORDER_MESSAGE_PREFIX_BYTES = Uint8Array.from([68, 84, 95, 79, 82, 68, 69, 82, 95, 86, 49]);

function sha256(message: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const rotr = (v: number, s: number) => (v >>> s) | (v << (32 - s));
  const add32 = (...vs: number[]) => vs.reduce((a, b) => (a + b) >>> 0, 0);
  const bitLength = message.length * 8;
  const paddedLength = (((message.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3);
      const s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10);
      w[i] = add32(w[i-16], s0, w[i-7], s1);
    }
    let [a,b,c,d,e,f,g,h] = [H[0],H[1],H[2],H[3],H[4],H[5],H[6],H[7]];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = add32(h, S1, ch, K[i], w[i]);
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = add32(S0, maj);
      [h,g,f,e,d,c,b,a] = [g, f, e, add32(d,t1), c, b, a, add32(t1,t2)];
    }
    H[0]=add32(H[0],a); H[1]=add32(H[1],b); H[2]=add32(H[2],c); H[3]=add32(H[3],d);
    H[4]=add32(H[4],e); H[5]=add32(H[5],f); H[6]=add32(H[6],g); H[7]=add32(H[7],h);
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i], false);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

function encodeAscii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function buildCanonicalOrderMessage(params: {
  marketAddress: string; walletAddress: string;
  side: 'BID' | 'ASK'; outcome: 'YES' | 'NO'; orderType: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
  price: bigint; size: bigint; expiryTs: bigint; clientOrderId: bigint;
}): Uint8Array {
  const market = new PublicKey(params.marketAddress).toBytes();
  const owner = new PublicKey(params.walletAddress).toBytes();
  const ctx = new Uint8Array(ORDER_MESSAGE_PREFIX_BYTES.length + 32 + 32 + 32 + 3);
  let off = 0;
  ctx.set(ORDER_MESSAGE_PREFIX_BYTES, off); off += ORDER_MESSAGE_PREFIX_BYTES.length;
  ctx.set(market, off); off += 32;
  ctx.set(owner, off); off += 32;
  ctx.set(owner, off); off += 32; // signer = owner for MCP wallet orders
  ctx[off++] = params.side === 'BID' ? 0 : 1;
  ctx[off++] = params.outcome === 'YES' ? 0 : 1;
  ctx[off++] = ['LIMIT','MARKET','IOC','FOK'].indexOf(params.orderType);
  const contextHash = bytesToHex(sha256(ctx));
  const text = [
    'DT_ORDER_V1',
    `ctx=${contextHash}`,
    `p=${params.price}`,
    `s=${params.size}`,
    `e=${params.expiryTs}`,
    `c=${params.clientOrderId}`,
  ].join('\n');
  return encodeAscii(text);
}

function signOrder(params: {
  marketAddress: string; walletAddress: string;
  side: 'BID' | 'ASK'; outcome: 'YES' | 'NO'; orderType: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
  price: number; size: number; expiryTs: number; clientOrderId: number;
}): { binaryMessage: string; signature: string } {
  const keypair = getKeypair();
  if (!keypair) throw new Error('Wallet not initialized');
  const msgBytes = buildCanonicalOrderMessage({
    ...params,
    price: BigInt(Math.floor(params.price * 1_000_000)),
    size: BigInt(Math.floor(params.size * 1_000_000)),
    expiryTs: BigInt(params.expiryTs),
    clientOrderId: BigInt(params.clientOrderId),
  });
  const sigBytes = nacl.sign.detached(msgBytes, keypair.secretKey);
  return {
    binaryMessage: Buffer.from(msgBytes).toString('base64'),
    signature: bs58.encode(sigBytes),
  };
}

export function registerTradingTools(server: McpServer) {
  server.tool(
    'place_order',
    `Place a buy or sell order on a prediction market.
For BUY orders: specify side="bid", pick outcome (yes/no), set price ($0.01-$0.99) and size (number of contracts), or use dollarAmount for market orders.
For SELL orders: specify side="ask" to sell existing position shares.
The agent gets reduced trading fees automatically.`,
    {
      marketAddress: z.string().describe('Market on-chain address (pubkey)'),
      side: z.enum(['bid', 'ask']).describe('"bid" to buy, "ask" to sell'),
      outcome: z.enum(['yes', 'no']).describe('Which outcome to trade'),
      type: z.enum(['limit', 'market']).default('limit').describe('Order type'),
      price: z.number().min(0.01).max(0.99).describe('Price per contract ($0.01-$0.99)'),
      size: z.number().min(0.001).max(100000).describe('Number of contracts'),
      dollarAmount: z.number().min(0.02).max(1000000).optional().describe('Total dollar amount for market orders'),
    },
    async ({ marketAddress, side, outcome, type, price, size, dollarAmount }) => {
      try {
        await ensureAuthenticated();

        // Check delegation before trading
        const delStatus = await ensureDelegation(dollarAmount || price * size);
        if (!delStatus.ready) {
          return {
            content: [{
              type: 'text' as const,
              text: delStatus.message + '\n\nUse the setup_delegation tool to authorize USDC spending for trading.',
            }],
          };
        }

        const clientOrderId = Date.now();
        const expiry = Math.floor(Date.now() / 1000) + 3600;
        const canonicalSize = type === 'market' && side === 'bid' && dollarAmount ? dollarAmount : size;
        const { binaryMessage, signature } = signOrder({
          marketAddress,
          walletAddress: getWalletAddress(),
          side: side.toUpperCase() as 'BID' | 'ASK',
          outcome: outcome.toUpperCase() as 'YES' | 'NO',
          orderType: type.toUpperCase() as 'LIMIT' | 'MARKET' | 'IOC' | 'FOK',
          price,
          size: canonicalSize,
          expiryTs: expiry,
          clientOrderId,
        });

        const result = await api.post('/orders/notify', {
          marketAddress,
          side,
          outcome,
          type,
          price,
          size,
          dollarAmount,
          expiry,
          clientOrderId,
          signature,
          binaryMessage,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              orderId: result.orderId,
              status: result.status,
              fills: result.fills,
              filledSize: result.filledSize,
              avgPrice: result.avgPrice,
              position: result.position,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Order failed: ${err.message}`,
          }],
        };
      }
    },
  );

  server.tool(
    'cancel_order',
    'Cancel an open order by its ID.',
    {
      orderId: z.string().describe('Order UUID to cancel'),
    },
    async ({ orderId }) => {
      try {
        await ensureAuthenticated();

        const keypair = getKeypair();
        if (!keypair) throw new Error('Wallet not initialized');

        const messageBytes = new TextEncoder().encode(`cancel:${orderId}`);
        const sigBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
        const signature = bs58.encode(sigBytes);

        const result = await api.delete(`/orders/${orderId}`, { signature });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, cancelled: orderId, ...result }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Cancel failed: ${err.message}`,
          }],
        };
      }
    },
  );

  server.tool(
    'cancel_all_orders',
    'Cancel all open orders, optionally filtered by market.',
    {
      marketAddress: z.string().optional().describe('Only cancel orders in this market'),
    },
    async ({ marketAddress }) => {
      try {
        await ensureAuthenticated();

        const params = marketAddress ? `?marketAddress=${marketAddress}` : '';
        const result = await api.delete(`/orders${params}`);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, ...result }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Cancel all failed: ${err.message}`,
          }],
        };
      }
    },
  );

  server.tool(
    'setup_delegation',
    `Authorize the platform to trade USDC on your behalf. This creates an on-chain "approve" transaction
that allows the relayer to execute trades using your USDC. You must do this before placing orders.`,
    {
      amount: z.number().min(1).describe('Amount of USDC to authorize for trading'),
    },
    async ({ amount }) => {
      try {
        await ensureAuthenticated();

        const signature = await setupDelegation(amount);

        return {
          content: [{
            type: 'text' as const,
            text: `Delegation set up successfully!\n\nAuthorized $${amount.toFixed(2)} USDC for trading.\nTransaction: ${signature}\n\nYou can now place orders.`,
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Delegation setup failed: ${err.message}\n\nMake sure your wallet has SOL for transaction fees and USDC for trading.`,
          }],
        };
      }
    },
  );
}
