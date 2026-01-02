'use client';

import { useMemo } from 'react';
import { Header } from '@/components/layout/Header';
import { useUser, useTotalPnL, useBalance } from '@/hooks/useUser';
import { useAuthStore } from '@/stores/authStore';
import { cn } from '@/lib/utils';
import { 
  ArrowLeft, 
  TrendingUp, 
  TrendingDown, 
  DollarSign,
  Target,
  Percent,
  Activity,
  PieChart,
  BarChart3,
  Calendar,
  Trophy,
  Flame,
  Wallet,
  RefreshCw
} from 'lucide-react';
import Link from 'next/link';

export default function PortfolioPage() {
  const { isAuthenticated } = useAuthStore();
  const { balance } = useBalance();
  const totalPnL = useTotalPnL();
  const { 
    positions,
    transactions,
    positionsLoading,
    transactionsLoading,
    refetchAll
  } = useUser();

  // Calculate portfolio metrics
  const metrics = useMemo(() => {
    const allTrades = transactions || [];
    const closedTrades = allTrades.filter(t => t.pnl !== undefined && t.pnl !== null);
    
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
    
    // Biggest win/loss
    const biggestWin = winningTrades.length > 0 
      ? Math.max(...winningTrades.map(t => t.pnl ?? 0)) 
      : 0;
    const biggestLoss = losingTrades.length > 0 
      ? Math.min(...losingTrades.map(t => t.pnl ?? 0)) 
      : 0;
    
    // Active positions value
    const activeValue = positions.reduce((sum, p) => {
      const shares = p.yesShares + p.noShares;
      return sum + shares * p.currentPrice;
    }, 0);
    
    // Unrealized PnL from positions
    const unrealizedPnL = positions.reduce((sum, p) => sum + p.unrealizedPnL, 0);
    
    // Asset breakdown
    const assetBreakdown = positions.reduce((acc, p) => {
      const asset = p.market.split('-')[0] || 'OTHER';
      if (!acc[asset]) acc[asset] = 0;
      acc[asset] += (p.yesShares + p.noShares) * p.currentPrice;
      return acc;
    }, {} as Record<string, number>);
    
    // Outcome breakdown
    const yesPositions = positions.filter(p => p.yesShares > 0).length;
    const noPositions = positions.filter(p => p.noShares > 0).length;
    
    // Streak calculation
    let currentStreak = 0;
    let maxWinStreak = 0;
    let tempWinStreak = 0;
    
    for (const trade of closedTrades.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))) {
      if ((trade.pnl ?? 0) > 0) {
        tempWinStreak++;
        maxWinStreak = Math.max(maxWinStreak, tempWinStreak);
        if (currentStreak >= 0) currentStreak++;
        else currentStreak = 1;
      } else {
        tempWinStreak = 0;
        if (currentStreak <= 0) currentStreak--;
        else currentStreak = -1;
      }
    }
    
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
      currentStreak,
      maxWinStreak,
    };
  }, [transactions, positions]);

  const isLoading = positionsLoading || transactionsLoading;

  return (
    <div className="min-h-screen bg-background bg-gradient-mesh">
      <Header />

      <main className="max-w-6xl mx-auto p-4 pb-24">
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
            <h1 className="text-2xl font-display font-bold">Portfolio Analytics</h1>
            <p className="text-text-muted">Track your trading performance</p>
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
              <PieChart className="w-10 h-10 text-text-muted/50" />
            </div>
            <h2 className="text-xl font-display font-bold mb-2">Connect Wallet</h2>
            <p className="text-text-muted">Connect your wallet to view your portfolio analytics</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Top Row - Key Metrics */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Total Balance */}
              <div className="glass-card rounded-2xl border border-border/50 p-6">
                <div className="flex items-center gap-2 text-text-muted mb-3">
                  <Wallet className="w-4 h-4" />
                  <span className="text-sm font-medium uppercase tracking-wide">Total Balance</span>
                </div>
                <div className="text-3xl font-display font-bold text-accent">
                  ${balance?.total?.toFixed(2) || '0.00'}
                </div>
                <div className="text-sm text-text-muted mt-1">
                  Available: ${balance?.available?.toFixed(2) || '0.00'}
                </div>
              </div>

              {/* Unrealized P&L */}
              <div className="glass-card rounded-2xl border border-border/50 p-6">
                <div className="flex items-center gap-2 text-text-muted mb-3">
                  <Activity className="w-4 h-4" />
                  <span className="text-sm font-medium uppercase tracking-wide">Unrealized P&L</span>
                </div>
                <div className={cn(
                  "text-3xl font-display font-bold flex items-center gap-2",
                  metrics.unrealizedPnL >= 0 ? 'text-long' : 'text-short'
                )}>
                  {metrics.unrealizedPnL >= 0 ? <TrendingUp className="w-6 h-6" /> : <TrendingDown className="w-6 h-6" />}
                  {metrics.unrealizedPnL >= 0 ? '+' : ''}${Math.abs(metrics.unrealizedPnL).toFixed(2)}
                </div>
                <div className="text-sm text-text-muted mt-1">
                  From {positions.length} active position{positions.length !== 1 ? 's' : ''}
                </div>
              </div>

              {/* Realized P&L */}
              <div className="glass-card rounded-2xl border border-border/50 p-6">
                <div className="flex items-center gap-2 text-text-muted mb-3">
                  <DollarSign className="w-4 h-4" />
                  <span className="text-sm font-medium uppercase tracking-wide">Realized P&L</span>
                </div>
                <div className={cn(
                  "text-3xl font-display font-bold flex items-center gap-2",
                  metrics.realizedPnL >= 0 ? 'text-long' : 'text-short'
                )}>
                  {metrics.realizedPnL >= 0 ? <TrendingUp className="w-6 h-6" /> : <TrendingDown className="w-6 h-6" />}
                  {metrics.realizedPnL >= 0 ? '+' : ''}${Math.abs(metrics.realizedPnL).toFixed(2)}
                </div>
                <div className="text-sm text-text-muted mt-1">
                  From {metrics.totalTrades} closed trade{metrics.totalTrades !== 1 ? 's' : ''}
                </div>
              </div>

              {/* Win Rate */}
              <div className="glass-card rounded-2xl border border-border/50 p-6">
                <div className="flex items-center gap-2 text-text-muted mb-3">
                  <Target className="w-4 h-4" />
                  <span className="text-sm font-medium uppercase tracking-wide">Win Rate</span>
                </div>
                <div className={cn(
                  "text-3xl font-display font-bold",
                  metrics.winRate >= 50 ? 'text-long' : 'text-short'
                )}>
                  {metrics.winRate.toFixed(1)}%
                </div>
                <div className="text-sm text-text-muted mt-1">
                  {metrics.winningTrades}W / {metrics.losingTrades}L
                </div>
              </div>
            </div>

            {/* Second Row - Performance Metrics */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Trading Stats */}
              <div className="glass-card rounded-2xl border border-border/50 p-6">
                <div className="flex items-center gap-2 mb-6">
                  <BarChart3 className="w-5 h-5 text-accent" />
                  <h2 className="font-display font-bold text-lg">Trading Statistics</h2>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <StatItem 
                    label="Average Win" 
                    value={`$${metrics.avgWin.toFixed(2)}`}
                    icon={<TrendingUp className="w-4 h-4" />}
                    color="long"
                  />
                  <StatItem 
                    label="Average Loss" 
                    value={`$${metrics.avgLoss.toFixed(2)}`}
                    icon={<TrendingDown className="w-4 h-4" />}
                    color="short"
                  />
                  <StatItem 
                    label="Biggest Win" 
                    value={`$${metrics.biggestWin.toFixed(2)}`}
                    icon={<Trophy className="w-4 h-4" />}
                    color="long"
                  />
                  <StatItem 
                    label="Biggest Loss" 
                    value={`$${Math.abs(metrics.biggestLoss).toFixed(2)}`}
                    icon={<Flame className="w-4 h-4" />}
                    color="short"
                  />
                  <StatItem 
                    label="Profit Factor" 
                    value={metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}
                    icon={<Percent className="w-4 h-4" />}
                    color={metrics.profitFactor >= 1 ? 'long' : 'short'}
                  />
                  <StatItem 
                    label="Current Streak" 
                    value={`${metrics.currentStreak > 0 ? '+' : ''}${metrics.currentStreak}`}
                    icon={<Flame className="w-4 h-4" />}
                    color={metrics.currentStreak >= 0 ? 'long' : 'short'}
                  />
                </div>
              </div>

              {/* Position Breakdown */}
              <div className="glass-card rounded-2xl border border-border/50 p-6">
                <div className="flex items-center gap-2 mb-6">
                  <PieChart className="w-5 h-5 text-accent" />
                  <h2 className="font-display font-bold text-lg">Position Breakdown</h2>
                </div>
                
                {positions.length === 0 ? (
                  <div className="text-center py-8">
                    <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-surface-light/50 flex items-center justify-center">
                      <Target className="w-6 h-6 text-text-muted/50" />
                    </div>
                    <p className="text-text-muted">No active positions</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Asset Distribution */}
                    <div>
                      <div className="text-sm text-text-muted mb-2">By Asset</div>
                      <div className="space-y-2">
                        {Object.entries(metrics.assetBreakdown).map(([asset, value]) => {
                          const percent = metrics.activeValue > 0 ? (value / metrics.activeValue) * 100 : 0;
                          const colors: Record<string, string> = {
                            BTC: 'bg-orange',
                            ETH: 'bg-violet',
                            SOL: 'bg-electric-blue',
                          };
                          return (
                            <div key={asset} className="flex items-center gap-3">
                              <div className="w-12 text-sm font-bold">{asset}</div>
                              <div className="flex-1 h-6 bg-surface-light rounded-lg overflow-hidden">
                                <div 
                                  className={cn("h-full transition-all duration-500", colors[asset] || 'bg-accent')}
                                  style={{ width: `${percent}%` }}
                                />
                              </div>
                              <div className="w-24 text-right">
                                <span className="font-mono font-bold">${value.toFixed(2)}</span>
                                <span className="text-text-muted text-xs ml-1">({percent.toFixed(0)}%)</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    
                    {/* Outcome Split */}
                    <div className="pt-4 border-t border-border/50">
                      <div className="text-sm text-text-muted mb-2">By Outcome</div>
                      <div className="flex items-center gap-4">
                        <div className="flex-1 flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full bg-long" />
                          <span className="text-sm">ABOVE</span>
                          <span className="font-mono font-bold text-long">{metrics.yesPositions}</span>
                        </div>
                        <div className="flex-1 flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full bg-short" />
                          <span className="text-sm">BELOW</span>
                          <span className="font-mono font-bold text-short">{metrics.noPositions}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Win/Loss Breakdown Bar */}
            {metrics.totalTrades > 0 && (
              <div className="glass-card rounded-2xl border border-border/50 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-display font-bold text-lg">Win/Loss Distribution</h2>
                  <div className="text-sm text-text-muted">
                    {metrics.totalTrades} total trades
                  </div>
                </div>
                
                <div className="h-12 flex rounded-xl overflow-hidden">
                  <div 
                    className="bg-long flex items-center justify-center transition-all duration-500"
                    style={{ width: `${metrics.winRate}%` }}
                  >
                    {metrics.winRate >= 20 && (
                      <span className="text-background font-bold text-sm">
                        {metrics.winningTrades} Wins
                      </span>
                    )}
                  </div>
                  <div 
                    className="bg-short flex items-center justify-center transition-all duration-500"
                    style={{ width: `${100 - metrics.winRate}%` }}
                  >
                    {(100 - metrics.winRate) >= 20 && (
                      <span className="text-background font-bold text-sm">
                        {metrics.losingTrades} Losses
                      </span>
                    )}
                  </div>
                </div>
                
                <div className="flex justify-between mt-2 text-sm">
                  <span className="text-long font-bold">{metrics.winRate.toFixed(1)}% Win Rate</span>
                  <span className="text-short font-bold">{(100 - metrics.winRate).toFixed(1)}% Loss Rate</span>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function StatItem({ 
  label, 
  value, 
  icon, 
  color 
}: { 
  label: string; 
  value: string; 
  icon: React.ReactNode;
  color: 'long' | 'short' | 'accent' | 'warning';
}) {
  const colorClasses = {
    long: 'text-long bg-long/10',
    short: 'text-short bg-short/10',
    accent: 'text-accent bg-accent/10',
    warning: 'text-warning bg-warning/10',
  };
  
  return (
    <div className="flex items-center gap-3 p-3 bg-surface-light/30 rounded-xl">
      <div className={cn(
        "w-10 h-10 rounded-lg flex items-center justify-center",
        colorClasses[color]
      )}>
        {icon}
      </div>
      <div>
        <div className="text-xs text-text-muted">{label}</div>
        <div className={cn("font-mono font-bold text-lg", `text-${color}`)}>{value}</div>
      </div>
    </div>
  );
}

