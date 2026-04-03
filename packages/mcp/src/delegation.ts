/**
 * Auto-delegation module for the MCP server.
 * Checks if the wallet has delegated USDC to the relayer and sets it up if not.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createApproveInstruction,
  getAccount,
} from '@solana/spl-token';
import { getKeypair, getWalletAddress } from './auth.js';
import { api } from './api-client.js';

let relayerAddress: string | null = null;
let usdcMint: string | null = null;
let rpcUrl: string | null = null;
let delegationChecked = false;

/**
 * Fetch platform config to get relayer address and USDC mint.
 */
async function fetchPlatformConfig(): Promise<void> {
  if (relayerAddress && usdcMint) return;

  const config = await api.get<{
    relayerAddress: string;
    usdcMint: string;
    solanaRpcUrl: string;
  }>('/config');

  relayerAddress = config.relayerAddress;
  usdcMint = config.usdcMint;
  rpcUrl = process.env.SOLANA_RPC_URL || config.solanaRpcUrl || 'https://api.devnet.solana.com';
}

/**
 * Check if wallet has delegated USDC to the relayer.
 * Returns the current delegated amount, or 0 if not delegated.
 */
export async function checkDelegation(): Promise<{
  isDelegated: boolean;
  delegatedAmount: number;
  balance: number;
}> {
  await fetchPlatformConfig();

  const keypair = getKeypair();
  if (!keypair || !usdcMint || !relayerAddress) {
    return { isDelegated: false, delegatedAmount: 0, balance: 0 };
  }

  const connection = new Connection(rpcUrl!, 'confirmed');
  const mintPubkey = new PublicKey(usdcMint);
  const ownerPubkey = keypair.publicKey;

  try {
    const ata = await getAssociatedTokenAddress(mintPubkey, ownerPubkey);
    const account = await getAccount(connection, ata);

    const balance = Number(account.amount) / 1_000_000; // USDC has 6 decimals
    const delegatedAmount = account.delegate && account.delegatedAmount
      ? Number(account.delegatedAmount) / 1_000_000
      : 0;
    const isDelegated = account.delegate?.toBase58() === relayerAddress && delegatedAmount > 0;

    return { isDelegated, delegatedAmount, balance };
  } catch {
    // Account doesn't exist or can't be read
    return { isDelegated: false, delegatedAmount: 0, balance: 0 };
  }
}

/**
 * Setup USDC delegation to the relayer.
 * Creates and signs an approve transaction.
 */
export async function setupDelegation(amountUsdc: number): Promise<string> {
  await fetchPlatformConfig();

  const keypair = getKeypair();
  if (!keypair || !usdcMint || !relayerAddress) {
    throw new Error('Delegation setup failed: missing keypair or platform config.');
  }

  const connection = new Connection(rpcUrl!, 'confirmed');
  const mintPubkey = new PublicKey(usdcMint);
  const delegatePubkey = new PublicKey(relayerAddress);
  const ownerPubkey = keypair.publicKey;

  const ata = await getAssociatedTokenAddress(mintPubkey, ownerPubkey);
  const amountLamports = BigInt(Math.floor(amountUsdc * 1_000_000));

  const instruction = createApproveInstruction(
    ata,
    delegatePubkey,
    ownerPubkey,
    amountLamports,
  );

  const transaction = new Transaction().add(instruction);

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [keypair],
    { commitment: 'confirmed' },
  );

  delegationChecked = false; // Reset cache
  return signature;
}

/**
 * Ensure delegation is set up before trading.
 * Returns delegation status info for the MCP tool to communicate to the user.
 */
export async function ensureDelegation(requiredAmount?: number): Promise<{
  ready: boolean;
  message: string;
  balance: number;
  delegatedAmount: number;
}> {
  const status = await checkDelegation();

  if (status.isDelegated && (!requiredAmount || status.delegatedAmount >= requiredAmount)) {
    delegationChecked = true;
    return {
      ready: true,
      message: `Delegation active: $${status.delegatedAmount.toFixed(2)} USDC delegated to relayer.`,
      balance: status.balance,
      delegatedAmount: status.delegatedAmount,
    };
  }

  // Not delegated or insufficient amount
  return {
    ready: false,
    message: status.balance === 0
      ? `No USDC balance found. Please fund your wallet (${getWalletAddress()}) with USDC before trading.`
      : `USDC delegation not set up. Your balance: $${status.balance.toFixed(2)} USDC. Use the setup_delegation tool to authorize trading.`,
    balance: status.balance,
    delegatedAmount: status.delegatedAmount,
  };
}

export function resetDelegationCache(): void {
  delegationChecked = false;
}
