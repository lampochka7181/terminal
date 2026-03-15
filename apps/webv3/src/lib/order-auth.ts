import { encodeCanonicalOrderMessage, type CanonicalOrderOutcome, type CanonicalOrderSide, type CanonicalOrderType } from '@degen/types';
import { PublicKey } from '@solana/web3.js';

export interface CanonicalOrderParams {
  marketAddress: string;
  walletAddress: string;
  signerPublicKey: string;
  side: CanonicalOrderSide;
  outcome: CanonicalOrderOutcome;
  orderType: CanonicalOrderType;
  price: number;
  size: number;
  expiryTs: number;
  clientOrderId: number;
}

export function buildCanonicalOrderMessage(params: CanonicalOrderParams): Uint8Array {
  return encodeCanonicalOrderMessage({
    market: new PublicKey(params.marketAddress).toBytes(),
    owner: new PublicKey(params.walletAddress).toBytes(),
    signer: new PublicKey(params.signerPublicKey).toBytes(),
    side: params.side,
    outcome: params.outcome,
    orderType: params.orderType,
    price: BigInt(Math.floor(params.price * 1_000_000)),
    size: BigInt(Math.floor(params.size * 1_000_000)),
    expiryTs: BigInt(params.expiryTs),
    clientOrderId: BigInt(params.clientOrderId),
  });
}
