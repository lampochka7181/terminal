/**
 * Solana utilities for Degen Terminal
 * Program IDs, PDAs, and constants
 */

import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

// Program ID (update this when deploying to devnet/mainnet)
// Default is the deployed devnet program
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk'
);

// USDC Mint - configurable via env or use default devnet USDC
// Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr = Custom devnet USDC
// EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v = Mainnet USDC
export const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT || 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'
);

// Get USDC mint (for compatibility)
export function getUsdcMint(): PublicKey {
  return USDC_MINT;
}

// Seeds for PDAs
export const SEEDS = {
  GLOBAL_STATE: Buffer.from('global'),
  MARKET: Buffer.from('market'),
  VAULT: Buffer.from('vault'),
  POSITION: Buffer.from('position'),
} as const;

// Constants (matching on-chain program)
export const PRICE_DECIMALS = 6; // $0.50 = 500_000
export const SIZE_DECIMALS = 0;  // Size is raw contract count (no decimals)
export const MIN_PRICE = 10_000;   // $0.01
export const MAX_PRICE = 990_000;  // $0.99
export const TICK_SIZE = 10_000;   // $0.01
export const MIN_SIZE = 1;         // 1 contract (raw count)
export const MAX_SIZE = 100_000;   // 100,000 contracts (raw count)

/**
 * Derive Global State PDA
 */
export function getGlobalStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.GLOBAL_STATE],
    PROGRAM_ID
  );
}

/**
 * Derive Market PDA
 */
export function getMarketPda(
  asset: string,
  timeframe: string,
  expiryTimestamp: number
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      SEEDS.MARKET,
      Buffer.from(asset),
      Buffer.from(timeframe),
      Buffer.from(expiryTimestamp.toString()),
    ],
    PROGRAM_ID
  );
}

/**
 * Derive User Position PDA for a specific market
 */
export function getPositionPda(
  user: PublicKey,
  market: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.POSITION, user.toBuffer(), market.toBuffer()],
    PROGRAM_ID
  );
}

/**
 * Convert dollar price to on-chain format (6 decimals)
 * $0.50 -> 500_000
 */
export function priceToOnChain(price: number): bigint {
  return BigInt(Math.round(price * Math.pow(10, PRICE_DECIMALS)));
}

/**
 * Convert on-chain price to dollars
 * 500_000 -> $0.50
 */
export function priceFromOnChain(price: bigint | number): number {
  return Number(price) / Math.pow(10, PRICE_DECIMALS);
}

/**
 * Convert contract size to on-chain format (6 decimals)
 * 100 contracts -> 100_000_000
 * 1.5 contracts -> 1_500_000
 */
export function sizeToOnChain(size: number): bigint {
  return BigInt(Math.round(size * 1_000_000));
}

/**
 * Convert on-chain size to contracts (from 6 decimals)
 * 100_000_000 -> 100 contracts
 * 1_500_000 -> 1.5 contracts
 */
export function sizeFromOnChain(size: bigint | number): number {
  return Number(size) / 1_000_000;
}

/**
 * Validate price is within bounds and on tick
 */
export function validatePrice(price: number): { valid: boolean; error?: string } {
  if (price < 0.01) {
    return { valid: false, error: 'Price must be at least $0.01' };
  }
  if (price > 0.99) {
    return { valid: false, error: 'Price must be at most $0.99' };
  }
  // Check tick size (must be on $0.01 increments)
  if (Math.round(price * 100) !== price * 100) {
    return { valid: false, error: 'Price must be in $0.01 increments' };
  }
  return { valid: true };
}

/**
 * Validate size is within bounds
 * Supports fractional contracts up to 6 decimal places (matches on-chain SHARE_MULTIPLIER)
 */
export function validateSize(size: number): { valid: boolean; error?: string } {
  if (size < 0.001) {
    return { valid: false, error: 'Size must be at least 0.001 contracts' };
  }
  if (size > 100_000) {
    return { valid: false, error: 'Size must be at most 100,000 contracts' };
  }
  // Check for valid decimal precision (max 6 decimal places)
  const decimalPlaces = (size.toString().split('.')[1] || '').length;
  if (decimalPlaces > 6) {
    return { valid: false, error: 'Size can have at most 6 decimal places' };
  }
  return { valid: true };
}

// Export token program IDs
export { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };

/**
 * Get user's USDC Associated Token Account
 */
export function getUserUsdcAta(user: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(USDC_MINT, user);
}

/**
 * Get market vault's USDC Associated Token Account
 * The vault is owned by the market PDA
 */
export function getMarketVaultAta(market: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(USDC_MINT, market, true);  // allowOwnerOffCurve = true for PDA
}


