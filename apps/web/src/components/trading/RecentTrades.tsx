'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useOrderbookStore, startOrderbookSimulation, stopOrderbookSimulation } from '@/stores/orderbookStore';

export function RecentTrades() {
  const { trades } = useOrderbookStore();

  // Ensure simulation is running
  useEffect(() => {
    startOrderbookSimulation();
    return () => stopOrderbookSimulation();
  }, []);

  return (
    <div className="bg-surface rounded-lg border border-border p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Recent Trades</h2>
        <span className="text-xs text-text-muted">{trades.length} trades</span>
      </div>

      {/* Header */}
      <div className="grid grid-cols-3 gap-2 text-xs text-text-muted mb-2 px-2">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Time</span>
      </div>

      {/* Trades list */}
      <div className="flex-1 overflow-auto space-y-0.5">
        {trades.length === 0 ? (
          <div className="text-center py-8 text-text-muted text-sm">
            No trades yet
          </div>
        ) : (
          trades.map((trade) => (
            <TradeRow
              key={trade.id}
              price={trade.price}
              size={trade.size}
              side={trade.side}
              timestamp={trade.timestamp}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TradeRow({
  price,
  size,
  side,
  timestamp,
}: {
  price: number;
  size: number;
  side: 'buy' | 'sell';
  timestamp: number;
}) {
  // Format time in a consistent way to avoid hydration issues
  const date = new Date(timestamp);
  const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;

  return (
    <div className={cn(
      'grid grid-cols-3 gap-2 py-1 px-2 rounded text-sm transition-colors',
      side === 'buy' ? 'animate-flash-green' : 'animate-flash-red'
    )}>
      <span className={cn(
        'font-mono',
        side === 'buy' ? 'text-long' : 'text-short'
      )}>
        ${price.toFixed(2)}
      </span>
      <span className="font-mono text-right text-text-primary">
        {size}
      </span>
      <span className="font-mono text-right text-text-muted text-xs" suppressHydrationWarning>
        {timeStr}
      </span>
    </div>
  );
}
