/**
 * User Store - Balance, Positions, Orders
 * Handles all user-specific data
 */

import { create } from 'zustand';
import { api, type UserBalance, type Position, type Order, type Settlement, type UserTransaction, ApiError } from '@/lib/api';
import { getWebSocket, type UserFillUpdate, type UserSettlementUpdate, type UserLiquidationUpdate } from '@/lib/websocket';

// Debounce helper for fetchAll to prevent request floods
let fetchAllDebounceTimer: NodeJS.Timeout | null = null;
let fetchAllPending = false;
const FETCH_ALL_DEBOUNCE_MS = 500;

// Global request throttle to prevent connection pool exhaustion
// Limits ALL user data fetches to one batch per MIN_FETCH_INTERVAL
let lastFetchAllTime = 0;
let pendingFetchAllResolvers: Array<() => void> = [];
const MIN_FETCH_INTERVAL = 2000; // At least 2 seconds between fetchAll batches

// Delayed refetch tracking - cancel previous if new event comes in
let delayedRefetchTimer: NodeJS.Timeout | null = null;

// Track orderIds that were already handled by the API response (useOrder.ts upsertPosition).
// handleFill should skip these to prevent double-counting shares.
const recentlyHandledOrderIds = new Set<string>();
const HANDLED_ORDER_TTL = 10_000; // 10s — plenty of time for WS fills to arrive

// Pending order info shown during "Placing..." phase before order hits DB
export interface PendingOrderInfo {
  marketAddress: string;
  market: string;
  outcome: 'yes' | 'no';
  side: 'bid' | 'ask';
  size: number;
  price: number;
  leverage?: number;
  marginAmount?: number;
  expiryAt?: number;
}

interface UserState {
  // Balance
  balance: UserBalance | null;
  balanceLoading: boolean;
  
  // Positions
  positions: Position[];
  positionsLoading: boolean;
  
  // Orders
  orders: Order[];
  ordersLoading: boolean;
  
  // Pending order (shown during "Placing..." before order is in DB)
  pendingOrder: PendingOrderInfo | null;
  
  // Settlements (history) - DEPRECATED, use transactions
  settlements: Settlement[];
  settlementsLoading: boolean;
  
  // Transactions (all trade history)
  transactions: UserTransaction[];
  transactionsLoading: boolean;
  transactionsHasMore: boolean;
  
  // Status
  lastUpdate: number | null;
  error: string | null;

  // Actions
  fetchBalance: () => Promise<void>;
  fetchPositions: (status?: 'open' | 'settled' | 'all') => Promise<void>;
  fetchOrders: (status?: 'open' | 'filled' | 'cancelled' | 'all') => Promise<void>;
  fetchSettlements: () => Promise<void>;
  fetchTransactions: (limit?: number, offset?: number) => Promise<void>;
  fetchAll: () => Promise<void>;
  fetchAllImmediate: () => Promise<void>; // Bypass debounce for user actions
  handleFill: (fill: UserFillUpdate['data']) => void;
  handleSettlement: (settlement: UserSettlementUpdate['data']) => void;
  setPendingOrder: (order: PendingOrderInfo | null) => void;
  upsertPosition: (position: Position) => void; // Immediately update/add a position
  removePosition: (marketAddress: string) => void; // Remove a closed position
  markOrderHandled: (orderId: string) => void; // Prevent handleFill from double-counting
  clearUserData: () => void;
}

export const useUserStore = create<UserState>((set, get) => ({
  balance: null,
  balanceLoading: false,
  positions: [],
  positionsLoading: false,
  orders: [],
  ordersLoading: false,
  pendingOrder: null,
  settlements: [],
  settlementsLoading: false,
  transactions: [],
  transactionsLoading: false,
  transactionsHasMore: false,
  lastUpdate: null,
  error: null,

  fetchBalance: async () => {
    set({ balanceLoading: true, error: null });
    try {
      const balance = await api.getUserBalance();
      set({ balance, balanceLoading: false, lastUpdate: Date.now() });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to fetch balance';
      set({ balanceLoading: false, error: message });
      
      // Auto-logout if unauthorized (happens after DB wipe)
      if (error instanceof ApiError && error.status === 401) {
        import('./authStore').then(m => m.useAuthStore.getState().signOut());
      }
      
      throw error;
    }
  },

  fetchPositions: async (status = 'open') => {
    set({ positionsLoading: true, error: null });
    try {
      const positions = await api.getUserPositions({ status });
      set({ positions, positionsLoading: false, lastUpdate: Date.now() });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to fetch positions';
      set({ positionsLoading: false, error: message });
      
      // Auto-logout if unauthorized
      if (error instanceof ApiError && error.status === 401) {
        import('./authStore').then(m => m.useAuthStore.getState().signOut());
      }
      
      throw error;
    }
  },

  fetchOrders: async (status = 'open') => {
    set({ ordersLoading: true, error: null });
    try {
      const { orders } = await api.getUserOrders({ status });
      set({ orders, ordersLoading: false, lastUpdate: Date.now() });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to fetch orders';
      set({ ordersLoading: false, error: message });
      
      // Auto-logout if unauthorized
      if (error instanceof ApiError && error.status === 401) {
        import('./authStore').then(m => m.useAuthStore.getState().signOut());
      }
      
      throw error;
    }
  },

  fetchSettlements: async () => {
    set({ settlementsLoading: true, error: null });
    try {
      const { settlements } = await api.getUserSettlements({ limit: 50 });
      set({ settlements, settlementsLoading: false, lastUpdate: Date.now() });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to fetch settlements';
      set({ settlementsLoading: false, error: message });
      
      // Auto-logout if unauthorized
      if (error instanceof ApiError && error.status === 401) {
        import('./authStore').then(m => m.useAuthStore.getState().signOut());
      }
      
      throw error;
    }
  },

  fetchTransactions: async (limit = 50, offset = 0) => {
    set({ transactionsLoading: true, error: null });
    try {
      const { transactions, hasMore } = await api.getUserTransactions({ limit, offset });
      set({ transactions, transactionsLoading: false, transactionsHasMore: hasMore, lastUpdate: Date.now() });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to fetch transactions';
      set({ transactionsLoading: false, error: message });
      
      // Auto-logout if unauthorized
      if (error instanceof ApiError && error.status === 401) {
        import('./authStore').then(m => m.useAuthStore.getState().signOut());
      }
      
      throw error;
    }
  },

  fetchAll: async () => {
    // Debounce to prevent request floods (e.g., WS reconnect + React StrictMode)
    if (fetchAllDebounceTimer) {
      clearTimeout(fetchAllDebounceTimer);
    }
    
    // If already fetching, just mark as pending and skip
    if (fetchAllPending) {
      return;
    }
    
    return new Promise<void>((resolve) => {
      fetchAllDebounceTimer = setTimeout(async () => {
        fetchAllPending = true;
        try {
          const promises = [
            get().fetchBalance(),
            get().fetchPositions(),
            get().fetchOrders(),
            get().fetchSettlements(),
            get().fetchTransactions(),
          ];
          await Promise.allSettled(promises);
        } finally {
          fetchAllPending = false;
        }
        resolve();
      }, FETCH_ALL_DEBOUNCE_MS);
    });
  },

  // Throttled immediate fetch - prevents connection pool exhaustion
  // Will coalesce rapid calls into a single batch
  fetchAllImmediate: async () => {
    // Clear any pending debounced fetch
    if (fetchAllDebounceTimer) {
      clearTimeout(fetchAllDebounceTimer);
      fetchAllDebounceTimer = null;
    }
    
    const now = Date.now();
    const timeSinceLastFetch = now - lastFetchAllTime;
    
    // If we just fetched, wait before fetching again
    if (timeSinceLastFetch < MIN_FETCH_INTERVAL) {
      // Coalesce this request with any pending one
      return new Promise<void>((resolve) => {
        pendingFetchAllResolvers.push(resolve);
        
        // Schedule a single fetch after the interval passes
        setTimeout(async () => {
          // Only the first resolver triggers the actual fetch
          if (pendingFetchAllResolvers.length > 0 && Date.now() - lastFetchAllTime >= MIN_FETCH_INTERVAL) {
            lastFetchAllTime = Date.now();
            
            const promises = [
              get().fetchBalance(),
              get().fetchPositions(),
              get().fetchOrders(),
              get().fetchSettlements(),
              get().fetchTransactions(),
            ];
            await Promise.allSettled(promises);
            
            // Resolve all waiting callers
            const resolvers = [...pendingFetchAllResolvers];
            pendingFetchAllResolvers = [];
            resolvers.forEach(r => r());
          }
        }, MIN_FETCH_INTERVAL - timeSinceLastFetch);
      });
    }
    
    // Enough time has passed, fetch immediately
    lastFetchAllTime = now;
    
    const promises = [
      get().fetchBalance(),
      get().fetchPositions(),
      get().fetchOrders(),
      get().fetchSettlements(),
      get().fetchTransactions(),
    ];
    await Promise.allSettled(promises);
    
    // Resolve any pending callers that were waiting
    const resolvers = [...pendingFetchAllResolvers];
    pendingFetchAllResolvers = [];
    resolvers.forEach(r => r());
  },

  handleFill: (fill) => {
    // Cancel any pending delayed refetch from previous events
    if (delayedRefetchTimer) {
      clearTimeout(delayedRefetchTimer);
    }
    delayedRefetchTimer = null;

    // Skip optimistic update if this fill's order was already handled by the API response
    // (useOrder.ts already called upsertPosition with correct position data).
    // Without this, we'd double-count shares: once from API response, once from WS fill.
    if (fill.orderId && recentlyHandledOrderIds.has(fill.orderId)) {
      console.log(`[UserStore] Skipping handleFill for already-handled order ${fill.orderId.slice(0,8)}`);
      // Still do a background refetch to ensure consistency
      get().fetchAllImmediate();
      return;
    }

    // Optimistically update position immediately from fill data
    // This gives instant UI feedback instead of waiting for DB round-trip
    const isBuy = fill.side === 'bid';
    const positions = get().positions;
    const existing = positions.find(p => p.marketAddress === fill.marketAddress);
    const isYes = fill.outcome === 'yes';
    const fillShares = fill.filledSize;
    const fillPrice = fill.price;

    if (existing) {
      const updated = { ...existing };
      if (isBuy) {
        // Add shares and update weighted avg entry
        if (isYes) {
          const curShares = updated.yesShares || 0;
          const curAvg = updated.avgEntryYes ?? updated.avgEntryPrice ?? 0;
          updated.avgEntryYes = curShares > 0
            ? (curShares * curAvg + fillShares * fillPrice) / (curShares + fillShares)
            : fillPrice;
          updated.yesShares = curShares + fillShares;
          updated.avgEntryPrice = updated.avgEntryYes;
        } else {
          const curShares = updated.noShares || 0;
          const curAvg = updated.avgEntryNo ?? updated.avgEntryPrice ?? 0;
          updated.avgEntryNo = curShares > 0
            ? (curShares * curAvg + fillShares * fillPrice) / (curShares + fillShares)
            : fillPrice;
          updated.noShares = curShares + fillShares;
          updated.avgEntryPrice = updated.avgEntryNo;
        }
        updated.totalCost = (updated.totalCost ?? 0) + fillShares * fillPrice;
      } else {
        // Sell: subtract shares
        if (isYes) {
          updated.yesShares = Math.max(0, (updated.yesShares || 0) - fillShares);
        } else {
          updated.noShares = Math.max(0, (updated.noShares || 0) - fillShares);
        }
      }
      updated.status = 'open';
      get().upsertPosition(updated);
    } else if (isBuy) {
      // New position — create it optimistically
      const newPosition: Position = {
        marketAddress: fill.marketAddress,
        market: '',
        asset: '',
        expiryAt: 0,
        yesShares: isYes ? fillShares : 0,
        noShares: isYes ? 0 : fillShares,
        avgEntryPrice: fillPrice,
        avgEntryYes: isYes ? fillPrice : undefined,
        avgEntryNo: isYes ? undefined : fillPrice,
        currentPrice: 0,
        unrealizedPnL: 0,
        totalCost: fillShares * fillPrice,
        status: 'open',
        createdAt: Date.now(),
      };
      get().upsertPosition(newPosition);
    }

    // Background refetch to sync with DB (fills in market name, prices, etc.)
    get().fetchAllImmediate();
  },

  handleSettlement: (settlement) => {
    if (delayedRefetchTimer) {
      clearTimeout(delayedRefetchTimer);
    }
    delayedRefetchTimer = null;

    // Immediate fetch for positions/balance
    get().fetchAllImmediate();

    // Poll for settlement data: first at 3s, then every 5s until new transactions appear
    const txCountBefore = get().transactions.length;
    let attempts = 0;
    const maxAttempts = 6; // up to ~33s total
    const poll = () => {
      attempts++;
      get().fetchTransactions();
      get().fetchBalance();
      if (get().transactions.length > txCountBefore || attempts >= maxAttempts) {
        if (delayedRefetchTimer) clearInterval(delayedRefetchTimer);
        delayedRefetchTimer = null;
      }
    };
    delayedRefetchTimer = setTimeout(() => {
      poll();
      delayedRefetchTimer = setInterval(poll, 5000) as any;
    }, 3000) as any;
  },

  setPendingOrder: (order) => {
    set({ pendingOrder: order });
  },

  upsertPosition: (position) => {
    console.log(`[⏱️ STORE] upsertPosition called for ${position.marketAddress.slice(0,8)}...`);
    set((state) => {
      const existingIndex = state.positions.findIndex(
        (p) => p.marketAddress === position.marketAddress
      );
      
      if (existingIndex >= 0) {
        const existing = state.positions[existingIndex];
        // Merge: preserve shares and entry prices from the other outcome
        const merged = { ...position };
        if (position.yesShares > 0 && existing.noShares > 0 && position.noShares === 0) {
          merged.noShares = existing.noShares;
          merged.avgEntryNo = existing.avgEntryNo ?? existing.avgEntryPrice;
          merged.avgEntryYes = position.avgEntryYes ?? position.avgEntryPrice;
          merged.totalCost = (position.totalCost ?? 0) + (existing.totalCost ?? existing.noShares * existing.avgEntryPrice);
        } else if (position.noShares > 0 && existing.yesShares > 0 && position.yesShares === 0) {
          merged.yesShares = existing.yesShares;
          merged.avgEntryYes = existing.avgEntryYes ?? existing.avgEntryPrice;
          merged.avgEntryNo = position.avgEntryNo ?? position.avgEntryPrice;
          merged.totalCost = (position.totalCost ?? 0) + (existing.totalCost ?? existing.yesShares * existing.avgEntryPrice);
        }
        console.log(`[⏱️ STORE] Merging position at index ${existingIndex} (yes=${merged.yesShares}, no=${merged.noShares})`);
        const newPositions = [...state.positions];
        newPositions[existingIndex] = merged;
        return { positions: newPositions };
      } else {
        // Add new position
        console.log(`[⏱️ STORE] Adding new position (total will be ${state.positions.length + 1})`);
        return { positions: [position, ...state.positions] };
      }
    });
  },

  removePosition: (marketAddress) => {
    set((state) => ({
      positions: state.positions.filter((p) => p.marketAddress !== marketAddress),
    }));
  },

  markOrderHandled: (orderId) => {
    recentlyHandledOrderIds.add(orderId);
    setTimeout(() => recentlyHandledOrderIds.delete(orderId), HANDLED_ORDER_TTL);
  },

  clearUserData: () => {
    set({
      balance: null,
      positions: [],
      orders: [],
      pendingOrder: null,
      settlements: [],
      transactions: [],
      transactionsHasMore: false,
      lastUpdate: null,
      error: null,
    });
  },
}));

// Subscribe to user-specific WebSocket updates
export function subscribeToUserUpdates(): () => void {
  const ws = getWebSocket();
  
  const unsubscribe = ws.onMessage((message) => {
    if (message.channel !== 'user') return;
    
    console.log('[UserStore] WebSocket update received:', message);
    const store = useUserStore.getState();
    
    if (message.event === 'fill') {
      const fillMessage = message as UserFillUpdate;
      store.handleFill(fillMessage.data);
    } else if (message.event === 'settlement') {
      const settlementMessage = message as UserSettlementUpdate;
      store.handleSettlement(settlementMessage.data);
    } else if (message.event === 'liquidation') {
      // Position was liquidated - refresh positions to get updated state
      const liquidationMessage = message as UserLiquidationUpdate;
      console.log('[UserStore] Position liquidated, refreshing positions:', liquidationMessage.data);
      store.fetchPositions('open').catch(err => console.error('[UserStore] Failed to refresh positions after liquidation:', err));
    }
  });

  return unsubscribe;
}







