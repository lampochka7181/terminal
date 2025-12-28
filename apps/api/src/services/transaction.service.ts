import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { anchorClient, PlaceOrderArgs } from '../lib/anchor-client.js';
import { orderService } from './order.service.js';
import { userService } from './user.service.js';
import { db, trades } from '../db/index.js';
import { eq } from 'drizzle-orm';

/**
 * Transaction Service
 * 
 * Handles on-chain transaction submission for:
 * - Execute match (settle trades)
 * - Position settlement (after market resolution)
 * 
 * Uses a relayer wallet to pay for transaction fees and submit
 * user-signed instructions on their behalf.
 */

// Retry settings
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;

// Transaction types
export interface MatchParams {
  marketPubkey: string;
  makerOrderId: string;
  takerOrderId: string;
  // Wallet addresses (preferred - already resolved)
  makerWallet?: string;
  takerWallet?: string;
  // User IDs (fallback - will be resolved to wallets)
  makerUserId?: string;
  takerUserId?: string;
  price: number;
  matchSize: number;
  makerSide: 'BID' | 'ASK';
  takerSide: 'BID' | 'ASK';
  outcome: 'YES' | 'NO';
  makerClientOrderId: number;
  takerClientOrderId: number;
  makerExpiryTs?: number;
  takerExpiryTs?: number;
  // On-chain Order PDAs (for user orders - trustless verification)
  makerOrderPda?: string;   // On-chain Order account (if user order)
  takerOrderPda?: string;   // On-chain Order account (if user order)
  // Legacy: signatures for MM orders (off-chain verification)
  makerSignature?: string;  // Base58 encoded
  takerSignature?: string;  // Base58 encoded
  makerMessage?: string;    // Base64 encoded binary message
  takerMessage?: string;    // Base64 encoded binary message
}

export interface SettlementParams {
  marketPubkey: string;
  userWallet: string;
  positionId: string;
  outcome: 'YES' | 'NO';
  size: number;
  payout: number;
}

export interface CloseParams {
  marketPubkey: string;
  buyerWallet: string;
  sellerWallet: string;
  outcome: 'YES' | 'NO';
  price: number;
  matchSize: number;
}

interface TransactionResult {
  success: boolean;
  signature?: string;
  error?: string;
  errorCode?: string;
}

class TransactionService {
  /**
   * Execute a match transaction on Solana
   */
  async executeMatch(params: MatchParams): Promise<TransactionResult> {
    if (!anchorClient.isReady()) {
      // Simulation mode - just return success without actually submitting
      logger.debug(`[SIMULATION] Match: ${params.makerOrderId} x ${params.takerOrderId} - ${params.matchSize} @ ${params.price}`);
      
      // Update trade status in simulation mode
      await this.updateTradeStatus(params.makerOrderId, params.takerOrderId, `sim_${Date.now()}`);
      
      return {
        success: true,
        signature: `sim_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      };
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Get user wallet addresses (prefer passed wallets, fall back to lookup)
        const makerWallet = params.makerWallet || (params.makerUserId ? await this.getUserWallet(params.makerUserId) : null);
        const takerWallet = params.takerWallet || (params.takerUserId ? await this.getUserWallet(params.takerUserId) : null);

        if (!makerWallet || !takerWallet) {
          throw new Error(`Could not resolve user wallet addresses: maker=${makerWallet || 'null'}, taker=${takerWallet || 'null'}`);
        }

        // Execute on-chain match
        // - User orders: have Order PDAs with escrowed USDC (trustless)
        // - MM orders: no Order PDA, uses delegation for USDC transfer
        const signature = await anchorClient.executeMatch({
          marketPubkey: params.marketPubkey,
          makerWallet,
          takerWallet,
          makerSide: params.makerSide,
          takerSide: params.takerSide,
          outcome: params.outcome,
          price: params.price,
          matchSize: params.matchSize,
          makerClientOrderId: params.makerClientOrderId,
          takerClientOrderId: params.takerClientOrderId,
          makerExpiryTs: params.makerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
          takerExpiryTs: params.takerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
          // Order PDAs for user orders (enables trustless escrow)
          makerOrderPda: params.makerOrderPda,
          takerOrderPda: params.takerOrderPda,
        });

        // Update database on success
        await this.handleMatchSuccess(params, signature);

        return { success: true, signature };
      } catch (err: any) {
        lastError = err;
        logger.warn(`Match tx attempt ${attempt} failed: ${err.message}`);

        // Check if this is a permanent failure
        const permanentError = this.isPermanentError(err);
        if (permanentError) {
          await this.handleMatchFailure(params, err);
          return {
            success: false,
            error: err.message,
            errorCode: permanentError,
          };
        }

        // Wait before retry (exponential backoff)
        if (attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted
    await this.handleMatchFailure(params, lastError!);
    return {
      success: false,
      error: lastError?.message || 'Max retries exceeded',
      errorCode: 'MAX_RETRIES',
    };
  }

  /**
   * Execute a closing trade on Solana
   * (seller sells existing shares to buyer)
   */
  async executeClose(params: CloseParams): Promise<TransactionResult> {
    if (!anchorClient.isReady()) {
      logger.debug(`[SIMULATION] Close: buyer=${params.buyerWallet} ← seller=${params.sellerWallet} - ${params.matchSize} @ ${params.price}`);
      return {
        success: true,
        signature: `sim_close_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      };
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const signature = await anchorClient.executeClose({
          marketPubkey: params.marketPubkey,
          buyerWallet: params.buyerWallet,
          sellerWallet: params.sellerWallet,
          outcome: params.outcome,
          price: params.price,
          matchSize: params.matchSize,
        });

        logger.debug(`Close trade executed on-chain: ${signature}`);
        return { success: true, signature };
      } catch (err: any) {
        lastError = err;
        logger.warn(`Close tx attempt ${attempt} failed: ${err.message}`);

        const permanentError = this.isPermanentError(err);
        if (permanentError) {
          return {
            success: false,
            error: err.message,
            errorCode: permanentError,
          };
        }

        if (attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Max retries exceeded',
      errorCode: 'MAX_RETRIES',
    };
  }

  /**
   * Execute a settlement transaction
   */
  async executeSettlement(params: SettlementParams): Promise<TransactionResult> {
    if (!anchorClient.isReady()) {
      logger.debug(`[SIMULATION] Settlement: ${params.positionId} → ${params.payout} USDC`);
      return {
        success: true,
        signature: `sim_settle_${Date.now()}`,
      };
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const signature = await anchorClient.settlePosition({
          marketPubkey: params.marketPubkey,
          userWallet: params.userWallet,
        });

        return { success: true, signature };
      } catch (err: any) {
        lastError = err;
        
        // PositionAlreadySettled (0x178b = 6027) means another process settled it - treat as success
        if (err.message?.includes('PositionAlreadySettled') || err.message?.includes('0x178b')) {
          logger.debug(`Position ${params.positionId} already settled on-chain, treating as success`);
          return { success: true, signature: 'already_settled' };
        }
        
        logger.warn(`Settlement tx attempt ${attempt} failed: ${err.message}`);

        if (attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Settlement failed',
      errorCode: 'MAX_RETRIES',
    };
  }

  /**
   * Handle successful match - update database
   */
  private async handleMatchSuccess(params: MatchParams, signature: string): Promise<void> {
    await this.updateTradeStatus(params.makerOrderId, params.takerOrderId, signature);
    logger.info(`Match success: market=${params.marketPubkey.slice(0,8)}, size=${params.matchSize}, tx=${signature}`);
  }

  /**
   * Update trade transaction status
   */
  private async updateTradeStatus(makerOrderId: string, takerOrderId: string, signature: string): Promise<void> {
    const updateData = {
      txSignature: signature,
      txStatus: signature.startsWith('sim_') ? 'PENDING' as const : 'CONFIRMED' as const,
      confirmedAt: signature.startsWith('sim_') ? null : new Date(),
    };

    // Skip makerOrderId lookup for synthetic MM orders (they're stored with null makerOrderId)
    const isSyntheticMaker = makerOrderId.startsWith('mm_synth_') || makerOrderId.startsWith('aggregated-mm-');
    
    if (!isSyntheticMaker) {
      // Update trades table by maker order ID
      await db
        .update(trades)
        .set(updateData)
        .where(eq(trades.makerOrderId, makerOrderId));
    }

    // Also update by taker order ID (this is the reliable identifier for synthetic MM trades)
    const isSyntheticTaker = takerOrderId === 'pending' || takerOrderId.startsWith('mm_synth_');
    if (!isSyntheticTaker) {
      await db
        .update(trades)
        .set(updateData)
        .where(eq(trades.takerOrderId, takerOrderId));
    }
  }

  /**
   * Handle failed match
   */
  private async handleMatchFailure(params: MatchParams, error: Error): Promise<void> {
    const errorCode = this.getErrorCode(error);

    // Cancel the taker order (it triggered the match)
    await orderService.cancel(params.takerOrderId, errorCode);

    // If it's a funds issue, mark taker's position for review
    if (errorCode === 'INSUFFICIENT_FUNDS') {
      logger.warn(`Insufficient funds for taker ${params.takerUserId}`);
    }

    logger.error(`Match failed: ${error.message}`, { params, errorCode });
  }

  /**
   * Check if error is permanent (shouldn't retry)
   */
  private isPermanentError(error: Error): string | null {
    const message = error.message.toLowerCase();

    if (message.includes('insufficient funds') || message.includes('insufficient balance')) {
      return 'INSUFFICIENT_FUNDS';
    }
    if (message.includes('position limit')) {
      return 'POSITION_LIMIT';
    }
    if (message.includes('market closed') || message.includes('market not open')) {
      return 'MARKET_CLOSED';
    }
    if (message.includes('invalid signature')) {
      return 'INVALID_SIGNATURE';
    }
    if (message.includes('self trade')) {
      return 'SELF_TRADE';
    }
    if (message.includes('account not found') || message.includes('0x1')) {
      return 'ACCOUNT_NOT_FOUND';
    }

    return null; // Retryable error
  }

  /**
   * Get error code from error
   */
  private getErrorCode(error: Error): string {
    return this.isPermanentError(error) || 'TRANSACTION_FAILED';
  }

  /**
   * Get user's wallet pubkey from user ID
   */
  private async getUserWallet(userId: string): Promise<string | null> {
    const user = await userService.findById(userId);
    return user?.walletAddress || null;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get relayer public key
   */
  getRelayerPublicKey(): string | null {
    return anchorClient.getRelayerPublicKey();
  }

  /**
   * Check if transaction service is ready
   */
  isReady(): boolean {
    return anchorClient.isReady();
  }

  /**
   * Get user's USDC balance
   */
  async getUsdcBalance(wallet: string): Promise<number> {
    return anchorClient.getUsdcBalance(wallet);
  }
}

export const transactionService = new TransactionService();
