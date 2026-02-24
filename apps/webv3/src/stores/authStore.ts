/**
 * Auth Store - Sign-In With Solana (SIWS)
 * Handles wallet authentication and session management
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, setAuthToken, getAuthToken, ApiError } from '@/lib/api';
import { getWebSocket } from '@/lib/websocket';
import bs58 from 'bs58';

interface AuthState {
  // State
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  walletAddress: string | null;
  token: string | null;
  tokenExpiresAt: number | null;
  error: string | null;
  // Cached auth nonce to keep wallet signing within user gesture
  nonceCache: Record<string, { nonce: string; fetchedAt: number }>;

  // Actions
  prefetchNonce: (walletAddress: string) => Promise<void>;
  signIn: (
    walletAddress: string,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>
  ) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
  checkSession: () => void;
  clearError: () => void;
}

// Lock to prevent concurrent sign-in attempts (Phantom throws "Unexpected error" when racing)
let signInLock: Promise<void> | null = null;

// Nonce caching
const NONCE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const noncePrefetchLocks: Record<string, Promise<void> | undefined> = {};

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      isAuthenticated: false,
      isAuthenticating: false,
      walletAddress: null,
      token: null,
      tokenExpiresAt: null,
      error: null,
      nonceCache: {},

      prefetchNonce: async (walletAddress: string) => {
        const existing = get().nonceCache[walletAddress];
        if (existing && Date.now() - existing.fetchedAt < NONCE_TTL_MS) {
          return;
        }

        if (noncePrefetchLocks[walletAddress]) {
          return noncePrefetchLocks[walletAddress]!;
        }

        noncePrefetchLocks[walletAddress] = (async () => {
          try {
            const { nonce } = await api.getNonce(walletAddress);
            set((state) => ({
              nonceCache: {
                ...state.nonceCache,
                [walletAddress]: { nonce, fetchedAt: Date.now() },
              },
            }));
          } catch (err) {
            console.debug('[Auth] Nonce prefetch failed:', (err as any)?.message || err);
          } finally {
            delete noncePrefetchLocks[walletAddress];
          }
        })();

        return noncePrefetchLocks[walletAddress]!;
      },

      signIn: async (walletAddress, signMessage) => {
        // If already signing in, wait for the existing attempt to complete
        if (signInLock) {
          console.debug('[Auth] Sign-in already in progress, waiting...');
          try {
            await signInLock;
          } catch {
            // Ignore errors from the existing attempt
          }
          // Check if the existing attempt succeeded
          const { isAuthenticated } = get();
          if (isAuthenticated) {
            console.debug('[Auth] Existing sign-in succeeded, skipping new attempt');
            return;
          }
        }
        
        // Create a new lock
        let resolveLock: () => void = () => {};
        signInLock = new Promise<void>((resolve) => {
          resolveLock = resolve;
        });
        
        set({ isAuthenticating: true, error: null });

        try {
          // Wrap in another try-finally to always release lock
          try {
          // Step 1: Get nonce (prefer prefetched nonce so signing stays within user-gesture)
          const cached = get().nonceCache[walletAddress];
          if (!cached || Date.now() - cached.fetchedAt > NONCE_TTL_MS) {
            // Kick off a nonce prefetch for the next click, but don't block here
            get().prefetchNonce(walletAddress).catch(() => {});
            set({
              isAuthenticating: false,
              error: 'Preparing wallet sign-in… please click Sign In again.',
            });
            return;
          }

          const message = cached.nonce;
          const messageBytes = new TextEncoder().encode(message);
          
          let signatureBytes: Uint8Array | null = null;
          let lastError: any = null;
          const MAX_RETRIES = 2;
          
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
              signatureBytes = await signMessage(messageBytes);
              break; // Success, exit retry loop
            } catch (walletError: any) {
              lastError = walletError;
              const errorMsg = walletError?.message || String(walletError);
              
              // User rejected or closed popup - not a retry-able error
              if (errorMsg.includes('User rejected') || 
                  errorMsg.includes('rejected') ||
                  errorMsg.includes('cancelled') ||
                  errorMsg.includes('canceled')) {
                console.log('[Auth] User cancelled sign-in');
                set({ isAuthenticating: false, error: null });
                return; // Silent return, don't throw
              }
              
              // "Unexpected error" is often transient - retry after a delay
              if (errorMsg.includes('Unexpected error') && attempt < MAX_RETRIES - 1) {
                console.warn(`[Auth] Wallet signing failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying...`);
                await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                continue;
              }
              
              // Final attempt failed or non-retryable error
              if (errorMsg.includes('Unexpected error') || 
                  errorMsg.includes('not connected') ||
                  errorMsg.includes('disconnected')) {
                console.warn('[Auth] Wallet signing failed - wallet may not be ready:', errorMsg);
                set({ 
                  isAuthenticating: false, 
                  error: 'Wallet signing failed. Please try again or reconnect your wallet.' 
                });
                return; // Don't throw, just set error state
              }
              
              // Unknown error - throw it
              throw walletError;
            }
          }

          // Nonce is single-use; clear it after any signing attempt
          set((state) => {
            const next = { ...state.nonceCache };
            delete next[walletAddress];
            return { nonceCache: next };
          });
          
          // If we still don't have a signature, return with error
          if (!signatureBytes) {
            console.error('[Auth] All signing attempts failed');
            set({ 
              isAuthenticating: false, 
              error: 'Wallet signing failed after retries. Please reconnect your wallet.' 
            });
            return;
          }
          
          const signature = bs58.encode(signatureBytes);

          // Step 4: Verify signature with server
          const { token, expiresAt } = await api.verifySignature(
            walletAddress,
            signature,
            message
          );

          // Step 5: Store token
          setAuthToken(token);

          // Step 6: Authenticate WebSocket
          const ws = getWebSocket();
          if (ws.isConnected) {
            ws.authenticate(token);
          }

          set({
            isAuthenticated: true,
            isAuthenticating: false,
            walletAddress,
            token,
            tokenExpiresAt: expiresAt,
            error: null,
          });
          } finally {
            // Always release the lock
            signInLock = null;
            resolveLock();
          }
        } catch (error) {
          console.error('[Auth] Sign in failed:', error);
          
          let errorMessage = 'Failed to sign in';
          if (error instanceof ApiError) {
            errorMessage = error.message;
          } else if (error instanceof Error) {
            errorMessage = error.message;
          }

          set({
            isAuthenticated: false,
            isAuthenticating: false,
            error: errorMessage,
          });

          throw error;
        }
      },

      signOut: async () => {
        try {
          const token = getAuthToken();
          if (token) {
            await api.logout();
          }
        } catch (error) {
          console.error('[Auth] Logout request failed:', error);
        } finally {
          setAuthToken(null);
          set({
            isAuthenticated: false,
            walletAddress: null,
            token: null,
            tokenExpiresAt: null,
            error: null,
          });
        }
      },

      refreshSession: async () => {
        const { token, tokenExpiresAt } = get();
        
        if (!token) {
          return;
        }

        // Only refresh if token expires in less than 5 minutes
        const fiveMinutesFromNow = Date.now() / 1000 + 5 * 60;
        if (tokenExpiresAt && tokenExpiresAt > fiveMinutesFromNow) {
          return;
        }

        try {
          const { token: newToken, expiresAt } = await api.refreshToken();
          setAuthToken(newToken);

          // Re-authenticate WebSocket
          const ws = getWebSocket();
          if (ws.isConnected) {
            ws.authenticate(newToken);
          }

          set({
            token: newToken,
            tokenExpiresAt: expiresAt,
          });
        } catch (error) {
          console.error('[Auth] Token refresh failed:', error);
          // If refresh fails, sign out
          get().signOut();
        }
      },

      checkSession: () => {
        const storedToken = getAuthToken();
        const { tokenExpiresAt, walletAddress } = get();

        if (!storedToken) {
          set({ isAuthenticated: false, token: null });
          return;
        }

        // Check if token is expired
        const now = Date.now() / 1000;
        if (tokenExpiresAt && tokenExpiresAt < now) {
          // Token expired, clear session
          setAuthToken(null);
          set({
            isAuthenticated: false,
            token: null,
            tokenExpiresAt: null,
          });
          return;
        }

        // Token is valid
        set({
          isAuthenticated: true,
          token: storedToken,
        });

        // Authenticate WebSocket if connected
        const ws = getWebSocket();
        if (ws.isConnected && storedToken) {
          ws.authenticate(storedToken);
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'degen-auth',
      partialize: (state) => ({
        walletAddress: state.walletAddress,
        token: state.token,
        tokenExpiresAt: state.tokenExpiresAt,
      }),
      onRehydrateStorage: () => (state) => {
        // Check session validity after rehydration
        if (state) {
          state.checkSession();
        }
      },
    }
  )
);

// Auto-refresh token before expiry
let refreshInterval: NodeJS.Timeout | null = null;

export function startTokenRefresh(): void {
  if (refreshInterval) return;

  refreshInterval = setInterval(() => {
    const store = useAuthStore.getState();
    if (store.isAuthenticated) {
      store.refreshSession();
    }
  }, 60 * 1000); // Check every minute
}

export function stopTokenRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}










