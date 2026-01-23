'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useWallet } from '@solana/wallet-adapter-react';
import { Header } from '@/components/layout/Header';
import { usePrices } from '@/hooks/usePrices';
import { useMarkets } from '@/hooks/useMarkets';
import { useAuth } from '@/hooks/useAuth';
import { useQuickOrder, type SessionSigner } from '@/hooks/useOrder';
import { useDelegation } from '@/hooks/useDelegation';
import { useSessionKey } from '@/hooks/useSessionKey';
import { useSettingsStore } from '@/stores/settingsStore';
import { cn } from '@/lib/utils';
import { 
  ArrowLeft, 
  RefreshCw, 
  CheckCircle, 
  XCircle, 
  Loader2, 
  Settings, 
  AlertCircle, 
  Clock, 
  Smartphone,
  Zap
} from 'lucide-react';
import type { Asset, Timeframe } from '@degen/types';
import { ChartV2 } from '@/components/trading/ChartV2';
import { Positions } from '@/components/trading/Positions';
import { SingleOrderbook } from '@/components/trading/SingleOrderbook';
import { GlobalTradeBlotter } from '@/components/trading/GlobalTradeBlotter';
import { useMarketStore } from '@/stores/marketStore';
import { WalletButton } from '@/components/WalletButton';
import { useOrderbookStore } from '@/stores/orderbookStore';
import { useOrderbook } from '@/hooks/useOrderbook';

const TIMEFRAMES: Timeframe[] = ['5m', '1h', '24h'];

// Truncate to 6 decimal places to match on-chain precision (SHARE_MULTIPLIER = 10^6)
const truncate6 = (n: number) => Math.floor(n * 1_000_000) / 1_000_000;

interface DesktopViewProps {
  asset: Asset;
  onSwitchView: () => void;
}

export function DesktopView({ asset, onSwitchView }: DesktopViewProps) {
  const router = useRouter();
  const { connected } = useWallet();
  const { isAuthenticated, signIn, isAuthenticating } = useAuth();
  const { selectedTimeframe, setTimeframe, setAsset } = useMarketStore();
  const { isApproved: isDelegationApproved, isApproving, approve: approveDelegation, delegatedAmount } = useDelegation();
  const { oneClickEnabled, oneClickAmount, soundEnabled } = useSettingsStore();
  
  // Session key for instant trading (no wallet popups)
  const { isActive: isSessionActive, publicKey: sessionPublicKey, signOrder, createSession, revokeSession, isCreating: isCreatingSession, getTimeRemaining } = useSessionKey();
  
  // Create session signer if session is active
  const sessionSigner: SessionSigner | undefined = useMemo(() => {
    if (!isSessionActive || !sessionPublicKey) return undefined;
    return {
      publicKey: sessionPublicKey,
      sign: signOrder,
    };
  }, [isSessionActive, sessionPublicKey, signOrder]);

  // Ensure store matches URL asset
  useEffect(() => {
    setAsset(asset);
  }, [asset, setAsset]);
  
  // Use usePrices to set up WebSocket subscription for live updates
  const { prices, loading: pricesLoading } = usePrices();
  const currentPrice = prices[asset];
  
  // Fetch markets for this asset
  const { markets, loading: marketsLoading, refetch, onMarketExpired } = useMarkets({ 
    asset, 
    status: 'OPEN' 
  });

  // Find the market for the selected timeframe
  const activeMarket = useMemo(() => {
    return markets.find(m => m.timeframe === selectedTimeframe);
  }, [markets, selectedTimeframe]);
  
  // Subscribe to orderbook WebSocket updates - ensures store has live data
  useOrderbook(activeMarket?.address ?? null);
  
  // Get REAL-TIME orderbook prices directly from the store for maximum sync
  // SINGLE ORDERBOOK MODEL: Only YES orderbook exists, NO prices are derived
  // This ensures ABOVE + BELOW always = $1.00 (no arbitrage opportunity)
  const yesBestAsk = useOrderbookStore(state => state.yes.asks[0]?.price);
  const yesBestBid = useOrderbookStore(state => state.yes.bids[0]?.price);
  const lastUpdate = useOrderbookStore(state => state.lastUpdate);
  
  // Check if market is pending activation (strike = 0 means waiting for activation)
  const isActivating = activeMarket?.strike === 0;
  
  // Handle market expiry
  const handleMarketExpired = useCallback((marketId: string, timeframe: string) => {
    onMarketExpired(timeframe as any, markets.length);
  }, [onMarketExpired, markets.length]);

  // Trade state for quick trades
  const [selectedOutcome, setSelectedOutcome] = useState<'YES' | 'NO' | null>(null);
  const [dollarAmount, setDollarAmount] = useState('50');
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [limitPrice, setLimitPrice] = useState('');
  
  // Trade mode: 'buy' or 'sell'
  const [tradeMode, setTradeMode] = useState<'buy' | 'sell'>('buy');
  
  // Sell state
  const [sellData, setSellData] = useState<{
    marketAddress: string;
    shares: number;
    avgEntry: number;
    currentPrice: number;
  } | null>(null);
  const [sellSize, setSellSize] = useState('');

  // Use the order hook - pass session signer for instant trading
  const { placeOrder, isPlacing, error: orderError, clearError } = useQuickOrder(sessionSigner);

  // Calculate estimates using REAL-TIME orderbook prices directly from store
  // SINGLE ORDERBOOK MODEL: Prices reflect ACTUAL execution cost
  // - ABOVE (buy YES) = best YES ASK (matches YES ASK)
  // - BELOW (buy NO) = 1 - best YES BID (matches YES BID, complement price)
  // NOTE: ABOVE + BELOW > $1.00 when there's a spread (reflects MM spread)
  const yesPrice = (yesBestAsk && yesBestAsk > 0.01 && yesBestAsk < 0.99) 
    ? yesBestAsk 
    : (activeMarket?.yesPrice ?? 0.50);
  // NO price is derived from YES BID (not YES ASK) because:
  // Buy NO matches YES BID (MM buying YES = MM selling NO)
  const noPrice = (yesBestBid && yesBestBid > 0.01 && yesBestBid < 0.99)
    ? 1 - yesBestBid
    : (activeMarket?.noPrice ?? 0.50);
  const marketPrice = selectedOutcome === 'YES' ? yesPrice : noPrice;
  const limitPriceNum = parseFloat(limitPrice) || 0;
  const selectedPrice = orderType === 'limit' && limitPriceNum > 0 ? limitPriceNum : marketPrice;
  const dollarAmountNum = parseFloat(dollarAmount) || 0;
  const estimatedContracts = dollarAmountNum > 0 && selectedPrice > 0 ? Math.floor(dollarAmountNum / selectedPrice) : 0;
  const estimatedPayout = estimatedContracts * 1.0;
  const estimatedProfit = estimatedPayout - dollarAmountNum;
  
  // Sell calculations
  const sellSizeNum = parseFloat(sellSize) || 0;
  const maxSellSize = sellData?.shares || 0;
  const sellPrice = sellData?.currentPrice || marketPrice;
  const sellProceeds = sellSizeNum * sellPrice;
  const sellCostBasis = sellSizeNum * (sellData?.avgEntry || 0);
  const sellProfit = sellProceeds - sellCostBasis;

  // Update limit price when outcome changes to reflect market price
  useEffect(() => {
    if (selectedOutcome && orderType === 'limit' && !limitPrice) {
      setLimitPrice(marketPrice.toFixed(2));
    }
  }, [selectedOutcome, orderType, marketPrice, limitPrice]);

  // Order state
  const [orderStatus, setOrderStatus] = useState<'idle' | 'placing' | 'success' | 'error'>('idle');
  const [orderResult, setOrderResult] = useState<{ message?: string } | null>(null);
  
  // One-click trading state
  const [oneClickOutcome, setOneClickOutcome] = useState<'YES' | 'NO' | null>(null);

  // One-click trading handler - no confirmation needed since user explicitly enabled one-click mode
  const handleOneClickTrade = useCallback(async (outcome: 'YES' | 'NO', price: number) => {
    if (!connected || !activeMarket || !isDelegationApproved || !oneClickEnabled) return;

    setOneClickOutcome(outcome);
    clearError();
    setOrderStatus('placing');

    const now = Math.floor(Date.now() / 1000);
    const defaultExpiry = now + 3600;
    const expiryTimestamp = activeMarket.expiry 
      ? Math.min(Math.floor(activeMarket.expiry / 1000) - 60, defaultExpiry)
      : defaultExpiry;

    const estimatedContracts = Math.floor(oneClickAmount / price);
    // SLIPPAGE PROTECTION: maxPrice = displayed price + 5% tolerance, capped at 0.99
    // This ensures user gets filled close to the quoted price, not at any price
    const SLIPPAGE_TOLERANCE = 0.05; // 5%
    const maxPrice = Math.min(0.99, price * (1 + SLIPPAGE_TOLERANCE));

    const result = await placeOrder({
      marketAddress: activeMarket.address,
      side: 'bid',
      outcome: outcome.toLowerCase() as 'yes' | 'no',
      orderType: 'market',
      price: price,
      size: estimatedContracts,
      expiryTimestamp,
      dollarAmount: oneClickAmount,
      maxPrice,
    });

    if (result && result.status !== 'cancelled' && (result.filledSize > 0 || result.status === 'open')) {
      setOrderStatus('success');
      setOrderResult({ message: `Bought ${result.filledSize || estimatedContracts} contracts` });
      
      // Play success sound if enabled
      if (soundEnabled) {
        try {
          const audio = new Audio('/sounds/success.mp3');
          audio.volume = 0.3;
          audio.play().catch(() => {});
        } catch {}
      }
      
      setTimeout(() => {
        setOrderStatus('idle');
        setOrderResult(null);
        setOneClickOutcome(null);
      }, 2000);
    } else {
      setOrderStatus('error');
      setOrderResult({ message: 'Order failed - try manual trade' });
      setTimeout(() => {
        setOrderStatus('idle');
        setOrderResult(null);
        setOneClickOutcome(null);
      }, 3000);
    }
  }, [connected, activeMarket, isDelegationApproved, oneClickEnabled, oneClickAmount, soundEnabled, placeOrder, clearError]);

  const handleQuickTrade = async () => {
    // Sell mode
    if (tradeMode === 'sell') {
      if (!connected || !selectedOutcome || !sellData || sellSizeNum <= 0) return;
      
      clearError();
      setOrderStatus('placing');

      const now = Math.floor(Date.now() / 1000);
      const expiryTimestamp = now + 3600;

      const result = await placeOrder({
        marketAddress: sellData.marketAddress,
        side: 'ask',
        outcome: selectedOutcome.toLowerCase() as 'yes' | 'no',
        orderType: 'market',
        // For MARKET sells, use a low minPrice to guarantee fill (matches against bids)
        // Similar to how market buys use maxPrice: 0.99 to guarantee fill
        price: 0.01,
        size: sellSizeNum,
        expiryTimestamp,
      });

      // Check if order was actually successful (not cancelled or failed)
      if (result && result.status !== 'cancelled' && result.filledSize > 0) {
        setOrderStatus('success');
        setOrderResult({ message: `Sold ${result.filledSize} contracts` });
        setTimeout(() => {
          setOrderStatus('idle');
          setOrderResult(null);
          setTradeMode('buy');
          setSellData(null);
          setSellSize('');
          setSelectedOutcome(null);
        }, 3000);
      } else if (result && result.status === 'cancelled') {
        setOrderStatus('error');
        setOrderResult({ message: 'Order cancelled - no buyers at this price' });
      } else if (result && result.filledSize === 0) {
        setOrderStatus('error');
        setOrderResult({ message: 'No fills - try adjusting price or wait for buyers' });
      } else if (result && result.error) {
        // Handle error returned directly in result (e.g., liquidation errors)
        setOrderStatus('error');
        setOrderResult({ message: result.error });
      } else {
        setOrderStatus('error');
        setOrderResult({ message: orderError || 'Order failed' });
      }
      return;
    }

    // Buy mode
    if (!connected || !activeMarket || !selectedOutcome || dollarAmountNum <= 0) return;
    if (orderType === 'limit' && (limitPriceNum <= 0 || limitPriceNum >= 1)) return;

    clearError();
    setOrderStatus('placing');

    const now = Math.floor(Date.now() / 1000);
    const defaultExpiry = now + 3600;
    const expiryTimestamp = activeMarket.expiry 
      ? Math.min(Math.floor(activeMarket.expiry / 1000) - 60, defaultExpiry)
      : defaultExpiry;

    // SLIPPAGE PROTECTION: Market orders use displayed price + 5% tolerance
    // Limit orders use the user's specified price
    const SLIPPAGE_TOLERANCE = 0.05; // 5%
    const maxPrice = orderType === 'market' 
      ? Math.min(0.99, marketPrice * (1 + SLIPPAGE_TOLERANCE))
      : limitPriceNum;

    const result = await placeOrder({
      marketAddress: activeMarket.address,
      side: 'bid',
      outcome: selectedOutcome.toLowerCase() as 'yes' | 'no',
      orderType: orderType,
      price: orderType === 'limit' ? limitPriceNum : marketPrice,
      size: estimatedContracts,
      expiryTimestamp,
      dollarAmount: dollarAmountNum,
      maxPrice,
    });

    // Check if order was actually successful (not cancelled or failed)
    if (result && result.status !== 'cancelled' && (result.filledSize > 0 || result.status === 'open')) {
      const filled = result.filledSize || 0;
      const message = result.status === 'filled' 
        ? `Bought ${filled} contracts`
        : result.status === 'partial'
          ? `Partially filled: ${filled} contracts`
          : `Order placed (${result.status})`;
      setOrderStatus('success');
      setOrderResult({ message });
      setTimeout(() => {
        setOrderStatus('idle');
        setOrderResult(null);
        setSelectedOutcome(null);
      }, 3000);
    } else if (result && result.status === 'cancelled') {
      setOrderStatus('error');
      setOrderResult({ message: 'Order cancelled - no sellers at this price' });
    } else {
      // Order failed or returned null (validation error)
      // Wait a tick for the error state to update from the hook
      await new Promise(resolve => setTimeout(resolve, 50));
      setOrderStatus('error');
      // The orderError should now be set - if not, show generic message
      setOrderResult({ message: 'Order failed - check validation errors above' });
    }
  };
  
  // Handle sell from positions
  const handleSellFromPositions = (marketAddress: string, outcome: 'YES' | 'NO', shares: number, avgEntry: number, price: number) => {
    setSelectedOutcome(outcome);
    setTradeMode('sell');
    // Truncate shares to 6 decimals to match on-chain precision
    const truncatedShares = truncate6(shares);
    setSellData({
      marketAddress,
      shares: truncatedShares,
      avgEntry,
      currentPrice: price,
    });
    setSellSize(truncatedShares.toString());
  };

  const assetNames: Record<string, string> = {
    BTC: 'Bitcoin',
    ETH: 'Ethereum',
    SOL: 'Solana',
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="w-full py-1">
        {/* Top Bar: Back, Asset Info, Switch View */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => router.back()}
              className="flex items-center gap-2 text-text-muted hover:text-text-primary transition-colors text-sm font-medium"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <div className="h-6 w-px bg-border" />
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-surface-light flex items-center justify-center font-bold text-accent text-lg border border-border">
                {asset.charAt(0)}
              </div>
              <div>
                <h1 className="text-xl font-bold">{asset}</h1>
                <p className="text-sm text-text-muted">{assetNames[asset] || asset}</p>
              </div>
            </div>
          </div>

          <button
            onClick={onSwitchView}
            className="flex items-center gap-2 px-3 py-2 text-sm text-text-muted hover:text-accent bg-surface border border-border rounded-lg transition-colors"
            title="Switch to Mobile View"
          >
            <Smartphone className="w-4 h-4" />
            <span>Mobile</span>
          </button>
        </div>

        {marketsLoading && markets.length === 0 ? (
          <div className="flex items-center justify-center h-[600px] bg-surface rounded-xl border border-border">
            <div className="text-center text-text-muted">
              <RefreshCw className="w-8 h-8 mx-auto animate-spin mb-3" />
              <p>Loading markets...</p>
            </div>
          </div>
        ) : !activeMarket ? (
          <div className="flex items-center justify-center h-[600px] bg-surface rounded-xl border border-border">
            <div className="text-center text-text-muted">
              <p className="text-lg mb-2">No active {selectedTimeframe} market for {asset}</p>
              <button 
                onClick={() => refetch()}
                className="text-accent hover:text-accent-dim font-bold"
              >
                Refresh
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Main Content Grid - 3 column layout: Chart | Orderbook | Trading */}
            <div className="grid grid-cols-12 gap-1 mb-2">
              {/* LEFT: Chart (spans 8 columns - wider) */}
              <div className="col-span-12 lg:col-span-8">
                <div className="bg-surface rounded-xl border border-border overflow-hidden h-[650px]">
                  {/* Chart Header with Compact Timeframe Selector & Countdown */}
                  <div className="flex items-center justify-between px-2 py-2 bg-surface-light/30 border-b border-border">
                    {/* Compact Timeframe Selector */}
                    <div className="flex gap-1 p-1 bg-surface rounded-lg border border-border">
                      {TIMEFRAMES.map((tf) => (
                        <button
                          key={tf}
                          onClick={() => setTimeframe(tf)}
                          className={cn(
                            "px-4 py-2 rounded-md text-sm font-bold transition-all btn-press",
                            selectedTimeframe === tf 
                              ? "bg-accent text-background shadow-md shadow-accent/30" 
                              : "text-text-muted hover:text-text-primary hover:bg-surface-light"
                          )}
                        >
                          {tf}
                        </button>
                      ))}
                    </div>

                    {/* Compact Countdown Timer */}
                    <TimeCountdown market={activeMarket} onExpired={() => handleMarketExpired(activeMarket.id, activeMarket.timeframe)} />
                  </div>

                  {/* Chart */}
                  <div className="h-[calc(100%-52px)]">
                    <ChartV2 
                      onPositionClick={(position) => {
                        // Set up sell mode with the clicked position
                        setSelectedOutcome(position.outcome.toUpperCase() as 'YES' | 'NO');
                        setTradeMode('sell');
                        if (activeMarket) {
                          // Truncate shares to 6 decimals to match on-chain precision
                          const truncatedShares = truncate6(position.shares);
                          setSellData({
                            marketAddress: activeMarket.address,
                            shares: truncatedShares,
                            avgEntry: position.avgEntry,
                            currentPrice: position.currentPrice,
                          });
                          setSellSize(truncatedShares.toString());
                        }
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* MIDDLE: Orderbook (spans 2 columns) */}
              <div className="col-span-12 lg:col-span-2 h-[650px]">
                {activeMarket && (
                  <SingleOrderbook 
                    marketAddress={activeMarket.address} 
                    className="h-full"
                    onPriceClick={(price, side) => {
                      // Set limit price when clicking on orderbook
                      setLimitPrice(price.toFixed(2));
                      setOrderType('limit');
                    }}
                  />
                )}
              </div>

              {/* RIGHT: Trading Panel (spans 2 columns - narrower) */}
              <div className="col-span-12 lg:col-span-2 h-[650px] flex flex-col">
                {/* Compact Price Boxes - Horizontal Layout */}
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <CompactPriceBox
                    label="ABOVE"
                    price={yesPrice}
                    outcome="YES"
                    isSelected={selectedOutcome === 'YES'}
                    onSelect={() => {
                      if (isActivating) return;
                      if (oneClickEnabled && isDelegationApproved && connected) {
                        handleOneClickTrade('YES', yesPrice);
                      } else {
                        setSelectedOutcome(selectedOutcome === 'YES' ? null : 'YES');
                      }
                    }}
                    colorClass="long"
                    oneClickEnabled={oneClickEnabled && isDelegationApproved && connected && !isActivating}
                    oneClickAmount={oneClickAmount}
                    isLoading={orderStatus === 'placing' && oneClickOutcome === 'YES'}
                    isActivating={isActivating}
                  />
                  <CompactPriceBox
                    label="BELOW"
                    price={noPrice}
                    outcome="NO"
                    isSelected={selectedOutcome === 'NO'}
                    onSelect={() => {
                      if (isActivating) return;
                      if (oneClickEnabled && isDelegationApproved && connected) {
                        handleOneClickTrade('NO', noPrice);
                      } else {
                        setSelectedOutcome(selectedOutcome === 'NO' ? null : 'NO');
                      }
                    }}
                    colorClass="short"
                    oneClickEnabled={oneClickEnabled && isDelegationApproved && connected && !isActivating}
                    oneClickAmount={oneClickAmount}
                    isLoading={orderStatus === 'placing' && oneClickOutcome === 'NO'}
                    isActivating={isActivating}
                  />
                </div>
                
                {/* One-Click Status Toast */}
                {orderStatus === 'success' && oneClickOutcome && (
                  <div className="mb-3 p-3 bg-long/10 border border-long/30 rounded-lg flex items-center gap-2 text-long text-sm animate-fade-in">
                    <CheckCircle className="w-4 h-4" />
                    <span>{orderResult?.message}</span>
                  </div>
                )}
                {orderStatus === 'error' && oneClickOutcome && (
                  <div className="mb-3 p-3 bg-short/10 border border-short/30 rounded-lg flex items-center gap-2 text-short text-sm animate-shake">
                    <XCircle className="w-4 h-4" />
                    <span>{orderResult?.message}</span>
                  </div>
                )}

                {/* Trade Panel - Fills remaining space */}
                <div className="bg-surface rounded-xl border border-border flex-1 flex flex-col overflow-hidden">
                  {selectedOutcome ? (
                    <div className="p-3 flex flex-col h-full">
                      {/* Header with Buy/Sell toggle */}
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="font-bold flex items-center gap-2">
                          <Zap className={cn(
                            'w-4 h-4',
                            tradeMode === 'sell' ? 'text-warning' : selectedOutcome === 'YES' ? 'text-long' : 'text-short'
                          )} />
                          {tradeMode === 'sell' ? 'Sell' : 'Trade'}
                        </h3>
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            'px-2 py-1 rounded text-xs font-bold',
                            selectedOutcome === 'YES' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
                          )}>
                            {selectedOutcome === 'YES' ? 'ABOVE' : 'BELOW'}
                          </span>
                          {tradeMode === 'sell' && (
                            <button
                              onClick={() => {
                                setTradeMode('buy');
                                setSellData(null);
                                setSellSize('');
                              }}
                              className="text-xs text-text-muted hover:text-accent transition-colors"
                            >
                              ✕ Cancel
                            </button>
                          )}
                        </div>
                      </div>

                      {/* SELL MODE UI */}
                      {tradeMode === 'sell' && sellData ? (
                        <>
                          {/* Sell Size Input */}
                          <div className="mb-3">
                            <label className="block text-xs text-text-muted mb-1.5">
                              Shares to Sell (max {maxSellSize.toFixed(0)})
                            </label>
                            <input
                              type="number"
                              value={sellSize}
                              onChange={(e) => setSellSize(e.target.value)}
                              min="0"
                              max={maxSellSize}
                              step="1"
                              className="w-full bg-surface-light border border-border rounded-lg px-4 py-2.5 font-mono text-center focus:border-warning focus:ring-1 focus:ring-warning"
                            />
                            <div className="flex gap-1.5 mt-1.5">
                              {[0.25, 0.5, 0.75, 1].map((pct) => (
                                <button
                                  key={pct}
                                  onClick={() => setSellSize(truncate6(maxSellSize * pct).toString())}
                                  className={cn(
                                    'flex-1 py-1.5 text-xs rounded-md transition-colors font-medium',
                                    sellSizeNum === truncate6(maxSellSize * pct)
                                      ? 'bg-warning/20 text-warning'
                                      : 'bg-surface-light text-text-muted hover:text-text-primary'
                                  )}
                                >
                                  {pct === 1 ? 'Max' : `${pct * 100}%`}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Sell Summary */}
                          <div className="bg-surface-light rounded-lg p-3 mb-3 flex-1">
                            <div className="space-y-2">
                              <div className="flex justify-between text-sm">
                                <span className="text-text-muted">Shares to Sell</span>
                                <span className="font-mono font-bold">{sellSizeNum.toFixed(0)}</span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-text-muted">Market Price</span>
                                <span className="font-mono">${sellPrice.toFixed(2)}</span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-text-muted">Est. Proceeds</span>
                                <span className="font-mono">${sellProceeds.toFixed(2)}</span>
                              </div>
                              <div className="border-t border-border pt-2 mt-2">
                                <div className="flex justify-between text-sm">
                                  <span className="text-text-muted">Avg Entry</span>
                                  <span className="font-mono">${sellData.avgEntry.toFixed(2)}</span>
                                </div>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-text-muted font-medium">Est. P&L</span>
                                <span className={cn(
                                  'font-mono font-bold text-lg',
                                  sellProfit >= 0 ? 'text-long' : 'text-short'
                                )}>
                                  {sellProfit >= 0 ? '+' : ''}${sellProfit.toFixed(2)}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Order Status */}
                          {orderStatus === 'success' && orderResult && (
                            <div className="flex items-center gap-2 p-3 mb-3 bg-long/10 border border-long/30 rounded-lg text-long text-sm">
                              <CheckCircle className="w-4 h-4" />
                              <span>{orderResult.message}</span>
                            </div>
                          )}
                          
                          {orderStatus === 'error' && orderResult && (
                            <div className="flex items-center gap-2 p-3 mb-3 bg-short/10 border border-short/30 rounded-lg text-short text-sm">
                              <XCircle className="w-4 h-4" />
                              <span>{orderResult.message}</span>
                            </div>
                          )}

                          {/* Sell Button */}
                          {connected ? (
                            <button
                              onClick={handleQuickTrade}
                              disabled={isPlacing || orderStatus === 'success' || sellSizeNum <= 0 || sellSizeNum > maxSellSize}
                              className={cn(
                                'w-full py-3 rounded-lg font-bold transition-all flex items-center justify-center gap-2',
                                'bg-warning text-background hover:shadow-lg hover:shadow-warning/30',
                                (isPlacing || orderStatus === 'success' || sellSizeNum <= 0 || sellSizeNum > maxSellSize) && 'opacity-50 cursor-not-allowed'
                              )}
                            >
                              {isPlacing ? (
                                <>
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                  <span>Selling...</span>
                                </>
                              ) : orderStatus === 'success' ? (
                                <>
                                  <CheckCircle className="w-4 h-4" />
                                  <span>Sold!</span>
                                </>
                              ) : (
                                `Sell ${sellSizeNum.toFixed(0)} → $${sellProceeds.toFixed(2)}`
                              )}
                            </button>
                          ) : (
                            <WalletButton className="!w-full !justify-center !bg-accent !text-background hover:!bg-accent-dim !rounded-lg !font-bold !h-14 !text-lg" />
                          )}
                        </>
                      ) : (
                        /* BUY MODE UI */
                        <>
                          {/* Order Type Toggle */}
                          <div className="flex gap-1 p-1 bg-surface-light rounded-lg mb-3">
                            <button
                              onClick={() => setOrderType('market')}
                              className={cn(
                                'flex-1 py-2 text-sm font-bold rounded-md transition-all',
                                orderType === 'market'
                                  ? 'bg-accent text-background'
                                  : 'text-text-muted hover:text-text-primary'
                              )}
                            >
                              Market
                            </button>
                            <button
                              onClick={() => {
                                setOrderType('limit');
                                if (!limitPrice) setLimitPrice(marketPrice.toFixed(2));
                              }}
                              className={cn(
                                'flex-1 py-2 text-sm font-bold rounded-md transition-all',
                                orderType === 'limit'
                                  ? 'bg-accent text-background'
                                  : 'text-text-muted hover:text-text-primary'
                              )}
                            >
                              Limit
                            </button>
                          </div>

                          {/* Limit Price Input (only for limit orders) */}
                          {orderType === 'limit' && (
                            <div className="mb-3">
                              <label className="block text-xs text-text-muted mb-1.5">Limit Price</label>
                              <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">$</span>
                                <input
                                  type="number"
                                  value={limitPrice}
                                  onChange={(e) => setLimitPrice(e.target.value)}
                                  min="0.01"
                                  max="0.99"
                                  step="0.01"
                                  placeholder="0.50"
                                  className="w-full bg-surface-light border border-border rounded-lg pl-8 pr-4 py-2.5 font-mono text-right focus:border-accent focus:ring-1 focus:ring-accent"
                                />
                              </div>
                              <div className="flex gap-1.5 mt-1.5">
                                {[
                                  { label: '-5¢', delta: -0.05 },
                                  { label: '-1¢', delta: -0.01 },
                                  { label: 'Mkt', delta: 0 },
                                  { label: '+1¢', delta: 0.01 },
                                  { label: '+5¢', delta: 0.05 },
                                ].map(({ label, delta }) => (
                                  <button
                                    key={label}
                                    onClick={() => {
                                      if (delta === 0) {
                                        setLimitPrice(marketPrice.toFixed(2));
                                      } else {
                                        const newPrice = Math.max(0.01, Math.min(0.99, (limitPriceNum || marketPrice) + delta));
                                        setLimitPrice(newPrice.toFixed(2));
                                      }
                                    }}
                                    className="flex-1 py-1.5 text-xs rounded-md bg-surface text-text-muted hover:text-text-primary hover:bg-surface-light transition-colors"
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Amount Input */}
                          <div className="mb-3">
                            <label className="block text-xs text-text-muted mb-1.5">Amount to Spend</label>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">$</span>
                              <input
                                type="number"
                                value={dollarAmount}
                                onChange={(e) => setDollarAmount(e.target.value)}
                                min="1"
                                className="w-full bg-surface-light border border-border rounded-lg pl-8 pr-14 py-2.5 font-mono text-right focus:border-accent focus:ring-1 focus:ring-accent"
                              />
                              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted text-xs">USDC</span>
                            </div>
                            <div className="flex gap-1.5 mt-1.5">
                              {[25, 50, 100, 250, 500].map((preset) => (
                                <button
                                  key={preset}
                                  onClick={() => setDollarAmount(preset.toString())}
                                  className={cn(
                                    'flex-1 py-1.5 text-xs rounded-md transition-colors font-medium',
                                    parseFloat(dollarAmount) === preset
                                      ? 'bg-accent/20 text-accent'
                                      : 'bg-surface-light text-text-muted hover:text-text-primary'
                                  )}
                                >
                                  ${preset}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Summary - Takes available space */}
                          <div className="bg-surface-light rounded-lg p-3 mb-3 flex-1">
                            <div className="space-y-2">
                              <div className="flex justify-between text-sm">
                                <span className="text-text-muted">
                                  {orderType === 'limit' ? 'Limit Price' : 'Market Price'}
                                </span>
                                <span className="font-mono font-bold">${selectedPrice.toFixed(2)}</span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-text-muted">Est. Contracts</span>
                                <span className="font-mono font-bold">{estimatedContracts.toLocaleString()}</span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-text-muted">Max Payout</span>
                                <span className="font-mono">${estimatedPayout.toFixed(2)}</span>
                              </div>
                              <div className="border-t border-border pt-2 mt-2">
                                <div className="flex justify-between">
                                  <span className="text-text-muted font-medium">Est. Profit</span>
                                  <span className="font-mono font-bold text-lg text-long">+${estimatedProfit.toFixed(2)}</span>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Order Status */}
                          {orderStatus === 'success' && orderResult && (
                            <div className="flex items-center gap-2 p-3 mb-3 bg-long/10 border border-long/30 rounded-lg text-long text-sm">
                              <CheckCircle className="w-4 h-4" />
                              <span>{orderResult.message}</span>
                            </div>
                          )}
                          
                          {orderStatus === 'error' && orderResult && (
                            <div className="flex items-center gap-2 p-3 mb-3 bg-short/10 border border-short/30 rounded-lg text-short text-sm">
                              <XCircle className="w-4 h-4" />
                              <span>{orderResult.message}</span>
                            </div>
                          )}

                          {/* Hook validation errors (shown immediately from hook state) */}
                          {orderError && orderStatus === 'idle' && (
                            <div className="flex items-center gap-2 p-3 mb-3 bg-short/10 border border-short/30 rounded-lg text-short text-sm">
                              <XCircle className="w-4 h-4" />
                              <span>{orderError}</span>
                            </div>
                          )}

                          {/* Trade Button */}
                          {connected ? (
                            !isDelegationApproved ? (
                              <button
                                onClick={() => approveDelegation()}
                                disabled={isApproving}
                                className="w-full py-4 rounded-lg font-bold bg-accent text-background hover:shadow-lg hover:shadow-accent/30 transition-all flex items-center justify-center gap-2 text-lg"
                              >
                                {isApproving ? (
                                  <>
                                    <Loader2 className="w-5 h-5 animate-spin" />
                                    <span>Enabling...</span>
                                  </>
                                ) : (
                                  <>
                                    <Settings className="w-5 h-5" />
                                    <span>Delegate USDC to Trade</span>
                                  </>
                                )}
                              </button>
                            ) : (
                              <button
                                onClick={handleQuickTrade}
                                disabled={isPlacing || orderStatus === 'success' || estimatedContracts <= 0 || (orderType === 'limit' && (limitPriceNum <= 0 || limitPriceNum >= 1))}
                                className={cn(
                                  'w-full py-3 rounded-lg font-bold transition-all flex items-center justify-center gap-2',
                                  selectedOutcome === 'YES'
                                    ? 'bg-long text-background hover:shadow-lg hover:shadow-long/30'
                                    : 'bg-short text-background hover:shadow-lg hover:shadow-short/30',
                                  (isPlacing || orderStatus === 'success' || estimatedContracts <= 0 || (orderType === 'limit' && (limitPriceNum <= 0 || limitPriceNum >= 1))) && 'opacity-50 cursor-not-allowed'
                                )}
                              >
                                {isPlacing ? (
                                  <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    <span>Placing...</span>
                                  </>
                                ) : orderStatus === 'success' ? (
                                  <>
                                    <CheckCircle className="w-4 h-4" />
                                    <span>Done!</span>
                                  </>
                                ) : orderType === 'limit' ? (
                                  `Place Limit @ $${limitPriceNum.toFixed(2)}`
                                ) : (
                                  `Buy ${estimatedContracts} ${selectedOutcome === 'YES' ? 'ABOVE' : 'BELOW'}`
                                )}
                              </button>
                            )
                          ) : (
                            <WalletButton className="!w-full !justify-center !bg-accent !text-background hover:!bg-accent-dim !rounded-lg !font-bold !h-14 !text-lg" />
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    /* Empty state - prompt to select */
                    <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
                      <div className="w-16 h-16 rounded-full bg-surface-light flex items-center justify-center mb-4">
                        <Zap className="w-8 h-8 text-text-muted" />
                      </div>
                      <h3 className="font-bold text-lg mb-2">Select a Position</h3>
                      <p className="text-text-muted text-sm max-w-[200px]">
                        Click <span className="text-long font-bold">ABOVE</span> or <span className="text-short font-bold">BELOW</span> to start trading
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* BOTTOM: Positions/Portfolio */}
            <div className="bg-surface rounded-xl border border-border overflow-hidden">
              <div className="px-2 py-2 bg-surface-light/30 border-b border-border">
                <h2 className="font-bold text-lg">Positions / Portfolio</h2>
              </div>
              <div className="min-h-[250px]">
                <Positions 
                  onSell={(marketAddress, outcome, shares, avgEntry, price) => {
                    handleSellFromPositions(marketAddress, outcome, shares, avgEntry, price);
                    // Scroll to trade panel
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  currentMarketAddress={activeMarket?.address}
                  currentYesPrice={yesPrice}
                  currentNoPrice={noPrice}
                />
              </div>
            </div>

            {/* Global Trade Blotter */}
            <GlobalTradeBlotter className="mt-4" maxTrades={50} />
          </>
        )}
      </main>

    </div>
  );
}

// Compact Price Box Component - Horizontal layout
function CompactPriceBox({
  label,
  price,
  outcome,
  isSelected,
  onSelect,
  colorClass,
  oneClickEnabled = false,
  oneClickAmount = 0,
  isLoading = false,
  isActivating = false,
}: {
  label: string;
  price: number;
  outcome: 'YES' | 'NO';
  isSelected: boolean;
  onSelect: () => void;
  colorClass: 'long' | 'short';
  oneClickEnabled?: boolean;
  oneClickAmount?: number;
  isLoading?: boolean;
  isActivating?: boolean;
}) {
  const isDisabled = isLoading || isActivating;
  
  return (
    <button
      onClick={onSelect}
      disabled={isDisabled}
      className={cn(
        'relative p-3 rounded-xl border-2 transition-all text-center group overflow-hidden btn-press',
        'bg-surface',
        isActivating && 'opacity-60 cursor-not-allowed',
        !isActivating && 'hover:bg-surface-light',
        isSelected && !isActivating
          ? colorClass === 'long' 
            ? 'border-long shadow-lg shadow-long/20' 
            : 'border-short shadow-lg shadow-short/20'
          : isActivating 
            ? 'border-accent/30'
            : 'border-border hover:border-opacity-50',
        oneClickEnabled && !isDisabled && 'ring-2 ring-warning/30 hover:ring-warning/50',
        isLoading && 'opacity-75 cursor-wait'
      )}
    >
      {/* Background glow */}
      <div className={cn(
        'absolute inset-0 opacity-0 transition-opacity duration-300',
        (isSelected || oneClickEnabled) && !isActivating && 'opacity-100',
        colorClass === 'long' ? 'bg-gradient-to-br from-long/10 to-transparent' : 'bg-gradient-to-br from-short/10 to-transparent'
      )} />

      <div className="relative">
        {/* Loading State */}
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-2">
            <Loader2 className={cn(
              'w-8 h-8 animate-spin mb-2',
              colorClass === 'long' ? 'text-long' : 'text-short'
            )} />
            <span className="text-sm text-text-muted">Placing order...</span>
          </div>
        ) : isActivating ? (
          /* Activating State */
          <div className="flex flex-col items-center justify-center py-2">
            <div className="text-3xl font-bold font-mono mb-1 text-text-muted">
              --
            </div>
            <div className="inline-block px-3 py-1 rounded-full text-xs font-bold bg-surface-light text-text-muted">
              {label}
            </div>
            <div className="mt-2 text-xs text-text-muted">
              Waiting for strike...
            </div>
          </div>
        ) : (
          <>
            {/* Price Display */}
                            <div className={cn(
                              'text-2xl font-bold font-mono mb-1 transition-transform',
                              colorClass === 'long' ? 'text-long' : 'text-short',
                              'group-hover:scale-105'
                            )}>
                              ${price.toFixed(2)}
                            </div>
            
            {/* Label Badge */}
            <div className={cn(
              'inline-block px-3 py-1 rounded-full text-xs font-bold',
              colorClass === 'long' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
            )}>
              {label}
            </div>

            {/* One-Click Mode Indicator */}
            {oneClickEnabled && (
              <div className="mt-2 flex items-center justify-center gap-1 text-xs text-warning font-bold">
                <Zap className="w-3 h-3" />
                <span>Tap to buy ${oneClickAmount}</span>
              </div>
            )}

            {/* Selected indicator */}
            {isSelected && !oneClickEnabled && (
              <div className={cn(
                'absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center',
                colorClass === 'long' ? 'bg-long' : 'bg-short'
              )}>
                <CheckCircle className="w-3 h-3 text-background" />
              </div>
            )}
          </>
        )}
      </div>
    </button>
  );
}

// Time Countdown Component - Large & Prominent
function TimeCountdown({ 
  market, 
  onExpired 
}: { 
  market: { id: string; timeframe: Timeframe; expiry?: number; strike?: number };
  onExpired: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const hasExpiredRef = useRef(false);
  
  // Check if market is pending activation (strike = 0 means waiting for activation)
  const isActivating = market.strike === 0;

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const isExpired = market.expiry ? market.expiry <= now : false;

  useEffect(() => {
    if (isExpired && !hasExpiredRef.current) {
      hasExpiredRef.current = true;
      onExpired();
    }
  }, [isExpired, onExpired]);

  useEffect(() => {
    hasExpiredRef.current = false;
  }, [market.id]);

  const timeRemaining = useMemo(() => {
    // Don't show countdown if market is still activating
    if (isActivating) return null;
    
    if (!market.expiry) return null;
    const diff = market.expiry - now;
    if (diff <= 0) return { text: 'Expired', urgent: true, isExpired: true, percent: 0 };
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    const durations: Record<string, number> = {
      '5m': 5 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
    };
    const totalDuration = durations[market.timeframe] || 5 * 60 * 1000;
    const percent = Math.min(100, Math.max(0, (diff / totalDuration) * 100));
    const urgent = diff < 60000;
    
    if (hours > 0) {
      return { text: `${hours}h ${minutes % 60}m ${seconds % 60}s`, percent, urgent, isExpired: false };
    } else if (minutes > 0) {
      return { text: `${minutes}m ${seconds % 60}s`, percent, urgent, isExpired: false };
    } else {
      return { text: `${seconds}s`, percent, urgent, isExpired: false };
    }
  }, [market.expiry, market.timeframe, now, isActivating]);

  // Show activation state
  if (isActivating) {
    return (
      <div className="flex items-center gap-4">
        {/* Activation display */}
        <div className="flex items-center gap-3 px-5 py-3 rounded-xl font-mono transition-all bg-accent/10 text-accent border-2 border-accent/50">
          <div className="relative w-6 h-6">
            <div className="absolute inset-0 rounded-full bg-accent/30 animate-ping" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          </div>
          <span className="font-bold text-xl animate-pulse">
            Activating...
          </span>
        </div>
        
        {/* Animated shimmer progress bar */}
        <div className="w-40 h-3 bg-surface rounded-full overflow-hidden border-2 border-accent/30">
          <div className="h-full w-full bg-gradient-to-r from-accent/20 via-accent to-accent/20 animate-shimmer" 
               style={{ backgroundSize: '200% 100%' }} />
        </div>
      </div>
    );
  }

  if (!timeRemaining) return null;

  return (
    <div className="flex items-center gap-4">
      {/* Large countdown display */}
      <div className={cn(
        'flex items-center gap-3 px-5 py-3 rounded-xl font-mono transition-all',
        timeRemaining.isExpired 
          ? 'bg-warning/20 text-warning border-2 border-warning/50' 
          : timeRemaining.urgent 
            ? 'bg-short/20 text-short border-2 border-short/50 animate-pulse' 
            : 'bg-surface text-text-primary border-2 border-border'
      )}>
        <Clock className={cn(
          'transition-all',
          timeRemaining.urgent ? 'w-7 h-7 animate-bounce' : 'w-6 h-6'
        )} />
        {timeRemaining.isExpired ? (
          <span className="flex items-center gap-2 text-xl font-bold">
            <RefreshCw className="w-5 h-5 animate-spin" />
            Refreshing...
          </span>
        ) : (
          <span className={cn(
            'font-bold tabular-nums tracking-wider',
            timeRemaining.urgent ? 'text-3xl' : 'text-2xl'
          )}>
            {timeRemaining.text}
          </span>
        )}
      </div>
      
      {/* Large progress bar */}
      <div className="w-40 h-3 bg-surface rounded-full overflow-hidden border-2 border-border">
        <div 
          className={cn(
            'h-full rounded-full transition-all duration-1000',
            timeRemaining.isExpired
              ? 'bg-warning'
              : timeRemaining.urgent 
                ? 'bg-short animate-pulse' 
                : timeRemaining.percent > 50 
                  ? 'bg-long' 
                  : timeRemaining.percent > 25 
                    ? 'bg-warning' 
                    : 'bg-short'
          )}
          style={{ width: `${timeRemaining.isExpired ? 100 : timeRemaining.percent}%` }}
        />
      </div>
    </div>
  );
}

