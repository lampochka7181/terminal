import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { anchorClient, getYesMintPda, getNoMintPda } from '../lib/anchor-client.js';
import { canonicalOrderMessageToBase64 } from '../lib/order-auth.js';
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

// RPC backpressure (429 / timeout) gets its own schedule: rate-limit errors
// are transient by nature, but hammering the RPC with fast retries makes the
// problem worse. Use a longer base delay + jitter + a higher cap so we stay
// within the same overall budget as a normal retry burst but are much gentler.
const RPC_BACKPRESSURE_MAX_RETRIES = 5;
const RPC_BACKPRESSURE_BASE_DELAY_MS = 1_500;
const RPC_BACKPRESSURE_MAX_DELAY_MS = 15_000;

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
  makerOrderType?: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
  takerOrderType?: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
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
  makerSessionPublicKey?: string;
  takerSessionPublicKey?: string;
  // Tokenized shares mint overrides (derived from market if not provided)
  yesMint?: string;
  noMint?: string;
  // Relayer pool: child wallet as fee payer
  feePayerKeypair?: import('@solana/web3.js').Keypair;
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
  buyerOrderType?: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
  sellerOrderType?: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
  buyerClientOrderId?: number;
  sellerClientOrderId?: number;
  buyerExpiryTs?: number;
  sellerExpiryTs?: number;
  buyerSignature?: string;
  sellerSignature?: string;
  buyerMessage?: string;
  sellerMessage?: string;
  buyerSessionPublicKey?: string;
  sellerSessionPublicKey?: string;
  // Tokenized shares mint overrides (derived from market if not provided)
  yesMint?: string;
  noMint?: string;
  // Relayer pool: child wallet as fee payer
  feePayerKeypair?: import('@solana/web3.js').Keypair;
}

interface TransactionResult {
  success: boolean;
  signature?: string;
  pendingConfirmation?: boolean;
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
    let lastBackpressureCode: 'RPC_RATE_LIMITED' | 'RPC_TIMEOUT' | null = null;
    let rpcBackpressureRetries = 0;

    // Loop bounded by MAX_RETRIES, but RPC backpressure errors can extend
    // the loop up to RPC_BACKPRESSURE_MAX_RETRIES additional attempts.
    for (let attempt = 1; attempt <= MAX_RETRIES + RPC_BACKPRESSURE_MAX_RETRIES; attempt++) {
      try {
        // Get user wallet addresses (prefer passed wallets, fall back to lookup)
        const makerWallet = params.makerWallet || (params.makerUserId ? await this.getUserWallet(params.makerUserId) : null);
        const takerWallet = params.takerWallet || (params.takerUserId ? await this.getUserWallet(params.takerUserId) : null);

        if (!makerWallet || !takerWallet) {
          throw new Error(`Could not resolve user wallet addresses: maker=${makerWallet || 'null'}, taker=${takerWallet || 'null'}`);
        }

        const hydratedParams = this.hydrateMatchAuth(params, makerWallet, takerWallet);

        // Execute on-chain match (V2: tokenized shares)
        const marketPubkey = new PublicKey(hydratedParams.marketPubkey);
        const yesMint = hydratedParams.yesMint || getYesMintPda(marketPubkey).toBase58();
        const noMint = hydratedParams.noMint || getNoMintPda(marketPubkey).toBase58();

        logger.info(`[V2] Executing match: ${hydratedParams.matchSize} shares @ $${hydratedParams.price}`);

        const result = await anchorClient.executeMatchV2({
          marketPubkey: hydratedParams.marketPubkey,
          yesMint,
          noMint,
          makerWallet,
          takerWallet,
          makerSide: hydratedParams.makerSide,
          takerSide: hydratedParams.takerSide,
          makerOrderType: hydratedParams.makerOrderType || 'LIMIT',
          takerOrderType: hydratedParams.takerOrderType || 'LIMIT',
          outcome: hydratedParams.outcome,
          price: hydratedParams.price,
          matchSize: hydratedParams.matchSize,
          takerFee: hydratedParams.takerFee,
          makerClientOrderId: hydratedParams.makerClientOrderId,
          takerClientOrderId: hydratedParams.takerClientOrderId,
          makerExpiryTs: hydratedParams.makerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
          takerExpiryTs: hydratedParams.takerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
          makerOrderPda: hydratedParams.makerOrderPda,
          takerOrderPda: hydratedParams.takerOrderPda,
          makerSignature: hydratedParams.makerSignature,
          takerSignature: hydratedParams.takerSignature,
          makerMessage: hydratedParams.makerMessage,
          takerMessage: hydratedParams.takerMessage,
          makerSessionPublicKey: hydratedParams.makerSessionPublicKey,
          takerSessionPublicKey: hydratedParams.takerSessionPublicKey,
          feePayerKeypair: hydratedParams.feePayerKeypair,
        });

        // Persist the submitted signature without over-claiming confirmation.
        await this.handleMatchSuccess(params, result.signature, result.confirmed ? 'CONFIRMED' : 'PENDING');

        return { success: true, signature: result.signature, pendingConfirmation: !result.confirmed };
      } catch (err: any) {
        lastError = err;

        // Check if this is a permanent failure
        const permanentError = this.isPermanentError(err);
        if (permanentError) {
          logger.warn(`Match tx attempt ${attempt} failed (permanent ${permanentError}): ${err.message}`);
          await this.handleMatchFailure(params, err);
          return {
            success: false,
            error: err.message,
            errorCode: permanentError,
          };
        }

        // RPC backpressure (429 / timeout) gets a separate, gentler retry
        // budget so we don't burn through MAX_RETRIES in <2s during a brief
        // rate-limit spike.
        const backpressureCode = this.isRpcBackpressureError(err);
        if (backpressureCode) {
          lastBackpressureCode = backpressureCode;
          rpcBackpressureRetries += 1;
          logger.warn(
            `[RPC_BACKPRESSURE] Match tx attempt ${attempt} hit ${backpressureCode} ` +
            `(backpressure retry ${rpcBackpressureRetries}/${RPC_BACKPRESSURE_MAX_RETRIES}): ${err.message}`
          );

          if (rpcBackpressureRetries > RPC_BACKPRESSURE_MAX_RETRIES) {
            // Exhausted backpressure budget — surface the specific code so
            // UI can show "network congested, please try again" rather than
            // a generic transaction failure.
            await this.handleMatchFailure(params, err);
            return {
              success: false,
              error: err.message,
              errorCode: backpressureCode,
            };
          }

          // Exponential backoff with jitter, capped.
          const raw = RPC_BACKPRESSURE_BASE_DELAY_MS * Math.pow(2, rpcBackpressureRetries - 1);
          const delay = Math.min(raw, RPC_BACKPRESSURE_MAX_DELAY_MS);
          const jitter = Math.floor(Math.random() * 500);
          await this.sleep(delay + jitter);
          continue;
        }

        logger.warn(`Match tx attempt ${attempt} failed: ${err.message}`);

        // Non-backpressure transient error: bounded by MAX_RETRIES.
        const nonBackpressureAttempt = attempt - rpcBackpressureRetries;
        if (nonBackpressureAttempt >= MAX_RETRIES) {
          break;
        }
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, nonBackpressureAttempt - 1);
        await this.sleep(delay);
      }
    }

    // All retries exhausted. Preserve the RPC-backpressure code if the most
    // recent failures were rate-limit / timeout related — this gives the UI
    // the context it needs to render a useful message.
    await this.handleMatchFailure(params, lastError!);
    return {
      success: false,
      error: lastError?.message || 'Max retries exceeded',
      errorCode: lastBackpressureCode ?? 'MAX_RETRIES',
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
    let lastBackpressureCode: 'RPC_RATE_LIMITED' | 'RPC_TIMEOUT' | null = null;
    let rpcBackpressureRetries = 0;

    for (let attempt = 1; attempt <= MAX_RETRIES + RPC_BACKPRESSURE_MAX_RETRIES; attempt++) {
      try {
        const hydratedParams = this.hydrateCloseAuth(params);
        const marketPubkey = new PublicKey(hydratedParams.marketPubkey);
        const yesMint = hydratedParams.yesMint || getYesMintPda(marketPubkey).toBase58();
        const noMint = hydratedParams.noMint || getNoMintPda(marketPubkey).toBase58();

        logger.info(`[V2] Executing close: ${hydratedParams.matchSize} shares @ $${hydratedParams.price}`);

        const result = await anchorClient.executeCloseV2({
          marketPubkey: hydratedParams.marketPubkey,
          yesMint,
          noMint,
          buyerWallet: hydratedParams.buyerWallet,
          sellerWallet: hydratedParams.sellerWallet,
          outcome: hydratedParams.outcome,
          price: hydratedParams.price,
          matchSize: hydratedParams.matchSize,
          takerFee: hydratedParams.takerFee,
          buyerOrderType: hydratedParams.buyerOrderType || 'LIMIT',
          sellerOrderType: hydratedParams.sellerOrderType || 'LIMIT',
          buyerClientOrderId: hydratedParams.buyerClientOrderId || Date.now(),
          sellerClientOrderId: hydratedParams.sellerClientOrderId || Date.now(),
          buyerExpiryTs: hydratedParams.buyerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
          sellerExpiryTs: hydratedParams.sellerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
          buyerSignature: hydratedParams.buyerSignature,
          sellerSignature: hydratedParams.sellerSignature,
          buyerMessage: hydratedParams.buyerMessage,
          sellerMessage: hydratedParams.sellerMessage,
          buyerSessionPublicKey: hydratedParams.buyerSessionPublicKey,
          sellerSessionPublicKey: hydratedParams.sellerSessionPublicKey,
          feePayerKeypair: hydratedParams.feePayerKeypair,
        });

        logger.debug(`Close trade executed on-chain: ${result.signature} (confirmed=${result.confirmed})`);
        
        // Persist the submitted signature without over-claiming confirmation.
        await this.updateCloseTradeSignature(params, result.signature, result.confirmed ? 'CONFIRMED' : 'PENDING');
        
        return { success: true, signature: result.signature, pendingConfirmation: !result.confirmed };
      } catch (err: any) {
        lastError = err;

        const permanentError = this.isPermanentError(err);
        if (permanentError) {
          logger.warn(`Close tx attempt ${attempt} failed (permanent ${permanentError}): ${err.message}`);
          return {
            success: false,
            error: err.message,
            errorCode: permanentError,
          };
        }

        const backpressureCode = this.isRpcBackpressureError(err);
        if (backpressureCode) {
          lastBackpressureCode = backpressureCode;
          rpcBackpressureRetries += 1;
          logger.warn(
            `[RPC_BACKPRESSURE] Close tx attempt ${attempt} hit ${backpressureCode} ` +
            `(backpressure retry ${rpcBackpressureRetries}/${RPC_BACKPRESSURE_MAX_RETRIES}): ${err.message}`
          );

          if (rpcBackpressureRetries > RPC_BACKPRESSURE_MAX_RETRIES) {
            return {
              success: false,
              error: err.message,
              errorCode: backpressureCode,
            };
          }

          const raw = RPC_BACKPRESSURE_BASE_DELAY_MS * Math.pow(2, rpcBackpressureRetries - 1);
          const delay = Math.min(raw, RPC_BACKPRESSURE_MAX_DELAY_MS);
          const jitter = Math.floor(Math.random() * 500);
          await this.sleep(delay + jitter);
          continue;
        }

        logger.warn(`Close tx attempt ${attempt} failed: ${err.message}`);

        const nonBackpressureAttempt = attempt - rpcBackpressureRetries;
        if (nonBackpressureAttempt >= MAX_RETRIES) {
          break;
        }
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, nonBackpressureAttempt - 1);
        await this.sleep(delay);
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Max retries exceeded',
      errorCode: lastBackpressureCode ?? 'MAX_RETRIES',
    };
  }


  /**
   * Handle successful match - update database
   */
  private async handleMatchSuccess(
    params: MatchParams,
    signature: string,
    status: 'PENDING' | 'CONFIRMED'
  ): Promise<void> {
    await this.updateTradeStatus(params.makerOrderId, params.takerOrderId, signature, status);
    logger.info(
      `Match success: market=${params.marketPubkey.slice(0,8)}, size=${params.matchSize}, tx=${signature}, status=${status}`
    );
  }

  /**
   * Update trade transaction status
   */
  private async updateTradeStatus(
    makerOrderId: string,
    takerOrderId: string,
    signature: string,
    status: 'PENDING' | 'CONFIRMED' = 'CONFIRMED'
  ): Promise<void> {
    const updateData = {
      txSignature: signature,
      txStatus: signature.startsWith('sim_') ? 'PENDING' as const : status,
      confirmedAt: signature.startsWith('sim_') || status !== 'CONFIRMED' ? null : new Date(),
    };

    // Skip makerOrderId lookup for synthetic MM orders (they're stored with null makerOrderId)
    const isSyntheticMaker = makerOrderId.startsWith('mm_synth_') || makerOrderId.startsWith('mm_bailout_') || makerOrderId.startsWith('aggregated-mm-');
    
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
  private async updateTradeSignature(
    tradeId: string,
    signature: string,
    status: 'PENDING' | 'CONFIRMED' = 'CONFIRMED'
  ): Promise<void> {
    const updateData = {
      txSignature: signature,
      txStatus: signature.startsWith('sim_') ? 'PENDING' as const : status,
      confirmedAt: signature.startsWith('sim_') || status !== 'CONFIRMED' ? null : new Date(),
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
  private async updateCloseTradeSignature(
    params: CloseParams,
    signature: string,
    status: 'PENDING' | 'CONFIRMED' = 'CONFIRMED'
  ): Promise<void> {
    if (params.tradeId) {
      await this.updateTradeSignature(params.tradeId, signature, status);
    } else if (params.makerOrderId && params.takerOrderId) {
      await this.updateTradeStatus(params.makerOrderId, params.takerOrderId, signature, status);
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
   * Classify an RPC backpressure error (429 / connection rate limit /
   * timeout). Returns a specific error code for backpressure, or null.
   *
   * Backpressure errors are NOT permanent — they should be retried with a
   * longer, jittered backoff. We still surface a distinct error code on
   * exhaustion so the frontend / WS consumer can render a helpful
   * "network congested, try again" message instead of a generic failure.
   */
  private isRpcBackpressureError(error: Error): 'RPC_RATE_LIMITED' | 'RPC_TIMEOUT' | null {
    const message = String(error?.message || '').toLowerCase();

    // HTTP 429 / provider-specific rate-limit messages.
    if (
      message.includes('429') ||
      message.includes('too many requests') ||
      message.includes('connection rate limits exceeded') ||
      message.includes('rate limit') ||
      message.includes('rate-limited') ||
      message.includes('rate limited')
    ) {
      return 'RPC_RATE_LIMITED';
    }

    // Network / timeout errors that should be retried with backoff.
    if (
      message.includes('etimedout') ||
      message.includes('esockettimedout') ||
      message.includes('socket hang up') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('fetch failed') ||
      message.includes('network error') ||
      message.includes('request timed out') ||
      message.includes('blockhash not found')
    ) {
      return 'RPC_TIMEOUT';
    }

    return null;
  }

  /**
   * Check if error is permanent (shouldn't retry)
   */
  private isPermanentError(error: Error): string | null {
    const message = String(error?.message || '').toLowerCase();

    if (message.includes('insufficient funds') || message.includes('insufficient balance')
        || message.includes('"custom":1}')) {  // SPL Token error 0x1 = insufficient funds
      return 'INSUFFICIENT_FUNDS';
    }
    if (message.includes('insufficientshares') || message.includes('insufficient shares') || message.includes('0x178d')) {
      return 'INSUFFICIENT_SHARES';
    }
    if (message.includes('no_sellable_balance')) {
      return 'INSUFFICIENT_SHARES';
    }
    if (message.includes('pending_position_sync')) {
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

  private hydrateMatchAuth(params: MatchParams, makerWallet: string, takerWallet: string): MatchParams {
    const mmKeypair = anchorClient.getMmKeypair();
    const mmWallet = mmKeypair?.publicKey.toBase58();
    if (!mmKeypair || !mmWallet) {
      return params;
    }

    const next = { ...params, makerWallet, takerWallet };

    if (makerWallet === mmWallet && !next.makerOrderPda && (!next.makerSignature || !next.makerMessage)) {
      logger.warn('[TX] Rebuilt missing MM auth proof for maker order');
      const message = canonicalOrderMessageToBase64({
        marketAddress: next.marketPubkey,
        walletAddress: makerWallet,
        signerPublicKey: makerWallet,
        side: next.makerSide,
        outcome: next.outcome,
        orderType: next.makerOrderType || 'LIMIT',
        price: next.price,
        size: next.matchSize,
        expiryTs: next.makerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
        clientOrderId: next.makerClientOrderId,
      });
      next.makerMessage = message;
      next.makerSignature = bs58.encode(
        nacl.sign.detached(Buffer.from(message, 'base64'), mmKeypair.secretKey)
      );
    }

    if (takerWallet === mmWallet && !next.takerOrderPda && (!next.takerSignature || !next.takerMessage)) {
      logger.warn('[TX] Rebuilt missing MM auth proof for taker order');
      const message = canonicalOrderMessageToBase64({
        marketAddress: next.marketPubkey,
        walletAddress: takerWallet,
        signerPublicKey: takerWallet,
        side: next.takerSide,
        outcome: next.outcome,
        orderType: next.takerOrderType || 'LIMIT',
        price: next.price,
        size: next.matchSize,
        expiryTs: next.takerExpiryTs || Math.floor(Date.now() / 1000) + 3600,
        clientOrderId: next.takerClientOrderId,
      });
      next.takerMessage = message;
      next.takerSignature = bs58.encode(
        nacl.sign.detached(Buffer.from(message, 'base64'), mmKeypair.secretKey)
      );
    }

    return next;
  }

  private hydrateCloseAuth(params: CloseParams): CloseParams {
    const mmKeypair = anchorClient.getMmKeypair();
    const mmWallet = mmKeypair?.publicKey.toBase58();
    if (!mmKeypair || !mmWallet) {
      return params;
    }

    const next = { ...params };

    // MM orders are authorized out-of-band and should not carry Ed25519 auth
    // in close txs; otherwise the extra verify ix can push relayed closes over
    // Solana's 1232-byte limit during fast repeated trading.
    if (next.buyerWallet === mmWallet) {
      next.buyerMessage = undefined;
      next.buyerSignature = undefined;
      next.buyerSessionPublicKey = undefined;
    }

    if (next.sellerWallet === mmWallet) {
      next.sellerMessage = undefined;
      next.sellerSignature = undefined;
      next.sellerSessionPublicKey = undefined;
    }

    return next;
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
