import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { encodeCanonicalOrderMessage } from '@degen/types';

export interface OrderResult {
  success: boolean;
  latencyMs: number;
  fills: number;
  error?: string;
}

export interface Market {
  id: string;
  address: string;   // on-chain pubkey
  asset: string;
  timeframe: string;
  strike: number;
  expiry: number;    // unix timestamp ms
  status: string;
  volume24h: number;
  yesPrice: number | null;
  noPrice: number | null;
}

/**
 * Build canonical order message, sign it, and POST to /orders/notify.
 *
 * `outcome` controls which side of the binary market the order is buying.
 * Default is 'yes' for backwards compatibility with single-side runs.
 */
export async function submitMarketOrder(
  keypair: Keypair,
  jwt: string,
  market: Market,
  dollarAmount: number,
  apiUrl: string,
  orderIndex: number,
  outcome: 'yes' | 'no' = 'yes',
): Promise<OrderResult> {
  const t0 = Date.now();
  const outcomeUpper = outcome.toUpperCase() as 'YES' | 'NO';

  try {
    const walletAddress = keypair.publicKey.toBase58();
    const clientOrderId = Date.now() + orderIndex;
    const expiry = Math.floor(Date.now() / 1000) + 300; // 5 minutes
    const price = 0.99; // Market order uses extreme price
    const size = dollarAmount; // For market BID, size = dollarAmount in canonical message

    // Build canonical binary message (same as backend's buildExpectedOrderMessage)
    const binaryMessage = encodeCanonicalOrderMessage({
      market: new PublicKey(market.address).toBytes(),
      owner: keypair.publicKey.toBytes(),
      signer: keypair.publicKey.toBytes(),
      side: 'BID',
      outcome: outcomeUpper,
      orderType: 'MARKET',
      price: BigInt(Math.floor(price * 1_000_000)),
      size: BigInt(Math.floor(size * 1_000_000)),
      expiryTs: BigInt(expiry),
      clientOrderId: BigInt(clientOrderId),
    });

    const binaryMessageBase64 = Buffer.from(binaryMessage).toString('base64');

    // Sign the canonical message
    const signatureBytes = nacl.sign.detached(binaryMessage, keypair.secretKey);
    const signature = bs58.encode(signatureBytes);

    // Submit to API
    const resp = await fetch(`${apiUrl}/orders/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        marketAddress: market.address,
        side: 'bid',
        outcome,
        type: 'market',
        price,
        size: 1, // placeholder, dollarAmount is what matters for market orders
        dollarAmount,
        maxPrice: 0.99,
        expiry,
        clientOrderId,
        signature,
        binaryMessage: binaryMessageBase64,
      }),
    });

    const latencyMs = Date.now() - t0;

    if (!resp.ok) {
      const errBody = await resp.text();
      return { success: false, latencyMs, fills: 0, error: `HTTP ${resp.status}: ${errBody.slice(0, 200)}` };
    }

    const result = await resp.json() as any;
    const fills = result.fills?.length ?? result.fillCount ?? 0;

    // Log first 3 orders for debugging
    if (orderIndex < 3) {
      console.log(`  [DEBUG order #${orderIndex}] status=${resp.status} fills=${fills} orderId=${result.orderId || 'n/a'} resp=${JSON.stringify(result).slice(0, 300)}`);
    }

    return { success: true, latencyMs, fills };
  } catch (err: any) {
    return { success: false, latencyMs: Date.now() - t0, fills: 0, error: err.message };
  }
}

/**
 * Fetch current open markets from the API.
 */
export async function fetchOpenMarkets(apiUrl: string): Promise<Market[]> {
  const resp = await fetch(`${apiUrl}/markets?status=OPEN`);
  if (!resp.ok) {
    throw new Error(`Failed to fetch markets (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json() as any;
  // API returns a flat array
  const markets: Market[] = Array.isArray(data) ? data : data.markets || [];

  // Debug: log raw first market to verify field names
  if (markets.length > 0) {
    console.log(`  [DEBUG] Raw market sample: ${JSON.stringify(markets[0])}`);
  }

  return markets;
}
