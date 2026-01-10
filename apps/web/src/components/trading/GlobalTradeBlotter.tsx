'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { getGlobalTrades, type GlobalTrade } from '@/lib/api';
import { getWebSocket, type GlobalTradeUpdate } from '@/lib/websocket';
import { 
  Activity, 
  ExternalLink, 
  RefreshCw, 
  ArrowUpRight, 
  ArrowDownRight,
  Globe
} from 'lucide-react';

interface GlobalTradeBlotterProps {
  className?: string;
  maxTrades?: number;
  compact?: boolean;
}

export function GlobalTradeBlotter({ className, maxTrades = 30, compact = false }: GlobalTradeBlotterProps) {
  const [trades, setTrades] = useState<GlobalTrade[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTradeId, setNewTradeId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  
  // Track trades we've seen to detect new ones
  const seenTradesRef = useRef(new Set<string>());
  const subscribedRef = useRef(false);

  // Fetch initial trades
  const fetchTrades = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await getGlobalTrades({ limit: maxTrades });
      setTrades(response.trades);
      // Mark all initial trades as seen
      response.trades.forEach(t => seenTradesRef.current.add(t.id));
    } catch (err) {
      setError('Failed to load trades');
      console.error('Failed to fetch global trades:', err);
    } finally {
      setIsLoading(false);
    }
  }, [maxTrades]);

  // Initial fetch and WebSocket setup
  useEffect(() => {
    fetchTrades();
    
    const ws = getWebSocket();
    
    // Handle incoming messages
    const unsubscribeMessage = ws.onMessage((message) => {
      // Check if this is a global trade message
      if (message.channel !== 'trades:global') return;
      
      const tradeData = (message as GlobalTradeUpdate).data;
      const newTrade: GlobalTrade = {
        ...tradeData,
        txStatus: 'PENDING',
        solanaExplorerUrl: tradeData.txSignature 
          ? `https://explorer.solana.com/tx/${tradeData.txSignature}` 
          : null,
        marketExpiry: 0,
      };
      
      // Only add if we haven't seen this trade
      if (!seenTradesRef.current.has(newTrade.id)) {
        seenTradesRef.current.add(newTrade.id);
        
        setTrades(prev => {
          // Add new trade at the beginning, remove oldest if over limit
          const updated = [newTrade, ...prev];
          if (updated.length > maxTrades) {
            const removed = updated.pop();
            if (removed) seenTradesRef.current.delete(removed.id);
          }
          return updated;
        });
        
        // Trigger highlight animation
        setNewTradeId(newTrade.id);
        setTimeout(() => setNewTradeId(null), 2000);
      }
    });
    
    // Handle connection state
    const handleConnect = () => {
      setIsConnected(true);
      if (!subscribedRef.current) {
        ws.subscribeGlobalTrades();
        subscribedRef.current = true;
      }
    };
    
    const handleDisconnect = () => {
      setIsConnected(false);
      subscribedRef.current = false;
    };
    
    const unsubscribeConnect = ws.onConnect(handleConnect);
    const unsubscribeDisconnect = ws.onDisconnect(handleDisconnect);
    
    // Subscribe if already connected
    if (ws.isConnected) {
      setIsConnected(true);
      ws.subscribeGlobalTrades();
      subscribedRef.current = true;
    } else {
      // Connect if not already
      ws.connect().catch(console.error);
    }
    
    return () => {
      unsubscribeMessage();
      unsubscribeConnect();
      unsubscribeDisconnect();
      if (subscribedRef.current) {
        ws.unsubscribeGlobalTrades();
        subscribedRef.current = false;
      }
    };
  }, [fetchTrades, maxTrades]);

  // Format time ago
  const formatTimeAgo = (timestamp: number) => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  if (compact) {
    return (
      <div className={cn('bg-surface rounded-lg border border-border overflow-hidden h-full flex flex-col', className)}>
        {/* Compact Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-surface-light/30 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-accent" />
            <h2 className="font-bold text-sm">Trade Feed</h2>
            <div className={cn(
              'w-2 h-2 rounded-full',
              isConnected ? 'bg-long animate-pulse' : 'bg-text-muted'
            )} />
          </div>
          <button 
            onClick={fetchTrades}
            className="p-1 hover:bg-surface-light rounded transition-colors"
            disabled={isLoading}
          >
            <RefreshCw className={cn('w-4 h-4 text-text-muted', isLoading && 'animate-spin')} />
          </button>
        </div>

        {/* Compact Trade List */}
        <div className="flex-1 overflow-auto">
          {isLoading && trades.length === 0 ? (
            <div className="divide-y divide-border/50">
              {[1, 2, 3].map(i => (
                <div key={i} className="px-3 py-2.5 flex items-center gap-3">
                  <div className="w-16 h-4 rounded skeleton" />
                  <div className="flex-1">
                    <div className="w-10 h-4 rounded skeleton" />
                  </div>
                  <div className="w-12 h-4 rounded skeleton" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="text-center py-4 text-text-muted text-sm">
              <p>{error}</p>
              <button onClick={fetchTrades} className="mt-1 text-accent hover:underline text-xs">Retry</button>
            </div>
          ) : trades.length === 0 ? (
            <div className="text-center py-6 text-text-muted">
              <Activity className="w-5 h-5 mx-auto opacity-20 mb-1" />
              <p className="text-sm">No trades yet</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="text-[10px] text-text-muted uppercase tracking-wider border-b border-border/50 bg-surface-light/5 sticky top-0">
                  <th className="px-3 py-2 font-bold">Market</th>
                  <th className="px-2 py-2 font-bold text-right">Size</th>
                  <th className="px-2 py-2 font-bold text-right">Price</th>
                  <th className="px-3 py-2 font-bold text-right">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {trades.map((trade) => (
                  <CompactTradeRow 
                    key={trade.id} 
                    trade={trade} 
                    isNew={trade.id === newTradeId}
                    formatTimeAgo={formatTimeAgo}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('bg-surface rounded-xl border border-border overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-surface-light/30 border-b border-border">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-accent" />
          <h2 className="font-bold text-lg">Global Trade Feed</h2>
          <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-accent/10 text-accent uppercase tracking-wide">
            Live
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* Connection status */}
          <div className={cn(
            'flex items-center gap-1.5 text-xs',
            isConnected ? 'text-long' : 'text-text-muted'
          )}>
            <div className={cn(
              'w-2 h-2 rounded-full',
              isConnected ? 'bg-long animate-pulse' : 'bg-text-muted'
            )} />
            <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
          
          <button 
            onClick={fetchTrades}
            className="p-2 hover:bg-surface-light rounded-lg transition-colors btn-press"
            disabled={isLoading}
            title="Refresh trades"
          >
            <RefreshCw className={cn('w-4 h-4 text-text-muted', isLoading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Trade List */}
      <div className="max-h-[300px] overflow-y-auto">
        {isLoading && trades.length === 0 ? (
          <div className="divide-y divide-border/50">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="px-4 py-3 flex items-center gap-4">
                <div className="w-16 h-6 rounded skeleton" />
                <div className="flex-1 space-y-1">
                  <div className="w-24 h-4 rounded skeleton" />
                  <div className="w-16 h-3 rounded skeleton" />
                </div>
                <div className="w-20 h-5 rounded skeleton" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-8 text-text-muted">
            <p>{error}</p>
            <button 
              onClick={fetchTrades}
              className="mt-2 text-accent hover:underline text-sm"
            >
              Try again
            </button>
          </div>
        ) : trades.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            <Activity className="w-8 h-8 mx-auto opacity-20 mb-2" />
            <p>No trades yet</p>
            <p className="text-xs mt-1">Trades will appear here in real-time</p>
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-[9px] text-text-muted uppercase tracking-widest border-b border-border bg-surface-light/10 sticky top-0 z-10">
                <th className="px-4 py-2 font-bold">Market</th>
                <th className="px-2 py-2 font-bold text-center">Side</th>
                <th className="px-2 py-2 font-bold text-right">Size</th>
                <th className="px-2 py-2 font-bold text-right">Price</th>
                <th className="px-2 py-2 font-bold text-right">Value</th>
                <th className="px-3 py-2 font-bold text-right">Time</th>
                <th className="px-3 py-2 font-bold text-center">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {trades.map((trade) => (
                <TradeRow 
                  key={trade.id} 
                  trade={trade} 
                  isNew={trade.id === newTradeId}
                  formatTimeAgo={formatTimeAgo}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function CompactTradeRow({ 
  trade, 
  isNew,
  formatTimeAgo 
}: { 
  trade: GlobalTrade; 
  isNew: boolean;
  formatTimeAgo: (ts: number) => string;
}) {
  const isBuy = trade.side === 'buy';
  const isYes = trade.outcome === 'yes';
  
  return (
    <tr className={cn(
      'transition-all duration-300',
      isNew ? 'bg-accent/20' : 'hover:bg-surface-light/30'
    )}>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="font-bold text-sm truncate max-w-[80px]">{trade.market}</span>
          <span className={cn(
            'px-1.5 py-0.5 rounded text-[9px] font-black',
            isYes ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
          )}>
            {isYes ? '↑' : '↓'}
          </span>
          <span className={cn(
            'text-[9px] font-bold',
            isBuy ? 'text-long' : 'text-short'
          )}>
            {isBuy ? 'B' : 'S'}
          </span>
        </div>
      </td>
      <td className="px-2 py-2.5 text-right">
        <span className="font-mono text-sm font-bold">{trade.size.toFixed(0)}</span>
      </td>
      <td className="px-2 py-2.5 text-right">
        <span className="font-mono text-sm">${trade.price.toFixed(2)}</span>
      </td>
      <td className="px-3 py-2.5 text-right">
        <span className="text-xs text-text-muted">{formatTimeAgo(trade.timestamp)}</span>
      </td>
    </tr>
  );
}

function TradeRow({ 
  trade, 
  isNew,
  formatTimeAgo 
}: { 
  trade: GlobalTrade; 
  isNew: boolean;
  formatTimeAgo: (ts: number) => string;
}) {
  const isBuy = trade.side === 'buy';
  const isYes = trade.outcome === 'yes';
  
  return (
    <tr className={cn(
      'transition-all duration-500',
      isNew ? 'bg-accent/20 animate-pulse' : 'hover:bg-surface-light/30'
    )}>
      {/* Market */}
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-bold text-xs">{trade.market}</span>
          <span className={cn(
            'px-1.5 py-0.5 rounded text-[8px] font-black uppercase',
            isYes ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
          )}>
            {trade.outcome === 'yes' ? 'ABOVE' : 'BELOW'}
          </span>
        </div>
      </td>
      
      {/* Side */}
      <td className="px-2 py-2.5 text-center">
        <span className={cn(
          'inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold uppercase',
          isBuy ? 'bg-long/10 text-long' : 'bg-short/10 text-short'
        )}>
          {isBuy ? (
            <ArrowUpRight className="w-3 h-3" />
          ) : (
            <ArrowDownRight className="w-3 h-3" />
          )}
          {trade.side}
        </span>
      </td>
      
      {/* Size */}
      <td className="px-2 py-2.5 text-right">
        <span className="font-mono text-xs font-bold">{trade.size.toFixed(0)}</span>
      </td>
      
      {/* Price */}
      <td className="px-2 py-2.5 text-right">
        <span className="font-mono text-xs">${trade.price.toFixed(2)}</span>
      </td>
      
      {/* Value */}
      <td className="px-2 py-2.5 text-right">
        <span className="font-mono text-xs text-text-muted">${trade.notional.toFixed(2)}</span>
      </td>
      
      {/* Time */}
      <td className="px-3 py-2.5 text-right">
        <span className="text-[10px] text-text-muted">{formatTimeAgo(trade.timestamp)}</span>
      </td>
      
      {/* Transaction Link */}
      <td className="px-3 py-2.5 text-center">
        {trade.solscanUrl ? (
          <a
            href={trade.solscanUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 text-text-muted hover:text-accent hover:bg-accent/10 rounded-lg transition-all inline-flex"
            title={`View on Solscan: ${trade.txSignature?.slice(0, 8)}...`}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        ) : trade.txSignature ? (
          <a
            href={`https://solscan.io/tx/${trade.txSignature}`}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 text-text-muted hover:text-accent hover:bg-accent/10 rounded-lg transition-all inline-flex"
            title={`View on Solscan: ${trade.txSignature.slice(0, 8)}...`}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        ) : (
          <span className="text-text-muted/50 text-[9px]">pending</span>
        )}
      </td>
    </tr>
  );
}
