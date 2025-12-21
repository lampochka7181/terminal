/**
 * useTrades Hook
 * Fetches recent trades and subscribes to real-time updates
 */

import { useEffect, useCallback, useRef } from 'react';
import { useOrderbookStore, type Trade } from '@/stores/orderbookStore';
import { api, ApiError } from '@/lib/api';
import { getWebSocket, type TradeUpdate } from '@/lib/websocket';

export function useTrades(marketAddress: string | null, limit = 50) {
  const { trades, addTrade, clearTrades, setTradesLoading, setTradesError, tradesLoading, tradesError } = useOrderbookStore();
  const subscribed = useRef(false);

  // Fetch initial trades
  const fetchTrades = useCallback(async () => {
    if (!marketAddress) {
      clearTrades();
      return;
    }

    setTradesLoading(true);
    setTradesError(null);

    try {
      const data = await api.getMarketTrades(marketAddress, { limit });
      
      // Clear and add fetched trades
      clearTrades();
      data.trades.forEach((trade) => {
        addTrade({
          id: trade.id,
          price: trade.price,
          size: trade.size,
          side: trade.side,
          timestamp: trade.executedAt,
        });
      });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to fetch trades';
      setTradesError(message);
      console.error('[useTrades] Error:', error);
    } finally {
      setTradesLoading(false);
    }
  }, [marketAddress, limit, addTrade, clearTrades, setTradesLoading, setTradesError]);

  // Subscribe to WebSocket updates
  useEffect(() => {
    if (!marketAddress) return;

    const ws = getWebSocket();
    
    // Handle trade updates
    const unsubscribe = ws.onMessage((message) => {
      if (message.channel !== 'trades') return;
      
      // Handle both message formats
      const data = message.data as any;
      const messageMarket = (message as any).market || data?.marketId;
      
      if (messageMarket !== marketAddress) return;

      addTrade({
        id: data?.id || `trade-${Date.now()}`,
        price: data?.price || 0,
        size: data?.size || 0,
        side: data?.side || 'buy',
        timestamp: data?.timestamp || Date.now(),
      });
    });

    // Subscribe when connected
    const handleConnect = () => {
      if (marketAddress && !subscribed.current) {
        ws.subscribeTrades(marketAddress);
        subscribed.current = true;
      }
    };

    const unsubscribeConnect = ws.onConnect(handleConnect);
    
    // Subscribe if already connected
    if (ws.isConnected && !subscribed.current) {
      ws.subscribeTrades(marketAddress);
      subscribed.current = true;
    }

    // Fetch initial data
    fetchTrades();

    return () => {
      unsubscribe();
      unsubscribeConnect();
      if (subscribed.current && marketAddress) {
        ws.unsubscribeTrades(marketAddress);
        subscribed.current = false;
      }
    };
  }, [marketAddress, fetchTrades, addTrade]);

  return {
    trades,
    loading: tradesLoading,
    error: tradesError,
    refetch: fetchTrades,
  };
}

export function useRecentTrades(marketAddress: string | null, count = 10) {
  const { trades } = useTrades(marketAddress);
  return trades.slice(0, count);
}



