export type Asset = 'BTC' | 'ETH' | 'SOL';
export type Timeframe = '5m' | '15m' | '1h' | '4h';
export type MarketStatus = 'OPEN' | 'CLOSED' | 'RESOLVED' | 'SETTLED';
export type Outcome = 'YES' | 'NO';

export interface Market {
  id: string;
  address: string;          // On-chain PDA address
  asset: Asset;
  timeframe: Timeframe;
  strikePrice: number;
  finalPrice?: number;
  createdAt: number;
  expiryAt: number;
  resolvedAt?: number;
  settledAt?: number;
  status: MarketStatus;
  outcome?: Outcome;
  totalVolume: number;
  totalTrades: number;
  openInterest: number;
  yesPrice?: number;
  noPrice?: number;
}

export interface MarketSummary {
  id: string;
  address: string;
  asset: Asset;
  timeframe: Timeframe;
  strike: number;
  expiry: number;
  status: MarketStatus;
  volume24h: number;
  yesPrice: number;
  noPrice: number;
}

export interface PriceData {
  price: number;
  confidence: number;
  timestamp: number;
  source: 'pyth' | 'switchboard';
}

export type PriceFeed = Record<Asset, PriceData>;



