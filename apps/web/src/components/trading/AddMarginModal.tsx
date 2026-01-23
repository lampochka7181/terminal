'use client';

import { useState, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { 
  AlertCircle,
  CheckCircle, 
  XCircle, 
  Loader2,
  X,
  Shield,
  TrendingDown,
  DollarSign
} from 'lucide-react';
import { useQuickOrder } from '@/hooks/useOrder';
import { useDelegation } from '@/hooks/useDelegation';
import { api } from '@/lib/api';

interface AddMarginModalProps {
  marginAccountId: string;
  marketName: string;
  outcome: 'YES' | 'NO';
  currentMarginDeposited: number;
  currentLoanAmount: number;
  currentLiquidationPrice: number;
  currentPrice: number;
  shares: number;
  leverage: number;
  onClose: () => void;
  onSuccess?: () => void;
}

type ModalStatus = 'idle' | 'confirming' | 'success' | 'error';

// Calculate new liquidation price after adding margin
// Formula: liqPrice = newLoan / (shares * (1 - maintenanceMarginPct))
function calculateNewLiquidationPrice(
  shares: number,
  currentLoan: number,
  marginToAdd: number,
  maintenanceMarginPct: number = 0.03
): { newLoan: number; newLiqPrice: number } {
  const newLoan = Math.max(0, currentLoan - marginToAdd);
  const newLiqPrice = newLoan > 0 
    ? newLoan / (shares * (1 - maintenanceMarginPct))
    : 0;
  return { newLoan, newLiqPrice: Math.max(0.01, Math.min(0.99, newLiqPrice)) };
}

export function AddMarginModal({
  marginAccountId,
  marketName,
  outcome,
  currentMarginDeposited,
  currentLoanAmount,
  currentLiquidationPrice,
  currentPrice,
  shares,
  leverage,
  onClose,
  onSuccess,
}: AddMarginModalProps) {
  const [marginAmount, setMarginAmount] = useState('');
  const [status, setStatus] = useState<ModalStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  const { isApproved: isDelegationApproved } = useDelegation();
  
  const marginAmountNum = parseFloat(marginAmount) || 0;
  
  // Calculate new values after adding margin
  const { newLoan, newLiqPrice } = useMemo(() => {
    if (marginAmountNum <= 0) {
      return { newLoan: currentLoanAmount, newLiqPrice: currentLiquidationPrice };
    }
    return calculateNewLiquidationPrice(shares, currentLoanAmount, marginAmountNum);
  }, [marginAmountNum, shares, currentLoanAmount, currentLiquidationPrice]);
  
  // Calculate how much the liquidation price improves
  const liqPriceImprovement = currentLiquidationPrice - newLiqPrice;
  const liqPriceImprovementPct = currentLiquidationPrice > 0 
    ? (liqPriceImprovement / currentLiquidationPrice) * 100 
    : 0;
  
  // Calculate distance to liquidation
  const currentDistanceToLiq = outcome === 'YES'
    ? currentPrice - currentLiquidationPrice
    : (1 - currentPrice) - currentLiquidationPrice;
  const newDistanceToLiq = outcome === 'YES'
    ? currentPrice - newLiqPrice
    : (1 - currentPrice) - newLiqPrice;
  
  // Calculate effective leverage after adding margin
  const newEffectiveLeverage = newLoan > 0 
    ? (shares * currentPrice) / (currentMarginDeposited + marginAmountNum)
    : 1;
  
  // Quick fill amounts
  const quickAmounts = [10, 25, 50, 100];
  
  const handleAddMargin = async () => {
    if (marginAmountNum <= 0) {
      setErrorMessage('Please enter a valid amount');
      return;
    }
    
    if (!isDelegationApproved) {
      setErrorMessage('Please enable fast trading mode first');
      return;
    }
    
    setStatus('confirming');
    setErrorMessage(null);
    
    try {
      const result = await api.addMargin({
        marginAccountId,
        amount: marginAmountNum,
      });
      
      if (result.success) {
        setStatus('success');
        onSuccess?.();
      } else {
        throw new Error(result.error || 'Failed to add margin');
      }
    } catch (err: any) {
      setStatus('error');
      setErrorMessage(err.message || 'Failed to add margin');
    }
  };
  
  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter' && status === 'idle' && marginAmountNum > 0) {
        handleAddMargin();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [status, marginAmountNum]);
  
  return (
    <div 
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative bg-surface rounded-2xl border border-border shadow-2xl max-w-md w-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-accent/10">
              <Shield className="w-5 h-5 text-accent" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Add Margin</h2>
              <p className="text-xs text-text-muted">
                {marketName} · {outcome} · {leverage}x
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-surface-light text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Content */}
        <div className="p-6">
          {status === 'success' ? (
            <div className="text-center py-8">
              <CheckCircle className="w-16 h-16 text-long mx-auto mb-4" />
              <h3 className="text-xl font-bold mb-2">Margin Added!</h3>
              <p className="text-text-muted">
                Successfully added ${marginAmountNum.toFixed(2)} margin
              </p>
              <p className="text-sm text-accent mt-2">
                New liquidation price: ${newLiqPrice.toFixed(3)}
              </p>
              <button
                onClick={onClose}
                className="mt-6 px-6 py-2 bg-accent text-background font-bold rounded-xl"
              >
                Done
              </button>
            </div>
          ) : status === 'error' ? (
            <div className="text-center py-8">
              <XCircle className="w-16 h-16 text-short mx-auto mb-4" />
              <h3 className="text-xl font-bold mb-2">Failed to Add Margin</h3>
              <p className="text-text-muted text-sm">{errorMessage}</p>
              <button
                onClick={() => setStatus('idle')}
                className="mt-6 px-6 py-2 bg-surface-light text-text-primary font-bold rounded-xl"
              >
                Try Again
              </button>
            </div>
          ) : (
            <>
              {/* Current Position Info */}
              <div className="bg-surface-light rounded-xl p-4 mb-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-text-muted">Current Margin</span>
                    <p className="font-mono font-bold">${currentMarginDeposited.toFixed(2)}</p>
                  </div>
                  <div>
                    <span className="text-text-muted">Loan Amount</span>
                    <p className="font-mono font-bold">${currentLoanAmount.toFixed(2)}</p>
                  </div>
                  <div>
                    <span className="text-text-muted">Current Price</span>
                    <p className="font-mono font-bold">${currentPrice.toFixed(2)}</p>
                  </div>
                  <div>
                    <span className="text-text-muted">Liquidation Price</span>
                    <p className="font-mono font-bold text-warning">${currentLiquidationPrice.toFixed(3)}</p>
                  </div>
                </div>
              </div>
              
              {/* Amount Input */}
              <div className="mb-4">
                <label className="block text-sm text-text-muted mb-2">Amount to Add</label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted" />
                  <input
                    type="number"
                    value={marginAmount}
                    onChange={(e) => setMarginAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full pl-10 pr-4 py-3 bg-surface-light border border-border rounded-xl font-mono text-lg focus:outline-none focus:border-accent"
                    autoFocus
                  />
                </div>
                
                {/* Quick amounts */}
                <div className="flex gap-2 mt-2">
                  {quickAmounts.map((amount) => (
                    <button
                      key={amount}
                      onClick={() => setMarginAmount(amount.toString())}
                      className={cn(
                        'flex-1 py-1.5 text-sm rounded-lg font-medium transition-colors',
                        marginAmountNum === amount
                          ? 'bg-accent text-background'
                          : 'bg-surface-light text-text-muted hover:text-text-primary'
                      )}
                    >
                      ${amount}
                    </button>
                  ))}
                </div>
              </div>
              
              {/* Preview Changes */}
              {marginAmountNum > 0 && (
                <div className="bg-long/5 border border-long/20 rounded-xl p-4 mb-4">
                  <h4 className="text-sm font-bold text-long mb-3 flex items-center gap-2">
                    <TrendingDown className="w-4 h-4" />
                    After Adding ${marginAmountNum.toFixed(2)}
                  </h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-text-muted">New Margin</span>
                      <span className="font-mono font-bold">
                        ${(currentMarginDeposited + marginAmountNum).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">New Loan</span>
                      <span className="font-mono font-bold">
                        ${newLoan.toFixed(2)}
                        {marginAmountNum > 0 && (
                          <span className="text-long text-xs ml-1">
                            (-${(currentLoanAmount - newLoan).toFixed(2)})
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">New Liq. Price</span>
                      <span className="font-mono font-bold text-long">
                        ${newLiqPrice.toFixed(3)}
                        {liqPriceImprovement > 0 && (
                          <span className="text-xs ml-1">
                            ({liqPriceImprovementPct.toFixed(0)}% safer)
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Effective Leverage</span>
                      <span className="font-mono font-bold">
                        {newEffectiveLeverage.toFixed(1)}x
                        <span className="text-long text-xs ml-1">
                          (was {leverage}x)
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              )}
              
              {/* Error Message */}
              {errorMessage && (
                <div className="flex items-center gap-2 text-short text-sm mb-4">
                  <AlertCircle className="w-4 h-4" />
                  {errorMessage}
                </div>
              )}
              
              {/* Submit Button */}
              <button
                onClick={handleAddMargin}
                disabled={status === 'confirming' || marginAmountNum <= 0 || !isDelegationApproved}
                className={cn(
                  'w-full py-3 rounded-xl font-bold text-lg transition-all',
                  status === 'confirming'
                    ? 'bg-surface-light text-text-muted cursor-wait'
                    : marginAmountNum > 0 && isDelegationApproved
                    ? 'bg-accent text-background hover:brightness-110'
                    : 'bg-surface-light text-text-muted cursor-not-allowed'
                )}
              >
                {status === 'confirming' ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Adding Margin...
                  </span>
                ) : !isDelegationApproved ? (
                  'Enable Fast Trading First'
                ) : marginAmountNum <= 0 ? (
                  'Enter Amount'
                ) : (
                  `Add $${marginAmountNum.toFixed(2)} Margin`
                )}
              </button>
              
              {!isDelegationApproved && (
                <p className="text-xs text-text-muted text-center mt-2">
                  Fast trading mode must be enabled to add margin
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

