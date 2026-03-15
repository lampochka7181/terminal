const ORDER_MESSAGE_PREFIX = 'DT_ORDER_V1';
const ORDER_MESSAGE_PREFIX_BYTES = Uint8Array.from([
  68, 84, 95, 79, 82, 68, 69, 82, 95, 86, 49,
]);

export type CanonicalOrderSide = 'BID' | 'ASK';
export type CanonicalOrderOutcome = 'YES' | 'NO';
export type CanonicalOrderType = 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';

export interface CanonicalOrderMessage {
  market: Uint8Array;
  owner: Uint8Array;
  signer: Uint8Array;
  side: CanonicalOrderSide;
  outcome: CanonicalOrderOutcome;
  orderType: CanonicalOrderType;
  price: bigint;
  size: bigint;
  expiryTs: bigint;
  clientOrderId: bigint;
}

export function encodeCanonicalOrderMessage(message: CanonicalOrderMessage): Uint8Array {
  const contextHash = bytesToHex(sha256(encodeCanonicalOrderContext(message)));
  const text = [
    ORDER_MESSAGE_PREFIX,
    `ctx=${contextHash}`,
    `p=${message.price.toString()}`,
    `s=${message.size.toString()}`,
    `e=${message.expiryTs.toString()}`,
    `c=${message.clientOrderId.toString()}`,
  ].join('\n');
  return encodeAscii(text);
}

function encodeCanonicalOrderContext(message: CanonicalOrderMessage): Uint8Array {
  const bytes = new Uint8Array(ORDER_MESSAGE_PREFIX_BYTES.length + 32 + 32 + 32 + 3);
  let offset = 0;

  bytes.set(ORDER_MESSAGE_PREFIX_BYTES, offset);
  offset += ORDER_MESSAGE_PREFIX_BYTES.length;

  bytes.set(assertPubkeyLength(message.market, 'market'), offset);
  offset += 32;
  bytes.set(assertPubkeyLength(message.owner, 'owner'), offset);
  offset += 32;
  bytes.set(assertPubkeyLength(message.signer, 'signer'), offset);
  offset += 32;

  bytes[offset++] = encodeSide(message.side);
  bytes[offset++] = encodeOutcome(message.outcome);
  bytes[offset++] = encodeOrderType(message.orderType);

  return bytes;
}

function assertPubkeyLength(bytes: Uint8Array, label: string): Uint8Array {
  if (bytes.length !== 32) {
    throw new Error(`${label} must be 32 bytes`);
  }
  return bytes;
}

function encodeSide(side: CanonicalOrderSide): number {
  return side === 'BID' ? 0 : 1;
}

function encodeOutcome(outcome: CanonicalOrderOutcome): number {
  return outcome === 'YES' ? 0 : 1;
}

function encodeOrderType(orderType: CanonicalOrderType): number {
  switch (orderType) {
    case 'LIMIT':
      return 0;
    case 'MARKET':
      return 1;
    case 'IOC':
      return 2;
    case 'FOK':
      return 3;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function encodeAscii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      throw new Error('Canonical order message must be ASCII');
    }
    bytes[i] = code;
  }
  return bytes;
}

// Small self-contained SHA-256 so the shared types package stays dependency-free.
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
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

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
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = add32(w[i - 16], s0, w[i - 7], s1);
    }

    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = add32(h, S1, ch, K[i], w[i]);
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = add32(S0, maj);

      h = g;
      g = f;
      f = e;
      e = add32(d, temp1);
      d = c;
      c = b;
      b = a;
      a = add32(temp1, temp2);
    }

    H[0] = add32(H[0], a);
    H[1] = add32(H[1], b);
    H[2] = add32(H[2], c);
    H[3] = add32(H[3], d);
    H[4] = add32(H[4], e);
    H[5] = add32(H[5], f);
    H[6] = add32(H[6], g);
    H[7] = add32(H[7], h);
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) {
    outView.setUint32(i * 4, H[i], false);
  }
  return out;
}

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

function add32(...values: number[]): number {
  let result = 0;
  for (const value of values) {
    result = (result + value) >>> 0;
  }
  return result;
}
