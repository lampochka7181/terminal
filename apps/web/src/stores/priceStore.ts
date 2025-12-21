/**
 * Price Store
 * Manages real-time asset prices
 */

import { create } from 'zustand';
import type { Asset } from '@degen/types';

interface Prices {
  BTC?: number;
  ETH?: number;
  SOL?: number;
}

interface PriceStore {
  prices: Prices;
  lastUpdate: number;
  isLoading: boolean;
  error: string | null;
  
  // Actions
  setPrice: (asset: Asset, price: number) => void;
  setPrices: (prices: Prices) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const usePriceStore = create<PriceStore>((set) => ({
  prices: {},
  lastUpdate: 0,
  isLoading: false,
  error: null,
  
  setPrice: (asset, price) =>
    set((state) => ({
      prices: { ...state.prices, [asset]: price },
      lastUpdate: Date.now(),
    })),
    
  setPrices: (prices) =>
    set((state) => ({
      prices: { ...state.prices, ...prices },
      lastUpdate: Date.now(),
      isLoading: false,
      error: null,
    })),
    
  setLoading: (isLoading) => set({ isLoading }),
  
  setError: (error) => set({ error, isLoading: false }),
}));

// Selectors
export function useAssetPrice(asset: Asset) {
  return usePriceStore(state => state.prices[asset]);
}

export function useAllPrices() {
  return usePriceStore(state => state.prices);
}

export function usePriceLastUpdate() {
  return usePriceStore(state => state.lastUpdate);
}

// Utility to format price
export function formatPrice(price: number | undefined, decimals = 2): string {
  if (price === undefined) return '--';
  return price.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Utility to format large numbers
export function formatLargeNumber(num: number): string {
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(2) + 'M';
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(2) + 'K';
  }
  return num.toFixed(2);
}
