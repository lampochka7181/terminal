export type PositionStatus = 'OPEN' | 'SETTLED';

export interface Position {
  id: string;
  userId: string;
  marketId: string;
  marketAddress: string;
  pubkey?: string;         // On-chain position PDA
  yesShares: number;
  noShares: number;
  avgEntryYes?: number;
  avgEntryNo?: number;
  totalCost: number;
  realizedPnL: number;
  status: PositionStatus;
  payout?: number;
  createdAt: number;
  updatedAt: number;
  settledAt?: number;
}

export interface PositionWithMarket extends Position {
  market: string;          // Human readable: "BTC-5m-12:05"
  currentPrice: number;
  unrealizedPnL: number;
}

export interface Settlement {
  id: string;
  positionId: string;
  userId: string;
  marketId: string;
  marketAddress: string;
  market: string;
  outcome: 'YES' | 'NO';
  yourPosition: 'YES' | 'NO';
  winningShares: number;
  payoutAmount: number;
  profit: number;
  txSignature?: string;
  settledAt: number;
}



