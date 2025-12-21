'use client';

import { useEffect, useCallback, useRef, memo, useState } from 'react';
import { cn } from '@/lib/utils';
import { 
  useOrderbookStore, 
  type OrderLevel, 
  type OutcomeOrderbook 
} from '@/stores/orderbookStore';
import { api } from '@/lib/api';
import { getWebSocket } from '@/lib/websocket';

interface OrderbookProps {
  marketAddress: string;
  className?: string;
}

/**
 * Professional dual-panel orderbook showing both YES and NO outcomes
 * with tick-by-tick updates and flash animations
 */
export function Orderbook({ marketAddress, className }: OrderbookProps) {
  const subscribed = useRef(false);
  const { 
    yes, 
    no, 
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
      
      // Get both YES and NO orderbooks
      const yesBids = (data.yes?.bids || data.bids || []) as [number, number][];
      const yesAsks = (data.yes?.asks || data.asks || []) as [number, number][];
      const noBids = (data.no?.bids || []) as [number, number][];
      const noAsks = (data.no?.asks || []) as [number, number][];
      
      setBothOrderbooks(yesBids, yesAsks, noBids, noAsks, data.sequenceId);
    } catch (err) {
      console.error('[Orderbook] Fetch error:', err);
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
      
      // Full snapshot or delta update
      if (message.snapshot || (bids.length > 5 || asks.length > 5)) {
        setOrderbook(outcome, bids, asks, data.sequenceId);
      } else {
        // Apply tick-by-tick updates
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
    
    // Fetch initial data
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
  
  if (isLoading && yes.bids.length === 0 && no.bids.length === 0) {
    return (
      <div className={cn('bg-surface rounded-lg border border-border p-4', className)}>
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-surface-light rounded w-1/3" />
          <div className="h-64 bg-surface-light rounded" />
        </div>
      </div>
    );
  }
  
  return (
    <div className={cn('bg-surface rounded-lg border border-border overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-light/50">
        <h2 className="text-sm font-semibold text-text-primary tracking-wide">ORDERBOOK</h2>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-muted font-mono">SEQ: {sequenceId}</span>
        </div>
      </div>
      
      {/* Dual panel orderbook */}
      <div className="grid grid-cols-2 divide-x divide-border">
        {/* YES Orderbook - Above Strike */}
        <OutcomePanel 
          outcome="YES" 
          label="ABOVE" 
          book={yes}
          colorClass="long"
        />
        
        {/* NO Orderbook - Below Strike */}
        <OutcomePanel 
          outcome="NO" 
          label="BELOW" 
          book={no}
          colorClass="short"
        />
      </div>
    </div>
  );
}

/**
 * Individual outcome panel (YES or NO)
 */
interface OutcomePanelProps {
  outcome: 'YES' | 'NO';
  label: string;
  book: OutcomeOrderbook;
  colorClass: 'long' | 'short';
}

const OutcomePanel = memo(function OutcomePanel({ 
  outcome, 
  label, 
  book, 
  colorClass 
}: OutcomePanelProps) {
  const maxSize = Math.max(
    ...book.asks.map(a => a.total || a.size),
    ...book.bids.map(b => b.total || b.size),
    1
  );
  
  const hasLiquidity = book.bids.length > 0 || book.asks.length > 0;
  
  return (
    <div className="flex flex-col">
      {/* Panel header */}
      <div className={cn(
        'px-3 py-2 text-center border-b border-border',
        colorClass === 'long' ? 'bg-long/5' : 'bg-short/5'
      )}>
        <div className="flex items-center justify-center gap-2">
          <span className={cn(
            'text-xs font-bold tracking-wider',
            colorClass === 'long' ? 'text-long' : 'text-short'
          )}>
            {label}
          </span>
          <span className="text-[10px] text-text-muted">({outcome})</span>
        </div>
        {hasLiquidity && (
          <div className="text-[10px] text-text-muted mt-0.5 font-mono">
            Mid: ${book.midPrice.toFixed(2)} • Spread: ${book.spread.toFixed(2)}
          </div>
        )}
      </div>
      
      {/* Column headers */}
      <div className="grid grid-cols-3 gap-1 px-2 py-1.5 text-[9px] text-text-muted uppercase tracking-wider bg-surface-light/30 border-b border-border/50">
        <span>Size</span>
        <span className="text-center">Price</span>
        <span className="text-right">Total</span>
      </div>
      
      {!hasLiquidity ? (
        <div className="flex-1 flex items-center justify-center py-8">
          <span className="text-xs text-text-muted">No liquidity</span>
        </div>
      ) : (
        <div className="flex flex-col" style={{ minHeight: '300px' }}>
          {/* Asks (sells) - reversed so lowest is at bottom near spread */}
          <div className="flex-1 flex flex-col justify-end overflow-hidden">
            {[...book.asks].reverse().slice(0, 8).map((level, i) => (
              <PriceRow
                key={`ask-${i}-${level.price.toFixed(2)}`}
                level={level}
                side="ask"
                maxSize={maxSize}
                colorClass={colorClass}
                outcome={outcome}
              />
            ))}
          </div>
          
          {/* Spread indicator */}
          <SpreadBar book={book} colorClass={colorClass} />
          
          {/* Bids (buys) */}
          <div className="flex-1 overflow-hidden">
            {book.bids.slice(0, 8).map((level, i) => (
              <PriceRow
                key={`bid-${i}-${level.price.toFixed(2)}`}
                level={level}
                side="bid"
                maxSize={maxSize}
                colorClass={colorClass}
                outcome={outcome}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

/**
 * Spread indicator bar between asks and bids
 */
const SpreadBar = memo(function SpreadBar({ 
  book, 
  colorClass 
}: { 
  book: OutcomeOrderbook; 
  colorClass: 'long' | 'short';
}) {
  if (book.spread <= 0) return null;
  
  return (
    <div className={cn(
      'flex items-center justify-center py-1.5 px-2',
      'bg-gradient-to-r',
      colorClass === 'long' 
        ? 'from-long/10 via-transparent to-long/10' 
        : 'from-short/10 via-transparent to-short/10'
    )}>
      <div className="flex items-center gap-2 text-[10px]">
        <span className="text-text-muted">SPREAD</span>
        <span className={cn(
          'font-mono font-medium',
          colorClass === 'long' ? 'text-long' : 'text-short'
        )}>
          ${book.spread.toFixed(2)}
        </span>
        <span className="text-text-muted">
          ({book.spreadPercent.toFixed(1)}%)
        </span>
      </div>
    </div>
  );
});

/**
 * Individual price level row with depth bar and flash animation
 */
interface PriceRowProps {
  level: OrderLevel;
  side: 'bid' | 'ask';
  maxSize: number;
  colorClass: 'long' | 'short';
  outcome: 'YES' | 'NO';
}

const PriceRow = memo(function PriceRow({ 
  level, 
  side, 
  maxSize, 
  colorClass,
  outcome
}: PriceRowProps) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevSizeRef = useRef(level.size);
  const clearFlash = useOrderbookStore(state => state.clearFlash);
  
  // Detect size changes and trigger flash
  useEffect(() => {
    if (level.flash) {
      setFlash(level.flash);
      const timer = setTimeout(() => {
        setFlash(null);
        clearFlash(outcome, side, level.price);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [level.flash, level.price, side, outcome, clearFlash]);
  
  // Also detect direct size changes
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
  
  const bgColor = colorClass === 'long' ? 'bg-long' : 'bg-short';
  const textColor = colorClass === 'long' ? 'text-long' : 'text-short';
  
  return (
    <div 
      className={cn(
        'relative grid grid-cols-3 gap-1 py-1 px-2',
        'hover:bg-surface-light/50 cursor-pointer transition-colors duration-75',
        'group',
        // Flash animation classes
        flash === 'up' && 'animate-flash-green',
        flash === 'down' && 'animate-flash-red'
      )}
    >
      {/* Depth bar background */}
      <div 
        className={cn(
          'absolute top-0 bottom-0 opacity-[0.12] transition-all duration-150',
          bgColor,
          isBid ? 'left-0 rounded-r' : 'right-0 rounded-l'
        )}
        style={{ 
          width: `${Math.min(100, depthPercent)}%`,
        }}
      />
      
      {/* Size */}
      <span className={cn(
        'relative z-10 text-[11px] font-mono tabular-nums',
        isBid ? 'text-text-primary' : 'text-text-muted',
        'group-hover:text-text-primary transition-colors'
      )}>
        {formatSize(level.size)}
      </span>
      
      {/* Price */}
      <span className={cn(
        'relative z-10 text-[11px] font-mono tabular-nums text-center font-medium',
        textColor
      )}>
        ${level.price.toFixed(2)}
      </span>
      
      {/* Cumulative total */}
      <span className="relative z-10 text-[10px] font-mono tabular-nums text-right text-text-muted">
        {formatSize(level.total || level.size)}
      </span>
    </div>
  );
});

/**
 * Format size for display (compact for large numbers)
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

/**
 * Compact version for smaller spaces
 */
export function CompactOrderbook({ marketAddress, className }: OrderbookProps) {
  const subscribed = useRef(false);
  const { 
    yes, 
    no, 
    setBothOrderbooks,
    setOrderbook,
    updateLevel
  } = useOrderbookStore();
  
  // Simplified fetch
  useEffect(() => {
    if (!marketAddress) return;
    
    const fetchData = async () => {
      try {
        const data = await api.getOrderbook(marketAddress) as any;
        const yesBids = (data.yes?.bids || data.bids || []) as [number, number][];
        const yesAsks = (data.yes?.asks || data.asks || []) as [number, number][];
        const noBids = (data.no?.bids || []) as [number, number][];
        const noAsks = (data.no?.asks || []) as [number, number][];
        setBothOrderbooks(yesBids, yesAsks, noBids, noAsks, data.sequenceId);
      } catch (err) {
        console.error('[CompactOrderbook] Error:', err);
      }
    };
    
    fetchData();
    
    // WebSocket subscription
    const ws = getWebSocket();
    
    const unsubscribe = ws.onMessage((message: any) => {
      if (message.channel !== 'orderbook') return;
      if ((message.market || message.data?.marketId) !== marketAddress) return;
      
      const data = message.data;
      if (!data) return;
      
      const outcome = (data.outcome as 'YES' | 'NO') || 'YES';
      const bids = (data.bids || []) as [number, number][];
      const asks = (data.asks || []) as [number, number][];
      
      if (message.snapshot || bids.length > 3 || asks.length > 3) {
        setOrderbook(outcome, bids, asks, data.sequenceId);
      } else {
        bids.forEach(([price, size]) => updateLevel(outcome, 'bid', price, size));
        asks.forEach(([price, size]) => updateLevel(outcome, 'ask', price, size));
      }
    });
    
    const handleConnect = () => {
      if (!subscribed.current) {
        ws.subscribeOrderbook(marketAddress);
        subscribed.current = true;
      }
    };
    
    const unsubConnect = ws.onConnect(handleConnect);
    if (ws.isConnected && !subscribed.current) {
      ws.subscribeOrderbook(marketAddress);
      subscribed.current = true;
    }
    
    return () => {
      unsubscribe();
      unsubConnect();
      if (subscribed.current) {
        ws.unsubscribeOrderbook(marketAddress);
        subscribed.current = false;
      }
    };
  }, [marketAddress, setBothOrderbooks, setOrderbook, updateLevel]);
  
  return (
    <div className={cn('grid grid-cols-2 gap-3', className)}>
      {/* YES (Above) mini book */}
      <MiniBook outcome="YES" label="ABOVE" book={yes} colorClass="long" />
      
      {/* NO (Below) mini book */}
      <MiniBook outcome="NO" label="BELOW" book={no} colorClass="short" />
    </div>
  );
}

/**
 * Mini orderbook panel for compact view
 */
const MiniBook = memo(function MiniBook({
  outcome,
  label,
  book,
  colorClass,
}: {
  outcome: 'YES' | 'NO';
  label: string;
  book: OutcomeOrderbook;
  colorClass: 'long' | 'short';
}) {
  const textColor = colorClass === 'long' ? 'text-long' : 'text-short';
  const bgColor = colorClass === 'long' ? 'bg-long' : 'bg-short';
  
  const maxSize = Math.max(
    ...book.bids.map(b => b.size),
    ...book.asks.map(a => a.size),
    1
  );
  
  return (
    <div className={cn(
      'rounded-lg border border-border overflow-hidden',
      colorClass === 'long' ? 'bg-long/5' : 'bg-short/5'
    )}>
      {/* Header */}
      <div className="px-2 py-1.5 border-b border-border/50 text-center">
        <span className={cn('text-[10px] font-bold tracking-wider', textColor)}>
          {label}
        </span>
        <span className="text-[9px] text-text-muted ml-1">({outcome})</span>
      </div>
      
      {/* Column headers */}
      <div className="grid grid-cols-2 px-2 py-1 text-[8px] text-text-muted uppercase">
        <span>Size</span>
        <span className="text-right">Price</span>
      </div>
      
      {/* Asks */}
      {[...book.asks].reverse().slice(0, 3).map((level, i) => (
        <MiniRow 
          key={`ask-${i}-${level.price.toFixed(2)}`} 
          level={level} 
          side="ask" 
          maxSize={maxSize}
          bgColor={bgColor}
          textColor={textColor}
        />
      ))}
      
      {/* Spread */}
      {book.spread > 0 && (
        <div className="text-center text-[8px] text-text-muted py-0.5 border-y border-border/30">
          ${book.spread.toFixed(2)}
        </div>
      )}
      
      {/* Bids */}
      {book.bids.slice(0, 3).map((level, i) => (
        <MiniRow 
          key={`bid-${i}-${level.price.toFixed(2)}`} 
          level={level} 
          side="bid" 
          maxSize={maxSize}
          bgColor={bgColor}
          textColor={textColor}
        />
      ))}
    </div>
  );
});

const MiniRow = memo(function MiniRow({
  level,
  side,
  maxSize,
  bgColor,
  textColor,
}: {
  level: OrderLevel;
  side: 'bid' | 'ask';
  maxSize: number;
  bgColor: string;
  textColor: string;
}) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevSizeRef = useRef(level.size);
  
  useEffect(() => {
    if (prevSizeRef.current !== level.size) {
      setFlash(level.size > prevSizeRef.current ? 'up' : 'down');
      const timer = setTimeout(() => setFlash(null), 300);
      prevSizeRef.current = level.size;
      return () => clearTimeout(timer);
    }
  }, [level.size]);
  
  const pct = (level.size / maxSize) * 100;
  const isBid = side === 'bid';
  
  return (
    <div className={cn(
      'relative grid grid-cols-2 px-2 py-0.5 text-[9px] font-mono',
      flash === 'up' && 'animate-flash-green',
      flash === 'down' && 'animate-flash-red'
    )}>
      <div 
        className={cn('absolute top-0 bottom-0 opacity-20', bgColor, isBid ? 'left-0' : 'right-0')}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
      <span className={cn('relative z-10', isBid ? 'text-text-primary' : 'text-text-muted')}>
        {formatSize(level.size)}
      </span>
      <span className={cn('relative z-10 text-right', textColor)}>
        ${level.price.toFixed(2)}
      </span>
    </div>
  );
});

export default Orderbook;
