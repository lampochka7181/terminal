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

  // Actions
  signIn: (
    walletAddress: string,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>
  ) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
  checkSession: () => void;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      isAuthenticated: false,
      isAuthenticating: false,
      walletAddress: null,
      token: null,
      tokenExpiresAt: null,
      error: null,

      signIn: async (walletAddress, signMessage) => {
        set({ isAuthenticating: true, error: null });

        try {
          // Step 1: Get nonce from server
          const { nonce } = await api.getNonce(walletAddress);
          
          // Step 2: Create message to sign
          const message = nonce;
          const messageBytes = new TextEncoder().encode(message);

          // Step 3: Sign message with wallet
          const signatureBytes = await signMessage(messageBytes);
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










