'use client';

import { useState, useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Header } from '@/components/layout/Header';
import { useSettingsStore, QuickTradePreset } from '@/stores/settingsStore';
import { useDelegation } from '@/hooks/useDelegation';
import { useBalance, useTotalPnL, useUser } from '@/hooks/useUser';
import { useOrder } from '@/hooks/useOrder';
import { useAuthStore } from '@/stores/authStore';
import { cn } from '@/lib/utils';
import { 
  ArrowLeft, 
  Zap, 
  Settings, 
  DollarSign, 
  Volume2, 
  VolumeX,
  Eye,
  EyeOff,
  Check,
  Plus,
  X,
  Trash2,
  RefreshCw,
  Shield,
  Wallet,
  TrendingUp,
  TrendingDown,
  Copy,
  ExternalLink,
  AlertCircle,
  Clock,
  Target,
  History,
  FileText,
  PieChart,
  BarChart3,
  Trophy,
  Flame,
  Percent,
  Activity
} from 'lucide-react';
import Link from 'next/link';
import type { Order as ApiOrder, UserTransaction } from '@/lib/api';

type Tab = 'positions' | 'analytics' | 'settings';

export default function ProfilePage() {
  const { connected, publicKey, disconnect } = useWallet();
  const { isAuthenticated } = useAuthStore();
  const { balance } = useBalance();
  const totalPnL = useTotalPnL();
  const { 
    orders: apiOrders,
    positions,
    transactions,
    ordersLoading,
    positionsLoading,
    transactionsLoading,
    refetchAll
  } = useUser();
  const { cancelOrder, isCancelling } = useOrder();
  const { 
    isApproved: isDelegationApproved, 
    delegatedAmount, 
    approve: approveDelegation, 
    revoke: revokeDelegation, 
    isApproving 
  } = useDelegation();

  const {
    oneClickEnabled,
    oneClickAmount,
    quickTradePresets,
    showPnLPercent,
    confirmTrades,
    soundEnabled,
    defaultOrderType,
    defaultSlippage,
    setOneClickEnabled,
    setOneClickAmount,
    setShowPnLPercent,
    setConfirmTrades,
    setSoundEnabled,
    setDefaultOrderType,
    setDefaultSlippage,
    addQuickTradePreset,
    removeQuickTradePreset,
    resetToDefaults,
  } = useSettingsStore();

  const [activeTab, setActiveTab] = useState<Tab>('positions');
  const [newPresetAmount, setNewPresetAmount] = useState('');
  const [showAddPreset, setShowAddPreset] = useState(false);
  const [delegationInput, setDelegationInput] = useState('');
  const [showDelegationEdit, setShowDelegationEdit] = useState(false);
  const [copied, setCopied] = useState(false);

  const walletAddress = publicKey?.toBase58() || '';
  const truncatedAddress = walletAddress 
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : '';

  const copyAddress = async () => {
    if (walletAddress) {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleAddPreset = () => {
    const amount = parseFloat(newPresetAmount);
    if (amount > 0 && amount <= 10000) {
      addQuickTradePreset(amount);
      setNewPresetAmount('');
      setShowAddPreset(false);
    }
  };

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

  // Calculate PNL for close trades by matching with opens
  const transactionsWithPnL = useMemo(() => {
    if (!transactions || transactions.length === 0) return [];
    
    // Helper to normalize outcome - handle all possible formats
    const normalizeOutcome = (outcome: string | undefined | null): string => {
      if (!outcome) return 'unknown';
      const s = String(outcome).toLowerCase().trim();
      if (s === 'yes' || s === 'above' || s === 'y' || s === '1' || s === 'true') return 'yes';
      if (s === 'no' || s === 'below' || s === 'n' || s === '0' || s === 'false') return 'no';
      return s;
    };
    
    // Get all open transactions
    const openTransactions = transactions.filter(tx => tx.transactionType === 'open');
    
    // Build a simple cost basis map: outcome -> { totalCost, totalSize }
    const costBasis: Record<string, { totalCost: number; totalSize: number }> = {};
    openTransactions.forEach(open => {
      const outcome = normalizeOutcome(open.outcome);
      if (!costBasis[outcome]) {
        costBasis[outcome] = { totalCost: 0, totalSize: 0 };
      }
      costBasis[outcome].totalCost += open.price * open.size;
      costBasis[outcome].totalSize += open.size;
    });
    
    // Calculate PNL for each close transaction
    return transactions.map(tx => {
      // For settlements with existing PNL, keep it
      if (tx.type === 'settlement' && tx.pnl !== undefined && tx.pnl !== null && !isNaN(tx.pnl)) {
        return tx;
      }
      
      // Calculate PNL for close transactions
      if (tx.transactionType === 'close') {
        const outcome = normalizeOutcome(tx.outcome);
        const basis = costBasis[outcome];
        
        if (basis && basis.totalSize > 0) {
          const avgOpenPrice = basis.totalCost / basis.totalSize;
          const calculatedPnL = (tx.price - avgOpenPrice) * tx.size;
          return { ...tx, pnl: calculatedPnL };
        }
      }
      
      return tx;
    });
  }, [transactions]);

  // Calculate portfolio metrics
  const metrics = useMemo(() => {
    const allTrades = transactionsWithPnL || [];
    const closedTrades = allTrades.filter(t => t.transactionType === 'close' || t.type === 'settlement');
    
    const totalTrades = closedTrades.length;
    const winningTrades = closedTrades.filter(t => (t.pnl ?? 0) > 0);
    const losingTrades = closedTrades.filter(t => (t.pnl ?? 0) < 0);
    
    const totalWins = winningTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0));
    const realizedPnL = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    
    const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;
    const avgWin = winningTrades.length > 0 ? totalWins / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? totalLosses / losingTrades.length : 0;
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;
    
    const biggestWin = winningTrades.length > 0 
      ? Math.max(...winningTrades.map(t => t.pnl ?? 0)) 
      : 0;
    const biggestLoss = losingTrades.length > 0 
      ? Math.min(...losingTrades.map(t => t.pnl ?? 0)) 
      : 0;
    
    const activeValue = positions.reduce((sum, p) => {
      const shares = p.yesShares + p.noShares;
      return sum + shares * p.currentPrice;
    }, 0);
    
    const unrealizedPnL = positions.reduce((sum, p) => sum + p.unrealizedPnL, 0);
    
    const assetBreakdown = positions.reduce((acc, p) => {
      const asset = p.market.split('-')[0] || 'OTHER';
      if (!acc[asset]) acc[asset] = 0;
      acc[asset] += (p.yesShares + p.noShares) * p.currentPrice;
      return acc;
    }, {} as Record<string, number>);
    
    const yesPositions = positions.filter(p => p.yesShares > 0).length;
    const noPositions = positions.filter(p => p.noShares > 0).length;
    
    return {
      totalTrades,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate,
      avgWin,
      avgLoss,
      profitFactor,
      biggestWin,
      biggestLoss,
      realizedPnL,
      unrealizedPnL,
      activeValue,
      assetBreakdown,
      yesPositions,
      noPositions,
    };
  }, [transactionsWithPnL, positions]);

  const isLoading = ordersLoading || positionsLoading || transactionsLoading;

  return (
    <div className="min-h-screen bg-background bg-gradient-mesh">
      <Header />

      <main className="max-w-4xl mx-auto p-4 pb-24">
        {/* Back Button */}
        <Link 
          href="/btc"
          className="inline-flex items-center gap-2 text-text-muted hover:text-text-primary transition-colors text-sm font-medium mb-6 btn-press"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Trading
        </Link>

        {/* Page Header with Account Info */}
        <div className="glass-card rounded-2xl border border-border/50 p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl font-display font-bold">Profile</h1>
              {connected && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="font-mono text-text-muted">{truncatedAddress}</span>
                  <button
                    onClick={copyAddress}
                    className={cn(
                      "p-1 rounded transition-all",
                      copied ? "text-long" : "text-text-muted hover:text-text-primary"
                    )}
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                  <a
                    href={`https://solscan.io/account/${walletAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1 rounded text-text-muted hover:text-accent transition-all"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              )}
            </div>
            <button
              onClick={() => refetchAll()}
              disabled={isLoading}
              className="p-2 hover:bg-surface-light rounded-lg transition-all btn-press"
            >
              <RefreshCw className={cn('w-5 h-5 text-text-muted', isLoading && 'animate-spin')} />
            </button>
          </div>

          {/* Quick Stats */}
          {connected && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-surface-light/50 rounded-xl p-3">
                <div className="text-xs text-text-muted mb-1">Balance</div>
                <div className="text-lg font-bold font-mono text-accent">
                  ${balance?.total?.toFixed(2) || '0.00'}
                </div>
              </div>
              <div className="bg-surface-light/50 rounded-xl p-3">
                <div className="text-xs text-text-muted mb-1">Delegated</div>
                <div className="text-lg font-bold font-mono text-accent">
                  ${isDelegationApproved ? (delegatedAmount / 1_000_000).toFixed(0) : '0'}
                </div>
              </div>
              <div className="bg-surface-light/50 rounded-xl p-3">
                <div className="text-xs text-text-muted mb-1">Unrealized P&L</div>
                <div className={cn(
                  "text-lg font-bold font-mono",
                  metrics.unrealizedPnL >= 0 ? 'text-long' : 'text-short'
                )}>
                  {metrics.unrealizedPnL >= 0 ? '+' : ''}${metrics.unrealizedPnL.toFixed(2)}
                </div>
              </div>
              <div className="bg-surface-light/50 rounded-xl p-3">
                <div className="text-xs text-text-muted mb-1">Realized P&L</div>
                <div className={cn(
                  "text-lg font-bold font-mono",
                  metrics.realizedPnL >= 0 ? 'text-long' : 'text-short'
                )}>
                  {metrics.realizedPnL >= 0 ? '+' : ''}${metrics.realizedPnL.toFixed(2)}
                </div>
              </div>
            </div>
          )}
        </div>

        {!isAuthenticated ? (
          <div className="glass-card rounded-2xl border border-border/50 p-12 text-center">
            <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-surface-light/50 flex items-center justify-center">
              <Wallet className="w-10 h-10 text-text-muted/50" />
            </div>
            <h2 className="text-xl font-display font-bold mb-2">Connect Wallet</h2>
            <p className="text-text-muted">Connect your wallet to view your profile</p>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="glass-card rounded-2xl border border-border/50 overflow-hidden">
              <div className="flex items-center gap-1 p-2 border-b border-border/50 bg-surface-light/20">
                {(['positions', 'analytics', 'settings'] as Tab[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      'flex-1 px-4 py-2.5 text-sm font-bold rounded-lg transition-all capitalize btn-press flex items-center justify-center gap-2',
                      activeTab === tab
                        ? 'bg-accent text-background shadow-sm'
                        : 'text-text-muted hover:text-text-primary hover:bg-surface-light'
                    )}
                  >
                    {tab === 'positions' && <Target className="w-4 h-4" />}
                    {tab === 'analytics' && <BarChart3 className="w-4 h-4" />}
                    {tab === 'settings' && <Settings className="w-4 h-4" />}
                    {tab === 'positions' ? 'Positions' : tab}
                    {tab === 'positions' && (openOrders.length > 0 || positions.length > 0) && (
                      <span className={cn(
                        "px-1.5 py-0.5 text-[10px] rounded-full font-black",
                        activeTab === tab ? "bg-background/20 text-background" : "bg-accent/20 text-accent"
                      )}>
                        {openOrders.length + positions.length}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              <div className="min-h-[400px]">
                {activeTab === 'positions' && (
                  <PositionsTab 
                    openOrders={openOrders}
                    positions={positions}
                    transactions={transactionsWithPnL}
                    isLoading={isLoading}
                    onCancel={handleCancel}
                    isCancelling={isCancelling}
                  />
                )}
                {activeTab === 'analytics' && (
                  <AnalyticsTab metrics={metrics} positions={positions} />
                )}
                {activeTab === 'settings' && (
                  <SettingsTab 
                    connected={connected}
                    isDelegationApproved={isDelegationApproved}
                    delegatedAmount={delegatedAmount}
                    approveDelegation={approveDelegation}
                    revokeDelegation={revokeDelegation}
                    isApproving={isApproving}
                    delegationInput={delegationInput}
                    setDelegationInput={setDelegationInput}
                    showDelegationEdit={showDelegationEdit}
                    setShowDelegationEdit={setShowDelegationEdit}
                    oneClickEnabled={oneClickEnabled}
                    oneClickAmount={oneClickAmount}
                    quickTradePresets={quickTradePresets}
                    showPnLPercent={showPnLPercent}
                    confirmTrades={confirmTrades}
                    soundEnabled={soundEnabled}
                    defaultOrderType={defaultOrderType}
                    defaultSlippage={defaultSlippage}
                    setOneClickEnabled={setOneClickEnabled}
                    setOneClickAmount={setOneClickAmount}
                    setShowPnLPercent={setShowPnLPercent}
                    setConfirmTrades={setConfirmTrades}
                    setSoundEnabled={setSoundEnabled}
                    setDefaultOrderType={setDefaultOrderType}
                    setDefaultSlippage={setDefaultSlippage}
                    addQuickTradePreset={addQuickTradePreset}
                    removeQuickTradePreset={removeQuickTradePreset}
                    resetToDefaults={resetToDefaults}
                    newPresetAmount={newPresetAmount}
                    setNewPresetAmount={setNewPresetAmount}
                    showAddPreset={showAddPreset}
                    setShowAddPreset={setShowAddPreset}
                    handleAddPreset={handleAddPreset}
                    disconnect={disconnect}
                  />
                )}
              </div>
            </div>
          </>
        )}

        {/* Version Info */}
        <div className="mt-8 text-center text-xs text-text-muted">
          <p>Degen Terminal v0.1.0</p>
          <p className="text-accent">Devnet</p>
        </div>
      </main>
    </div>
  );
}

// =================== POSITIONS TAB ===================
function PositionsTab({ 
  openOrders, 
  positions, 
  transactions,
  isLoading, 
  onCancel,
  isCancelling
}: { 
  openOrders: ApiOrder[];
  positions: any[];
  transactions: UserTransaction[];
  isLoading: boolean;
  onCancel: (id: string) => void;
  isCancelling: boolean;
}) {
  const [subTab, setSubTab] = useState<'open' | 'history'>('open');
  
  const realizedPnL = transactions
    .filter(t => t.transactionType === 'close' || t.type === 'settlement')
    .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  return (
    <div>
      {/* Sub-tabs */}
      <div className="flex items-center justify-between p-4 border-b border-border/30">
        <div className="flex gap-1">
          <button
            onClick={() => setSubTab('open')}
            className={cn(
              'px-3 py-1.5 text-sm font-bold rounded-lg transition-all btn-press flex items-center gap-2',
              subTab === 'open'
                ? 'bg-surface-light text-text-primary'
                : 'text-text-muted hover:text-text-primary'
            )}
          >
            <Zap className="w-3.5 h-3.5" />
            Open Positions
            {(openOrders.length + positions.length) > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-accent/20 text-accent font-black">
                {openOrders.length + positions.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setSubTab('history')}
            className={cn(
              'px-3 py-1.5 text-sm font-bold rounded-lg transition-all btn-press flex items-center gap-2',
              subTab === 'history'
                ? 'bg-surface-light text-text-primary'
                : 'text-text-muted hover:text-text-primary'
            )}
          >
            <History className="w-3.5 h-3.5" />
            Trade History
            {transactions.length > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-accent/20 text-accent font-black">
                {transactions.length}
              </span>
            )}
          </button>
        </div>
        {subTab === 'history' && realizedPnL !== 0 && (
          <div className={cn(
            "text-sm font-mono font-bold",
            realizedPnL >= 0 ? 'text-long' : 'text-short'
          )}>
            Realized P&L: {realizedPnL >= 0 ? '+' : ''}${realizedPnL.toFixed(2)}
          </div>
        )}
      </div>

      {subTab === 'open' ? (
        <OpenPositionsContent 
          openOrders={openOrders}
          positions={positions}
          isLoading={isLoading}
          onCancel={onCancel}
          isCancelling={isCancelling}
        />
      ) : (
        <TradeHistoryContent transactions={transactions} isLoading={isLoading} />
      )}
    </div>
  );
}

function OpenPositionsContent({ openOrders, positions, isLoading, onCancel, isCancelling }: any) {
  if (isLoading && openOrders.length === 0 && positions.length === 0) {
    return (
      <div className="p-4 space-y-2">
        {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-xl skeleton" />)}
      </div>
    );
  }

  if (openOrders.length === 0 && positions.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-surface-light/50 flex items-center justify-center">
          <Target className="w-8 h-8 text-text-muted/50" />
        </div>
        <p className="text-text-muted text-lg font-medium">No open positions</p>
        <p className="text-sm text-text-muted/70 mt-1">Start trading to see your positions here</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/30">
      {/* Active Positions */}
      {positions.map((position: any) => (
        <PositionRow key={position.marketAddress} position={position} />
      ))}
      
      {/* Open Orders */}
      {openOrders.map((order: ApiOrder) => (
        <OpenOrderRow key={order.id} order={order} onCancel={onCancel} isCancelling={isCancelling} />
      ))}
    </div>
  );
}

function PositionRow({ position }: { position: any }) {
  const isYes = position.yesShares > 0;
  const shares = isYes ? position.yesShares : position.noShares;
  const pnl = position.unrealizedPnL;
  
  return (
    <div className="p-4 hover:bg-surface-light/20 transition-colors animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold">{position.market}</span>
              <span className={cn(
                'px-2 py-0.5 rounded text-xs font-bold uppercase',
                isYes ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
              )}>
                {isYes ? 'ABOVE' : 'BELOW'}
              </span>
            </div>
            <div className="text-xs text-text-muted mt-1">
              Avg: ${position.avgCost.toFixed(2)}
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="font-mono font-bold">{shares.toFixed(0)} contracts</div>
            <div className="text-sm text-text-muted">@ ${position.currentPrice.toFixed(2)}</div>
          </div>
          
          <div className="w-24 text-right">
            <div className={cn(
              'flex items-center justify-end gap-1 font-mono font-bold',
              pnl >= 0 ? 'text-long' : 'text-short'
            )}>
              {pnl >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OpenOrderRow({ order, onCancel, isCancelling }: { order: ApiOrder; onCancel: (id: string) => void; isCancelling: boolean }) {
  const fillPercent = (order.filledSize / order.size) * 100;
  
  return (
    <div className="p-4 hover:bg-surface-light/20 transition-colors animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
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
              <span className="px-2 py-0.5 rounded text-xs font-bold bg-warning/20 text-warning">
                LIMIT
              </span>
            </div>
            <div className="flex items-center gap-1 text-xs text-text-muted mt-1">
              <Clock className="w-3 h-3" />
              {new Date(order.createdAt).toLocaleString()}
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="font-mono font-bold">{order.size.toFixed(0)} contracts</div>
            <div className="text-sm text-text-muted">@ ${order.price.toFixed(2)}</div>
          </div>
          
          <div className="w-20 text-right">
            <div className="font-mono text-xs font-bold mb-1">{fillPercent.toFixed(0)}%</div>
            <div className="h-1.5 bg-surface-light rounded-full overflow-hidden">
              <div 
                className="h-full bg-accent transition-all"
                style={{ width: `${fillPercent}%` }}
              />
            </div>
          </div>
          
          <button
            onClick={() => onCancel(order.id)}
            disabled={isCancelling}
            className="p-2 text-text-muted hover:text-short hover:bg-short/10 rounded-lg transition-all btn-press"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function TradeHistoryContent({ transactions, isLoading }: { transactions: UserTransaction[]; isLoading: boolean }) {
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
  const hasPnl = pnl !== undefined && pnl !== null && !isNaN(pnl);
  const outcomeNorm = (transaction.outcome || '').toLowerCase();
  const isYes = outcomeNorm === 'yes' || outcomeNorm === 'above';

  const solscanUrl = transaction.txSignature 
    ? `https://solscan.io/tx/${transaction.txSignature}` 
    : null;

  return (
    <div className="p-4 hover:bg-surface-light/20 transition-colors animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold">{transaction.market || '--'}</span>
              <span className={cn(
                'px-2 py-0.5 rounded text-xs font-bold uppercase',
                isYes ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
              )}>
                {isYes ? 'ABOVE' : 'BELOW'}
              </span>
              <span className={cn(
                'px-2 py-0.5 rounded text-xs font-bold',
                isSettlement ? 'bg-violet/20 text-violet' : isOpening ? 'bg-accent/20 text-accent' : 'bg-warning/20 text-warning'
              )}>
                {isSettlement ? 'SETTLED' : isOpening ? 'OPEN' : 'CLOSE'}
              </span>
            </div>
            <div className="text-xs text-text-muted mt-1">
              {transaction.timestamp ? new Date(transaction.timestamp).toLocaleString() : '--'}
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="font-mono font-bold">{transaction.size.toFixed(0)} contracts</div>
            <div className="text-sm text-text-muted">@ ${transaction.price.toFixed(2)}</div>
          </div>
          
          <div className="w-28 text-right">
            {hasPnl ? (
              <div className={cn(
                'flex items-center justify-end gap-1 font-mono font-bold',
                pnl >= 0 ? 'text-long' : 'text-short'
              )}>
                {pnl >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                <span>{pnl >= 0 ? '+' : '-'}${Math.abs(pnl).toFixed(2)}</span>
              </div>
            ) : (
              <span className="text-text-muted">--</span>
            )}
          </div>
          
          {solscanUrl ? (
            <a
              href={solscanUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 text-text-muted hover:text-accent hover:bg-accent/10 rounded-lg transition-all btn-press"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          ) : (
            <div className="w-8" />
          )}
        </div>
      </div>
    </div>
  );
}

// =================== ANALYTICS TAB ===================
function AnalyticsTab({ metrics, positions }: { metrics: any; positions: any[] }) {
  return (
    <div className="p-6 space-y-6">
      {/* Key Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Win Rate" value={`${metrics.winRate.toFixed(1)}%`} color={metrics.winRate >= 50 ? 'long' : 'short'} />
        <StatCard label="Profit Factor" value={metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)} color={metrics.profitFactor >= 1 ? 'long' : 'short'} />
        <StatCard label="Avg Win" value={`$${metrics.avgWin.toFixed(2)}`} color="long" />
        <StatCard label="Avg Loss" value={`$${metrics.avgLoss.toFixed(2)}`} color="short" />
      </div>

      {/* Trading Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-surface-light/30 rounded-xl p-4">
          <div className="flex items-center gap-2 text-long mb-2">
            <Trophy className="w-4 h-4" />
            <span className="text-sm font-medium">Biggest Win</span>
          </div>
          <div className="text-2xl font-mono font-bold text-long">+${metrics.biggestWin.toFixed(2)}</div>
        </div>
        <div className="bg-surface-light/30 rounded-xl p-4">
          <div className="flex items-center gap-2 text-short mb-2">
            <Flame className="w-4 h-4" />
            <span className="text-sm font-medium">Biggest Loss</span>
          </div>
          <div className="text-2xl font-mono font-bold text-short">-${Math.abs(metrics.biggestLoss).toFixed(2)}</div>
        </div>
      </div>

      {/* Win/Loss Bar */}
      {metrics.totalTrades > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2 text-sm">
            <span className="text-text-muted">{metrics.totalTrades} total trades</span>
            <span className="font-mono font-bold">{metrics.winningTrades}W / {metrics.losingTrades}L</span>
          </div>
          <div className="h-8 flex rounded-lg overflow-hidden">
            <div 
              className="bg-long flex items-center justify-center"
              style={{ width: `${metrics.winRate}%` }}
            >
              {metrics.winRate >= 20 && (
                <span className="text-background font-bold text-xs">{metrics.winRate.toFixed(0)}%</span>
              )}
            </div>
            <div 
              className="bg-short flex items-center justify-center"
              style={{ width: `${100 - metrics.winRate}%` }}
            >
              {(100 - metrics.winRate) >= 20 && (
                <span className="text-background font-bold text-xs">{(100 - metrics.winRate).toFixed(0)}%</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Position Breakdown */}
      {positions.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-text-muted mb-3">Position Breakdown by Asset</h3>
          <div className="space-y-2">
            {Object.entries(metrics.assetBreakdown).map(([asset, value]: [string, any]) => {
              const percent = metrics.activeValue > 0 ? (value / metrics.activeValue) * 100 : 0;
              const colors: Record<string, string> = {
                BTC: 'bg-orange',
                ETH: 'bg-electric-blue',
                SOL: 'bg-violet',
              };
              return (
                <div key={asset} className="flex items-center gap-3">
                  <div className="w-10 text-sm font-bold">{asset}</div>
                  <div className="flex-1 h-6 bg-surface-light rounded-lg overflow-hidden">
                    <div 
                      className={cn("h-full transition-all duration-500", colors[asset] || 'bg-accent')}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <div className="w-24 text-right">
                    <span className="font-mono font-bold">${value.toFixed(2)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: 'long' | 'short' | 'accent' }) {
  return (
    <div className="bg-surface-light/30 rounded-xl p-4">
      <div className="text-xs text-text-muted mb-1">{label}</div>
      <div className={cn("text-xl font-mono font-bold", `text-${color}`)}>{value}</div>
    </div>
  );
}

// =================== SETTINGS TAB ===================
function SettingsTab(props: any) {
  const {
    connected,
    isDelegationApproved,
    delegatedAmount,
    approveDelegation,
    revokeDelegation,
    isApproving,
    delegationInput,
    setDelegationInput,
    showDelegationEdit,
    setShowDelegationEdit,
    oneClickEnabled,
    oneClickAmount,
    quickTradePresets,
    showPnLPercent,
    confirmTrades,
    soundEnabled,
    defaultOrderType,
    defaultSlippage,
    setOneClickEnabled,
    setOneClickAmount,
    setShowPnLPercent,
    setConfirmTrades,
    setSoundEnabled,
    setDefaultOrderType,
    setDefaultSlippage,
    removeQuickTradePreset,
    resetToDefaults,
    newPresetAmount,
    setNewPresetAmount,
    showAddPreset,
    setShowAddPreset,
    handleAddPreset,
    disconnect,
  } = props;

  return (
    <div className="p-4 space-y-6">
      {/* Delegated Balance */}
      <section>
        <h3 className="text-sm font-bold text-text-muted mb-3 flex items-center gap-2">
          <Shield className="w-4 h-4" />
          Delegated Balance
        </h3>
        <div className="bg-surface-light/30 rounded-xl p-4">
          {isDelegationApproved ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-text-muted">Delegated Amount</span>
                <span className="font-mono font-bold text-accent">
                  ${(delegatedAmount / 1_000_000).toFixed(2)} USDC
                </span>
              </div>
              {showDelegationEdit ? (
                <div className="space-y-3">
                  <input
                    type="number"
                    value={delegationInput}
                    onChange={(e) => setDelegationInput(e.target.value)}
                    placeholder="New amount"
                    className="w-full px-4 py-2 rounded-lg bg-surface border border-border text-text-primary font-mono focus:border-accent"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => setShowDelegationEdit(false)} className="flex-1 py-2 rounded-lg border border-border text-text-muted hover:text-text-primary transition-colors btn-press">Cancel</button>
                    <button
                      onClick={async () => {
                        const amount = parseFloat(delegationInput) * 1_000_000;
                        if (amount > 0) {
                          await approveDelegation(amount);
                          setShowDelegationEdit(false);
                        }
                      }}
                      disabled={isApproving}
                      className="flex-1 py-2 rounded-lg bg-accent text-background font-bold btn-press"
                    >
                      {isApproving ? 'Updating...' : 'Update'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setDelegationInput((delegatedAmount / 1_000_000).toString());
                      setShowDelegationEdit(true);
                    }}
                    className="flex-1 py-2 rounded-lg bg-surface text-text-primary hover:bg-border transition-colors btn-press"
                  >
                    Adjust
                  </button>
                  <button
                    onClick={() => revokeDelegation()}
                    disabled={isApproving}
                    className="px-4 py-2 rounded-lg border border-short/30 text-short hover:bg-short/10 transition-colors btn-press"
                  >
                    Revoke
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => approveDelegation()}
              disabled={isApproving || !connected}
              className="w-full py-3 rounded-lg bg-accent text-background font-bold hover:bg-accent-dim transition-all btn-press flex items-center justify-center gap-2"
            >
              {isApproving ? <><RefreshCw className="w-4 h-4 animate-spin" /> Enabling...</> : <><Zap className="w-4 h-4" /> Delegate USDC</>}
            </button>
          )}
        </div>
      </section>

      {/* One-Click Trading */}
      <section>
        <h3 className="text-sm font-bold text-text-muted mb-3 flex items-center gap-2">
          <Zap className="w-4 h-4" />
          One-Click Trading
        </h3>
        <div className="bg-surface-light/30 rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">Enable One-Click Mode</div>
              <div className="text-sm text-text-muted">Trade instantly by tapping the price</div>
            </div>
            <button
              onClick={() => setOneClickEnabled(!oneClickEnabled)}
              className={cn("w-12 h-7 rounded-full transition-all relative btn-press", oneClickEnabled ? "bg-accent" : "bg-surface-light border border-border")}
            >
              <div className={cn("w-5 h-5 rounded-full bg-white shadow-md absolute top-1 transition-all", oneClickEnabled ? "left-6" : "left-1")} />
            </button>
          </div>

          <div className={cn("space-y-3", !oneClickEnabled && "opacity-50 pointer-events-none")}>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">Default Amount</span>
              <span className="font-mono font-bold text-accent">${oneClickAmount}</span>
            </div>
            <input
              type="range"
              value={oneClickAmount}
              onChange={(e) => setOneClickAmount(parseInt(e.target.value))}
              min="10"
              max="1000"
              step="10"
              className="w-full accent-accent"
            />
          </div>

          {oneClickEnabled && (
            <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
              <AlertCircle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
              <p className="text-xs text-warning">One-click trading executes trades immediately. Ensure you have delegated USDC.</p>
            </div>
          )}
        </div>
      </section>

      {/* Preferences */}
      <section>
        <h3 className="text-sm font-bold text-text-muted mb-3 flex items-center gap-2">
          <Settings className="w-4 h-4" />
          Preferences
        </h3>
        <div className="bg-surface-light/30 rounded-xl divide-y divide-border/30">
          {/* Order Type */}
          <div className="p-4 flex items-center justify-between">
            <span className="font-medium">Default Order Type</span>
            <div className="flex gap-1 bg-surface rounded-lg p-1">
              <button onClick={() => setDefaultOrderType('market')} className={cn("px-3 py-1 rounded text-sm font-medium btn-press", defaultOrderType === 'market' ? "bg-accent text-background" : "text-text-muted")}>Market</button>
              <button onClick={() => setDefaultOrderType('limit')} className={cn("px-3 py-1 rounded text-sm font-medium btn-press", defaultOrderType === 'limit' ? "bg-accent text-background" : "text-text-muted")}>Limit</button>
            </div>
          </div>

          {/* Slippage */}
          <div className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium">Max Slippage</span>
              <span className="font-mono font-bold text-accent">${defaultSlippage.toFixed(2)}</span>
            </div>
            <input
              type="range"
              value={defaultSlippage * 100}
              onChange={(e) => setDefaultSlippage(parseInt(e.target.value) / 100)}
              min="1"
              max="25"
              className="w-full accent-accent"
            />
          </div>

          {/* Toggles */}
          <ToggleRow label="Show P&L Percentage" value={showPnLPercent} onChange={() => setShowPnLPercent(!showPnLPercent)} icon={showPnLPercent ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />} />
          <ToggleRow label="Confirm Trades" value={confirmTrades} onChange={() => setConfirmTrades(!confirmTrades)} icon={<Check className="w-4 h-4" />} />
          <ToggleRow label="Sound Effects" value={soundEnabled} onChange={() => setSoundEnabled(!soundEnabled)} icon={soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />} />
        </div>
      </section>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={() => {
            if (confirm('Reset all settings to defaults?')) {
              resetToDefaults();
            }
          }}
          className="flex-1 py-2 rounded-lg border border-border text-text-muted hover:text-short hover:border-short/30 transition-colors btn-press flex items-center justify-center gap-2"
        >
          <Trash2 className="w-4 h-4" />
          Reset Settings
        </button>
        <button
          onClick={() => disconnect()}
          className="flex-1 py-2 rounded-lg border border-border text-text-muted hover:text-short hover:border-short/30 transition-colors btn-press"
        >
          Disconnect Wallet
        </button>
      </div>
    </div>
  );
}

function ToggleRow({ label, value, onChange, icon }: { label: string; value: boolean; onChange: () => void; icon: React.ReactNode }) {
  return (
    <div className="p-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-text-muted">{icon}</span>
        <span className="font-medium">{label}</span>
      </div>
      <button
        onClick={onChange}
        className={cn("w-12 h-7 rounded-full transition-all relative btn-press", value ? "bg-accent" : "bg-surface-light border border-border")}
      >
        <div className={cn("w-5 h-5 rounded-full bg-white shadow-md absolute top-1 transition-all", value ? "left-6" : "left-1")} />
      </button>
    </div>
  );
}
