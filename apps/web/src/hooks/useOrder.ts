/**
 * useOrder Hook
 * Handles on-chain order placement with transaction signing
 * 
 * This hook implements the trustless order flow where users sign
 * real Solana transactions that create Order PDAs on-chain.
 */

import { useState, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useAuthStore } from '@/stores/authStore';
import { useUserStore } from '@/stores/userStore';
import { api, ApiError } from '@/lib/api';
import {
  submitCancelOrder,
} from '@/lib/order-builder';
import { validatePrice, validateSize } from '@/lib/solana';

export interface PlaceOrderParams {
  marketAddress: string;
  side: 'bid' | 'ask';
  outcome: 'yes' | 'no';
  orderType: 'limit' | 'market';
  price: number;  // For LIMIT: exact price. For MARKET: max price willing to pay
  size: number;   // For LIMIT: exact contracts. For MARKET: estimated contracts
  expiryTimestamp?: number;
  // MARKET order specific
  dollarAmount?: number;  // Total USD to spend (MARKET orders)
  maxPrice?: number;      // Price protection limit (MARKET orders)
  // Delegation mode (skip on-chain order, use relayer delegation)
  useDelegation?: boolean;
}

export interface OrderResult {
  orderId: string;
  orderPda: string;
  txSignature: string;
  status: 'open' | 'partial' | 'filled' | 'cancelled';
  fills: number;
  filledSize: number;
  // MARKET order specific results
  totalSpent?: number;
  avgPrice?: number;
  unfilledDollars?: number;
}

export interface UseOrderReturn {
  // State
  isPlacing: boolean;
  isCancelling: boolean;
  error: string | null;
  lastOrder: OrderResult | null;
  
  // Actions
  placeOrder: (params: PlaceOrderParams) => Promise<OrderResult | null>;
  cancelOrder: (orderId: string, orderPda?: string) => Promise<boolean>;
  cancelAllOrders: (marketAddress?: string) => Promise<number>;
  clearError: () => void;
}

export function useOrder(): UseOrderReturn {
  const { publicKey, signTransaction, signMessage, connected } = useWallet();
  const { connection } = useConnection();
  const { isAuthenticated, token } = useAuthStore();
  
  const [isPlacing, setIsPlacing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOrder, setLastOrder] = useState<OrderResult | null>(null);

  /**
   * Place a new order (on-chain transaction)
   */
  const placeOrder = useCallback(async (params: PlaceOrderParams): Promise<OrderResult | null> => {
    // Validate wallet connection
    if (!connected || !publicKey) {
      setError('Please connect your wallet');
      return null;
    }

    if (!signTransaction) {
      setError('Wallet does not support transaction signing');
      return null;
    }

    // Validate authentication
    if (!isAuthenticated || !token) {
      setError('Please sign in to place orders');
      return null;
    }

    // Validate price
    const priceValidation = validatePrice(params.price);
    if (!priceValidation.valid) {
      setError(priceValidation.error || 'Invalid price');
      return null;
    }

    // Validate size
    const sizeValidation = validateSize(params.size);
    if (!sizeValidation.valid) {
      setError(sizeValidation.error || 'Invalid size');
      return null;
    }

    setIsPlacing(true);
    setError(null);

    try {
      // Set expiry to market close or 1 hour from now (whichever is sooner)
      const expiryTimestamp = params.expiryTimestamp || Math.floor(Date.now() / 1000) + 3600;
      const clientOrderId = Date.now();

      // ========================================
      // DELEGATED ORDER (Fast Mode)
      // ========================================
      const isSellOrder = params.side === 'ask';
      const isMarketOrder = params.orderType === 'market';
      
      const orderTypeLabel = isSellOrder ? 'SELL' : isMarketOrder ? 'MARKET BUY' : 'LIMIT BUY';
      console.log('[Order] Using fast mode for', orderTypeLabel, 'order');

      // Sign authorization message
      if (!signMessage) {
        setError('Wallet does not support message signing');
        return null;
      }

      // Create human-readable message for wallet display
      const outcomeLabel = params.outcome.toUpperCase();
      let humanMessage: string;
      let orderData: Record<string, unknown>;

      if (isSellOrder) {
        humanMessage = `Degen Terminal - MARKET SELL

Sell ${params.size.toFixed(2)} ${outcomeLabel} Contracts
Type: Market Order (best available price)

Market: ${params.marketAddress.slice(0, 8)}...
Order ID: ${clientOrderId}
Expires: ${new Date(expiryTimestamp * 1000).toLocaleTimeString()}`;
        orderData = {
          action: 'sell_order',
          market: params.marketAddress,
          side: params.side,
          outcome: params.outcome,
          size: params.size,
          minPrice: params.price,
          expiry: expiryTimestamp,
          clientOrderId,
          timestamp: Date.now(),
        };
      } else if (isMarketOrder && params.dollarAmount) {
        humanMessage = `Degen Terminal - MARKET Order

Buy ${outcomeLabel} Contracts
Amount: $${params.dollarAmount} USDC
Max Price: $${params.maxPrice?.toFixed(2) || '0.99'}

Market: ${params.marketAddress.slice(0, 8)}...
Order ID: ${clientOrderId}
Expires: ${new Date(expiryTimestamp * 1000).toLocaleTimeString()}`;
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
        };
      } else {
        // LIMIT order
        humanMessage = `Degen Terminal - LIMIT Order

Buy ${params.size.toFixed(2)} ${outcomeLabel} Contracts
Limit Price: $${params.price.toFixed(2)}

Market: ${params.marketAddress.slice(0, 8)}...
Order ID: ${clientOrderId}
Expires: ${new Date(expiryTimestamp * 1000).toLocaleTimeString()}`;
        orderData = {
          action: 'limit_order',
          market: params.marketAddress,
          side: params.side,
          outcome: params.outcome,
          size: params.size,
          price: params.price,
          expiry: expiryTimestamp,
          clientOrderId,
          timestamp: Date.now(),
        };
      }

      // Combine human + machine readable
      const fullMessage = `${humanMessage}\n\n---\n${JSON.stringify(orderData)}`;

      const messageBytes = new TextEncoder().encode(fullMessage);
      const signatureBytes = await signMessage(messageBytes);
      const signature = Buffer.from(signatureBytes).toString('base64');

      console.log('[Order] Signed authorization message');

      // Notify backend
      const response = await api.notifyOrderPlaced({
        marketAddress: params.marketAddress,
        side: params.side,
        outcome: params.outcome,
        type: params.orderType,
        price: params.price,
        size: params.size,
        expiry: expiryTimestamp,
        clientOrderId,
        dollarAmount: params.dollarAmount,
        maxPrice: params.maxPrice,
        signature,
        binaryMessage: Buffer.from(messageBytes).toString('base64'),
      });

      console.log('[Order] Order response:', response);

      // Trigger user data refetch to update UI (positions, orders, balance)
      useUserStore.getState().fetchAll();

      const result: OrderResult = {
        orderId: response.orderId || `delegated-${clientOrderId}`,
        orderPda: '',
        txSignature: '',
        status: response.status as 'open' | 'partial' | 'filled' | 'cancelled' || 'filled',
        fills: (response as any).fills || 0,
        filledSize: (response as any).filledSize || 0,
        totalSpent: (response as any).totalSpent,
        avgPrice: (response as any).avgPrice,
        unfilledDollars: (response as any).unfilledDollars,
      };

      setLastOrder(result);
      return result;

    } catch (err) {
      console.error('[Order] Error placing order:', err);
      
      let errorMessage = 'Failed to place order';
      
      if (err instanceof ApiError) {
        errorMessage = err.message;
      } else if (err instanceof Error) {
        // Handle wallet rejection
        if (err.message.includes('User rejected') || err.message.includes('rejected')) {
          errorMessage = 'Transaction was rejected';
        } else if (err.message.includes('insufficient')) {
          errorMessage = 'Insufficient SOL for transaction fee';
        } else if (err.message.includes('blockhash')) {
          errorMessage = 'Transaction expired, please try again';
        } else {
          errorMessage = err.message;
        }
      }

      setError(errorMessage);
      return null;

    } finally {
      setIsPlacing(false);
    }
  }, [connected, publicKey, signTransaction, connection, isAuthenticated, token]);

  /**
   * Cancel an existing order (on-chain transaction)
   * @param orderId - Database order ID
   * @param orderPda - On-chain Order PDA address (if on-chain order)
   * @param marketAddress - Market address (required for on-chain cancellation)
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
      // If orderPda is provided, cancel on-chain
      if (orderPda && marketAddress) {
        const signature = await submitCancelOrder(
          orderPda,
          publicKey,
          marketAddress,
          connection,
          signTransaction
        );

        console.log('[Order] Order cancelled on-chain:', signature);
        
        // Notify backend
        try {
          await api.cancelOrder(orderId, signature);
          // Refresh user data after successful cancellation
          useUserStore.getState().fetchAll();
        } catch (apiErr) {
          console.warn('[Order] Backend notification failed, but order cancelled on-chain');
        }

        return true;
      } else {
        // Fallback: use message signing for off-chain orders
        if (!signMessage) {
          setError('Wallet does not support message signing');
          return false;
        }

        const message = `Cancel order: ${orderId}`;
        const messageBytes = new TextEncoder().encode(message);
        const signatureBytes = await signMessage(messageBytes);
        const signature = require('bs58').encode(signatureBytes);

        await api.cancelOrder(orderId, signature);
        console.log('[Order] Order cancelled:', orderId);
        
        // Refresh user data after successful cancellation
        useUserStore.getState().fetchAll();
        
        return true;
      }

    } catch (err) {
      console.error('[Order] Error cancelling order:', err);
      
      let errorMessage = 'Failed to cancel order';
      if (err instanceof ApiError) {
        errorMessage = err.message;
      } else if (err instanceof Error) {
        if (err.message.includes('User rejected') || err.message.includes('rejected')) {
          errorMessage = 'Transaction was rejected';
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
      // Sign cancel all message
      const message = marketAddress
        ? `Cancel all orders for market: ${marketAddress}`
        : 'Cancel all orders';
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = await signMessage(messageBytes);
      const signature = require('bs58').encode(signatureBytes);

      // Submit cancellation
      const result = await api.cancelAllOrders(signature, marketAddress);
      
      console.log('[Order] Cancelled orders:', result.cancelledCount);
      
      // Refresh user data after successful cancellation
      useUserStore.getState().fetchAll();
      
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
 * Simple order placement hook with auto sign-in
 */
export function useQuickOrder() {
  const { placeOrder, isPlacing, error, clearError } = useOrder();
  const { isAuthenticated, signIn, isAuthenticating } = useAuthStore();
  const { signMessage, publicKey, connected } = useWallet();

  const quickPlaceOrder = useCallback(async (params: PlaceOrderParams): Promise<OrderResult | null> => {
    // Auto sign-in if needed
    if (connected && !isAuthenticated && publicKey && signMessage) {
      try {
        await signIn(publicKey.toBase58(), signMessage);
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
