'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useUser } from '@/hooks/useUser';
import { useLiquidationNotifications } from '@/hooks/useLiquidationNotifications';
import { cn } from '@/lib/utils';
import { Clock, TrendingUp, TrendingDown, X, RefreshCw, ArrowRightLeft, ExternalLink, History, DollarSign, Percent, Target, Shield, AlertTriangle } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useOrder } from '@/hooks/useOrder';
import { useSettingsStore } from '@/stores/settingsStore';
import { AddMarginModal } from './AddMarginModal';
import type { Position as ApiPosition, Order as ApiOrder, Settlement, UserTransaction } from '@/lib/api';
import { useUserStore, type PendingOrderInfo } from '@/stores/userStore';

type Tab = 'active' | 'history';

interface UnifiedTrade {
  id: string;
  orderId?: string;    // Original order ID for cancel operations
  type: 'position' | 'order' | 'combined'; // 'combined' = order with partial/full fill
  market: string;
  marketAddress: string;
  asset: string;
  expiryAt: number;
  outcome: 'YES' | 'NO';
  side: 'BID' | 'ASK';
  size: number;         // Total order size
  filled: number;       // How much has been filled
  remaining: number;    // How much is still pending (size - filled)
  price: number;        // Avg entry price for filled portion, limit price for unfilled
  currentPrice: number; // Current market price
  pnl?: number;         // P&L on filled portion
  pnlPercent?: number;
  status: string;       // OPEN, PARTIAL, FILLED
  createdAt: number;
  // Cost breakdown (in USDC)
  spentAmount?: number;     // $ spent on filled portion
  pendingAmount?: number;   // $ pending for remaining
  totalOrderValue?: number; // $ total original order value
  // Leverage fields
  leverage?: number;
  liquidationPrice?: number;
  marginDeposited?: number;
  loanAmount?: number;
  marginAccountId?: string; // For add margin modal
}

interface PositionsProps {
  onSell?: (marketAddress: string, outcome: 'YES' | 'NO', shares: number, avgEntry: number, price: number, timeframe: any, expiry: number) => void;
  // Real-time prices for the currently viewed market (from orderbook)
  currentMarketAddress?: string;
  currentYesPrice?: number;
  currentNoPrice?: number;
  compact?: boolean;
}

export function Positions({ onSell, currentMarketAddress, currentYesPrice, currentNoPrice, compact = false }: PositionsProps) {
  const [activeTab, setActiveTab] = useState<Tab>('active');
  const [, setTick] = useState(0); // Force re-render for expiry filtering
  const { isAuthenticated } = useAuthStore();
  const { cancelOrder, isCancelling } = useOrder();
  const { showPnLPercent } = useSettingsStore();
  
  // Add Margin Modal state
  const [addMarginTrade, setAddMarginTrade] = useState<UnifiedTrade | null>(null);
  
  // Liquidation notification state
  const [liquidationAlert, setLiquidationAlert] = useState<{
    side: 'YES' | 'NO';
    shares: number;
    returnedToUser: number;
  } | null>(null);
  
  // Handle liquidation notifications via WebSocket
  const handleLiquidation = useCallback((notification: {
    side: 'YES' | 'NO';
    shares: number;
    returnedToUser: number;
  }) => {
    setLiquidationAlert(notification);
    // Auto-dismiss after 8 seconds
    setTimeout(() => setLiquidationAlert(null), 8000);
  }, []);
  
  useLiquidationNotifications({ onLiquidation: handleLiquidation });
  
  const { 
    positions: apiPositions, 
    orders: apiOrders, 
    transactions,
    positionsLoading,
    ordersLoading,
    transactionsLoading,
    refetchAll
  } = useUser();
  
  // Get pending order from store (shown during "Placing..." phase)
  const pendingOrder = useUserStore((state) => state.pendingOrder);
  
  // TIMING: Track when positions update
  const prevPositionCount = useRef(apiPositions?.length || 0);
  useEffect(() => {
    const newCount = apiPositions?.length || 0;
    if (newCount !== prevPositionCount.current) {
      console.log(`[⏱️ POSITIONS] Position count changed: ${prevPositionCount.current} → ${newCount} at ${new Date().toISOString()}`);
      prevPositionCount.current = newCount;
    }
  }, [apiPositions]);
  
  // TIMING: Log render with positions
  useEffect(() => {
    if (apiPositions && apiPositions.length > 0) {
      console.log(`[⏱️ POSITIONS] Rendered with ${apiPositions.length} positions`);
    }
  }, [apiPositions]);

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

  // Create unified view: One entry per order, combining order + position data
  // This prevents showing duplicate entries for partially filled orders
  const combinedActive: UnifiedTrade[] = useMemo(() => {
    const now = Date.now();
    const results: UnifiedTrade[] = [];
    
    // Create a map of positions by market+outcome for quick lookup
    const positionMap = new Map<string, ApiPosition>();
    for (const p of (apiPositions || [])) {
      if (p.yesShares > 0) {
        positionMap.set(`${p.marketAddress}-YES`, p);
      }
      if (p.noShares > 0) {
        positionMap.set(`${p.marketAddress}-NO`, p);
      }
    }
    
    // Track which positions have been associated with orders
    const usedPositionKeys = new Set<string>();
    
    // Process orders - these represent user's intent
    for (const o of (apiOrders || [])) {
      // Skip cancelled orders
      if (o.status === 'cancelled') continue;
      // Skip expired orders (give 30 second buffer)
      if (o.expiryAt && o.expiryAt < now - 30000) continue;
      // Skip fully-filled sell orders (position already closed, nothing to show)
      if (o.side.toUpperCase() === 'ASK' && o.status === 'filled') continue;

      const outcome = o.outcome.toUpperCase() as 'YES' | 'NO';
      const positionKey = `${o.marketAddress}-${outcome}`;
      const position = positionMap.get(positionKey);
      
      // Get current price from position or real-time prices
      const isCurrentMarket = currentMarketAddress && o.marketAddress === currentMarketAddress;
      let currentPrice = 0;
      if (position) {
        currentPrice = outcome === 'YES' 
          ? (isCurrentMarket && currentYesPrice !== undefined ? currentYesPrice : position.currentPrice)
          : (isCurrentMarket && currentNoPrice !== undefined ? currentNoPrice : (1 - position.currentPrice));
      } else if (isCurrentMarket) {
        currentPrice = outcome === 'YES' 
          ? (currentYesPrice ?? 0) 
          : (currentNoPrice ?? 0);
      }
      
      const totalSize = o.size || 0;
      const filledSize = o.filledSize || 0;
      // Calculate remaining - use API value if available, otherwise calculate from size - filled
      const remainingSize = o.remainingSize ?? (totalSize - filledSize);
      
      // Calculate P&L on filled portion using position's avg entry price
      let pnl: number | undefined;
      let pnlPercent: number | undefined;
      let avgEntry = o.price; // Default to order price
      
      if (position && filledSize > 0) {
        avgEntry = position.avgEntryPrice || o.price;
        const shares = outcome === 'YES' ? position.yesShares : position.noShares;
        if (shares > 0 && currentPrice > 0) {
          pnl = (currentPrice - avgEntry) * filledSize;
          const isLeveraged = position.leverage && position.leverage > 1 && position.marginDeposited && position.marginDeposited > 0;
          pnlPercent = isLeveraged
            ? (pnl / position.marginDeposited!) * 100
            : (avgEntry > 0 ? ((currentPrice - avgEntry) / avgEntry) * 100 : 0);
        }
        usedPositionKeys.add(positionKey);
      }
      
      // Determine status based on fill state
      let status: string;
      if (filledSize > 0 && remainingSize > 0) {
        status = 'PARTIAL';
      } else if (filledSize > 0 && remainingSize <= 0) {
        status = 'FILLED';
      } else {
        status = 'OPEN';
      }
      
      // Calculate cost breakdown in USDC
      const spentAmount = filledSize * avgEntry;
      const pendingAmount = remainingSize * o.price;
      const totalOrderValue = totalSize * o.price; // Total USDC value of original order
      
      // Get leverage info: prefer position data (actual margin account), fall back to order data (pending)
      // This ensures leverage info is shown even before the margin account is created
      const leverage = position?.leverage ?? o.leverage;
      const marginDeposited = position?.marginDeposited ?? o.marginAmount;
      const liquidationPrice = position?.liquidationPrice;
      const loanAmount = position?.loanAmount;
      
      // For pending leveraged orders without a position yet, calculate estimated liquidation price
      // Using simplified formula: liqPrice = entryPrice * (1 - 1/leverage * maintenanceMarginRatio)
      // With ~80% maintenance margin for safety
      let estimatedLiqPrice = liquidationPrice;
      if (!liquidationPrice && leverage && leverage > 1 && o.price > 0) {
        // Simplified liquidation price calculation for display
        // Real liquidation price is calculated by margin service on backend
        const maintenanceRatio = 0.8; // Approximate maintenance margin ratio
        estimatedLiqPrice = o.price * (1 - (maintenanceRatio / leverage));
      }
      
      results.push({
        id: `ord-${o.id}`,
        orderId: o.id,
        type: status === 'FILLED' ? 'position' : (status === 'PARTIAL' ? 'combined' : 'order'),
        market: o.market,
        marketAddress: o.marketAddress,
        asset: o.asset || o.market.split('-')[0] || 'BTC',
        expiryAt: o.expiryAt || 0,
        side: o.side.toUpperCase() as 'BID' | 'ASK',
        outcome,
        size: totalSize,
        filled: filledSize,
        remaining: remainingSize,
        price: avgEntry,
        currentPrice,
        pnl,
        pnlPercent,
        status,
        createdAt: o.createdAt,
        spentAmount,
        pendingAmount,
        totalOrderValue,
        leverage,
        liquidationPrice: estimatedLiqPrice,
        marginDeposited,
        loanAmount,
        marginAccountId: position?.marginAccountId,
      });
    }
    
    // Add any positions that don't have associated open orders
    // (i.e., positions from fully filled orders that are no longer in orders list)
    for (const p of (apiPositions || [])) {
      // Skip expired positions
      if (p.expiryAt && p.expiryAt < now - 30000) continue;
      
      const isCurrentMarket = currentMarketAddress && p.marketAddress === currentMarketAddress;
      const yesPrice = isCurrentMarket && currentYesPrice !== undefined ? currentYesPrice : p.currentPrice;
      const noPrice = isCurrentMarket && currentNoPrice !== undefined ? currentNoPrice : (1 - p.currentPrice);
      
      if (p.yesShares > 0) {
        const posKey = `${p.marketAddress}-YES`;
        if (!usedPositionKeys.has(posKey)) {
          const pnl = (yesPrice - p.avgEntryPrice) * p.yesShares;
          const isLeveraged = p.leverage && p.leverage > 1 && p.marginDeposited && p.marginDeposited > 0;
          const pnlPercent = isLeveraged
            ? (pnl / p.marginDeposited!) * 100
            : (p.avgEntryPrice > 0 ? ((yesPrice - p.avgEntryPrice) / p.avgEntryPrice) * 100 : 0);
          
          results.push({
            id: `pos-${p.marketAddress}-yes`,
            type: 'position',
            market: p.market,
            marketAddress: p.marketAddress,
            asset: p.asset || p.market.split('-')[0] || 'BTC',
            expiryAt: p.expiryAt || 0,
            outcome: 'YES',
            side: 'BID',
            size: p.yesShares,
            filled: p.yesShares,
            remaining: 0,
            price: p.avgEntryPrice,
            currentPrice: yesPrice,
            pnl,
            pnlPercent,
            status: 'FILLED',
            createdAt: p.createdAt || 0,
            spentAmount: p.yesShares * p.avgEntryPrice,
            pendingAmount: 0,
            totalOrderValue: p.yesShares * p.avgEntryPrice,
            leverage: p.leverage,
            liquidationPrice: p.liquidationPrice,
            marginDeposited: p.marginDeposited,
            loanAmount: p.loanAmount,
          });
        }
      }
      
      if (p.noShares > 0) {
        const posKey = `${p.marketAddress}-NO`;
        if (!usedPositionKeys.has(posKey)) {
          const pnl = (noPrice - p.avgEntryPrice) * p.noShares;
          const isLeveraged = p.leverage && p.leverage > 1 && p.marginDeposited && p.marginDeposited > 0;
          const pnlPercent = isLeveraged
            ? (pnl / p.marginDeposited!) * 100
            : (p.avgEntryPrice > 0 ? ((noPrice - p.avgEntryPrice) / p.avgEntryPrice) * 100 : 0);
          
          results.push({
            id: `pos-${p.marketAddress}-no`,
            type: 'position',
            market: p.market,
            marketAddress: p.marketAddress,
            asset: p.asset || p.market.split('-')[0] || 'BTC',
            expiryAt: p.expiryAt || 0,
            outcome: 'NO',
            side: 'BID',
            size: p.noShares,
            filled: p.noShares,
            remaining: 0,
            price: p.avgEntryPrice,
            currentPrice: noPrice,
            pnl,
            pnlPercent,
            status: 'FILLED',
            createdAt: p.createdAt || 0,
            spentAmount: p.noShares * p.avgEntryPrice,
            pendingAmount: 0,
            totalOrderValue: p.noShares * p.avgEntryPrice,
            leverage: p.leverage,
            liquidationPrice: p.liquidationPrice,
            marginDeposited: p.marginDeposited,
            loanAmount: p.loanAmount,
          });
        }
      }
    }
    
    // Add pending order if it exists (shown during "Placing..." phase)
    if (pendingOrder) {
      const outcome = pendingOrder.outcome.toUpperCase() as 'YES' | 'NO';
      const leverage = pendingOrder.leverage;
      const marginAmount = pendingOrder.marginAmount;
      
      // Calculate estimated liquidation price
      let estimatedLiqPrice: number | undefined;
      if (leverage && leverage > 1 && pendingOrder.price > 0) {
        const maintenanceRatio = 0.8;
        estimatedLiqPrice = pendingOrder.price * (1 - (maintenanceRatio / leverage));
      }
      
      results.push({
        id: `pending-${Date.now()}`,
        type: 'order',
        market: pendingOrder.market || `Pending...`,
        marketAddress: pendingOrder.marketAddress,
        asset: 'BTC', // Default, will be updated when order is created
        expiryAt: pendingOrder.expiryAt || 0,
        side: pendingOrder.side.toUpperCase() as 'BID' | 'ASK',
        outcome,
        size: pendingOrder.size,
        filled: 0,
        remaining: pendingOrder.size,
        price: pendingOrder.price,
        currentPrice: 0,
        status: 'PENDING',
        createdAt: Date.now(),
        spentAmount: 0,
        pendingAmount: pendingOrder.size * pendingOrder.price,
        totalOrderValue: pendingOrder.size * pendingOrder.price,
        leverage,
        liquidationPrice: estimatedLiqPrice,
        marginDeposited: marginAmount,
      });
    }
    
    // Sort by creation time, newest first
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }, [apiOrders, apiPositions, pendingOrder, currentMarketAddress, currentYesPrice, currentNoPrice]);
  
  // Separate for summary calculations - only count filled portions
  const positions = combinedActive.filter(t => t.filled > 0);
  
  const totalPnl = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
  const totalValue = positions.reduce((sum, p) => sum + (p.filled * p.currentPrice), 0); // Use filled amount
  const isLoading = positionsLoading || ordersLoading;

  if (!isAuthenticated) {
    return (
      <div className={cn(
        "h-full flex flex-col items-center justify-center text-center",
        compact ? "p-4 space-y-2" : "p-8 space-y-4"
      )}>
        <div className={cn(
          "bg-surface-light rounded-full flex items-center justify-center",
          compact ? "w-8 h-8" : "w-12 h-12"
        )}>
          <Clock className={cn("text-text-muted", compact ? "w-4 h-4" : "w-6 h-6")} />
        </div>
        <div>
          <h3 className={cn("font-bold", compact ? "text-sm" : "text-lg")}>Positions Locked</h3>
          <p className={cn("text-text-muted max-w-xs", compact ? "text-xs" : "text-sm")}>Connect wallet to view</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Liquidation Alert Banner */}
      {liquidationAlert && (
        <div className="bg-short/20 border-b border-short/30 px-4 py-3 animate-pulse">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-short/20">
                <AlertTriangle className="w-4 h-4 text-short" />
              </div>
              <div>
                <p className="text-sm font-bold text-short">Position Liquidated</p>
                <p className="text-xs text-text-muted">
                  {liquidationAlert.shares.toFixed(2)} {liquidationAlert.side} contracts • ${liquidationAlert.returnedToUser.toFixed(2)} returned to wallet
                </p>
              </div>
            </div>
            <button
              onClick={() => setLiquidationAlert(null)}
              className="p-1 hover:bg-surface-light rounded transition-colors"
            >
              <X className="w-4 h-4 text-text-muted" />
            </button>
          </div>
        </div>
      )}
      
      {!compact && (
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
                {tab === 'active' ? 'Open Positions' : 'Trade History'}
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
      )}

      {/* Compact mode: inline tabs */}
      {compact && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 flex-shrink-0">
          <div className="flex gap-1.5">
            {(['active', 'history'] as Tab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'px-3 py-1.5 text-xs font-bold rounded transition-all',
                  activeTab === tab
                    ? 'bg-accent/20 text-accent'
                    : 'text-text-muted hover:text-text-primary'
                )}
              >
                {tab === 'active' ? `Open (${combinedActive.length})` : `History (${transactions?.length || 0})`}
              </button>
            ))}
          </div>
          <button 
            onClick={() => refetchAll()}
            className="p-1.5 hover:bg-surface-light rounded transition-colors"
            disabled={isLoading}
          >
            <RefreshCw className={cn("w-4 h-4 text-text-muted", isLoading && "animate-spin")} />
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {activeTab === 'active' && (
          <UnifiedTable 
            trades={combinedActive} 
            isLoading={isLoading} 
            onSell={onSell} 
            onCancel={handleCancel}
            onAddMargin={setAddMarginTrade}
            isCancelling={isCancelling}
            showPnLPercent={showPnLPercent}
            compact={compact}
            refetchAll={refetchAll}
          />
        )}
        {activeTab === 'history' && (
          <TransactionHistoryTable 
            transactions={transactions || []} 
            isLoading={transactionsLoading}
            compact={compact}
          />
        )}
      </div>

      {activeTab === 'active' && positions.length > 0 && !compact && (
        <div className="px-4 py-3 bg-surface-light/50 border-t border-border flex-shrink-0">
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

      {/* Compact footer with P&L */}
      {activeTab === 'active' && positions.length > 0 && compact && (
        <div className="px-3 py-2.5 bg-surface-light/30 border-t border-border/50 flex items-center justify-between text-sm flex-shrink-0">
          <span className="text-text-muted">{positions.length} pos · ${totalValue.toFixed(0)} value</span>
          <span className={cn('font-mono font-bold text-base', totalPnl >= 0 ? 'text-long' : 'text-short')}>
            {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
          </span>
        </div>
      )}
      
      {/* Add Margin Modal - rendered at Positions level where state is defined */}
      {addMarginTrade && addMarginTrade.marginAccountId && (
        <AddMarginModal
          marginAccountId={addMarginTrade.marginAccountId}
          marketName={addMarginTrade.market}
          outcome={addMarginTrade.outcome}
          currentMarginDeposited={addMarginTrade.marginDeposited || 0}
          currentLoanAmount={addMarginTrade.loanAmount || 0}
          currentLiquidationPrice={addMarginTrade.liquidationPrice || 0}
          currentPrice={addMarginTrade.currentPrice}
          shares={addMarginTrade.filled}
          leverage={addMarginTrade.leverage || 1}
          onClose={() => setAddMarginTrade(null)}
          onSuccess={() => {
            setAddMarginTrade(null);
            refetchAll();
          }}
        />
      )}
    </div>
  );
}

function UnifiedTable({ 
  trades, 
  isLoading, 
  onSell,
  onCancel,
  onAddMargin,
  isCancelling,
  showPnLPercent = true,
  compact = false,
  refetchAll
}: { 
  trades: UnifiedTrade[]; 
  isLoading: boolean;
  onSell?: (marketAddress: string, outcome: 'YES' | 'NO', shares: number, avgEntry: number, price: number, timeframe: any, expiry: number) => void;
  onCancel: (id: string) => void;
  onAddMargin?: (trade: UnifiedTrade) => void;
  isCancelling: boolean;
  showPnLPercent?: boolean;
  compact?: boolean;
  refetchAll?: () => void;
}) {
  if (isLoading && trades.length === 0) {
    return (
      <div className="divide-y divide-border">
        {[1, 2].map(i => (
          <div key={i} className={cn("flex items-center gap-3", compact ? "h-14 px-3 py-2" : "h-20 px-4 py-3")}>
            <div className="w-16 h-5 rounded skeleton" />
            <div className="flex-1 space-y-1">
              <div className="w-20 h-4 rounded skeleton" />
            </div>
            <div className="w-14 h-5 rounded skeleton" />
          </div>
        ))}
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className={cn("text-center text-text-muted", compact ? "py-8" : "py-16")}>
        <div className={cn("mx-auto mb-2 rounded-full bg-surface-light flex items-center justify-center", compact ? "w-10 h-10" : "w-16 h-16")}>
          <Target className={cn("opacity-30", compact ? "w-5 h-5" : "w-8 h-8")} />
        </div>
        <p className={cn("font-medium", compact ? "text-sm mb-0.5" : "text-lg mb-1")}>No positions</p>
        <p className={cn(compact ? "text-xs" : "text-sm")}>Start trading</p>
      </div>
    );
  }

  if (compact) {
    // Check if any position has leverage
    const hasLeveragedPositions = trades.some(t => t.leverage && t.leverage > 1);
    
    return (
      <div className="w-full">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="text-xs text-text-muted uppercase tracking-wider border-b border-border/50 bg-surface-light/5">
              <th className="px-3 py-2.5 font-bold">Market</th>
              <th className="px-2 py-2.5 font-bold text-center">Side</th>
              <th className="px-2 py-2.5 font-bold text-right">Size</th>
              <th className="px-2 py-2.5 font-bold text-right">Avg</th>
              <th className="px-2 py-2.5 font-bold text-right">Now</th>
              {hasLeveragedPositions && (
                <th className="px-2 py-2.5 font-bold text-right">Lev/Liq</th>
              )}
              <th className="px-2 py-2.5 font-bold text-right">P&L</th>
              <th className="px-3 py-2.5 font-bold text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {trades.map((trade) => (
              <CompactTradeRow 
                key={trade.id} 
                trade={trade} 
                onSell={onSell} 
                onCancel={onCancel}
                onAddMargin={onAddMargin}
                isCancelling={isCancelling}
                showLeverage={hasLeveragedPositions}
              />
            ))}
          </tbody>
        </table>
        
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
  
  // Determine status
  const isOpen = trade.status === 'OPEN' && trade.filled === 0;
  const isPartial = trade.status === 'PARTIAL' || (trade.filled > 0 && trade.remaining > 0);
  const isFilled = trade.status === 'FILLED' || (trade.filled > 0 && trade.remaining === 0);
  const hasFills = trade.filled > 0;
  const hasRemaining = trade.remaining > 0;
  
  // Calculate potential payout for filled portion
  const potentialPayout = hasFills ? trade.filled * 1.00 : 0;
  const potentialProfit = hasFills ? potentialPayout - (trade.filled * trade.price) : 0;

  // Calculate fill percentage
  const fillPercent = trade.size > 0 ? (trade.filled / trade.size) * 100 : 0;
  
  // Status badge
  const getStatusBadge = () => {
    if (isPartial) {
      return (
        <span className="px-1.5 py-0.5 rounded text-[8px] bg-warning/20 text-warning font-black uppercase">
          {fillPercent.toFixed(0)}% FILLED
        </span>
      );
    }
    if (isOpen) {
      return (
        <span className="px-1.5 py-0.5 rounded text-[8px] bg-accent/20 text-accent font-black uppercase animate-pulse">
          PENDING
        </span>
      );
    }
    return null; // Filled positions don't need a status badge
  };

  return (
    <tr className={cn(
      "hover:bg-surface-light/30 transition-colors group animate-fade-in",
      isOpen && "bg-accent/5",
      isPartial && "bg-warning/5"
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
            {getStatusBadge()}
          </div>
          <div className="flex items-center gap-1 text-[9px] text-text-muted font-mono mt-1">
            <Clock className="w-2.5 h-2.5" />
            <ExpiryCountdown expiry={trade.expiryAt} />
          </div>
        </div>
      </td>
      
      {/* Size - Show contracts with USDC breakdown */}
      <td className="px-2 py-3 text-right">
        <div className="flex flex-col items-end">
          {isPartial ? (
            <>
              <span className="font-mono text-xs sm:text-sm font-bold text-text-primary">
                {trade.filled.toFixed(0)} <span className="text-text-muted text-[10px]">/ {trade.size.toFixed(0)}</span>
              </span>
              {/* USDC breakdown - prominent display */}
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-[10px] font-bold text-long">
                  ${(trade.spentAmount ?? 0).toFixed(2)}
                </span>
                <span className="text-[9px] text-text-muted">/</span>
                <span className="text-[10px] font-bold text-warning">
                  ${(trade.pendingAmount ?? 0).toFixed(2)}
                </span>
              </div>
              <span className="text-[8px] text-text-muted">
                spent / pending
              </span>
            </>
          ) : isOpen ? (
            <>
              <span className="font-mono text-xs sm:text-sm font-bold text-text-primary">
                {trade.size.toFixed(0)}
              </span>
              <span className="text-[10px] font-bold text-warning">
                ${(trade.totalOrderValue ?? trade.pendingAmount ?? trade.size * trade.price).toFixed(2)}
              </span>
              <span className="text-[8px] text-text-muted">
                pending
              </span>
            </>
          ) : (
            <>
              <span className="font-mono text-xs sm:text-sm font-bold text-text-primary">
                {trade.size.toFixed(0)}
              </span>
              <span className="text-[9px] text-text-muted">
                contracts
              </span>
            </>
          )}
        </div>
      </td>
      
      {/* Entry/Limit Price */}
      <td className="px-2 py-3 text-right">
        <div className="flex flex-col items-end">
          <span className="font-mono text-xs sm:text-sm font-medium text-text-secondary">
            ${trade.price.toFixed(2)}
          </span>
          {isPartial && (
            <span className="text-[9px] text-text-muted">
              avg entry
            </span>
          )}
        </div>
      </td>
      
      {/* Current Price */}
      <td className="px-2 py-3 text-right">
        {hasFills && trade.currentPrice > 0 ? (
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
      
      {/* P&L Display */}
      <td className="px-2 py-3 text-right">
        {trade.pnl !== undefined && hasFills ? (
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
            {showPnLPercent && trade.pnlPercent !== undefined && (
              <div className={cn(
                'text-[10px] sm:text-xs font-bold mt-0.5 flex items-center gap-0.5',
                trade.pnlPercent >= 0 ? 'text-long/80' : 'text-short/80'
              )}>
                <Percent className="w-2.5 h-2.5" />
                {trade.pnlPercent >= 0 ? '+' : ''}{trade.pnlPercent.toFixed(1)}%
              </div>
            )}
            
            {/* Max potential */}
            {potentialProfit > 0 && (
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
      
      {/* Actions - Based on status */}
      <td className="px-2 sm:px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-1">
          {/* Cancel button - for open orders or partial fills */}
          {hasRemaining && trade.orderId && (
            <button 
              onClick={() => onCancel(trade.orderId!)}
              disabled={isCancelling}
              className={cn(
                "p-2 rounded-lg transition-all btn-press",
                isCancelling 
                  ? "opacity-50 cursor-wait" 
                  : "text-text-muted hover:text-short hover:bg-short/10"
              )}
              title={isPartial ? "Cancel Remaining" : "Cancel Order"}
            >
              <X className="w-4 h-4" />
            </button>
          )}
          
          {/* Sell button - for filled positions or partial fills */}
          {hasFills && (
            <button 
              onClick={() => onSell?.(
                trade.marketAddress, 
                trade.outcome, 
                trade.filled, // Sell only the filled portion
                trade.price, 
                trade.currentPrice,
                timeframe,
                trade.expiryAt
              )}
              className="p-2 text-text-muted hover:text-warning hover:bg-warning/10 rounded-lg transition-all btn-press"
              title={isPartial ? "Sell Filled" : "Sell Position"}
            >
              <ArrowRightLeft className="w-4 h-4" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function CompactTradeRow({ 
  trade, 
  onSell,
  onCancel,
  onAddMargin,
  isCancelling,
  showLeverage = false
}: { 
  trade: UnifiedTrade;
  onSell?: (marketAddress: string, outcome: 'YES' | 'NO', shares: number, avgEntry: number, price: number, timeframe: any, expiry: number) => void;
  onCancel: (id: string) => void;
  onAddMargin?: (trade: UnifiedTrade) => void;
  isCancelling: boolean;
  showLeverage?: boolean;
}) {
  const timeframe = trade.market.split('-')[1];
  
  // Determine status
  const isOpen = trade.status === 'OPEN' && trade.filled === 0;
  const isPartial = trade.status === 'PARTIAL' || (trade.filled > 0 && trade.remaining > 0);
  const hasFills = trade.filled > 0;
  const hasRemaining = trade.remaining > 0;
  
  const isLeveraged = trade.leverage && trade.leverage > 1;
  
  // Check if position is near liquidation (within 20% of liquidation price)
  // Note: currentPrice is always YES price, but liquidationPrice is in position's native price space
  const isNearLiquidation = useMemo(() => {
    if (!isLeveraged || !trade.liquidationPrice || trade.currentPrice <= 0) return false;
    
    // For YES positions: compare YES currentPrice to YES liquidationPrice
    // For NO positions: convert currentPrice to NO price first
    const positionCurrentPrice = trade.outcome === 'NO' 
      ? (1 - trade.currentPrice)  // Convert YES price to NO price
      : trade.currentPrice;
    
    // Position is near liquidation when current price is within 20% of liq price
    // For both YES and NO: liquidation happens when price DROPS to liq price
    const distanceToLiq = positionCurrentPrice - trade.liquidationPrice;
    const distancePct = distanceToLiq / positionCurrentPrice;
    
    return distancePct < 0.2 && distancePct >= 0; // Within 20% above liq price
  }, [isLeveraged, trade.liquidationPrice, trade.currentPrice, trade.outcome]);

  return (
    <tr className={cn(
      "hover:bg-surface-light/30 transition-colors",
      isOpen && "bg-accent/5",
      isPartial && "bg-warning/5",
      isNearLiquidation && "bg-short/5"
    )}>
      {/* Market */}
      <td className="px-3 py-3">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="font-bold text-base">{trade.market}</span>
            {isPartial && (
              <span className="px-1.5 py-0.5 rounded text-[8px] bg-warning/20 text-warning font-black">
                {((trade.filled / trade.size) * 100).toFixed(0)}%
              </span>
            )}
            {isOpen && (
              <span className="px-1.5 py-0.5 rounded text-[8px] bg-accent/20 text-accent font-black animate-pulse">
                PENDING
              </span>
            )}
          </div>
          {/* USDC amounts for partial/open */}
          {(isPartial || isOpen) && (
            <div className="flex items-center gap-1 text-[10px] mt-0.5">
              {isPartial ? (
                <>
                  <span className="text-long font-bold">${(trade.spentAmount ?? 0).toFixed(0)}</span>
                  <span className="text-text-muted">/</span>
                  <span className="text-warning font-bold">${(trade.pendingAmount ?? 0).toFixed(0)}</span>
                  <span className="text-text-muted">spent/pending</span>
                </>
              ) : (
                <span className="text-warning font-bold">
                  ${(trade.totalOrderValue ?? trade.pendingAmount ?? trade.size * trade.price).toFixed(0)} pending
                </span>
              )}
            </div>
          )}
        </div>
      </td>
      
      {/* Side/Outcome */}
      <td className="px-2 py-3 text-center">
        <span className={cn(
          'px-2 py-1 rounded text-xs font-black',
          trade.outcome === 'YES' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
        )}>
          {trade.outcome === 'YES' ? 'ABOVE' : 'BELOW'}
        </span>
      </td>
      
      {/* Size */}
      <td className="px-2 py-3 text-right">
        <div className="flex flex-col items-end">
          <span className="font-mono text-base font-bold">
            {isPartial ? trade.filled.toFixed(0) : trade.size.toFixed(0)}
          </span>
          {isPartial && (
            <span className="text-[10px] text-text-muted">of {trade.size.toFixed(0)}</span>
          )}
        </div>
      </td>
      
      {/* Avg Price */}
      <td className="px-2 py-3 text-right">
        <span className="font-mono text-base text-text-secondary">${trade.price.toFixed(2)}</span>
      </td>
      
      {/* Current Price */}
      <td className="px-2 py-3 text-right">
        {hasFills && trade.currentPrice > 0 ? (
          <span className={cn(
            'font-mono text-base font-medium',
            trade.currentPrice > trade.price ? 'text-long' : trade.currentPrice < trade.price ? 'text-short' : 'text-text-primary'
          )}>
            ${trade.currentPrice.toFixed(2)}
          </span>
        ) : (
          <span className="text-text-muted text-base">--</span>
        )}
      </td>
      
      {/* Leverage / Liquidation Price */}
      {showLeverage && (
        <td className="px-2 py-3 text-right">
          {isLeveraged ? (
            <div className="flex flex-col items-end">
              <span className="font-mono text-sm font-bold text-warning">
                {trade.leverage}x
              </span>
              <span className={cn(
                'font-mono text-xs',
                isNearLiquidation ? 'text-short animate-pulse' : 'text-text-muted'
              )}>
                Liq ${trade.liquidationPrice?.toFixed(2)}
              </span>
            </div>
          ) : (
            <span className="text-text-muted text-sm">1x</span>
          )}
        </td>
      )}
      
      {/* P&L with % */}
      <td className="px-2 py-3 text-right">
        {trade.pnl !== undefined && hasFills ? (
          <div className="flex flex-col items-end">
            <span className={cn(
              'font-mono text-base font-bold',
              trade.pnl >= 0 ? 'text-long' : 'text-short'
            )}>
              {trade.pnl >= 0 ? '+' : ''}${Math.abs(trade.pnl).toFixed(2)}
            </span>
            {trade.pnlPercent !== undefined && (
              <span className={cn(
                'font-mono text-xs',
                trade.pnlPercent >= 0 ? 'text-long/70' : 'text-short/70'
              )}>
                {trade.pnlPercent >= 0 ? '+' : ''}{trade.pnlPercent.toFixed(1)}%
              </span>
            )}
          </div>
        ) : (
          <span className="text-text-muted text-base">--</span>
        )}
      </td>
      
      {/* Action - Based on status */}
      <td className="px-3 py-3 text-right">
        <div className="flex items-center justify-end gap-1">
          {/* Add Margin button for leveraged positions */}
          {isLeveraged && hasFills && trade.marginAccountId && onAddMargin && (
            <button 
              onClick={() => onAddMargin(trade)}
              className={cn(
                "px-2 py-2 text-sm font-bold rounded-lg transition-colors",
                isNearLiquidation
                  ? "bg-short/20 text-short hover:bg-short/30 animate-pulse"
                  : "bg-accent/20 text-accent hover:bg-accent/30"
              )}
              title={isNearLiquidation ? "⚠️ Near liquidation! Add margin to avoid liquidation" : "Add margin to reduce liquidation risk"}
            >
              <Shield className="w-4 h-4" />
            </button>
          )}
          
          {/* Cancel button */}
          {hasRemaining && trade.orderId && (
            <button 
              onClick={() => onCancel(trade.orderId!)}
              disabled={isCancelling}
              className="px-3 py-2 text-sm font-bold rounded-lg bg-short/20 text-short hover:bg-short/30 transition-colors"
            >
              {isPartial ? 'Cancel' : 'Cancel'}
            </button>
          )}
          
          {/* Sell button */}
          {hasFills && (
            <button 
              onClick={() => onSell?.(
                trade.marketAddress, 
                trade.outcome, 
                trade.filled, 
                trade.price, 
                trade.currentPrice,
                timeframe,
                trade.expiryAt
              )}
              className="px-3 py-2 text-sm font-bold rounded-lg bg-warning/20 text-warning hover:bg-warning/30 transition-colors"
            >
              Sell
            </button>
          )}
        </div>
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

// Transaction History Table Component - Shows ORDER-LEVEL trades and settlements
// Each row represents one order (aggregated from all fills) or one settlement
function TransactionHistoryTable({ 
  transactions, 
  isLoading,
  compact = false
}: { 
  transactions: UserTransaction[]; 
  isLoading: boolean;
  compact?: boolean;
}) {
  // Calculate realized P&L from closing transactions (settlements with pnl)
  const totalPnl = transactions
    .filter(t => t.transactionType === 'close' && t.pnl !== undefined)
    .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  if (isLoading && transactions.length === 0) {
    return (
      <div className="divide-y divide-border">
        {[1, 2].map(i => <div key={i} className={cn("bg-surface animate-pulse", compact ? "h-12" : "h-16")} />)}
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className={cn("text-center text-text-muted", compact ? "py-8" : "py-16")}>
        <History className={cn("mx-auto opacity-20 mb-2", compact ? "w-5 h-5" : "w-8 h-8")} />
        <p className={compact ? "text-sm" : ""}>No history yet</p>
        {!compact && <p className="text-xs mt-1">Your orders will appear here</p>}
      </div>
    );
  }

  if (compact) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-[10px] text-text-muted uppercase tracking-wider border-b border-border/50 bg-surface-light/5 sticky top-0">
                <th className="px-3 py-2 font-bold">Market</th>
                <th className="px-2 py-2 font-bold text-center">Side</th>
                <th className="px-2 py-2 font-bold text-right">Size</th>
                <th className="px-2 py-2 font-bold text-right">Avg</th>
                <th className="px-2 py-2 font-bold text-center">Lev</th>
                <th className="px-2 py-2 font-bold text-right">P&L</th>
                <th className="px-2 py-2 font-bold text-right">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {transactions.slice(0, 10).map((tx, idx) => {
                const solscanUrl = tx.txSignature 
                  ? `https://solscan.io/tx/${tx.txSignature}` 
                  : null;
                const isBuy = tx.side === 'buy';
                const isSettlement = tx.type === 'settlement';
                const isLiquidation = tx.type === 'liquidation';
                return (
                  <tr key={`${tx.id}-${idx}`} className={cn(
                    "hover:bg-surface-light/30",
                    isLiquidation && "bg-short/5"
                  )}>
                    <td className="px-3 py-2.5">
                      <span className="font-bold text-sm truncate block max-w-[80px]">{tx.market || '--'}</span>
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      {isLiquidation ? (
                        <span className="px-1.5 py-0.5 rounded text-[8px] font-black bg-orange-500/20 text-orange-400">
                          LIQD
                        </span>
                      ) : isSettlement ? (
                        <span className="px-1.5 py-0.5 rounded text-[8px] font-black bg-purple-500/20 text-purple-400">
                          SETTLED
                        </span>
                      ) : (
                        <span className={cn(
                          'px-1.5 py-0.5 rounded text-[8px] font-black',
                          isBuy ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
                        )}>
                          {isBuy ? 'BUY' : 'SELL'}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right">
                      <span className="font-mono text-sm">{tx.size.toFixed(0)}</span>
                    </td>
                    <td className="px-2 py-2.5 text-right">
                      <span className="font-mono text-sm text-text-secondary">${tx.price.toFixed(2)}</span>
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      {tx.leverage && tx.leverage > 1 ? (
                        <span className="font-mono text-sm font-bold text-warning">{tx.leverage}x</span>
                      ) : (
                        <span className="text-text-muted text-sm">1x</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right">
                      {tx.pnl !== undefined && tx.pnl !== null ? (
                        <span className={cn('font-mono text-sm font-bold', tx.pnl >= 0 ? 'text-long' : 'text-short')}>
                          {tx.pnl >= 0 ? '+' : ''}${tx.pnl.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-text-muted text-sm">--</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right">
                      {solscanUrl ? (
                        <a 
                          href={solscanUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1 text-text-muted hover:text-accent hover:bg-accent/10 rounded transition-all inline-flex"
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
              })}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 border-t border-border/50 text-xs text-text-muted flex-shrink-0">
          Realized: <span className={cn('font-bold text-sm', totalPnl >= 0 ? 'text-long' : 'text-short')}>{totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}</span>
        </div>
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

      {/* Table - Shows order-level data with side and avg price */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left border-collapse table-fixed">
          <thead>
            <tr className="text-[9px] sm:text-[10px] text-text-muted uppercase tracking-widest border-b border-border bg-surface-light/10 sticky top-0">
              <th className="px-2 sm:px-4 py-3 font-bold w-[25%]">Market</th>
              <th className="px-2 py-3 font-bold text-center w-[10%]">Side</th>
              <th className="px-2 py-3 font-bold text-right w-[12%]">Size</th>
              <th className="px-2 py-3 font-bold text-right w-[13%]">Avg Price</th>
              <th className="px-2 py-3 font-bold text-center w-[8%]">Lev</th>
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
  const isSettlement = transaction.type === 'settlement';
  const isLiquidation = transaction.type === 'liquidation';
  const isBuy = transaction.side === 'buy';
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

  return (
    <tr className={cn(
      "hover:bg-surface-light/30 transition-colors",
      isLiquidation && "bg-short/5" // Subtle red background for liquidations
    )}>
      {/* Market + Date */}
      <td className="px-2 sm:px-4 py-3">
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-xs sm:text-sm truncate">{transaction.market || '--'}</span>
            {/* Outcome badge */}
            <span className={cn(
              'px-1.5 py-0.5 rounded text-[8px] font-black uppercase flex-shrink-0',
              transaction.outcome === 'yes' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
            )}>
              {transaction.outcome === 'yes' ? 'ABOVE' : 'BELOW'}
            </span>
          </div>
          <span className="text-[9px] text-text-muted">{formattedDate}</span>
        </div>
      </td>
      
      {/* Side */}
      <td className="px-2 py-3 text-center">
        {isLiquidation ? (
          <span className="px-2 py-0.5 rounded text-[9px] font-black uppercase bg-orange-500/20 text-orange-400">
            LIQUIDATED
          </span>
        ) : isSettlement ? (
          <span className="px-2 py-0.5 rounded text-[9px] font-black uppercase bg-purple-500/20 text-purple-400">
            SETTLED
          </span>
        ) : (
          <span className={cn(
            'px-2 py-0.5 rounded text-[9px] font-black uppercase',
            isBuy ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
          )}>
            {isBuy ? 'BUY' : 'SELL'}
          </span>
        )}
      </td>
      
      {/* Size */}
      <td className="px-2 py-3 text-right">
        <span className="font-mono text-xs sm:text-sm font-bold">
          {transaction.size.toFixed(0)}
        </span>
      </td>
      
      {/* Avg Price - show entry→exit for liquidations */}
      <td className="px-2 py-3 text-right">
        {isLiquidation && transaction.entryPrice ? (
          <div className="flex flex-col items-end">
            <span className="font-mono text-xs sm:text-sm text-text-secondary">
              ${transaction.price.toFixed(2)}
            </span>
            <span className="text-[8px] text-text-muted">
              from ${transaction.entryPrice.toFixed(2)}
            </span>
          </div>
        ) : (
          <span className="font-mono text-xs sm:text-sm text-text-secondary">
            ${transaction.price.toFixed(2)}
          </span>
        )}
      </td>
      
      {/* Leverage */}
      <td className="px-2 py-3 text-center">
        {transaction.leverage && transaction.leverage > 1 ? (
          <span className="font-mono text-xs sm:text-sm font-bold text-warning">{transaction.leverage}x</span>
        ) : (
          <span className="text-text-muted font-mono text-xs">1x</span>
        )}
      </td>
      
      {/* P&L */}
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
      
      {/* Solscan Link */}
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
