'use client';

import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { api } from '@/lib/api';
import { getWebSocket } from '@/lib/websocket';
import { cn } from '@/lib/utils';
import { useOrderbookStore } from '@/stores/orderbookStore';

interface OrderLevel {
  price: number;
  size: number;
}

interface MiniOrderbookProps {
  marketAddress: string;
  outcome: 'YES' | 'NO';
  className?: string;
  levels?: number;
}

/**
 * Mini orderbook for single outcome (YES or NO)
 */
export function MiniOrderbook({ 
  marketAddress, 
  outcome, 
  className,
  levels = 5 
}: MiniOrderbookProps) {
  const [bids, setBids] = useState<OrderLevel[]>([]);
  const [asks, setAsks] = useState<OrderLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const subscribed = useRef(false);

  const fetchOrderbook = useCallback(async (isInitial = false) => {
    if (!marketAddress) return;
    
    try {
      if (isInitial) setLoading(true);
      
      const response = await api.getOrderbook(marketAddress) as any;
      
      // Get data for the specific outcome
      const outcomeData = outcome === 'YES' ? response.yes : response.no;
      const bidLevels: OrderLevel[] = (outcomeData?.bids || response.bids || [])
        .map(([price, size]: [number, number]) => ({ price, size }))
        .filter((l: OrderLevel) => l.price >= 0.01 && l.price <= 0.99);
      const askLevels: OrderLevel[] = (outcomeData?.asks || response.asks || [])
        .map(([price, size]: [number, number]) => ({ price, size }))
        .filter((l: OrderLevel) => l.price >= 0.01 && l.price <= 0.99);
      
      setBids(bidLevels.slice(0, levels));
      setAsks(askLevels.slice(0, levels));
    } catch (err) {
      console.error('[MiniOrderbook] Error:', err);
    } finally {
      setLoading(false);
    }
  }, [marketAddress, outcome, levels]);

  useEffect(() => {
    if (!marketAddress) return;

    const ws = getWebSocket();
    
    const unsubscribe = ws.onMessage((message: any) => {
      if (message.channel !== 'orderbook') return;
      if (message.market !== marketAddress) return;
      if (message.data?.outcome && message.data.outcome !== outcome) return;
      
      const data = message.data;
      if (!data) return;
      
      const newBids = (data.bids || [])
        .map(([price, size]: [number, number]) => ({ price, size }))
        .filter((l: OrderLevel) => l.price >= 0.01 && l.price <= 0.99);
      const newAsks = (data.asks || [])
        .map(([price, size]: [number, number]) => ({ price, size }))
        .filter((l: OrderLevel) => l.price >= 0.01 && l.price <= 0.99);
      
      if (newBids.length > 0 || newAsks.length > 0) {
        setBids(newBids.slice(0, levels));
        setAsks(newAsks.slice(0, levels));
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

    fetchOrderbook(true);

    return () => {
      unsubscribe();
      unsubscribeConnect();
      if (subscribed.current && marketAddress) {
        ws.unsubscribeOrderbook(marketAddress);
        subscribed.current = false;
      }
    };
  }, [marketAddress, outcome, levels, fetchOrderbook]);

  const maxSize = Math.max(
    ...bids.map(b => b.size || 0),
    ...asks.map(a => a.size || 0),
    1
  );

  if (loading && bids.length === 0) {
    return (
      <div className={cn('text-center text-xs text-text-muted py-2', className)}>
        Loading...
      </div>
    );
  }

  if (bids.length === 0 && asks.length === 0) {
    return (
      <div className={cn('text-center text-xs text-text-muted py-2', className)}>
        No liquidity
      </div>
    );
  }

  const isYes = outcome === 'YES';
  const bidColor = isYes ? 'bg-long' : 'bg-short';
  const askColor = isYes ? 'bg-long/50' : 'bg-short/50';

  const sortedAsks = [...asks].sort((a, b) => b.price - a.price);
  const sortedBids = [...bids].sort((a, b) => b.price - a.price);
  
  const bestBid = sortedBids[0]?.price || 0;
  const bestAsk = sortedAsks[sortedAsks.length - 1]?.price || 0;
  const spread = bestAsk > bestBid ? bestAsk - bestBid : 0;

  return (
    <div className={cn('space-y-0.5', className)}>
      <div className="flex justify-between text-[8px] text-text-muted px-0.5 uppercase">
        <span>Size</span>
        <span>Price</span>
      </div>
      
      {sortedAsks.slice(0, levels).map((ask, i) => (
        <OrderRow 
          key={`ask-${i}`}
          price={ask.price}
          size={ask.size}
          maxSize={maxSize}
          type="ask"
          color={askColor}
        />
      ))}
      
      {spread > 0 && (
        <div className="text-center text-[8px] text-text-muted py-0.5 border-y border-border/30">
          spread ${spread.toFixed(2)}
        </div>
      )}
      
      {sortedBids.slice(0, levels).map((bid, i) => (
        <OrderRow 
          key={`bid-${i}`}
          price={bid.price}
          size={bid.size}
          maxSize={maxSize}
          type="bid"
          color={bidColor}
        />
      ))}
    </div>
  );
}

const OrderRow = memo(function OrderRow({ 
  price, 
  size, 
  maxSize,
  type,
  color,
}: { 
  price: number;
  size: number;
  maxSize: number;
  type: 'bid' | 'ask';
  color: string;
}) {
  const [flash, setFlash] = useState(false);
  const prevSizeRef = useRef(size);
  
  useEffect(() => {
    if (prevSizeRef.current !== size) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 300);
      prevSizeRef.current = size;
      return () => clearTimeout(timer);
    }
  }, [size]);
  
  const percent = ((size || 0) / maxSize) * 100;
  const isBid = type === 'bid';

  return (
    <div className={cn(
      'relative flex justify-between items-center h-4 text-[9px] font-mono px-0.5',
      flash && (size > prevSizeRef.current ? 'animate-flash-green' : 'animate-flash-red')
    )}>
      <div 
        className={cn(
          'absolute top-0 bottom-0 opacity-25 rounded-sm transition-all duration-150',
          color,
          isBid ? 'left-0' : 'right-0'
        )}
        style={{ width: `${Math.min(100, percent)}%` }}
      />
      <span className={cn('relative z-10', isBid ? 'text-long' : 'text-short')}>
        {(size || 0).toFixed(0)}
      </span>
      <span className="relative z-10 text-text-secondary">
        ${(price || 0).toFixed(2)}
      </span>
    </div>
  );
});

/**
 * Dual orderbook showing both YES and NO sides with live updates
 * Professional trading interface style
 */
export function DualMiniOrderbook({ 
  marketAddress,
  className,
}: { 
  marketAddress: string;
  className?: string;
}) {
  const subscribed = useRef(false);
  const { yes, no, setBothOrderbooks, setOrderbook, updateLevel } = useOrderbookStore();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!marketAddress) return;

    const fetchData = async () => {
      try {
        setLoading(true);
        const response = await api.getOrderbook(marketAddress) as any;
        
        const yesBids = (response.yes?.bids || response.bids || []) as [number, number][];
        const yesAsks = (response.yes?.asks || response.asks || []) as [number, number][];
        const noBids = (response.no?.bids || []) as [number, number][];
        const noAsks = (response.no?.asks || []) as [number, number][];
        
        setBothOrderbooks(yesBids, yesAsks, noBids, noAsks, response.sequenceId);
      } catch (err) {
        console.error('[DualMiniOrderbook] Error:', err);
      } finally {
        setLoading(false);
      }
    };

    const ws = getWebSocket();
    
    const unsubscribe = ws.onMessage((message: any) => {
      if (message.channel !== 'orderbook') return;
      if (message.market !== marketAddress) return;
      
      const data = message.data;
      if (!data) return;
      
      const outcome = (data.outcome as 'YES' | 'NO') || 'YES';
      const bids = (data.bids || []) as [number, number][];
      const asks = (data.asks || []) as [number, number][];
      
      // Snapshot or delta
      if (message.snapshot || bids.length > 3 || asks.length > 3) {
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

    fetchData();

    return () => {
      unsubscribe();
      unsubscribeConnect();
      if (subscribed.current && marketAddress) {
        ws.unsubscribeOrderbook(marketAddress);
        subscribed.current = false;
      }
    };
  }, [marketAddress, setBothOrderbooks, setOrderbook, updateLevel]);

  const maxSize = Math.max(
    ...yes.bids.map(b => b.size || 0),
    ...yes.asks.map(a => a.size || 0),
    ...no.bids.map(b => b.size || 0),
    ...no.asks.map(a => a.size || 0),
    1
  );

  if (loading && yes.bids.length === 0 && no.bids.length === 0) {
    return (
      <div className={cn('text-center text-xs text-text-muted py-3', className)}>
        Loading orderbook...
      </div>
    );
  }

  return (
    <div className={cn('grid grid-cols-2 gap-2', className)}>
      {/* YES Orderbook */}
      <CompactBookPanel 
        bids={yes.bids} 
        asks={yes.asks} 
        spread={yes.spread}
        maxSize={maxSize}
        outcome="YES"
        label="ABOVE"
        colorClass="long"
      />
      
      {/* NO Orderbook */}
      <CompactBookPanel 
        bids={no.bids} 
        asks={no.asks}
        spread={no.spread}
        maxSize={maxSize}
        outcome="NO"
        label="BELOW"
        colorClass="short"
      />
    </div>
  );
}

interface CompactBookPanelProps {
  bids: { price: number; size: number; flash?: 'up' | 'down' | null }[];
  asks: { price: number; size: number; flash?: 'up' | 'down' | null }[];
  spread: number;
  maxSize: number;
  outcome: 'YES' | 'NO';
  label: string;
  colorClass: 'long' | 'short';
}

const CompactBookPanel = memo(function CompactBookPanel({ 
  bids, 
  asks, 
  spread,
  maxSize,
  outcome,
  label,
  colorClass,
}: CompactBookPanelProps) {
  const bgColor = colorClass === 'long' ? 'bg-long' : 'bg-short';
  const textColor = colorClass === 'long' ? 'text-long' : 'text-short';
  
  const sortedAsks = [...asks].sort((a, b) => a.price - b.price);
  const sortedBids = [...bids].sort((a, b) => b.price - a.price);
  
  const hasLiquidity = sortedBids.length > 0 || sortedAsks.length > 0;

  return (
    <div className={cn(
      'rounded-lg overflow-hidden',
      colorClass === 'long' ? 'bg-long/5' : 'bg-short/5'
    )}>
      <div className="px-2 py-1.5 border-b border-border/30 text-center">
        <span className={cn('text-[10px] font-bold tracking-wider', textColor)}>
          {label}
        </span>
        <span className="text-[9px] text-text-muted ml-1">({outcome})</span>
      </div>
      
      <div className="flex justify-between text-[8px] text-text-muted px-2 py-1 border-b border-border/20">
        <span>SIZE</span>
        <span>PRICE</span>
      </div>
      
      {!hasLiquidity ? (
        <div className="text-[9px] text-text-muted text-center py-3">
          No liquidity
        </div>
      ) : (
        <>
          {/* Asks - reversed so lowest is at bottom */}
          {[...sortedAsks].reverse().slice(0, 3).map((ask, i) => (
            <CompactRow 
              key={`ask-${i}-${ask.price.toFixed(2)}`}
              price={ask.price}
              size={ask.size}
              flash={ask.flash}
              maxSize={maxSize}
              side="ask"
              bgColor={bgColor}
              textColor={textColor}
            />
          ))}
          
          {/* Spread */}
          {spread > 0 && (
            <div className="text-center text-[8px] text-text-muted py-0.5 border-y border-border/30">
              ${spread.toFixed(2)}
            </div>
          )}
          
          {/* Bids */}
          {sortedBids.slice(0, 3).map((bid, i) => (
            <CompactRow 
              key={`bid-${i}-${bid.price.toFixed(2)}`}
              price={bid.price}
              size={bid.size}
              flash={bid.flash}
              maxSize={maxSize}
              side="bid"
              bgColor={bgColor}
              textColor={textColor}
            />
          ))}
        </>
      )}
    </div>
  );
});

interface CompactRowProps {
  price: number;
  size: number;
  flash?: 'up' | 'down' | null;
  maxSize: number;
  side: 'bid' | 'ask';
  bgColor: string;
  textColor: string;
}

const CompactRow = memo(function CompactRow({
  price,
  size,
  flash: propFlash,
  maxSize,
  side,
  bgColor,
  textColor,
}: CompactRowProps) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevSizeRef = useRef(size);
  
  // Handle flash from props or size change
  useEffect(() => {
    if (propFlash) {
      setFlash(propFlash);
      const timer = setTimeout(() => setFlash(null), 300);
      return () => clearTimeout(timer);
    }
  }, [propFlash]);
  
  useEffect(() => {
    if (prevSizeRef.current !== size && !propFlash) {
      setFlash(size > prevSizeRef.current ? 'up' : 'down');
      const timer = setTimeout(() => setFlash(null), 300);
      prevSizeRef.current = size;
      return () => clearTimeout(timer);
    }
    prevSizeRef.current = size;
  }, [size, propFlash]);
  
  const pct = (size / maxSize) * 100;
  const isBid = side === 'bid';

  return (
    <div className={cn(
      'relative flex justify-between items-center h-4 text-[9px] font-mono px-2',
      flash === 'up' && 'animate-flash-green',
      flash === 'down' && 'animate-flash-red'
    )}>
      <div 
        className={cn(
          'absolute top-0 bottom-0 opacity-20 transition-all duration-150',
          bgColor,
          isBid ? 'left-0' : 'right-0'
        )}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
      <span className={cn('relative z-10', isBid ? 'text-text-primary' : 'text-text-muted')}>
        {size.toFixed(0)}
      </span>
      <span className={cn('relative z-10', textColor)}>
        ${price.toFixed(2)}
      </span>
    </div>
  );
});
