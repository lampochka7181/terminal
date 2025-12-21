/**
 * useAuth Hook
 * Combines wallet adapter with auth store for easy authentication
 */

import { useCallback, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAuthStore, startTokenRefresh, stopTokenRefresh } from '@/stores/authStore';
import { useUserStore } from '@/stores/userStore';
import { getWebSocket } from '@/lib/websocket';

export function useAuth() {
  const wallet = useWallet();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isAuthenticating = useAuthStore((state) => state.isAuthenticating);
  const walletAddress = useAuthStore((state) => state.walletAddress);
  const token = useAuthStore((state) => state.token);
  const error = useAuthStore((state) => state.error);
  const authSignIn = useAuthStore((state) => state.signIn);
  const authSignOut = useAuthStore((state) => state.signOut);
  const checkSession = useAuthStore((state) => state.checkSession);
  const clearError = useAuthStore((state) => state.clearError);
  const fetchAllUser = useUserStore((state) => state.fetchAll);
  const clearUserData = useUserStore((state) => state.clearUserData);

  // Sign in with connected wallet - stable reference
  const signIn = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signMessage) {
      throw new Error('Wallet not connected or does not support message signing');
    }

    await authSignIn(wallet.publicKey.toBase58(), wallet.signMessage);
    
    // Start token refresh
    startTokenRefresh();
    
    // Fetch user data after sign in
    await fetchAllUser();
  }, [wallet.publicKey, wallet.signMessage, authSignIn, fetchAllUser]);

  // Sign out - stable reference
  const signOut = useCallback(async () => {
    stopTokenRefresh();
    await authSignOut();
    clearUserData();
  }, [authSignOut, clearUserData]);

  // Auto-restore session when wallet connects (if not already authenticated)
  useEffect(() => {
    if (wallet.connected && wallet.publicKey && !isAuthenticated && !isAuthenticating) {
      // Check if we have a stored session for this wallet
      if (walletAddress === wallet.publicKey.toBase58() && token) {
        // Session exists, validate it
        checkSession();
      }
    }
  }, [wallet.connected, wallet.publicKey, isAuthenticated, isAuthenticating, walletAddress, token, checkSession]);

  // Fetch user data when authenticated
  useEffect(() => {
    if (isAuthenticated && token) {
      fetchAllUser();
    }
  }, [isAuthenticated, token, fetchAllUser]);

  // Clear auth when wallet disconnects
  useEffect(() => {
    if (!wallet.connected && isAuthenticated) {
      signOut();
    }
  }, [wallet.connected, isAuthenticated, signOut]);

  // Connect WebSocket and authenticate when signed in
  useEffect(() => {
    if (isAuthenticated && token) {
      const ws = getWebSocket();
      
      // Connect if not already connected
      if (!ws.isConnected) {
        ws.connect().then(() => {
          // Re-check token as it might have changed during async connect
          const currentToken = useAuthStore.getState().token;
          if (currentToken) {
            ws.authenticate(currentToken);
          }
        }).catch(console.error);
      } else if (!ws.authenticated) {
        ws.authenticate(token);
      }
    }
  }, [isAuthenticated, token]);

  return {
    // Wallet state
    wallet: {
      connected: wallet.connected,
      connecting: wallet.connecting,
      publicKey: wallet.publicKey?.toBase58() || null,
      connect: wallet.connect,
      disconnect: wallet.disconnect,
    },
    // Auth state
    isAuthenticated,
    isAuthenticating,
    error,
    // Actions
    signIn,
    signOut,
    clearError,
  };
}

export function useRequireAuth() {
  const { isAuthenticated, signIn, wallet } = useAuth();

  const requireAuth = useCallback(async <T>(action: () => Promise<T>): Promise<T> => {
    if (!wallet.connected) {
      throw new Error('Please connect your wallet');
    }

    if (!isAuthenticated) {
      await signIn();
    }

    return action();
  }, [isAuthenticated, signIn, wallet.connected]);

  return requireAuth;
}


