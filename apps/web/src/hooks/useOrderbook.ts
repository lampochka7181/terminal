/**
 * useOrderbook Hook (v2)
 * Fetches orderbook and subscribes to real-time updates for both YES and NO outcomes
 */

import { useEffect, useCallback, useRef } from 'react';
import { 
  useOrderbookStore, 
  useYesOrderbook, 
  useNoOrderbook,
  type OrderLevel 
} from '@/stores/orderbookStore';
import { api, ApiError } from '@/lib/api';
import { getWebSocket } from '@/lib/websocket';

export function useOrderbook(marketAddress: string | null) {
  const { 
    yes,
    no,
    sequenceId,
    setBothOrderbooks,
    setOrderbook,
    updateLevel,
    setLoading,
    setError,
    isLoading,
    error 
  } = useOrderbookStore();
  
  const subscribed = useRef(false);

  // Fetch initial snapshot for both outcomes
  const fetchOrderbook = useCallback(async () => {
    if (!marketAddress) return;

    setLoading(true);
    setError(null);

    try {
      const data = await api.getOrderbook(marketAddress) as any;
      
      // Parse both YES and NO orderbooks
      const yesBids = (data.yes?.bids || data.bids || []) as [number, number][];
      const yesAsks = (data.yes?.asks || data.asks || []) as [number, number][];
      const noBids = (data.no?.bids || []) as [number, number][];
      const noAsks = (data.no?.asks || []) as [number, number][];
      
      setBothOrderbooks(yesBids, yesAsks, noBids, noAsks, data.sequenceId);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to fetch orderbook';
      setError(message);
      console.error('[useOrderbook] Error:', error);
    } finally {
      setLoading(false);
    }
  }, [marketAddress, setBothOrderbooks, setLoading, setError]);

  // Subscribe to WebSocket updates
  useEffect(() => {
    if (!marketAddress) return;

    const ws = getWebSocket();
    
    // Handle orderbook updates
    const unsubscribe = ws.onMessage((message) => {
      if (message.channel !== 'orderbook') return;
      
      // Handle both message formats
      const data = message.data as any;
      const messageMarket = (message as any).market || data?.marketId;
      
      if (messageMarket !== marketAddress) return;

      // Get outcome from message (default to YES for backwards compatibility)
      const outcome = (data?.outcome as 'YES' | 'NO') || 'YES';
      const bids = (data?.bids || []) as [number, number][];
      const asks = (data?.asks || []) as [number, number][];
      const newSequenceId = data?.sequenceId;
      
      // For full snapshot, replace entire orderbook for that outcome
      if ((message as any).snapshot || bids.length > 5 || asks.length > 5) {
        setOrderbook(outcome, bids, asks, newSequenceId);
        return;
      }
      
      // Apply tick-by-tick delta updates
      bids.forEach(([price, size]) => {
        updateLevel(outcome, 'bid', price, size);
      });
      asks.forEach(([price, size]) => {
        updateLevel(outcome, 'ask', price, size);
      });
    });

    // Subscribe when connected
    const handleConnect = () => {
      if (marketAddress && !subscribed.current) {
        ws.subscribeOrderbook(marketAddress);
        subscribed.current = true;
      }
    };

    const unsubscribeConnect = ws.onConnect(handleConnect);
    
    // Subscribe if already connected
    if (ws.isConnected && !subscribed.current) {
      ws.subscribeOrderbook(marketAddress);
      subscribed.current = true;
    }

    // Fetch initial data
    fetchOrderbook();

    return () => {
      unsubscribe();
      unsubscribeConnect();
      if (subscribed.current && marketAddress) {
        ws.unsubscribeOrderbook(marketAddress);
        subscribed.current = false;
      }
    };
  }, [marketAddress, fetchOrderbook, setOrderbook, updateLevel]);

  return {
    // YES outcome
    yesBids: yes.bids,
    yesAsks: yes.asks,
    yesBestBid: yes.bestBid,
    yesBestAsk: yes.bestAsk,
    yesMidPrice: yes.midPrice,
    yesSpread: yes.spread,
    yesSpreadPercent: yes.spreadPercent,
    
    // NO outcome
    noBids: no.bids,
    noAsks: no.asks,
    noBestBid: no.bestBid,
    noBestAsk: no.bestAsk,
    noMidPrice: no.midPrice,
    noSpread: no.spread,
    noSpreadPercent: no.spreadPercent,
    
    // Legacy (YES only) - for backwards compatibility
    bids: yes.bids,
    asks: yes.asks,
    spread: yes.spread,
    spreadPercent: yes.spreadPercent,
    midPrice: yes.midPrice,
    
    // Meta
    sequenceId,
    loading: isLoading,
    error,
    refetch: fetchOrderbook,
  };
}

/**
 * Hook to get best prices for a specific outcome
 */
export function useBestPrices(outcome: 'YES' | 'NO' = 'YES') {
  const yes = useYesOrderbook();
  const no = useNoOrderbook();
  
  const book = outcome === 'YES' ? yes : no;
  
  return {
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    bestBidSize: book.bids[0]?.size || 0,
    bestAskSize: book.asks[0]?.size || 0,
    midPrice: book.midPrice,
    spread: book.spread,
  };
}

/**
 * Hook to get orderbook depth with percentage calculations
 */
export function useOrderbookDepth(outcome: 'YES' | 'NO' = 'YES', levels = 10) {
  const yes = useYesOrderbook();
  const no = useNoOrderbook();
  
  const book = outcome === 'YES' ? yes : no;
  
  const slicedBids = book.bids.slice(0, levels);
  const slicedAsks = book.asks.slice(0, levels);
  
  const maxBidSize = Math.max(...slicedBids.map(b => b.total || b.size), 1);
  const maxAskSize = Math.max(...slicedAsks.map(a => a.total || a.size), 1);
  const maxSize = Math.max(maxBidSize, maxAskSize);
  
  return {
    bids: slicedBids.map(b => ({
      ...b,
      depth: (b.total || b.size) / maxSize,
    })),
    asks: slicedAsks.map(a => ({
      ...a,
      depth: (a.total || a.size) / maxSize,
    })),
    maxSize,
  };
}

/**
 * Hook to get both orderbooks for dual display
 */
export function useDualOrderbook() {
  const yes = useYesOrderbook();
  const no = useNoOrderbook();
  const sequenceId = useOrderbookStore(state => state.sequenceId);
  const isLoading = useOrderbookStore(state => state.isLoading);
  
  return {
    yes,
    no,
    sequenceId,
    isLoading,
  };
}
