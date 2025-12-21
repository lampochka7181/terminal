'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { 
  Clock, 
  TrendingUp, 
  TrendingDown, 
  X, 
  RefreshCw, 
  ChevronRight,
  ArrowRightLeft,
  Calendar,
  DollarSign
} from 'lucide-react';
import { getUserPositions, getUserOrders, type Position, type Order } from '@/lib/api';
import { useUserStore } from '@/stores/userStore';
import { useAuthStore } from '@/stores/authStore';
import { useOrder } from '@/hooks/useOrder';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { useWallet } from '@solana/wallet-adapter-react';

type Tab = 'positions' | 'orders';

export default function OrdersPage() {
  const [activeTab, setActiveTab] = useState<Tab>('positions');
  const { isAuthenticated, signIn, isAuthenticating } = useAuthStore();
  const { cancelOrder, isCancelling } = useOrder();
  const { publicKey, signMessage, connected } = useWallet();

  // Track if we've already attempted sign-in to prevent infinite loops
  const signInAttemptedRef = useRef(false);
  
  // Reset the flag when wallet disconnects
  useEffect(() => {
    if (!connected) {
      signInAttemptedRef.current = false;
    }
  }, [connected]);

  // Step 1: Handle Auto-SignIn (similar to Home page)
  useEffect(() => {
    if (connected && !isAuthenticated && !isAuthenticating && !signInAttemptedRef.current && publicKey && signMessage) {
      signInAttemptedRef.current = true;
      signIn(publicKey.toBase58(), signMessage).catch((err) => {
        console.error('[OrdersPage] Auto sign-in failed:', err);
      });
    }
  }, [connected, isAuthenticated, isAuthenticating, publicKey, signMessage, signIn]);

  // Fetch positions from API
  const { data: positionsData, isLoading: positionsLoading, refetch: refetchPositions } = useQuery({
    queryKey: ['user-positions', 'all'],
    queryFn: () => getUserPositions({ status: 'open' }),
    enabled: isAuthenticated,
    staleTime: 5000,
  });

  // Fetch orders from API
  const { data: ordersData, isLoading: ordersLoading, refetch: refetchOrders } = useQuery({
    queryKey: ['user-orders', 'all'],
    queryFn: () => getUserOrders({ status: 'open' }),
    enabled: isAuthenticated,
    staleTime: 5000,
  });

  const positions = positionsData || [];
  const orders = ordersData?.orders || [];
  const isLoading = positionsLoading || ordersLoading;

  // Debug logging
  useEffect(() => {
    if (isAuthenticated) {
      console.log('[OrdersPage] Authenticated, data:', { 
        positionsCount: positions.length, 
        ordersCount: orders.length,
        isLoading 
      });
    }
  }, [isAuthenticated, positions.length, orders.length, isLoading]);

  // Step 2: Ensure data is fetched when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      refetchPositions();
      refetchOrders();
    }
  }, [isAuthenticated, refetchPositions, refetchOrders]);

  const handleCancelOrder = async (orderId: string) => {
    if (confirm('Are you sure you want to cancel this order?')) {
      const success = await cancelOrder(orderId);
      if (success) {
        refetchOrders();
      }
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <Header />
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="bg-surface rounded-2xl border border-border p-8 max-w-md w-full text-center space-y-4">
            <div className="w-16 h-16 bg-surface-light rounded-full flex items-center justify-center mx-auto">
              <Clock className="w-8 h-8 text-text-muted" />
            </div>
            <h1 className="text-2xl font-bold">Your Orders</h1>
            <p className="text-text-muted">Connect your wallet to see your positions and active orders.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Orders & Positions</h1>
          <button 
            onClick={() => { refetchPositions(); refetchOrders(); }}
            className="p-2 hover:bg-surface-light rounded-lg transition-colors"
            disabled={isLoading}
          >
            <RefreshCw className={cn("w-5 h-5 text-text-muted", isLoading && "animate-spin")} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 p-1 bg-surface rounded-xl border border-border w-fit">
          <button
            onClick={() => setActiveTab('positions')}
            className={cn(
              "px-6 py-2 rounded-lg font-medium transition-all flex items-center gap-2",
              activeTab === 'positions' ? "bg-accent text-background shadow-lg" : "text-text-muted hover:text-text-primary hover:bg-surface-light"
            )}
          >
            Positions
            {positions.length > 0 && (
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-bold",
                activeTab === 'positions' ? "bg-background/20 text-background" : "bg-accent/20 text-accent"
              )}>
                {positions.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('orders')}
            className={cn(
              "px-6 py-2 rounded-lg font-medium transition-all flex items-center gap-2",
              activeTab === 'orders' ? "bg-accent text-background shadow-lg" : "text-text-muted hover:text-text-primary hover:bg-surface-light"
            )}
          >
            Open Orders
            {orders.length > 0 && (
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-bold",
                activeTab === 'orders' ? "bg-background/20 text-background" : "bg-accent/20 text-accent"
              )}>
                {orders.length}
              </span>
            )}
          </button>
        </div>

        {/* Content */}
        <div className="min-h-[400px]">
          {activeTab === 'positions' ? (
            <PositionsView positions={positions} isLoading={positionsLoading} />
          ) : (
            <OrdersView 
              orders={orders} 
              isLoading={ordersLoading} 
              onCancel={handleCancelOrder}
              isCancelling={isCancelling}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PositionsView({ positions, isLoading }: { positions: Position[], isLoading: boolean }) {
  if (isLoading && positions.length === 0) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-48 bg-surface rounded-2xl border border-border animate-pulse" />
        ))}
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="bg-surface rounded-2xl border border-border p-12 text-center space-y-4">
        <div className="w-16 h-16 bg-surface-light rounded-full flex items-center justify-center mx-auto">
          <TrendingUp className="w-8 h-8 text-text-muted" />
        </div>
        <h2 className="text-xl font-bold">No Open Positions</h2>
        <p className="text-text-muted max-w-sm mx-auto">You don't have any active trades. Head over to the markets to start trading.</p>
        <Link href="/" className="inline-block bg-accent text-background px-6 py-2 rounded-xl font-bold hover:bg-accent-dim transition-colors">
          Browse Markets
        </Link>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {positions.map((pos) => (
        <PositionCard key={pos.marketAddress} position={pos} />
      ))}
    </div>
  );
}

function PositionCard({ position }: { position: Position }) {
  const outcome = position.yesShares > 0 ? 'YES' : 'NO';
  const shares = position.yesShares > 0 ? position.yesShares : position.noShares;
  const pnlPercent = position.avgEntryPrice > 0 
    ? ((position.currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100 
    : 0;

  return (
    <div className="bg-surface rounded-2xl border border-border overflow-hidden hover:border-accent/30 transition-all flex flex-col">
      <div className="p-4 border-b border-border bg-surface-light/30 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center font-bold text-accent text-xs">
            {position.asset?.charAt(0) || 'M'}
          </div>
          <div>
            <div className="font-bold text-sm">{position.market}</div>
            <div className="text-[10px] text-text-muted font-mono">{position.marketAddress.slice(0, 8)}...</div>
          </div>
        </div>
        <div className={cn(
          "px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider",
          outcome === 'YES' ? "bg-long/20 text-long" : "bg-short/20 text-short"
        )}>
          {outcome}
        </div>
      </div>

      <div className="p-4 space-y-4 flex-1">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-text-muted mb-1">Size</div>
            <div className="font-mono font-medium">{shares.toLocaleString()} contracts</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-text-muted mb-1">Avg Price</div>
            <div className="font-mono font-medium">${position.avgEntryPrice.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">PnL</div>
            <div className={cn(
              "font-mono font-bold flex items-center gap-1",
              position.unrealizedPnL >= 0 ? "text-long" : "text-short"
            )}>
              {position.unrealizedPnL >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {position.unrealizedPnL >= 0 ? '+' : ''}${Math.abs(position.unrealizedPnL).toFixed(2)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-text-muted mb-1">ROI</div>
            <div className={cn(
              "font-mono font-medium",
              pnlPercent >= 0 ? "text-long" : "text-short"
            )}>
              {pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%
            </div>
          </div>
        </div>

        <div className="pt-3 border-t border-border flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <Clock className="w-3.5 h-3.5" />
            <span className="font-mono"><ExpiryCountdown expiry={position.expiryAt} /></span>
          </div>
          <Link 
            href={`/market/${position.asset?.toLowerCase() || 'btc'}`}
            className="text-xs text-accent hover:underline flex items-center gap-1 font-bold"
          >
            Trade <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
      </div>
    </div>
  );
}

function OrdersView({ 
  orders, 
  isLoading, 
  onCancel,
  isCancelling 
}: { 
  orders: Order[], 
  isLoading: boolean,
  onCancel: (id: string) => void,
  isCancelling: boolean
}) {
  if (isLoading && orders.length === 0) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 bg-surface rounded-2xl border border-border animate-pulse" />
        ))}
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="bg-surface rounded-2xl border border-border p-12 text-center space-y-4">
        <div className="w-16 h-16 bg-surface-light rounded-full flex items-center justify-center mx-auto">
          <Clock className="w-8 h-8 text-text-muted" />
        </div>
        <h2 className="text-xl font-bold">No Open Orders</h2>
        <p className="text-text-muted max-w-sm mx-auto">You don't have any active orders in the orderbook.</p>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-2xl border border-border overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-border bg-surface-light/30">
              <th className="p-4 text-xs font-bold text-text-muted uppercase tracking-wider">Market</th>
              <th className="p-4 text-xs font-bold text-text-muted uppercase tracking-wider">Side / Outcome</th>
              <th className="p-4 text-xs font-bold text-text-muted uppercase tracking-wider text-right">Price</th>
              <th className="p-4 text-xs font-bold text-text-muted uppercase tracking-wider text-right">Size</th>
              <th className="p-4 text-xs font-bold text-text-muted uppercase tracking-wider text-right">Filled</th>
              <th className="p-4 text-xs font-bold text-text-muted uppercase tracking-wider">Expires In</th>
              <th className="p-4 text-xs font-bold text-text-muted uppercase tracking-wider text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {orders.map((order) => (
              <tr key={order.id} className="hover:bg-surface-light/20 transition-colors">
                <td className="p-4">
                  <div className="font-bold text-sm">{order.market}</div>
                  <div className="text-[10px] text-text-muted font-mono">{order.marketAddress.slice(0, 8)}...</div>
                </td>
                <td className="p-4">
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] font-bold uppercase",
                      order.side === 'bid' ? "bg-long/10 text-long" : "bg-short/10 text-short"
                    )}>
                      {order.side === 'bid' ? 'BUY' : 'SELL'}
                    </span>
                    <span className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] font-bold uppercase",
                      order.outcome === 'yes' ? "bg-long/20 text-long" : "bg-short/20 text-short"
                    )}>
                      {order.outcome}
                    </span>
                  </div>
                </td>
                <td className="p-4 text-right font-mono text-sm font-medium">
                  ${order.price.toFixed(2)}
                </td>
                <td className="p-4 text-right font-mono text-sm">
                  {order.size.toLocaleString()}
                </td>
                <td className="p-4 text-right">
                  <div className="font-mono text-sm">{order.filledSize.toLocaleString()}</div>
                  <div className="w-20 h-1.5 bg-surface-light rounded-full overflow-hidden ml-auto mt-1">
                    <div 
                      className="h-full bg-accent" 
                      style={{ width: `${(order.filledSize / order.size) * 100}%` }}
                    />
                  </div>
                </td>
                <td className="p-4 text-sm text-text-muted font-mono">
                  <ExpiryCountdown expiry={order.expiryAt} />
                </td>
                <td className="p-4 text-right">
                  <button
                    onClick={() => onCancel(order.id)}
                    disabled={isCancelling}
                    className="p-2 text-text-muted hover:text-short hover:bg-short/10 rounded-lg transition-all"
                    title="Cancel Order"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExpiryCountdown({ expiry }: { expiry: number }) {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
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
      } else {
        setTimeLeft(`${mins}m ${secs}s`);
      }
    };

    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [expiry]);

  return <span>{timeLeft}</span>;
}

