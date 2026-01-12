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
  Zap,
  TrendingUp
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
  const { oneClickEnabled, oneClickAmount, soundEnabled, setOneClickAmount } = useSettingsStore();
  
  // Session key for instant trading (no wallet popups)
  const { isActive: isSessionActive, publicKey: sessionPublicKey, signOrder, createSession, revokeSession, isCreating: isCreatingSession, getTimeRemaining } = useSessionKey();
  
  // Create session signer if session is active
  const sessionSigner: SessionSigner | undefined = useMemo(() => {
    console.log('[DesktopView] Creating sessionSigner:', { isSessionActive, sessionPublicKey: sessionPublicKey?.slice(0, 8), hasSignOrder: !!signOrder });
    if (!isSessionActive || !sessionPublicKey) return undefined;
    return {
      publicKey: sessionPublicKey,
      sign: signOrder,
    };
  }, [isSessionActive, sessionPublicKey, signOrder]);
  
  // Debug: Log when sessionSigner changes
  useEffect(() => {
    console.log('[DesktopView] sessionSigner updated:', { hasSessionSigner: !!sessionSigner, pubkey: sessionSigner?.publicKey?.slice(0, 8) });
  }, [sessionSigner]);
  
  // One-click amount popup state
  const [showAmountPopup, setShowAmountPopup] = useState(false);
  const [pendingOneClickOutcome, setPendingOneClickOutcome] = useState<{ outcome: 'YES' | 'NO'; price: number } | null>(null);

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
  
  // Leverage state
  const [leverage, setLeverage] = useState(1);
  const [showLeverage, setShowLeverage] = useState(false);
  
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
  
  // Leverage calculations - dollarAmount is the user's MARGIN when leveraged
  const leverageStats = useMemo(() => {
    const isLeveraged = leverage > 1;
    const price = selectedPrice;
    
    if (price === 0 || dollarAmountNum === 0) {
      return { 
        isLeveraged: false, 
        marginRequired: dollarAmountNum, 
        loanAmount: 0, 
        liquidationPrice: 0,
        buyingPower: dollarAmountNum,
        contracts: 0
      };
    }
    
    // With leverage: dollarAmount = margin, buyingPower = margin * leverage
    const marginRequired = dollarAmountNum;
    const buyingPower = isLeveraged ? marginRequired * leverage : marginRequired;
    const loanAmount = buyingPower - marginRequired;
    const contracts = Math.floor(buyingPower / price);
    
    // Liquidation price calculation (3% maintenance margin for leverage)
    // At 10x leverage, initial margin is 10%. Lower maintenance = liquidate later, return ~35% of margin.
    // Formula: liq_price = loan / (shares * (1 - maintenance_margin))
    const maintenanceMarginPct = 0.03; // 3% maintenance = liquidate later, return ~35% of collateral
    let liquidationPrice = 0;
    
    if (isLeveraged && contracts > 0 && loanAmount > 0) {
      // Same formula for both YES and NO:
      // liq_price = loan / (shares × (1 - maintenance_margin))
      // For YES: liquidation when YES price drops to this level
      // For NO: liquidation when NO price drops to this level
      liquidationPrice = loanAmount / (contracts * (1 - maintenanceMarginPct));
      
      // Clamp to valid price range
      liquidationPrice = Math.max(0.01, Math.min(0.99, liquidationPrice));
    }
    
    return { isLeveraged, marginRequired, loanAmount, liquidationPrice, buyingPower, contracts };
  }, [leverage, dollarAmountNum, selectedPrice, selectedOutcome]);

  // Contracts: use leveraged contracts if leverage > 1, otherwise normal calculation
  const estimatedContracts = leverageStats.contracts > 0 ? leverageStats.contracts : 
    (dollarAmountNum > 0 && selectedPrice > 0 ? Math.floor(dollarAmountNum / selectedPrice) : 0);
  const estimatedPayout = estimatedContracts * 1.0;
  const estimatedProfit = estimatedPayout - (leverage > 1 ? leverageStats.marginRequired : dollarAmountNum);
  
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
  
  // Toast notification state
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  
  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  
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
      setToast({ type: 'error', message: 'Order failed - try manual trade' });
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
        setToast({ type: 'error', message: 'Order cancelled - no buyers at this price' });
      } else if (result && result.filledSize === 0) {
        setOrderStatus('error');
        setOrderResult({ message: 'No fills - try adjusting price or wait for buyers' });
        setToast({ type: 'error', message: 'No fills - try adjusting price or wait for buyers' });
      } else {
        setOrderStatus('error');
        setOrderResult({ message: orderError || 'Order failed' });
        setToast({ type: 'error', message: orderError || 'Order failed' });
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

    // DEBUG: Log leverage state before placing order
    console.log('[Trade] Placing order with leverage:', {
      leverage,
      isLeveraged: leverage > 1,
      dollarAmountInput: dollarAmountNum,
      buyingPower: leverageStats.buyingPower,
      marginRequired: leverageStats.marginRequired,
      contracts: estimatedContracts,
      outcome: selectedOutcome,
    });
    
    const result = await placeOrder({
      marketAddress: activeMarket.address,
      side: 'bid',
      outcome: selectedOutcome.toLowerCase() as 'yes' | 'no',
      orderType: orderType,
      price: orderType === 'limit' ? limitPriceNum : marketPrice,
      size: estimatedContracts,
      expiryTimestamp,
      // With leverage: dollarAmount is buying power, marginAmount is user's collateral
      dollarAmount: leverage > 1 ? leverageStats.buyingPower : dollarAmountNum,
      maxPrice,
      leverage: leverage > 1 ? leverage : undefined,
      marginAmount: leverage > 1 ? dollarAmountNum : undefined, // User's margin (their input)
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
      setToast({ type: 'error', message: 'Order cancelled - no sellers at this price' });
    } else {
      // Order failed or returned null (validation error)
      // Wait a tick for the error state to update from the hook
      await new Promise(resolve => setTimeout(resolve, 50));
      setOrderStatus('error');
      // The orderError should now be set - if not, show generic message
      const errorMsg = orderError || 'Order failed';
      setOrderResult({ message: errorMsg });
      setToast({ type: 'error', message: errorMsg });
    }
  };
  
  // Handle sell from positions
  const handleSellFromPositions = (marketAddress: string, outcome: 'YES' | 'NO', shares: number, avgEntry: number, price: number) => {
    setSelectedOutcome(outcome);
    setTradeMode('sell');
    setSellData({
      marketAddress,
      shares,
      avgEntry,
      currentPrice: price,
    });
    setSellSize(shares.toString());
  };

  const assetNames: Record<string, string> = {
    BTC: 'Bitcoin',
    ETH: 'Ethereum',
    SOL: 'Solana',
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />

      {/* Toast Notification */}
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 animate-fade-in">
          <div className={cn(
            'flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg border backdrop-blur-sm',
            toast.type === 'error' 
              ? 'bg-short/90 border-short text-white' 
              : 'bg-long/90 border-long text-white'
          )}>
            {toast.type === 'error' ? (
              <XCircle className="w-5 h-5 flex-shrink-0" />
            ) : (
              <CheckCircle className="w-5 h-5 flex-shrink-0" />
            )}
            <span className="font-medium text-sm">{toast.message}</span>
            <button 
              onClick={() => setToast(null)}
              className="ml-2 p-1 hover:bg-white/20 rounded transition-colors"
            >
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* One-Click Amount Popup */}
      {showAmountPopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-surface border border-border rounded-xl shadow-2xl w-80 overflow-hidden animate-fade-in-scale">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-surface-light/50 border-b border-border">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-warning" />
                <span className="font-bold text-sm">One-Click Amount</span>
              </div>
              <button
                onClick={() => {
                  setShowAmountPopup(false);
                  setPendingOneClickOutcome(null);
                }}
                className="p-1 hover:bg-surface-light rounded transition-colors"
              >
                <XCircle className="w-4 h-4 text-text-muted" />
              </button>
            </div>
            
            {/* Current Amount Display */}
            <div className="p-4">
              <div className="flex items-center justify-center mb-4">
                <span className="text-3xl font-black font-mono text-warning">${oneClickAmount}</span>
              </div>
              
              {/* Quick Amount Presets */}
              <div className="grid grid-cols-4 gap-2 mb-4">
                {[25, 50, 100, 250].map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setOneClickAmount(amt)}
                    className={cn(
                      'py-2 text-sm font-bold rounded-lg transition-all btn-press',
                      oneClickAmount === amt
                        ? 'bg-warning text-background'
                        : 'bg-surface-light hover:bg-border text-text-primary'
                    )}
                  >
                    ${amt}
                  </button>
                ))}
              </div>
              
              {/* Custom Amount Input */}
              <div className="flex items-center gap-2 mb-4">
                <span className="text-text-muted text-sm">Custom:</span>
                <div className="flex-1 relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">$</span>
                  <input
                    type="number"
                    value={oneClickAmount}
                    onChange={(e) => setOneClickAmount(Math.max(1, Number(e.target.value) || 1))}
                    className="w-full pl-7 pr-3 py-2 bg-surface-light border border-border rounded-lg text-text-primary font-mono text-center focus:border-warning outline-none transition-colors"
                    min="1"
                    step="1"
                  />
                </div>
              </div>
              
              {/* Action Buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowAmountPopup(false);
                    setPendingOneClickOutcome(null);
                  }}
                  className="flex-1 py-2.5 rounded-lg bg-surface-light hover:bg-border text-text-primary font-bold transition-all btn-press"
                >
                  Cancel
                </button>
                {pendingOneClickOutcome && (
                  <button
                    onClick={() => {
                      setShowAmountPopup(false);
                      handleOneClickTrade(pendingOneClickOutcome.outcome, pendingOneClickOutcome.price);
                      setPendingOneClickOutcome(null);
                    }}
                    className={cn(
                      'flex-1 py-2.5 rounded-lg font-bold transition-all btn-press flex items-center justify-center gap-1.5',
                      pendingOneClickOutcome.outcome === 'YES'
                        ? 'bg-long hover:bg-long/80 text-background'
                        : 'bg-short hover:bg-short/80 text-white'
                    )}
                  >
                    <Zap className="w-4 h-4" />
                    Trade {pendingOneClickOutcome.outcome === 'YES' ? 'ABOVE' : 'BELOW'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <main className="w-full px-3 py-1">
        {/* Compact Top Bar */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => router.back()}
              className="flex items-center gap-1.5 text-text-muted hover:text-text-primary transition-colors text-xs font-medium"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back
            </button>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-surface-light flex items-center justify-center font-bold text-accent text-sm border border-border">
                {asset.charAt(0)}
              </div>
              <div>
                <h1 className="text-sm font-bold leading-tight">{asset} <span className="text-text-muted font-normal text-xs">{assetNames[asset] || ''}</span></h1>
              </div>
            </div>
          </div>

          <button
            onClick={onSwitchView}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-text-muted hover:text-accent bg-surface border border-border rounded-md transition-colors"
            title="Switch to Mobile View"
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>Mobile</span>
          </button>
        </div>

        {marketsLoading && markets.length === 0 ? (
          <div className="flex items-center justify-center h-[calc(100vh-100px)] bg-surface rounded-lg border border-border">
            <div className="text-center text-text-muted">
              <RefreshCw className="w-6 h-6 mx-auto animate-spin mb-2" />
              <p className="text-sm">Loading markets...</p>
            </div>
          </div>
        ) : !activeMarket ? (
          <div className="flex items-center justify-center h-[calc(100vh-100px)] bg-surface rounded-lg border border-border">
            <div className="text-center text-text-muted">
              <p className="text-sm mb-2">No active {selectedTimeframe} market for {asset}</p>
              <button 
                onClick={() => refetch()}
                className="text-accent hover:text-accent-dim font-bold text-sm"
              >
                Refresh
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Main Content Grid - 2 column layout: Chart | Combined Trading Panel */}
            <div className="grid grid-cols-12 gap-2 mb-2">
              {/* LEFT: Chart (spans 9 columns) */}
              <div className="col-span-12 lg:col-span-9 overflow-hidden">
                <div className="bg-surface rounded-lg border border-border overflow-hidden h-[calc(100vh-420px)] min-h-[200px] relative">
                  {/* Chart Header with Compact Timeframe Selector & Countdown */}
                  <div className="flex items-center justify-between px-3 py-2 bg-surface-light/30 border-b border-border">
                    {/* Compact Timeframe Selector */}
                    <div className="flex gap-0.5 p-0.5 bg-surface rounded-lg border border-border">
                      {TIMEFRAMES.map((tf) => (
                        <button
                          key={tf}
                          onClick={() => setTimeframe(tf)}
                          className={cn(
                            "px-3 py-1.5 rounded-md text-xs font-bold transition-all btn-press",
                            selectedTimeframe === tf 
                              ? "bg-accent text-background shadow-sm shadow-accent/30" 
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
                  <div className="h-[calc(100%-44px)]">
                    <ChartV2 
                      strikePrice={activeMarket?.strike}
                      centerOnStrike={true}
                      onPositionClick={(position) => {
                        // Set up sell mode with the clicked position
                        setSelectedOutcome(position.outcome.toUpperCase() as 'YES' | 'NO');
                        setTradeMode('sell');
                        if (activeMarket) {
                          setSellData({
                            marketAddress: activeMarket.address,
                            shares: position.shares,
                            avgEntry: position.avgEntry,
                            currentPrice: position.currentPrice,
                          });
                          setSellSize(position.shares.toString());
                        }
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* RIGHT: Combined Trading Panel (spans 3 columns) - ONE unified container */}
              <div className="col-span-12 lg:col-span-3 h-[calc(100vh-420px)] min-h-[200px] bg-surface rounded-lg border border-border flex flex-col overflow-hidden">
                {/* TOP HALF: Orderbook fills space above the strike line */}
                <div className="flex-1 border-b border-border overflow-hidden">
                  {activeMarket && (
                    <SingleOrderbook 
                      marketAddress={activeMarket.address} 
                      className="!rounded-none !border-0 h-full"
                      compact={true}
                      onPriceClick={(price, side) => {
                        // Set limit price when clicking on orderbook
                        setLimitPrice(price.toFixed(2));
                        setOrderType('limit');
                      }}
                    />
                  )}
                </div>

                {/* MIDDLE: Price Selectors - Divider aligns with chart strike price */}
                <div className="flex-shrink-0">
                  {/* ABOVE selector */}
                  <PriceSelectorBox
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
                    onAmountClick={() => {
                      setPendingOneClickOutcome({ outcome: 'YES', price: yesPrice });
                      setShowAmountPopup(true);
                    }}
                  />
                  
                  {/* Simple divider between ABOVE/BELOW */}
                  <div className="h-px bg-border" />
                  
                  {/* BELOW selector */}
                  <PriceSelectorBox
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
                    onAmountClick={() => {
                      setPendingOneClickOutcome({ outcome: 'NO', price: noPrice });
                      setShowAmountPopup(true);
                    }}
                  />
                </div>
                
                {/* One-Click Status Toast */}
                {orderStatus === 'success' && oneClickOutcome && (
                  <div className="p-2 bg-long/10 border-y border-long/30 flex items-center gap-1.5 text-long text-xs animate-fade-in">
                    <CheckCircle className="w-3.5 h-3.5" />
                    <span>{orderResult?.message}</span>
                  </div>
                )}

                {/* BOTTOM HALF: Trade Panel - fills space below strike line */}
                <div className="flex-1 flex flex-col overflow-hidden min-h-0 border-t border-border">
                  {selectedOutcome ? (
                    <div className="p-2.5 pt-2 flex flex-col h-full">
                      {/* Minimal header - only show when in sell mode */}
                          {tradeMode === 'sell' && (
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-bold text-warning">Sell Position</span>
                            <button
                              onClick={() => {
                                setTradeMode('buy');
                                setSellData(null);
                                setSellSize('');
                              }}
                              className="px-2 py-0.5 rounded text-xs font-bold bg-surface-light text-text-muted hover:text-text-primary hover:bg-surface transition-colors"
                            >
                              Cancel
                            </button>
                        </div>
                      )}

                      {/* SELL MODE UI */}
                      {tradeMode === 'sell' && sellData ? (
                        <>
                          {/* Sell Size Input */}
                          <div className="mb-2">
                            <div className="flex items-center justify-between mb-1">
                              <label className="text-xs text-text-muted">Shares</label>
                              <span className="text-xs text-text-muted">max {maxSellSize.toFixed(0)}</span>
                            </div>
                            <input
                              type="number"
                              value={sellSize}
                              onChange={(e) => setSellSize(e.target.value)}
                              min="0"
                              max={maxSellSize}
                              step="1"
                              className="w-full bg-surface-light border border-border rounded-lg px-3 py-2.5 font-mono text-lg text-right focus:border-warning focus:ring-1 focus:ring-warning"
                            />
                            <div className="flex gap-1 mt-1.5">
                              {[0.25, 0.5, 0.75, 1].map((pct) => (
                                <button
                                  key={pct}
                                  onClick={() => setSellSize(Math.floor(maxSellSize * pct).toString())}
                                  className={cn(
                                    'flex-1 py-1.5 text-xs rounded-lg transition-colors font-bold',
                                    sellSizeNum === Math.floor(maxSellSize * pct)
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
                          <div className="bg-surface-light rounded-lg p-2.5 mb-2 text-sm">
                            <div className="space-y-1">
                              <div className="flex justify-between">
                                <span className="text-text-muted">Shares</span>
                                <span className="font-mono font-bold">{sellSizeNum.toFixed(0)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-text-muted">Price</span>
                                <span className="font-mono">${sellPrice.toFixed(2)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-text-muted">Proceeds</span>
                                <span className="font-mono">${sellProceeds.toFixed(2)}</span>
                              </div>
                              <div className="border-t border-border pt-1 mt-1">
                                <div className="flex justify-between">
                                  <span className="text-text-muted font-medium">P&L</span>
                                  <span className={cn(
                                    'font-mono font-bold text-base',
                                    sellProfit >= 0 ? 'text-long' : 'text-short'
                                  )}>
                                    {sellProfit >= 0 ? '+' : ''}${sellProfit.toFixed(2)}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Sell Button */}
                          {connected ? (
                            <button
                              onClick={handleQuickTrade}
                              disabled={isPlacing || orderStatus === 'success' || sellSizeNum <= 0 || sellSizeNum > maxSellSize}
                              className={cn(
                                'w-full py-2.5 rounded-lg font-bold text-base transition-all flex items-center justify-center gap-2',
                                'bg-warning text-background hover:shadow-md hover:shadow-warning/30',
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
                                `Sell → $${sellProceeds.toFixed(2)}`
                              )}
                            </button>
                          ) : (
                            <WalletButton className="!w-full !justify-center !bg-accent !text-background hover:!bg-accent-dim !rounded-lg !font-bold !h-10 !text-sm" />
                          )}
                        </>
                      ) : (
                        /* BUY MODE UI */
                        <>
                          {/* Order Type Toggle */}
                          <div className="flex gap-1 p-1 bg-surface-light rounded-lg mb-2">
                            <button
                              onClick={() => setOrderType('market')}
                              className={cn(
                                'flex-1 py-1.5 text-sm font-bold rounded-md transition-all',
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
                                'flex-1 py-1.5 text-sm font-bold rounded-md transition-all',
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
                            <div className="mb-2">
                              <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-sm">$</span>
                                <input
                                  type="number"
                                  value={limitPrice}
                                  onChange={(e) => setLimitPrice(e.target.value)}
                                  min="0.01"
                                  max="0.99"
                                  step="0.01"
                                  placeholder="0.50"
                                  className="w-full bg-surface-light border border-border rounded-lg pl-8 pr-3 py-2 font-mono text-lg text-right focus:border-accent focus:ring-1 focus:ring-accent"
                                />
                              </div>
                              <div className="flex gap-1 mt-1">
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
                                    className="flex-1 py-1 text-xs rounded-md bg-surface text-text-muted hover:text-text-primary hover:bg-surface-light transition-colors font-medium"
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Amount Input */}
                          <div className="mb-2">
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-sm">$</span>
                              <input
                                type="number"
                                value={dollarAmount}
                                onChange={(e) => setDollarAmount(e.target.value)}
                                min="1"
                                className="w-full bg-surface-light border border-border rounded-lg pl-8 pr-3 py-2 font-mono text-lg text-right focus:border-accent focus:ring-1 focus:ring-accent"
                              />
                            </div>
                            <div className="flex gap-1 mt-1.5">
                              {[25, 50, 100, 250].map((preset) => (
                                <button
                                  key={preset}
                                  onClick={() => setDollarAmount(preset.toString())}
                                  className={cn(
                                    'flex-1 py-1 text-xs rounded-lg transition-colors font-bold',
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

                          {/* Summary */}
                          <div className="bg-surface-light rounded-lg p-2.5 mb-2 text-sm">
                            <div className="space-y-1">
                              <div className="flex justify-between">
                                <span className="text-text-muted">Price</span>
                                <span className="font-mono font-bold">${selectedPrice.toFixed(2)}</span>
                              </div>
                              {leverage > 1 && (
                                <div className="flex justify-between">
                                  <span className="text-text-muted">Buying Power</span>
                                  <span className="font-mono font-bold text-accent">${leverageStats.buyingPower.toFixed(2)}</span>
                                </div>
                              )}
                              <div className="flex justify-between">
                                <span className="text-text-muted">Contracts</span>
                                <span className="font-mono font-bold">{estimatedContracts.toLocaleString()}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-text-muted">Payout</span>
                                <span className="font-mono">${estimatedPayout.toFixed(2)}</span>
                              </div>
                              <div className="border-t border-border pt-1 mt-1">
                                <div className="flex justify-between">
                                  <span className="text-text-muted font-medium">Profit</span>
                                  <span className="font-mono font-bold text-long">+${estimatedProfit.toFixed(2)}</span>
                                </div>
                              </div>
                              {/* Leverage Button */}
                              <div className="border-t border-border pt-1 mt-1">
                                <button 
                                  onClick={() => setShowLeverage(true)}
                                  className={cn(
                                    'flex items-center justify-between w-full text-xs transition-colors',
                                    leverage > 1 ? 'text-accent' : 'text-text-muted hover:text-text-primary'
                                  )}
                                >
                                  <div className="flex items-center gap-1">
                                    <TrendingUp className="w-3 h-3" />
                                    <span>Leverage</span>
                                  </div>
                                  <span className={cn('font-bold', leverage > 1 && 'text-accent')}>
                                    {leverage}x {leverage > 1 && `• Liq $${leverageStats.liquidationPrice.toFixed(2)}`}
                                  </span>
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* Leverage Popup Modal */}
                          {showLeverage && (
                            <div className="fixed inset-0 z-50 flex items-center justify-center">
                              {/* Backdrop */}
                              <div 
                                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                                onClick={() => setShowLeverage(false)}
                              />
                              {/* Modal */}
                              <div className="relative bg-surface border border-border rounded-xl p-4 w-72 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                                <div className="flex items-center justify-between mb-4">
                                  <div className="flex items-center gap-2">
                                    <TrendingUp className="w-5 h-5 text-accent" />
                                    <h3 className="font-bold text-lg">Leverage</h3>
                                  </div>
                                  <button 
                                    onClick={() => setShowLeverage(false)}
                                    className="text-text-muted hover:text-text-primary"
                                  >
                                    <XCircle className="w-5 h-5" />
                                  </button>
                                </div>

                                {/* Current leverage display */}
                                <div className="text-center mb-4">
                                  <span className="text-4xl font-bold text-accent">{leverage}x</span>
                                </div>

                                {/* Slider */}
                                <input
                                  type="range"
                                  value={leverage}
                                  onChange={(e) => setLeverage(parseInt(e.target.value))}
                                  min="1"
                                  max="10"
                                  step="1"
                                  className="w-full accent-accent h-2 mb-1"
                                />
                                <div className="flex justify-between text-xs text-text-muted mb-3">
                                  <span>1x (No leverage)</span>
                                  <span>10x (Max)</span>
                                </div>

                                {/* Quick buttons */}
                                <div className="flex gap-1.5 mb-4">
                                  {[1, 2, 3, 5, 10].map((lev) => (
                                    <button
                                      key={lev}
                                      onClick={() => setLeverage(lev)}
                                      className={cn(
                                        'flex-1 py-2 text-sm rounded-lg font-bold transition-all',
                                        leverage === lev
                                          ? 'bg-accent text-background shadow-lg shadow-accent/30'
                                          : 'bg-surface-light text-text-muted hover:text-text-primary hover:bg-surface'
                                      )}
                                    >
                                      {lev}x
                                    </button>
                                  ))}
                                </div>

                                {/* Stats when leveraged */}
                                {leverage > 1 && (
                                  <div className="bg-surface-light rounded-lg p-3 space-y-2 text-sm mb-4">
                                    <div className="flex justify-between">
                                      <span className="text-text-muted">Your Margin</span>
                                      <span className="font-mono font-bold">${dollarAmountNum.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-text-muted">Borrowed</span>
                                      <span className="font-mono">${leverageStats.loanAmount.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-text-muted">Buying Power</span>
                                      <span className="font-mono font-bold text-accent">${leverageStats.buyingPower.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between items-center pt-2 border-t border-border">
                                      <span className="text-warning flex items-center gap-1">
                                        <AlertCircle className="w-3.5 h-3.5" />
                                        Liquidation
                                      </span>
                                      <span className={cn(
                                        'font-mono font-bold',
                                        selectedOutcome === 'YES' ? 'text-short' : 'text-long'
                                      )}>
                                        ${leverageStats.liquidationPrice.toFixed(3)}
                                      </span>
                                    </div>
                                  </div>
                                )}

                                {/* Warning */}
                                {leverage > 1 && (
                                  <p className="text-[10px] text-text-muted text-center mb-3">
                                    {leverage}x leverage means {leverage}x gains <em>and</em> {leverage}x losses.
                                    Position liquidates at ${leverageStats.liquidationPrice.toFixed(2)}.
                                  </p>
                                )}

                                {/* Confirm button */}
                                <button
                                  onClick={() => setShowLeverage(false)}
                                  className="w-full py-2.5 bg-accent text-background rounded-lg font-bold hover:shadow-lg hover:shadow-accent/30 transition-all"
                                >
                                  {leverage > 1 ? `Use ${leverage}x Leverage` : 'No Leverage'}
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Trade Button */}
                          {connected ? (
                            !isDelegationApproved ? (
                              <button
                                onClick={() => approveDelegation()}
                                disabled={isApproving}
                                className="w-full py-2.5 rounded-lg font-bold text-sm bg-accent text-background hover:shadow-md hover:shadow-accent/30 transition-all flex items-center justify-center gap-2"
                              >
                                {isApproving ? (
                                  <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    <span>Enabling...</span>
                                  </>
                                ) : (
                                  <>
                                    <Settings className="w-4 h-4" />
                                    <span>Delegate USDC</span>
                                  </>
                                )}
                              </button>
                            ) : (
                              <button
                                onClick={handleQuickTrade}
                                disabled={isPlacing || orderStatus === 'success' || estimatedContracts <= 0 || (orderType === 'limit' && (limitPriceNum <= 0 || limitPriceNum >= 1))}
                                className={cn(
                                  'w-full py-2.5 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2',
                                  selectedOutcome === 'YES'
                                    ? 'bg-long text-background hover:shadow-md hover:shadow-long/30'
                                    : 'bg-short text-background hover:shadow-md hover:shadow-short/30',
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
                                  `Limit @ $${limitPriceNum.toFixed(2)}`
                                ) : (
                                  `Buy ${estimatedContracts}`
                                )}
                              </button>
                            )
                          ) : (
                            <WalletButton className="!w-full !justify-center !bg-accent !text-background hover:!bg-accent-dim !rounded-lg !font-bold !h-10 !text-sm" />
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    /* Empty state - prompt to select */
                    <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
                      <div className="w-14 h-14 rounded-full bg-surface-light flex items-center justify-center mb-3">
                        <Zap className="w-7 h-7 text-text-muted" />
                      </div>
                      <h3 className="font-bold text-base mb-2">Select a Position</h3>
                      <p className="text-text-muted text-sm">
                        Click <span className="text-long font-bold">ABOVE</span> or <span className="text-short font-bold">BELOW</span> to start trading
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* BOTTOM ROW: Trade Blotter (left) + Positions (right) - SWAPPED & TALLER */}
            <div className="grid grid-cols-12 gap-2">
              {/* Trade Blotter - Left side */}
              <div className="col-span-12 lg:col-span-6 h-[280px]">
                <GlobalTradeBlotter maxTrades={25} compact />
              </div>

              {/* Positions - Right side */}
              <div className="col-span-12 lg:col-span-6 bg-surface rounded-lg border border-border overflow-hidden h-[280px] flex flex-col">
                <div className="px-3 py-1.5 bg-surface-light/30 border-b border-border flex-shrink-0">
                  <h2 className="font-bold text-xs">Positions</h2>
                </div>
                <div className="flex-1 overflow-auto">
                  <Positions 
                    onSell={(marketAddress, outcome, shares, avgEntry, price) => {
                      handleSellFromPositions(marketAddress, outcome, shares, avgEntry, price);
                    }}
                    currentMarketAddress={activeMarket?.address}
                    currentYesPrice={yesPrice}
                    currentNoPrice={noPrice}
                    compact
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </main>

    </div>
  );
}

// Compact Price Box Component - Larger and more prominent
// Price Selector Box - Full-width row layout for stacked display
function PriceSelectorBox({
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
  onAmountClick,
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
  onAmountClick?: () => void;
}) {
  const isDisabled = isLoading || isActivating;
  
  return (
    <button
      onClick={onSelect}
      disabled={isDisabled}
      className={cn(
        'relative w-full px-4 py-3 transition-all overflow-hidden btn-press',
        'flex items-center justify-between',
        isActivating && 'opacity-60 cursor-not-allowed',
        !isActivating && 'hover:bg-surface-light active:scale-[0.99]',
        isSelected && !isActivating
          ? colorClass === 'long' 
            ? 'bg-long/15' 
            : 'bg-short/15'
          : 'bg-surface',
        oneClickEnabled && !isDisabled && 'ring-inset ring-1 ring-warning/30',
        isLoading && 'opacity-75 cursor-wait'
      )}
    >
      {/* Loading indicator */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface/80 z-10">
          <Loader2 className={cn(
            'w-5 h-5 animate-spin',
            colorClass === 'long' ? 'text-long' : 'text-short'
          )} />
        </div>
      )}
      
      {/* Left: Price */}
      <div className="flex items-center gap-2">
        {isActivating ? (
          <div className="flex items-center gap-1">
            <Loader2 className="w-4 h-4 animate-spin text-text-muted" />
            <span className="text-lg text-text-muted font-mono">--</span>
          </div>
        ) : (
          <span className={cn(
            'text-2xl font-black font-mono',
            colorClass === 'long' ? 'text-long' : 'text-short'
          )}>
            ${price.toFixed(2)}
          </span>
        )}
        
        {/* Selected indicator */}
        {isSelected && !isActivating && (
          <CheckCircle className={cn(
            'w-5 h-5',
            colorClass === 'long' ? 'text-long' : 'text-short'
          )} />
        )}
      </div>

      {/* Right: Label */}
      <div className="flex items-center gap-2">
        {oneClickEnabled && !isActivating && (
          <span 
            onClick={(e) => {
              e.stopPropagation();
              onAmountClick?.();
            }}
            className="text-[10px] text-warning font-medium px-1.5 py-0.5 bg-warning/10 rounded cursor-pointer hover:bg-warning/20 transition-colors"
          >
            ⚡ ${oneClickAmount}
          </span>
        )}
        <span className={cn(
          'text-sm font-bold uppercase tracking-wide',
          colorClass === 'long' ? 'text-long' : 'text-short'
        )}>
          {label}
        </span>
        <div className={cn(
          'w-2.5 h-2.5 rounded-full',
          colorClass === 'long' ? 'bg-long' : 'bg-short'
        )} />
      </div>
    </button>
  );
}

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
        'relative px-4 py-3 rounded-lg border transition-all group overflow-hidden btn-press',
        'bg-surface flex items-center justify-between gap-3',
        isActivating && 'opacity-60 cursor-not-allowed',
        !isActivating && 'hover:bg-surface-light active:scale-[0.98]',
        isSelected && !isActivating
          ? colorClass === 'long' 
            ? 'border-long shadow-lg shadow-long/20 bg-long/5' 
            : 'border-short shadow-lg shadow-short/20 bg-short/5'
          : isActivating 
            ? 'border-accent/30'
            : 'border-border hover:border-opacity-50',
        oneClickEnabled && !isDisabled && 'ring-1 ring-warning/30 hover:ring-warning/50',
        isLoading && 'opacity-75 cursor-wait'
      )}
    >
      <div className="flex items-center gap-2">
        {/* Loading State */}
        {isLoading ? (
          <Loader2 className={cn(
            'w-4 h-4 animate-spin',
            colorClass === 'long' ? 'text-long' : 'text-short'
          )} />
        ) : isActivating ? (
          <Loader2 className="w-4 h-4 animate-spin text-text-muted" />
        ) : (
          <div className={cn(
            'w-2.5 h-2.5 rounded-full',
            colorClass === 'long' ? 'bg-long' : 'bg-short'
          )} />
        )}
        
        {/* Label */}
        <span className={cn(
          'text-sm font-bold',
          colorClass === 'long' ? 'text-long' : 'text-short'
        )}>
          {label}
        </span>
      </div>

      {/* Price */}
      <div className="flex items-center gap-2">
        {isActivating ? (
          <span className="text-base font-mono text-text-muted">--</span>
        ) : (
          <span className={cn(
            'text-xl font-bold font-mono',
            colorClass === 'long' ? 'text-long' : 'text-short'
          )}>
            ${price.toFixed(2)}
          </span>
        )}
        
        {/* One-Click indicator */}
        {oneClickEnabled && !isActivating && (
          <Zap className="w-3.5 h-3.5 text-warning" />
        )}
        
        {/* Selected indicator */}
        {isSelected && !oneClickEnabled && !isActivating && (
          <CheckCircle className={cn(
            'w-4 h-4',
            colorClass === 'long' ? 'text-long' : 'text-short'
          )} />
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
      <div className="flex items-center gap-2">
        {/* Activation display */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg font-mono transition-all bg-accent/10 text-accent border border-accent/50">
          <div className="relative w-4 h-4">
            <div className="absolute inset-0 rounded-full bg-accent/30 animate-ping" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            </div>
          </div>
          <span className="font-bold text-sm animate-pulse">
            Activating...
          </span>
        </div>
        
        {/* Animated shimmer progress bar */}
        <div className="w-24 h-2 bg-surface rounded-full overflow-hidden border border-accent/30">
          <div className="h-full w-full bg-gradient-to-r from-accent/20 via-accent to-accent/20 animate-shimmer" 
               style={{ backgroundSize: '200% 100%' }} />
        </div>
      </div>
    );
  }

  if (!timeRemaining) return null;

  return (
    <div className="flex items-center gap-2">
      {/* Compact countdown display */}
      <div className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-lg font-mono transition-all',
        timeRemaining.isExpired 
          ? 'bg-warning/20 text-warning border border-warning/50' 
          : timeRemaining.urgent 
            ? 'bg-short/20 text-short border border-short/50 animate-pulse' 
            : 'bg-surface text-text-primary border border-border'
      )}>
        <Clock className={cn(
          'transition-all',
          timeRemaining.urgent ? 'w-4 h-4 animate-bounce' : 'w-4 h-4'
        )} />
        {timeRemaining.isExpired ? (
          <span className="flex items-center gap-1.5 text-sm font-bold">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            Refreshing...
          </span>
        ) : (
          <span className={cn(
            'font-bold tabular-nums tracking-wider',
            timeRemaining.urgent ? 'text-lg' : 'text-base'
          )}>
            {timeRemaining.text}
          </span>
        )}
      </div>
      
      {/* Compact progress bar */}
      <div className="w-20 h-2 bg-surface rounded-full overflow-hidden border border-border">
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


