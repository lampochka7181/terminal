/**
 * useMarkets Hook
 * Fetches and manages market data
 * 
 * Backend PRE-CREATES markets, so the next market is always ready
 * before the current one expires. No aggressive polling needed!
 * 
 * Now also listens for market_activated WebSocket events for instant
 * strike price updates without polling delay.
 */

import { useEffect, useCallback, useRef, useMemo } from 'react';
import { useMarketStore } from '@/stores/marketStore';
import { api, type GetMarketsParams, ApiError } from '@/lib/api';
import { getWebSocket } from '@/lib/websocket';
import type { MarketSummary, Asset, Timeframe } from '@degen/types';

// Polling interval to keep data fresh (10 seconds)
const POLLING_INTERVAL = 10000;

export function useMarkets(params?: GetMarketsParams) {
  const { 
    markets, 
    marketsLoading, 
    marketsError,
    setMarkets,
    setMarketsLoading,
    setMarketsError 
  } = useMarketStore();
  
  // Track if we're currently fetching to avoid duplicate requests
  const isFetchingRef = useRef(false);

  const fetchMarkets = useCallback(async (showLoading = true): Promise<MarketSummary[]> => {
    // Prevent duplicate requests
    if (isFetchingRef.current) {
      return [];
    }
    
    isFetchingRef.current = true;
    if (showLoading) {
      setMarketsLoading(true);
    }
    setMarketsError(null);
    
    try {
      const data = await api.getMarkets(params);
      setMarkets(data);
      return data;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to fetch markets';
      setMarketsError(message);
      console.error('[useMarkets] Error:', error);
      return [];
    } finally {
      setMarketsLoading(false);
      isFetchingRef.current = false;
    }
  }, [params?.asset, params?.status, params?.timeframe, setMarkets, setMarketsLoading, setMarketsError]);

  // Initial fetch
  useEffect(() => {
    fetchMarkets();
  }, [fetchMarkets]);
  
  // Auto-refresh polling
  useEffect(() => {
    const interval = setInterval(() => {
      fetchMarkets(false);
    }, POLLING_INTERVAL);
    
    return () => clearInterval(interval);
  }, [fetchMarkets]);
  
  // Listen for market_activated WebSocket events for instant strike price updates
  useEffect(() => {
    const ws = getWebSocket();
    ws.connect().catch(() => {});
    
    const unsubscribe = ws.onMessage((message: any) => {
      if (message.type !== 'market_activated') return;
      
      const data = message.data;
      if (!data) return;
      
      console.log('[useMarkets] Market activated:', data.asset, data.timeframe, 'strike:', data.strikePrice);
      
      // Update the markets list with the new strike price
      const { markets, setMarkets } = useMarketStore.getState();
      const address = data.address || message.market;
      
      const updatedMarkets = markets.map((m) => {
        if (m.address === address || m.id === data.marketId) {
          return {
            ...m,
            strike: data.strikePrice,
          };
        }
        return m;
      });
      
      // If we found and updated a market, apply it
      const wasUpdated = updatedMarkets.some((m, i) => m.strike !== markets[i]?.strike);
      if (wasUpdated) {
        setMarkets(updatedMarkets);
        console.log('[useMarkets] Updated market with strike price:', data.strikePrice);
      } else {
        // Market not in list yet, do a fresh fetch to get it
        console.log('[useMarkets] Market not found in list, fetching fresh data...');
        fetchMarkets(false);
      }
    });
    
    return () => {
      unsubscribe();
    };
  }, [fetchMarkets]);
  
  // Refetch when a market expires (instant refresh to get the pre-created next market)
  const onMarketExpired = useCallback((timeframe: Timeframe, count: number) => {
    console.log(`[useMarkets] Market expired (${timeframe}), fetching pre-created replacement...`);
    fetchMarkets(false);
  }, [fetchMarkets]);

  // Filter to show only the current (soonest expiring) market per timeframe
  // Since backend pre-creates markets, we may have multiple per timeframe
  const currentMarkets = useMemo(() => {
    const now = Date.now();
    const marketsByTimeframe = new Map<string, typeof markets[0]>();
    
    // Sort by expiry ascending
    const sortedMarkets = [...markets].sort((a, b) => (a.expiry || 0) - (b.expiry || 0));
    
    for (const market of sortedMarkets) {
      const key = market.timeframe;
      // Only consider markets that haven't expired yet
      if (market.expiry && market.expiry > now) {
        // Take the first (soonest expiring) market for each timeframe
        if (!marketsByTimeframe.has(key)) {
          marketsByTimeframe.set(key, market);
        }
      }
    }
    
    return Array.from(marketsByTimeframe.values());
  }, [markets]);

  return {
    markets: currentMarkets,
    allMarkets: markets, // Expose all markets if needed
    loading: marketsLoading,
    error: marketsError,
    refetch: fetchMarkets,
    onMarketExpired,
  };
}

export function useMarket(address: string | null) {
  const { selectedMarket, setMarket } = useMarketStore();

  const fetchMarket = useCallback(async () => {
    if (!address) {
      setMarket(null);
      return;
    }

    try {
      const data = await api.getMarket(address);
      // Convert Market to the store's format
      setMarket({
        id: data.id,
        address: data.address,
        asset: data.asset,
        timeframe: data.timeframe,
        strike: data.strikePrice,
        expiry: data.expiryAt,
        status: data.status,
        yesPrice: data.yesPrice || 0.5,
        noPrice: data.noPrice || 0.5,
      });
    } catch (error) {
      console.error('[useMarket] Error:', error);
      setMarket(null);
    }
  }, [address, setMarket]);

  useEffect(() => {
    fetchMarket();
  }, [fetchMarket]);

  return {
    market: selectedMarket,
    refetch: fetchMarket,
  };
}

export function useMarketsByAsset(asset: Asset) {
  return useMarkets({ asset, status: 'OPEN' });
}

export function useActiveMarket() {
  const { selectedAsset, selectedTimeframe, markets } = useMarketStore();

  // Find the market matching current selection
  const activeMarket = markets.find(
    (m) => m.asset === selectedAsset && m.timeframe === selectedTimeframe
  );

  return activeMarket || null;
}

export function useFilteredMarkets(asset?: Asset, timeframe?: Timeframe) {
  const { markets } = useMarketStore();

  return markets.filter((market) => {
    if (asset && market.asset !== asset) return false;
    if (timeframe && market.timeframe !== timeframe) return false;
    return true;
  });
}

