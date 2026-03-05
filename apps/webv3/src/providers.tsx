import { type ReactNode, useMemo, useEffect, useRef } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import { getWebSocket } from '@/lib/websocket';
import { startTokenRefresh, stopTokenRefresh, useAuthStore } from '@/stores/authStore';
import { useUserStore } from '@/stores/userStore';

import '@solana/wallet-adapter-react-ui/styles.css';

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
  const walletWasConnected = useRef(false);
  const lastAutoSignInAttempt = useRef<{ wallet: string | null; at: number }>({ wallet: null, at: 0 });

  useEffect(() => {
    const ws = getWebSocket();
    ws.connect().catch(() => {});
    startTokenRefresh();

    return () => {
      stopTokenRefresh();
      if (import.meta.env.PROD) {
        ws.disconnect();
      }
    };
  }, []);

  useEffect(() => {
    if (isAuthenticated && token && token !== lastAuthToken.current) {
      lastAuthToken.current = token;
      hasSignedOut.current = false;
      const ws = getWebSocket();

      if (ws.isConnected) {
        ws.authenticate(token);
      } else {
        ws.connect().then(() => {
          const currentToken = useAuthStore.getState().token;
          if (currentToken && currentToken === token) {
            ws.authenticate(currentToken);
          }
        }).catch(console.error);
      }
    }

    if (!isAuthenticated) {
      lastAuthToken.current = null;
    }
  }, [isAuthenticated, token]);

  // Track when wallet connects so we can distinguish "not yet connected on
  // page load" from "was connected then disconnected".
  useEffect(() => {
    if (wallet.connected) {
      walletWasConnected.current = true;
      hasSignedOut.current = false;
    }
  }, [wallet.connected]);

  // Auto-sign-in when wallet connects but we don't have a valid session yet.
  // On a fresh page load with a persisted session the auth store rehydrates
  // isAuthenticated = true BEFORE the wallet adapter auto-connects, so this
  // effect correctly skips the sign-in flow (the persisted JWT is still valid).
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

  // Sign out only when the wallet was previously connected and then
  // disconnects (real disconnect, not just "hasn't auto-connected yet").
  useEffect(() => {
    if (
      !wallet.connected &&
      !wallet.connecting &&
      isAuthenticated &&
      walletWasConnected.current &&
      !hasSignedOut.current
    ) {
      hasSignedOut.current = true;
      walletWasConnected.current = false;
      stopTokenRefresh();
      signOut();
      clearUserData();
    }
  }, [wallet.connected, wallet.connecting, isAuthenticated, signOut, clearUserData]);

  return <>{children}</>;
}

export function Providers({ children }: { children: ReactNode }) {
  const network = (import.meta.env.VITE_SOLANA_NETWORK as 'devnet' | 'mainnet-beta') || 'devnet';
  const endpoint = import.meta.env.VITE_SOLANA_RPC_URL || clusterApiUrl(network);
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
