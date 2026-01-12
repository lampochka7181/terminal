'use client';

import { useEffect, useRef, useState } from 'react';
import { WalletButton } from '@/components/WalletButton';
import { useWallet } from '@solana/wallet-adapter-react';
import { usePriceStore } from '@/stores/priceStore';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown, Activity, Wallet, User, Zap, Settings, X, RefreshCw, ChevronDown, Clock } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useBalance } from '@/hooks/useUser';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useDelegation } from '@/hooks/useDelegation';
import { useSessionKey, SESSION_DURATIONS } from '@/hooks/useSessionKey';

export function Header() {
  const { connected, publicKey } = useWallet();
  const { prices } = usePriceStore();
  const pathname = usePathname();
  const { balance } = useBalance();
  const { isAuthenticated, isAuthenticating, signIn, signOut } = useAuth();
  const authedWalletAddress = useAuthStore((s) => s.walletAddress);
  const { oneClickEnabled, oneClickAmount, setOneClickAmount } = useSettingsStore();
  const { isApproved: isDelegationApproved, delegatedAmount, approve: approveDelegation, revoke: revokeDelegation, isApproving } = useDelegation();
  const { isActive: isSessionActive, isCreating: isCreatingSession, createSession, revokeSession, getTimeRemaining, expiresAt } = useSessionKey();
  
  const [showDelegationDropdown, setShowDelegationDropdown] = useState(false);
  const [delegationInput, setDelegationInput] = useState('');
  const delegationDropdownRef = useRef<HTMLDivElement>(null);
  
  const [showSessionDropdown, setShowSessionDropdown] = useState(false);
  const sessionDropdownRef = useRef<HTMLDivElement>(null);
  
  const [showOneClickDropdown, setShowOneClickDropdown] = useState(false);
  const [oneClickInput, setOneClickInput] = useState('');
  const oneClickDropdownRef = useRef<HTMLDivElement>(null);

  const lastAttemptRef = useRef<{ wallet: string | null; at: number }>({ wallet: null, at: 0 });
  
  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (delegationDropdownRef.current && !delegationDropdownRef.current.contains(event.target as Node)) {
        setShowDelegationDropdown(false);
      }
      if (oneClickDropdownRef.current && !oneClickDropdownRef.current.contains(event.target as Node)) {
        setShowOneClickDropdown(false);
      }
      if (sessionDropdownRef.current && !sessionDropdownRef.current.contains(event.target as Node)) {
        setShowSessionDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  
  // Format session time remaining
  const formatTimeRemaining = () => {
    const seconds = getTimeRemaining();
    if (seconds <= 0) return 'Expired';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  // Ensure SIWS runs from any page:
  // - When wallet connects and we're not authenticated -> prompt sign message
  // - When wallet changes while authenticated -> sign out and prompt sign-in for the new wallet
  useEffect(() => {
    const wallet = publicKey?.toBase58() ?? null;
    if (!connected || !wallet) return;

    // Throttle repeated attempts (hot reload, reconnect storms)
    const now = Date.now();
    if (lastAttemptRef.current.wallet === wallet && now - lastAttemptRef.current.at < 20_000) {
      return;
    }

    const walletMismatch = Boolean(authedWalletAddress && authedWalletAddress !== wallet);

    // If authenticated for a different wallet, clear session first.
    if (walletMismatch && isAuthenticated && !isAuthenticating) {
      lastAttemptRef.current = { wallet, at: now };
      signOut().catch(() => {});
      // Then prompt sign-in for the new wallet (small delay to let state settle)
      setTimeout(() => {
        signIn().catch(() => {});
      }, 150);
      return;
    }

    // If not authenticated, always prompt sign-in from any page.
    if (!isAuthenticated && !isAuthenticating) {
      lastAttemptRef.current = { wallet, at: now };
      signIn().catch(() => {});
    }
  }, [connected, publicKey, authedWalletAddress, isAuthenticated, isAuthenticating, signIn, signOut]);

  return (
    <header className="sticky top-0 z-50 glass-strong border-b border-border/50">
      <div className="w-full px-1 py-2 flex items-center justify-between relative">
        {/* Logo + Navigation */}
        <div className="flex items-center gap-4 sm:gap-8">
          <Link href="/" className="flex items-center gap-2 group btn-press">
            <div className="relative">
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-accent flex items-center justify-center group-hover:bg-accent-light transition-all group-hover:shadow-glow">
                <Activity className="w-4 h-4 sm:w-5 sm:h-5 text-background" />
              </div>
              <div className="absolute inset-0 bg-accent rounded-lg blur-xl opacity-20 group-hover:opacity-40 transition-opacity" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm sm:text-lg font-display font-bold text-accent leading-none tracking-tight">DEGEN</span>
              <span className="hidden sm:inline text-[10px] text-text-muted font-medium uppercase tracking-widest leading-none">TERMINAL</span>
            </div>
          </Link>

          <nav className="flex items-center gap-1">
            <Link 
              href="/profile" 
              className={cn(
                "px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors btn-press flex items-center gap-1.5",
                (pathname === '/profile' || pathname === '/orders' || pathname === '/portfolio') 
                  ? "bg-accent/10 text-accent" 
                  : "text-text-muted hover:text-text-primary hover:bg-surface-light"
              )}
            >
              <User className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Profile</span>
            </Link>
          </nav>
        </div>

        {/* Price Tickers - Absolutely centered */}
        <div className="hidden md:flex items-center gap-4 absolute left-1/2 -translate-x-1/2">
          <PriceTicker symbol="BTC" price={prices.BTC} />
          <PriceTicker symbol="ETH" price={prices.ETH} />
          <PriceTicker symbol="SOL" price={prices.SOL} />
        </div>

        {/* Right Side: Delegation + Balance + Wallet */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Delegation Status / Enable Button */}
          {connected && (
            <div className="relative" ref={delegationDropdownRef}>
              {isDelegationApproved ? (
                <button
                  onClick={() => {
                    setDelegationInput(((delegatedAmount || 0) / 1_000_000).toFixed(0));
                    setShowDelegationDropdown(!showDelegationDropdown);
                  }}
                  className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 bg-long/10 border border-long/30 rounded-lg text-long text-xs font-bold hover:bg-long/20 transition-colors btn-press"
                  title="Delegation Active - Click to manage"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span className="font-mono">${(delegatedAmount / 1_000_000).toFixed(0)}</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
              ) : (
                <button
                  onClick={() => approveDelegation()}
                  disabled={isApproving}
                  className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-light border border-border/50 rounded-lg text-text-muted text-xs font-bold hover:border-accent/50 hover:text-accent transition-colors btn-press"
                  title="Enable delegation to start trading"
                >
                  {isApproving ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Enabling...</span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-3.5 h-3.5" />
                      <span>Enable Trading</span>
                    </>
                  )}
                </button>
              )}
              
              {/* Delegation Dropdown */}
              {showDelegationDropdown && isDelegationApproved && (
                <div className="absolute right-0 top-full mt-2 w-72 bg-surface border border-border rounded-xl shadow-xl z-50 overflow-hidden animate-fade-in">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-light/30">
                    <div className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-long" />
                      <span className="font-bold text-sm">Delegated Balance</span>
                    </div>
                    <button
                      onClick={() => setShowDelegationDropdown(false)}
                      className="p-1 hover:bg-surface-light rounded transition-colors"
                    >
                      <X className="w-4 h-4 text-text-muted" />
                    </button>
                  </div>
                  
                  <div className="p-4 space-y-4">
                    <div className="flex items-center justify-between p-3 bg-surface-light/50 rounded-lg">
                      <span className="text-xs text-text-muted">Currently delegated</span>
                      <span className="font-mono text-lg font-bold text-accent">${(delegatedAmount / 1_000_000).toFixed(2)}</span>
                    </div>
                    
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-text-muted">Adjust amount (USDC)</label>
                      <input
                        value={delegationInput}
                        onChange={(e) => setDelegationInput(e.target.value)}
                        inputMode="decimal"
                        placeholder="e.g. 10000"
                        className="w-full px-3 py-2 rounded-lg bg-surface-light border border-border text-text-primary font-mono text-sm outline-none focus:border-accent transition-colors"
                      />
                      <div className="grid grid-cols-4 gap-1">
                        {[1000, 5000, 10000, 25000].map((amt) => (
                          <button
                            key={amt}
                            onClick={() => setDelegationInput(amt.toString())}
                            className="py-1.5 text-[10px] font-mono font-bold rounded bg-surface-light hover:bg-border border border-border/50 text-text-muted hover:text-text-primary transition-all"
                          >
                            ${(amt / 1000).toFixed(0)}k
                          </button>
                        ))}
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={async () => {
                          await revokeDelegation();
                          setShowDelegationDropdown(false);
                        }}
                        disabled={isApproving}
                        className="flex-1 px-3 py-2 rounded-lg border border-short/30 text-short text-xs font-bold hover:bg-short/10 transition-colors btn-press"
                      >
                        Revoke All
                      </button>
                      <button
                        onClick={async () => {
                          const parsed = Number(delegationInput);
                          if (!Number.isFinite(parsed) || parsed < 0) return;
                          const micro = Math.floor(parsed * 1_000_000);
                          await approveDelegation(micro);
                          setShowDelegationDropdown(false);
                        }}
                        disabled={isApproving}
                        className="flex-1 px-3 py-2 rounded-lg bg-accent text-background text-xs font-bold hover:bg-accent-dim transition-all btn-press flex items-center justify-center gap-1.5"
                      >
                        {isApproving ? (
                          <>
                            <RefreshCw className="w-3 h-3 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          'Update'
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          
          {/* Session Trading Button */}
          {connected && isDelegationApproved && (
            <div className="relative" ref={sessionDropdownRef}>
              {isSessionActive ? (
                <button
                  onClick={() => setShowSessionDropdown(!showSessionDropdown)}
                  className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 bg-accent/10 border border-accent/30 rounded-lg text-accent text-xs font-bold hover:bg-accent/20 transition-colors btn-press"
                  title="Session Active - No popups for orders"
                >
                  <Activity className="w-3.5 h-3.5" />
                  <span>{formatTimeRemaining()}</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
              ) : (
                <button
                  onClick={() => setShowSessionDropdown(!showSessionDropdown)}
                  disabled={isCreatingSession}
                  className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-light border border-border/50 rounded-lg text-text-muted text-xs font-bold hover:border-accent/50 hover:text-accent transition-colors btn-press"
                  title="Start session for instant trading"
                >
                  {isCreatingSession ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Starting...</span>
                    </>
                  ) : (
                    <>
                      <Activity className="w-3.5 h-3.5" />
                      <span>Session</span>
                    </>
                  )}
                </button>
              )}
              
              {/* Session Dropdown */}
              {showSessionDropdown && (
                <div className="absolute right-0 top-full mt-2 w-72 bg-surface border border-border rounded-xl shadow-xl z-50 overflow-hidden animate-fade-in">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-light/30">
                    <div className="flex items-center gap-2">
                      <Activity className="w-4 h-4 text-accent" />
                      <span className="font-bold text-sm">Trading Session</span>
                    </div>
                    <button
                      onClick={() => setShowSessionDropdown(false)}
                      className="p-1 hover:bg-surface-light rounded transition-colors"
                    >
                      <X className="w-4 h-4 text-text-muted" />
                    </button>
                  </div>
                  
                  <div className="p-4 space-y-4">
                    {isSessionActive ? (
                      <>
                        <div className="flex items-center justify-between p-3 bg-accent/10 rounded-lg border border-accent/20">
                          <span className="text-xs text-text-muted">Session active</span>
                          <span className="font-mono text-sm font-bold text-accent">{formatTimeRemaining()} left</span>
                        </div>
                        <p className="text-xs text-text-muted">
                          Orders are signed instantly without wallet popups.
                        </p>
                        <button
                          onClick={async () => {
                            await revokeSession();
                            setShowSessionDropdown(false);
                          }}
                          className="w-full px-3 py-2 rounded-lg border border-short/30 text-short text-xs font-bold hover:bg-short/10 transition-colors btn-press"
                        >
                          End Session
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="text-xs text-text-muted">
                          Start a trading session to sign orders instantly without wallet popups. You&apos;ll sign once to authorize, then trade freely.
                        </p>
                        <div className="space-y-2">
                          <button
                            onClick={async () => {
                              await createSession(SESSION_DURATIONS.SHORT);
                              setShowSessionDropdown(false);
                            }}
                            disabled={isCreatingSession}
                            className="w-full px-3 py-2 rounded-lg bg-surface-light border border-border text-text-primary text-xs font-bold hover:border-accent/50 transition-colors btn-press flex items-center justify-center gap-2"
                          >
                            <Clock className="w-3.5 h-3.5" />
                            1 Hour Session
                          </button>
                          <button
                            onClick={async () => {
                              await createSession(SESSION_DURATIONS.MEDIUM);
                              setShowSessionDropdown(false);
                            }}
                            disabled={isCreatingSession}
                            className="w-full px-3 py-2 rounded-lg bg-accent text-background text-xs font-bold hover:bg-accent-dim transition-all btn-press flex items-center justify-center gap-2"
                          >
                            <Clock className="w-3.5 h-3.5" />
                            4 Hour Session (Recommended)
                          </button>
                          <button
                            onClick={async () => {
                              await createSession(SESSION_DURATIONS.LONG);
                              setShowSessionDropdown(false);
                            }}
                            disabled={isCreatingSession}
                            className="w-full px-3 py-2 rounded-lg bg-surface-light border border-border text-text-primary text-xs font-bold hover:border-accent/50 transition-colors btn-press flex items-center justify-center gap-2"
                          >
                            <Clock className="w-3.5 h-3.5" />
                            24 Hour Session
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          
          {/* One-Click Mode Indicator */}
          {connected && oneClickEnabled && (
            <div className="relative" ref={oneClickDropdownRef}>
              <button
                onClick={() => {
                  setOneClickInput(oneClickAmount.toString());
                  setShowOneClickDropdown(!showOneClickDropdown);
                }}
                className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 bg-warning/10 border border-warning/30 rounded-lg text-warning text-xs font-bold hover:bg-warning/20 transition-colors btn-press"
                title="One-Click Trading - Click to adjust amount"
              >
                <Zap className="w-3.5 h-3.5" />
                <span className="font-mono">${oneClickAmount}</span>
                <ChevronDown className="w-3 h-3" />
              </button>
              
              {/* One-Click Amount Dropdown */}
              {showOneClickDropdown && (
                <div className="absolute right-0 top-full mt-2 w-64 bg-surface border border-border rounded-xl shadow-xl z-50 overflow-hidden animate-fade-in">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-light/30">
                    <div className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-warning" />
                      <span className="font-bold text-sm">Quick Trade Amount</span>
                    </div>
                    <button
                      onClick={() => setShowOneClickDropdown(false)}
                      className="p-1 hover:bg-surface-light rounded transition-colors"
                    >
                      <X className="w-4 h-4 text-text-muted" />
                    </button>
                  </div>
                  
                  <div className="p-4 space-y-4">
                    <div className="flex items-center justify-between p-3 bg-surface-light/50 rounded-lg">
                      <span className="text-xs text-text-muted">Current amount</span>
                      <span className="font-mono text-lg font-bold text-warning">${oneClickAmount}</span>
                    </div>
                    
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-text-muted">Adjust amount (USDC)</label>
                      <input
                        value={oneClickInput}
                        onChange={(e) => setOneClickInput(e.target.value)}
                        inputMode="decimal"
                        placeholder="e.g. 100"
                        className="w-full px-3 py-2 rounded-lg bg-surface-light border border-border text-text-primary font-mono text-sm outline-none focus:border-warning transition-colors"
                      />
                      <div className="grid grid-cols-4 gap-1">
                        {[25, 50, 100, 250].map((amt) => (
                          <button
                            key={amt}
                            onClick={() => setOneClickInput(amt.toString())}
                            className={cn(
                              "py-1.5 text-[10px] font-mono font-bold rounded border transition-all",
                              oneClickInput === amt.toString()
                                ? "bg-warning/20 border-warning/50 text-warning"
                                : "bg-surface-light border-border/50 text-text-muted hover:text-text-primary hover:bg-border"
                            )}
                          >
                            ${amt}
                          </button>
                        ))}
                      </div>
                    </div>
                    
                    <button
                      onClick={() => {
                        const parsed = Number(oneClickInput);
                        if (Number.isFinite(parsed) && parsed > 0) {
                          setOneClickAmount(parsed);
                        }
                        setShowOneClickDropdown(false);
                      }}
                      className="w-full px-3 py-2 rounded-lg bg-warning text-background text-xs font-bold hover:bg-warning/80 transition-all btn-press"
                    >
                      Update Amount
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          
          {connected && balance && typeof balance.total === 'number' && (
            <div className="hidden sm:flex items-center gap-2 text-sm">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-light rounded-lg border border-border/50">
                <Wallet className="w-3.5 h-3.5 text-text-muted" />
                <span className="text-accent font-mono font-medium">
                  ${balance.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          )}
          <WalletButton className="!bg-accent !text-background hover:!bg-accent-dim !rounded-lg !font-semibold !h-10 !px-4 btn-press" />
        </div>
      </div>
    </header>
  );
}

function PriceTicker({ symbol, price }: { symbol: string; price?: number }) {
  // Mock 24h change
  const change24h = symbol === 'BTC' ? 2.34 : symbol === 'ETH' ? -1.23 : 5.67;
  const isPositive = change24h >= 0;

  // Format price without locale to avoid hydration issues
  const formatPrice = (p: number) => {
    return p.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  // Market URL for this asset
  const marketUrl = `/${symbol.toLowerCase()}`;

  // Color for each asset
  const symbolColors: Record<string, string> = {
    BTC: 'text-orange',
    ETH: 'text-electric-blue',
    SOL: 'text-violet',
  };

  return (
    <Link 
      href={marketUrl}
      className="flex items-center gap-3 px-3 py-2 rounded-xl bg-surface/60 border border-border/50 hover:border-accent/30 hover:bg-surface-light/50 transition-all cursor-pointer group btn-press"
    >
      <div className="flex flex-col">
        <span className={cn(
          "text-xs font-bold uppercase tracking-wide transition-colors",
          symbolColors[symbol] || 'text-text-muted',
          "group-hover:text-accent"
        )}>{symbol}</span>
        <span className="font-mono text-text-primary font-bold text-sm group-hover:text-accent transition-colors" suppressHydrationWarning>
          ${price ? formatPrice(price) : '---'}
        </span>
      </div>
      <div className={cn(
        'flex items-center gap-0.5 text-xs font-bold px-1.5 py-0.5 rounded',
        isPositive ? 'text-long bg-long/10' : 'text-short bg-short/10'
      )}>
        {isPositive ? (
          <TrendingUp className="w-3 h-3" />
        ) : (
          <TrendingDown className="w-3 h-3" />
        )}
        <span>{isPositive ? '+' : ''}{change24h.toFixed(2)}%</span>
      </div>
    </Link>
  );
}
