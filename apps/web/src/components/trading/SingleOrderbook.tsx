'use client';

import { useEffect, useCallback, useRef, memo, useState } from 'react';
import { cn } from '@/lib/utils';
import { 
  useOrderbookStore, 
  type OrderLevel 
} from '@/stores/orderbookStore';
import { api } from '@/lib/api';
import { getWebSocket } from '@/lib/websocket';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface SingleOrderbookProps {
  marketAddress: string;
  className?: string;
  onPriceClick?: (price: number, side: 'bid' | 'ask') => void;
}

/**
 * Single YES-focused orderbook (Option 3 from MARKET_MAKER.md)
 * - Shows Bids and Asks for YES only
 * - NO price is always displayed as (1 - YES price)
 * - Simplest UX for binary markets
 */
export function SingleOrderbook({ marketAddress, className, onPriceClick }: SingleOrderbookProps) {
  const subscribed = useRef(false);
  const { 
    yes, 
    sequenceId, 
    isLoading, 
    setOrderbook, 
    setBothOrderbooks,
    updateLevel,
    setLoading, 
    setError 
  } = useOrderbookStore();
  
  // Fetch initial orderbook data
  const fetchOrderbook = useCallback(async () => {
    if (!marketAddress) return;
    
    setLoading(true);
    try {
      const data = await api.getOrderbook(marketAddress) as any;
      
      const yesBids = (data.yes?.bids || data.bids || []) as [number, number][];
      const yesAsks = (data.yes?.asks || data.asks || []) as [number, number][];
      const noBids = (data.no?.bids || []) as [number, number][];
      const noAsks = (data.no?.asks || []) as [number, number][];
      
      setBothOrderbooks(yesBids, yesAsks, noBids, noAsks, data.sequenceId);
    } catch (err) {
      console.error('[SingleOrderbook] Fetch error:', err);
      setError('Failed to load orderbook');
    }
  }, [marketAddress, setBothOrderbooks, setLoading, setError]);
  
  // Subscribe to WebSocket updates
  useEffect(() => {
    if (!marketAddress) return;
    
    const ws = getWebSocket();
    
    const unsubscribe = ws.onMessage((message: any) => {
      if (message.channel !== 'orderbook') return;
      
      const messageMarket = message.market || message.data?.marketId;
      if (messageMarket !== marketAddress) return;
      
      const data = message.data;
      if (!data) return;
      
      const outcome = (data.outcome as 'YES' | 'NO') || 'YES';
      const bids = (data.bids || []) as [number, number][];
      const asks = (data.asks || []) as [number, number][];
      
      if (message.snapshot || (bids.length > 5 || asks.length > 5)) {
        setOrderbook(outcome, bids, asks, data.sequenceId);
      } else {
        bids.forEach(([price, size]) => updateLevel(outcome, 'bid', price, size));
        asks.forEach(([price, size]) => updateLevel(outcome, 'ask', price, size));
      }
    });
    
    const handleConnect = () => {
      if (marketAddress && !subscribed.current) {
        ws.subscribeOrderbook(marketAddress);
        subscribed.current = true;
      }
    };
    
    const unsubscribeConnect = ws.onConnect(handleConnect);
    
    if (ws.isConnected && !subscribed.current) {
      ws.subscribeOrderbook(marketAddress);
      subscribed.current = true;
    }
    
    fetchOrderbook();
    
    return () => {
      unsubscribe();
      unsubscribeConnect();
      if (subscribed.current && marketAddress) {
        ws.unsubscribeOrderbook(marketAddress);
        subscribed.current = false;
      }
    };
  }, [marketAddress, fetchOrderbook, setOrderbook, updateLevel]);
  
  const maxSize = Math.max(
    ...yes.asks.map(a => a.total || a.size),
    ...yes.bids.map(b => b.total || b.size),
    1
  );
  
  const hasLiquidity = yes.bids.length > 0 || yes.asks.length > 0;
  
  if (isLoading && yes.bids.length === 0) {
    return (
      <div className={cn('bg-surface rounded-xl border border-border overflow-hidden', className)}>
        <div className="animate-pulse p-4 space-y-2">
          <div className="h-4 bg-surface-light rounded w-1/2 mx-auto" />
          <div className="h-64 bg-surface-light rounded" />
        </div>
      </div>
    );
  }
  
  return (
    <div className={cn('bg-surface rounded-xl border border-border overflow-hidden flex flex-col', className)}>
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-border bg-surface-light/30">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold text-text-primary tracking-wide">ORDER BOOK</h2>
          <span className="text-[9px] text-text-muted font-mono">#{sequenceId}</span>
        </div>
      </div>
      
      {/* Column Headers */}
      <div className="grid grid-cols-4 gap-1 px-2 py-1.5 text-[9px] text-text-muted uppercase tracking-wider bg-surface-light/20 border-b border-border/50">
        <span>Size</span>
        <span className="text-center text-long">ABOVE</span>
        <span className="text-center text-short">BELOW</span>
        <span className="text-right">Total</span>
      </div>
      
      {!hasLiquidity ? (
        <div className="flex-1 flex items-center justify-center py-12">
          <span className="text-xs text-text-muted">No liquidity</span>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Asks (sells) - slice first to get best 8, then reverse so lowest is at bottom near spread */}
          <div className="flex-1 flex flex-col justify-end overflow-hidden">
            {[...yes.asks.slice(0, 8)].reverse().map((level, i) => (
              <PriceRow
                key={`ask-${level.price.toFixed(2)}`}
                level={level}
                side="ask"
                maxSize={maxSize}
                onPriceClick={onPriceClick}
              />
            ))}
          </div>
          
          {/* Spread Indicator - Always visible, calculated from actual displayed data */}
          <SpreadIndicator 
            bestAsk={yes.asks[0]?.price} 
            bestBid={yes.bids[0]?.price} 
          />
          
          {/* Bids (buys) */}
          <div className="flex-1 overflow-hidden">
            {yes.bids.slice(0, 8).map((level, i) => (
              <PriceRow
                key={`bid-${level.price.toFixed(2)}`}
                level={level}
                side="bid"
                maxSize={maxSize}
                onPriceClick={onPriceClick}
              />
            ))}
          </div>
        </div>
      )}
      
      {/* Footer with best prices - use actual orderbook data for accuracy */}
      {hasLiquidity && (
        <div className="px-3 py-2 border-t border-border bg-surface-light/20">
          <div className="flex items-center justify-between text-[10px]">
            <div className="flex items-center gap-1.5">
              <TrendingUp className="w-3 h-3 text-long" />
              <span className="text-text-muted">Best Bid:</span>
              <span className="font-mono font-bold text-long">
                ${(yes.bids[0]?.price ?? 0).toFixed(2)}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-text-muted">Best Ask:</span>
              <span className="font-mono font-bold text-accent">
                ${(yes.asks[0]?.price ?? 1).toFixed(2)}
              </span>
              <TrendingDown className="w-3 h-3 text-short" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Spread indicator - Always visible in the middle of the orderbook
 * Calculates spread directly from actual best ask/bid for accuracy
 */
const SpreadIndicator = memo(function SpreadIndicator({ 
  bestAsk, 
  bestBid 
}: { 
  bestAsk?: number; 
  bestBid?: number;
}) {
  // Calculate spread from actual data
  const ask = bestAsk ?? 1;
  const bid = bestBid ?? 0;
  const spread = ask > bid ? ask - bid : 0;
  const midPrice = bid > 0 && ask < 1 ? (bid + ask) / 2 : 0.5;
  const spreadPercent = midPrice > 0 ? (spread / midPrice) * 100 : 0;
  
  return (
    <div className="flex items-center justify-center py-2 px-2 bg-gradient-to-r from-long/5 via-surface-light/50 to-short/5 border-y border-border/30">
      <div className="flex items-center gap-3 text-[10px]">
        <span className="text-text-muted font-bold tracking-wider">SPREAD</span>
        <span className="font-mono font-bold text-accent">
          ${spread.toFixed(2)}
        </span>
        <span className="text-text-muted font-medium">
          ({spreadPercent.toFixed(1)}%)
        </span>
      </div>
    </div>
  );
});

/**
 * Individual price level row showing YES price and implied NO price
 */
interface PriceRowProps {
  level: OrderLevel;
  side: 'bid' | 'ask';
  maxSize: number;
  onPriceClick?: (price: number, side: 'bid' | 'ask') => void;
}

const PriceRow = memo(function PriceRow({ 
  level, 
  side, 
  maxSize,
  onPriceClick 
}: PriceRowProps) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevSizeRef = useRef(level.size);
  const clearFlash = useOrderbookStore(state => state.clearFlash);
  
  // Flash on size changes
  useEffect(() => {
    if (level.flash) {
      setFlash(level.flash);
      const timer = setTimeout(() => {
        setFlash(null);
        clearFlash('YES', side, level.price);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [level.flash, level.price, side, clearFlash]);
  
  useEffect(() => {
    if (prevSizeRef.current !== level.size) {
      const direction = level.size > prevSizeRef.current ? 'up' : 'down';
      setFlash(direction);
      const timer = setTimeout(() => setFlash(null), 300);
      prevSizeRef.current = level.size;
      return () => clearTimeout(timer);
    }
  }, [level.size]);
  
  const depthPercent = ((level.total || level.size) / maxSize) * 100;
  const isBid = side === 'bid';
  const impliedNoPrice = 1 - level.price;
  
  return (
    <div 
      className={cn(
        'relative grid grid-cols-4 gap-1 py-1 px-2',
        'hover:bg-surface-light/50 cursor-pointer transition-colors duration-75',
        'group',
        flash === 'up' && 'animate-flash-green',
        flash === 'down' && 'animate-flash-red'
      )}
      onClick={() => onPriceClick?.(level.price, side)}
    >
      {/* Depth bar background */}
      <div 
        className={cn(
          'absolute top-0 bottom-0 opacity-[0.08] transition-all duration-150',
          isBid ? 'bg-long left-0 rounded-r' : 'bg-short right-0 rounded-l'
        )}
        style={{ width: `${Math.min(100, depthPercent)}%` }}
      />
      
      {/* Size */}
      <span className={cn(
        'relative z-10 text-[10px] font-mono tabular-nums',
        isBid ? 'text-text-primary' : 'text-text-muted',
        'group-hover:text-text-primary transition-colors'
      )}>
        {formatSize(level.size)}
      </span>
      
      {/* YES Price (ABOVE) */}
      <span className={cn(
        'relative z-10 text-[10px] font-mono tabular-nums text-center font-bold',
        isBid ? 'text-long' : 'text-long/70'
      )}>
        ${level.price.toFixed(2)}
      </span>
      
      {/* Implied NO Price (BELOW = 1 - YES) */}
      <span className={cn(
        'relative z-10 text-[10px] font-mono tabular-nums text-center',
        isBid ? 'text-short/70' : 'text-short'
      )}>
        ${impliedNoPrice.toFixed(2)}
      </span>
      
      {/* Cumulative total */}
      <span className="relative z-10 text-[9px] font-mono tabular-nums text-right text-text-muted">
        {formatSize(level.total || level.size)}
      </span>
    </div>
  );
});

/**
 * Format size for display
 */
function formatSize(size: number): string {
  if (size >= 1000000) {
    return (size / 1000000).toFixed(1) + 'M';
  }
  if (size >= 1000) {
    return (size / 1000).toFixed(1) + 'K';
  }
  return Math.round(size).toLocaleString();
}

export default SingleOrderbook;

