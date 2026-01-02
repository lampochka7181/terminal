'use client';

import { useEffect, useRef } from 'react';
import { WalletButton } from '@/components/WalletButton';
import { useWallet } from '@solana/wallet-adapter-react';
import { usePriceStore } from '@/stores/priceStore';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown, Activity, Wallet, User, Zap } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useBalance } from '@/hooks/useUser';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';

export function Header() {
  const { connected, publicKey } = useWallet();
  const { prices } = usePriceStore();
  const pathname = usePathname();
  const { balance } = useBalance();
  const { isAuthenticated, isAuthenticating, signIn, signOut } = useAuth();
  const authedWalletAddress = useAuthStore((s) => s.walletAddress);
  const { oneClickEnabled, oneClickAmount } = useSettingsStore();

  const lastAttemptRef = useRef<{ wallet: string | null; at: number }>({ wallet: null, at: 0 });

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
      <div className="max-w-[1800px] mx-auto px-4 py-3 flex items-center justify-between relative">
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
              href="/" 
              className={cn(
                "px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors btn-press",
                pathname === '/' ? "bg-accent/10 text-accent" : "text-text-muted hover:text-text-primary hover:bg-surface-light"
              )}
            >
              Markets
            </Link>
            <Link 
              href="/orders" 
              className={cn(
                "px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors btn-press",
                pathname === '/orders' ? "bg-accent/10 text-accent" : "text-text-muted hover:text-text-primary hover:bg-surface-light"
              )}
            >
              Orders
            </Link>
            <Link 
              href="/portfolio" 
              className={cn(
                "px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors btn-press hidden sm:block",
                pathname === '/portfolio' ? "bg-accent/10 text-accent" : "text-text-muted hover:text-text-primary hover:bg-surface-light"
              )}
            >
              Analytics
            </Link>
            <Link 
              href="/profile" 
              className={cn(
                "px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors btn-press flex items-center gap-1.5",
                pathname === '/profile' ? "bg-accent/10 text-accent" : "text-text-muted hover:text-text-primary hover:bg-surface-light"
              )}
            >
              <User className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Settings</span>
            </Link>
          </nav>
        </div>

        {/* Price Tickers - Absolutely centered */}
        <div className="hidden md:flex items-center gap-4 absolute left-1/2 -translate-x-1/2">
          <PriceTicker symbol="BTC" price={prices.BTC} />
          <PriceTicker symbol="ETH" price={prices.ETH} />
          <PriceTicker symbol="SOL" price={prices.SOL} />
        </div>

        {/* Right Side: One-Click Indicator + Balance + Wallet */}
        <div className="flex items-center gap-2 sm:gap-4">
          {/* One-Click Mode Indicator */}
          {connected && oneClickEnabled && (
            <Link
              href="/profile"
              className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 bg-warning/10 border border-warning/30 rounded-lg text-warning text-xs font-bold hover:bg-warning/20 transition-colors btn-press"
              title="One-Click Trading Active"
            >
              <Zap className="w-3.5 h-3.5" />
              <span className="font-mono">${oneClickAmount}</span>
            </Link>
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
  const marketUrl = `/market/${symbol.toLowerCase()}`;

  // Color for each asset
  const symbolColors: Record<string, string> = {
    BTC: 'text-orange',
    ETH: 'text-violet',
    SOL: 'text-electric-blue',
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
