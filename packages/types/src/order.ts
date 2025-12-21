import type { Outcome } from './market.js';

export type OrderSide = 'BID' | 'ASK';
export type OrderType = 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
export type OrderStatus = 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED';

export interface Order {
  id: string;
  clientOrderId: string;
  marketId: string;
  marketAddress: string;
  userId: string;
  side: OrderSide;
  outcome: Outcome;
  orderType: OrderType;
  price: number;           // 0.01 - 0.99
  size: number;            // Total order size
  filledSize: number;      // Amount filled
  remainingSize: number;   // size - filledSize
  status: OrderStatus;
  signature: string;
  encodedInstruction: string;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
  cancelledAt?: number;
  cancelReason?: 'USER' | 'EXPIRED' | 'MARKET_CLOSED';
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface Orderbook {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  midPrice: number;
  spread: number;
  sequenceId: number;
}

export interface OrderbookUpdate {
  bids: [number, number][];  // [price, size] - size=0 means remove
  asks: [number, number][];
  sequenceId: number;
}

export interface PlaceOrderRequest {
  marketAddress: string;
  side: 'bid' | 'ask';
  outcome: 'yes' | 'no';
  type: 'limit' | 'market' | 'ioc' | 'fok';
  price: number;
  size: number;
  expiry?: number;
  signature: string;
  encodedInstruction: string;
}

export interface PlaceOrderResponse {
  orderId: string;
  status: string;
  createdAt: number;
}



