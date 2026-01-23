/**
 * useDelegation Hook
 * Handles SPL Token delegation for the relayer to execute MARKET orders
 * without requiring on-chain Order PDAs
 */

import { useState, useCallback, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  createApproveInstruction,
  getAccount,
  TokenAccountNotFoundError,
} from '@solana/spl-token';
import { api } from '@/lib/api';
import { USDC_MINT, getUserUsdcAta } from '@/lib/solana';

// Default delegation amount: 10,000 USDC (in smallest units)
const DEFAULT_DELEGATION_AMOUNT = 10_000 * 1_000_000;

export interface UseDelegationReturn {
  // State
  isApproved: boolean;
  isLoading: boolean;
  isApproving: boolean;
  error: string | null;
  relayerAddress: string | null;
  delegatedAmount: number;
  
  // Actions
  checkApproval: () => Promise<void>;
  approve: (amount?: number) => Promise<boolean>;
  revoke: () => Promise<boolean>;
}

export function useDelegation(): UseDelegationReturn {
  const { publicKey, signTransaction, connected } = useWallet();
  const { connection } = useConnection();
  
  const [isApproved, setIsApproved] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relayerAddress, setRelayerAddress] = useState<string | null>(null);
  const [delegatedAmount, setDelegatedAmount] = useState(0);

  // Fetch relayer address on mount
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const config = await api.getConfig();
        setRelayerAddress(config.relayerAddress);
      } catch (err) {
        console.error('Failed to fetch config:', err);
      }
    };
    fetchConfig();
  }, []);

  // Check if user has approved the relayer
  const checkApproval = useCallback(async () => {
    if (!publicKey || !relayerAddress) {
      setIsApproved(false);
      setDelegatedAmount(0);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const userUsdcAta = getUserUsdcAta(publicKey);
      
      try {
        const tokenAccount = await getAccount(connection, userUsdcAta);
        
        // Check if relayer is the delegate
        if (tokenAccount.delegate?.toBase58() === relayerAddress) {
          const amount = Number(tokenAccount.delegatedAmount);
          setDelegatedAmount(amount);
          setIsApproved(amount > 0);
        } else {
          setIsApproved(false);
          setDelegatedAmount(0);
        }
      } catch (err) {
        if (err instanceof TokenAccountNotFoundError) {
          // User doesn't have USDC account yet
          setIsApproved(false);
          setDelegatedAmount(0);
        } else {
          throw err;
        }
      }
    } catch (err) {
      console.error('Failed to check delegation:', err);
      setError('Failed to check delegation status');
    } finally {
      setIsLoading(false);
    }
  }, [publicKey, relayerAddress, connection]);

  // Check approval when wallet connects or relayer address changes
  useEffect(() => {
    if (connected && publicKey && relayerAddress) {
      checkApproval();
    }
  }, [connected, publicKey, relayerAddress, checkApproval]);

  // Approve relayer to spend USDC
  const approve = useCallback(async (amount: number = DEFAULT_DELEGATION_AMOUNT): Promise<boolean> => {
    if (!publicKey || !signTransaction || !relayerAddress) {
      setError('Wallet not connected');
      return false;
    }

    setIsApproving(true);
    setError(null);

    try {
      const userUsdcAta = getUserUsdcAta(publicKey);
      const relayerPubkey = new PublicKey(relayerAddress);

      // Create approve instruction
      const approveIx = createApproveInstruction(
        userUsdcAta,          // Token account
        relayerPubkey,        // Delegate
        publicKey,            // Owner
        BigInt(amount),       // Amount
      );

      // Build transaction
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({
        recentBlockhash: blockhash,
        feePayer: publicKey,
      }).add(approveIx);

      // Sign and send
      const signedTx = await signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      }, 'confirmed');

      console.log('[Delegation] Approved relayer:', signature);
      
      // Update state
      setIsApproved(true);
      setDelegatedAmount(amount);
      
      return true;
    } catch (err) {
      console.error('[Delegation] Failed to approve:', err);
      
      if (err instanceof Error) {
        if (err.message.includes('User rejected')) {
          setError('Transaction rejected');
        } else {
          setError(err.message);
        }
      } else {
        setError('Failed to approve delegation');
      }
      
      return false;
    } finally {
      setIsApproving(false);
    }
  }, [publicKey, signTransaction, relayerAddress, connection]);

  // Revoke delegation
  const revoke = useCallback(async (): Promise<boolean> => {
    if (!publicKey || !signTransaction || !relayerAddress) {
      setError('Wallet not connected');
      return false;
    }

    setIsApproving(true);
    setError(null);

    try {
      const userUsdcAta = getUserUsdcAta(publicKey);
      const relayerPubkey = new PublicKey(relayerAddress);

      // Create approve instruction with 0 amount to revoke
      const revokeIx = createApproveInstruction(
        userUsdcAta,
        relayerPubkey,
        publicKey,
        BigInt(0),
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({
        recentBlockhash: blockhash,
        feePayer: publicKey,
      }).add(revokeIx);

      const signedTx = await signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      }, 'confirmed');

      console.log('[Delegation] Revoked:', signature);
      
      setIsApproved(false);
      setDelegatedAmount(0);
      
      return true;
    } catch (err) {
      console.error('[Delegation] Failed to revoke:', err);
      setError('Failed to revoke delegation');
      return false;
    } finally {
      setIsApproving(false);
    }
  }, [publicKey, signTransaction, relayerAddress, connection]);

  return {
    isApproved,
    isLoading,
    isApproving,
    error,
    relayerAddress,
    delegatedAmount,
    checkApproval,
    approve,
    revoke,
  };
}


