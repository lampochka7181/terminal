/**
 * useOrder Hook
 * Handles order placement with wallet or session key signing
 * 
 * Supports two signing modes:
 * 1. Wallet signing - user signs each order (popup per order)
 * 2. Session key signing - ephemeral key signs orders (no popup, instant)
 */

import { useState, useCallback, useRef } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useAuthStore } from '@/stores/authStore';
import { useUserStore } from '@/stores/userStore';
import { api, ApiError } from '@/lib/api';
import { submitCancelOrder } from '@/lib/order-builder';
import { validatePrice, validateSize } from '@/lib/solana';

export interface PlaceOrderParams {
  marketAddress: string;
  side: 'bid' | 'ask';
  outcome: 'yes' | 'no';
  orderType: 'limit' | 'market';
  price: number;
  size: number;
  expiryTimestamp?: number;
  dollarAmount?: number;
  maxPrice?: number;
  useDelegation?: boolean;
  // Leverage params
  leverage?: number; // 1-10, default 1 (no leverage)
  marginAmount?: number; // User's margin (required if leverage > 1)
}

// Session signer interface - allows session key to sign orders
export interface SessionSigner {
  publicKey: string;
  sign: (orderData: Record<string, unknown>) => string | null;
}

export interface OrderResult {
  orderId: string;
  orderPda: string;
  txSignature: string;
  status: 'open' | 'partial' | 'filled' | 'cancelled' | 'error';
  fills: number;
  filledSize: number;
  totalSpent?: number;
  avgPrice?: number;
  unfilledDollars?: number;
  error?: string;
}

export interface UseOrderReturn {
  isPlacing: boolean;
  isCancelling: boolean;
  error: string | null;
  lastOrder: OrderResult | null;
  placeOrder: (params: PlaceOrderParams) => Promise<OrderResult | null>;
  cancelOrder: (orderId: string, orderPda?: string) => Promise<boolean>;
  cancelAllOrders: (marketAddress?: string) => Promise<number>;
  clearError: () => void;
}

export function useOrder(sessionSigner?: SessionSigner): UseOrderReturn {
  const { publicKey, signTransaction, signMessage, connected } = useWallet();
  const { connection } = useConnection();
  const { isAuthenticated, token } = useAuthStore();
  
  const [isPlacing, setIsPlacing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOrder, setLastOrder] = useState<OrderResult | null>(null);
  const placingRef = useRef(false); // Ref guard: prevents concurrent submissions even if React hasn't re-rendered

  /**
   * Place a new order
   * Uses session key if available (no popup), otherwise wallet signing (popup)
   */
  const placeOrder = useCallback(async (params: PlaceOrderParams): Promise<OrderResult | null> => {
    // Ref guard: block concurrent submissions (React state may not have re-rendered yet)
    if (placingRef.current) {
      console.warn('[ORDER] Blocked concurrent order submission');
      return null;
    }
    placingRef.current = true;

    if (!connected || !publicKey) {
      setError('Please connect your wallet');
      placingRef.current = false;
      return null;
    }

    if (!signTransaction) {
      setError('Wallet does not support transaction signing');
      placingRef.current = false;
      return null;
    }

    // Read fresh auth state from store (closure values may be stale after inline signIn)
    const { isAuthenticated: authed, token: authToken } = useAuthStore.getState();
    if (!authed || !authToken) {
      setError('Please sign in to place orders');
      placingRef.current = false;
      return null;
    }

    const priceValidation = validatePrice(params.price);
    if (!priceValidation.valid) {
      setError(priceValidation.error || 'Invalid price');
      placingRef.current = false;
      return null;
    }

    const sizeValidation = validateSize(params.size);
    if (!sizeValidation.valid) {
      setError(sizeValidation.error || 'Invalid size');
      placingRef.current = false;
      return null;
    }
    
    // Use truncated size to ensure on-chain compatibility
    const truncatedSize = sizeValidation.truncatedSize || params.size;

    setIsPlacing(true);
    setError(null);
    
    // TIMING: Order flow start
    const t0 = performance.now();
    console.log(`[⏱️ ORDER TIMING] T+0ms: User clicked ${params.side === 'ask' ? 'SELL' : 'BUY'} - starting order flow`);

    try {
      const expiryTimestamp = params.expiryTimestamp || Math.floor(Date.now() / 1000) + 3600;
      const clientOrderId = Date.now();
      const isSellOrder = params.side === 'ask';
      const isMarketOrder = params.orderType === 'market';
      const outcomeLabel = params.outcome.toUpperCase();
      
      // Build order data
      let orderData: Record<string, unknown>;
      const isLeveraged = params.leverage && params.leverage > 1;
      
      if (isSellOrder) {
        orderData = {
          action: 'sell_order',
          market: params.marketAddress,
          side: params.side,
          outcome: params.outcome,
          size: truncatedSize,
          minPrice: params.price,
          expiry: expiryTimestamp,
          clientOrderId,
          timestamp: Date.now(),
        };
      } else if (isMarketOrder && params.dollarAmount) {
        orderData = {
          action: 'market_order',
          market: params.marketAddress,
          side: params.side,
          outcome: params.outcome,
          dollarAmount: params.dollarAmount,
          maxPrice: params.maxPrice,
          expiry: expiryTimestamp,
          clientOrderId,
          timestamp: Date.now(),
          ...(isLeveraged && { leverage: params.leverage, marginAmount: params.marginAmount }),
        };
      } else {
        orderData = {
          action: 'limit_order',
          market: params.marketAddress,
          side: params.side,
          outcome: params.outcome,
          size: truncatedSize,
          price: params.price,
          expiry: expiryTimestamp,
          clientOrderId,
          timestamp: Date.now(),
          ...(isLeveraged && { leverage: params.leverage, marginAmount: params.marginAmount }),
        };
      }

      let signature: string = '';
      let binaryMessage: string = '';
      let sessionPublicKey: string | undefined;
      let useSessionSigning = false;

      // ========================================
      // TRY SESSION KEY SIGNING (No popup - instant!)
      // ========================================
      console.log('[Order] Session signer check:', { 
        hasSessionSigner: !!sessionSigner, 
        sessionPubkey: sessionSigner?.publicKey?.slice(0, 8) 
      });
      
      if (sessionSigner) {
        const sessionSignature = sessionSigner.sign(orderData);
        console.log('[Order] Session signature result:', !!sessionSignature);
        
        if (sessionSignature) {
          signature = sessionSignature;
          binaryMessage = Buffer.from(JSON.stringify(orderData)).toString('base64');
          sessionPublicKey = sessionSigner.publicKey;
          useSessionSigning = true;
          
          const orderTypeLabel = isSellOrder ? 'SELL' : isMarketOrder ? 'MARKET BUY' : 'LIMIT BUY';
          console.log('[Order] ✅ Session key signed', orderTypeLabel, 'order (no popup)');
        } else {
          console.warn('[Order] Session sign returned null, falling back to wallet signing');
        }
      }
      
      // ========================================
      // WALLET SIGNING (Popup per order) - fallback
      // ========================================
      if (!useSessionSigning) {
        if (!signMessage) {
          setError('Wallet does not support message signing');
          return null;
        }

        const orderTypeLabel = isSellOrder ? 'SELL' : isMarketOrder ? 'MARKET BUY' : 'LIMIT BUY';
        console.log('[Order] Wallet signing', orderTypeLabel, 'order (popup)');

        // Create human-readable message for wallet display
        let humanMessage: string;
        
        if (isSellOrder) {
          humanMessage = `Degen Terminal - MARKET SELL

Sell ${params.size.toFixed(2)} ${outcomeLabel} Contracts
Type: Market Order (best available price)

Market: ${params.marketAddress.slice(0, 8)}...
Order ID: ${clientOrderId}
Expires: ${new Date(expiryTimestamp * 1000).toLocaleTimeString()}`;
        } else if (isMarketOrder && params.dollarAmount) {
          humanMessage = `Degen Terminal - MARKET Order

Buy ${outcomeLabel} Contracts
Amount: $${params.dollarAmount} USDC
Max Price: $${params.maxPrice?.toFixed(2) || '0.99'}

Market: ${params.marketAddress.slice(0, 8)}...
Order ID: ${clientOrderId}
Expires: ${new Date(expiryTimestamp * 1000).toLocaleTimeString()}`;
        } else {
          humanMessage = `Degen Terminal - LIMIT Order

Buy ${params.size.toFixed(2)} ${outcomeLabel} Contracts
Limit Price: $${params.price.toFixed(2)}

Market: ${params.marketAddress.slice(0, 8)}...
Order ID: ${clientOrderId}
Expires: ${new Date(expiryTimestamp * 1000).toLocaleTimeString()}`;
        }

        // Combine human + machine readable
        const fullMessage = `${humanMessage}\n\n---\n${JSON.stringify(orderData)}`;
        const messageBytes = new TextEncoder().encode(fullMessage);
        const signatureBytes = await signMessage(messageBytes);
        
        signature = Buffer.from(signatureBytes).toString('base64');
        binaryMessage = Buffer.from(messageBytes).toString('base64');
        
        console.log('[Order] Signed authorization message');
      }

      // Send to backend
      console.log('[Order] Sending with leverage:', { 
        leverage: params.leverage, 
        marginAmount: params.marginAmount,
        dollarAmount: params.dollarAmount,
        isLeveraged: params.leverage && params.leverage > 1
      });
      
      // TIMING: Sending API request
      const t1 = performance.now();
      console.log(`[⏱️ ORDER TIMING] T+${(t1-t0).toFixed(0)}ms: Signed, sending API request...`);
      
      const response = await api.notifyOrderPlaced({
        marketAddress: params.marketAddress,
        side: params.side,
        outcome: params.outcome,
        type: params.orderType,
        price: params.price,
        size: truncatedSize,
        expiry: expiryTimestamp,
        clientOrderId,
        dollarAmount: params.dollarAmount,
        maxPrice: params.maxPrice,
        signature,
        binaryMessage,
        sessionPublicKey, // Include session key if used
        leverage: params.leverage,
        marginAmount: params.marginAmount,
      });

      // TIMING: Got API response
      const t2 = performance.now();
      console.log(`[⏱️ ORDER TIMING] T+${(t2-t0).toFixed(0)}ms: API response received (API took ${(t2-t1).toFixed(0)}ms)`);
      console.log('[Order] Order response:', response);

      // Clear pending order
      useUserStore.getState().setPendingOrder(null);

      // Mark this order as handled so handleFill doesn't double-count shares
      // when the WS fill event arrives for the same order
      if (response.orderId) {
        useUserStore.getState().markOrderHandled(response.orderId);
      }

      // IMMEDIATE POSITION UPDATE: Use position data from response for instant UI update
      // This avoids the extra API round-trip that was causing 1-2 second delays
      // NOTE: response.position contains only THIS order's shares/cost (not aggregate).
      // We must accumulate onto any existing position to avoid flickering on repeat buys.
      if (response.position) {
        console.log(`[⏱️ ORDER TIMING] T+${(performance.now()-t0).toFixed(0)}ms: Updating position in store...`);
        const pos = response.position;
        const store = useUserStore.getState();
        const existing = store.positions.find(p => p.marketAddress === pos.marketAddress);
        const fillPrice = response.avgPrice || pos.avgEntryPrice;
        const isYes = pos.yesShares > 0;
        const fillShares = isYes ? pos.yesShares : pos.noShares;
        const fillCost = pos.totalCost ?? (fillPrice && fillShares ? fillPrice * fillShares : 0);

        if (existing && params.side === 'bid') {
          // Accumulate shares onto existing position (same logic as handleFill)
          const updated = { ...existing };
          if (isYes) {
            const curShares = existing.yesShares || 0;
            const curAvg = existing.avgEntryYes ?? existing.avgEntryPrice ?? 0;
            updated.avgEntryYes = curShares > 0
              ? (curShares * curAvg + fillShares * fillPrice) / (curShares + fillShares)
              : fillPrice;
            updated.yesShares = curShares + fillShares;
            updated.avgEntryPrice = updated.avgEntryYes;
          } else {
            const curShares = existing.noShares || 0;
            const curAvg = existing.avgEntryNo ?? existing.avgEntryPrice ?? 0;
            updated.avgEntryNo = curShares > 0
              ? (curShares * curAvg + fillShares * fillPrice) / (curShares + fillShares)
              : fillPrice;
            updated.noShares = curShares + fillShares;
            updated.avgEntryPrice = updated.avgEntryNo;
          }
          updated.totalCost = (existing.totalCost ?? 0) + fillCost;
          updated.status = 'open';
          store.upsertPosition(updated);
        } else if (!existing || params.side === 'bid') {
          // New position — use API data directly
          const positionWithCorrectEntry = {
            ...pos,
            avgEntryPrice: fillPrice,
            totalCost: fillCost || undefined,
          };
          store.upsertPosition(positionWithCorrectEntry);
        } else {
          // Sell — use API data as-is (reduces shares)
          store.upsertPosition(pos);
        }
        console.log(`[⏱️ ORDER TIMING] T+${(performance.now()-t0).toFixed(0)}ms: Position store updated! Entry: $${fillPrice}`);
      } else if (response.position === null && params.side === 'ask' && response.status === 'filled') {
        // Position was fully closed (sell order that was filled, not cancelled)
        console.log('[Order] Position fully closed, removing from state');
        useUserStore.getState().removePosition(params.marketAddress);
      }
      // Note: If order was cancelled (status !== 'filled'), don't remove position - it still exists
      
      // Background refresh for balance, orders, and transaction history
      setTimeout(() => {
        useUserStore.getState().fetchBalance();
      }, 100);
      setTimeout(() => {
        useUserStore.getState().fetchOrders();
      }, 500);
      setTimeout(() => {
        useUserStore.getState().fetchTransactions();
      }, 2000);

      const result: OrderResult = {
        orderId: response.orderId || `order-${clientOrderId}`,
        orderPda: '',
        txSignature: '',
        status: response.status as 'open' | 'partial' | 'filled' | 'cancelled' || 'filled',
        fills: response.fills || 0,
        filledSize: response.filledSize || 0,
        totalSpent: (response as any).totalSpent,
        avgPrice: response.avgPrice,
        unfilledDollars: (response as any).unfilledDollars,
      };

      setLastOrder(result);
      return result;

    } catch (err) {
      console.error('[Order] Error placing order:', err);
      
      // Clear pending order on error
      useUserStore.getState().setPendingOrder(null);
      
      let errorMessage = 'Failed to place order';
      let shouldRefreshPositions = false;
      
      if (err instanceof ApiError) {
        if (err.code === 'RATE_LIMITED') {
          errorMessage = 'Slow down — you are sending too many requests. Wait a moment and try again.';
        } else if (err.code === 'POSITION_BEING_LIQUIDATED') {
          errorMessage = '⚠️ This position is being liquidated. Please wait for the liquidation to complete.';
          shouldRefreshPositions = true;
        } else if (err.code === 'POSITION_ALREADY_CLOSED') {
          errorMessage = '🔒 This position has been liquidated. Please refresh to see your updated positions.';
          shouldRefreshPositions = true;
        } else if (err.code === 'INSUFFICIENT_DELEGATION' || err.message.includes('Insufficient delegation')) {
          // Extract amounts from error message if possible
          const match = err.message.match(/delegated \$([0-9.]+).*requires \$([0-9.]+)/);
          if (match) {
            const delegated = match[1];
            const required = match[2];
            errorMessage = `💰 Insufficient delegation: You have $${delegated} delegated, but need $${required}. Please increase your delegation.`;
          } else {
            errorMessage = '💰 Insufficient delegation. Please increase your USDC delegation to place this order.';
          }
        } else {
          errorMessage = err.message;
        }
      } else if (err instanceof Error) {
        if (err.message.includes('User rejected') || err.message.includes('rejected')) {
          console.log('[Order] User rejected transaction');
          setIsPlacing(false);
          placingRef.current = false;
          return null;
        } else if (err.message.includes('insufficient')) {
          errorMessage = 'Insufficient SOL for transaction fee';
        } else if (err.message.includes('blockhash')) {
          errorMessage = 'Transaction expired, please try again';
        } else {
          errorMessage = err.message;
        }
      }
      
      // Auto-refresh positions for liquidation-related errors
      if (shouldRefreshPositions) {
        setTimeout(() => {
          useUserStore.getState().fetchAllImmediate();
        }, 500);
      }

      setError(errorMessage);
      
      // Return error result object so caller can immediately access error message
      // without waiting for async state update
      return {
        orderId: '',
        orderPda: '',
        txSignature: '',
        status: 'error' as const,
        fills: 0,
        filledSize: 0,
        error: errorMessage,
      };

    } finally {
      setIsPlacing(false);
      placingRef.current = false;
    }
  }, [connected, publicKey, signTransaction, signMessage, sessionSigner]);

  /**
   * Cancel an existing order
   */
  const cancelOrder = useCallback(async (
    orderId: string, 
    orderPda?: string,
    marketAddress?: string
  ): Promise<boolean> => {
    if (!connected || !publicKey) {
      setError('Please connect your wallet');
      return false;
    }

    if (!signTransaction) {
      setError('Wallet does not support transaction signing');
      return false;
    }

    if (!isAuthenticated || !token) {
      setError('Please sign in to cancel orders');
      return false;
    }

    setIsCancelling(true);
    setError(null);

    try {
      if (orderPda && marketAddress) {
        const signature = await submitCancelOrder(
          orderPda,
          publicKey,
          marketAddress,
          connection,
          signTransaction
        );

        console.log('[Order] Order cancelled on-chain:', signature);
        
        try {
          await api.cancelOrder(orderId, signature);
          useUserStore.getState().fetchAllImmediate();
        } catch (apiErr) {
          console.warn('[Order] Backend notification failed, but order cancelled on-chain');
        }

        return true;
      } else {
        if (!signMessage) {
          setError('Wallet does not support message signing');
          return false;
        }

        const message = `cancel:${orderId}`;
        const messageBytes = new TextEncoder().encode(message);
        const signatureBytes = await signMessage(messageBytes);
        const bs58 = await import('bs58');
        const signature = bs58.default.encode(signatureBytes);

        await api.cancelOrder(orderId, signature);
        console.log('[Order] Order cancelled:', orderId);
        useUserStore.getState().fetchAllImmediate();
        
        return true;
      }

    } catch (err) {
      console.error('[Order] Error cancelling order:', err);
      
      let errorMessage = 'Failed to cancel order';
      if (err instanceof ApiError) {
        errorMessage = err.message;
      } else if (err instanceof Error) {
        if (err.message.includes('User rejected') || err.message.includes('rejected')) {
          console.log('[Order] User rejected cancel transaction');
          return false;
        } else {
          errorMessage = err.message;
        }
      }

      setError(errorMessage);
      return false;

    } finally {
      setIsCancelling(false);
    }
  }, [connected, publicKey, signTransaction, signMessage, connection, isAuthenticated, token]);

  /**
   * Cancel all open orders
   */
  const cancelAllOrders = useCallback(async (marketAddress?: string): Promise<number> => {
    if (!connected || !publicKey) {
      setError('Please connect your wallet');
      return 0;
    }

    if (!signMessage) {
      setError('Wallet does not support message signing');
      return 0;
    }

    if (!isAuthenticated || !token) {
      setError('Please sign in to cancel orders');
      return 0;
    }

    setIsCancelling(true);
    setError(null);

    try {
      const message = marketAddress
        ? `Cancel all orders for market: ${marketAddress}`
        : 'Cancel all orders';
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = await signMessage(messageBytes);
      const bs58 = await import('bs58');
      const signature = bs58.default.encode(signatureBytes);

      const result = await api.cancelAllOrders(signature, marketAddress);
      
      console.log('[Order] Cancelled orders:', result.cancelledCount);
      useUserStore.getState().fetchAllImmediate();
      
      return result.cancelledCount;

    } catch (err) {
      console.error('[Order] Error cancelling orders:', err);
      
      let errorMessage = 'Failed to cancel orders';
      if (err instanceof ApiError) {
        errorMessage = err.message;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      }

      setError(errorMessage);
      return 0;

    } finally {
      setIsCancelling(false);
    }
  }, [connected, publicKey, signMessage, isAuthenticated, token]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    isPlacing,
    isCancelling,
    error,
    lastOrder,
    placeOrder,
    cancelOrder,
    cancelAllOrders,
    clearError,
  };
}

/**
 * Quick order hook with auto sign-in and optional session key support
 */
export function useQuickOrder(sessionSigner?: SessionSigner) {
  const { placeOrder, isPlacing, error, clearError } = useOrder(sessionSigner);
  const { isAuthenticated, signIn, isAuthenticating } = useAuthStore();
  const { signMessage, publicKey, connected } = useWallet();

  const quickPlaceOrder = useCallback(async (params: PlaceOrderParams): Promise<OrderResult | null> => {
    // Auto sign-in if needed
    if (connected && !isAuthenticated && publicKey && signMessage) {
      try {
        await signIn(publicKey.toBase58(), signMessage);
        
        // Check if sign-in actually succeeded (it may return early without error)
        const { isAuthenticated: nowAuthenticated } = useAuthStore.getState();
        if (!nowAuthenticated) {
          console.warn('[QuickOrder] Sign-in did not complete');
          return null;
        }
      } catch (err) {
        console.error('[QuickOrder] Sign-in failed:', err);
        return null;
      }
    }

    return placeOrder(params);
  }, [connected, isAuthenticated, publicKey, signMessage, signIn, placeOrder]);

  return {
    placeOrder: quickPlaceOrder,
    isPlacing: isPlacing || isAuthenticating,
    error,
    clearError,
  };
}
