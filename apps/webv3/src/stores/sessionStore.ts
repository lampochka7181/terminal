/**
 * Session Store
 * 
 * Manages trading session state globally.
 * Session keys allow instant order signing without wallet popups.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SessionState {
  // Session state
  isActive: boolean;
  sessionPublicKey: string | null;
  expiresAt: number | null;
  
  // Actions
  setSession: (publicKey: string, expiresAt: number) => void;
  clearSession: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      isActive: false,
      sessionPublicKey: null,
      expiresAt: null,
      
      setSession: (publicKey, expiresAt) => set({
        isActive: true,
        sessionPublicKey: publicKey,
        expiresAt,
      }),
      
      clearSession: () => set({
        isActive: false,
        sessionPublicKey: null,
        expiresAt: null,
      }),
    }),
    {
      name: 'degen-session',
      partialize: (state) => ({
        // Only persist these fields
        sessionPublicKey: state.sessionPublicKey,
        expiresAt: state.expiresAt,
        // Note: isActive is recalculated on load based on expiry
      }),
      onRehydrateStorage: () => (state) => {
        // Check if session is still valid after rehydration
        if (state?.expiresAt) {
          const isExpired = state.expiresAt < Date.now() / 1000;
          if (isExpired) {
            state.clearSession();
          } else {
            state.isActive = true;
          }
        }
      },
    }
  )
);

