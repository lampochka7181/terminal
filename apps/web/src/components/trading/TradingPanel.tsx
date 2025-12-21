'use client';

import { useState, useEffect, useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useOrderbookStore } from '@/stores/orderbookStore';
import { useMarketStore } from '@/stores/marketStore';
import { useQuickOrder } from '@/hooks/useOrder';
import { cn } from '@/lib/utils';
import { AlertCircle, ArrowRight, Zap, Loader2, CheckCircle, XCircle, Settings2 } from 'lucide-react';

type Side = 'YES' | 'NO';
type OrderType = 'limit' | 'market';
type OrderStatus = 'idle' | 'signing' | 'submitting' | 'success' | 'error';

interface OrderbookLevel {
  price: number;
  size: number;
}

export function TradingPanel() {
  const { connected } = useWallet();
  const { yes, no } = useOrderbookStore();
  const { selectedMarket } = useMarketStore();
  const { placeOrder, isPlacing, error: orderError, clearError } = useQuickOrder();
  
  const [side, setSide] = useState<Side>('YES');
  const [orderType, setOrderType] = useState<OrderType>('market');
  
  // LIMIT order inputs
  const [limitPrice, setLimitPrice] = useState('0.50');
  const [limitSize, setLimitSize] = useState('100');
  
  // MARKET order inputs
  const [dollarAmount, setDollarAmount] = useState('50');
  const [priceProtection, setPriceProtection] = useState('0.10');
  const [showAdvanced, setShowAdvanced] = useState(false);
  
  const [orderStatus, setOrderStatus] = useState<OrderStatus>('idle');
  const [orderResult, setOrderResult] = useState<{
    orderId?: string;
    status?: string;
    filledSize?: number;
    errorMessage?: string;
  } | null>(null);

  // Sync order error
  useEffect(() => {
    if (orderError) {
      setOrderStatus('error');
      setOrderResult({ errorMessage: orderError });
    }
  }, [orderError]);

  // Get orderbook for selected side
  const book = side === 'YES' ? yes : no;
  const bestBid = book.bestBid || 0.49;
  const bestAsk = book.bestAsk || 0.51;

  // Parse orderbook asks into levels for walking
  const askLevels: OrderbookLevel[] = useMemo(() => {
    const asks = book.asks || [];
    return asks.map(([price, size]: [number, number]) => ({ price, size }))
      .sort((a, b) => a.price - b.price); // Sort by price ascending (best first)
  }, [book.asks]);

  // Calculate MARKET order estimates (walk the book)
  const marketEstimate = useMemo(() => {
    const amount = parseFloat(dollarAmount) || 0;
    const maxSlippage = parseFloat(priceProtection) || 0.10;
    const maxPrice = Math.min(0.99, bestAsk + maxSlippage);
    
    let remainingDollars = amount;
    let totalContracts = 0;
    let totalSpent = 0;
    const fills: { price: number; contracts: number; cost: number }[] = [];
    
    // Walk the orderbook
    for (const level of askLevels) {
      if (remainingDollars <= 0) break;
      if (level.price > maxPrice) break;
      
      // How many contracts can we buy at this level?
      const maxContractsAtLevel = level.size;
      const costPerContract = level.price;
      const maxWeCanAfford = Math.floor(remainingDollars / costPerContract);
      const contractsToFill = Math.min(maxContractsAtLevel, maxWeCanAfford);
      
      if (contractsToFill > 0) {
        const cost = contractsToFill * costPerContract;
        fills.push({ price: level.price, contracts: contractsToFill, cost });
        totalContracts += contractsToFill;
        totalSpent += cost;
        remainingDollars -= cost;
      }
    }
    
    // If orderbook is empty or insufficient, estimate based on best ask
    if (totalContracts === 0 && amount > 0) {
      const estimatedPrice = bestAsk || 0.50;
      if (estimatedPrice <= maxPrice) {
        totalContracts = Math.floor(amount / estimatedPrice);
        totalSpent = totalContracts * estimatedPrice;
      }
    }
    
    const avgPrice = totalContracts > 0 ? totalSpent / totalContracts : bestAsk;
    const maxPayout = totalContracts * 1.0;
    const unfilled = amount - totalSpent;
    
    return {
      contracts: totalContracts,
      avgPrice,
      maxPayout,
      totalSpent,
      unfilled,
      fills,
      maxPrice,
    };
  }, [dollarAmount, priceProtection, askLevels, bestAsk]);

  // LIMIT order calculations
  const limitPriceNum = parseFloat(limitPrice) || 0;
  const limitSizeNum = parseFloat(limitSize) || 0;
  const limitCost = limitPriceNum * limitSizeNum;
  const limitPayout = limitSizeNum * 1.0;
  const limitProfit = limitPayout - limitCost;

  // Quick fill helpers
  const fillAtBest = () => {
    setLimitPrice(bestAsk.toFixed(2));
  };

  // Handle order submission
  const handleSubmit = async () => {
    if (!connected || !selectedMarket) return;

    clearError();
    setOrderResult(null);
    setOrderStatus('signing');

    // Calculate expiry (market expiry - 60s or 1 hour from now)
    const now = Math.floor(Date.now() / 1000);
    const defaultExpiry = now + 3600;
    const expiryTimestamp = selectedMarket.expiry 
      ? Math.min(Math.floor(selectedMarket.expiry / 1000) - 60, defaultExpiry)
      : defaultExpiry;

    setOrderStatus('submitting');

    const outcomeValue = side.toLowerCase() as 'yes' | 'no';
    console.log('[TradingPanel] Placing order with outcome:', outcomeValue, 'type:', orderType);

    if (orderType === 'market') {
      // MARKET order: dollar-based
      const result = await placeOrder({
        marketAddress: selectedMarket.address,
        side: 'bid',
        outcome: outcomeValue,
        orderType: 'market',
        price: marketEstimate.maxPrice, // Max price willing to pay
        size: marketEstimate.contracts, // Estimated contracts
        dollarAmount: parseFloat(dollarAmount),
        maxPrice: marketEstimate.maxPrice,
        expiryTimestamp,
      });

      handleOrderResult(result);
    } else {
      // LIMIT order: contract-based
      const result = await placeOrder({
        marketAddress: selectedMarket.address,
        side: 'bid',
        outcome: outcomeValue,
        orderType: 'limit',
        price: limitPriceNum,
        size: limitSizeNum,
        expiryTimestamp,
      });

      handleOrderResult(result);
    }
  };

  const handleOrderResult = (result: any) => {
    if (result) {
      setOrderStatus('success');
      setOrderResult({
        orderId: result.orderId,
        status: result.status,
        filledSize: result.filledSize,
      });
      setTimeout(() => {
        setOrderStatus('idle');
        setOrderResult(null);
      }, 3000);
    } else {
      setOrderStatus('error');
      setOrderResult({ errorMessage: orderError || 'Order failed' });
    }
  };

  const handleResetError = () => {
    setOrderStatus('idle');
    setOrderResult(null);
    clearError();
  };

  const canSubmitMarket = connected && selectedMarket && parseFloat(dollarAmount) > 0 && marketEstimate.contracts > 0;
  const canSubmitLimit = connected && selectedMarket && limitSizeNum > 0 && limitPriceNum >= 0.01 && limitPriceNum <= 0.99;
  const canSubmit = orderType === 'market' ? canSubmitMarket : canSubmitLimit;

  return (
    <div className="bg-surface rounded-lg border border-border p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Place Order</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setOrderType('market')}
            className={cn(
              'px-2 py-1 text-xs rounded transition-colors',
              orderType === 'market'
                ? 'bg-accent/20 text-accent'
                : 'text-text-muted hover:text-text-primary'
            )}
          >
            Market
          </button>
          <button
            onClick={() => setOrderType('limit')}
            className={cn(
              'px-2 py-1 text-xs rounded transition-colors',
              orderType === 'limit'
                ? 'bg-accent/20 text-accent'
                : 'text-text-muted hover:text-text-primary'
            )}
          >
            Limit
          </button>
        </div>
      </div>

      {/* Side Toggle */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <button
          onClick={() => setSide('YES')}
          className={cn(
            'py-3 rounded-lg font-bold text-lg transition-all flex items-center justify-center gap-2',
            side === 'YES'
              ? 'bg-long text-background shadow-lg shadow-long/20'
              : 'bg-surface-light text-text-secondary hover:bg-surface-light/80'
          )}
        >
          <span>YES</span>
          <span className="text-sm font-normal opacity-70">Long</span>
        </button>
        <button
          onClick={() => setSide('NO')}
          className={cn(
            'py-3 rounded-lg font-bold text-lg transition-all flex items-center justify-center gap-2',
            side === 'NO'
              ? 'bg-short text-background shadow-lg shadow-short/20'
              : 'bg-surface-light text-text-secondary hover:bg-surface-light/80'
          )}
        >
          <span>NO</span>
          <span className="text-sm font-normal opacity-70">Short</span>
        </button>
      </div>

      {/* MARKET Order Input */}
      {orderType === 'market' && (
        <>
          <div className="mb-4">
            <label className="block text-sm text-text-muted mb-1">Amount to Spend</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">$</span>
              <input
                type="number"
                value={dollarAmount}
                onChange={(e) => setDollarAmount(e.target.value)}
                min="1"
                step="10"
                className="w-full bg-surface-light border border-border rounded-lg px-8 py-3 font-mono text-right focus:border-accent focus:ring-1 focus:ring-accent transition-all"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted text-sm">USDC</span>
            </div>
            <div className="flex gap-2 mt-2">
              {[25, 50, 100, 250, 500].map((preset) => (
                <button
                  key={preset}
                  onClick={() => setDollarAmount(preset.toString())}
                  className={cn(
                    'flex-1 py-1.5 text-xs rounded transition-colors',
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
          <div className="mb-4">
            <button 
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary mb-2"
            >
              <Settings2 className="w-3 h-3" />
              {showAdvanced ? 'Hide' : 'Show'} Price Protection
            </button>
            
            {showAdvanced && (
              <div className="bg-surface-light rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-text-muted">Max Price Above Best Ask</span>
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
                  Best ask: ${bestAsk.toFixed(2)} → Max: ${marketEstimate.maxPrice.toFixed(2)}
                </div>
              </div>
            )}
          </div>

          {/* Market Order Summary */}
          <div className="bg-surface-light rounded-lg p-3 mb-4 space-y-2 text-sm flex-1">
            <div className="flex justify-between">
              <span className="text-text-muted">Est. Contracts</span>
              <span className="font-mono font-bold">{marketEstimate.contracts.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Avg Price</span>
              <span className="font-mono">${marketEstimate.avgPrice.toFixed(3)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Max Payout</span>
              <span className="font-mono">${marketEstimate.maxPayout.toFixed(2)} USDC</span>
            </div>
            {marketEstimate.unfilled > 0.01 && (
              <div className="flex justify-between text-warning">
                <span>Unfilled (low liquidity)</span>
                <span className="font-mono">${marketEstimate.unfilled.toFixed(2)}</span>
              </div>
            )}
            <div className="border-t border-border pt-2 mt-2">
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Est. Profit</span>
                <div className="text-right">
                  <span className={cn('font-mono font-bold', 'text-long')}>
                    +${(marketEstimate.maxPayout - parseFloat(dollarAmount)).toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* LIMIT Order Input */}
      {orderType === 'limit' && (
        <>
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm text-text-muted">Price</label>
              <button 
                onClick={fillAtBest}
                className="text-xs text-accent hover:text-accent-dim transition-colors flex items-center gap-1"
              >
                <Zap className="w-3 h-3" />
                Fill at best
              </button>
            </div>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">$</span>
              <input
                type="number"
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                step="0.01"
                min="0.01"
                max="0.99"
                className="w-full bg-surface-light border border-border rounded-lg px-8 py-3 font-mono text-right focus:border-accent focus:ring-1 focus:ring-accent transition-all"
              />
            </div>
            <div className="flex gap-1 mt-1">
              {[0.25, 0.40, 0.50, 0.60, 0.75].map((preset) => (
                <button
                  key={preset}
                  onClick={() => setLimitPrice(preset.toFixed(2))}
                  className={cn(
                    'px-2 py-0.5 text-xs rounded transition-colors',
                    parseFloat(limitPrice) === preset
                      ? 'bg-accent/20 text-accent'
                      : 'bg-surface-light text-text-muted hover:text-text-primary'
                  )}
                >
                  ${preset}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-sm text-text-muted mb-1">Contracts</label>
            <input
              type="number"
              value={limitSize}
              onChange={(e) => setLimitSize(e.target.value)}
              min="1"
              step="1"
              className="w-full bg-surface-light border border-border rounded-lg px-4 py-3 font-mono text-right focus:border-accent focus:ring-1 focus:ring-accent transition-all"
            />
            <div className="flex gap-2 mt-2">
              {[10, 50, 100, 500, 1000].map((preset) => (
                <button
                  key={preset}
                  onClick={() => setLimitSize(preset.toString())}
                  className={cn(
                    'flex-1 py-1.5 text-xs rounded transition-colors',
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

          {/* Limit Order Summary */}
          <div className="bg-surface-light rounded-lg p-3 mb-4 space-y-2 text-sm flex-1">
            <div className="flex justify-between">
              <span className="text-text-muted">Cost</span>
              <span className="font-mono">${limitCost.toFixed(2)} USDC</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Max Payout</span>
              <span className="font-mono">${limitPayout.toFixed(2)} USDC</span>
            </div>
            <div className="border-t border-border pt-2 mt-2">
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Potential Profit</span>
                <div className="text-right">
                  <span className={cn('font-mono font-bold', limitProfit > 0 ? 'text-long' : 'text-short')}>
                    {limitProfit > 0 ? '+' : ''}${limitProfit.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Warning for unconnected */}
      {!connected && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-warning/10 border border-warning/20 rounded-lg text-warning text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>Connect your wallet to place orders</span>
        </div>
      )}

      {/* No market selected warning */}
      {connected && !selectedMarket && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-warning/10 border border-warning/20 rounded-lg text-warning text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>Select a market to place orders</span>
        </div>
      )}

      {/* Order Status Feedback */}
      {orderStatus === 'success' && orderResult && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-long/10 border border-long/20 rounded-lg text-long text-sm">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1">
            Order {orderResult.status === 'filled' ? 'filled' : 'placed'} successfully!
          </span>
        </div>
      )}

      {orderStatus === 'error' && orderResult?.errorMessage && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-short/10 border border-short/20 rounded-lg text-short text-sm">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1">{orderResult.errorMessage}</span>
          <button onClick={handleResetError} className="text-xs underline">Dismiss</button>
        </div>
      )}

      {/* Submit Button */}
      <button
        onClick={handleSubmit}
        disabled={!canSubmit || isPlacing || orderStatus === 'success'}
        className={cn(
          'w-full py-4 rounded-lg font-bold text-lg transition-all flex items-center justify-center gap-2',
          canSubmit && !isPlacing
            ? side === 'YES'
              ? 'bg-long text-background hover:shadow-lg hover:shadow-long/30 hover:scale-[1.02] active:scale-[0.98]'
              : 'bg-short text-background hover:shadow-lg hover:shadow-short/30 hover:scale-[1.02] active:scale-[0.98]'
            : 'bg-surface-light text-text-muted cursor-not-allowed'
        )}
      >
        {!connected ? (
          'Connect Wallet'
        ) : orderStatus === 'signing' ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Sign in wallet...</span>
          </>
        ) : isPlacing || orderStatus === 'submitting' ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Placing order...</span>
          </>
        ) : orderStatus === 'success' ? (
          <>
            <CheckCircle className="w-5 h-5" />
            <span>Order Placed</span>
          </>
        ) : orderType === 'market' ? (
          <>
            <span>Buy ~{marketEstimate.contracts.toLocaleString()} {side}</span>
            <ArrowRight className="w-5 h-5" />
          </>
        ) : (
          <>
            <span>Buy {limitSize} {side}</span>
            <ArrowRight className="w-5 h-5" />
          </>
        )}
      </button>
    </div>
  );
}
