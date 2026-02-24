/**
 * useLiquidationNotifications Hook
 * 
 * Listens for WebSocket liquidation events and triggers:
 * 1. Position refresh
 * 2. Balance refresh
 * 3. Optional callback for UI notifications
 */

import { useEffect, useCallback, useRef } from 'react';
import { getWebSocket, type UserLiquidationUpdate } from '@/lib/websocket';
import { useUserStore } from '@/stores/userStore';
import { useAuthStore } from '@/stores/authStore';

interface LiquidationNotification {
  marketId: string;
  marketAddress: string;
  side: 'YES' | 'NO';
  shares: number;
  entryPrice: number;
  liquidationPrice: number;
  executionPrice: number;
  proceeds: number;
  returnedToUser: number;
  leverage: number;
}

interface UseLiquidationNotificationsOptions {
  onLiquidation?: (notification: LiquidationNotification) => void;
}

export function useLiquidationNotifications(options?: UseLiquidationNotificationsOptions) {
  const { isAuthenticated } = useAuthStore();
  const onLiquidationRef = useRef(options?.onLiquidation);
  
  // Keep callback ref updated
  useEffect(() => {
    onLiquidationRef.current = options?.onLiquidation;
  }, [options?.onLiquidation]);

  const handleMessage = useCallback((message: any) => {
    // Only process liquidation events
    if (message.channel !== 'user' || message.event !== 'liquidation') {
      return;
    }

    const liquidationData = message.data as LiquidationNotification;
    
    console.log('[Liquidation] Position liquidated:', {
      market: liquidationData.marketAddress?.slice(0, 8),
      side: liquidationData.side,
      shares: liquidationData.shares?.toFixed(2),
      returnedToUser: liquidationData.returnedToUser?.toFixed(2),
    });

    // Immediately refresh positions and balance
    const userStore = useUserStore.getState();
    
    // Remove the position from local state immediately for instant UI update
    if (liquidationData.marketAddress) {
      userStore.removePosition(liquidationData.marketAddress);
    }
    
    // Also do a full refresh to sync with backend
    userStore.fetchAllImmediate();
    userStore.fetchBalance();

    // Call the optional callback for UI notifications (toast, modal, etc.)
    if (onLiquidationRef.current) {
      onLiquidationRef.current(liquidationData);
    }
  }, []);

  useEffect(() => {
    // Only listen when authenticated
    if (!isAuthenticated) {
      return;
    }

    const ws = getWebSocket();
    const unsubscribe = ws.onMessage(handleMessage);

    return () => {
      unsubscribe();
    };
  }, [isAuthenticated, handleMessage]);
}

export default useLiquidationNotifications;

