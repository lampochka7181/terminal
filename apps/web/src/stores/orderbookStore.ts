/**
 * Orderbook Store (v2)
 * Manages dual-outcome orderbook data (YES/NO) with tick-by-tick updates
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export interface OrderLevel {
  price: number;
  size: number;
  total?: number;     // Cumulative size
  flash?: 'up' | 'down' | null;  // For animation
  prevSize?: number;  // Previous size for comparison
}

export interface OutcomeOrderbook {
  bids: OrderLevel[];
  asks: OrderLevel[];
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spread: number;
  spreadPercent: number;
}

export interface Trade {
  id: string;
  price: number;
  size: number;
  side: 'buy' | 'sell';
  outcome: 'YES' | 'NO';
  timestamp: number;
}

interface OrderbookState {
  // Dual orderbook data
  yes: OutcomeOrderbook;
  no: OutcomeOrderbook;
  
  // Combined metrics
  sequenceId: number;
  lastUpdate: number;
  
  // Recent trades
  trades: Trade[];
  
  // Loading states
  isLoading: boolean;
  error: string | null;
  
  // Actions
  setOrderbook: (outcome: 'YES' | 'NO', bids: [number, number][], asks: [number, number][], sequenceId?: number) => void;
  setBothOrderbooks: (
    yesBids: [number, number][], yesAsks: [number, number][],
    noBids: [number, number][], noAsks: [number, number][],
    sequenceId?: number
  ) => void;
  updateLevel: (outcome: 'YES' | 'NO', side: 'bid' | 'ask', price: number, size: number) => void;
  clearFlash: (outcome: 'YES' | 'NO', side: 'bid' | 'ask', price: number) => void;
  addTrade: (trade: Trade) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const emptyOrderbook: OutcomeOrderbook = {
  bids: [],
  asks: [],
  bestBid: 0,
  bestAsk: 1,
  midPrice: 0.5,
  spread: 1,
  spreadPercent: 200,
};

const initialState = {
  yes: { ...emptyOrderbook },
  no: { ...emptyOrderbook },
  sequenceId: 0,
  lastUpdate: 0,
  trades: [],
  isLoading: false,
  error: null,
};

/**
 * Process raw price/size tuples into OrderLevel array with cumulative totals
 */
function processLevels(
  data: [number, number][],
  side: 'bid' | 'ask',
  existingLevels: OrderLevel[]
): OrderLevel[] {
  // Create a map of existing levels for comparison
  const existingMap = new Map<number, OrderLevel>();
  existingLevels.forEach(level => existingMap.set(level.price, level));
  
  const levels: OrderLevel[] = data
    .filter(([price, size]) => price >= 0.01 && price <= 0.99 && size > 0)
    .map(([price, size]) => {
      const existing = existingMap.get(price);
      const prevSize = existing?.size ?? 0;
      
      // Determine flash direction
      let flash: 'up' | 'down' | null = null;
      if (existing && size !== prevSize) {
        flash = size > prevSize ? 'up' : 'down';
      } else if (!existing && size > 0) {
        flash = 'up'; // New level
      }
      
      return {
        price,
        size,
        prevSize,
        flash,
      };
    });
  
  // Sort: bids descending (highest first), asks ascending (lowest first)
  if (side === 'bid') {
    levels.sort((a, b) => b.price - a.price);
  } else {
    levels.sort((a, b) => a.price - b.price);
  }
  
  // Calculate cumulative totals
  let cumulative = 0;
  levels.forEach(level => {
    cumulative += level.size;
    level.total = cumulative;
  });
  
  return levels.slice(0, 15); // Keep top 15 levels
}

/**
 * Calculate orderbook metrics from levels
 */
function calculateMetrics(bids: OrderLevel[], asks: OrderLevel[]): Partial<OutcomeOrderbook> {
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 1;
  const spread = bestAsk > bestBid ? bestAsk - bestBid : 0;
  const midPrice = bestBid > 0 && bestAsk < 1 ? (bestBid + bestAsk) / 2 : 0.5;
  const spreadPercent = midPrice > 0 ? (spread / midPrice) * 100 : 0;
  
  return { bestBid, bestAsk, midPrice, spread, spreadPercent };
}

export const useOrderbookStore = create<OrderbookState>()(
  subscribeWithSelector((set, get) => ({
    ...initialState,
    
    setOrderbook: (outcome, bidsData, asksData, sequenceId) => {
      const state = get();
      const currentBook = outcome === 'YES' ? state.yes : state.no;
      
      const bids = processLevels(bidsData, 'bid', currentBook.bids);
      const asks = processLevels(asksData, 'ask', currentBook.asks);
      const metrics = calculateMetrics(bids, asks);
      
      const newBook: OutcomeOrderbook = {
        bids,
        asks,
        bestBid: metrics.bestBid!,
        bestAsk: metrics.bestAsk!,
        midPrice: metrics.midPrice!,
        spread: metrics.spread!,
        spreadPercent: metrics.spreadPercent!,
      };
      
      set({
        [outcome.toLowerCase()]: newBook,
        sequenceId: sequenceId ?? state.sequenceId + 1,
        lastUpdate: Date.now(),
        isLoading: false,
        error: null,
      });
    },
    
    setBothOrderbooks: (yesBids, yesAsks, noBids, noAsks, sequenceId) => {
      const state = get();
      
      const yesBidsProcessed = processLevels(yesBids, 'bid', state.yes.bids);
      const yesAsksProcessed = processLevels(yesAsks, 'ask', state.yes.asks);
      const yesMetrics = calculateMetrics(yesBidsProcessed, yesAsksProcessed);
      
      const noBidsProcessed = processLevels(noBids, 'bid', state.no.bids);
      const noAsksProcessed = processLevels(noAsks, 'ask', state.no.asks);
      const noMetrics = calculateMetrics(noBidsProcessed, noAsksProcessed);
      
      set({
        yes: {
          bids: yesBidsProcessed,
          asks: yesAsksProcessed,
          bestBid: yesMetrics.bestBid!,
          bestAsk: yesMetrics.bestAsk!,
          midPrice: yesMetrics.midPrice!,
          spread: yesMetrics.spread!,
          spreadPercent: yesMetrics.spreadPercent!,
        },
        no: {
          bids: noBidsProcessed,
          asks: noAsksProcessed,
          bestBid: noMetrics.bestBid!,
          bestAsk: noMetrics.bestAsk!,
          midPrice: noMetrics.midPrice!,
          spread: noMetrics.spread!,
          spreadPercent: noMetrics.spreadPercent!,
        },
        sequenceId: sequenceId ?? state.sequenceId + 1,
        lastUpdate: Date.now(),
        isLoading: false,
        error: null,
      });
    },
    
    updateLevel: (outcome, side, price, size) => {
      set((state) => {
        const book = outcome === 'YES' ? state.yes : state.no;
        const levels = side === 'bid' ? [...book.bids] : [...book.asks];
        
        const existingIndex = levels.findIndex(l => Math.abs(l.price - price) < 0.0001);
        
        if (size <= 0) {
          // Remove level
          if (existingIndex !== -1) {
            const removed = levels[existingIndex];
            levels.splice(existingIndex, 1);
            // Mark nearby levels as potentially changed for UI update
          }
        } else if (existingIndex !== -1) {
          // Update existing level with flash
          const existing = levels[existingIndex];
          const flash: 'up' | 'down' | null = size > existing.size ? 'up' : size < existing.size ? 'down' : null;
          levels[existingIndex] = { 
            ...existing, 
            prevSize: existing.size,
            size, 
            flash 
          };
        } else {
          // Add new level
          levels.push({ 
            price, 
            size, 
            prevSize: 0,
            flash: 'up' 
          });
        }
        
        // Re-sort
        if (side === 'bid') {
          levels.sort((a, b) => b.price - a.price);
        } else {
          levels.sort((a, b) => a.price - b.price);
        }
        
        // Recalculate totals
        let cumulative = 0;
        levels.forEach(level => {
          cumulative += level.size;
          level.total = cumulative;
        });
        
        const newLevels = levels.slice(0, 15);
        const bids = side === 'bid' ? newLevels : book.bids;
        const asks = side === 'ask' ? newLevels : book.asks;
        const metrics = calculateMetrics(bids, asks);
        
        const newBook: OutcomeOrderbook = {
          bids,
          asks,
          bestBid: metrics.bestBid!,
          bestAsk: metrics.bestAsk!,
          midPrice: metrics.midPrice!,
          spread: metrics.spread!,
          spreadPercent: metrics.spreadPercent!,
        };
        
        return {
          [outcome.toLowerCase()]: newBook,
          sequenceId: state.sequenceId + 1,
          lastUpdate: Date.now(),
        };
      });
    },
    
    clearFlash: (outcome, side, price) => {
      set((state) => {
        const book = outcome === 'YES' ? state.yes : state.no;
        const levels = side === 'bid' ? [...book.bids] : [...book.asks];
        
        const index = levels.findIndex(l => Math.abs(l.price - price) < 0.0001);
        if (index !== -1) {
          levels[index] = { ...levels[index], flash: null };
        }
        
        return {
          [outcome.toLowerCase()]: {
            ...book,
            [side === 'bid' ? 'bids' : 'asks']: levels,
          },
        };
      });
    },
    
    addTrade: (trade) => {
      set((state) => ({
        trades: [trade, ...state.trades].slice(0, 50),
      }));
    },
    
    setLoading: (isLoading) => set({ isLoading }),
    
    setError: (error) => set({ error, isLoading: false }),
    
    reset: () => set(initialState),
  }))
);

// Selectors
export function useYesOrderbook() {
  return useOrderbookStore(state => state.yes);
}

export function useNoOrderbook() {
  return useOrderbookStore(state => state.no);
}

export function useBestPrices(outcome: 'YES' | 'NO') {
  return useOrderbookStore(state => {
    const book = outcome === 'YES' ? state.yes : state.no;
    return {
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      midPrice: book.midPrice,
      spread: book.spread,
    };
  });
}

export function useOrderbookSequence() {
  return useOrderbookStore(state => state.sequenceId);
}

// Legacy exports for compatibility
export function useBestBid() {
  return useOrderbookStore(state => state.yes.bids[0]);
}

export function useBestAsk() {
  return useOrderbookStore(state => state.yes.asks[0]);
}

export function useSpread() {
  return useOrderbookStore(state => ({
    spread: state.yes.spread,
    spreadPercent: state.yes.spreadPercent,
  }));
}

export function useMidPrice() {
  return useOrderbookStore(state => state.yes.midPrice);
}
