'use client';

import { useState, useEffect } from 'react';
import { useMarketStore } from '@/stores/marketStore';
import { usePriceStore } from '@/stores/priceStore';
import { Countdown } from './Countdown';
import { cn } from '@/lib/utils';

const ASSETS = ['BTC', 'ETH', 'SOL'] as const;
const TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;

// Calculate next expiry time based on timeframe
function getNextExpiry(timeframe: string): number {
  const now = Date.now();
  const intervals: Record<string, number> = {
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
  };
  
  const interval = intervals[timeframe] || intervals['5m'];
  const nextExpiry = Math.ceil(now / interval) * interval;
  
  return nextExpiry;
}

export function MarketSelector() {
  const { selectedAsset, selectedTimeframe, setAsset, setTimeframe } = useMarketStore();
  const { prices } = usePriceStore();
  
  // Initialize with 0 to avoid hydration mismatch, set real value in useEffect
  const [expiryTime, setExpiryTime] = useState(0);
  const [strike, setStrike] = useState(0);
  const [mounted, setMounted] = useState(false);

  // Set initial values on client mount
  useEffect(() => {
    setMounted(true);
    setExpiryTime(getNextExpiry(selectedTimeframe));
  }, []);

  // Update expiry when timeframe changes
  useEffect(() => {
    if (mounted) {
      setExpiryTime(getNextExpiry(selectedTimeframe));
    }
  }, [selectedTimeframe, mounted]);

  // Update strike when asset changes (mock: use current price as strike)
  useEffect(() => {
    const price = prices[selectedAsset];
    if (price) {
      // Round to nearest significant value
      const roundTo = selectedAsset === 'BTC' ? 100 : selectedAsset === 'ETH' ? 10 : 1;
      setStrike(Math.round(price / roundTo) * roundTo);
    }
  }, [selectedAsset, prices]);

  // Reset expiry when it passes
  const handleExpire = () => {
    setExpiryTime(getNextExpiry(selectedTimeframe));
  };

  const currentPrice = prices[selectedAsset] || 0;
  const isAboveStrike = currentPrice > strike;
  const distanceFromStrike = strike > 0 ? ((currentPrice - strike) / strike) * 100 : 0;

  return (
    <div className="bg-surface rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-4">
        {/* Asset Selection */}
        <div className="flex items-center gap-2">
          <span className="text-text-muted text-sm">Asset:</span>
          <div className="flex gap-1">
            {ASSETS.map((asset) => (
              <button
                key={asset}
                onClick={() => setAsset(asset)}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-all',
                  selectedAsset === asset
                    ? 'bg-accent text-background shadow-lg shadow-accent/20'
                    : 'bg-surface-light text-text-secondary hover:text-text-primary hover:bg-surface-light/80'
                )}
              >
                {asset}
              </button>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="h-8 w-px bg-border hidden sm:block" />

        {/* Timeframe Selection */}
        <div className="flex items-center gap-2">
          <span className="text-text-muted text-sm">Expiry:</span>
          <div className="flex gap-1">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={cn(
                  'px-3 py-2 rounded-lg text-sm font-medium transition-all',
                  selectedTimeframe === tf
                    ? 'bg-accent text-background shadow-lg shadow-accent/20'
                    : 'bg-surface-light text-text-secondary hover:text-text-primary hover:bg-surface-light/80'
                )}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="h-8 w-px bg-border hidden md:block" />

        {/* Market Info */}
        <div className="flex items-center gap-6 ml-auto">
          {/* Strike Price */}
          <div className="text-sm">
            <span className="text-text-muted">Strike: </span>
            <span className="font-mono text-warning font-medium" suppressHydrationWarning>
              ${strike.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
            </span>
          </div>

          {/* Current vs Strike */}
          <div className="text-sm">
            <span className="text-text-muted">Current: </span>
            <span className={cn(
              'font-mono font-medium',
              isAboveStrike ? 'text-long' : 'text-short'
            )} suppressHydrationWarning>
              ${currentPrice.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
            </span>
            <span className={cn(
              'ml-1 text-xs',
              isAboveStrike ? 'text-long' : 'text-short'
            )} suppressHydrationWarning>
              ({distanceFromStrike >= 0 ? '+' : ''}{distanceFromStrike.toFixed(2)}%)
            </span>
          </div>

          {/* Countdown */}
          <div className="flex items-center gap-2">
            <span className="text-text-muted text-sm">Expires:</span>
            <Countdown 
              expiryTime={expiryTime}
              onExpire={handleExpire}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
