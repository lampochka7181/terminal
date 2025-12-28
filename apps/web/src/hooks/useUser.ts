/**
 * useUser Hook
 * Access user data (balance, positions, orders)
 */

import { useEffect } from 'react';
import { useUserStore, subscribeToUserUpdates } from '@/stores/userStore';
import { useAuthStore } from '@/stores/authStore';

export function useUser() {
  const { isAuthenticated } = useAuthStore();
  const user = useUserStore();

  // Fetch user data when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      user.fetchAll();
    }
  }, [isAuthenticated]);

  // Subscribe to WebSocket updates
  useEffect(() => {
    if (!isAuthenticated) return;

    const unsubscribe = subscribeToUserUpdates();
    return unsubscribe;
  }, [isAuthenticated]);

  return {
    // Balance
    balance: user.balance,
    balanceLoading: user.balanceLoading,
    
    // Positions
    positions: user.positions,
    positionsLoading: user.positionsLoading,
    
    // Orders
    orders: user.orders,
    ordersLoading: user.ordersLoading,
    
    // Settlements (history) - DEPRECATED, use transactions
    settlements: user.settlements,
    settlementsLoading: user.settlementsLoading,
    
    // Transactions (all trade history)
    transactions: user.transactions,
    transactionsLoading: user.transactionsLoading,
    transactionsHasMore: user.transactionsHasMore,
    
    // Status
    lastUpdate: user.lastUpdate,
    error: user.error,
    
    // Actions
    refetchBalance: user.fetchBalance,
    refetchPositions: user.fetchPositions,
    refetchOrders: user.fetchOrders,
    refetchSettlements: user.fetchSettlements,
    refetchTransactions: user.fetchTransactions,
    refetchAll: user.fetchAll,
  };
}

export function useBalance() {
  const { balance, balanceLoading, refetchBalance } = useUser();
  return { balance, loading: balanceLoading, refetch: refetchBalance };
}

export function usePositions(status: 'open' | 'settled' | 'all' = 'open') {
  const { isAuthenticated } = useAuthStore();
  const { positions, positionsLoading, fetchPositions } = useUserStore();

  useEffect(() => {
    if (isAuthenticated) {
      fetchPositions(status);
    }
  }, [isAuthenticated, status, fetchPositions]);

  return { positions, loading: positionsLoading, refetch: () => fetchPositions(status) };
}

export function useOrders(status: 'open' | 'filled' | 'cancelled' | 'all' = 'open') {
  const { isAuthenticated } = useAuthStore();
  const { orders, ordersLoading, fetchOrders } = useUserStore();

  useEffect(() => {
    if (isAuthenticated) {
      fetchOrders(status);
    }
  }, [isAuthenticated, status, fetchOrders]);

  return { orders, loading: ordersLoading, refetch: () => fetchOrders(status) };
}

export function useOpenPositionsCount() {
  const { positions } = useUserStore();
  return positions.filter(p => p.status === 'open').length;
}

export function useOpenOrdersCount() {
  const { orders } = useUserStore();
  return orders.filter(o => o.status === 'open' || o.status === 'partial').length;
}

export function useTotalPnL() {
  const { positions } = useUserStore();
  return positions.reduce((total, pos) => total + pos.unrealizedPnL, 0);
}







