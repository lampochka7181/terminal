/**
 * User Store - Balance, Positions, Orders
 * Handles all user-specific data
 */

import { create } from 'zustand';
import { api, type UserBalance, type Position, type Order, ApiError } from '@/lib/api';
import { getWebSocket, type UserFillUpdate, type UserSettlementUpdate } from '@/lib/websocket';

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
  
  // Status
  lastUpdate: number | null;
  error: string | null;

  // Actions
  fetchBalance: () => Promise<void>;
  fetchPositions: (status?: 'open' | 'settled' | 'all') => Promise<void>;
  fetchOrders: (status?: 'open' | 'filled' | 'cancelled' | 'all') => Promise<void>;
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

  fetchAll: async () => {
    const promises = [
      get().fetchBalance(),
      get().fetchPositions(),
      get().fetchOrders(),
    ];
    await Promise.allSettled(promises);
  },

  handleFill: (fill) => {
    // Refetch data IMMEDIATELY after fill
    get().fetchAll();
    
    // Also refetch again slightly later to catch any backend DB replication lag
    setTimeout(() => {
      get().fetchAll();
    }, 1500);
  },

  handleSettlement: (settlement) => {
    // Refetch full data immediately after settlement
    get().fetchAll();

    // Refetch again later
    setTimeout(() => {
      get().fetchAll();
    }, 2000);
  },

  clearUserData: () => {
    set({
      balance: null,
      positions: [],
      orders: [],
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







