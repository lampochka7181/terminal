import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, Connection } from "@solana/web3.js";
import { 
  createMint, 
  createAssociatedTokenAccount, 
  mintTo,
  getAccount,
  Account,
} from "@solana/spl-token";
import BN from "bn.js";

// Constants
export const USDC_DECIMALS = 6;
export const USDC_MULTIPLIER = 1_000_000;
export const PRICE_DECIMALS = 6;
export const PRICE_MULTIPLIER = 1_000_000;
export const MIN_PRICE = 10_000;      // $0.01
export const MAX_PRICE = 990_000;     // $0.99
export const TICK_SIZE = 10_000;      // $0.01

/**
 * Airdrop SOL to a keypair and wait for confirmation
 */
export async function airdropSol(
  connection: Connection,
  publicKey: PublicKey,
  amount: number = 2 * LAMPORTS_PER_SOL
): Promise<void> {
  const signature = await connection.requestAirdrop(publicKey, amount);
  await connection.confirmTransaction(signature);
}

/**
 * Create a mock USDC mint for testing
 */
export async function createMockUsdcMint(
  connection: Connection,
  payer: Keypair
): Promise<PublicKey> {
  return await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    USDC_DECIMALS
  );
}

/**
 * Create an associated token account and optionally mint tokens
 */
export async function createTokenAccountWithBalance(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  mintAuthority: Keypair,
  amount: number = 0
): Promise<PublicKey> {
  const ata = await createAssociatedTokenAccount(
    connection,
    payer,
    mint,
    owner
  );

  if (amount > 0) {
    await mintTo(
      connection,
      payer,
      mint,
      ata,
      mintAuthority,
      amount
    );
  }

  return ata;
}

/**
 * Get token account balance
 */
export async function getTokenBalance(
  connection: Connection,
  tokenAccount: PublicKey
): Promise<bigint> {
  const account = await getAccount(connection, tokenAccount);
  return account.amount;
}

/**
 * Convert USDC amount to human-readable format
 */
export function usdcToHuman(amount: number | bigint | BN): number {
  if (BN.isBN(amount)) {
    return amount.toNumber() / USDC_MULTIPLIER;
  }
  return Number(amount) / USDC_MULTIPLIER;
}

/**
 * Convert human-readable USDC to raw amount
 */
export function humanToUsdc(amount: number): BN {
  return new BN(Math.floor(amount * USDC_MULTIPLIER));
}

/**
 * Convert price to human-readable format ($0.00 - $1.00)
 */
export function priceToHuman(price: number | BN): number {
  if (BN.isBN(price)) {
    return price.toNumber() / PRICE_MULTIPLIER;
  }
  return price / PRICE_MULTIPLIER;
}

/**
 * Convert human-readable price to raw amount
 */
export function humanToPrice(price: number): BN {
  return new BN(Math.floor(price * PRICE_MULTIPLIER));
}

/**
 * Calculate YES and NO costs for a given price and size
 */
export function calculateCosts(
  price: BN,
  size: BN
): { yesCost: BN; noCost: BN; totalCost: BN } {
  const priceNum = price.toNumber();
  const sizeNum = size.toNumber();
  
  const yesCost = Math.floor((priceNum * sizeNum) / PRICE_MULTIPLIER);
  const noCost = Math.floor(((PRICE_MULTIPLIER - priceNum) * sizeNum) / PRICE_MULTIPLIER);
  
  return {
    yesCost: new BN(yesCost),
    noCost: new BN(noCost),
    totalCost: new BN(yesCost + noCost),
  };
}

/**
 * Calculate taker fee
 */
export function calculateTakerFee(
  notional: BN,
  feeBps: number
): BN {
  return new BN(Math.floor((notional.toNumber() * feeBps) / 10_000));
}

/**
 * Derive Global State PDA
 */
export function deriveGlobalStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    programId
  );
}

/**
 * Derive Market PDA
 */
export function deriveMarketPda(
  programId: PublicKey,
  asset: string,
  timeframe: string,
  expiryTs: BN
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      Buffer.from(asset),
      Buffer.from(timeframe),
      expiryTs.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
}

/**
 * Derive User Position PDA
 */
export function derivePositionPda(
  programId: PublicKey,
  market: PublicKey,
  owner: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), owner.toBuffer()],
    programId
  );
}

/**
 * Generate test order arguments
 */
export interface OrderArgs {
  side: { bid: {} } | { ask: {} };
  outcome: { yes: {} } | { no: {} };
  orderType: { limit: {} } | { market: {} } | { ioc: {} } | { fok: {} };
  price: BN;
  size: BN;
  expiryTs: BN;
  clientOrderId: BN;
}

export function createOrderArgs(
  side: "bid" | "ask",
  outcome: "yes" | "no",
  price: number,    // Human-readable price (0.01 - 0.99)
  size: number,     // Number of contracts
  expirySeconds: number = 3600
): OrderArgs {
  return {
    side: side === "bid" ? { bid: {} } : { ask: {} },
    outcome: outcome === "yes" ? { yes: {} } : { no: {} },
    orderType: { limit: {} },
    price: humanToPrice(price),
    size: new BN(size),
    expiryTs: new BN(Math.floor(Date.now() / 1000) + expirySeconds),
    clientOrderId: new BN(Date.now() + Math.random() * 1000000),
  };
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait for clock to advance (useful for time-based tests)
 */
export async function waitForTimestamp(
  connection: Connection,
  targetTimestamp: number
): Promise<void> {
  while (true) {
    const slot = await connection.getSlot();
    const timestamp = await connection.getBlockTime(slot);
    if (timestamp && timestamp >= targetTimestamp) {
      break;
    }
    await sleep(1000);
  }
}

/**
 * Assert that a transaction throws an expected error
 */
export async function expectError(
  fn: () => Promise<any>,
  expectedError: string
): Promise<void> {
  try {
    await fn();
    throw new Error(`Expected error containing "${expectedError}" but transaction succeeded`);
  } catch (err: any) {
    const errorMessage = err.error?.errorCode?.code || err.message || String(err);
    if (!errorMessage.toLowerCase().includes(expectedError.toLowerCase())) {
      throw new Error(
        `Expected error containing "${expectedError}" but got "${errorMessage}"`
      );
    }
  }
}

/**
 * Format market ID for logging
 */
export function formatMarketId(
  asset: string,
  timeframe: string,
  expiryTs: BN
): string {
  const date = new Date(expiryTs.toNumber() * 1000);
  const time = date.toISOString().slice(11, 16);
  return `${asset}-${timeframe}-${time}`;
}

/**
 * Validate price is within bounds and on tick grid
 */
export function isValidPrice(price: BN): boolean {
  const priceNum = price.toNumber();
  return (
    priceNum >= MIN_PRICE &&
    priceNum <= MAX_PRICE &&
    priceNum % TICK_SIZE === 0
  );
}

/**
 * Generate a unique client order ID
 */
export function generateClientOrderId(): BN {
  return new BN(Date.now() * 1000 + Math.floor(Math.random() * 1000));
}













