/**
 * Session Service
 * 
 * Manages trading sessions with ephemeral session keys.
 * Users sign once to authorize a session key, then orders can be
 * signed by the session key without wallet popups.
 */

import { logger } from '../lib/logger.js';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

interface Session {
  sessionPublicKey: string;
  walletAddress: string;
  expiresAt: number;
  createdAt: number;
  authSignature: string;
  authMessage: string;
}

// In-memory session store (can be moved to Redis for multi-instance)
const sessions = new Map<string, Session>();

// Cleanup expired sessions periodically
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  let cleaned = 0;
  
  for (const [key, session] of sessions) {
    if (session.expiresAt < now) {
      sessions.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    logger.debug(`[Sessions] Cleaned ${cleaned} expired sessions`);
  }
}, 60 * 1000); // Every minute

/**
 * Create a new trading session
 */
export async function createSession(params: {
  sessionPublicKey: string;
  walletAddress: string;
  expiresAt: number;
  signature: string;
  message: string;
}): Promise<{ success: boolean; error?: string }> {
  const { sessionPublicKey, walletAddress, expiresAt, signature, message } = params;
  
  try {
    // 1. Validate session public key format
    try {
      new PublicKey(sessionPublicKey);
    } catch {
      return { success: false, error: 'Invalid session public key' };
    }
    
    // 2. Validate wallet address format
    let walletPubkey: PublicKey;
    try {
      walletPubkey = new PublicKey(walletAddress);
    } catch {
      return { success: false, error: 'Invalid wallet address' };
    }
    
    // 3. Validate expiry is in the future (but not too far)
    const now = Math.floor(Date.now() / 1000);
    const maxExpiry = now + 7 * 24 * 60 * 60; // Max 7 days
    
    if (expiresAt <= now) {
      return { success: false, error: 'Session expiry must be in the future' };
    }
    
    if (expiresAt > maxExpiry) {
      return { success: false, error: 'Session expiry cannot exceed 7 days' };
    }
    
    // 4. Verify the authorization signature
    // The message should contain the session public key and expiry
    if (!message.includes(sessionPublicKey)) {
      return { success: false, error: 'Authorization message must contain session key' };
    }
    
    try {
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = bs58.decode(signature);
      
      const isValid = nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        walletPubkey.toBytes()
      );
      
      if (!isValid) {
        return { success: false, error: 'Invalid authorization signature' };
      }
    } catch (err) {
      logger.error('[Sessions] Signature verification failed:', err);
      return { success: false, error: 'Signature verification failed' };
    }
    
    // 5. Check if wallet already has an active session - revoke it
    for (const [key, session] of sessions) {
      if (session.walletAddress === walletAddress) {
        sessions.delete(key);
        logger.info(`[Sessions] Revoked existing session for ${walletAddress.slice(0, 8)}...`);
      }
    }
    
    // 6. Store the session
    const session: Session = {
      sessionPublicKey,
      walletAddress,
      expiresAt,
      createdAt: now,
      authSignature: signature,
      authMessage: message,
    };
    
    sessions.set(sessionPublicKey, session);
    
    logger.info(`[Sessions] Created session for ${walletAddress.slice(0, 8)}... expires in ${Math.floor((expiresAt - now) / 3600)}h`);
    
    return { success: true };
    
  } catch (err) {
    logger.error('[Sessions] Failed to create session:', err);
    return { success: false, error: 'Failed to create session' };
  }
}

/**
 * Revoke a session by session public key
 */
export function revokeSession(sessionPublicKey: string): boolean {
  const deleted = sessions.delete(sessionPublicKey);
  
  if (deleted) {
    logger.info(`[Sessions] Revoked session ${sessionPublicKey.slice(0, 8)}...`);
  }
  
  return deleted;
}

/**
 * Revoke all sessions for a wallet
 */
export function revokeAllSessions(walletAddress: string): number {
  let count = 0;
  
  for (const [key, session] of sessions) {
    if (session.walletAddress === walletAddress) {
      sessions.delete(key);
      count++;
    }
  }
  
  if (count > 0) {
    logger.info(`[Sessions] Revoked ${count} sessions for ${walletAddress.slice(0, 8)}...`);
  }
  
  return count;
}

/**
 * Get session info
 */
export function getSession(sessionPublicKey: string): Session | null {
  const session = sessions.get(sessionPublicKey);
  
  if (!session) {
    return null;
  }
  
  // Check if expired
  if (session.expiresAt < Date.now() / 1000) {
    sessions.delete(sessionPublicKey);
    return null;
  }
  
  return session;
}

/**
 * Verify an order signature from a session key
 * Returns the wallet address if valid, null otherwise
 */
export function verifySessionSignature(
  sessionPublicKey: string,
  orderData: Record<string, unknown>,
  signature: string
): { valid: boolean; walletAddress?: string; error?: string } {
  // 1. Get session
  const session = getSession(sessionPublicKey);
  
  if (!session) {
    return { valid: false, error: 'Session not found or expired' };
  }
  
  // 2. Verify signature
  try {
    const message = JSON.stringify(orderData);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = bs58.decode(sessionPublicKey);
    
    const isValid = nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKeyBytes
    );
    
    if (!isValid) {
      return { valid: false, error: 'Invalid order signature' };
    }
    
    return { valid: true, walletAddress: session.walletAddress };
    
  } catch (err) {
    logger.error('[Sessions] Order signature verification failed:', err);
    return { valid: false, error: 'Signature verification failed' };
  }
}

/**
 * Check if a wallet has an active session
 */
export function hasActiveSession(walletAddress: string): boolean {
  const now = Date.now() / 1000;
  
  for (const session of sessions.values()) {
    if (session.walletAddress === walletAddress && session.expiresAt > now) {
      return true;
    }
  }
  
  return false;
}

/**
 * Get session status for a wallet
 */
export function getSessionStatus(walletAddress: string): {
  active: boolean;
  sessionPublicKey?: string;
  expiresAt?: number;
} {
  const now = Date.now() / 1000;
  
  for (const [key, session] of sessions) {
    if (session.walletAddress === walletAddress && session.expiresAt > now) {
      return {
        active: true,
        sessionPublicKey: key,
        expiresAt: session.expiresAt,
      };
    }
  }
  
  return { active: false };
}

export const sessionService = {
  createSession,
  revokeSession,
  revokeAllSessions,
  getSession,
  verifySessionSignature,
  hasActiveSession,
  getSessionStatus,
};

