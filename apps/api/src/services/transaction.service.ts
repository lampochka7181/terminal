import { PublicKey, Keypair } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { anchorClient, PlaceOrderArgs, getYesMintPda, getNoMintPda } from '../lib/anchor-client.js';
import { orderService } from './order.service.js';
import { userService } from './user.service.js';
import { lendingService } from './lending.service.js';
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
  takerFee: number;  // Fee in USD calculated by fee.service.ts
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
  // V2 tokenized shares (optional - only for V2 markets)
  yesMint?: string;         // YES token mint pubkey
  noMint?: string;          // NO token mint pubkey
  useV2?: boolean;          // Force V2 execution
  // Relayer pool: child wallet as fee payer
  feePayerKeypair?: import('@solana/web3.js').Keypair;
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
  takerFee: number;  // Fee in USD calculated by fee.service.ts
  tradeId?: string;  // Optional trade ID to update with tx signature
  makerOrderId?: string;  // For updating trade by order IDs
  takerOrderId?: string;  // For updating trade by order IDs
  // V2 tokenized shares (optional - only for V2 markets)
  yesMint?: string;         // YES token mint pubkey
  noMint?: string;          // NO token mint pubkey
  useV2?: boolean;          // Force V2 execution
  // Relayer pool: child wallet as fee payer
  feePayerKeypair?: import('@solana/web3.js').Keypair;
}

// Leveraged match params - Lending Pool executes on behalf of user
export interface LeveragedMatchParams {
  marketPubkey: string;
  makerOrderId: string;
  takerOrderId: string;
  makerWallet: string;        // MM wallet (selling)
  userWallet: string;         // User wallet (for tracking, receives position in DB)
  price: number;
  matchSize: number;
  takerFee: number;
  makerSide: 'BID' | 'ASK';
  takerSide: 'BID' | 'ASK';
  outcome: 'YES' | 'NO';
  makerClientOrderId: number;
  takerClientOrderId: number;
  makerExpiryTs?: number;
  takerExpiryTs?: number;
  // Leverage info
  leverage: number;
  marginAmount: number;
  loanAmount: number;
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
      // Anchor client not ready — only allow simulation if explicitly enabled
      if (!config.perfTestMode) {
        logger.error(`[TX] Anchor client not ready and PERF_TEST_MODE is off — rejecting match. This should not happen in production.`);
        return {
          success: false,
          error: 'On-chain client not ready — cannot execute trade',
          errorCode: 'CLIENT_NOT_READY',
        };
      }
      logger.warn(`[SIMULATION] Match: ${params.makerOrderId} x ${params.takerOrderId} - ${params.matchSize} @ ${params.price}`);

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
        let signature: string;

        // Check if V2 mode is enabled (globally or per-request)
        const useV2 = params.useV2 ?? config.useV2;

        if (useV2) {
          // V2: Tokenized shares - mint YES/NO tokens instead of creating Position PDAs
          const marketPubkey = new PublicKey(params.marketPubkey);
          const yesMint = params.yesMint || getYesMintPda(marketPubkey).toBase58();
          const noMint = params.noMint || getNoMintPda(marketPubkey).toBase58();

          logger.info(`[V2] Executing match: ${params.matchSize} shares @ $${params.price}`);

          signature = await anchorClient.executeMatchV2({
            marketPubkey: params.marketPubkey,
            yesMint,
            noMint,
            makerWallet,
            takerWallet,
            makerSide: params.makerSide,
            takerSide: params.takerSide,
            outcome: params.outcome,
            price: params.price,
            matchSize: params.matchSize,
            takerFee: params.takerFee,
            makerClientOrderId: params.makerClientOrderId,
            takerClientOrderId: params.takerClientOrderId,
            makerExpiryTs: params.makerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
            takerExpiryTs: params.takerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
            makerOrderPda: params.makerOrderPda,
            takerOrderPda: params.takerOrderPda,
            feePayerKeypair: params.feePayerKeypair,
          });
        } else {
          // V1: Position PDAs
          signature = await anchorClient.executeMatch({
            marketPubkey: params.marketPubkey,
            makerWallet,
            takerWallet,
            makerSide: params.makerSide,
            takerSide: params.takerSide,
            outcome: params.outcome,
            price: params.price,
            matchSize: params.matchSize,
            takerFee: params.takerFee,  // Tiered fee from fee.service.ts
            makerClientOrderId: params.makerClientOrderId,
            takerClientOrderId: params.takerClientOrderId,
            makerExpiryTs: params.makerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
            takerExpiryTs: params.takerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
            // Order PDAs for user orders (enables trustless escrow)
            makerOrderPda: params.makerOrderPda,
            takerOrderPda: params.takerOrderPda,
            feePayerKeypair: params.feePayerKeypair,
          });
        }

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
   * Execute a LEVERAGED match transaction on Solana
   * 
   * Key difference: The Lending Pool wallet executes the trade on-chain,
   * using its own funds. The position is owned by Lending Pool on-chain,
   * but tracked to the user in the database.
   * 
   * PREREQUISITE: The Lending Pool must have delegation set up to the relayer.
   * Run: npx ts-node apps/api/src/scripts/setup-lending-delegation.ts
   */
  async executeLeveragedMatch(params: LeveragedMatchParams): Promise<TransactionResult> {
    // Get lending pool wallet address
    const lendingWalletPubkey = lendingService.getLendingWalletPubkey();
    if (!lendingWalletPubkey) {
      return {
        success: false,
        error: 'Lending pool not configured',
        errorCode: 'LENDING_NOT_CONFIGURED',
      };
    }

    const lendingPoolWallet = lendingWalletPubkey.toBase58();

    if (!anchorClient.isReady()) {
      if (!config.perfTestMode) {
        logger.error(`[TX] Anchor client not ready and PERF_TEST_MODE is off — rejecting leveraged match.`);
        return {
          success: false,
          error: 'On-chain client not ready — cannot execute leveraged trade',
          errorCode: 'CLIENT_NOT_READY',
        };
      }
      const simSignature = `sim_leveraged_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      logger.warn(`[SIMULATION] Leveraged Match: LendingPool ${lendingPoolWallet.slice(0,8)} buying for user ${params.userWallet.slice(0,8)} - ${params.matchSize} @ ${params.price}`);

      await this.updateTradeStatus(params.makerOrderId, params.takerOrderId, simSignature);

      return {
        success: true,
        signature: simSignature,
      };
    }

    // STEP 1: Collect user's margin and lock it in Lending Pool
    // This ensures we have the user's collateral BEFORE executing the leveraged trade
    const relayerKeypair = anchorClient.getRelayerKeypair();
    if (!relayerKeypair) {
      return {
        success: false,
        error: 'Relayer not configured',
        errorCode: 'RELAYER_NOT_CONFIGURED',
      };
    }
    
    // Collect margin + trading fee from user
    // The fee covers the Lending Pool's on-chain transaction fee (it's the taker)
    const totalToCollect = params.marginAmount + params.takerFee;
    logger.info(`[Leveraged] Step 1: Collecting $${totalToCollect.toFixed(2)} (margin: $${params.marginAmount.toFixed(2)} + fee: $${params.takerFee.toFixed(2)}) from user ${params.userWallet.slice(0,8)} → Lending Pool`);
    
    const marginTxSig = await lendingService.collectMarginFromUser(
      params.userWallet,
      totalToCollect,  // Collect margin + fee
      relayerKeypair
    );
    
    if (!marginTxSig) {
      return {
        success: false,
        error: 'Failed to collect user margin - check delegation is set up',
        errorCode: 'MARGIN_COLLECTION_FAILED',
      };
    }
    
    logger.info(`[Leveraged] Margin collected: ${marginTxSig}`);

    // STEP 2: Execute the leveraged trade
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.info(`[Leveraged] Step 2: Lending Pool ${lendingPoolWallet.slice(0,8)} executing trade for user ${params.userWallet.slice(0,8)}`);
        logger.info(`[Leveraged] ${params.matchSize.toFixed(2)} shares @ $${params.price} (${params.leverage}x leverage, margin: $${params.marginAmount}, loan: $${params.loanAmount})`);

        // Execute the leveraged match - Lending Pool wallet is the taker (buyer)
        // The relayer has delegation authority over Lending Pool's USDC (same as MM)
        const signature = await anchorClient.executeLeveragedMatch({
          marketPubkey: params.marketPubkey,
          makerWallet: params.makerWallet,
          lendingPoolWallet: lendingPoolWallet,
          userWallet: params.userWallet,
          makerSide: params.makerSide,
          takerSide: params.takerSide,
          outcome: params.outcome,
          price: params.price,
          matchSize: params.matchSize,
          takerFee: params.takerFee,
          makerClientOrderId: params.makerClientOrderId,
          takerClientOrderId: params.takerClientOrderId,
          makerExpiryTs: params.makerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
          takerExpiryTs: params.takerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
        });

        // Update database on success
        await this.updateTradeStatus(params.makerOrderId, params.takerOrderId, signature);
        
        logger.info(`[Leveraged] Match success: ${signature}`);

        return { success: true, signature };
      } catch (err: any) {
        lastError = err;
        logger.warn(`Leveraged match tx attempt ${attempt} failed: ${err.message}`);

        // Check if this is a permanent failure
        const permanentError = this.isPermanentError(err);
        if (permanentError) {
          // ROLLBACK: Trade permanently failed - return margin + fee to user
          logger.warn(`[Leveraged] Permanent error after margin collection. Rolling back: returning $${totalToCollect.toFixed(2)} to user ${params.userWallet.slice(0,8)}`);
          
          try {
            const rollbackSig = await lendingService.transferToUser(params.userWallet, totalToCollect);
            if (rollbackSig) {
              logger.info(`[Leveraged] Rollback successful: Tx ${rollbackSig}`);
            } else {
              logger.error(`[Leveraged] CRITICAL: Rollback failed for permanent error! User ${params.userWallet} has $${totalToCollect.toFixed(2)} stuck.`);
            }
          } catch (rollbackErr: any) {
            logger.error(`[Leveraged] CRITICAL: Rollback exception! ${rollbackErr.message}`);
          }
          
          return {
            success: false,
            error: err.message,
            errorCode: permanentError,
          };
        }

        // Wait before retry
        if (attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }

    // ROLLBACK: Trade failed after margin was collected - return margin + fee to user
    logger.warn(`[Leveraged] Trade failed after margin collection. Rolling back: returning $${totalToCollect.toFixed(2)} to user ${params.userWallet.slice(0,8)}`);
    
    try {
      const rollbackSig = await lendingService.transferToUser(params.userWallet, totalToCollect);
      if (rollbackSig) {
        logger.info(`[Leveraged] Rollback successful: $${totalToCollect.toFixed(2)} returned to user. Tx: ${rollbackSig}`);
      } else {
        // Critical: margin stuck in lending pool
        logger.error(`[Leveraged] CRITICAL: Rollback failed! User ${params.userWallet} has $${totalToCollect.toFixed(2)} stuck in lending pool. Manual intervention required.`);
      }
    } catch (rollbackErr: any) {
      logger.error(`[Leveraged] CRITICAL: Rollback exception! User ${params.userWallet} has $${totalToCollect.toFixed(2)} stuck. Error: ${rollbackErr.message}`);
    }

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
      if (!config.perfTestMode) {
        logger.error(`[TX] Anchor client not ready and PERF_TEST_MODE is off — rejecting close trade.`);
        return {
          success: false,
          error: 'On-chain client not ready — cannot execute close trade',
          errorCode: 'CLIENT_NOT_READY',
        };
      }
      const simSignature = `sim_close_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      logger.warn(`[SIMULATION] Close: buyer=${params.buyerWallet} ← seller=${params.sellerWallet} - ${params.matchSize} @ ${params.price}`);

      // Update trade with simulation signature
      await this.updateCloseTradeSignature(params, simSignature);

      return {
        success: true,
        signature: simSignature,
      };
    }

    let lastError: Error | null = null;

    // Check if V2 mode is enabled (globally or per-request)
    const useV2 = params.useV2 ?? config.useV2;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        let signature: string;

        if (useV2) {
          // V2: Tokenized shares - transfer tokens between wallets
          const marketPubkey = new PublicKey(params.marketPubkey);
          const yesMint = params.yesMint || getYesMintPda(marketPubkey).toBase58();
          const noMint = params.noMint || getNoMintPda(marketPubkey).toBase58();

          logger.info(`[V2] Executing close: ${params.matchSize} shares @ $${params.price}`);

          signature = await anchorClient.executeCloseV2({
            marketPubkey: params.marketPubkey,
            yesMint,
            noMint,
            buyerWallet: params.buyerWallet,
            sellerWallet: params.sellerWallet,
            outcome: params.outcome,
            price: params.price,
            matchSize: params.matchSize,
            takerFee: params.takerFee,
            feePayerKeypair: params.feePayerKeypair,
          });
        } else {
          // V1: Position PDAs
          signature = await anchorClient.executeClose({
            marketPubkey: params.marketPubkey,
            buyerWallet: params.buyerWallet,
            sellerWallet: params.sellerWallet,
            outcome: params.outcome,
            price: params.price,
            matchSize: params.matchSize,
            takerFee: params.takerFee,  // Tiered fee from fee.service.ts
            feePayerKeypair: params.feePayerKeypair,
          });
        }

        logger.debug(`Close trade executed on-chain: ${signature}`);
        
        // Update trade with tx signature
        await this.updateCloseTradeSignature(params, signature);
        
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
      if (!config.perfTestMode) {
        logger.error(`[TX] Anchor client not ready and PERF_TEST_MODE is off — rejecting settlement.`);
        return {
          success: false,
          error: 'On-chain client not ready — cannot execute settlement',
          errorCode: 'CLIENT_NOT_READY',
        };
      }
      logger.warn(`[SIMULATION] Settlement: ${params.positionId} → ${params.payout} USDC`);
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
   * Update trade with tx signature by trade ID
   * Used for close transactions where we have the trade ID directly
   */
  private async updateTradeSignature(tradeId: string, signature: string): Promise<void> {
    const updateData = {
      txSignature: signature,
      txStatus: signature.startsWith('sim_') ? 'PENDING' as const : 'CONFIRMED' as const,
      confirmedAt: signature.startsWith('sim_') ? null : new Date(),
    };

    await db
      .update(trades)
      .set(updateData)
      .where(eq(trades.id, tradeId));
    
    logger.debug(`Updated trade ${tradeId} with signature ${signature.slice(0, 16)}...`);
  }

  /**
   * Update close trade with tx signature
   * Uses tradeId if available, otherwise falls back to order IDs
   */
  private async updateCloseTradeSignature(params: CloseParams, signature: string): Promise<void> {
    if (params.tradeId) {
      await this.updateTradeSignature(params.tradeId, signature);
    } else if (params.makerOrderId && params.takerOrderId) {
      await this.updateTradeStatus(params.makerOrderId, params.takerOrderId, signature);
    }
    // If neither is provided, signature won't be saved (legacy code path)
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

    if (message.includes('insufficient funds') || message.includes('insufficient balance')
        || message.includes('"custom":1}')) {  // SPL Token error 0x1 = insufficient funds
      return 'INSUFFICIENT_FUNDS';
    }
    if (message.includes('insufficientshares') || message.includes('insufficient shares') || message.includes('0x178d')) {
      return 'INSUFFICIENT_SHARES';
    }
    if (message.includes('feetoolow') || message.includes('fee too low') || message.includes('0x1773')) {
      return 'FEE_TOO_LOW';
    }
    if (message.includes('position limit')) {
      return 'POSITION_LIMIT';
    }
    if (message.includes('market closed') || message.includes('market not open')
        || message.includes('marketclosing') || message.includes('market is closing') || message.includes('0x1777') || message.includes('"custom":6007')) {
      return 'MARKET_CLOSED';
    }
    if (message.includes('invalid signature')) {
      return 'INVALID_SIGNATURE';
    }
    if (message.includes('self trade')) {
      return 'SELF_TRADE';
    }
    if (message.includes('account not found')) {
      return 'ACCOUNT_NOT_FOUND';
    }
    if (message.includes('insufficient lamports')) {
      return 'INSUFFICIENT_LAMPORTS';
    }
    // Anchor framework errors (3000-3012) — account deserialization, constraint violations, etc.
    // Error format in preflight: {"InstructionError":[N,{"Custom":3003}]}
    if (message.includes('accountdidnotdeserialize') || message.includes('"custom":3003') || message.includes('0xbbb')) {
      return 'ACCOUNT_DESERIALIZATION';
    }
    if (message.includes('accountdidnotserialize') || message.includes('"custom":3004') || message.includes('0xbbc')) {
      return 'ACCOUNT_SERIALIZATION';
    }
    if (message.includes('constraintviolation') || message.includes('a raw constraint was violated') || message.includes('"custom":2000')) {
      return 'CONSTRAINT_VIOLATION';
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
