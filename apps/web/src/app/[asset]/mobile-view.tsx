'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useWallet } from '@solana/wallet-adapter-react';
import { Header } from '@/components/layout/Header';
import { usePrices } from '@/hooks/usePrices';
import { useMarkets } from '@/hooks/useMarkets';
import { useAuth } from '@/hooks/useAuth';
import { useQuickOrder } from '@/hooks/useOrder';
import { useDelegation } from '@/hooks/useDelegation';
import { cn } from '@/lib/utils';
import { ArrowLeft, TrendingUp, TrendingDown, RefreshCw, CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, Settings, ArrowRightLeft, AlertCircle, Clock, Monitor, Zap } from 'lucide-react';
import type { Asset, Timeframe } from '@degen/types';
import { DualMiniOrderbook } from '@/components/MiniOrderbook';
import { MarketPosition } from '@/components/trading/MarketPosition';
import { ChartV2 } from '@/components/trading/ChartV2';
import { Positions } from '@/components/trading/Positions';
import { useMarketStore } from '@/stores/marketStore';
import { WalletButton } from '@/components/WalletButton';
import { useOrderbookStore } from '@/stores/orderbookStore';
import { useOrderbook } from '@/hooks/useOrderbook';

const TIMEFRAMES: Timeframe[] = ['5m', '1h', '24h'];

interface MobileViewProps {
  asset: Asset;
  onSwitchView: () => void;
}

export function MobileView({ asset, onSwitchView }: MobileViewProps) {
  const router = useRouter();
  const { connected } = useWallet();
  const { isAuthenticated, signIn, isAuthenticating } = useAuth();
  const { selectedTimeframe, setTimeframe, setAsset } = useMarketStore();

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
  
  // Subscribe to orderbook WebSocket updates (runs regardless of orderbook panel visibility)
  // This ensures the store has live data even when DualMiniOrderbook is hidden
  useOrderbook(activeMarket?.address || null);
  
  // Get real-time orderbook prices directly from store for maximum sync with orderbook display
  const yesAsks = useOrderbookStore(state => state.yes.asks);
  const yesBids = useOrderbookStore(state => state.yes.bids);
  const yesBestAskFromStore = yesAsks[0]?.price;
  const yesBestBidFromStore = yesBids[0]?.price;
  const yesPrice = (yesBestAskFromStore && yesBestAskFromStore > 0.01 && yesBestAskFromStore < 0.99) 
    ? yesBestAskFromStore 
    : (activeMarket?.yesPrice ?? 0.50);
  // BELOW price = 1 - YES BID (because Buy NO matches YES BID)
  // This reflects actual execution cost, so ABOVE + BELOW > $1.00 with spread
  const noPrice = (yesBestBidFromStore && yesBestBidFromStore > 0.01 && yesBestBidFromStore < 0.99)
    ? 1 - yesBestBidFromStore
    : (activeMarket?.noPrice ?? 0.50);
  
  // Handle market expiry - just refetch, the next market is already pre-created
  const handleMarketExpired = useCallback((marketId: string, timeframe: string) => {
    console.log(`[MobileView] Market ${marketId} (${timeframe}) expired, switching to next market...`);
    // Refetch to get the pre-created next market
    onMarketExpired(timeframe as any, markets.length);
  }, [onMarketExpired, markets.length]);
  
  const [selectedTrade, setSelectedTrade] = useState<{
    timeframe: Timeframe;
    outcome: 'YES' | 'NO';
    price: number;
    marketAddress: string;
    marketExpiry?: number;
    mode: 'buy' | 'sell';
    shares?: number;
    avgEntry?: number;
  } | null>(null);

  const assetNames: Record<string, string> = {
    BTC: 'Bitcoin',
    ETH: 'Ethereum',
    SOL: 'Solana',
  };

  // Format price without locale to avoid hydration issues
  const formatPrice = (p: number | undefined) => {
    if (p === undefined) return '--';
    return p.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  return (
    <div className="min-h-screen bg-background bg-gradient-mesh">
      <Header />

      <main className="max-w-lg mx-auto p-4 space-y-6 pb-24">
        {/* Back button and Asset Info */}
        <div className="flex items-center justify-between animate-fade-in">
           <button 
             onClick={() => router.back()}
             className="flex items-center gap-2 text-text-muted hover:text-text-primary transition-colors text-sm font-medium btn-press"
           >
             <ArrowLeft className="w-4 h-4" />
             Back
           </button>
           <div className="flex items-center gap-3">
             <button
               onClick={onSwitchView}
               className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-muted hover:text-accent bg-surface-light rounded-lg transition-colors btn-press"
               title="Switch to Desktop View"
             >
               <Monitor className="w-3.5 h-3.5" />
               <span>Desktop</span>
             </button>
             <div className="flex items-center gap-2">
               <div className="w-7 h-7 rounded-lg bg-surface-light flex items-center justify-center font-display font-bold text-accent text-sm">
                 {asset.charAt(0)}
               </div>
               <span className="font-display font-bold">{asset}</span>
             </div>
           </div>
        </div>

        {/* Chart Section */}
        <div className="h-[350px]">
          <ChartV2 
            onPositionClick={(position) => {
              // Set up sell mode with the clicked position
              if (activeMarket) {
                setSelectedTrade({
                  timeframe: activeMarket.timeframe,
                  outcome: position.outcome.toUpperCase() as 'YES' | 'NO',
                  price: position.currentPrice,
                  marketAddress: activeMarket.address,
                  marketExpiry: activeMarket.expiry,
                  mode: 'sell',
                  shares: position.shares,
                  avgEntry: position.avgEntry,
                });
              }
            }}
          />
        </div>

        {/* Active Market Card */}
        <div className="flex flex-col space-y-4 animate-fade-in stagger-1">
          {marketsLoading && markets.length === 0 ? (
            <div className="glass-card rounded-2xl border border-border/50 p-12 text-center text-text-muted">
              <RefreshCw className="w-6 h-6 mx-auto animate-spin mb-2 text-accent" />
              Loading markets...
            </div>
          ) : !activeMarket ? (
            <div className="glass-card rounded-2xl border border-border/50 p-12 text-center text-text-muted">
              <p>No active {selectedTimeframe} market for {asset}</p>
              <button 
                onClick={() => refetch()}
                className="mt-2 text-accent hover:text-accent-dim font-bold btn-press"
              >
                Refresh
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <TimeframeCard
                market={activeMarket}
                currentPrice={currentPrice || 0}
                selectedTimeframe={selectedTimeframe}
                onTimeframeChange={setTimeframe}
                onSelectTrade={(outcome, price) => {
                  setSelectedTrade({
                    timeframe: activeMarket.timeframe,
                    outcome,
                    price,
                    marketAddress: activeMarket.address,
                    marketExpiry: activeMarket.expiry,
                    mode: 'buy',
                  });
                }}
                onExpired={() => handleMarketExpired(activeMarket.id, activeMarket.timeframe)}
              />
            </div>
          )}
        </div>

        {/* User Positions & Orders Section */}
        <div className="pt-4">
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-xl font-bold">Your Portfolio</h2>
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className="min-h-[400px]">
            <Positions 
              onSell={(marketAddress, outcome, shares, avgEntry, price, timeframe, expiry) => {
                setSelectedTrade({
                  timeframe,
                  outcome,
                  price,
                  marketAddress,
                  marketExpiry: expiry,
                  mode: 'sell',
                  shares,
                  avgEntry,
                });
              }}
              currentMarketAddress={activeMarket?.address}
              currentYesPrice={yesPrice}
              currentNoPrice={noPrice}
            />
          </div>
        </div>
      </main>

      {/* Trade Modal */}
      {selectedTrade && (
        <TradeModal
          asset={asset}
          timeframe={selectedTrade.timeframe}
          outcome={selectedTrade.outcome}
          price={selectedTrade.price}
          marketAddress={selectedTrade.marketAddress}
          marketExpiry={selectedTrade.marketExpiry}
          connected={connected}
          isAuthenticated={isAuthenticated}
          isAuthenticating={isAuthenticating}
          onSignIn={signIn}
          onClose={() => setSelectedTrade(null)}
          mode={selectedTrade.mode}
          existingShares={selectedTrade.shares}
          avgEntryPrice={selectedTrade.avgEntry}
        />
      )}
    </div>
  );
}

function TimeframeCard({ 
  market, 
  currentPrice,
  onSelectTrade,
  onExpired,
  selectedTimeframe,
  onTimeframeChange,
}: { 
  market: {
    id: string;
    address: string;
    timeframe: Timeframe;
    strike: number;
    yesPrice: number | null;
    noPrice: number | null;
    volume24h?: number;
    expiry?: number;
  };
  currentPrice: number;
  onSelectTrade: (outcome: 'YES' | 'NO', price: number) => void;
  onExpired?: () => void;
  selectedTimeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
}) {
  const isAboveStrike = currentPrice > market.strike;
  const [now, setNow] = useState(Date.now());
  const hasExpiredRef = useRef(false);
  const [showOrderbook, setShowOrderbook] = useState(false);
  
  // Check if market is pending activation (strike = 0 means waiting for activation)
  const isActivating = market.strike === 0;
  
  // Get REAL-TIME orderbook prices (WebSocket subscribed for live updates)
  const { yesBestAsk, yesBestBid } = useOrderbook(market.address);
  
  // Update time every second
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  
  // Use real-time orderbook prices, fallback to market data
  // Note: Check for valid range (0.01-0.99 is valid for binary markets)
  const yesPrice = (yesBestAsk && yesBestAsk > 0.01 && yesBestAsk < 0.99) 
    ? yesBestAsk 
    : (market.yesPrice ?? 0.50);
  // BELOW price = 1 - YES BID (because Buy NO matches YES BID)
  const noPrice = (yesBestBid && yesBestBid > 0.01 && yesBestBid < 0.99)
    ? 1 - yesBestBid
    : (market.noPrice ?? 0.50);
  
  // Check if market has expired
  const isExpired = market.expiry ? market.expiry <= now : false;
  
  // Notify parent when market expires (only once)
  useEffect(() => {
    if (isExpired && !hasExpiredRef.current && onExpired) {
      hasExpiredRef.current = true;
      onExpired();
    }
  }, [isExpired, onExpired]);
  
  // Reset expired flag if market changes (e.g., new market loaded)
  useEffect(() => {
    hasExpiredRef.current = false;
  }, [market.id]);
  
  // Calculate time remaining - only show countdown when market is activated (has strike)
  const timeRemaining = useMemo(() => {
    // Don't show countdown if market is still activating
    if (isActivating) return null;
    
    if (!market.expiry) return null;
    const diff = market.expiry - now;
    if (diff <= 0) return { text: 'Expired', percent: 0, urgent: true, isExpired: true };
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    // Calculate total duration based on timeframe
    const durations: Record<string, number> = {
      '5m': 5 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
    };
    const totalDuration = durations[market.timeframe] || 5 * 60 * 1000;
    const percent = Math.min(100, Math.max(0, (diff / totalDuration) * 100));
    const urgent = diff < 60000; // Less than 1 minute
    
    if (hours > 0) {
      return { text: `${hours}h ${minutes % 60}m`, percent, urgent, isExpired: false };
    } else if (minutes > 0) {
      return { text: `${minutes}m ${seconds % 60}s`, percent, urgent, isExpired: false };
    } else {
      return { text: `${seconds}s`, percent, urgent, isExpired: false };
    }
  }, [market.expiry, market.timeframe, now, isActivating]);
  
  return (
    <div className={cn(
      "bg-surface rounded-xl border overflow-hidden transition-all",
      isActivating ? "border-accent/50" : "border-border"
    )}>
      {/* Header */}
      <div className="px-4 py-3 bg-surface-light">
        {/* Timeframe Selector (inside market screen) */}
        <div className="flex gap-2 p-1 bg-surface rounded-xl border border-border w-fit mx-auto mb-3">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => onTimeframeChange(tf)}
              className={cn(
                "px-5 py-2 rounded-lg text-sm font-medium transition-all",
                selectedTimeframe === tf 
                  ? "bg-accent text-background shadow-lg" 
                  : "text-text-muted hover:text-text-primary hover:bg-surface-light"
              )}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold">{market.timeframe}</span>
            <span className="text-sm text-text-muted">expiry</span>
          </div>
          <div className="text-right">
            <div className="text-xs text-text-muted">Strike</div>
            {isActivating ? (
              <div className="font-mono text-accent flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span className="animate-pulse">Setting...</span>
              </div>
            ) : (
              <div className="font-mono text-warning">${market.strike.toLocaleString()}</div>
            )}
          </div>
        </div>
        
        {/* Activation Animation - shown when strike = 0 */}
        {isActivating && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-text-muted font-mono">#{market.id.slice(0, 8)}</span>
              <span className="font-medium flex items-center gap-1.5 text-accent">
                <div className="relative w-3 h-3">
                  <div className="absolute inset-0 rounded-full bg-accent/30 animate-ping" />
                  <div className="absolute inset-0 rounded-full bg-accent animate-pulse" />
                </div>
                <span className="animate-pulse">Activating market...</span>
              </span>
            </div>
            {/* Animated loading bar */}
            <div className="h-1.5 bg-surface rounded-full overflow-hidden">
              <div className="h-full w-full bg-gradient-to-r from-accent/20 via-accent to-accent/20 animate-shimmer" 
                   style={{ backgroundSize: '200% 100%' }} />
            </div>
          </div>
        )}
        
        {/* Time Remaining Bar - only show when market is activated */}
        {!isActivating && timeRemaining && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-text-muted font-mono">#{market.id.slice(0, 8)}</span>
              <span className={cn(
                'font-medium flex items-center gap-1',
                timeRemaining.isExpired 
                  ? 'text-warning' 
                  : timeRemaining.urgent 
                    ? 'text-short animate-pulse' 
                    : 'text-accent'
              )}>
                {timeRemaining.isExpired ? (
                  <>
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    <span>Refreshing...</span>
                  </>
                ) : (
                  `${timeRemaining.text} left`
                )}
              </span>
            </div>
            <div className="h-1.5 bg-surface rounded-full overflow-hidden">
              <div 
                className={cn(
                  'h-full rounded-full transition-all duration-1000',
                  timeRemaining.isExpired
                    ? 'bg-warning'
                    : timeRemaining.urgent 
                      ? 'bg-short' 
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
        )}
      </div>
      
      {/* Above/Below Strike Buttons - LARGER & MORE PROMINENT */}
      <div className="grid grid-cols-2 gap-0">
        {/* Above Strike (YES) */}
        <button
          onClick={() => !isActivating && onSelectTrade('YES', yesPrice)}
          disabled={isActivating}
          className={cn(
            "p-6 border-r border-border transition-colors group",
            isActivating 
              ? "opacity-50 cursor-not-allowed" 
              : "hover:bg-long/5 active:bg-long/10"
          )}
        >
          <div className="text-center">
            <div className={cn(
              'mb-2 inline-block px-4 py-1.5 rounded-full text-sm font-bold',
              isActivating ? 'bg-surface-light text-text-muted' : 'bg-long/20 text-long'
            )}>
              ● ABOVE
            </div>
            <div className={cn(
              "text-4xl font-bold font-mono transition-transform",
              isActivating ? "text-text-muted" : "text-long group-hover:scale-105"
            )}>
              {isActivating ? '--' : `$${yesPrice.toFixed(2)}`}
            </div>
            <div className="text-xs text-text-muted mt-2">
              {isActivating ? 'Waiting...' : market.volume24h ? `$${(market.volume24h / 2).toLocaleString()} vol` : 'Tap to trade'}
            </div>
          </div>
        </button>

        {/* Below Strike (NO) */}
        <button
          onClick={() => !isActivating && onSelectTrade('NO', noPrice)}
          disabled={isActivating}
          className={cn(
            "p-6 transition-colors group",
            isActivating 
              ? "opacity-50 cursor-not-allowed" 
              : "hover:bg-short/5 active:bg-short/10"
          )}
        >
          <div className="text-center">
            <div className={cn(
              'mb-2 inline-block px-4 py-1.5 rounded-full text-sm font-bold',
              isActivating ? 'bg-surface-light text-text-muted' : 'bg-short/20 text-short'
            )}>
              ● BELOW
            </div>
            <div className={cn(
              "text-4xl font-bold font-mono transition-transform",
              isActivating ? "text-text-muted" : "text-short group-hover:scale-105"
            )}>
              {isActivating ? '--' : `$${noPrice.toFixed(2)}`}
            </div>
            <div className="text-xs text-text-muted mt-2">
              {isActivating ? 'Waiting...' : market.volume24h ? `$${(market.volume24h / 2).toLocaleString()} vol` : 'Tap to trade'}
            </div>
          </div>
        </button>
      </div>

      {/* Current Status + Orderbook Toggle */}
      <div className="px-4 py-2 border-t border-border bg-surface-light/50 flex items-center justify-between">
        <div>
          <span className="text-xs text-text-muted">Currently </span>
          <span className={cn(
            'text-xs font-medium',
            isAboveStrike ? 'text-long' : 'text-short'
          )}>
            {isAboveStrike ? 'ABOVE' : 'BELOW'} strike
          </span>
        </div>
        <button
          onClick={() => setShowOrderbook(!showOrderbook)}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-dim transition-colors"
        >
          <span>Orderbook</span>
          {showOrderbook ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>
      
      {/* Orderbook Section */}
      {showOrderbook && (
        <div className="px-4 py-3 border-t border-border bg-surface-light/30">
          <DualMiniOrderbook marketAddress={market.address} />
        </div>
      )}
    </div>
  );
}

type OrderType = 'MARKET' | 'LIMIT';
type OrderStatus = 'idle' | 'signing' | 'submitting' | 'success' | 'error';

function TradeModal({
  asset,
  timeframe,
  outcome,
  price,
  marketAddress,
  marketExpiry,
  connected,
  isAuthenticated,
  isAuthenticating,
  onSignIn,
  onClose,
  mode = 'buy',
  existingShares,
  avgEntryPrice,
}: {
  asset: string;
  timeframe: Timeframe;
  outcome: 'YES' | 'NO';
  price: number;
  marketAddress: string;
  marketExpiry?: number;
  connected: boolean;
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  onSignIn: () => Promise<void>;
  onClose: () => void;
  mode?: 'buy' | 'sell';
  existingShares?: number;
  avgEntryPrice?: number;
}) {
  const isSellMode = mode === 'sell';
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  
  // MARKET order state
  const [dollarAmount, setDollarAmount] = useState('50');
  
  // LIMIT order state
  const [limitSize, setLimitSize] = useState('100');
  const [limitPrice, setLimitPrice] = useState(price.toFixed(2));
  
  // SELL mode state
  const [sellSize, setSellSize] = useState(existingShares?.toString() || '0');
  const maxSellSize = existingShares || 0;
  
  const [orderStatus, setOrderStatus] = useState<OrderStatus>('idle');
  const [orderResult, setOrderResult] = useState<{
    orderId?: string;
    status?: string;
    filledSize?: number;
    errorMessage?: string;
  } | null>(null);
  
  // Use the order hook
  const { placeOrder, isPlacing, error: orderError, clearError } = useQuickOrder();
  
  // Use delegation hook for MARKET orders
  const { isApproved: isDelegationApproved, isApproving, approve: approveDelegation, delegatedAmount } = useDelegation();
  
  // Calculate MARKET order estimates
  const dollarAmountNum = parseFloat(dollarAmount) || 0;
  // Market orders walk the book until filled - no price limit
  const maxPrice = 0.99;
  const estimatedContracts = dollarAmountNum > 0 ? Math.floor(dollarAmountNum / price) : 0;
  const estimatedPayout = estimatedContracts * 1.0;
  const estimatedProfit = estimatedPayout - dollarAmountNum;
  
  // LIMIT order calculations
  const limitSizeNum = parseInt(limitSize) || 0;
  const limitPriceNum = parseFloat(limitPrice) || 0;
  const limitCost = limitPriceNum * limitSizeNum;
  const limitPayout = limitSizeNum * 1.0;
  const limitProfit = limitPayout - limitCost;
  
  // Delegation validation
  const delegatedAmountDollars = delegatedAmount / 1_000_000;
  const takerFeeBps = 20;
  const feeMultiplier = 1 + (takerFeeBps / 10000);
  const totalCostWithFee = (orderType === 'MARKET' ? dollarAmountNum : limitCost) * feeMultiplier;
  const isDelegationInsufficient = isDelegationApproved && !isSellMode && totalCostWithFee > delegatedAmountDollars;

  // Validate limit price (must be between 0.01 and 0.99)
  const isValidLimitPrice = limitPriceNum >= 0.01 && limitPriceNum <= 0.99;
  
  // SELL mode calculations
  const sellSizeNum = parseFloat(sellSize) || 0;
  const sellProceeds = sellSizeNum * price;
  const sellCostBasis = sellSizeNum * (avgEntryPrice || 0);
  const sellProfit = sellProceeds - sellCostBasis;
  
  // Validation
  const canSubmitMarket = dollarAmountNum > 0 && estimatedContracts > 0 && orderStatus !== 'success' && !isDelegationInsufficient;
  const canSubmitLimit = limitSizeNum > 0 && isValidLimitPrice && orderStatus !== 'success' && !isDelegationInsufficient;
  const canSubmitSell = sellSizeNum > 0 && sellSizeNum <= maxSellSize && orderStatus !== 'success';
  const canSubmit = isSellMode ? canSubmitSell : (orderType === 'MARKET' ? canSubmitMarket : canSubmitLimit);
  
  // Sync order error to local state
  useEffect(() => {
    if (orderError) {
      setOrderStatus('error');
      setOrderResult({ errorMessage: orderError });
    }
  }, [orderError]);

  const handleSubmit = async () => {
    if (!connected || !canSubmit) return;
    
    clearError();
    setOrderResult(null);
    setOrderStatus('signing');

    console.log('[TradeModal] Placing order:', { 
      marketAddress, 
      outcome, 
      orderType,
      mode,
      ...(isSellMode
        ? { sellSize: sellSizeNum, price }
        : orderType === 'MARKET' 
          ? { dollarAmount: dollarAmountNum, maxPrice, estimatedContracts }
          : { price: limitPriceNum, size: limitSizeNum }
      )
    });

    setOrderStatus('submitting');
    
    const now = Math.floor(Date.now() / 1000);
    const defaultExpiry = now + 3600;
    const expiryTimestamp = marketExpiry 
      ? Math.min(Math.floor(marketExpiry / 1000) - 60, defaultExpiry)
      : defaultExpiry;

    const result = await placeOrder({
      marketAddress,
      side: isSellMode ? 'ask' : 'bid',
      outcome: outcome.toLowerCase() as 'yes' | 'no',
      orderType: isSellMode ? 'market' : orderType.toLowerCase() as 'limit' | 'market',
      // For MARKET sells, use minPrice: 0.01 to guarantee fill against bids
      // Similar to how market buys use maxPrice: 0.99
      price: isSellMode ? 0.01 : (orderType === 'MARKET' ? price : limitPriceNum),
      size: isSellMode ? sellSizeNum : (orderType === 'MARKET' ? estimatedContracts : limitSizeNum),
      expiryTimestamp,
      dollarAmount: (!isSellMode && orderType === 'MARKET') ? dollarAmountNum : undefined,
      maxPrice: (!isSellMode && orderType === 'MARKET') ? maxPrice : undefined,
    });

    if (result) {
      setOrderStatus('success');
      setOrderResult({
        orderId: result.orderId,
        status: result.status,
        filledSize: result.filledSize,
      });
      
      setTimeout(() => {
        onClose();
      }, 2000);
    } else {
      setOrderStatus('error');
      setOrderResult({ errorMessage: orderError || 'Order failed' });
    }
  };
  
  const handleResetAndRetry = () => {
    setOrderStatus('idle');
    setOrderResult(null);
    clearError();
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-end justify-center z-50" onClick={onClose}>
      <div 
        className="bg-surface w-full max-w-lg rounded-t-2xl p-4 animate-in slide-in-from-bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">
            {isSellMode ? (
              <span className="flex items-center gap-2">
                <ArrowRightLeft className="w-4 h-4 text-warning" />
                Sell {outcome === 'YES' ? 'ABOVE' : 'BELOW'}
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Zap className={cn("w-4 h-4", outcome === 'YES' ? 'text-long' : 'text-short')} />
                Trade
              </span>
            )}
          </h2>
          <span className={cn(
            'px-2 py-1 rounded text-sm font-bold',
            outcome === 'YES' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
          )}>
            {outcome === 'YES' ? 'ABOVE' : 'BELOW'}
          </span>
        </div>

        <div className="space-y-3">
          {/* Order Type Toggle - only for buy mode */}
          {!isSellMode && (
            <div className="flex rounded-lg bg-surface-light p-0.5">
              <button
                onClick={() => setOrderType('MARKET')}
                className={cn(
                  'flex-1 py-1.5 px-3 rounded-md text-sm font-bold transition-all',
                  orderType === 'MARKET'
                    ? 'bg-accent text-background shadow-sm'
                    : 'text-text-muted hover:text-text-primary'
                )}
              >
                Market
              </button>
              <button
                onClick={() => setOrderType('LIMIT')}
                className={cn(
                  'flex-1 py-1.5 px-3 rounded-md text-sm font-bold transition-all',
                  orderType === 'LIMIT'
                    ? 'bg-accent text-background shadow-sm'
                    : 'text-text-muted hover:text-text-primary'
                )}
              >
                Limit
              </button>
            </div>
          )}

          {/* SELL Mode UI - Compact */}
          {isSellMode && (
            <>
              <div>
                <label className="block text-xs text-text-muted mb-1">
                  Shares to Sell (max {maxSellSize.toFixed(0)})
                </label>
                <input
                  type="number"
                  value={sellSize}
                  onChange={(e) => setSellSize(e.target.value)}
                  min="0"
                  max={maxSellSize}
                  step="1"
                  className="w-full bg-surface-light border border-border rounded-lg px-4 py-2.5 font-mono text-lg text-center focus:border-warning focus:ring-1 focus:ring-warning"
                />
                <div className="flex gap-1.5 mt-1.5">
                  {[0.25, 0.5, 0.75, 1].map((pct) => (
                    <button
                      key={pct}
                      onClick={() => setSellSize((maxSellSize * pct).toFixed(0))}
                      className={cn(
                        'flex-1 py-1.5 text-sm font-bold rounded-lg transition-colors',
                        Math.abs(sellSizeNum - maxSellSize * pct) < 0.5
                          ? 'bg-warning/20 text-warning'
                          : 'bg-surface-light text-text-muted hover:text-text-primary'
                      )}
                    >
                      {pct === 1 ? 'Max' : `${pct * 100}%`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Sell Summary - Compact */}
              <div className="space-y-1.5 p-3 bg-surface-light rounded-lg text-sm">
                <div className="flex justify-between">
                  <span className="text-text-muted">Shares</span>
                  <span className="font-mono font-bold">{sellSizeNum.toFixed(0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Price</span>
                  <span className="font-mono">${price.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Proceeds</span>
                  <span className="font-mono">${sellProceeds.toFixed(2)}</span>
                </div>
                <div className="flex justify-between pt-1.5 border-t border-border">
                  <span className="text-text-muted">P&L</span>
                  <span className={cn(
                    'font-mono font-bold',
                    sellProfit >= 0 ? 'text-long' : 'text-short'
                  )}>
                    {sellProfit >= 0 ? '+' : ''}${Math.abs(sellProfit).toFixed(2)}
                  </span>
                </div>
              </div>
            </>
          )}

          {/* Limit Price Input (only for limit orders in buy mode) */}
          {!isSellMode && orderType === 'LIMIT' && (
            <div>
              <label className="block text-xs text-text-muted mb-1">Limit Price</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-lg">$</span>
                <input
                  type="number"
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  min="0.01"
                  max="0.99"
                  step="0.01"
                  className={cn(
                    'w-full bg-surface-light border rounded-lg pl-8 pr-4 py-2.5 font-mono text-lg text-center focus:ring-1',
                    isValidLimitPrice 
                      ? 'border-border focus:border-accent focus:ring-accent' 
                      : 'border-short focus:border-short focus:ring-short'
                  )}
                />
              </div>
              <div className="flex gap-1.5 mt-1.5">
                {[0.10, 0.25, 0.50, 0.75, 0.90].map((preset) => (
                  <button
                    key={preset}
                    onClick={() => setLimitPrice(preset.toFixed(2))}
                    className={cn(
                      'flex-1 py-1.5 text-xs rounded-lg transition-colors font-mono font-bold',
                      parseFloat(limitPrice) === preset
                        ? 'bg-accent/20 text-accent'
                        : 'bg-surface-light text-text-muted hover:text-text-primary'
                    )}
                  >
                    ${preset.toFixed(2)}
                  </button>
                ))}
              </div>
              {!isValidLimitPrice && limitPrice && (
                <p className="text-[10px] text-short mt-1">Price must be between $0.01 and $0.99</p>
              )}
            </div>
          )}

          {/* MARKET Order: Dollar Amount Input (buy mode only) */}
          {!isSellMode && orderType === 'MARKET' && (
            <>
              <div>
                <label className="block text-xs text-text-muted mb-1">Amount</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-lg">$</span>
                  <input
                    type="number"
                    value={dollarAmount}
                    onChange={(e) => setDollarAmount(e.target.value)}
                    min="1"
                    className="w-full bg-surface-light border border-border rounded-lg pl-8 pr-4 py-2.5 font-mono text-lg text-center focus:border-accent focus:ring-1 focus:ring-accent"
                  />
                </div>
                <div className="flex gap-1.5 mt-1.5">
                  {[25, 50, 100, 250].map((preset) => (
                    <button
                      key={preset}
                      onClick={() => setDollarAmount(preset.toString())}
                      className={cn(
                        'flex-1 py-1.5 text-sm font-bold rounded-lg transition-colors',
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

              {/* MARKET Summary - Compact */}
              <div className="space-y-1.5 p-3 bg-surface-light rounded-lg text-sm">
                <div className="flex justify-between">
                  <span className="text-text-muted">Price</span>
                  <span className="font-mono font-bold">${price.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Contracts</span>
                  <span className="font-mono font-bold">{estimatedContracts.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Payout</span>
                  <span className="font-mono">${estimatedPayout.toFixed(2)}</span>
                </div>
                <div className="flex justify-between pt-1.5 border-t border-border">
                  <span className="text-text-muted">Profit</span>
                  <span className="font-mono font-bold text-long">+${estimatedProfit.toFixed(2)}</span>
                </div>
              </div>
            </>
          )}

          {/* LIMIT Order: Contracts Input (buy mode only) */}
          {!isSellMode && orderType === 'LIMIT' && (
            <>
              <div>
                <label className="block text-xs text-text-muted mb-1">Contracts</label>
                <input
                  type="number"
                  value={limitSize}
                  onChange={(e) => setLimitSize(e.target.value)}
                  min="1"
                  className="w-full bg-surface-light border border-border rounded-lg px-4 py-2.5 font-mono text-lg text-center focus:border-accent focus:ring-1 focus:ring-accent"
                />
                <div className="flex gap-1.5 mt-1.5">
                  {[10, 50, 100, 500, 1000].map((preset) => (
                    <button
                      key={preset}
                      onClick={() => setLimitSize(preset.toString())}
                      className={cn(
                        'flex-1 py-1.5 text-xs font-bold rounded-lg transition-colors',
                        parseInt(limitSize) === preset
                          ? 'bg-accent/20 text-accent'
                          : 'bg-surface-light text-text-muted hover:text-text-primary'
                      )}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              {/* LIMIT Summary - Compact */}
              <div className="space-y-1.5 p-3 bg-surface-light rounded-lg text-sm">
                <div className="flex justify-between">
                  <span className="text-text-muted">Cost</span>
                  <span className="font-mono">${limitCost.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Payout</span>
                  <span className="font-mono">${limitPayout.toFixed(2)}</span>
                </div>
                <div className="flex justify-between pt-1.5 border-t border-border">
                  <span className="text-text-muted">Profit</span>
                  <span className="font-mono font-bold text-long">+${limitProfit.toFixed(2)}</span>
                </div>
              </div>
            </>
          )}

          {/* Order Status Feedback - Compact */}
          {orderStatus === 'success' && orderResult && (
            <div className="flex items-center gap-2 p-2.5 bg-long/10 border border-long/30 rounded-lg">
              <CheckCircle className="w-5 h-5 text-long flex-shrink-0" />
              <div className="flex-1">
                <div className="text-sm font-semibold text-long">Order Placed!</div>
                <div className="text-xs text-text-muted">
                  {orderResult.status === 'filled' 
                    ? `Filled ${orderResult.filledSize} contracts`
                    : orderResult.status === 'partial'
                      ? `Partially filled ${orderResult.filledSize} contracts`
                      : 'Order added to orderbook'
                  }
                </div>
              </div>
            </div>
          )}
          
          {orderStatus === 'error' && orderResult?.errorMessage && (
            <div className="flex items-center gap-2 p-2.5 bg-short/10 border border-short/30 rounded-lg">
              <XCircle className="w-5 h-5 text-short flex-shrink-0" />
              <div className="flex-1">
                <div className="text-sm font-semibold text-short">Failed</div>
                <div className="text-xs text-text-muted">{orderResult.errorMessage}</div>
              </div>
              <button onClick={handleResetAndRetry} className="text-xs text-accent hover:text-accent-dim">Retry</button>
            </div>
          )}

          {isDelegationInsufficient && !isSellMode && (
            <div className="flex items-center gap-2 p-2.5 bg-short/10 border border-short/30 rounded-lg text-xs text-short font-medium">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <div className="flex-1">
                Need ${totalCostWithFee.toFixed(2)} · Have ${delegatedAmountDollars.toFixed(2)}
              </div>
              <button
                onClick={() => approveDelegation(Math.max(10000 * 1_000_000, totalCostWithFee * 2 * 1_000_000))}
                className="bg-short text-background px-2 py-1 rounded font-bold text-[10px]"
              >
                Top Up
              </button>
            </div>
          )}

          {/* Submit Button - Prominent */}
          {connected ? (
            !isDelegationApproved && !isSellMode ? (
              <button
                onClick={() => approveDelegation()}
                disabled={isApproving}
                className="w-full py-3.5 rounded-xl font-bold text-base bg-accent text-background transition-all flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-accent/30"
              >
                {isApproving ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /><span>Delegating...</span></>
                ) : (
                  <><Settings className="w-4 h-4" /><span>Delegate USDC to Trade</span></>
                )}
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={isPlacing || isAuthenticating || !canSubmit || orderStatus === 'success'}
                className={cn(
                  'w-full py-3.5 rounded-xl font-bold text-base transition-all flex items-center justify-center gap-2',
                  isSellMode
                    ? 'bg-warning text-background hover:shadow-lg hover:shadow-warning/30'
                    : outcome === 'YES'
                      ? 'bg-long text-background hover:shadow-lg hover:shadow-long/30'
                      : 'bg-short text-background hover:shadow-lg hover:shadow-short/30',
                  (isPlacing || isAuthenticating || !canSubmit || orderStatus === 'success') && 'opacity-50 cursor-not-allowed'
                )}
              >
                {orderStatus === 'signing' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /><span>Sign in wallet...</span></>
                ) : orderStatus === 'submitting' || isPlacing ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /><span>Placing...</span></>
                ) : orderStatus === 'success' ? (
                  <><CheckCircle className="w-4 h-4" /><span>Done!</span></>
                ) : isAuthenticating ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /><span>Signing in...</span></>
                ) : isSellMode ? (
                  `Sell ${sellSizeNum.toFixed(0)} → $${sellProceeds.toFixed(2)}`
                ) : orderType === 'MARKET' ? (
                  `Buy ${estimatedContracts}`
                ) : (
                  `Buy ${limitSizeNum} @ $${limitPriceNum.toFixed(2)}`
                )}
              </button>
            )
          ) : (
            <WalletButton className="!w-full !justify-center !bg-accent !text-background hover:!bg-accent-dim !rounded-xl !font-bold !h-12 !text-base" />
          )}
        </div>
      </div>
    </div>
  );
}

