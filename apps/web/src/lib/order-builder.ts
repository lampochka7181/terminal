/**
 * Order Builder for Degen Terminal
 * Builds and submits on-chain Solana transactions for order placement
 * 
 * This module implements the trustless order flow where users sign
 * real transactions that create Order PDAs on-chain.
 */

import {
  PublicKey,
  TransactionInstruction,
  Transaction,
  Connection,
  SystemProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getUserUsdcAta,
  getMarketVaultAta,
} from './solana';

// Instruction discriminators (from Anchor IDL)
const CANCEL_ORDER_DISCRIMINATOR = Buffer.from([95, 129, 237, 240, 8, 49, 223, 132]);

/**
 * Build a CancelOrder transaction for existing on-chain orders
 */
export function buildCancelOrderTransaction(
  orderPda: PublicKey,
  owner: PublicKey,
  market: PublicKey,
  recentBlockhash?: string
): Transaction {
  const vault = getMarketVaultAta(market);
  const userUsdc = getUserUsdcAta(owner);
  
  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: userUsdc, isSigner: false, isWritable: true },
      { pubkey: orderPda, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: CANCEL_ORDER_DISCRIMINATOR,
  });
  
  const transaction = new Transaction().add(instruction);
  
  if (recentBlockhash) {
    transaction.recentBlockhash = recentBlockhash;
    transaction.feePayer = owner;
  }
  
  return transaction;
}

/**
 * Build and sign a CancelOrder transaction, then submit to chain
 */
export async function submitCancelOrder(
  orderPda: PublicKey | string,
  owner: PublicKey,
  market: PublicKey | string,
  connection: Connection,
  signTransaction: (transaction: Transaction) => Promise<Transaction>,
): Promise<string> {
  const orderPubkey = typeof orderPda === 'string' ? new PublicKey(orderPda) : orderPda;
  const marketPubkey = typeof market === 'string' ? new PublicKey(market) : market;
  
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transaction = buildCancelOrderTransaction(orderPubkey, owner, marketPubkey, blockhash);
  const signedTransaction = await signTransaction(transaction);
  
  const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  
  await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  }, 'confirmed');
  
  return signature;
}
