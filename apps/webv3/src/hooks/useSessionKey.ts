/**
 * useSessionKey Hook
 * 
 * Implements session-based trading with ephemeral ed25519 keypairs.
 * User signs once to authorize a session key, then all subsequent orders
 * are signed by the session key (no wallet popup per order).
 * 
 * Flow:
 * 1. Generate ephemeral ed25519 keypair in browser
 * 2. User signs authorization: "I authorize [session_pubkey] until [expiry]"
 * 3. Session private key stored in memory (or localStorage if "remember" enabled)
 * 4. Orders signed by session key instantly (no popup)
 * 5. Backend verifies session authorization + order signature
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Keypair } from '@solana/web3.js';
import { useAuthStore } from '@/stores/authStore';
import { useSessionStore } from '@/stores/sessionStore';
import { api } from '@/lib/api';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

// Session duration options (in seconds)
export const SESSION_DURATIONS = {
  SHORT: 60 * 60,           // 1 hour
  MEDIUM: 4 * 60 * 60,      // 4 hours
  LONG: 24 * 60 * 60,       // 24 hours
} as const;

const DEFAULT_SESSION_DURATION = SESSION_DURATIONS.MEDIUM;
const STORAGE_KEY = 'degen-session-key';

interface StoredSession {
  secretKey: string;      // base58 encoded
  publicKey: string;      // base58 encoded
  expiresAt: number;      // unix timestamp
  walletAddress: string;  // owner wallet
}

// Session signer interface for useOrder hook
export interface SessionSigner {
  publicKey: string;
  sign: (orderData: Record<string, unknown>) => string | null;
}

export interface SessionKeyState {
  // State
  isActive: boolean;
  isCreating: boolean;
  publicKey: string | null;
  expiresAt: number | null;
  error: string | null;

  // Session signer object for useOrder hook
  sessionSigner: SessionSigner | undefined;

  // Actions
  createSession: (durationSeconds?: number, remember?: boolean) => Promise<boolean>;
  revokeSession: () => Promise<void>;
  signOrder: (orderData: Record<string, unknown>) => string | null;
  getTimeRemaining: () => number;
}

// Module-level storage for session keypair (shared across all hook instances)
let globalSessionKeypair: Keypair | null = null;

export function useSessionKey(): SessionKeyState {
  const { publicKey: walletPublicKey, signMessage, connected } = useWallet();
  const { isAuthenticated } = useAuthStore();
  
  // Use shared store for session state (read from store, not local state)
  const storeIsActive = useSessionStore((s) => s.isActive);
  const storeSessionPublicKey = useSessionStore((s) => s.sessionPublicKey);
  const storeExpiresAt = useSessionStore((s) => s.expiresAt);
  const setStoreSession = useSessionStore((s) => s.setSession);
  const clearStoreSession = useSessionStore((s) => s.clearSession);
  
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Derived state from store
  const isActive = storeIsActive;
  const sessionPublicKey = storeSessionPublicKey;
  const expiresAt = storeExpiresAt;
  
  // Define clearSession first (used in effects below)
  const clearSession = useCallback(() => {
    globalSessionKeypair = null;
    setError(null);
    localStorage.removeItem(STORAGE_KEY);
    clearStoreSession();
    console.log('[SessionKey] Session cleared');
  }, [clearStoreSession]);
  
  // Track whether the wallet has ever been connected this session
  const hasEverConnected = useRef(false);
  
  // Check for stored session on mount and restore if valid
  useEffect(() => {
    if (!connected || !walletPublicKey) {
      // Only clear session if wallet was previously connected (intentional disconnect),
      // not on initial mount before the wallet adapter auto-reconnects
      if (hasEverConnected.current) {
        clearSession();
      }
      return;
    }
    
    hasEverConnected.current = true;
    
    // If store says session is active but we don't have keypair in memory, try to restore
    if (storeIsActive && !globalSessionKeypair) {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const session: StoredSession = JSON.parse(stored);
          
          // Verify session belongs to current wallet and hasn't expired
          if (session.walletAddress === walletPublicKey.toBase58() && session.expiresAt > Date.now() / 1000) {
            const secretKey = bs58.decode(session.secretKey);
            globalSessionKeypair = Keypair.fromSecretKey(secretKey);
            console.log('[SessionKey] Restored keypair from storage');
          } else {
            // Session invalid, clear it
            localStorage.removeItem(STORAGE_KEY);
            clearStoreSession();
          }
        } else {
          // No stored session, clear store
          clearStoreSession();
        }
      } catch (err) {
        console.error('[SessionKey] Failed to restore session:', err);
        localStorage.removeItem(STORAGE_KEY);
        clearStoreSession();
      }
      return;
    }
    
    // If store says no session, try to restore from localStorage
    if (!storeIsActive) {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return;
        
        const session: StoredSession = JSON.parse(stored);
        
        // Verify session belongs to current wallet
        if (session.walletAddress !== walletPublicKey.toBase58()) {
          localStorage.removeItem(STORAGE_KEY);
          return;
        }
        
        // Verify session hasn't expired
        if (session.expiresAt < Date.now() / 1000) {
          localStorage.removeItem(STORAGE_KEY);
          return;
        }
        
        // Restore session
        const secretKey = bs58.decode(session.secretKey);
        globalSessionKeypair = Keypair.fromSecretKey(secretKey);
        setStoreSession(session.publicKey, session.expiresAt);
        
        console.log('[SessionKey] Restored session from storage');
      } catch (err) {
        console.error('[SessionKey] Failed to restore session:', err);
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  }, [connected, walletPublicKey, storeIsActive, setStoreSession, clearStoreSession, clearSession]);
  
  // Auto-expire session
  useEffect(() => {
    if (!isActive || !expiresAt) return;
    
    const checkExpiry = () => {
      if (expiresAt < Date.now() / 1000) {
        console.log('[SessionKey] Session expired');
        clearSession();
      }
    };
    
    // Check immediately
    checkExpiry();
    
    // Check every 10 seconds
    const interval = setInterval(checkExpiry, 10000);
    return () => clearInterval(interval);
  }, [isActive, expiresAt, clearSession]);
  
  /**
   * Create a new trading session
   * @param durationSeconds - How long the session should last
   * @param remember - Whether to persist session in localStorage
   */
  const createSession = useCallback(async (
    durationSeconds: number = DEFAULT_SESSION_DURATION,
    remember: boolean = true
  ): Promise<boolean> => {
    if (!connected || !walletPublicKey || !signMessage) {
      setError('Wallet not connected');
      return false;
    }
    
    if (!isAuthenticated) {
      setError('Please sign in first');
      return false;
    }
    
    setIsCreating(true);
    setError(null);
    
    try {
      // 1. Generate ephemeral keypair
      const sessionKeypair = Keypair.generate();
      const sessionPubkeyStr = sessionKeypair.publicKey.toBase58();
      const expiry = Math.floor(Date.now() / 1000) + durationSeconds;
      
      // 2. Create authorization message
      const authMessage = `Degen Terminal - Trading Session

I authorize this session key to sign orders on my behalf:

Session Key: ${sessionPubkeyStr}
Valid Until: ${new Date(expiry * 1000).toLocaleString()}
Duration: ${Math.floor(durationSeconds / 3600)} hours

This session can be revoked at any time.`;
      
      // 3. User signs with wallet (this is the ONLY popup)
      const messageBytes = new TextEncoder().encode(authMessage);
      const signatureBytes = await signMessage(messageBytes);
      const signature = bs58.encode(signatureBytes);
      
      // 4. Register session with backend
      await api.createSession({
        sessionPublicKey: sessionPubkeyStr,
        walletAddress: walletPublicKey.toBase58(),
        expiresAt: expiry,
        signature,
        message: authMessage,
      });
      
      // 5. Store session keypair (globally so all hook instances can access it)
      globalSessionKeypair = sessionKeypair;
      setStoreSession(sessionPubkeyStr, expiry);
      
      // 6. Optionally persist to localStorage
      if (remember) {
        const storedSession: StoredSession = {
          secretKey: bs58.encode(sessionKeypair.secretKey),
          publicKey: sessionPubkeyStr,
          expiresAt: expiry,
          walletAddress: walletPublicKey.toBase58(),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(storedSession));
      }
      
      console.log('[SessionKey] Session created:', sessionPubkeyStr);
      return true;
      
    } catch (err) {
      console.error('[SessionKey] Failed to create session:', err);
      
      if (err instanceof Error) {
        if (err.message.includes('User rejected') || err.message.includes('rejected')) {
          setError('Session authorization rejected');
        } else {
          setError(err.message);
        }
      } else {
        setError('Failed to create session');
      }
      
      return false;
    } finally {
      setIsCreating(false);
    }
  }, [connected, walletPublicKey, signMessage, isAuthenticated]);
  
  /**
   * Revoke the current session
   */
  const revokeSession = useCallback(async () => {
    if (sessionPublicKey) {
      try {
        await api.revokeSession(sessionPublicKey);
        console.log('[SessionKey] Session revoked');
      } catch (err) {
        console.warn('[SessionKey] Failed to revoke on server:', err);
      }
    }
    
    clearSession();
  }, [sessionPublicKey, clearSession]);
  
  /**
   * Sign order data with session key
   * Returns base58-encoded signature or null if session not active
   */
  const signOrder = useCallback((orderData: Record<string, unknown>): string | null => {
    console.log('[SessionKey] signOrder called:', { 
      isActive, 
      hasKeypair: !!globalSessionKeypair,
      expiresAt,
      now: Date.now() / 1000 
    });
    
    if (!isActive) {
      console.log('[SessionKey] signOrder: session not active');
      return null;
    }
    
    if (!globalSessionKeypair) {
      console.log('[SessionKey] signOrder: no keypair in memory');
      return null;
    }
    
    // Check expiry
    if (expiresAt && expiresAt < Date.now() / 1000) {
      console.log('[SessionKey] signOrder: session expired');
      clearSession();
      return null;
    }
    
    try {
      // Create deterministic message from order data
      const message = JSON.stringify(orderData);
      const messageBytes = new TextEncoder().encode(message);
      
      // Sign with session key (using global keypair)
      const signature = nacl.sign.detached(
        messageBytes,
        globalSessionKeypair.secretKey
      );
      
      console.log('[SessionKey] signOrder: successfully signed');
      return bs58.encode(signature);
    } catch (err) {
      console.error('[SessionKey] Failed to sign order:', err);
      return null;
    }
  }, [isActive, expiresAt, clearSession]);
  
  /**
   * Get remaining session time in seconds
   */
  const getTimeRemaining = useCallback((): number => {
    if (!expiresAt) return 0;
    return Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  }, [expiresAt]);
  
  // Create sessionSigner object for useOrder hook (only when session is active)
  const sessionSigner: SessionSigner | undefined = isActive && sessionPublicKey ? {
    publicKey: sessionPublicKey,
    sign: signOrder,
  } : undefined;

  return {
    isActive,
    isCreating,
    publicKey: sessionPublicKey,
    expiresAt,
    error,
    sessionSigner,
    createSession,
    revokeSession,
    signOrder,
    getTimeRemaining,
  };
}

