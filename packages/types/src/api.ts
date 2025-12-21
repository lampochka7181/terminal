export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  error: ApiError;
}

export type ApiResponse<T> = T | ApiErrorResponse;

// Error codes
export const ErrorCodes = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  INVALID_PRICE: 'INVALID_PRICE',
  INVALID_SIZE: 'INVALID_SIZE',
  INVALID_TICK: 'INVALID_TICK',
  ORDER_EXPIRED: 'ORDER_EXPIRED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  POSITION_LIMIT_EXCEEDED: 'POSITION_LIMIT_EXCEEDED',
  ORDER_LIMIT_EXCEEDED: 'ORDER_LIMIT_EXCEEDED',
  MARKET_NOT_FOUND: 'MARKET_NOT_FOUND',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_ALREADY_FILLED: 'ORDER_ALREADY_FILLED',
  MARKET_CLOSED: 'MARKET_CLOSED',
  MARKET_CLOSING: 'MARKET_CLOSING',
  DUPLICATE_ORDER: 'DUPLICATE_ORDER',
  SELF_TRADE_PREVENTED: 'SELF_TRADE_PREVENTED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  PROTOCOL_PAUSED: 'PROTOCOL_PAUSED',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// Pagination
export interface PaginatedRequest {
  limit?: number;
  offset?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// Trade
export interface Trade {
  id: string;
  marketId: string;
  marketAddress: string;
  market: string;
  makerOrderId: string;
  takerOrderId: string;
  outcome: 'YES' | 'NO';
  price: number;
  size: number;
  notional: number;
  makerFee: number;
  takerFee: number;
  side: 'buy' | 'sell';
  txSignature?: string;
  executedAt: number;
}

// Stats
export interface PlatformStats {
  totalVolume24h: number;
  totalTrades24h: number;
  activeMarkets: number;
  totalUsers: number;
}

// Fees
export interface FeeSchedule {
  trading: {
    makerFee: number;
    takerFee: number;
  };
  settlement: {
    claimFee: number;
  };
  discounts: {
    volumeTiers: {
      minVolume: number;
      makerDiscount: number;
      takerDiscount: number;
    }[];
  };
}



