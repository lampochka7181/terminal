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
import { ArrowLeft, TrendingUp, TrendingDown, RefreshCw, CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, Settings, ArrowRightLeft, AlertCircle } from 'lucide-react';
import type { Asset, Timeframe } from '@degen/types';
import { DualMiniOrderbook } from '@/components/MiniOrderbook';
import { MarketPosition } from '@/components/trading/MarketPosition';

const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h', '4h'];

export default function MarketPage() {
  const params = useParams();
  const router = useRouter();
  const { connected } = useWallet();
  const { isAuthenticated, signIn, isAuthenticating } = useAuth();
  
  const asset = (params.asset as string)?.toUpperCase() as Asset || 'BTC';
  
  // Use usePrices to set up WebSocket subscription for live updates
  const { prices, loading: pricesLoading } = usePrices();
  const currentPrice = prices[asset];
  
  // Fetch markets for this asset
  const { markets, loading: marketsLoading, refetch, onMarketExpired } = useMarkets({ 
    asset, 
    status: 'OPEN' 
  });
  
  // Handle market expiry - just refetch, the next market is already pre-created
  const handleMarketExpired = useCallback((marketId: string, timeframe: string) => {
    console.log(`[MarketPage] Market ${marketId} (${timeframe}) expired, switching to next market...`);
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
    shares?: number;      // For sell mode: how many shares to sell
    avgEntry?: number;    // For sell mode: average entry price
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
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-lg mx-auto p-4 space-y-4">
        {/* Back button and Asset Info */}
        <div className="flex items-center justify-between mb-2">
           <button 
             onClick={() => router.back()}
             className="flex items-center gap-2 text-text-muted hover:text-text-primary transition-colors text-sm font-medium"
           >
             <ArrowLeft className="w-4 h-4" />
             Back to Markets
           </button>
           <div className="flex items-center gap-2">
             <div className="w-6 h-6 rounded-full bg-surface-light flex items-center justify-center font-bold text-accent text-xs">
               {asset.charAt(0)}
             </div>
             <span className="font-bold">{asset}</span>
           </div>
        </div>

        {/* Current Price Banner */}
        <div className="bg-surface rounded-xl border border-border p-4 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <span>Current Price</span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-long animate-pulse" />
                <span className="text-xs text-long">LIVE</span>
              </span>
            </div>
            <div className="text-2xl font-bold font-mono" suppressHydrationWarning>
              {pricesLoading && !currentPrice ? (
                <span className="text-text-muted">Loading...</span>
              ) : (
                `$${formatPrice(currentPrice)}`
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-text-muted">Price Feed</div>
            <div className="text-sm text-accent">Binance</div>
          </div>
        </div>

        {/* Timeframe Cards */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Select Timeframe</h2>
            {marketsLoading && (
              <RefreshCw className="w-4 h-4 text-text-muted animate-spin" />
            )}
          </div>
          
          {marketsLoading && markets.length === 0 ? (
            <div className="text-center py-12 text-text-muted">
              <RefreshCw className="w-6 h-6 mx-auto animate-spin mb-2" />
              Loading markets...
            </div>
          ) : markets.length === 0 ? (
            <div className="text-center py-12 text-text-muted">
              <p>No active markets for {asset}</p>
              <button 
                onClick={() => refetch()}
                className="mt-2 text-accent hover:text-accent-dim"
              >
                Refresh
              </button>
            </div>
          ) : (
            markets.map((market) => (
              <div key={market.id} className="space-y-2">
                {/* User Position for this market */}
                {isAuthenticated && (
                  <MarketPosition
                    marketAddress={market.address}
                    currentYesPrice={market.yesPrice ?? 0.5}
                    currentNoPrice={market.noPrice ?? 0.5}
                    onSell={(outcome, shares, avgEntry) => {
                      setSelectedTrade({
                        timeframe: market.timeframe,
                        outcome,
                        price: outcome === 'YES' ? (market.yesPrice ?? 0.5) : (market.noPrice ?? 0.5),
                        marketAddress: market.address,
                        marketExpiry: market.expiry,
                        mode: 'sell',
                        shares,
                        avgEntry,
                      });
                    }}
                  />
                )}
                
                {/* Market Card */}
                <TimeframeCard
                  market={market}
                  currentPrice={currentPrice || 0}
                  onSelectTrade={(outcome, price) => {
                    setSelectedTrade({
                      timeframe: market.timeframe,
                      outcome,
                      price,
                      marketAddress: market.address,
                      marketExpiry: market.expiry,
                      mode: 'buy',
                    });
                  }}
                  onExpired={() => handleMarketExpired(market.id, market.timeframe)}
                />
              </div>
            ))
          )}
        </div>

        {/* Info */}
        <div className="text-center text-sm text-text-muted py-4">
          <p>Prices show probability of {asset} being above or below strike at expiry</p>
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
}) {
  const isAboveStrike = currentPrice > market.strike;
  const [now, setNow] = useState(Date.now());
  const hasExpiredRef = useRef(false);
  const [showOrderbook, setShowOrderbook] = useState(false);
  
  // Update time every second
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  
  // Default to 0.50 if no price data (50% probability)
  const yesPrice = market.yesPrice ?? 0.50;
  const noPrice = market.noPrice ?? 0.50;
  
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
  
  // Calculate time remaining
  const timeRemaining = useMemo(() => {
    if (!market.expiry) return null;
    const diff = market.expiry - now;
    if (diff <= 0) return { text: 'Expired', percent: 0, urgent: true, isExpired: true };
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    // Calculate total duration based on timeframe
    const durations: Record<string, number> = {
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
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
  }, [market.expiry, market.timeframe, now]);
  
  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-surface-light">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold">{market.timeframe}</span>
            <span className="text-sm text-text-muted">expiry</span>
          </div>
          <div className="text-right">
            <div className="text-xs text-text-muted">Strike</div>
            <div className="font-mono text-warning">${market.strike.toLocaleString()}</div>
          </div>
        </div>
        
        {/* Time Remaining Bar */}
        {timeRemaining && (
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
      
      {/* Above/Below Strike Buttons */}
      <div className="grid grid-cols-2 gap-0">
        {/* Above Strike (YES) */}
        <button
          onClick={() => onSelectTrade('YES', yesPrice)}
          className="p-4 border-r border-border hover:bg-long/5 transition-colors group"
        >
          <div className="text-center">
            <div className="text-3xl font-bold font-mono text-long group-hover:scale-105 transition-transform">
              ${yesPrice.toFixed(2)}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {market.volume24h ? `$${(market.volume24h / 2).toLocaleString()} vol` : 'No volume'}
            </div>
            <div className={cn(
              'mt-2 inline-block px-3 py-1 rounded-full text-sm font-bold',
              'bg-long/20 text-long'
            )}>
              ABOVE STRIKE
            </div>
          </div>
        </button>

        {/* Below Strike (NO) */}
        <button
          onClick={() => onSelectTrade('NO', noPrice)}
          className="p-4 hover:bg-short/5 transition-colors group"
        >
          <div className="text-center">
            <div className="text-3xl font-bold font-mono text-short group-hover:scale-105 transition-transform">
              ${noPrice.toFixed(2)}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {market.volume24h ? `$${(market.volume24h / 2).toLocaleString()} vol` : 'No volume'}
            </div>
            <div className={cn(
              'mt-2 inline-block px-3 py-1 rounded-full text-sm font-bold',
              'bg-short/20 text-short'
            )}>
              BELOW STRIKE
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
  const [priceProtection, setPriceProtection] = useState('0.10');
  const [showAdvanced, setShowAdvanced] = useState(false);
  
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
  const priceProtectionNum = parseFloat(priceProtection) || 0.10;
  const maxPrice = Math.min(0.99, price + priceProtectionNum);
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
  const takerFeeBps = 20; // Should ideally come from API, but 20bps is current config
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
    
    // Clear any previous errors
    clearError();
    setOrderResult(null);
    setOrderStatus('signing');

    // Auto sign-in handled by useQuickOrder
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
    
    // Calculate expiry timestamp (use market expiry - 60s, or 1 hour from now)
    const now = Math.floor(Date.now() / 1000);
    const defaultExpiry = now + 3600; // 1 hour
    const expiryTimestamp = marketExpiry 
      ? Math.min(Math.floor(marketExpiry / 1000) - 60, defaultExpiry)
      : defaultExpiry;

    const result = await placeOrder({
      marketAddress,
      side: isSellMode ? 'ask' : 'bid', // ASK for selling, BID for buying
      outcome: outcome.toLowerCase() as 'yes' | 'no',
      orderType: isSellMode ? 'market' : orderType.toLowerCase() as 'limit' | 'market',
      price: isSellMode ? price : (orderType === 'MARKET' ? price : limitPriceNum),
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
      
      // Auto close after success
      setTimeout(() => {
        onClose();
      }, 2000);
    } else {
      setOrderStatus('error');
      setOrderResult({ errorMessage: orderError || 'Order failed' });
    }
  };
  
  // Reset error state when user changes inputs
  const handleResetAndRetry = () => {
    setOrderStatus('idle');
    setOrderResult(null);
    clearError();
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-end justify-center z-50" onClick={onClose}>
      <div 
        className="bg-surface w-full max-w-lg rounded-t-2xl p-6 animate-in slide-in-from-bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold">
            {isSellMode ? (
              <span className="flex items-center gap-2">
                <ArrowRightLeft className="w-5 h-5 text-warning" />
                Sell {outcome === 'YES' ? 'ABOVE' : 'BELOW'}
              </span>
            ) : (
              `Buy ${outcome === 'YES' ? 'ABOVE STRIKE' : 'BELOW STRIKE'}`
            )}
          </h2>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-surface-light rounded-lg transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          {/* Order Type Toggle - only for buy mode */}
          {!isSellMode && (
            <div className="flex rounded-lg bg-surface-light p-1">
              <button
                onClick={() => setOrderType('MARKET')}
                className={cn(
                  'flex-1 py-2 px-4 rounded-md text-sm font-medium transition-all',
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
                  'flex-1 py-2 px-4 rounded-md text-sm font-medium transition-all',
                  orderType === 'LIMIT'
                    ? 'bg-accent text-background shadow-sm'
                    : 'text-text-muted hover:text-text-primary'
                )}
              >
                Limit
              </button>
            </div>
          )}

          {/* Market Info */}
          <div className="flex items-center justify-between p-3 bg-surface-light rounded-lg">
            <span className="text-text-muted">{asset} {timeframe}</span>
            <span className={cn(
              'px-2 py-1 rounded text-sm font-bold',
              outcome === 'YES' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
            )}>
              {outcome === 'YES' ? 'ABOVE' : 'BELOW'} @ ${price.toFixed(2)}
            </span>
          </div>

          {/* SELL Mode UI */}
          {isSellMode && (
            <>
              <div>
                <label className="block text-sm text-text-muted mb-2">
                  Shares to Sell (max {maxSellSize.toFixed(2)})
                </label>
                <input
                  type="number"
                  value={sellSize}
                  onChange={(e) => setSellSize(e.target.value)}
                  min="0"
                  max={maxSellSize}
                  step="0.01"
                  className="w-full bg-surface-light border border-border rounded-lg px-4 py-3 font-mono text-xl text-center focus:border-accent focus:ring-1 focus:ring-accent"
                />
                <div className="flex gap-2 mt-2">
                  {[0.25, 0.5, 0.75, 1].map((pct) => (
                    <button
                      key={pct}
                      onClick={() => setSellSize((maxSellSize * pct).toFixed(2))}
                      className={cn(
                        'flex-1 py-2 text-sm rounded-lg transition-colors',
                        sellSizeNum === maxSellSize * pct
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
              <div className="space-y-2 p-4 bg-surface-light rounded-lg">
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Shares to Sell</span>
                  <span className="font-mono font-bold">{sellSizeNum.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Market Price</span>
                  <span className="font-mono">${price.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Est. Proceeds</span>
                  <span className="font-mono">${sellProceeds.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm pt-2 border-t border-border">
                  <span className="text-text-muted">Avg Entry</span>
                  <span className="font-mono">${avgEntryPrice?.toFixed(2) || '0.00'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Est. P&L</span>
                  <span className={cn(
                    'font-mono font-bold',
                    sellProfit >= 0 ? 'text-long' : 'text-short'
                  )}>
                    {sellProfit >= 0 ? '+' : ''}{sellProfit.toFixed(2)}
                  </span>
                </div>
              </div>
            </>
          )}

          {/* Limit Price Input (only for limit orders in buy mode) */}
          {!isSellMode && orderType === 'LIMIT' && (
            <div>
              <label className="block text-sm text-text-muted mb-2">Limit Price</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted text-xl">$</span>
                <input
                  type="number"
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  min="0.01"
                  max="0.99"
                  step="0.01"
                  className={cn(
                    'w-full bg-surface-light border rounded-lg pl-8 pr-4 py-3 font-mono text-xl text-center focus:ring-1',
                    isValidLimitPrice 
                      ? 'border-border focus:border-accent focus:ring-accent' 
                      : 'border-short focus:border-short focus:ring-short'
                  )}
                />
              </div>
              <div className="flex gap-2 mt-2">
                {[0.10, 0.25, 0.50, 0.75, 0.90].map((preset) => (
                  <button
                    key={preset}
                    onClick={() => setLimitPrice(preset.toFixed(2))}
                    className={cn(
                      'flex-1 py-2 text-sm rounded-lg transition-colors font-mono',
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
                <p className="text-xs text-short mt-1">Price must be between $0.01 and $0.99</p>
              )}
              {orderType === 'LIMIT' && isValidLimitPrice && limitPriceNum < price && (
                <p className="text-xs text-warning mt-1">
                  Your limit price is below market. Order will wait to fill.
                </p>
              )}
            </div>
          )}

          {/* MARKET Order: Dollar Amount Input (buy mode only) */}
          {!isSellMode && orderType === 'MARKET' && (
            <>
              <div>
                <label className="block text-sm text-text-muted mb-2">Amount to Spend</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted text-xl">$</span>
                  <input
                    type="number"
                    value={dollarAmount}
                    onChange={(e) => setDollarAmount(e.target.value)}
                    min="1"
                    className="w-full bg-surface-light border border-border rounded-lg pl-10 pr-16 py-3 font-mono text-xl text-center focus:border-accent focus:ring-1 focus:ring-accent"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-text-muted text-sm">USDC</span>
                </div>
                <div className="flex gap-2 mt-2">
                  {[25, 50, 100, 250, 500].map((preset) => (
                    <button
                      key={preset}
                      onClick={() => setDollarAmount(preset.toString())}
                      className={cn(
                        'flex-1 py-2 text-sm rounded-lg transition-colors',
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

              {/* Price Protection */}
              <div>
                <button 
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary mb-2"
                >
                  <Settings className="w-3 h-3" />
                  {showAdvanced ? 'Hide' : 'Show'} Price Protection
                </button>
                
                {showAdvanced && (
                  <div className="bg-surface-light rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-text-muted">Max Slippage</span>
                      <span className="text-sm font-mono">${priceProtection}</span>
                    </div>
                    <input
                      type="range"
                      value={parseFloat(priceProtection) * 100}
                      onChange={(e) => setPriceProtection((parseInt(e.target.value) / 100).toFixed(2))}
                      min="1"
                      max="25"
                      className="w-full accent-accent"
                    />
                    <div className="flex justify-between text-xs text-text-muted mt-1">
                      <span>$0.01</span>
                      <span>$0.25</span>
                    </div>
                    <div className="mt-2 text-xs text-text-muted">
                      Current: ${price.toFixed(2)} → Max: ${maxPrice.toFixed(2)}
                    </div>
                  </div>
                )}
              </div>

              {/* MARKET Summary */}
              <div className="space-y-2 p-4 bg-surface-light rounded-lg">
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Est. Contracts</span>
                  <span className="font-mono font-bold">{estimatedContracts.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Avg Price</span>
                  <span className="font-mono">${price.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Max Payout</span>
                  <span className="font-mono">${estimatedPayout.toFixed(2)}</span>
                </div>
                <div className="flex justify-between pt-2 border-t border-border">
                  <span className="text-text-muted">Est. Profit</span>
                  <span className="font-mono font-bold text-long">+${estimatedProfit.toFixed(2)}</span>
                </div>
              </div>
            </>
          )}

          {/* LIMIT Order: Contracts Input (buy mode only) */}
          {!isSellMode && orderType === 'LIMIT' && (
            <>
              <div>
                <label className="block text-sm text-text-muted mb-2">Contracts</label>
                <input
                  type="number"
                  value={limitSize}
                  onChange={(e) => setLimitSize(e.target.value)}
                  min="1"
                  className="w-full bg-surface-light border border-border rounded-lg px-4 py-3 font-mono text-xl text-center focus:border-accent focus:ring-1 focus:ring-accent"
                />
                <div className="flex gap-2 mt-2">
                  {[10, 50, 100, 500, 1000].map((preset) => (
                    <button
                      key={preset}
                      onClick={() => setLimitSize(preset.toString())}
                      className={cn(
                        'flex-1 py-2 text-sm rounded-lg transition-colors',
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

              {/* LIMIT Summary */}
              <div className="space-y-2 p-4 bg-surface-light rounded-lg">
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Cost</span>
                  <span className="font-mono">${limitCost.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Max Payout</span>
                  <span className="font-mono">${limitPayout.toFixed(2)}</span>
                </div>
                <div className="flex justify-between pt-2 border-t border-border">
                  <span className="text-text-muted">Max Profit</span>
                  <span className="font-mono font-bold text-long">+${limitProfit.toFixed(2)}</span>
                </div>
                <div className="text-xs text-text-muted pt-2 border-t border-border">
                  Limit orders stay open until filled, cancelled, or market closes
                </div>
              </div>
            </>
          )}

          {/* Order Status Feedback */}
          {orderStatus === 'success' && orderResult && (
            <div className="flex items-center gap-3 p-4 bg-long/10 border border-long/30 rounded-xl">
              <CheckCircle className="w-6 h-6 text-long flex-shrink-0" />
              <div className="flex-1">
                <div className="font-semibold text-long">Order Placed!</div>
                <div className="text-sm text-text-muted">
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
            <div className="flex items-center gap-3 p-4 bg-short/10 border border-short/30 rounded-xl">
              <XCircle className="w-6 h-6 text-short flex-shrink-0" />
              <div className="flex-1">
                <div className="font-semibold text-short">Order Failed</div>
                <div className="text-sm text-text-muted">{orderResult.errorMessage}</div>
              </div>
              <button
                onClick={handleResetAndRetry}
                className="text-sm text-accent hover:text-accent-dim"
              >
                Try Again
              </button>
            </div>
          )}

          {isDelegationInsufficient && !isSellMode && (
            <div className="flex items-center gap-2 p-3 bg-short/10 border border-short/30 rounded-xl text-xs text-short font-medium mb-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <div className="flex-1">
                Insufficient delegation. Requires ${totalCostWithFee.toFixed(2)}.
                <br />
                <span className="text-text-muted">Currently delegated: ${delegatedAmountDollars.toFixed(2)}</span>
              </div>
              <button
                type="button"
                onClick={() => approveDelegation(Math.max(10000 * 1_000_000, totalCostWithFee * 2 * 1_000_000))}
                className="bg-short text-background px-3 py-1 rounded-lg font-bold hover:bg-short-dim transition-colors"
              >
                Top Up
              </button>
            </div>
          )}

          {/* Submit */}
          {connected ? (
            !isDelegationApproved && !isSellMode ? (
              <button
                onClick={() => approveDelegation()}
                disabled={isApproving}
                className="w-full py-4 rounded-xl font-bold text-lg bg-accent text-background transition-all flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-accent/30"
              >
                {isApproving ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Enabling Fast Trading...</span>
                  </>
                ) : (
                  <>
                    <Settings className="w-5 h-5" />
                    <span>Enable Fast Trading</span>
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={isPlacing || isAuthenticating || !canSubmit || orderStatus === 'success'}
                className={cn(
                  'w-full py-4 rounded-xl font-bold text-lg transition-all flex items-center justify-center gap-2',
                  isSellMode
                    ? 'bg-warning text-background hover:shadow-lg hover:shadow-warning/30'
                    : outcome === 'YES'
                      ? 'bg-long text-background hover:shadow-lg hover:shadow-long/30'
                      : 'bg-short text-background hover:shadow-lg hover:shadow-short/30',
                  (isPlacing || isAuthenticating || !canSubmit || orderStatus === 'success') && 'opacity-50 cursor-not-allowed'
                )}
              >
                {orderStatus === 'signing' ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Sign in wallet...</span>
                  </>
                ) : orderStatus === 'submitting' || isPlacing ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Placing order...</span>
                  </>
                ) : orderStatus === 'success' ? (
                  <>
                    <CheckCircle className="w-5 h-5" />
                    <span>Order Placed</span>
                  </>
                ) : isAuthenticating ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Signing in...</span>
                  </>
                ) : isSellMode ? (
                  `Sell ${sellSizeNum.toFixed(2)} → $${sellProceeds.toFixed(2)}`
                ) : orderType === 'MARKET' ? (
                  `Spend $${dollarAmountNum} → ~${estimatedContracts} contracts`
                ) : (
                  `Buy ${limitSizeNum} ${outcome === 'YES' ? 'ABOVE' : 'BELOW'}`
                )}
              </button>
            )
          ) : (
            <WalletButton className="!w-full !justify-center !bg-accent !text-background hover:!bg-accent-dim !rounded-xl !font-bold !h-14 !text-lg" />
          )}
        </div>
      </div>
    </div>
  );
}
