import { eq, sql } from 'drizzle-orm';
import { db, lendingPool, insuranceFund, type LendingPool, type InsuranceFund } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { Keypair, PublicKey, Connection, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, createTransferCheckedInstruction, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import bs58 from 'bs58';

/**
 * Lending Pool Service
 * 
 * Manages the USDC lending pool that provides loans for leveraged positions.
 * Also manages the insurance fund that receives liquidation penalties and covers bad debt.
 */
export class LendingService {
  private lendingKeypair: Keypair | null = null;
  private insuranceKeypair: Keypair | null = null;
  private connection: Connection;
  
  constructor() {
    this.connection = new Connection(config.solanaRpcUrl);
    
    // Initialize lending wallet
    if (config.lendingWalletPrivateKey) {
      try {
        const decoded = bs58.decode(config.lendingWalletPrivateKey);
        this.lendingKeypair = Keypair.fromSecretKey(decoded);
        logger.info(`Lending wallet initialized: ${this.lendingKeypair.publicKey.toBase58()}`);
      } catch (err) {
        logger.error('Failed to initialize lending wallet:', err);
      }
    } else {
      logger.warn('LENDING_WALLET not configured - leverage features disabled');
    }
    
    // Initialize insurance wallet
    if (config.insuranceWalletPrivateKey) {
      try {
        const decoded = bs58.decode(config.insuranceWalletPrivateKey);
        this.insuranceKeypair = Keypair.fromSecretKey(decoded);
        logger.info(`Insurance wallet initialized: ${this.insuranceKeypair.publicKey.toBase58()}`);
      } catch (err) {
        logger.error('Failed to initialize insurance wallet:', err);
      }
    } else {
      logger.warn('INSURANCE_WALLET not configured');
    }
  }
  
  /**
   * Check if leverage is enabled (lending wallet configured)
   */
  isEnabled(): boolean {
    return this.lendingKeypair !== null;
  }
  
  /**
   * Get lending wallet public key
   */
  getLendingWalletPubkey(): PublicKey | null {
    return this.lendingKeypair?.publicKey || null;
  }
  
  /**
   * Get insurance wallet public key
   */
  getInsuranceWalletPubkey(): PublicKey | null {
    return this.insuranceKeypair?.publicKey || null;
  }
  
  /**
   * Get lending wallet keypair (for signing transactions)
   * Only use this for executing leveraged trades from the lending pool
   */
  getLendingKeypair(): Keypair | null {
    return this.lendingKeypair;
  }
  
  /**
   * Get insurance wallet keypair (for signing transactions)
   * Only use for distributing funds from insurance
   */
  getInsuranceKeypair(): Keypair | null {
    return this.insuranceKeypair;
  }
  
  /**
   * Get or create lending pool record
   */
  async getOrCreatePool(): Promise<LendingPool> {
    if (!this.lendingKeypair) {
      throw new Error('Lending wallet not configured');
    }
    
    const walletAddress = this.lendingKeypair.publicKey.toBase58();
    
    // Try to find existing record
    const existing = await db
      .select()
      .from(lendingPool)
      .where(eq(lendingPool.walletAddress, walletAddress))
      .limit(1);
    
    if (existing[0]) {
      return existing[0];
    }
    
    // Create new record
    const [pool] = await db
      .insert(lendingPool)
      .values({
        walletAddress,
        totalDeposited: '0',
        totalLoaned: '0',
        available: '0',
      })
      .returning();
    
    return pool;
  }
  
  /**
   * Get or create insurance fund record
   */
  async getOrCreateInsuranceFund(): Promise<InsuranceFund> {
    if (!this.insuranceKeypair) {
      throw new Error('Insurance wallet not configured');
    }
    
    const walletAddress = this.insuranceKeypair.publicKey.toBase58();
    
    // Try to find existing record
    const existing = await db
      .select()
      .from(insuranceFund)
      .where(eq(insuranceFund.walletAddress, walletAddress))
      .limit(1);
    
    if (existing[0]) {
      return existing[0];
    }
    
    // Create new record
    const [fund] = await db
      .insert(insuranceFund)
      .values({
        walletAddress,
        balance: '0',
        totalReceived: '0',
        totalPaidOut: '0',
      })
      .returning();
    
    return fund;
  }
  
  /**
   * Sync pool balance from on-chain
   * Call periodically to ensure DB matches on-chain state
   */
  async syncPoolBalance(): Promise<{ balance: number; available: number; loaned: number }> {
    if (!this.lendingKeypair) {
      throw new Error('Lending wallet not configured');
    }
    
    const pool = await this.getOrCreatePool();
    
    // Get on-chain USDC balance
    const usdcMint = new PublicKey(config.usdcMint);
    const ata = await getAssociatedTokenAddress(usdcMint, this.lendingKeypair.publicKey);
    
    let onChainBalance = 0;
    try {
      const account = await getAccount(this.connection, ata);
      onChainBalance = Number(account.amount) / 1_000_000; // USDC has 6 decimals
    } catch {
      // ATA doesn't exist yet - balance is 0
      logger.warn('Lending wallet USDC ATA not found - balance is 0');
    }
    
    // Calculate available = on-chain balance - active loans
    const loaned = parseFloat(pool.totalLoaned || '0');
    const available = Math.max(0, onChainBalance - loaned);
    
    // Update DB
    await db
      .update(lendingPool)
      .set({
        totalDeposited: onChainBalance.toString(),
        available: available.toString(),
        updatedAt: new Date(),
      })
      .where(eq(lendingPool.id, pool.id));
    
    return {
      balance: onChainBalance,
      available,
      loaned,
    };
  }
  
  /**
   * Check if a loan can be made
   */
  async canMakeLoan(loanAmount: number, userId?: string): Promise<{ 
    canLoan: boolean; 
    reason?: string;
    available: number;
    maxLoan: number;
  }> {
    if (!this.isEnabled()) {
      return { canLoan: false, reason: 'Leverage not enabled', available: 0, maxLoan: 0 };
    }
    
    const pool = await this.getOrCreatePool();
    const available = parseFloat(pool.available || '0');
    const totalDeposited = parseFloat(pool.totalDeposited || '0');
    
    // Calculate max single loan (default 10% of pool)
    const maxSingleLoan = totalDeposited * config.leverage.maxSingleLoanPct;
    
    // Keep minimum reserve (default 10% of pool)
    const minReserve = totalDeposited * config.leverage.minPoolReservePct;
    const effectiveAvailable = Math.max(0, available - minReserve);
    
    const maxLoan = Math.min(maxSingleLoan, effectiveAvailable);
    
    if (loanAmount > maxLoan) {
      return {
        canLoan: false,
        reason: `Loan amount $${loanAmount.toFixed(2)} exceeds maximum $${maxLoan.toFixed(2)}`,
        available: effectiveAvailable,
        maxLoan,
      };
    }
    
    // TODO: Check user's total exposure if userId provided
    // For v1, we skip per-user exposure limits
    
    return {
      canLoan: true,
      available: effectiveAvailable,
      maxLoan,
    };
  }
  
  /**
   * Record a loan being made (called after on-chain transfer)
   */
  async recordLoan(amount: number): Promise<void> {
    const pool = await this.getOrCreatePool();
    
    await db
      .update(lendingPool)
      .set({
        totalLoaned: sql`${lendingPool.totalLoaned} + ${amount}`,
        available: sql`${lendingPool.available} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(lendingPool.id, pool.id));
    
    logger.info(`Loan recorded: $${amount.toFixed(2)}`);
  }
  
  /**
   * Record a loan repayment (called after on-chain transfer)
   */
  async recordRepayment(amount: number): Promise<void> {
    const pool = await this.getOrCreatePool();
    
    await db
      .update(lendingPool)
      .set({
        totalLoaned: sql`GREATEST(0, ${lendingPool.totalLoaned} - ${amount})`,
        available: sql`${lendingPool.available} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(lendingPool.id, pool.id));
    
    logger.info(`Loan repayment recorded: $${amount.toFixed(2)}`);
  }
  
  /**
   * Record penalty received by insurance fund
   */
  async recordPenalty(amount: number): Promise<void> {
    if (!this.insuranceKeypair) {
      throw new Error('Insurance wallet not configured');
    }
    
    const fund = await this.getOrCreateInsuranceFund();
    
    await db
      .update(insuranceFund)
      .set({
        balance: sql`${insuranceFund.balance} + ${amount}`,
        totalReceived: sql`${insuranceFund.totalReceived} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(insuranceFund.id, fund.id));
    
    logger.info(`Liquidation penalty recorded: $${amount.toFixed(2)}`);
  }
  
  /**
   * Record bad debt covered by insurance fund
   */
  async coverBadDebt(amount: number): Promise<boolean> {
    if (!this.insuranceKeypair) {
      throw new Error('Insurance wallet not configured');
    }
    
    const fund = await this.getOrCreateInsuranceFund();
    const balance = parseFloat(fund.balance || '0');
    
    if (balance < amount) {
      logger.error(`Insurance fund insufficient for bad debt: balance=$${balance.toFixed(2)}, needed=$${amount.toFixed(2)}`);
      return false;
    }
    
    await db
      .update(insuranceFund)
      .set({
        balance: sql`${insuranceFund.balance} - ${amount}`,
        totalPaidOut: sql`${insuranceFund.totalPaidOut} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(insuranceFund.id, fund.id));
    
    logger.info(`Bad debt covered by insurance: $${amount.toFixed(2)}`);
    return true;
  }
  
  /**
   * Get pool status summary
   */
  async getPoolStatus(): Promise<{
    totalDeposited: number;
    totalLoaned: number;
    available: number;
    utilizationPct: number;
  }> {
    const pool = await this.getOrCreatePool();
    const totalDeposited = parseFloat(pool.totalDeposited || '0');
    const totalLoaned = parseFloat(pool.totalLoaned || '0');
    const available = parseFloat(pool.available || '0');
    const utilizationPct = totalDeposited > 0 ? (totalLoaned / totalDeposited) * 100 : 0;
    
    return {
      totalDeposited,
      totalLoaned,
      available,
      utilizationPct,
    };
  }
  
  /**
   * Get insurance fund status
   */
  async getInsuranceStatus(): Promise<{
    balance: number;
    totalReceived: number;
    totalPaidOut: number;
  }> {
    const fund = await this.getOrCreateInsuranceFund();
    
    return {
      balance: parseFloat(fund.balance || '0'),
      totalReceived: parseFloat(fund.totalReceived || '0'),
      totalPaidOut: parseFloat(fund.totalPaidOut || '0'),
    };
  }
  
  /**
   * Collect user's margin and transfer to Lending Pool
   * Uses relayer's delegation authority over user's USDC
   * 
   * This LOCKS the user's margin in the Lending Pool for the duration of the leveraged trade.
   * 
   * @param userWallet - User's wallet public key (string)
   * @param amount - Margin amount in USDC to collect
   * @param relayerKeypair - Relayer keypair (has delegation over user's USDC)
   * @returns Transaction signature or null on failure
   */
  async collectMarginFromUser(
    userWallet: string, 
    amount: number, 
    relayerKeypair: Keypair
  ): Promise<string | null> {
    if (!this.lendingKeypair) {
      logger.error('Cannot collect margin: Lending wallet not configured');
      return null;
    }
    
    if (amount <= 0) {
      logger.info(`No margin to collect: amount is $${amount.toFixed(2)}`);
      return null;
    }
    
    try {
      const usdcMint = new PublicKey(config.usdcMint);
      const userPubkey = new PublicKey(userWallet);
      
      // Get user's USDC ATA
      const userAta = await getAssociatedTokenAddress(
        usdcMint,
        userPubkey
      );
      
      // Get Lending Pool's USDC ATA (create if needed)
      const lendingPoolAta = await getOrCreateAssociatedTokenAccount(
        this.connection,
        relayerKeypair, // Relayer pays for ATA creation if needed
        usdcMint,
        this.lendingKeypair.publicKey
      );
      
      // Convert to lamports (USDC has 6 decimals)
      const amountLamports = BigInt(Math.floor(amount * 1_000_000));
      
      // Create transfer instruction using relayer's delegation authority
      // The relayer is approved to transfer from user's ATA (same as regular trades)
      const transferIx = createTransferCheckedInstruction(
        userAta,                          // Source: User's USDC ATA
        usdcMint,                         // Mint
        lendingPoolAta.address,           // Destination: Lending Pool's USDC ATA
        relayerKeypair.publicKey,         // Authority: Relayer (has delegation)
        amountLamports,                   // Amount
        6                                 // Decimals (USDC = 6)
      );
      
      // Build and send transaction
      const transaction = new Transaction().add(transferIx);
      transaction.feePayer = relayerKeypair.publicKey;
      
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [relayerKeypair],
        { commitment: 'confirmed' }
      );
      
      logger.info(`✅ Collected $${amount.toFixed(2)} margin from user ${userWallet.slice(0, 8)} → Lending Pool: ${signature}`);
      
      return signature;
    } catch (err) {
      logger.error(`Failed to collect margin from user ${userWallet.slice(0, 8)}:`, err);
      return null;
    }
  }
  
  /**
   * Transfer USDC from Lending Pool to a user wallet
   * Used to distribute winnings after leveraged position settlement
   * 
   * @param userWallet - User's wallet public key (string)
   * @param amount - Amount in USDC to transfer
   * @returns Transaction signature or null on failure
   */
  async transferToUser(userWallet: string, amount: number): Promise<string | null> {
    if (!this.lendingKeypair) {
      logger.error('Cannot transfer to user: Lending wallet not configured');
      return null;
    }
    
    if (amount <= 0) {
      logger.info(`No transfer needed: amount is $${amount.toFixed(2)}`);
      return null;
    }
    
    try {
      const usdcMint = new PublicKey(config.usdcMint);
      const userPubkey = new PublicKey(userWallet);
      
      // Get Lending Pool's USDC ATA
      const lendingPoolAta = await getAssociatedTokenAddress(
        usdcMint,
        this.lendingKeypair.publicKey
      );
      
      // Get or create user's USDC ATA
      const userAta = await getOrCreateAssociatedTokenAccount(
        this.connection,
        this.lendingKeypair, // Payer (Lending Pool pays for ATA creation if needed)
        usdcMint,
        userPubkey
      );
      
      // Convert to lamports (USDC has 6 decimals)
      const amountLamports = BigInt(Math.floor(amount * 1_000_000));
      
      // Create transfer instruction
      const transferIx = createTransferCheckedInstruction(
        lendingPoolAta,
        usdcMint,
        userAta.address,
        this.lendingKeypair.publicKey, // Owner/signer
        amountLamports,
        6 // USDC decimals
      );
      
      // Build and send transaction
      const transaction = new Transaction().add(transferIx);
      transaction.feePayer = this.lendingKeypair.publicKey;
      
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.lendingKeypair],
        { commitment: 'confirmed' }
      );
      
      logger.info(`Transferred $${amount.toFixed(2)} USDC from Lending Pool to user ${userWallet.slice(0, 8)}: ${signature}`);
      
      return signature;
    } catch (err) {
      logger.error(`Failed to transfer $${amount.toFixed(2)} to user ${userWallet.slice(0, 8)}:`, err);
      return null;
    }
  }
}

export const lendingService = new LendingService();

