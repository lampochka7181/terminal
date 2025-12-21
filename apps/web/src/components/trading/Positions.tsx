'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { Clock, TrendingUp, TrendingDown, X, RefreshCw } from 'lucide-react';
import { getUserPositions, getUserOrders, type Position as ApiPosition, type Order as ApiOrder } from '@/lib/api';
import { useUserStore } from '@/stores/userStore';

type Tab = 'positions' | 'orders' | 'history';

interface Position {
  id: string;
  market: string;
  marketAddress: string;
  outcome: 'YES' | 'NO';
  shares: number;
  avgEntry: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  totalCost: number;
}

interface Order {
  id: string;
  market: string;
  marketAddress: string;
  side: 'BID' | 'ASK';
  outcome: 'YES' | 'NO';
  price: number;
  size: number;
  filled: number;
  remaining: number;
  status: 'OPEN' | 'PARTIAL';
  createdAt: number;
}

export function Positions() {
  const [activeTab, setActiveTab] = useState<Tab>('positions');
  const { isAuthenticated } = useUserStore();

  // Fetch positions from API
  const { data: positionsData, isLoading: positionsLoading, refetch: refetchPositions } = useQuery({
    queryKey: ['positions', 'open'],
    queryFn: () => getUserPositions({ status: 'open' }),
    enabled: isAuthenticated,
    staleTime: 10000,
    refetchInterval: 30000,
  });

  // Fetch orders from API
  const { data: ordersData, isLoading: ordersLoading, refetch: refetchOrders } = useQuery({
    queryKey: ['orders', 'open'],
    queryFn: () => getUserOrders({ status: 'open' }),
    enabled: isAuthenticated,
    staleTime: 10000,
    refetchInterval: 30000,
  });

  // Transform API positions to our format
  const positions: Position[] = (positionsData || [])
    .filter((p: ApiPosition) => p.yesShares > 0 || p.noShares > 0)
    .flatMap((p: ApiPosition) => {
      const results: Position[] = [];
      
      if (p.yesShares > 0) {
        const pnl = (p.currentPrice - p.avgEntryPrice) * p.yesShares;
        const pnlPercent = p.avgEntryPrice > 0 ? ((p.currentPrice - p.avgEntryPrice) / p.avgEntryPrice) * 100 : 0;
        results.push({
          id: `${p.marketAddress}-yes`,
          market: p.market,
          marketAddress: p.marketAddress,
          outcome: 'YES',
          shares: p.yesShares,
          avgEntry: p.avgEntryPrice,
          currentPrice: p.currentPrice,
          pnl,
          pnlPercent,
          totalCost: p.avgEntryPrice * p.yesShares,
        });
      }
      
      if (p.noShares > 0) {
        const noCurrentPrice = 1 - p.currentPrice;
        const noAvgEntry = p.avgEntryPrice; // This should be avgEntryNo from API
        const pnl = (noCurrentPrice - noAvgEntry) * p.noShares;
        const pnlPercent = noAvgEntry > 0 ? ((noCurrentPrice - noAvgEntry) / noAvgEntry) * 100 : 0;
        results.push({
          id: `${p.marketAddress}-no`,
          market: p.market,
          marketAddress: p.marketAddress,
          outcome: 'NO',
          shares: p.noShares,
          avgEntry: noAvgEntry,
          currentPrice: noCurrentPrice,
          pnl,
          pnlPercent,
          totalCost: noAvgEntry * p.noShares,
        });
      }
      
      return results;
    });

  // Transform API orders to our format
  const orders: Order[] = (ordersData?.orders || []).map((o: ApiOrder) => ({
    id: o.id,
    market: o.market,
    marketAddress: o.marketAddress,
    side: o.side.toUpperCase() as 'BID' | 'ASK',
    outcome: o.outcome.toUpperCase() as 'YES' | 'NO',
    price: o.price,
    size: o.size,
    filled: o.filledSize,
    remaining: o.remainingSize,
    status: o.status.toUpperCase() as 'OPEN' | 'PARTIAL',
    createdAt: o.createdAt,
  }));
  
  const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0);
  const totalValue = positions.reduce((sum, p) => sum + (p.shares * p.currentPrice), 0);
  
  const isLoading = positionsLoading || ordersLoading;

  if (!isAuthenticated) {
    return (
      <div className="bg-surface rounded-lg border border-border p-4 h-full flex flex-col">
        <div className="text-center py-8 text-text-muted">
          Connect wallet to view positions
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-lg border border-border p-4 h-full flex flex-col">
      {/* Header with tabs */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1">
          {(['positions', 'orders', 'history'] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'px-4 py-2 text-sm font-medium rounded-lg transition-colors capitalize',
                activeTab === tab
                  ? 'bg-accent/20 text-accent'
                  : 'text-text-muted hover:text-text-primary hover:bg-surface-light'
              )}
            >
              {tab}
              {tab === 'positions' && positions.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-accent/30 rounded">
                  {positions.length}
                </span>
              )}
              {tab === 'orders' && orders.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-accent/30 rounded">
                  {orders.length}
                </span>
              )}
            </button>
          ))}
        </div>
        
        <div className="flex items-center gap-4">
          {isLoading && <RefreshCw className="w-4 h-4 text-text-muted animate-spin" />}
          {activeTab === 'positions' && positions.length > 0 && (
            <div className="flex items-center gap-4 text-sm">
              <div>
                <span className="text-text-muted">Value: </span>
                <span className="font-mono">${totalValue.toFixed(2)}</span>
              </div>
              <div>
                <span className="text-text-muted">P&L: </span>
                <span className={cn(
                  'font-mono font-bold',
                  totalPnl >= 0 ? 'text-long' : 'text-short'
                )}>
                  {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'positions' && <PositionsTable positions={positions} isLoading={positionsLoading} />}
        {activeTab === 'orders' && <OrdersTable orders={orders} isLoading={ordersLoading} />}
        {activeTab === 'history' && (
          <div className="text-center py-8 text-text-muted">
            No trade history yet
          </div>
        )}
      </div>
    </div>
  );
}

function PositionsTable({ positions, isLoading }: { positions: Position[]; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="text-center py-8 text-text-muted">
        <RefreshCw className="w-5 h-5 mx-auto animate-spin mb-2" />
        Loading positions...
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="text-center py-8 text-text-muted">
        No open positions
      </div>
    );
  }

  return (
    <table className="w-full">
      <thead>
        <tr className="text-left text-xs text-text-muted border-b border-border">
          <th className="pb-2 font-medium">Market</th>
          <th className="pb-2 font-medium">Side</th>
          <th className="pb-2 font-medium text-right">Size</th>
          <th className="pb-2 font-medium text-right">Entry</th>
          <th className="pb-2 font-medium text-right">Current</th>
          <th className="pb-2 font-medium text-right">P&L</th>
          <th className="pb-2 font-medium text-right"></th>
        </tr>
      </thead>
      <tbody>
        {positions.map((position) => (
          <PositionRow key={position.id} position={position} />
        ))}
      </tbody>
    </table>
  );
}

function PositionRow({ position }: { position: Position }) {
  return (
    <tr className="border-b border-border/50 hover:bg-surface-light transition-colors">
      <td className="py-3">
        <span className="font-mono text-sm">{position.market}</span>
      </td>
      <td className="py-3">
        <span className={cn(
          'px-2 py-0.5 rounded text-xs font-medium',
          position.outcome === 'YES' 
            ? 'bg-long/20 text-long' 
            : 'bg-short/20 text-short'
        )}>
          {position.outcome === 'YES' ? 'ABOVE' : 'BELOW'}
        </span>
      </td>
      <td className="py-3 text-right font-mono text-sm">{position.shares.toFixed(2)}</td>
      <td className="py-3 text-right font-mono text-sm text-text-muted">${position.avgEntry.toFixed(2)}</td>
      <td className="py-3 text-right font-mono text-sm">${position.currentPrice.toFixed(2)}</td>
      <td className="py-3 text-right">
        <div className="flex items-center justify-end gap-1">
          {position.pnl >= 0 ? (
            <TrendingUp className="w-3 h-3 text-long" />
          ) : (
            <TrendingDown className="w-3 h-3 text-short" />
          )}
          <span className={cn(
            'font-mono text-sm font-medium',
            position.pnl >= 0 ? 'text-long' : 'text-short'
          )}>
            {position.pnl >= 0 ? '+' : ''}${position.pnl.toFixed(2)}
          </span>
          <span className={cn(
            'text-xs',
            position.pnl >= 0 ? 'text-long/60' : 'text-short/60'
          )}>
            ({position.pnlPercent >= 0 ? '+' : ''}{position.pnlPercent.toFixed(1)}%)
          </span>
        </div>
      </td>
      <td className="py-3 text-right">
        <a 
          href={`/market/${position.market.split('-')[0]}`}
          className="px-3 py-1.5 text-xs bg-surface-light hover:bg-short/20 hover:text-short rounded transition-colors"
        >
          Sell
        </a>
      </td>
    </tr>
  );
}

function OrdersTable({ orders, isLoading }: { orders: Order[]; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="text-center py-8 text-text-muted">
        <RefreshCw className="w-5 h-5 mx-auto animate-spin mb-2" />
        Loading orders...
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="text-center py-8 text-text-muted">
        No open orders
      </div>
    );
  }

  return (
    <table className="w-full">
      <thead>
        <tr className="text-left text-xs text-text-muted border-b border-border">
          <th className="pb-2 font-medium">Market</th>
          <th className="pb-2 font-medium">Type</th>
          <th className="pb-2 font-medium text-right">Price</th>
          <th className="pb-2 font-medium text-right">Size</th>
          <th className="pb-2 font-medium text-right">Filled</th>
          <th className="pb-2 font-medium">Status</th>
          <th className="pb-2 font-medium text-right"></th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <OrderRow key={order.id} order={order} />
        ))}
      </tbody>
    </table>
  );
}

function OrderRow({ order }: { order: Order }) {
  return (
    <tr className="border-b border-border/50 hover:bg-surface-light transition-colors">
      <td className="py-3">
        <span className="font-mono text-sm">{order.market}</span>
      </td>
      <td className="py-3">
        <div className="flex items-center gap-1">
          <span className={cn(
            'text-xs font-medium',
            order.side === 'BID' ? 'text-long' : 'text-short'
          )}>
            {order.side === 'BID' ? 'BUY' : 'SELL'}
          </span>
          <span className={cn(
            'px-1.5 py-0.5 rounded text-xs',
            order.outcome === 'YES' 
              ? 'bg-long/10 text-long' 
              : 'bg-short/10 text-short'
          )}>
            {order.outcome === 'YES' ? 'ABOVE' : 'BELOW'}
          </span>
        </div>
      </td>
      <td className="py-3 text-right font-mono text-sm">${order.price.toFixed(2)}</td>
      <td className="py-3 text-right font-mono text-sm">{order.size.toFixed(2)}</td>
      <td className="py-3 text-right font-mono text-sm text-text-muted">
        {order.filled.toFixed(2)}/{order.size.toFixed(2)}
      </td>
      <td className="py-3">
        <span className={cn(
          'px-2 py-0.5 rounded text-xs font-medium',
          order.status === 'OPEN' && 'bg-accent/20 text-accent',
          order.status === 'PARTIAL' && 'bg-warning/20 text-warning',
        )}>
          {order.status}
        </span>
      </td>
      <td className="py-3 text-right">
        <button className="p-1.5 text-text-muted hover:text-short hover:bg-short/10 rounded transition-colors">
          <X className="w-4 h-4" />
        </button>
      </td>
    </tr>
  );
}
