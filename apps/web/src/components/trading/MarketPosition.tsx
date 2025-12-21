'use client';

import { usePositionForMarket } from '@/hooks/usePositionForMarket';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown, DollarSign, ArrowRightLeft } from 'lucide-react';

interface MarketPositionProps {
  marketAddress: string;
  currentYesPrice?: number;
  currentNoPrice?: number;
  onSell?: (outcome: 'YES' | 'NO', shares: number, avgEntry: number) => void;
  className?: string;
}

export function MarketPosition({
  marketAddress,
  currentYesPrice = 0.5,
  currentNoPrice = 0.5,
  onSell,
  className,
}: MarketPositionProps) {
  const { data: position, isLoading } = usePositionForMarket(marketAddress);

  // Don't show anything if loading or no position
  if (isLoading) {
    return (
      <div className={cn('bg-surface rounded-xl border border-border p-4', className)}>
        <div className="animate-pulse flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-surface-light" />
          <div className="flex-1">
            <div className="h-4 w-24 bg-surface-light rounded mb-2" />
            <div className="h-3 w-32 bg-surface-light rounded" />
          </div>
        </div>
      </div>
    );
  }

  // Don't show if user has no position
  if (!position || (position.yesShares === 0 && position.noShares === 0)) {
    return null;
  }

  const hasYes = position.yesShares > 0;
  const hasNo = position.noShares > 0;

  // Calculate unrealized PnL
  const yesPnl = hasYes ? (currentYesPrice - position.avgEntryYes) * position.yesShares : 0;
  const noPnl = hasNo ? (currentNoPrice - position.avgEntryNo) * position.noShares : 0;
  const totalPnl = yesPnl + noPnl + (position.realizedPnl || 0);

  return (
    <div className={cn('bg-surface rounded-xl border border-border overflow-hidden', className)}>
      <div className="px-4 py-3 bg-surface-light border-b border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-accent" />
            <span className="font-semibold">Your Position</span>
          </div>
          <div className={cn(
            'text-sm font-mono font-bold',
            totalPnl >= 0 ? 'text-long' : 'text-short'
          )}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)} PnL
          </div>
        </div>
      </div>

      <div className="p-4 space-y-3">
        {/* YES Position */}
        {hasYes && (
          <div className="flex items-center justify-between p-3 bg-long/5 rounded-lg border border-long/20">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-long/20 flex items-center justify-center">
                <TrendingUp className="w-4 h-4 text-long" />
              </div>
              <div>
                <div className="font-semibold text-long">
                  {position.yesShares.toFixed(2)} ABOVE
                </div>
                <div className="text-xs text-text-muted">
                  Avg: ${position.avgEntryYes.toFixed(2)} → Now: ${currentYesPrice.toFixed(2)}
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className={cn(
                'text-sm font-mono font-bold',
                yesPnl >= 0 ? 'text-long' : 'text-short'
              )}>
                {yesPnl >= 0 ? '+' : ''}{yesPnl.toFixed(2)}
              </div>
              {onSell && (
                <button
                  onClick={() => onSell('YES', position.yesShares, position.avgEntryYes)}
                  className="mt-1 text-xs text-accent hover:text-accent-dim flex items-center gap-1 ml-auto"
                >
                  <ArrowRightLeft className="w-3 h-3" />
                  Sell
                </button>
              )}
            </div>
          </div>
        )}

        {/* NO Position */}
        {hasNo && (
          <div className="flex items-center justify-between p-3 bg-short/5 rounded-lg border border-short/20">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-short/20 flex items-center justify-center">
                <TrendingDown className="w-4 h-4 text-short" />
              </div>
              <div>
                <div className="font-semibold text-short">
                  {position.noShares.toFixed(2)} BELOW
                </div>
                <div className="text-xs text-text-muted">
                  Avg: ${position.avgEntryNo.toFixed(2)} → Now: ${currentNoPrice.toFixed(2)}
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className={cn(
                'text-sm font-mono font-bold',
                noPnl >= 0 ? 'text-long' : 'text-short'
              )}>
                {noPnl >= 0 ? '+' : ''}{noPnl.toFixed(2)}
              </div>
              {onSell && (
                <button
                  onClick={() => onSell('NO', position.noShares, position.avgEntryNo)}
                  className="mt-1 text-xs text-accent hover:text-accent-dim flex items-center gap-1 ml-auto"
                >
                  <ArrowRightLeft className="w-3 h-3" />
                  Sell
                </button>
              )}
            </div>
          </div>
        )}

        {/* Position Summary */}
        <div className="flex justify-between text-xs text-text-muted pt-2 border-t border-border">
          <span>Total Cost: ${position.totalCost.toFixed(2)}</span>
          {position.realizedPnl !== 0 && (
            <span className={cn(
              'font-medium',
              position.realizedPnl >= 0 ? 'text-long' : 'text-short'
            )}>
              Realized: {position.realizedPnl >= 0 ? '+' : ''}{position.realizedPnl.toFixed(2)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default MarketPosition;

