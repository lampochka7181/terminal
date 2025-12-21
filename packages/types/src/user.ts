export interface User {
  id: string;
  walletAddress: string;
  createdAt: number;
  lastLoginAt?: number;
  totalVolume: number;
  totalTrades: number;
  feeTier: number;
  isBanned: boolean;
}

export interface UserBalance {
  total: number;
  available: number;
  lockedInOrders: number;
  pendingSettlement: number;
}

export interface AuthNonceResponse {
  nonce: string;
}

export interface AuthVerifyRequest {
  address: string;
  signature: string;
  message: string;
}

export interface AuthVerifyResponse {
  token: string;
  expiresAt: number;
}



