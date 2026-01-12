'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { 
  ArrowRightLeft, 
  CheckCircle, 
  XCircle, 
  Loader2, 
  Settings, 
  AlertCircle,
  X
} from 'lucide-react';
import { useQuickOrder } from '@/hooks/useOrder';
import { useDelegation } from '@/hooks/useDelegation';
import { WalletButton } from '@/components/WalletButton';
import type { Timeframe } from '@degen/types';

type OrderType = 'MARKET' | 'LIMIT';
type OrderStatus = 'idle' | 'signing' | 'submitting' | 'success' | 'error';

interface TradeModalProps {
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
}

export function TradeModal({
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
}: TradeModalProps) {
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
  // Market orders fill at best available price (no slippage protection)
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
  
  // Fee calculation (tiered structure)
  // Tier 1: $0-$50 = $0.02 flat, Tier 2: $50-$500 = 4bps, Tier 3: $500-$2000 = 3bps, Tier 4: $2000+ = 2bps
  const orderNotional = orderType === 'MARKET' ? dollarAmountNum : limitCost;
  const calculateFee = (notional: number): number => {
    if (notional < 50) return 0.02;  // Flat fee
    if (notional < 500) return Math.max(notional * 0.0004, 0.02);  // 4 bps
    if (notional < 2000) return notional * 0.0003;  // 3 bps
    return notional * 0.0002;  // 2 bps
  };
  const estimatedFee = calculateFee(orderNotional);
  const totalCostWithFee = orderNotional + estimatedFee;
  
  // Delegation validation
  const delegatedAmountDollars = delegatedAmount / 1_000_000;
  const isDelegationInsufficient = isDelegationApproved && !isSellMode && totalCostWithFee > delegatedAmountDollars;
  
  // Order minimums: $5 for buy, $0.02 for sell
  const MIN_BUY_NOTIONAL = 5;
  const MIN_SELL_NOTIONAL = 0.02;

  // Validate limit price (must be between 0.01 and 0.99)
  const isValidLimitPrice = limitPriceNum >= 0.01 && limitPriceNum <= 0.99;
  
  // SELL mode calculations
  const sellSizeNum = parseFloat(sellSize) || 0;
  const sellProceeds = sellSizeNum * price;
  const sellCostBasis = sellSizeNum * (avgEntryPrice || 0);
  const sellProfit = sellProceeds - sellCostBasis;
  
  // Validation with minimum order checks
  const isAboveMinBuy = orderType === 'MARKET' ? dollarAmountNum >= MIN_BUY_NOTIONAL : limitCost >= MIN_BUY_NOTIONAL;
  const isAboveMinSell = sellProceeds >= MIN_SELL_NOTIONAL;
  const canSubmitMarket = dollarAmountNum > 0 && estimatedContracts > 0 && isAboveMinBuy && orderStatus !== 'success' && !isDelegationInsufficient;
  const canSubmitLimit = limitSizeNum > 0 && isValidLimitPrice && isAboveMinBuy && orderStatus !== 'success' && !isDelegationInsufficient;
  const canSubmitSell = sellSizeNum > 0 && sellSizeNum <= maxSellSize && isAboveMinSell && orderStatus !== 'success';
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
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50" onClick={onClose}>
      <div 
        className="bg-surface w-full max-w-md rounded-2xl p-4 animate-in fade-in zoom-in-95 duration-200 max-h-[90vh] overflow-y-auto"
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
              `Buy ${outcome === 'YES' ? 'ABOVE' : 'BELOW'}`
            )}
          </h2>
          <button 
            onClick={onClose}
            className="p-1.5 hover:bg-surface-light rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
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

          {/* Market Info */}
          <div className="flex items-center justify-between p-2.5 bg-surface-light rounded-lg">
            <span className="text-text-muted text-sm">{asset} {timeframe}</span>
            <span className={cn(
              'px-2 py-1 rounded text-sm font-bold',
              outcome === 'YES' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
            )}>
              {outcome === 'YES' ? 'ABOVE' : 'BELOW'} @ ${price.toFixed(2)}
            </span>
          </div>

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
                    min="5"
                    className="w-full bg-surface-light border border-border rounded-lg pl-8 pr-4 py-2.5 font-mono text-lg text-center focus:border-accent focus:ring-1 focus:ring-accent"
                  />
                </div>
                <div className="flex gap-1.5 mt-1.5">
                  {[5, 25, 50, 100, 250].map((preset) => (
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

              {/* Minimum order warning */}
              {dollarAmountNum > 0 && dollarAmountNum < MIN_BUY_NOTIONAL && (
                <p className="text-[10px] text-short">Minimum buy order is ${MIN_BUY_NOTIONAL}</p>
              )}

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
                  <span className="text-text-muted">Fee</span>
                  <span className="font-mono text-text-muted">${estimatedFee.toFixed(2)}</span>
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

