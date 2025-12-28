'use client';

import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Header } from '@/components/layout/Header';
import { usePrices } from '@/hooks/usePrices';
import { useUser, useTotalPnL } from '@/hooks/useUser';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown, Activity, Wallet, ChevronRight, RefreshCw, CheckCircle, Settings, X } from 'lucide-react';
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

  // NOTE: Auto sign-in is handled globally in `Header` so it works from any page.

  const totalValue = positions.reduce((sum, p) => {
    const shares = p.yesShares + p.noShares;
    const avgPrice = p.avgEntryPrice;
    return sum + shares * avgPrice;
  }, 0);

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-lg mx-auto p-4 space-y-4">
        {/* Balance Card */}
        <div className="bg-surface rounded-xl border border-border p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-text-muted">
              <Wallet className="w-4 h-4" />
              <span className="text-sm">Balance</span>
            </div>
            {connected && (
              <button 
                onClick={() => refetchAll()}
                className="p-1 hover:bg-surface-light rounded transition-colors"
                disabled={balanceLoading}
              >
                <RefreshCw className={cn('w-4 h-4 text-text-muted', balanceLoading && 'animate-spin')} />
              </button>
            )}
          </div>
          <div className="text-3xl font-bold font-mono text-text-primary">
            {connected && balance && typeof balance.total === 'number' 
              ? `$${balance.total.toFixed(2)}` 
              : '$0.00'}
          </div>
          {connected && balance && typeof balance.available === 'number' && (
            <div className="mt-1 text-sm text-text-muted">
              Available: <span className="text-accent">${balance.available.toFixed(2)}</span>
              {typeof balance.lockedInOrders === 'number' && balance.lockedInOrders > 0 && (
                <span className="ml-2">• In orders: ${balance.lockedInOrders.toFixed(2)}</span>
              )}
            </div>
          )}
          
          {connected && (
            <div className="mt-4 pt-4 border-t border-border">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-text-muted">
                  <CheckCircle className={cn("w-4 h-4", isDelegationApproved ? "text-long" : "text-short")} />
                  <span className="text-sm">Fast Trading</span>
                </div>
                {isDelegationApproved ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono font-medium text-text-primary">
                      ${(delegatedAmount / 1_000_000).toFixed(2)} Delegated
                    </span>
                    <button
                      onClick={() => {
                        setDelegationInput(((delegatedAmount || 0) / 1_000_000).toFixed(2));
                        setShowDelegationSettings(true);
                      }}
                      className="p-1 hover:bg-surface-light rounded transition-colors"
                      title="Fast Trading Settings"
                    >
                      <Settings className="w-4 h-4 text-text-muted" />
                    </button>
                  </div>
                ) : (
                  <button 
                    onClick={() => approveDelegation()}
                    disabled={isApproving}
                    className="text-sm text-accent hover:underline flex items-center gap-1"
                  >
                    {isApproving ? 'Enabling...' : 'Enable Now'}
                  </button>
                )}
              </div>
              {!isDelegationApproved && (
                <p className="mt-1 text-xs text-text-muted">
                  Enable fast trading to skip SOL gas fees on every trade.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Positions Card */}
        <div className="bg-surface rounded-xl border border-border p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Positions</h2>
            {connected && positions.length > 0 && (
              <div className={cn(
                'text-sm font-mono font-medium',
                totalPnL >= 0 ? 'text-long' : 'text-short'
              )}>
                {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
              </div>
            )}
          </div>

          {!connected ? (
            <div className="text-center py-8 text-text-muted">
              Connect wallet to view holdings
            </div>
          ) : positionsLoading ? (
            <div className="text-center py-8 text-text-muted">
              <RefreshCw className="w-5 h-5 mx-auto animate-spin mb-2" />
              Loading positions...
            </div>
          ) : positions.length === 0 ? (
            <div className="text-center py-8 text-text-muted">
              No open positions
            </div>
          ) : (
            <div className="space-y-2">
              {positions.map((position) => (
                <HoldingRow key={position.marketAddress} position={position} />
              ))}
            </div>
          )}
        </div>

        {/* Markets Section */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Markets</h2>
            {pricesLoading && (
              <RefreshCw className="w-4 h-4 text-text-muted animate-spin" />
            )}
          </div>
          <div className="space-y-3">
            <MarketCard 
              asset="BTC" 
              name="Bitcoin" 
              price={prices.BTC}
              change={2.34}
            />
            <MarketCard 
              asset="ETH" 
              name="Ethereum" 
              price={prices.ETH}
              change={-1.23}
            />
            <MarketCard 
              asset="SOL" 
              name="Solana" 
              price={prices.SOL}
              change={5.67}
            />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border px-4 py-3 mt-8">
        <div className="max-w-lg mx-auto text-center text-sm text-text-muted">
          <span>Degen Terminal</span>
          <span className="mx-2 text-border">•</span>
          <span className="text-accent">Devnet</span>
        </div>
      </footer>

      {/* Delegation Settings Modal */}
      {showDelegationSettings && connected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="w-full max-w-md bg-surface rounded-xl border border-border overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-light/30">
              <div>
                <div className="font-semibold">Fast Trading Settings</div>
                <div className="text-xs text-text-muted">Adjust the USDC amount delegated to the relayer.</div>
              </div>
              <button
                onClick={() => setShowDelegationSettings(false)}
                className="p-2 hover:bg-surface-light rounded-lg transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4 text-text-muted" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className="text-sm text-text-muted">
                Current delegation: <span className="font-mono text-text-primary font-semibold">${(delegatedAmount / 1_000_000).toFixed(2)}</span>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-primary">Delegated amount (USDC)</label>
                <input
                  value={delegationInput}
                  onChange={(e) => setDelegationInput(e.target.value)}
                  inputMode="decimal"
                  placeholder="e.g. 1000"
                  className="w-full px-3 py-2 rounded-lg bg-surface-light border border-border text-text-primary outline-none focus:border-accent"
                />
                <div className="flex flex-wrap gap-2">
                  {[1000, 5000, 10000, 25000].map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setDelegationInput(amt.toString())}
                      className="px-2.5 py-1.5 text-xs font-mono rounded-lg bg-surface-light hover:bg-surface-light/80 border border-border text-text-primary"
                    >
                      ${amt.toLocaleString()}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-text-muted">
                  This lets the relayer execute your MARKET orders without extra approvals. You can change or revoke anytime.
                </p>
              </div>

              <div className="flex items-center justify-between gap-3 pt-2">
                <button
                  onClick={async () => {
                    await revokeDelegation();
                    setShowDelegationSettings(false);
                  }}
                  disabled={isApproving}
                  className="px-3 py-2 rounded-lg border border-border text-text-muted hover:text-text-primary hover:bg-surface-light transition-colors"
                >
                  Revoke
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
                  className="px-3 py-2 rounded-lg bg-accent text-background font-semibold hover:opacity-90 transition-opacity"
                >
                  {isApproving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HoldingRow({ position }: { position: { 
  marketAddress: string;
  market: string;
  yesShares: number;
  noShares: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  status: string;
}}) {
  const outcome = position.yesShares > 0 ? 'YES' : 'NO';
  const shares = position.yesShares > 0 ? position.yesShares : position.noShares;
  const pnl = position.unrealizedPnL;
  const pnlPercent = position.avgEntryPrice > 0 
    ? ((position.currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100 
    : 0;

  // Extract asset from market name (e.g., "BTC-5m" -> "btc")
  const asset = position.market.split('-')[0]?.toLowerCase() || 'btc';

  return (
    <Link 
      href={`/market/${asset}`}
      className="flex items-center justify-between p-3 bg-surface-light rounded-lg hover:bg-surface-light/80 transition-colors"
    >
      <div className="flex items-center gap-3">
        <span className={cn(
          'px-2 py-1 rounded text-xs font-bold',
          outcome === 'YES' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
        )}>
          {outcome}
        </span>
        <div>
          <div className="font-mono text-sm">{position.market}</div>
          <div className="text-xs text-text-muted">
            {shares} shares @ ${position.avgEntryPrice.toFixed(2)}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className={cn(
          'font-mono text-sm font-medium',
          pnl >= 0 ? 'text-long' : 'text-short'
        )}>
          {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
        </div>
        <div className={cn(
          'text-xs',
          pnl >= 0 ? 'text-long/70' : 'text-short/70'
        )}>
          {pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%
        </div>
      </div>
    </Link>
  );
}

function MarketCard({ asset, name, price, change }: { 
  asset: string; 
  name: string; 
  price?: number;
  change: number;
}) {
  const isPositive = change >= 0;
  
  // Format price without locale to avoid hydration issues
  const formatPrice = (p: number | undefined) => {
    if (p === undefined) return '--';
    return p.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  return (
    <Link 
      href={`/market/${asset.toLowerCase()}`}
      className="flex items-center justify-between p-4 bg-surface rounded-xl border border-border hover:border-accent/50 transition-all group"
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-surface-light flex items-center justify-center font-bold text-accent">
          {asset.charAt(0)}
        </div>
        <div>
          <div className="font-semibold">{asset}</div>
          <div className="text-sm text-text-muted">{name}</div>
        </div>
      </div>
      
      <div className="flex items-center gap-3">
        <div className="text-right">
          <div className="font-mono font-medium" suppressHydrationWarning>
            ${formatPrice(price)}
          </div>
          <div className={cn(
            'flex items-center justify-end gap-1 text-xs font-medium',
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
        <ChevronRight className="w-5 h-5 text-text-muted group-hover:text-accent transition-colors" />
      </div>
    </Link>
  );
}
