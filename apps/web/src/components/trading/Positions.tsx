'use client';

import { useState, useEffect, useMemo } from 'react';
import { useUser } from '@/hooks/useUser';
import { cn } from '@/lib/utils';
import { Clock, TrendingUp, TrendingDown, X, RefreshCw, ArrowRightLeft, ExternalLink, History, DollarSign, Percent, Target } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useOrder } from '@/hooks/useOrder';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Position as ApiPosition, Order as ApiOrder, Settlement, UserTransaction } from '@/lib/api';

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

interface PositionsProps {
  onSell?: (marketAddress: string, outcome: 'YES' | 'NO', shares: number, avgEntry: number, price: number, timeframe: any, expiry: number) => void;
  // Real-time prices for the currently viewed market (from orderbook)
  currentMarketAddress?: string;
  currentYesPrice?: number;
  currentNoPrice?: number;
}

export function Positions({ onSell, currentMarketAddress, currentYesPrice, currentNoPrice }: PositionsProps) {
  const [activeTab, setActiveTab] = useState<Tab>('active');
  const [, setTick] = useState(0); // Force re-render for expiry filtering
  const { isAuthenticated } = useAuthStore();
  const { cancelOrder, isCancelling } = useOrder();
  const { showPnLPercent } = useSettingsStore();
  
  const { 
    positions: apiPositions, 
    orders: apiOrders, 
    transactions,
    positionsLoading,
    ordersLoading,
    transactionsLoading,
    refetchAll
  } = useUser();

  // Auto-refresh every 10 seconds to filter out newly expired positions
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1); // Force re-render to re-evaluate expiry filters
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleCancel = async (orderId: string) => {
    if (confirm('Are you sure you want to cancel this order?')) {
      const success = await cancelOrder(orderId);
      if (success) {
        refetchAll();
      }
    }
  };

  // Process positions into unified format
  // Use real-time orderbook prices for the current market if available
  // Filter out expired positions automatically
  const positions: UnifiedTrade[] = useMemo(() => {
    const now = Date.now();
    return (apiPositions || [])
      .filter((p: ApiPosition) => {
        // Must have shares
        if (p.yesShares <= 0 && p.noShares <= 0) return false;
        // Filter out expired positions (give 30 second buffer for settlement processing)
        if (p.expiryAt && p.expiryAt < now - 30000) return false;
        return true;
      })
      .flatMap((p: ApiPosition) => {
        const results: UnifiedTrade[] = [];
        const asset = p.asset || p.market.split('-')[0] || 'BTC';
        const expiryAt = p.expiryAt || 0;
        
        // Use real-time prices if this is the current market, otherwise use API data
        const isCurrentMarket = currentMarketAddress && p.marketAddress === currentMarketAddress;
        const yesPrice = isCurrentMarket && currentYesPrice !== undefined ? currentYesPrice : p.currentPrice;
        const noPrice = isCurrentMarket && currentNoPrice !== undefined ? currentNoPrice : (1 - p.currentPrice);
        
        if (p.yesShares > 0) {
          const pnl = (yesPrice - p.avgEntryPrice) * p.yesShares;
          const pnlPercent = p.avgEntryPrice > 0 ? ((yesPrice - p.avgEntryPrice) / p.avgEntryPrice) * 100 : 0;
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
            currentPrice: yesPrice,
            pnl,
            pnlPercent,
            status: p.status.toUpperCase(),
            createdAt: p.createdAt || 0, 
          });
        }
        
        if (p.noShares > 0) {
          const noAvgEntry = p.avgEntryPrice;
          const pnl = (noPrice - noAvgEntry) * p.noShares;
          const pnlPercent = noAvgEntry > 0 ? ((noPrice - noAvgEntry) / noAvgEntry) * 100 : 0;
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
            currentPrice: noPrice,
            pnl,
            pnlPercent,
            status: p.status.toUpperCase(),
            createdAt: p.createdAt || 0,
          });
        }
        
        return results;
      });
  }, [apiPositions, currentMarketAddress, currentYesPrice, currentNoPrice]);

  // Process orders into unified format
  // Filter out expired orders automatically
  const orders: UnifiedTrade[] = useMemo(() => {
    const now = Date.now();
    return (apiOrders || [])
      .filter((o: ApiOrder) => {
        // Must be active status
        if (o.status !== 'open' && o.status !== 'partial' && o.status !== 'filled') return false;
        // Filter out expired orders (give 30 second buffer)
        if (o.expiryAt && o.expiryAt < now - 30000) return false;
        return true;
      })
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
          <h3 className="font-bold text-lg">Positions Locked</h3>
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
              {tab === 'active' ? 'Live Trades' : 'History'}
              {tab === 'active' && combinedActive.length > 0 && (
                <span className={cn(
                  "ml-2 px-1.5 py-0.5 text-[10px] rounded-full font-black",
                  activeTab === tab ? "bg-background/20 text-background" : "bg-accent/20 text-accent"
                )}>
                  {combinedActive.length}
                </span>
              )}
              {tab === 'history' && transactions && transactions.length > 0 && (
                <span className={cn(
                  "ml-2 px-1.5 py-0.5 text-[10px] rounded-full font-black",
                  activeTab === tab ? "bg-background/20 text-background" : "bg-accent/20 text-accent"
                )}>
                  {transactions.length}
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
            showPnLPercent={showPnLPercent}
          />
        )}
        {activeTab === 'history' && (
          <TransactionHistoryTable 
            transactions={transactions || []} 
            isLoading={transactionsLoading} 
          />
        )}
      </div>

      {activeTab === 'active' && positions.length > 0 && (
        <div className="px-4 py-3 bg-surface-light/50 border-t border-border">
          <div className="flex items-center justify-between">
            {/* Portfolio Summary */}
            <div className="flex items-center gap-6">
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-wider text-text-muted font-bold">Positions</span>
                <span className="font-mono font-bold text-text-primary">{positions.length}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-wider text-text-muted font-bold">Net Value</span>
                <span className="font-mono font-bold text-text-primary">${totalValue.toFixed(2)}</span>
              </div>
            </div>
            
            {/* Total P&L - Prominent Display */}
            <div className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg',
              totalPnl >= 0 ? 'bg-long/10' : 'bg-short/10'
            )}>
              <div className="flex flex-col items-end">
                <span className="text-[10px] uppercase tracking-wider text-text-muted font-bold">Unrealized P&L</span>
                <span className={cn(
                  'font-mono text-lg font-black flex items-center gap-1',
                  totalPnl >= 0 ? 'text-long' : 'text-short'
                )}>
                  {totalPnl >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  {totalPnl >= 0 ? '+' : ''}${Math.abs(totalPnl).toFixed(2)}
                </span>
              </div>
            </div>
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
  isCancelling,
  showPnLPercent = true
}: { 
  trades: UnifiedTrade[]; 
  isLoading: boolean;
  onSell?: (marketAddress: string, outcome: 'YES' | 'NO', shares: number, avgEntry: number, price: number, timeframe: any, expiry: number) => void;
  onCancel: (id: string) => void;
  isCancelling: boolean;
  showPnLPercent?: boolean;
}) {
  if (isLoading && trades.length === 0) {
    return (
      <div className="divide-y divide-border">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-20 px-4 py-3 flex items-center gap-4">
            <div className="w-16 h-8 rounded skeleton" />
            <div className="flex-1 space-y-2">
              <div className="w-24 h-4 rounded skeleton" />
              <div className="w-16 h-3 rounded skeleton" />
            </div>
            <div className="w-20 h-6 rounded skeleton" />
          </div>
        ))}
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="text-center py-16 text-text-muted">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-surface-light flex items-center justify-center">
          <Target className="w-8 h-8 opacity-30" />
        </div>
        <p className="text-lg font-medium mb-1">No active positions</p>
        <p className="text-sm">Start trading to see your positions here</p>
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden">
      <table className="w-full text-left border-collapse table-fixed">
        <thead>
          <tr className="text-[9px] sm:text-[10px] text-text-muted uppercase tracking-widest border-b border-border bg-surface-light/10">
            <th className="px-2 sm:px-4 py-3 font-bold w-[28%]">Market</th>
            <th className="px-2 py-3 font-bold text-right w-[14%]">Size</th>
            <th className="px-2 py-3 font-bold text-right w-[16%]">Entry</th>
            <th className="px-2 py-3 font-bold text-right w-[14%]">Now</th>
            <th className="px-2 py-3 font-bold text-right w-[20%]">P&L</th>
            <th className="px-2 sm:px-4 py-3 font-bold text-right w-[8%]"></th>
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
              showPnLPercent={showPnLPercent}
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
  isCancelling,
  showPnLPercent = true
}: { 
  trade: UnifiedTrade;
  onSell?: (marketAddress: string, outcome: 'YES' | 'NO', shares: number, avgEntry: number, price: number, timeframe: any, expiry: number) => void;
  onCancel: (id: string) => void;
  isCancelling: boolean;
  showPnLPercent?: boolean;
}) {
  const timeframe = trade.market.split('-')[1];
  const isOrder = trade.type === 'order';
  
  // Calculate potential payout for positions
  const potentialPayout = !isOrder ? trade.size * 1.00 : 0;
  const potentialProfit = !isOrder ? potentialPayout - (trade.size * trade.price) : 0;

  return (
    <tr className={cn(
      "hover:bg-surface-light/30 transition-colors group animate-fade-in",
      isOrder && "bg-accent/5"
    )}>
      {/* Market Info */}
      <td className="px-2 sm:px-4 py-3">
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-1.5 overflow-hidden">
            <span className="font-bold text-xs sm:text-sm truncate">{trade.market}</span>
            <span className={cn(
              'px-1.5 py-0.5 rounded text-[8px] sm:text-[9px] font-black uppercase flex-shrink-0',
              trade.outcome === 'YES' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
            )}>
              {trade.outcome === 'YES' ? 'ABOVE' : 'BELOW'}
            </span>
            {isOrder && (
              <span className="px-1.5 py-0.5 rounded text-[8px] bg-warning/20 text-warning font-black uppercase animate-pulse">PENDING</span>
            )}
          </div>
          <div className="flex items-center gap-1 text-[9px] text-text-muted font-mono mt-1">
            <Clock className="w-2.5 h-2.5" />
            <ExpiryCountdown expiry={trade.expiryAt} />
          </div>
        </div>
      </td>
      
      {/* Size */}
      <td className="px-2 py-3 text-right">
        <div className="flex flex-col items-end">
          <span className="font-mono text-xs sm:text-sm font-bold text-text-primary">
            {trade.size.toFixed(0)}
          </span>
          <span className="text-[9px] text-text-muted">
            contracts
          </span>
        </div>
      </td>
      
      {/* Entry Price */}
      <td className="px-2 py-3 text-right">
        <span className="font-mono text-xs sm:text-sm font-medium text-text-secondary">
          ${trade.price.toFixed(2)}
        </span>
      </td>
      
      {/* Current Price (only for positions) */}
      <td className="px-2 py-3 text-right">
        {!isOrder ? (
          <span className={cn(
            "font-mono text-xs sm:text-sm font-bold",
            trade.currentPrice > trade.price ? "text-long" : trade.currentPrice < trade.price ? "text-short" : "text-text-primary"
          )}>
            ${trade.currentPrice.toFixed(2)}
          </span>
        ) : (
          <span className="text-text-muted text-xs">--</span>
        )}
      </td>
      
      {/* P&L Display - Enhanced */}
      <td className="px-2 py-3 text-right">
        {trade.pnl !== undefined ? (
          <div className="flex flex-col items-end">
            {/* Main P&L Value */}
            <div className={cn(
              'flex items-center gap-1 px-2 py-1 rounded-md font-mono text-sm sm:text-base font-black transition-all',
              trade.pnl >= 0 
                ? 'text-long bg-long/10' 
                : 'text-short bg-short/10'
            )}>
              {trade.pnl >= 0 ? (
                <TrendingUp className="w-3.5 h-3.5 flex-shrink-0" />
              ) : (
                <TrendingDown className="w-3.5 h-3.5 flex-shrink-0" />
              )}
              <span>{trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(2)}</span>
            </div>
            
            {/* Percentage (if enabled) */}
            {showPnLPercent && (
              <div className={cn(
                'text-[10px] sm:text-xs font-bold mt-0.5 flex items-center gap-0.5',
                (trade.pnlPercent || 0) >= 0 ? 'text-long/80' : 'text-short/80'
              )}>
                <Percent className="w-2.5 h-2.5" />
                {(trade.pnlPercent || 0) >= 0 ? '+' : ''}{trade.pnlPercent?.toFixed(1)}%
              </div>
            )}
            
            {/* Max potential (for YES positions - settles at $1) */}
            {!isOrder && potentialProfit > 0 && (
              <div className="text-[9px] text-text-muted mt-1 flex items-center gap-0.5">
                <span>Max: +${potentialProfit.toFixed(2)}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-end gap-1 text-text-muted">
            <span className="font-mono text-sm">--</span>
          </div>
        )}
      </td>
      
      {/* Actions */}
      <td className="px-2 sm:px-4 py-3 text-right">
        {isOrder ? (
          <button 
            onClick={() => onCancel(trade.id.replace('ord-', ''))}
            disabled={isCancelling}
            className={cn(
              "p-2 rounded-lg transition-all btn-press",
              isCancelling 
                ? "opacity-50 cursor-wait" 
                : "text-text-muted hover:text-short hover:bg-short/10"
            )}
            title="Cancel Order"
          >
            <X className="w-4 h-4" />
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
            className="p-2 text-text-muted hover:text-warning hover:bg-warning/10 rounded-lg transition-all btn-press"
            title="Close Position"
          >
            <ArrowRightLeft className="w-4 h-4" />
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

// Transaction History Table Component - Shows all trades and settlements
function TransactionHistoryTable({ 
  transactions, 
  isLoading 
}: { 
  transactions: UserTransaction[]; 
  isLoading: boolean;
}) {
  // Calculate realized P&L from closing transactions (settlements with pnl)
  const totalPnl = transactions
    .filter(t => t.transactionType === 'close' && t.pnl !== undefined)
    .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  if (isLoading && transactions.length === 0) {
    return (
      <div className="divide-y divide-border">
        {[1, 2, 3].map(i => <div key={i} className="h-16 bg-surface animate-pulse" />)}
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="text-center py-16 text-text-muted">
        <History className="w-8 h-8 mx-auto opacity-20 mb-2" />
        <p>No transaction history yet</p>
        <p className="text-xs mt-1">Your trades will appear here</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Summary Stats */}
      <div className="px-4 py-3 bg-surface-light/30 border-b border-border flex items-center justify-end text-sm">
        <div className="flex items-center gap-2">
          <span className="text-text-muted">Realized P&L:</span>
          <span className={cn(
            'font-mono font-bold',
            totalPnl >= 0 ? 'text-long' : 'text-short'
          )}>
            {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left border-collapse table-fixed">
          <thead>
            <tr className="text-[9px] sm:text-[10px] text-text-muted uppercase tracking-widest border-b border-border bg-surface-light/10 sticky top-0">
              <th className="px-2 sm:px-4 py-3 font-bold w-[22%]">Market</th>
              <th className="px-2 py-3 font-bold text-center w-[12%]">Type</th>
              <th className="px-2 py-3 font-bold text-center w-[15%]">Side</th>
              <th className="px-2 py-3 font-bold text-right w-[13%]">Size</th>
              <th className="px-2 py-3 font-bold text-right w-[13%]">Price</th>
              <th className="px-2 py-3 font-bold text-right w-[15%]">P&L</th>
              <th className="px-2 sm:px-4 py-3 font-bold text-right w-[10%]">Tx</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {transactions.map((tx, idx) => (
              <TransactionRow key={`${tx.id}-${idx}`} transaction={tx} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TransactionRow({ transaction }: { transaction: UserTransaction }) {
  const isOpening = transaction.transactionType === 'open';
  const isSettlement = transaction.type === 'settlement';
  const pnl = transaction.pnl;
  const hasPnl = pnl !== undefined && pnl !== null;
  
  // Format date
  const timestamp = transaction.timestamp || 0;
  const txDate = new Date(timestamp);
  const formattedDate = timestamp > 0 
    ? txDate.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '--';

  // Solscan link
  const solscanUrl = transaction.txSignature 
    ? `https://solscan.io/tx/${transaction.txSignature}` 
    : null;

  // Type badge
  const getTypeBadge = () => {
    if (isSettlement) {
      return (
        <span className="px-2 py-0.5 rounded text-[9px] font-black uppercase bg-purple-500/20 text-purple-400">
          SETTLED
        </span>
      );
    }
    if (isOpening) {
      return (
        <span className="px-2 py-0.5 rounded text-[9px] font-black uppercase bg-accent/20 text-accent">
          OPEN
        </span>
      );
    }
    return (
      <span className="px-2 py-0.5 rounded text-[9px] font-black uppercase bg-warning/20 text-warning">
        CLOSE
      </span>
    );
  };

  // Side/Position display
  const getSideBadge = () => {
    if (isSettlement) {
      const isWin = (pnl ?? 0) > 0;
      return (
        <div className="flex flex-col items-center gap-0.5">
          <span className={cn(
            'px-2 py-0.5 rounded text-[9px] font-black uppercase',
            transaction.outcome === 'yes' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
          )}>
            {transaction.outcome === 'yes' ? 'YES' : 'NO'}
          </span>
          <span className={cn(
            'text-[8px] font-bold',
            isWin ? 'text-long' : 'text-short'
          )}>
            {isWin ? '→ $1.00' : '→ $0.00'}
          </span>
        </div>
      );
    }
    
    const isBuy = transaction.side === 'buy';
    return (
      <div className="flex flex-col items-center gap-0.5">
        <span className={cn(
          'px-2 py-0.5 rounded text-[9px] font-black uppercase',
          isBuy ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
        )}>
          {isBuy ? 'BUY' : 'SELL'}
        </span>
        <span className={cn(
          'text-[8px] font-bold',
          transaction.outcome === 'yes' ? 'text-long' : 'text-short'
        )}>
          {transaction.outcome === 'yes' ? 'YES' : 'NO'}
        </span>
      </div>
    );
  };

  return (
    <tr className="hover:bg-surface-light/30 transition-colors">
      <td className="px-2 sm:px-4 py-3">
        <div className="flex flex-col min-w-0">
          <span className="font-bold text-xs sm:text-sm truncate">{transaction.market || '--'}</span>
          <span className="text-[9px] text-text-muted">{formattedDate}</span>
        </div>
      </td>
      <td className="px-2 py-3 text-center">
        {getTypeBadge()}
      </td>
      <td className="px-2 py-3 text-center">
        {getSideBadge()}
      </td>
      <td className="px-2 py-3 text-right">
        <span className="font-mono text-xs sm:text-sm font-bold">
          {transaction.size.toFixed(0)}
        </span>
      </td>
      <td className="px-2 py-3 text-right">
        <span className="font-mono text-xs sm:text-sm font-medium">
          ${transaction.price.toFixed(2)}
        </span>
      </td>
      <td className="px-2 py-3 text-right">
        {hasPnl ? (
          <span className={cn(
            'font-mono text-xs sm:text-sm font-bold',
            pnl >= 0 ? 'text-long' : 'text-short'
          )}>
            {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
          </span>
        ) : (
          <span className="text-text-muted font-mono text-xs">--</span>
        )}
      </td>
      <td className="px-2 sm:px-4 py-3 text-right">
        {solscanUrl ? (
          <a 
            href={solscanUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 text-text-muted hover:text-accent hover:bg-accent/10 rounded-lg transition-all inline-flex"
            title="View on Solscan"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        ) : (
          <span className="text-text-muted text-[9px]">--</span>
        )}
      </td>
    </tr>
  );
}
