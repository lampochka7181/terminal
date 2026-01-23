import { ReactNode, useMemo, useEffect, useRef } from 'react';
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
      if (import.meta.env.PROD) {
        ws.disconnect();
      }
    };
  }, []);

  // Centralized WebSocket authentication - only runs ONCE when auth state changes
  useEffect(() => {
    if (isAuthenticated && token && token !== lastAuthToken.current) {
      lastAuthToken.current = token;
      hasSignedOut.current = false;
      const ws = getWebSocket();

      if (ws.isConnected) {
        console.log('[WS Auth] Authenticating WebSocket (centralized)');
        ws.authenticate(token);
      } else {
        ws.connect().then(() => {
          const currentToken = useAuthStore.getState().token;
          if (currentToken && currentToken === token) {
            console.log('[WS Auth] Authenticating WebSocket after connect (centralized)');
            ws.authenticate(currentToken);
          }
        }).catch(console.error);
      }
    }

    if (!isAuthenticated) {
      lastAuthToken.current = null;
    }
  }, [isAuthenticated, token]);

  // Centralized auto sign-in
  useEffect(() => {
    const walletAddress = wallet.publicKey?.toBase58();
    if (!wallet.connected || wallet.connecting || !walletAddress) return;
    if (isAuthenticated || isAuthenticating) return;
    if (!wallet.signMessage) return;

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
      const state = useAuthStore.getState();
      if (state.isAuthenticated || state.isAuthenticating) return;
      if (!wallet.connected || wallet.connecting || !wallet.publicKey || !wallet.signMessage) return;
      await authSignIn(walletAddress, wallet.signMessage);
    })().catch(() => {});
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

  // Centralized wallet disconnect handling
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
  // Configure Solana network - use Vite env vars
  const network = (import.meta.env.VITE_SOLANA_NETWORK as 'devnet' | 'mainnet-beta') || 'devnet';
  const endpoint = import.meta.env.VITE_SOLANA_RPC_URL || clusterApiUrl(network);

  // Wallet Standard auto-detects wallets like Phantom
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <AuthStateManager>
            {children}
          </AuthStateManager>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
