'use client';

import { ReactNode, useMemo, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { 
  ConnectionProvider, 
  WalletProvider,
  useWallet
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import { getWebSocket } from '@/lib/websocket';
import { startTokenRefresh, stopTokenRefresh, useAuthStore } from '@/stores/authStore';
import { useUserStore } from '@/stores/userStore';

// Import wallet adapter CSS
import '@solana/wallet-adapter-react-ui/styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 10, // 10 seconds
      refetchOnWindowFocus: false,
    },
  },
});

// Centralized auth state manager
// Handles WebSocket auth and wallet disconnect in ONE place to avoid duplicate calls
function AuthStateManager({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isAuthenticating = useAuthStore((state) => state.isAuthenticating);
  const token = useAuthStore((state) => state.token);
  const prefetchNonce = useAuthStore((state) => state.prefetchNonce);
  const authSignIn = useAuthStore((state) => state.signIn);
  const signOut = useAuthStore((state) => state.signOut);
  const clearUserData = useUserStore((state) => state.clearUserData);
  const lastAuthToken = useRef<string | null>(null);
  const hasSignedOut = useRef(false);
  const lastAutoSignInAttempt = useRef<{ wallet: string | null; at: number }>({ wallet: null, at: 0 });
  
  // Initial WebSocket connection
  useEffect(() => {
    const ws = getWebSocket();
    
    // Connect to WebSocket (auto-reconnect handles failures)
    ws.connect().catch(() => {
      // Initial connection failure is handled by auto-reconnect
    });

    // Start token refresh check
    startTokenRefresh();

    // Cleanup on unmount
    return () => {
      stopTokenRefresh();
      // In React 18 StrictMode (dev), effects mount/unmount twice.
      // Disconnecting the singleton WebSocket during the dev-only teardown causes:
      // "WebSocket is closed before the connection is established."
      if (process.env.NODE_ENV === 'production') {
        ws.disconnect();
      }
    };
  }, []);
  
  // Centralized WebSocket authentication - only runs ONCE when auth state changes
  // This prevents duplicate auth calls from multiple components using useAuth()
  useEffect(() => {
    if (isAuthenticated && token && token !== lastAuthToken.current) {
      lastAuthToken.current = token;
      hasSignedOut.current = false;
      const ws = getWebSocket();
      
      if (ws.isConnected) {
        console.log('[WS Auth] Authenticating WebSocket (centralized)');
        ws.authenticate(token);
      } else {
        // Wait for connection then authenticate
        ws.connect().then(() => {
          const currentToken = useAuthStore.getState().token;
          if (currentToken && currentToken === token) {
            console.log('[WS Auth] Authenticating WebSocket after connect (centralized)');
            ws.authenticate(currentToken);
          }
        }).catch(console.error);
      }
    }
    
    // Clear last token on logout
    if (!isAuthenticated) {
      lastAuthToken.current = null;
    }
  }, [isAuthenticated, token]);
  
  // Centralized auto sign-in:
  // When user selects/connects a wallet and is not authenticated, automatically run SIWS.
  //
  // Implementation detail: we prefetch the nonce first so `signIn()` can call `signMessage()`
  // without first awaiting a network request. This avoids "Unexpected error" in some
  // wallet-standard adapters when signing is invoked after async boundaries.
  useEffect(() => {
    const walletAddress = wallet.publicKey?.toBase58();
    if (!wallet.connected || wallet.connecting || !walletAddress) return;
    if (isAuthenticated || isAuthenticating) return;
    if (!wallet.signMessage) return;

    // Throttle repeated attempts (StrictMode/dev + reconnect storms)
    const now = Date.now();
    if (
      lastAutoSignInAttempt.current.wallet === walletAddress &&
      now - lastAutoSignInAttempt.current.at < 20_000
    ) {
      return;
    }
    lastAutoSignInAttempt.current = { wallet: walletAddress, at: now };

    (async () => {
      await prefetchNonce(walletAddress);

      // Re-check current auth + wallet state before triggering a wallet popup
      const state = useAuthStore.getState();
      if (state.isAuthenticated || state.isAuthenticating) return;
      if (!wallet.connected || wallet.connecting || !wallet.publicKey || !wallet.signMessage) return;

      await authSignIn(walletAddress, wallet.signMessage);
    })().catch(() => {
      // auth store sets error state; keep UI responsive
    });
  }, [
    wallet.connected,
    wallet.connecting,
    wallet.publicKey,
    wallet.signMessage,
    isAuthenticated,
    isAuthenticating,
    prefetchNonce,
    authSignIn,
  ]);

  // Centralized wallet disconnect handling - only runs ONCE when wallet disconnects
  // This prevents multiple signOut calls from different components using useAuth()
  useEffect(() => {
    if (!wallet.connected && isAuthenticated && !hasSignedOut.current) {
      hasSignedOut.current = true;
      console.log('[Auth] Wallet disconnected, signing out (centralized)');
      stopTokenRefresh();
      signOut();
      clearUserData();
    }
  }, [wallet.connected, isAuthenticated, signOut, clearUserData]);

  return <>{children}</>;
}

export function Providers({ children }: { children: ReactNode }) {
  // Configure Solana network
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK as 'devnet' | 'mainnet-beta' || 'devnet';
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl(network);
  // Wallet Standard (including Phantom) is auto-detected by @solana/wallet-adapter-react.
  // Do NOT manually include PhantomWalletAdapter or you'll get:
  // "Phantom was registered as a Standard Wallet. The Wallet Adapter for Phantom can be removed from your app."
  const wallets = useMemo(() => [], []);

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>
            <AuthStateManager>
              {children}
            </AuthStateManager>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
