/**
 * Market Store
 * Manages market selection and market list data
 */

import { create } from 'zustand';
import type { MarketSummary, Asset, Timeframe, MarketStatus } from '@degen/types';

interface Market {
  id: string;
  address: string;
  asset: Asset;
  timeframe: Timeframe;
  strike: number;
  expiry: number;
  status: MarketStatus;
  yesPrice: number;
  noPrice: number;
}

interface MarketStore {
  // Selection
  selectedAsset: Asset;
  selectedTimeframe: Timeframe;
  selectedMarket: Market | null;
  
  // Market list
  markets: MarketSummary[];
  marketsLoading: boolean;
  marketsError: string | null;
  
  // Actions
  setAsset: (asset: Asset) => void;
  setTimeframe: (timeframe: Timeframe) => void;
  setMarket: (market: Market | null) => void;
  setMarkets: (markets: MarketSummary[]) => void;
  setMarketsLoading: (loading: boolean) => void;
  setMarketsError: (error: string | null) => void;
  
  // Selectors
  getMarketsByAsset: (asset: Asset) => MarketSummary[];
  getMarketByAssetAndTimeframe: (asset: Asset, timeframe: Timeframe) => MarketSummary | undefined;
}

export const useMarketStore = create<MarketStore>((set, get) => ({
  // Initial state
  selectedAsset: 'BTC',
  selectedTimeframe: '5m',
  selectedMarket: null,
  markets: [],
  marketsLoading: false,
  marketsError: null,
  
  // Actions
  setAsset: (asset) => set({ selectedAsset: asset }),
  
  setTimeframe: (timeframe) => set({ selectedTimeframe: timeframe }),
  
  setMarket: (market) => set({ selectedMarket: market }),
  
  setMarkets: (markets) => set({ markets, marketsError: null }),
  
  setMarketsLoading: (marketsLoading) => set({ marketsLoading }),
  
  setMarketsError: (marketsError) => set({ marketsError }),
  
  // Selectors
  getMarketsByAsset: (asset) => {
    return get().markets.filter(m => m.asset === asset);
  },
  
  getMarketByAssetAndTimeframe: (asset, timeframe) => {
    return get().markets.find(m => m.asset === asset && m.timeframe === timeframe);
  },
}));

// Helper to get the best market for current selection
export function useSelectedMarket() {
  const { selectedAsset, selectedTimeframe, markets, selectedMarket } = useMarketStore();
  const now = Date.now();
  
  const pickFromList = () => {
    // Prefer the soonest-expiring *active* market for this asset/timeframe
    const candidates = markets
      .filter((m) => m.asset === selectedAsset && m.timeframe === selectedTimeframe)
      .filter((m) => typeof m.expiry === 'number' && m.expiry > now)
      .sort((a, b) => (a.expiry || 0) - (b.expiry || 0));

    const market = candidates[0];
    if (!market) return null;

    return {
      id: market.id,
      address: market.address,
      asset: market.asset,
      timeframe: market.timeframe,
      strike: market.strike,
      expiry: market.expiry,
      status: market.status,
      yesPrice: market.yesPrice,
      noPrice: market.noPrice,
    };
  };

  // If we have a specifically selected market, only trust it if it matches the current selection
  // and hasn't expired. Otherwise prefer the up-to-date market list.
  if (selectedMarket) {
    const matchesSelection =
      selectedMarket.asset === selectedAsset && selectedMarket.timeframe === selectedTimeframe;
    const notExpired = typeof selectedMarket.expiry === 'number' && selectedMarket.expiry > now;

    if (matchesSelection && notExpired) {
      // If the market list has a replacement (common after refresh/expiry), prefer the list.
      const fromList = pickFromList();
      if (fromList && fromList.address !== selectedMarket.address) {
        return fromList;
      }
      return selectedMarket;
    }
  }
  
  return pickFromList();
}
