/**
 * User Store - Balance, Positions, Orders
 * Handles all user-specific data
 */

import { create } from 'zustand';
import { api, type UserBalance, type Position, type Order, type Settlement, type UserTransaction, ApiError } from '@/lib/api';
import { getWebSocket, type UserFillUpdate, type UserSettlementUpdate } from '@/lib/websocket';

// Debounce helper for fetchAll to prevent request floods
let fetchAllDebounceTimer: NodeJS.Timeout | null = null;
let fetchAllPending = false;
const FETCH_ALL_DEBOUNCE_MS = 500;

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
  handleFill: (fill: UserFillUpdate['data']) => void;
  handleSettlement: (settlement: UserSettlementUpdate['data']) => void;
  clearUserData: () => void;
}

export const useUserStore = create<UserState>((set, get) => ({
  balance: null,
  balanceLoading: false,
  positions: [],
  positionsLoading: false,
  orders: [],
  ordersLoading: false,
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

  handleFill: (fill) => {
    // Debounced refetch - handles DB replication lag via debounce window
    get().fetchAll();
    
    // One delayed refetch to catch any slower DB propagation
    setTimeout(() => {
      get().fetchAll();
    }, 2000);
  },

  handleSettlement: (settlement) => {
    // Debounced refetch after settlement
    get().fetchAll();

    // One delayed refetch
    setTimeout(() => {
      get().fetchAll();
    }, 2500);
  },

  clearUserData: () => {
    set({
      balance: null,
      positions: [],
      orders: [],
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
    }
  });

  return unsubscribe;
}







