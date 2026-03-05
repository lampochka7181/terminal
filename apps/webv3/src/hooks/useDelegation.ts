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
  createAssociatedTokenAccountInstruction,
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
  checkApproval: () => Promise<boolean>;
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

  // Check if user has approved the relayer. Returns the fresh approval status.
  const checkApproval = useCallback(async (): Promise<boolean> => {
    if (!publicKey || !relayerAddress) {
      setIsApproved(false);
      setDelegatedAmount(0);
      return false;
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
          const approved = amount > 0;
          setIsApproved(approved);
          return approved;
        } else {
          setIsApproved(false);
          setDelegatedAmount(0);
          return false;
        }
      } catch (err) {
        if (err instanceof TokenAccountNotFoundError) {
          setIsApproved(false);
          setDelegatedAmount(0);
          return false;
        } else {
          throw err;
        }
      }
    } catch (err) {
      console.error('Failed to check delegation:', err);
      setError('Failed to check delegation status');
      return false;
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

  // Clear delegation state when wallet disconnects
  useEffect(() => {
    if (!connected) {
      setIsApproved(false);
      setDelegatedAmount(0);
      setError(null);
    }
  }, [connected]);

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

      // Verify ATA exists before building approve instruction
      // If the user has never received USDC, the ATA won't exist on-chain
      // and the Approve instruction would fail with "invalid account data"
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({
        recentBlockhash: blockhash,
        feePayer: publicKey,
      });

      try {
        const tokenAccount = await getAccount(connection, userUsdcAta);
        const balance = Number(tokenAccount.amount);
        if (balance === 0) {
          setError('You have no USDC in your wallet. Please deposit USDC first.');
          return false;
        }
        if (balance < amount) {
          const balanceUsd = (balance / 1_000_000).toFixed(2);
          const requestedUsd = (amount / 1_000_000).toFixed(2);
          setError(`Not enough USDC. You have $${balanceUsd} but tried to delegate $${requestedUsd}.`);
          return false;
        }
      } catch (err) {
        if (err instanceof TokenAccountNotFoundError) {
          // No USDC token account = user has never held USDC
          setError('You have no USDC in your wallet. Please deposit USDC first.');
          return false;
        } else {
          throw err;
        }
      }

      // Create approve instruction
      const approveIx = createApproveInstruction(
        userUsdcAta,          // Token account
        relayerPubkey,        // Delegate
        publicKey,            // Owner
        BigInt(amount),       // Amount
      );

      transaction.add(approveIx);

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
        const msg = err.message.toLowerCase();
        if (msg.includes('user rejected') || msg.includes('rejected')) {
          setError('Transaction rejected');
        } else if (msg.includes('simulation failed') || msg.includes('insufficient') || msg.includes('0x1')) {
          setError('Not enough USDC in your wallet. Please deposit USDC first.');
        } else if (msg.includes('insufficient lamports') || msg.includes('not enough sol')) {
          setError('Not enough SOL for transaction fees.');
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


