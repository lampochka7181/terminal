'use client';

import { WalletButton } from '@/components/WalletButton';
import { useWallet } from '@solana/wallet-adapter-react';
import { usePriceStore } from '@/stores/priceStore';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown, Activity, Clock, Wallet } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useBalance } from '@/hooks/useUser';

export function Header() {
  const { connected, publicKey } = useWallet();
  const { prices } = usePriceStore();
  const pathname = usePathname();
  const { balance } = useBalance();

  return (
    <header className="border-b border-border bg-surface px-4 py-3">
      <div className="flex items-center justify-between">
        {/* Logo + Navigation */}
        <div className="flex items-center gap-4 sm:gap-8">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-accent flex items-center justify-center group-hover:bg-accent-dim transition-colors">
              <Activity className="w-4 h-4 sm:w-5 sm:h-5 text-background" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm sm:text-lg font-bold terminal-text leading-none">DEGEN</span>
              <span className="hidden sm:inline text-[10px] text-text-muted leading-none">TERMINAL</span>
            </div>
          </Link>

          <nav className="flex items-center gap-1">
            <Link 
              href="/" 
              className={cn(
                "px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors",
                pathname === '/' ? "bg-accent/10 text-accent" : "text-text-muted hover:text-text-primary hover:bg-surface-light"
              )}
            >
              Markets
            </Link>
            <Link 
              href="/orders" 
              className={cn(
                "px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors flex items-center gap-2",
                pathname === '/orders' ? "bg-accent/10 text-accent" : "text-text-muted hover:text-text-primary hover:bg-surface-light"
              )}
            >
              Orders
            </Link>
          </nav>
        </div>

        {/* Price Tickers */}
        <div className="hidden md:flex items-center gap-6">
          <PriceTicker symbol="BTC" price={prices.BTC} />
          <PriceTicker symbol="ETH" price={prices.ETH} />
          <PriceTicker symbol="SOL" price={prices.SOL} />
        </div>

        {/* Right Side: Balance + Wallet */}
        <div className="flex items-center gap-4">
          {connected && balance && typeof balance.total === 'number' && (
            <div className="hidden sm:flex items-center gap-4 text-sm">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-light rounded-lg border border-border/50">
                <Wallet className="w-3.5 h-3.5 text-text-muted" />
                <span className="text-accent font-mono font-medium">
                  ${balance.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          )}
          <WalletButton className="!bg-accent !text-background hover:!bg-accent-dim !rounded-lg !font-semibold !h-10 !px-4" />
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

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 bg-surface-light rounded-lg">
      <div className="flex flex-col">
        <span className="text-text-muted text-xs">{symbol}/USD</span>
        <span className="font-mono text-text-primary font-medium" suppressHydrationWarning>
          ${price ? formatPrice(price) : '---'}
        </span>
      </div>
      <div className={cn(
        'flex items-center gap-1 text-xs font-medium',
        isPositive ? 'text-long' : 'text-short'
      )}>
        {isPositive ? (
          <TrendingUp className="w-3 h-3" />
        ) : (
          <TrendingDown className="w-3 h-3" />
        )}
        <span>{isPositive ? '+' : ''}{change24h.toFixed(2)}%</span>
      </div>
    </div>
  );
}
