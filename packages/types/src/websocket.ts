import type { OrderbookUpdate } from './order.js';
import type { Trade } from './api.js';

// Client -> Server messages
export type WsClientMessage =
  | { op: 'ping' }
  | { op: 'subscribe'; channel: 'orderbook'; market: string }
  | { op: 'subscribe'; channel: 'trades'; market: string }
  | { op: 'subscribe'; channel: 'prices'; assets: string[] }
  | { op: 'unsubscribe'; channel: string; market?: string }
  | { op: 'auth'; token: string }
  | { op: 'snapshot'; channel: 'orderbook'; market: string; lastSeqId: number };

// Server -> Client messages
export type WsServerMessage =
  | { op: 'pong'; serverTime: number }
  | { op: 'subscribed'; channel: string; market?: string }
  | { op: 'unsubscribed'; channel: string; market?: string }
  | { op: 'auth'; status: 'authenticated' | 'failed'; wallet?: string }
  | { op: 'error'; message: string }
  | WsOrderbookUpdate
  | WsTradeUpdate
  | WsPriceUpdate
  | WsMarketResolved
  | WsSettlement
  | WsFillUpdate;

export interface WsOrderbookUpdate {
  channel: 'orderbook';
  market: string;
  data: OrderbookUpdate;
  snapshot?: boolean;
}

export interface WsTradeUpdate {
  channel: 'trades';
  market: string;
  data: {
    price: number;
    size: number;
    outcome: 'yes' | 'no';
    side: 'buy' | 'sell';
    timestamp: number;
  };
}

export interface WsPriceUpdate {
  channel: 'prices';
  data: {
    asset: string;
    price: number;
    timestamp: number;
  };
}

export interface WsMarketResolved {
  channel: 'market';
  market: string;
  event: 'resolved';
  data: {
    outcome: 'yes' | 'no';
    finalPrice: number;
    strikePrice: number;
    resolvedAt: number;
  };
}

export interface WsSettlement {
  channel: 'user';
  event: 'settlement';
  data: {
    marketAddress: string;
    outcome: 'yes' | 'no';
    yourShares: number;
    payout: number;
    profit: number;
    newBalance: number;
    txSignature: string;
  };
}

export interface WsFillUpdate {
  channel: 'user';
  event: 'fill';
  data: {
    orderId: string;
    marketAddress: string;
    side: 'bid' | 'ask';
    outcome: 'yes' | 'no';
    price: number;
    filledSize: number;
    remainingSize: number;
    status: string;
    timestamp: number;
  };
}



