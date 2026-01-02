'use client';

import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Header } from '@/components/layout/Header';
import { usePrices } from '@/hooks/usePrices';
import { useUser, useTotalPnL } from '@/hooks/useUser';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown, Activity, Wallet, ChevronRight, RefreshCw, CheckCircle, Settings, X, Zap, Shield, DollarSign, Target } from 'lucide-react';
import Link from 'next/link';
import { useDelegation } from '@/hooks/useDelegation';

export default function Home() {
  const { connected } = useWallet();
  const { prices, loading: pricesLoading, refetch: refetchPrices } = usePrices();
  const { isAuthenticated, isAuthenticating } = useAuth();
  const { balance, positions, balanceLoading, positionsLoading, refetchAll } = useUser();
  const { isApproved: isDelegationApproved, delegatedAmount, approve: approveDelegation, revoke: revokeDelegation, isApproving } = useDelegation();
  const totalPnL = useTotalPnL();
  const [showDelegationSettings, setShowDelegationSettings] = useState(false);
  const [delegationInput, setDelegationInput] = useState('');

  const totalValue = positions.reduce((sum, p) => {
    const shares = p.yesShares + p.noShares;
    const avgPrice = p.avgEntryPrice;
    return sum + shares * avgPrice;
  }, 0);

  return (
    <div className="min-h-screen bg-background bg-gradient-mesh">
      <Header />

      <main className="max-w-lg mx-auto p-4 space-y-4 pb-24">
        {/* Balance Card */}
        <div className="glass-card rounded-2xl border border-border/50 p-6 animate-fade-in">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-text-muted">
              <Wallet className="w-4 h-4" />
              <span className="text-sm font-medium uppercase tracking-wide">Balance</span>
            </div>
            {connected && (
              <button 
                onClick={() => refetchAll()}
                className="p-2 hover:bg-surface-light rounded-lg transition-all btn-press"
                disabled={balanceLoading}
              >
                <RefreshCw className={cn('w-4 h-4 text-text-muted', balanceLoading && 'animate-spin')} />
              </button>
            )}
          </div>
          
          <div className="text-4xl font-display font-bold text-accent tracking-tight">
            {connected && balance && typeof balance.total === 'number' 
              ? `$${balance.total.toFixed(2)}` 
              : '$0.00'}
          </div>
          
          {connected && balance && typeof balance.available === 'number' && (
            <div className="mt-3 flex items-center gap-4 text-sm">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-long animate-live-pulse" />
                <span className="text-text-muted">Available:</span>
                <span className="text-text-primary font-mono font-medium">${balance.available.toFixed(2)}</span>
              </div>
              {typeof balance.lockedInOrders === 'number' && balance.lockedInOrders > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-warning" />
                  <span className="text-text-muted">In orders:</span>
                  <span className="text-text-primary font-mono font-medium">${balance.lockedInOrders.toFixed(2)}</span>
                </div>
              )}
            </div>
          )}
          
          {/* Fast Trading Section */}
          {connected && (
            <div className="mt-5 pt-5 border-t border-border/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={cn(
                    "w-8 h-8 rounded-lg flex items-center justify-center",
                    isDelegationApproved ? "bg-long/20" : "bg-surface-light"
                  )}>
                    <Zap className={cn("w-4 h-4", isDelegationApproved ? "text-long" : "text-text-muted")} />
                  </div>
                  <div>
                    <span className="text-sm font-medium">Fast Trading</span>
                    <p className="text-xs text-text-muted">
                      {isDelegationApproved ? 'Enabled - skip wallet approvals' : 'Enable to trade faster'}
                    </p>
                  </div>
                </div>
                
                {isDelegationApproved ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono font-bold text-accent">
                      ${(delegatedAmount / 1_000_000).toFixed(0)}
                    </span>
                    <button
                      onClick={() => {
                        setDelegationInput(((delegatedAmount || 0) / 1_000_000).toFixed(2));
                        setShowDelegationSettings(true);
                      }}
                      className="p-2 hover:bg-surface-light rounded-lg transition-all btn-press"
                      title="Fast Trading Settings"
                    >
                      <Settings className="w-4 h-4 text-text-muted" />
                    </button>
                  </div>
                ) : (
                  <button 
                    onClick={() => approveDelegation()}
                    disabled={isApproving}
                    className="px-4 py-2 rounded-lg bg-accent text-background font-bold text-sm hover:bg-accent-light transition-all btn-press flex items-center gap-1.5"
                  >
                    {isApproving ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Enabling...
                      </>
                    ) : (
                      <>
                        <Zap className="w-3.5 h-3.5" />
                        Enable
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Positions Card */}
        <div className="glass-card rounded-2xl border border-border/50 p-4 animate-fade-in stagger-1">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-display font-bold">Positions</h2>
            {connected && positions.length > 0 && (
              <div className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-mono font-bold',
                totalPnL >= 0 ? 'text-long bg-long/10' : 'text-short bg-short/10'
              )}>
                {totalPnL >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
              </div>
            )}
          </div>

          {!connected ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-surface-light/50 flex items-center justify-center">
                <Wallet className="w-8 h-8 text-text-muted/50" />
              </div>
              <p className="text-text-muted">Connect wallet to view positions</p>
            </div>
          ) : positionsLoading ? (
            <div className="space-y-2">
              {[1, 2].map(i => (
                <div key={i} className="h-16 rounded-xl skeleton" />
              ))}
            </div>
          ) : positions.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-surface-light/50 flex items-center justify-center">
                <Target className="w-8 h-8 text-text-muted/50" />
              </div>
              <p className="text-text-muted">No open positions</p>
              <p className="text-sm text-text-muted/70 mt-1">Start trading to see your positions here</p>
            </div>
          ) : (
            <div className="space-y-2">
              {positions.map((position, i) => (
                <HoldingRow key={position.marketAddress} position={position} index={i} />
              ))}
            </div>
          )}
        </div>

        {/* Markets Section */}
        <div className="animate-fade-in stagger-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-display font-bold">Markets</h2>
            {pricesLoading && (
              <RefreshCw className="w-4 h-4 text-accent animate-spin" />
            )}
          </div>
          <div className="space-y-3">
            <MarketCard 
              asset="BTC" 
              name="Bitcoin" 
              price={prices.BTC}
              change={2.34}
              color="orange"
              index={0}
            />
            <MarketCard 
              asset="ETH" 
              name="Ethereum" 
              price={prices.ETH}
              change={-1.23}
              color="violet"
              index={1}
            />
            <MarketCard 
              asset="SOL" 
              name="Solana" 
              price={prices.SOL}
              change={5.67}
              color="electric-blue"
              index={2}
            />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/30 px-4 py-4 mt-8 glass">
        <div className="max-w-lg mx-auto flex items-center justify-center gap-3 text-sm">
          <Activity className="w-4 h-4 text-accent" />
          <span className="font-display font-bold">Degen Terminal</span>
          <span className="px-2 py-0.5 rounded-full bg-accent/10 text-accent text-xs font-bold">Devnet</span>
        </div>
      </footer>

      {/* Delegation Settings Modal */}
      {showDelegationSettings && connected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-md glass-strong rounded-2xl border border-border/50 overflow-hidden animate-fade-in-scale">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
              <div>
                <div className="font-display font-bold text-lg">Fast Trading</div>
                <div className="text-sm text-text-muted">Adjust USDC delegation</div>
              </div>
              <button
                onClick={() => setShowDelegationSettings(false)}
                className="p-2 hover:bg-surface-light rounded-lg transition-colors btn-press"
                aria-label="Close"
              >
                <X className="w-5 h-5 text-text-muted" />
              </button>
            </div>

            <div className="p-5 space-y-5">
              <div className="flex items-center justify-between p-4 bg-surface-light/50 rounded-xl">
                <span className="text-text-muted">Currently delegated</span>
                <span className="font-mono text-xl font-bold text-accent">${(delegatedAmount / 1_000_000).toFixed(2)}</span>
              </div>

              <div className="space-y-3">
                <label className="text-sm font-medium text-text-primary">New amount (USDC)</label>
                <input
                  value={delegationInput}
                  onChange={(e) => setDelegationInput(e.target.value)}
                  inputMode="decimal"
                  placeholder="e.g. 1000"
                  className="w-full px-4 py-3 rounded-xl bg-surface-light border border-border text-text-primary font-mono text-lg outline-none focus:border-accent transition-colors"
                />
                <div className="grid grid-cols-4 gap-2">
                  {[1000, 5000, 10000, 25000].map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setDelegationInput(amt.toString())}
                      className="py-2 text-sm font-mono font-bold rounded-lg bg-surface-light hover:bg-border border border-border text-text-primary transition-all btn-press"
                    >
                      ${(amt / 1000).toFixed(0)}k
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={async () => {
                    await revokeDelegation();
                    setShowDelegationSettings(false);
                  }}
                  disabled={isApproving}
                  className="flex-1 px-4 py-3 rounded-xl border border-short/30 text-short font-bold hover:bg-short/10 transition-colors btn-press"
                >
                  Revoke All
                </button>
                <button
                  onClick={async () => {
                    const parsed = Number(delegationInput);
                    if (!Number.isFinite(parsed) || parsed < 0) return;
                    const micro = Math.floor(parsed * 1_000_000);
                    await approveDelegation(micro);
                    setShowDelegationSettings(false);
                  }}
                  disabled={isApproving}
                  className="flex-1 px-4 py-3 rounded-xl bg-accent text-background font-bold hover:bg-accent-light transition-all btn-press flex items-center justify-center gap-2"
                >
                  {isApproving ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    'Save'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HoldingRow({ position, index }: { position: { 
  marketAddress: string;
  market: string;
  yesShares: number;
  noShares: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  status: string;
}, index: number }) {
  const outcome = position.yesShares > 0 ? 'YES' : 'NO';
  const shares = position.yesShares > 0 ? position.yesShares : position.noShares;
  const pnl = position.unrealizedPnL;
  const pnlPercent = position.avgEntryPrice > 0 
    ? ((position.currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100 
    : 0;

  const asset = position.market.split('-')[0]?.toLowerCase() || 'btc';

  return (
    <Link 
      href={`/market/${asset}`}
      className="flex items-center justify-between p-4 bg-surface-light/50 rounded-xl hover:bg-surface-light transition-all btn-press group"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex items-center gap-3">
        <span className={cn(
          'px-2.5 py-1.5 rounded-lg text-xs font-bold uppercase',
          outcome === 'YES' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
        )}>
          {outcome === 'YES' ? 'ABOVE' : 'BELOW'}
        </span>
        <div>
          <div className="font-mono font-bold text-sm">{position.market}</div>
          <div className="text-xs text-text-muted">
            {shares.toFixed(0)} contracts @ ${position.avgEntryPrice.toFixed(2)}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className={cn(
          'font-mono text-sm font-bold flex items-center gap-1 justify-end',
          pnl >= 0 ? 'text-long' : 'text-short'
        )}>
          {pnl >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {pnl >= 0 ? '+' : ''}${Math.abs(pnl).toFixed(2)}
        </div>
        <div className={cn(
          'text-xs font-medium',
          pnl >= 0 ? 'text-long/70' : 'text-short/70'
        )}>
          {pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%
        </div>
      </div>
    </Link>
  );
}

function MarketCard({ asset, name, price, change, color, index }: { 
  asset: string; 
  name: string; 
  price?: number;
  change: number;
  color: 'orange' | 'violet' | 'electric-blue';
  index: number;
}) {
  const isPositive = change >= 0;
  
  const formatPrice = (p: number | undefined) => {
    if (p === undefined) return '--';
    return p.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  const colorClasses = {
    orange: 'text-orange bg-orange/10 border-orange/20',
    violet: 'text-violet bg-violet/10 border-violet/20',
    'electric-blue': 'text-electric-blue bg-electric-blue/10 border-electric-blue/20',
  };

  return (
    <Link 
      href={`/market/${asset.toLowerCase()}`}
      className="flex items-center justify-between p-4 glass-card rounded-2xl border border-border/50 hover:border-accent/30 transition-all btn-press card-hover group"
      style={{ animationDelay: `${index * 100}ms` }}
    >
      <div className="flex items-center gap-4">
        <div className={cn(
          'w-12 h-12 rounded-xl flex items-center justify-center font-display font-bold text-lg border',
          colorClasses[color]
        )}>
          {asset.charAt(0)}
        </div>
        <div>
          <div className="font-display font-bold text-lg">{asset}</div>
          <div className="text-sm text-text-muted">{name}</div>
        </div>
      </div>
      
      <div className="flex items-center gap-4">
        <div className="text-right">
          <div className="font-mono font-bold text-lg" suppressHydrationWarning>
            ${formatPrice(price)}
          </div>
          <div className={cn(
            'flex items-center justify-end gap-1 text-xs font-bold',
            isPositive ? 'text-long' : 'text-short'
          )}>
            {isPositive ? (
              <TrendingUp className="w-3 h-3" />
            ) : (
              <TrendingDown className="w-3 h-3" />
            )}
            <span>{isPositive ? '+' : ''}{change.toFixed(2)}%</span>
          </div>
        </div>
        <ChevronRight className="w-5 h-5 text-text-muted group-hover:text-accent group-hover:translate-x-1 transition-all" />
      </div>
    </Link>
  );
}
