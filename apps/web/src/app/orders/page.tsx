'use client';

import { useState, useMemo } from 'react';
import { Header } from '@/components/layout/Header';
import { useUser } from '@/hooks/useUser';
import { useOrder } from '@/hooks/useOrder';
import { useAuthStore } from '@/stores/authStore';
import { cn } from '@/lib/utils';
import { 
  ArrowLeft, 
  Clock, 
  RefreshCw, 
  Filter,
  TrendingUp, 
  TrendingDown, 
  X, 
  ExternalLink,
  Search,
  ChevronDown,
  FileText,
  History,
  Zap,
  CheckCircle,
  XCircle,
  Target
} from 'lucide-react';
import Link from 'next/link';
import type { Order as ApiOrder, UserTransaction } from '@/lib/api';

type Tab = 'open' | 'history';
type StatusFilter = 'all' | 'filled' | 'cancelled' | 'expired';
type AssetFilter = 'all' | 'BTC' | 'ETH' | 'SOL';

export default function OrdersPage() {
  const { isAuthenticated } = useAuthStore();
  const { 
    orders: apiOrders, 
    transactions,
    ordersLoading,
    transactionsLoading,
    refetchAll
  } = useUser();
  const { cancelOrder, isCancelling } = useOrder();
  
  const [activeTab, setActiveTab] = useState<Tab>('open');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const handleCancel = async (orderId: string) => {
    if (confirm('Cancel this order?')) {
      const success = await cancelOrder(orderId);
      if (success) {
        refetchAll();
      }
    }
  };

  // Filter open orders
  const openOrders = useMemo(() => {
    return (apiOrders || []).filter((o: ApiOrder) => 
      o.status === 'open' || o.status === 'partial'
    );
  }, [apiOrders]);

  // Filter transactions based on filters
  const filteredTransactions = useMemo(() => {
    let filtered = transactions || [];
    
    // Status filter
    if (statusFilter !== 'all') {
      if (statusFilter === 'filled') {
        filtered = filtered.filter(t => t.transactionType === 'close' || t.type === 'settlement');
      } else if (statusFilter === 'cancelled') {
        filtered = filtered.filter(t => t.status === 'cancelled');
      }
    }
    
    // Asset filter
    if (assetFilter !== 'all') {
      filtered = filtered.filter(t => t.market?.startsWith(assetFilter));
    }
    
    // Search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(t => 
        t.market?.toLowerCase().includes(query) ||
        t.txSignature?.toLowerCase().includes(query)
      );
    }
    
    return filtered;
  }, [transactions, statusFilter, assetFilter, searchQuery]);

  // Calculate stats
  const totalTrades = transactions?.length || 0;
  const winningTrades = transactions?.filter(t => (t.pnl ?? 0) > 0).length || 0;
  const totalPnL = transactions?.reduce((sum, t) => sum + (t.pnl ?? 0), 0) || 0;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

  const isLoading = ordersLoading || transactionsLoading;

  return (
    <div className="min-h-screen bg-background bg-gradient-mesh">
      <Header />

      <main className="max-w-4xl mx-auto p-4 pb-24">
        {/* Back Button */}
        <Link 
          href="/"
          className="inline-flex items-center gap-2 text-text-muted hover:text-text-primary transition-colors text-sm font-medium mb-6 btn-press"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Markets
        </Link>

        {/* Page Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-display font-bold">Orders</h1>
            <p className="text-text-muted">Manage your orders and trade history</p>
          </div>
          <button
            onClick={() => refetchAll()}
            disabled={isLoading}
            className="p-2 hover:bg-surface-light rounded-lg transition-all btn-press"
          >
            <RefreshCw className={cn('w-5 h-5 text-text-muted', isLoading && 'animate-spin')} />
          </button>
        </div>

        {!isAuthenticated ? (
          <div className="glass-card rounded-2xl border border-border/50 p-12 text-center">
            <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-surface-light/50 flex items-center justify-center">
              <FileText className="w-10 h-10 text-text-muted/50" />
            </div>
            <h2 className="text-xl font-display font-bold mb-2">Connect Wallet</h2>
            <p className="text-text-muted">Connect your wallet to view orders and trade history</p>
          </div>
        ) : (
          <>
            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <div className="glass-card rounded-xl border border-border/50 p-4">
                <div className="text-sm text-text-muted mb-1">Open Orders</div>
                <div className="text-2xl font-display font-bold text-accent">{openOrders.length}</div>
              </div>
              <div className="glass-card rounded-xl border border-border/50 p-4">
                <div className="text-sm text-text-muted mb-1">Total Trades</div>
                <div className="text-2xl font-display font-bold">{totalTrades}</div>
              </div>
              <div className="glass-card rounded-xl border border-border/50 p-4">
                <div className="text-sm text-text-muted mb-1">Win Rate</div>
                <div className={cn(
                  "text-2xl font-display font-bold",
                  winRate >= 50 ? "text-long" : "text-short"
                )}>{winRate.toFixed(0)}%</div>
              </div>
              <div className="glass-card rounded-xl border border-border/50 p-4">
                <div className="text-sm text-text-muted mb-1">Total P&L</div>
                <div className={cn(
                  "text-2xl font-display font-bold",
                  totalPnL >= 0 ? "text-long" : "text-short"
                )}>
                  {totalPnL >= 0 ? '+' : ''}${Math.abs(totalPnL).toFixed(2)}
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="glass-card rounded-2xl border border-border/50 overflow-hidden">
              <div className="flex items-center justify-between p-4 border-b border-border/50 bg-surface-light/20">
                <div className="flex gap-1">
                  {(['open', 'history'] as Tab[]).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={cn(
                        'px-4 py-2 text-sm font-bold rounded-lg transition-all capitalize btn-press flex items-center gap-2',
                        activeTab === tab
                          ? 'bg-accent text-background shadow-sm'
                          : 'text-text-muted hover:text-text-primary hover:bg-surface-light'
                      )}
                    >
                      {tab === 'open' ? <Zap className="w-4 h-4" /> : <History className="w-4 h-4" />}
                      {tab === 'open' ? 'Open Orders' : 'History'}
                      {tab === 'open' && openOrders.length > 0 && (
                        <span className={cn(
                          "px-1.5 py-0.5 text-[10px] rounded-full font-black",
                          activeTab === tab ? "bg-background/20 text-background" : "bg-accent/20 text-accent"
                        )}>
                          {openOrders.length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                
                {activeTab === 'history' && (
                  <button
                    onClick={() => setShowFilters(!showFilters)}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all btn-press",
                      showFilters ? "bg-accent text-background" : "text-text-muted hover:text-text-primary hover:bg-surface-light"
                    )}
                  >
                    <Filter className="w-4 h-4" />
                    Filters
                    <ChevronDown className={cn("w-4 h-4 transition-transform", showFilters && "rotate-180")} />
                  </button>
                )}
              </div>

              {/* Filters Panel */}
              {activeTab === 'history' && showFilters && (
                <div className="p-4 border-b border-border/50 bg-surface-light/10 animate-fade-in">
                  <div className="flex flex-wrap gap-4">
                    {/* Search */}
                    <div className="flex-1 min-w-[200px]">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search market or tx..."
                          className="w-full pl-10 pr-4 py-2 rounded-lg bg-surface-light border border-border text-text-primary text-sm outline-none focus:border-accent transition-colors"
                        />
                      </div>
                    </div>
                    
                    {/* Status Filter */}
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-text-muted">Status:</span>
                      <div className="flex gap-1">
                        {(['all', 'filled', 'cancelled'] as StatusFilter[]).map((status) => (
                          <button
                            key={status}
                            onClick={() => setStatusFilter(status)}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-xs font-bold capitalize transition-all btn-press",
                              statusFilter === status
                                ? "bg-accent text-background"
                                : "bg-surface-light text-text-muted hover:text-text-primary"
                            )}
                          >
                            {status}
                          </button>
                        ))}
                      </div>
                    </div>
                    
                    {/* Asset Filter */}
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-text-muted">Asset:</span>
                      <div className="flex gap-1">
                        {(['all', 'BTC', 'ETH', 'SOL'] as AssetFilter[]).map((asset) => (
                          <button
                            key={asset}
                            onClick={() => setAssetFilter(asset)}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-xs font-bold uppercase transition-all btn-press",
                              assetFilter === asset
                                ? "bg-accent text-background"
                                : "bg-surface-light text-text-muted hover:text-text-primary"
                            )}
                          >
                            {asset}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Content */}
              <div className="min-h-[400px]">
                {activeTab === 'open' && (
                  <OpenOrdersTable 
                    orders={openOrders} 
                    isLoading={ordersLoading} 
                    onCancel={handleCancel}
                    isCancelling={isCancelling}
                  />
                )}
                {activeTab === 'history' && (
                  <TransactionHistoryTable 
                    transactions={filteredTransactions} 
                    isLoading={transactionsLoading} 
                  />
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function OpenOrdersTable({ 
  orders, 
  isLoading, 
  onCancel,
  isCancelling
}: { 
  orders: ApiOrder[]; 
  isLoading: boolean;
  onCancel: (id: string) => void;
  isCancelling: boolean;
}) {
  if (isLoading && orders.length === 0) {
    return (
      <div className="p-4 space-y-2">
        {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-xl skeleton" />)}
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-surface-light/50 flex items-center justify-center">
          <Target className="w-8 h-8 text-text-muted/50" />
        </div>
        <p className="text-text-muted text-lg font-medium">No open orders</p>
        <p className="text-sm text-text-muted/70 mt-1">Your limit orders will appear here</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/30">
      {orders.map((order) => (
        <OpenOrderRow key={order.id} order={order} onCancel={onCancel} isCancelling={isCancelling} />
      ))}
    </div>
  );
}

function OpenOrderRow({ order, onCancel, isCancelling }: { order: ApiOrder; onCancel: (id: string) => void; isCancelling: boolean }) {
  const fillPercent = (order.filledSize / order.size) * 100;
  const isPartial = order.status === 'partial';
  
  return (
    <div className="p-4 hover:bg-surface-light/20 transition-colors animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {/* Market & Outcome */}
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold">{order.market}</span>
              <span className={cn(
                'px-2 py-0.5 rounded text-xs font-bold uppercase',
                order.outcome === 'yes' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
              )}>
                {order.outcome === 'yes' ? 'ABOVE' : 'BELOW'}
              </span>
              <span className={cn(
                'px-2 py-0.5 rounded text-xs font-bold',
                order.side === 'bid' ? 'bg-long/10 text-long' : 'bg-short/10 text-short'
              )}>
                {order.side === 'bid' ? 'BUY' : 'SELL'}
              </span>
              {isPartial && (
                <span className="px-2 py-0.5 rounded text-xs font-bold bg-warning/20 text-warning animate-pulse">
                  PARTIAL
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 text-xs text-text-muted mt-1">
              <Clock className="w-3 h-3" />
              {new Date(order.createdAt).toLocaleString()}
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          {/* Size & Price */}
          <div className="text-right">
            <div className="font-mono font-bold">{order.size.toFixed(0)} contracts</div>
            <div className="text-sm text-text-muted">@ ${order.price.toFixed(2)}</div>
          </div>
          
          {/* Fill Progress */}
          <div className="w-24 text-right">
            <div className="font-mono text-sm font-bold mb-1">{fillPercent.toFixed(0)}% filled</div>
            <div className="h-1.5 bg-surface-light rounded-full overflow-hidden">
              <div 
                className="h-full bg-accent transition-all duration-500"
                style={{ width: `${fillPercent}%` }}
              />
            </div>
          </div>
          
          {/* Cancel Button */}
          <button
            onClick={() => onCancel(order.id)}
            disabled={isCancelling}
            className="p-2.5 text-text-muted hover:text-short hover:bg-short/10 rounded-lg transition-all btn-press"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function TransactionHistoryTable({ 
  transactions, 
  isLoading 
}: { 
  transactions: UserTransaction[]; 
  isLoading: boolean;
}) {
  if (isLoading && transactions.length === 0) {
    return (
      <div className="p-4 space-y-2">
        {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-xl skeleton" />)}
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-surface-light/50 flex items-center justify-center">
          <History className="w-8 h-8 text-text-muted/50" />
        </div>
        <p className="text-text-muted text-lg font-medium">No trade history</p>
        <p className="text-sm text-text-muted/70 mt-1">Your completed trades will appear here</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/30">
      {transactions.map((tx, idx) => (
        <TransactionRow key={`${tx.id}-${idx}`} transaction={tx} />
      ))}
    </div>
  );
}

function TransactionRow({ transaction }: { transaction: UserTransaction }) {
  const isOpening = transaction.transactionType === 'open';
  const isSettlement = transaction.type === 'settlement';
  const pnl = transaction.pnl;
  const hasPnl = pnl !== undefined && pnl !== null;
  
  const timestamp = transaction.timestamp || 0;
  const formattedDate = timestamp > 0 
    ? new Date(timestamp).toLocaleString()
    : '--';

  const solscanUrl = transaction.txSignature 
    ? `https://solscan.io/tx/${transaction.txSignature}` 
    : null;

  return (
    <div className="p-4 hover:bg-surface-light/20 transition-colors animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {/* Type Icon */}
          <div className={cn(
            "w-10 h-10 rounded-xl flex items-center justify-center",
            isSettlement ? "bg-violet/20" : isOpening ? "bg-accent/20" : "bg-warning/20"
          )}>
            {isSettlement ? (
              <CheckCircle className="w-5 h-5 text-violet" />
            ) : isOpening ? (
              <TrendingUp className="w-5 h-5 text-accent" />
            ) : (
              <TrendingDown className="w-5 h-5 text-warning" />
            )}
          </div>
          
          {/* Details */}
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold">{transaction.market || '--'}</span>
              <span className={cn(
                'px-2 py-0.5 rounded text-xs font-bold uppercase',
                transaction.outcome === 'yes' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
              )}>
                {transaction.outcome === 'yes' ? 'ABOVE' : 'BELOW'}
              </span>
              <span className={cn(
                'px-2 py-0.5 rounded text-xs font-bold',
                isSettlement ? 'bg-violet/20 text-violet' : isOpening ? 'bg-accent/20 text-accent' : 'bg-warning/20 text-warning'
              )}>
                {isSettlement ? 'SETTLED' : isOpening ? 'OPEN' : 'CLOSE'}
              </span>
            </div>
            <div className="text-xs text-text-muted mt-1">{formattedDate}</div>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          {/* Size & Price */}
          <div className="text-right">
            <div className="font-mono font-bold">{transaction.size.toFixed(0)} contracts</div>
            <div className="text-sm text-text-muted">@ ${transaction.price.toFixed(2)}</div>
          </div>
          
          {/* P&L */}
          <div className="w-24 text-right">
            {hasPnl ? (
              <div className={cn(
                'flex items-center justify-end gap-1 font-mono font-bold',
                pnl >= 0 ? 'text-long' : 'text-short'
              )}>
                {pnl >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
              </div>
            ) : (
              <span className="text-text-muted">--</span>
            )}
          </div>
          
          {/* Tx Link */}
          {solscanUrl ? (
            <a
              href={solscanUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2.5 text-text-muted hover:text-accent hover:bg-accent/10 rounded-lg transition-all btn-press"
            >
              <ExternalLink className="w-5 h-5" />
            </a>
          ) : (
            <div className="w-10" />
          )}
        </div>
      </div>
    </div>
  );
}

