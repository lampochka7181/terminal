'use client';

import { useState, useEffect, useMemo } from 'react';
import { useUser } from '@/hooks/useUser';
import { cn } from '@/lib/utils';
import { Clock, TrendingUp, TrendingDown, X, RefreshCw, ArrowRightLeft } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useOrder } from '@/hooks/useOrder';
import type { Position as ApiPosition, Order as ApiOrder } from '@/lib/api';

type Tab = 'active' | 'history';

interface UnifiedTrade {
  id: string;
  type: 'position' | 'order';
  market: string;
  marketAddress: string;
  asset: string;
  expiryAt: number;
  outcome: 'YES' | 'NO';
  side: 'BID' | 'ASK';
  size: number;        // shares for position, total size for order
  filled: number;      // shares for position (always == size), filledSize for order
  price: number;       // avgEntry for position, limit price for order
  currentPrice: number; // current market price
  pnl?: number;
  pnlPercent?: number;
  status: string;
  createdAt: number;
}

export function Positions({ onSell }: { onSell?: (marketAddress: string, outcome: 'YES' | 'NO', shares: number, avgEntry: number, price: number, timeframe: any, expiry: number) => void }) {
  const [activeTab, setActiveTab] = useState<Tab>('active');
  const { isAuthenticated } = useAuthStore();
  const { cancelOrder, isCancelling } = useOrder();
  
  const { 
    positions: apiPositions, 
    orders: apiOrders, 
    positionsLoading,
    ordersLoading,
    refetchAll
  } = useUser();

  const handleCancel = async (orderId: string) => {
    if (confirm('Are you sure you want to cancel this order?')) {
      const success = await cancelOrder(orderId);
      if (success) {
        refetchAll();
      }
    }
  };

  // Process positions into unified format
  const positions: UnifiedTrade[] = useMemo(() => {
    return (apiPositions || [])
      .filter((p: ApiPosition) => p.yesShares > 0 || p.noShares > 0)
      .flatMap((p: ApiPosition) => {
        const results: UnifiedTrade[] = [];
        const asset = p.asset || p.market.split('-')[0] || 'BTC';
        const expiryAt = p.expiryAt || 0;
        
        if (p.yesShares > 0) {
          const pnl = (p.currentPrice - p.avgEntryPrice) * p.yesShares;
          const pnlPercent = p.avgEntryPrice > 0 ? ((p.currentPrice - p.avgEntryPrice) / p.avgEntryPrice) * 100 : 0;
          results.push({
            id: `pos-${p.marketAddress}-yes`,
            type: 'position',
            market: p.market,
            marketAddress: p.marketAddress,
            asset,
            expiryAt,
            outcome: 'YES',
            side: 'BID',
            size: p.yesShares,
            filled: p.yesShares,
            price: p.avgEntryPrice,
            currentPrice: p.currentPrice,
            pnl,
            pnlPercent,
            status: p.status.toUpperCase(),
            createdAt: p.createdAt || 0, 
          });
        }
        
        if (p.noShares > 0) {
          const noCurrentPrice = 1 - p.currentPrice;
          const noAvgEntry = p.avgEntryPrice;
          const pnl = (noCurrentPrice - noAvgEntry) * p.noShares;
          const pnlPercent = noAvgEntry > 0 ? ((noCurrentPrice - noAvgEntry) / noAvgEntry) * 100 : 0;
          results.push({
            id: `pos-${p.marketAddress}-no`,
            type: 'position',
            market: p.market,
            marketAddress: p.marketAddress,
            asset,
            expiryAt,
            outcome: 'NO',
            side: 'BID',
            size: p.noShares,
            filled: p.noShares,
            price: noAvgEntry,
            currentPrice: noCurrentPrice,
            pnl,
            pnlPercent,
            status: p.status.toUpperCase(),
            createdAt: p.createdAt || 0,
          });
        }
        
        return results;
      });
  }, [apiPositions]);

  // Process orders into unified format
  const orders: UnifiedTrade[] = useMemo(() => {
    return (apiOrders || [])
      .filter((o: ApiOrder) => o.status === 'open' || o.status === 'partial' || o.status === 'filled')
      .map((o: ApiOrder) => ({
        id: `ord-${o.id}`,
        type: 'order',
        market: o.market,
        marketAddress: o.marketAddress,
        asset: o.asset || o.market.split('-')[0] || 'BTC',
        expiryAt: o.expiryAt || 0,
        side: o.side.toUpperCase() as 'BID' | 'ASK',
        outcome: o.outcome.toUpperCase() as 'YES' | 'NO',
        size: o.size,
        filled: o.filledSize,
        price: o.price,
        currentPrice: 0, 
        status: o.status.toUpperCase(),
        createdAt: o.createdAt,
      }));
  }, [apiOrders]);

  // Combine and sort: Orders first (by creation time), then Positions
  const combinedActive = useMemo(() => {
    return [...orders, ...positions].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'order' ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
  }, [orders, positions]);
  
  const totalPnl = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
  const totalValue = positions.reduce((sum, p) => sum + (p.size * p.currentPrice), 0);
  const isLoading = positionsLoading || ordersLoading;

  if (!isAuthenticated) {
    return (
      <div className="bg-surface rounded-xl border border-border p-8 h-full flex flex-col items-center justify-center text-center space-y-4">
        <div className="w-12 h-12 bg-surface-light rounded-full flex items-center justify-center">
          <Clock className="w-6 h-6 text-text-muted" />
        </div>
        <div>
          <h3 className="font-bold text-lg">Portfolio Locked</h3>
          <p className="text-text-muted text-sm max-w-xs">Connect your wallet to see your active positions and open orders.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden h-full flex flex-col">
      <div className="flex items-center justify-between p-4 bg-surface-light/30 border-b border-border">
        <div className="flex gap-1">
          {(['active', 'history'] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'px-4 py-2 text-sm font-bold rounded-lg transition-all capitalize',
                activeTab === tab
                  ? 'bg-accent text-background shadow-sm'
                  : 'text-text-muted hover:text-text-primary hover:bg-surface-light'
              )}
            >
              {tab === 'active' ? 'Live Trades' : tab}
              {tab === 'active' && combinedActive.length > 0 && (
                <span className={cn(
                  "ml-2 px-1.5 py-0.5 text-[10px] rounded-full font-black",
                  activeTab === tab ? "bg-background/20 text-background" : "bg-accent/20 text-accent"
                )}>
                  {combinedActive.length}
                </span>
              )}
            </button>
          ))}
        </div>
        
        <div className="flex items-center gap-4">
          <button 
            onClick={() => refetchAll()}
            className="p-2 hover:bg-surface-light rounded-lg transition-colors"
            disabled={isLoading}
          >
            <RefreshCw className={cn("w-4 h-4 text-text-muted", isLoading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {activeTab === 'active' && (
          <UnifiedTable 
            trades={combinedActive} 
            isLoading={isLoading} 
            onSell={onSell} 
            onCancel={handleCancel}
            isCancelling={isCancelling}
          />
        )}
        {activeTab === 'history' && (
          <div className="text-center py-12 text-text-muted space-y-2">
            <Clock className="w-8 h-8 mx-auto opacity-20" />
            <p>No trade history yet</p>
          </div>
        )}
      </div>

      {activeTab === 'active' && positions.length > 0 && (
        <div className="px-4 py-3 bg-surface-light/50 border-t border-border flex items-center justify-between text-sm">
          <div className="flex items-center gap-4">
            <span className="text-text-muted">Net Exposure: <span className="font-mono text-text-primary font-bold">${totalValue.toFixed(2)}</span></span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-text-muted">Total P&L:</span>
            <span className={cn(
              'font-mono font-black flex items-center gap-1',
              totalPnl >= 0 ? 'text-long' : 'text-short'
            )}>
              {totalPnl >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {totalPnl >= 0 ? '+' : ''}${Math.abs(totalPnl).toFixed(2)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function UnifiedTable({ 
  trades, 
  isLoading, 
  onSell,
  onCancel,
  isCancelling
}: { 
  trades: UnifiedTrade[]; 
  isLoading: boolean;
  onSell?: (marketAddress: string, outcome: 'YES' | 'NO', shares: number, avgEntry: number, price: number, timeframe: any, expiry: number) => void;
  onCancel: (id: string) => void;
  isCancelling: boolean;
}) {
  if (isLoading && trades.length === 0) {
    return (
      <div className="divide-y divide-border">
        {[1, 2, 3].map(i => <div key={i} className="h-16 bg-surface animate-pulse" />)}
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="text-center py-16 text-text-muted">
        <TrendingUp className="w-8 h-8 mx-auto opacity-20 mb-2" />
        <p>No active trades or positions</p>
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden">
      <table className="w-full text-left border-collapse table-fixed">
        <thead>
          <tr className="text-[9px] sm:text-[10px] text-text-muted uppercase tracking-widest border-b border-border bg-surface-light/10">
            <th className="px-2 sm:px-4 py-3 font-bold w-[30%]">Market</th>
            <th className="px-2 py-3 font-bold text-right w-[15%]">Size</th>
            <th className="px-2 py-3 font-bold text-right w-[18%]">Avg Price</th>
            <th className="px-2 py-3 font-bold text-right w-[15%]">Fill %</th>
            <th className="px-2 py-3 font-bold text-right w-[15%]">PnL</th>
            <th className="px-2 sm:px-4 py-3 font-bold text-right w-[7%]"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {trades.map((trade) => (
            <TradeRow 
              key={trade.id} 
              trade={trade} 
              onSell={onSell} 
              onCancel={onCancel}
              isCancelling={isCancelling}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradeRow({ 
  trade, 
  onSell,
  onCancel,
  isCancelling
}: { 
  trade: UnifiedTrade;
  onSell?: (marketAddress: string, outcome: 'YES' | 'NO', shares: number, avgEntry: number, price: number, timeframe: any, expiry: number) => void;
  onCancel: (id: string) => void;
  isCancelling: boolean;
}) {
  const timeframe = trade.market.split('-')[1];
  const fillPercent = (trade.filled / trade.size) * 100;
  const isOrder = trade.type === 'order';

  return (
    <tr className={cn(
      "hover:bg-surface-light/30 transition-colors group",
      isOrder && "bg-accent/5"
    )}>
      <td className="px-2 sm:px-4 py-3">
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-1.5 overflow-hidden">
            <span className="font-bold text-xs sm:text-sm truncate">{trade.market}</span>
            <span className={cn(
              'px-1 py-0.5 rounded text-[8px] sm:text-[9px] font-black uppercase flex-shrink-0',
              trade.outcome === 'YES' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
            )}>
              {trade.outcome}
            </span>
            {isOrder && (
              <span className="px-1 py-0.5 rounded text-[8px] bg-accent/20 text-accent font-black uppercase">PENDING</span>
            )}
          </div>
          <div className="flex items-center gap-1 text-[9px] text-text-muted font-mono mt-0.5">
            <Clock className="w-2.5 h-2.5" />
            <ExpiryCountdown expiry={trade.expiryAt} />
          </div>
        </div>
      </td>
      <td className="px-2 py-3 text-right font-mono text-xs sm:text-sm font-medium truncate">
        {trade.size.toFixed(0)}
      </td>
      <td className="px-2 py-3 text-right">
        <div className="flex flex-col items-end">
          <span className="text-text-primary font-bold text-xs sm:text-sm">${trade.price.toFixed(2)}</span>
          {!isOrder && (
            <span className="text-[9px] sm:text-[10px] text-text-muted">Now: ${trade.currentPrice.toFixed(2)}</span>
          )}
        </div>
      </td>
      <td className="px-2 py-3 text-right">
        <div className="flex flex-col items-end">
          <span className="font-mono text-xs font-bold text-text-primary">
            {fillPercent.toFixed(0)}%
          </span>
          <div className="w-12 h-1 bg-surface-light rounded-full overflow-hidden mt-1 border border-border/50">
            <div 
              className={cn(
                "h-full transition-all duration-1000",
                isOrder ? "bg-accent" : "bg-long"
              )}
              style={{ width: `${fillPercent}%` }} 
            />
          </div>
        </div>
      </td>
      <td className="px-2 py-3 text-right">
        {trade.pnl !== undefined ? (
          <div className="flex flex-col items-end">
            <div className={cn(
              'font-mono text-xs sm:text-sm font-black flex items-center gap-0.5',
              trade.pnl >= 0 ? 'text-long' : 'text-short'
            )}>
              {trade.pnl >= 0 ? '+' : '-'}${Math.abs(trade.pnl).toFixed(2)}
            </div>
            <div className={cn(
              'text-[9px] sm:text-[10px] font-bold',
              (trade.pnlPercent || 0) >= 0 ? 'text-long/70' : 'text-short/70'
            )}>
              {(trade.pnlPercent || 0) >= 0 ? '+' : ''}{trade.pnlPercent?.toFixed(1)}%
            </div>
          </div>
        ) : (
          <span className="text-text-muted font-mono">--</span>
        )}
      </td>
      <td className="px-2 sm:px-4 py-3 text-right">
        {isOrder ? (
          <button 
            onClick={() => onCancel(trade.id.replace('ord-', ''))}
            disabled={isCancelling}
            className="p-1.5 text-text-muted hover:text-short hover:bg-short/10 rounded-lg transition-all"
            title="Cancel Order"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button 
            onClick={() => onSell?.(
              trade.marketAddress, 
              trade.outcome, 
              trade.size, 
              trade.price, 
              trade.currentPrice,
              timeframe,
              trade.expiryAt
            )}
            className="p-1.5 text-text-muted hover:text-warning hover:bg-warning/10 rounded-lg transition-all"
            title="Sell Position"
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
          </button>
        )}
      </td>
    </tr>
  );
}

function ExpiryCountdown({ expiry }: { expiry: number }) {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    if (!expiry) {
      setTimeLeft('--');
      return;
    }

    const update = () => {
      const now = Date.now();
      const diff = expiry - now;
      
      if (diff <= 0) {
        setTimeLeft('Expired');
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const secs = Math.floor((diff % (1000 * 60)) / 1000);

      if (hours > 0) {
        setTimeLeft(`${hours}h ${mins}m`);
      } else if (mins > 0) {
        setTimeLeft(`${mins}m ${secs}s`);
      } else {
        setTimeLeft(`${secs}s`);
      }
    };

    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [expiry]);

  return <span>{timeLeft}</span>;
}
