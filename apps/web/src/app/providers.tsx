'use client';

import { ReactNode, useMemo, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { 
  ConnectionProvider, 
  WalletProvider 
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { clusterApiUrl } from '@solana/web3.js';
import { getWebSocket } from '@/lib/websocket';
import { startTokenRefresh, stopTokenRefresh } from '@/stores/authStore';

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

// WebSocket initialization component
function WebSocketInitializer({ children }: { children: ReactNode }) {
  useEffect(() => {
    const ws = getWebSocket();
    
    // Connect to WebSocket (auto-reconnect handles failures)
    // Note: Price subscriptions are handled by usePrices hook
    ws.connect().catch(() => {
      // Initial connection failure is handled by auto-reconnect
      // No need to log here as WebSocket service already logs
    });

    // Start token refresh check
    startTokenRefresh();

    // Cleanup on unmount
    return () => {
      stopTokenRefresh();
      ws.disconnect();
    };
  }, []);

  return <>{children}</>;
}

export function Providers({ children }: { children: ReactNode }) {
  // Configure Solana network
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK as 'devnet' | 'mainnet-beta' || 'devnet';
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl(network);
  
  // Configure wallets
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
    ],
    []
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>
            <WebSocketInitializer>
              {children}
            </WebSocketInitializer>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
