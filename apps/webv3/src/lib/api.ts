/**
 * API Client for Degen Terminal
 * Handles all HTTP requests to the backend
 */

import type {
  Market,
  MarketSummary,
  PriceFeed,
  Asset,
  Timeframe,
  MarketStatus,
} from '@degen/types';
import type {
  Trade,
  PlatformStats,
  FeeSchedule,
  ApiErrorResponse,
} from '@degen/types';

// API Configuration - use Vite env vars
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

// Types for API responses
export interface OrderbookSnapshot {
  bids: [number, number][]; // [price, size]
  asks: [number, number][];
  midPrice: number;
  spread: number;
  sequenceId: number;
}

export interface OrderResponse {
  orderId: string;
  status: 'open' | 'partial' | 'filled' | 'cancelled';
  createdAt: number;
  fills?: number;
  filledSize?: number;
  avgPrice?: number;
  leverage?: number;
  marginAccountId?: string;
  // Position data for immediate frontend update (included in response to avoid refetch)
  position?: Position | null;
}

export interface UserBalance {
  total: number;
  available: number;
  lockedInOrders: number;
  pendingSettlement: number;
}

export interface Position {
  marketAddress: string;
  market: string;
  asset: string;
  expiryAt: number;
  yesShares: number;
  noShares: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  totalCost?: number;
  status: 'open' | 'settled';
  createdAt?: number;
  // Leverage fields (only present if position is leveraged)
  leverage?: number;
  marginDeposited?: number;
  loanAmount?: number;
  liquidationPrice?: number;
  marginAccountId?: string;
}

export interface MarketPosition {
  marketAddress: string;
  market: string;
  yesShares: number;
  noShares: number;
  avgEntryYes: number;
  avgEntryNo: number;
  totalCost: number;
  realizedPnl: number;
  unrealizedYesPnl?: number;
  unrealizedNoPnl?: number;
  currentYesPrice?: number;
  currentNoPrice?: number;
  status: 'open' | 'settled';
}

export interface Order {
  id: string;
  marketAddress: string;
  market: string;
  asset: string;
  expiryAt: number;
  side: 'bid' | 'ask';
  outcome: 'yes' | 'no';
  type: 'limit' | 'market';
  price: number;
  size: number;
  filledSize: number;
  remainingSize: number;
  status: 'open' | 'partial' | 'filled' | 'cancelled';
  createdAt: number;
  updatedAt?: number;
  // Leverage fields (available before margin account exists, for pending orders)
  leverage?: number;       // 1 = no leverage, 2-10 = leveraged
  marginAmount?: number;   // User's margin amount deposited
}

export interface Settlement {
  marketAddress: string;
  market: string;
  outcome: 'yes' | 'no';
  yourPosition: 'yes' | 'no';
  shares: number;
  payout: number;
  profit: number;
  settledAt: number;
  txSignature: string;
}

// Unified transaction type for history view
export interface UserTransaction {
  id: string;
  type: 'trade' | 'settlement' | 'liquidation';
  transactionType: 'open' | 'close';
  marketAddress: string;
  market: string;
  asset: string;
  expiryAt: number;
  outcome: string;
  side: 'buy' | 'sell' | 'settlement' | 'liquidation';
  price: number;
  entryPrice?: number; // For liquidations - the original entry price
  size: number;
  notional: number;
  fee: number;
  pnl?: number;
  leverage?: number; // For liquidations
  loanRepaid?: number; // For liquidations
  txSignature: string;
  timestamp: number;
}

export interface AuthNonceResponse {
  nonce: string;
}

export interface AuthVerifyResponse {
  token: string;
  expiresAt: number;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  timestamp: number;
  version: string;
  services: {
    database: 'ok' | 'error';
    redis: 'ok' | 'error';
    solana: 'ok' | 'error';
  };
}

// Error handling
export class ApiError extends Error {
  code: string;
  details?: Record<string, unknown>;
  status: number;

  constructor(status: number, response: ApiErrorResponse) {
    super(response.error.message);
    this.name = 'ApiError';
    this.code = response.error.code;
    this.details = response.error.details;
    this.status = status;
  }
}

// Token management
let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
  if (token) {
    localStorage.setItem('auth_token', token);
  } else {
    localStorage.removeItem('auth_token');
  }
}

export function getAuthToken(): string | null {
  if (authToken) return authToken;
  if (typeof window !== 'undefined') {
    authToken = localStorage.getItem('auth_token');
  }
  return authToken;
}

// Base fetch wrapper with automatic retry for 503 (service overloaded)
async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {},
  retryCount = 0
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const token = getAuthToken();
  const MAX_RETRIES = 3;
  const BASE_RETRY_DELAY = 2000; // 2 seconds

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true', // Skip ngrok interstitial page
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  // Handle rate limiting
  const remaining = response.headers.get('X-RateLimit-Remaining');
  if (remaining && parseInt(remaining) < 10) {
    console.warn(`Rate limit warning: ${remaining} requests remaining`);
  }

  // Self-healing: Automatic retry for 503 (service overloaded / circuit breaker tripped)
  if (response.status === 503 && retryCount < MAX_RETRIES) {
    const retryAfter = response.headers.get('Retry-After');
    const delay = retryAfter 
      ? parseInt(retryAfter) * 1000 
      : BASE_RETRY_DELAY * Math.pow(2, retryCount); // Exponential backoff
    
    console.warn(`[API] Server overloaded, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    return apiFetch<T>(endpoint, options, retryCount + 1);
  }

  if (!response.ok) {
    let errorResponse: ApiErrorResponse;
    try {
      errorResponse = await response.json();
    } catch {
      errorResponse = {
        error: {
          code: 'INTERNAL_ERROR',
          message: `HTTP ${response.status}: ${response.statusText}`,
        },
      };
    }
    throw new ApiError(response.status, errorResponse);
  }

  return response.json();
}

// ===================
// System Endpoints
// ===================

export async function getHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/health');
}

export async function getServerTime(): Promise<{ serverTime: number }> {
  return apiFetch<{ serverTime: number }>('/time');
}

// ===================
// Authentication
// ===================

export async function getNonce(address: string): Promise<AuthNonceResponse> {
  return apiFetch<AuthNonceResponse>(`/auth/nonce?address=${address}`);
}

export async function verifySignature(
  address: string,
  signature: string,
  message: string
): Promise<AuthVerifyResponse> {
  return apiFetch<AuthVerifyResponse>('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address, signature, message }),
  });
}

export async function refreshToken(): Promise<AuthVerifyResponse> {
  return apiFetch<AuthVerifyResponse>('/auth/refresh', {
    method: 'POST',
  });
}

export async function logout(): Promise<{ success: boolean }> {
  try {
    const result = await apiFetch<{ success: boolean }>('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}), // Send empty object to avoid "Body cannot be empty" error
    });
    return result;
  } finally {
    setAuthToken(null);
  }
}

// ============================================
// SESSION KEY API (for one-click trading)
// ============================================

export interface CreateSessionParams {
  sessionPublicKey: string;
  walletAddress: string;
  expiresAt: number;
  signature: string;
  message: string;
}

export interface SessionStatus {
  active: boolean;
  sessionPublicKey?: string;
  expiresAt?: number;
}

export async function createSession(params: CreateSessionParams): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>('/auth/session', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function revokeSession(sessionPublicKey: string): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/auth/session/${sessionPublicKey}`, {
    method: 'DELETE',
  });
}

export async function getSessionStatus(): Promise<SessionStatus> {
  return apiFetch<SessionStatus>('/auth/session/status');
}

// ===================
// Market Data
// ===================

export interface GetMarketsParams {
  asset?: Asset;
  status?: MarketStatus;
  timeframe?: Timeframe;
}

export async function getMarkets(
  params?: GetMarketsParams
): Promise<MarketSummary[]> {
  const searchParams = new URLSearchParams();
  if (params?.asset) searchParams.set('asset', params.asset);
  if (params?.status) searchParams.set('status', params.status);
  if (params?.timeframe) searchParams.set('timeframe', params.timeframe);

  const query = searchParams.toString();
  return apiFetch<MarketSummary[]>(`/markets${query ? `?${query}` : ''}`);
}

export async function getMarket(address: string): Promise<Market> {
  return apiFetch<Market>(`/markets/${address}`);
}

export async function getOrderbook(address: string): Promise<OrderbookSnapshot> {
  return apiFetch<OrderbookSnapshot>(`/markets/${address}/orderbook`);
}

export interface GetTradesParams {
  limit?: number;
  before?: string;
}

export async function getMarketTrades(
  address: string,
  params?: GetTradesParams
): Promise<{ trades: Trade[]; nextCursor: string | null }> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.before) searchParams.set('before', params.before);

  const query = searchParams.toString();
  return apiFetch<{ trades: Trade[]; nextCursor: string | null }>(
    `/markets/${address}/trades${query ? `?${query}` : ''}`
  );
}

export async function getPrices(): Promise<PriceFeed> {
  return apiFetch<PriceFeed>('/markets/prices');
}

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export async function getCandles(params: {
  asset: Asset;
  intervalSec?: number;
  lookbackSec?: number;
}): Promise<{ asset: Asset; intervalSec: number; candles: Candle[] }> {
  const searchParams = new URLSearchParams();
  searchParams.set('asset', params.asset);
  if (params.intervalSec != null) searchParams.set('intervalSec', String(params.intervalSec));
  if (params.lookbackSec != null) searchParams.set('lookbackSec', String(params.lookbackSec));
  return apiFetch<{ asset: Asset; intervalSec: number; candles: Candle[] }>(`/markets/candles?${searchParams.toString()}`);
}

export async function getStats(): Promise<PlatformStats> {
  return apiFetch<PlatformStats>('/markets/stats');
}

export async function getFees(): Promise<FeeSchedule> {
  return apiFetch<FeeSchedule>('/fees');
}

// ===================
// Global Trades
// ===================

export interface GlobalTrade {
  id: string;
  market: string;
  marketAddress: string;
  asset: string;
  timeframe: string;
  side: 'buy' | 'sell';
  outcome: 'yes' | 'no';
  price: number;
  size: number;
  notional: number;
  txSignature: string | null;
  txStatus: string;
  solscanUrl: string | null;
  solanaExplorerUrl: string | null;
  timestamp: number;
  marketExpiry: number;
}

export interface GetGlobalTradesParams {
  limit?: number;
  before?: string;
  asset?: Asset;
}

export async function getGlobalTrades(
  params?: GetGlobalTradesParams
): Promise<{ trades: GlobalTrade[]; nextCursor: string | null }> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.before) searchParams.set('before', params.before);
  if (params?.asset) searchParams.set('asset', params.asset);

  const query = searchParams.toString();
  return apiFetch<{ trades: GlobalTrade[]; nextCursor: string | null }>(
    `/trades/global${query ? `?${query}` : ''}`
  );
}

// ===================
// Trading (Authenticated)
// ===================

export interface PlaceOrderParams {
  marketAddress: string;
  side: 'bid' | 'ask';
  outcome: 'yes' | 'no';
  type: 'limit' | 'market';
  price: number; // Dollar amount (e.g., 0.40 for $0.40)
  size: number; // Number of contracts
  expiry: number; // Unix timestamp
  signature: string;
  encodedInstruction: string;
  binaryMessage: string;  // Base64 encoded binary message for on-chain verification
  clientOrderId: number;
}

export async function placeOrder(
  params: PlaceOrderParams
): Promise<OrderResponse> {
  return apiFetch<OrderResponse>('/orders', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

/**
 * Notify backend about an on-chain order that was placed
 * This is for proactive notification - backend also listens to chain events
 */
export interface NotifyOrderPlacedParams {
  orderPda?: string;          // The Order PDA address (optional for MARKET orders with dollarAmount)
  txSignature?: string;       // Transaction signature (optional for MARKET orders with dollarAmount)
  marketAddress: string;
  side: 'bid' | 'ask';
  outcome: 'yes' | 'no';
  type: 'limit' | 'market';
  price: number;
  size: number;
  expiry: number;
  clientOrderId: number;
  // MARKET order specific (walk-the-book)
  dollarAmount?: number;      // Total USD to spend
  maxPrice?: number;          // Price protection limit
  signature?: string;         // User's signature for authorization
  binaryMessage?: string;     // Binary message that was signed
  sessionPublicKey?: string;  // Session key public key (for session-signed orders)
  // Leverage (optional)
  leverage?: number;          // 1-10, default 1 (no leverage)
  marginAmount?: number;      // User's margin (required if leverage > 1)
}

export async function notifyOrderPlaced(
  params: NotifyOrderPlacedParams
): Promise<OrderResponse> {
  return apiFetch<OrderResponse>('/orders/notify', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function cancelOrder(
  orderId: string,
  signature: string
): Promise<{ orderId: string; status: 'cancelled' }> {
  return apiFetch<{ orderId: string; status: 'cancelled' }>(
    `/orders/${orderId}`,
    {
      method: 'DELETE',
      body: JSON.stringify({ signature }),
    }
  );
}

export async function cancelAllOrders(
  signature: string,
  marketAddress?: string
): Promise<{ cancelledCount: number; orderIds: string[] }> {
  const searchParams = new URLSearchParams();
  if (marketAddress) searchParams.set('marketAddress', marketAddress);

  const query = searchParams.toString();
  return apiFetch<{ cancelledCount: number; orderIds: string[] }>(
    `/orders${query ? `?${query}` : ''}`,
    {
      method: 'DELETE',
      body: JSON.stringify({ signature }),
    }
  );
}

export async function getOrder(orderId: string): Promise<Order> {
  return apiFetch<Order>(`/orders/${orderId}`);
}

// ===================
// User Data (Authenticated)
// ===================

export async function getUserBalance(): Promise<UserBalance> {
  return apiFetch<UserBalance>('/user/balance');
}

export interface GetPositionsParams {
  status?: 'open' | 'settled' | 'all';
}

export async function getUserPositions(
  params?: GetPositionsParams
): Promise<Position[]> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);

  const query = searchParams.toString();
  return apiFetch<Position[]>(`/user/positions${query ? `?${query}` : ''}`);
}

export async function getUserPositionForMarket(
  marketAddress: string
): Promise<MarketPosition> {
  return apiFetch<MarketPosition>(`/user/positions/${marketAddress}`);
}

export interface GetOrdersParams {
  status?: 'open' | 'filled' | 'cancelled' | 'all';
  limit?: number;
  offset?: number;
}

export async function getUserOrders(
  params?: GetOrdersParams
): Promise<{ orders: Order[]; total: number; limit: number; offset: number }> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.offset) searchParams.set('offset', params.offset.toString());

  const query = searchParams.toString();
  return apiFetch<{
    orders: Order[];
    total: number;
    limit: number;
    offset: number;
  }>(`/user/orders${query ? `?${query}` : ''}`);
}

export interface GetUserTradesParams {
  limit?: number;
  offset?: number;
  from?: number;
  to?: number;
}

export async function getUserTransactions(
  params?: GetUserTradesParams
): Promise<{ transactions: UserTransaction[]; total: number; limit: number; offset: number; hasMore: boolean }> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.offset) searchParams.set('offset', params.offset.toString());
  if (params?.from) searchParams.set('from', params.from.toString());
  if (params?.to) searchParams.set('to', params.to.toString());

  const query = searchParams.toString();
  return apiFetch<{
    transactions: UserTransaction[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }>(`/user/trades${query ? `?${query}` : ''}`);
}

export interface GetSettlementsParams {
  limit?: number;
  offset?: number;
}

export async function getUserSettlements(
  params?: GetSettlementsParams
): Promise<{ settlements: Settlement[]; total: number }> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.offset) searchParams.set('offset', params.offset.toString());

  const query = searchParams.toString();
  return apiFetch<{ settlements: Settlement[]; total: number }>(
    `/user/settlements${query ? `?${query}` : ''}`
  );
}

// ===================
// Export API object for convenience
// ===================

// Get public config (relayer address, etc.)
export interface PublicConfig {
  relayerAddress: string | null;
  usdcMint: string;
  programId: string;
  delegationEnabled: boolean;
}

export async function getConfig(): Promise<PublicConfig> {
  return apiFetch<PublicConfig>('/config');
}

// ===================
// Margin / Leverage
// ===================

export interface AddMarginParams {
  marginAccountId: string;
  amount: number;
}

export interface AddMarginResponse {
  success: boolean;
  marginAccountId: string;
  amountAdded: number;
  newLoanAmount: number;
  newLiquidationPrice: number;
  error?: string;
}

export async function addMargin(params: AddMarginParams): Promise<AddMarginResponse> {
  return apiFetch<AddMarginResponse>('/margin/add', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export interface MarginConfig {
  enabled: boolean;
  maxLeverage: number;
  minLeverage: number;
  maintenanceMarginPct: number;
  liquidationPenaltyPct: number;
  minMarginUsd: number;
}

export async function getMarginConfig(): Promise<MarginConfig> {
  return apiFetch<MarginConfig>('/margin/config');
}

export interface MarginAccount {
  id: string;
  positionId: string;
  marketId: string;
  market?: {
    pubkey: string;
    asset: string;
    timeframe: string;
  };
  side: 'YES' | 'NO';
  shares: number;
  entryPrice: number;
  marginDeposited: number;
  loanAmount: number;
  leverage: number;
  liquidationPrice: number;
  currentPrice: number;
  status: string;
  health: {
    equity: number;
    marginRatio: number;
    distanceToLiq: number;
    distanceToLiqPct: number;
    isAtRisk: boolean;
  };
  createdAt: number;
}

export async function getMarginAccounts(): Promise<{ accounts: MarginAccount[]; total: number }> {
  return apiFetch<{ accounts: MarginAccount[]; total: number }>('/margin/accounts');
}

export const api = {
  // System
  getHealth,
  getServerTime,
  getConfig,
  // Auth
  getNonce,
  verifySignature,
  refreshToken,
  logout,
  setAuthToken,
  getAuthToken,
  // Session Keys (one-click trading)
  createSession,
  revokeSession,
  getSessionStatus,
  // Markets
  getMarkets,
  getMarket,
  getOrderbook,
  getMarketTrades,
  getPrices,
  getCandles,
  getStats,
  getFees,
  // Trading
  placeOrder,
  notifyOrderPlaced,
  cancelOrder,
  cancelAllOrders,
  getOrder,
  // User
  getUserBalance,
  getUserPositions,
  getUserPositionForMarket,
  getUserOrders,
  getUserTransactions,
  getUserSettlements,
  // Global
  getGlobalTrades,
  // Margin / Leverage
  addMargin,
  getMarginConfig,
  getMarginAccounts,
};

export default api;

