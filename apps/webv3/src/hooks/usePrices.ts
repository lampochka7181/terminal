/**
 * usePrices Hook
 * Fetches prices and subscribes to real-time updates
 */

import { useEffect, useCallback, useRef } from 'react';
import { usePriceStore } from '@/stores/priceStore';
import { api, ApiError } from '@/lib/api';
import { getWebSocket, type PriceUpdate } from '@/lib/websocket';
import type { Asset } from '@degen/types';

export function usePrices() {
  const { 
    prices, 
    lastUpdate, 
    setPrice, 
    setPrices,
    setLoading,
    setError,
    isLoading,
    error 
  } = usePriceStore();
  
  const subscribed = useRef(false);

  // Fetch initial prices
  const fetchPrices = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await api.getPrices();
      setPrices({
        BTC: data.BTC?.price,
        ETH: data.ETH?.price,
        SOL: data.SOL?.price,
      });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to fetch prices';
      setError(message);
      console.error('[usePrices] Error:', error);
    } finally {
      setLoading(false);
    }
  }, [setPrices, setLoading, setError]);

  // Subscribe to WebSocket updates
  useEffect(() => {
    const ws = getWebSocket();
    
    // Handle price updates
    const unsubscribe = ws.onMessage((message) => {
      if (message.channel !== 'prices') return;
      
      const data = message.data as any;
      
      // Handle snapshot format: { BTC: { price, ... }, ETH: { price, ... }, ... }
      if (data && !data.asset) {
        // This is a snapshot with all prices
        for (const asset of ['BTC', 'ETH', 'SOL'] as const) {
          if (data[asset]?.price !== undefined) {
            setPrice(asset, data[asset].price);
          }
        }
        return;
      }
      
      // Handle individual update format: { asset, price, timestamp }
      if (data?.asset && data?.price !== undefined) {
        setPrice(data.asset as 'BTC' | 'ETH' | 'SOL', data.price);
      }
    });

    // Subscribe when connected
    const handleConnect = () => {
      // Always resubscribe on connect
      ws.subscribePrices(['BTC', 'ETH', 'SOL']);
      subscribed.current = true;
    };

    const unsubscribeConnect = ws.onConnect(handleConnect);
    
    // Subscribe if already connected
    if (ws.isConnected) {
      ws.subscribePrices(['BTC', 'ETH', 'SOL']);
      subscribed.current = true;
    }

    // Fetch initial data
    fetchPrices();

    return () => {
      unsubscribe();
      unsubscribeConnect();
      if (subscribed.current) {
        ws.unsubscribePrices();
        subscribed.current = false;
      }
    };
  }, [fetchPrices, setPrice]);

  return {
    prices,
    lastUpdate,
    loading: isLoading,
    error,
    refetch: fetchPrices,
  };
}

export function usePrice(asset: Asset) {
  const { prices } = usePriceStore();
  return prices[asset];
}

export function useFormattedPrice(asset: Asset) {
  const price = usePrice(asset);
  
  if (!price) return '--';
  
  // Format with commas
  return price.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

