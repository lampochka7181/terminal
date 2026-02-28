import { orderbookService, OrderbookOrder } from './orderbook.service.js';
import { orderService } from './order.service.js';
import { positionService } from './position.service.js';
import { marketService } from './market.service.js';
import { userService } from './user.service.js';
import { transactionService, MatchParams, CloseParams, LeveragedMatchParams } from './transaction.service.js';
import { calculateTakerFee, calculateMakerFee } from './fee.service.js';
import { getMarketPda, anchorClient } from '../lib/anchor-client.js';
import { db, trades, type NewTrade } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { logger, tradeLogger, orderLogger, logEvents } from '../lib/logger.js';
import { broadcastOrderbookUpdate, broadcastTrade, broadcastGlobalTrade, broadcastUserFill } from '../lib/broadcasts.js';
import { config } from '../config.js';
import { onchainSubmitQueue } from '../queue/queues.js';
import { mmBotV2 } from '../bot/mm-bot-v2.js';
import { lendingService } from './lending.service.js';
import { marginService } from './margin.service.js';
import { writeBehindService } from './write-behind.service.js';
import { randomUUID } from 'crypto';

// Get MM bot user ID
function getMMUserId(): string | null {
  return mmBotV2.getStatus().userId;
}

/**
 * Matching Engine Service
 * 
 * Implements price-time priority matching:
 * 1. Match at best available price
 * 2. Among orders at same price, match oldest first (FIFO)
 * 
 * Key Rules:
 * - Self-trade prevention: User can't match against their own orders
 * - Price-time priority: Best price first, then oldest order
 * - Partial fills: Orders can be partially filled
 * - Market orders: Use extreme prices (0.99 for BID, 0.01 for ASK) to guarantee matching
 * 
 * Performance Optimization (v2):
 * - On-chain execution happens IMMEDIATELY after Redis matching
 * - DB updates (trades, positions, stats) run in BACKGROUND
 * - Batch operations reduce 110+ queries to ~10 queries per order
 */

export interface MatchResult {
  matched: boolean;
  fills: Fill[];
  remainingSize: number;
  error?: string;
}

export interface Fill {
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
  price: number;
  size: number;
  outcome: 'YES' | 'NO';
  makerFee: number;
  takerFee: number;
  makerSide: 'BID' | 'ASK';
  takerSide: 'BID' | 'ASK';
  makerClientOrderId: number;
  takerClientOrderId: number;
  // For on-chain order verification
  makerOrderPda?: string;  // On-chain Order PDA for maker (if user order)
  takerOrderPda?: string;  // On-chain Order PDA for taker (if user order)
  // Legacy: signatures for off-chain orders (MM bot)
  makerSignature?: string;
  takerSignature?: string;
  makerMessage?: string;
  takerMessage?: string;
  // Leverage fields (for leveraged orders executed from Lending Pool)
  leverage?: number;         // 1 = no leverage, 2-10 = leveraged
  marginAmount?: number;     // User's margin amount
  loanAmount?: number;       // Loan amount from lending pool
  // Leveraged close: on-chain shares are owned by Lending Pool, not user
  isLeveragedClose?: boolean;
}

// Fee configuration - Now uses tiered fee service from fee.service.ts
// Legacy constant kept for backward compatibility in some calculations
const MAKER_FEE_BPS = config.makerFeeBps;

/**
 * Calculate fees for a fill based on notional value
 * Uses tiered fee structure from fee.service.ts
 */
function calculateFillFees(notional: number): { makerFee: number; takerFee: number } {
  const makerFeeCalc = calculateMakerFee(notional);
  const takerFeeCalc = calculateTakerFee(notional);
  return {
    makerFee: makerFeeCalc.fee,
    takerFee: takerFeeCalc.fee,
  };
}

// Legacy helper for places still using BPS directly (to be migrated)
const TAKER_FEE_BPS = config.fees.tier4Bps; // Use lowest tier as fallback

/**
 * Parameters for dollar-based MARKET orders
 * Walk the book until dollarAmount is exhausted or maxPrice is reached
 */
export interface DollarMarketOrder {
  marketId: string;
  userId: string;
  side: 'BID' | 'ASK';
  outcome: 'YES' | 'NO';
  dollarAmount: number;   // Total USD to spend
  maxPrice: number;       // Price protection limit
  clientOrderId?: number;
  expiresAt?: number;
  // For on-chain verification (user's signed authorization)
  signature?: string;
  binaryMessage?: string;
  // Leverage fields (for leveraged orders)
  leverage?: number;       // 1 = no leverage, 2-10 = leveraged
  marginAmount?: number;   // User's margin amount
  loanAmount?: number;     // Loan from lending pool
}

export interface DollarMatchResult {
  orderId: string;
  fills: Fill[];
  totalSpent: number;
  totalContracts: number;
  avgPrice: number;
  unfilledDollars: number;
  totalTakerFees: number;
  upfrontFee: number;
  dollarAmount: number;
}

/**
 * Parameters for sell orders (user selling existing shares)
 */
export interface SellOrder {
  marketId: string;
  userId: string;
  outcome: 'YES' | 'NO';
  size: number;           // Number of contracts to sell
  minPrice: number;       // Price floor (won't sell below this)
  clientOrderId?: number;
  expiresAt?: number;
  // For on-chain verification (user's signed authorization)
  signature?: string;
  binaryMessage?: string;
  // Leveraged position close: on-chain shares are owned by Lending Pool
  isLeveragedClose?: boolean;
}

export interface SellMatchResult {
  orderId: string;
  fills: Fill[];
  totalProceeds: number;
  totalSold: number;
  avgPrice: number;
  remainingSize: number;
}

/**
 * Parameters for delegated LIMIT orders (no on-chain Order PDA)
 */
export interface LimitOrder {
  marketId: string;
  userId: string;
  side: 'BID' | 'ASK';
  outcome: 'YES' | 'NO';
  price: number;
  size: number;
  clientOrderId?: number;
  expiresAt?: number;
  // For on-chain verification (user's signed authorization)
  signature?: string;
  binaryMessage?: string;
  // Leverage fields (for leveraged orders)
  leverage?: number;       // 1 = no leverage, 2-10 = leveraged
  marginAmount?: number;   // User's margin amount
  loanAmount?: number;     // Loan from lending pool
}

export interface LimitMatchResult {
  orderId: string;
  fills: Fill[];
  filledSize: number;
  remainingSize: number;
  status: 'open' | 'partial' | 'filled';
}

export class MatchingService {
  /**
   * Semaphore to limit concurrent background DB processing.
   * Prevents 50+ concurrent processFillsInBackground calls from
   * overwhelming the DB connection pool (25 connections).
   */
  private bgDbConcurrency = 0;
  // In perf mode, allow only 3 concurrent background DB tasks (trade inserts only)
  // to leave pool capacity for write-behind + on-chain workers.
  // Normal mode: 10 (includes position/stats updates).
  private readonly MAX_BG_DB_CONCURRENCY = config.perfTestMode ? 3 : 10;
  private bgDbQueue: Array<() => void> = [];

  private async acquireBgDbSlot(): Promise<void> {
    if (this.bgDbConcurrency < this.MAX_BG_DB_CONCURRENCY) {
      this.bgDbConcurrency++;
      return;
    }
    // Wait for a slot to open
    return new Promise<void>(resolve => {
      this.bgDbQueue.push(resolve);
    });
  }

  private releaseBgDbSlot(): void {
    this.bgDbConcurrency--;
    const next = this.bgDbQueue.shift();
    if (next) {
      this.bgDbConcurrency++;
      next();
    }
  }

  /**
   * Opt-in perf logging for matching loops.
   * Enable with: PERF_MATCHING_LOGS=true
   */
  private matchingPerfEnabled(): boolean {
    return String(process.env.PERF_MATCHING_LOGS || '').toLowerCase() === 'true';
  }

  private async safeZcard(key: string): Promise<number | null> {
    try {
      // Lazy import to avoid adding redis dependency plumbing here
      const { redis } = await import('../db/redis.js');
      return await redis.zcard(key);
    } catch {
      return null;
    }
  }

  /**
   * Helper to check if a user is the Market Maker bot (supports both v1 and v2)
   */
  private isMarketMaker(userId: string): boolean {
    const mmUserId = getMMUserId();
    return userId === mmUserId;
  }

  /**
   * When MM order persistence is disabled, MM orders do not exist in Postgres.
   * Any foreign keys to `orders.id` must therefore be NULL for the MM side.
   */
  private tradeOrderIdForDb(userId: string, orderId: string): string | null {
    if (config.disableMmOrderPersistence && this.isMarketMaker(userId)) {
      return null;
    }
    return orderId;
  }

  private toWsSide(side: string): 'bid' | 'ask' {
    return String(side).toUpperCase() === 'BID' ? 'bid' : 'ask';
  }

  private toWsOutcome(outcome: string): 'yes' | 'no' {
    return String(outcome).toUpperCase() === 'YES' ? 'yes' : 'no';
  }

  /**
   * Aggregate multiple fills for the same taker order against the Market Maker.
   * This reduces on-chain gas costs by settling multiple logical fills as one physical match.
   */
  private aggregateMmFills(fills: Fill[]): Fill[] {
    if (fills.length <= 1) return fills;

    const result: Fill[] = [];
    // Group fills by (takerOrderId + makerUserId)
    // We only aggregate if makerUserId is the Market Maker
    const mmFillsByTaker = new Map<string, Fill[]>();
    
    for (const fill of fills) {
      if (this.isMarketMaker(fill.makerUserId)) {
        const key = `${fill.takerOrderId}`;
        if (!mmFillsByTaker.has(key)) mmFillsByTaker.set(key, []);
        mmFillsByTaker.get(key)!.push(fill);
      } else {
        // Non-MM fills are never aggregated
        result.push(fill);
      }
    }

    // Process aggregated MM fills
    for (const [takerOrderId, takerFills] of mmFillsByTaker) {
      if (takerFills.length === 1) {
        result.push(takerFills[0]);
        continue;
      }

      // Calculate weighted average price
      let totalSize = 0;
      let totalWeightedPrice = 0;
      let totalTakerFee = 0;
      let totalMakerFee = 0;

      for (const f of takerFills) {
        totalSize += f.size;
        totalWeightedPrice += f.price * f.size;
        totalTakerFee += f.takerFee;
        totalMakerFee += f.makerFee;
      }

      const avgPrice = totalWeightedPrice / totalSize;
      
      // Create aggregate fill
      const first = takerFills[0];
      result.push({
        ...first,
        price: avgPrice,
        size: totalSize,
        takerFee: totalTakerFee,
        makerFee: totalMakerFee,
        // Mark as aggregated for logging/debugging if needed
        makerOrderId: `aggregated-mm-${takerOrderId}`,
      });

      logger.debug(
        `Aggregated ${takerFills.length} MM fills for taker order ${takerOrderId}: ` +
        `${totalSize.toFixed(2)} @ avg ${avgPrice.toFixed(4)}`
      );
    }

    return result;
  }

  /**
   * Check how much of an order can be filled without modifying state
   * Used for FOK order validation
   */
  async getAvailableMatchSize(takerOrder: OrderbookOrder): Promise<number> {
    const matchSide = takerOrder.side === 'BID' ? 'ASK' : 'BID';
    const isMarketOrder = takerOrder.orderType === 'MARKET';
    const effectivePrice = isMarketOrder
      ? (takerOrder.side === 'BID' ? 0.99 : 0.01)
      : takerOrder.price;
    
    // Get all orders on the opposing side
    const snapshot = await orderbookService.getSnapshot(takerOrder.marketId, takerOrder.outcome);
    const opposingLevels = matchSide === 'ASK' ? snapshot.asks : snapshot.bids;
    
    let availableSize = 0;
    
    for (const level of opposingLevels) {
      // Check if price would cross
      const pricesCross = takerOrder.side === 'BID'
        ? effectivePrice >= level.price
        : effectivePrice <= level.price;
      
      if (!pricesCross) break;
      
      availableSize += level.size;
      
      if (availableSize >= takerOrder.remainingSize) {
        return takerOrder.remainingSize;
      }
    }
    
    return availableSize;
  }

  /**
   * Try to match an incoming order against the orderbook
   * 
   * @param takerOrder The incoming order to match
   * @returns Match result with fills
   */
  async matchOrder(takerOrder: OrderbookOrder): Promise<MatchResult> {
    const fills: Fill[] = [];
    let remainingSize = takerOrder.remainingSize;
    
    // SINGLE ORDERBOOK MODEL: Transform NO orders to match against YES orderbook
    // Same rules as matchMarketOrderByDollar: YES=opposite, NO=same
    const isNoOrder = takerOrder.outcome === 'NO';
    const effectiveOutcome: 'YES' | 'NO' = 'YES';
    
    // Side transformation: YES=opposite, NO=same
    let matchSide: 'BID' | 'ASK';
    if (isNoOrder) {
      matchSide = takerOrder.side;
    } else {
      matchSide = takerOrder.side === 'BID' ? 'ASK' : 'BID';
    }
    
    // For MARKET orders, use extreme prices to guarantee matching
    // BID (buy) uses 0.99 to match any ask
    // ASK (sell) uses 0.01 to match any bid
    const isMarketOrder = takerOrder.orderType === 'MARKET';
    const effectivePrice = isMarketOrder
      ? (takerOrder.side === 'BID' ? 0.99 : 0.01)
      : takerOrder.price;
    
    logger.debug(
      `Matching ${takerOrder.side} ${takerOrder.outcome} ${takerOrder.orderType || 'LIMIT'} order for ` +
      `${takerOrder.remainingSize} @ ${takerOrder.price} (effective: ${effectivePrice})` +
      (isNoOrder ? ` [matching YES ${matchSide}s]` : '')
    );
    
    while (remainingSize > 0) {
      // Get best opposing order from YES orderbook
      const bestOrder = matchSide === 'ASK'
        ? await orderbookService.getBestAsk(takerOrder.marketId, effectiveOutcome)
        : await orderbookService.getBestBid(takerOrder.marketId, effectiveOutcome);
      
      if (!bestOrder) {
        logger.debug('No opposing orders in book');
        break;
      }
      
      // SINGLE ORDERBOOK MODEL: Calculate user's effective price
      // For NO orders, the user's price is the complement of the YES order price
      const userEffectivePrice = isNoOrder ? (1 - bestOrder.price) : bestOrder.price;
      
      // Check if prices cross using user's effective price
      // For market orders, use extreme price (0.99 for BID, 0.01 for ASK) to guarantee crossing
      const pricesCross = takerOrder.side === 'BID'
        ? effectivePrice >= userEffectivePrice  // Buyer willing to pay >= seller asking
        : effectivePrice <= userEffectivePrice; // Seller willing to accept <= buyer bidding
      
      if (!pricesCross) {
        logger.debug(`Prices don't cross: taker ${effectivePrice} vs maker ${userEffectivePrice}`);
        break;
      }
      
      // Self-trade prevention
      if (bestOrder.userId === takerOrder.userId) {
        logger.debug(`Self-trade prevented for user ${takerOrder.userId}`);
        return {
          matched: fills.length > 0,
          fills,
          remainingSize,
          error: 'SELF_TRADE_PREVENTED',
        };
      }
      
      // Calculate fill size (minimum of both remaining sizes)
      const fillSize = Math.min(remainingSize, bestOrder.remainingSize);
      
      // Execute at user's effective price
      const fillPrice = userEffectivePrice;
      
      // Calculate fees based on user's cost (tiered fee structure)
      const notional = fillPrice * fillSize;
      const { makerFee, takerFee } = calculateFillFees(notional);
      
      // Create fill record with order PDAs for on-chain verification
      const fill: Fill = {
        makerOrderId: bestOrder.id,
        takerOrderId: takerOrder.id,
        makerUserId: bestOrder.userId,
        takerUserId: takerOrder.userId,
        price: fillPrice,  // User's effective price
        size: fillSize,
        outcome: takerOrder.outcome,  // User's original outcome
        makerFee,
        takerFee,
        makerSide: isNoOrder ? (bestOrder.side === 'BID' ? 'ASK' : 'BID') : bestOrder.side,
        takerSide: takerOrder.side,
        makerClientOrderId: bestOrder.clientOrderId || Date.now(),
        takerClientOrderId: takerOrder.clientOrderId || Date.now(),
        // On-chain Order PDAs (if user orders)
        makerOrderPda: (bestOrder as any).orderPda,
        takerOrderPda: (takerOrder as any).orderPda,
        // Legacy: signatures for MM orders
        makerSignature: bestOrder.signature,
        takerSignature: takerOrder.signature,
        makerMessage: bestOrder.binaryMessage,
        takerMessage: takerOrder.binaryMessage,
        // Leverage fields (for on-chain execution routing)
        leverage: takerOrder.leverage,
        marginAmount: takerOrder.marginAmount,
        loanAmount: takerOrder.loanAmount,
      };
      
      fills.push(fill);
      
      // Update maker order in orderbook (atomic: 1 Redis round-trip via Lua)
      const newMakerRemaining = bestOrder.remainingSize - fillSize;
      await orderbookService.consumeOrder(bestOrder, Math.max(0, newMakerRemaining));
      
      // Update remaining taker size
      remainingSize -= fillSize;
      
      logger.debug(`Fill: ${fillSize} @ ${fillPrice} (maker: ${bestOrder.id}, taker: ${takerOrder.id})`);
    }
    
    return {
      matched: fills.length > 0,
      fills,
      remainingSize,
    };
  }

  /**
   * Walk-the-book matching for dollar-based MARKET orders
   * 
   * Walks the orderbook from best price up to maxPrice, filling orders
   * until the dollarAmount is exhausted or no more liquidity.
   * 
   * SINGLE ORDERBOOK MODEL:
   * - Only YES orderbook exists
   * - NO orders are transformed to match against YES orderbook:
   *   - BID NO @ X → Match against YES BID @ (1-X) [MM buying YES = MM selling NO]
   *   - ASK NO @ X → Match against YES ASK @ (1-X) [MM selling YES = MM buying NO]
   * 
   * @param order Dollar-based market order parameters
   * @returns Match result with all fills and aggregated stats
   */
  async matchMarketOrderByDollar(order: DollarMarketOrder): Promise<DollarMatchResult> {
    const fills: Fill[] = [];
    
    // Match with full budget first; after matching we know the fill count,
    // so we can calculate exact per-fill fees and scale fills down to fit
    // within dollarAmount (collateral + fees = dollarAmount).
    let remainingDollars = order.dollarAmount;
    let totalContracts = 0;
    let totalSpent = 0;
    let totalTakerFees = 0;
    
    const perfEnabled = this.matchingPerfEnabled();
    const perf = {
      iterations: 0,
      emptyRetries: 0,
      sleepMs: 0,
      getBestMs: 0,
      updateOrderMs: 0,
      removeOrderMs: 0,
      zcardAtTimeout: null as number | null,
    };

    // CONTINUOUS MATCHING CONFIG
    // Retry delays were reduced from 100ms→20ms after profiling showed empty-book
    // retries were the dominant contributor to matching latency (~1-2s per order).
    const isPerfMode = config.perfTestMode;
    const MAX_RETRIES = isPerfMode ? 3 : 10;            // Reduced from 5/20
    const RETRY_DELAY_MS = isPerfMode ? 10 : 20;        // Reduced from 50/100ms
    const MAX_MATCHING_TIME_MS = isPerfMode ? 200 : 3000; // Reduced from 500/5000ms
    const startTime = Date.now();
    let emptyBookRetries = 0;
    
    // SINGLE ORDERBOOK MODEL: Transform NO orders to match against YES orderbook
    // 
    // NO price derivation from YES:
    // - NO ASK (what user pays to buy NO) = 1 - YES BID
    // - NO BID (what user receives to sell NO) = 1 - YES ASK
    //
    // So matching rules:
    // - YES: BID→ASK, ASK→BID (opposite side)
    // - NO: BID→BID, ASK→ASK (SAME side - because NO is derived from opposite YES)
    const isNoOrder = order.outcome === 'NO';
    const effectiveOutcome: 'YES' | 'NO' = 'YES'; // Always match against YES orderbook
    
    // Side transformation:
    // - YES BID → YES ASK (opposite)
    // - NO BID → YES BID (same side, because NO ASK = complement of YES BID)
    let matchSide: 'BID' | 'ASK';
    if (isNoOrder) {
      matchSide = order.side;  // Same side for NO
    } else {
      matchSide = order.side === 'BID' ? 'ASK' : 'BID';  // Opposite for YES
    }
    
    while (remainingDollars > 0) {
      perf.iterations++;
      // Check timeout
      if (Date.now() - startTime > MAX_MATCHING_TIME_MS) {
        if (perfEnabled) {
          // For BID NO, we match against YES:BID. For other cases, the key still provides useful context.
          const { RedisKeys } = await import('../db/redis.js');
          const key = RedisKeys.orderbook(order.marketId, effectiveOutcome, matchSide);
          perf.zcardAtTimeout = await this.safeZcard(key);
        }
        logger.warn(`Matching timeout after ${MAX_MATCHING_TIME_MS}ms, remaining $${remainingDollars.toFixed(2)}`);
        if (perfEnabled) {
          logger.warn(
            {
              marketId: order.marketId,
              side: order.side,
              outcome: order.outcome,
              matchSide,
              elapsedMs: Date.now() - startTime,
              fills: fills.length,
              remainingDollars,
              perf,
            },
            '[MATCH PERF] Timeout'
          );
        }
        break;
      }
      
      // Get best opposing order from YES orderbook
      const tBest = Date.now();
      const bestOrder = matchSide === 'ASK'
        ? await orderbookService.getBestAsk(order.marketId, effectiveOutcome)
        : await orderbookService.getBestBid(order.marketId, effectiveOutcome);
      perf.getBestMs += Date.now() - tBest;
      
      if (!bestOrder) {
        // CONTINUOUS MATCHING: Wait and retry for MM to replenish orderbook
        if (emptyBookRetries < MAX_RETRIES) {
          emptyBookRetries++;
          perf.emptyRetries = emptyBookRetries;
          logger.debug(`Orderbook empty, retry ${emptyBookRetries}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms...`);
          const tSleep = Date.now();
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          perf.sleepMs += Date.now() - tSleep;
          continue; // Retry the loop
        }
        
        // Exhausted retries - use DEV synthetic fill if enabled
        if (config.devAlwaysFillMarketOrders) {
          const mmUserId = getMMUserId();
          if (!mmUserId) {
            logger.warn('DEV_ALWAYS_FILL_MARKET_ORDERS enabled but MM user is not initialized');
            break;
          }

          // Use current market prices as a sane fill price (defaults to 0.50).
          const market = await marketService.getById(order.marketId);
          const yesPx = market?.yesPrice ? parseFloat(market.yesPrice) : 0.5;
          const noPx = market?.noPrice ? parseFloat(market.noPrice) : 0.5;
          const basePrice = order.outcome === 'YES' ? yesPx : noPx;
          const price = Math.min(0.99, Math.max(0.01, basePrice || 0.5));

          const fillSize = remainingDollars / price;
          const fillCost = fillSize * price;
          const { makerFee } = calculateFillFees(fillCost);

          const fill: Fill = {
            makerOrderId: `mm_synth_${Date.now()}`,
            takerOrderId: 'pending',
            makerUserId: mmUserId,
            takerUserId: order.userId,
            price,
            size: fillSize,
            outcome: order.outcome,
            makerFee,
            takerFee: 0, // Placeholder — distributed proportionally after matching
            makerSide: matchSide, // maker provides the opposing side
            takerSide: order.side,
            makerClientOrderId: Date.now(),
            takerClientOrderId: order.clientOrderId || Date.now(),
            // Leverage fields
            leverage: order.leverage,
            marginAmount: order.marginAmount,
            loanAmount: order.loanAmount,
          };

          fills.push(fill);
          totalContracts += fillSize;
          totalSpent += fillCost;
          remainingDollars -= fillCost;

          logger.info(
            `DEV fill: synthetic MM liquidity ${fillSize.toFixed(6)} @ ${price.toFixed(4)} for ${order.side} ${order.outcome}` +
            (order.leverage && order.leverage > 1 ? ` (${order.leverage}x leverage)` : '')
          );
        }
        
        logger.info(`Orderbook exhausted after ${emptyBookRetries} retries, remaining $${remainingDollars.toFixed(2)}`);
        break;
      }
      
      // Reset retry counter when we find an order
      emptyBookRetries = 0;
      
      // Log each fill's price to show we're getting fresh best prices
      logger.debug(`[MATCH] Best ${matchSide} found: $${bestOrder.price.toFixed(4)} (order ${bestOrder.id.slice(0,8)})`);
      
      // SINGLE ORDERBOOK MODEL: Calculate effective price for user
      // For NO orders, the user's price is the complement of the YES order price
      // YES BID @ $0.56 → User pays $0.44 for NO
      const userEffectivePrice = isNoOrder ? (1 - bestOrder.price) : bestOrder.price;
      
      // NO maxPrice check - market orders fill at any available price
      // This enables continuous matching as MM replenishes at different prices
      
      // Self-trade prevention - if best order is yours, stop matching
      if (bestOrder.userId === order.userId) {
        logger.debug(`Self-trade prevented for user ${order.userId}`);
        break;
      }
      
      // Calculate how many contracts we can afford at the user's effective price
      const maxContractsAtPrice = remainingDollars / userEffectivePrice;
      
      // Minimum fill threshold: 0.01 contracts (1 cent payout worth)
      const MIN_FILL_SIZE = 0.01;
      if (maxContractsAtPrice < MIN_FILL_SIZE) {
        logger.debug(`Walk-the-book: Remaining $${remainingDollars.toFixed(4)} not enough for minimum ${MIN_FILL_SIZE} contracts`);
        break;
      }
      
      // Calculate fill size (minimum of what we can afford and what's available)
      // No Math.floor() - allow fractional contracts
      const fillSize = Math.min(maxContractsAtPrice, bestOrder.remainingSize);
      const fillPrice = userEffectivePrice;  // User sees their effective price
      const fillCost = fillSize * fillPrice;
      
      // Maker fee per fill (always 0 currently); taker fee distributed after loop
      const { makerFee } = calculateFillFees(fillCost);
      
      // Placeholder for taker order ID - will be replaced after order is created
      const takerOrderId = 'pending';
      
      // Create fill record
      // For NO orders: record the user's outcome (NO) and their effective price
      const fill: Fill = {
        makerOrderId: bestOrder.id,
        takerOrderId,
        makerUserId: bestOrder.userId,
        takerUserId: order.userId,
        price: fillPrice,  // User's effective price (complement for NO)
        size: fillSize,
        outcome: order.outcome,  // User's original outcome (YES or NO)
        makerFee,
        takerFee: 0, // Placeholder — distributed proportionally after matching
        makerSide: isNoOrder ? (bestOrder.side === 'BID' ? 'ASK' : 'BID') : bestOrder.side, // Flip for NO
        takerSide: order.side,
        makerClientOrderId: bestOrder.clientOrderId || Date.now(),
        takerClientOrderId: order.clientOrderId || Date.now(),
        makerOrderPda: (bestOrder as any).orderPda,
        makerSignature: bestOrder.signature,
        makerMessage: bestOrder.binaryMessage,
        takerSignature: order.signature,
        takerMessage: order.binaryMessage,
        // Leverage fields (for on-chain execution routing)
        leverage: order.leverage,
        marginAmount: order.marginAmount,
        loanAmount: order.loanAmount,
      };
      
      fills.push(fill);
      totalContracts += fillSize;
      totalSpent += fillCost;
      remainingDollars -= fillCost;
      
      // Update maker order in orderbook (atomic: 1 Redis round-trip via Lua)
      const newMakerRemaining = bestOrder.remainingSize - fillSize;
      const tConsume = Date.now();
      await orderbookService.consumeOrder(bestOrder, Math.max(0, newMakerRemaining));
      if (newMakerRemaining > 0) {
        perf.updateOrderMs += Date.now() - tConsume;
      } else {
        perf.removeOrderMs += Date.now() - tConsume;
      }
      
      logger.debug(
        `Walk-the-book fill: ${fillSize.toFixed(6)} contracts @ ${fillPrice} = $${fillCost.toFixed(4)} ` +
        `(remaining: $${remainingDollars.toFixed(4)})`
      );
    }
    
    // TWO-PASS FEE ADJUSTMENT:
    // Pass 1 (above) matched with full dollarAmount to discover fill count & prices.
    // Pass 2 (below) calculates actual per-fill fees, then scales fills down so
    // collateral + fees = dollarAmount exactly. This prevents overcharging when
    // user has exactly dollarAmount in their wallet.
    let upfrontFee = 0;
    if (fills.length > 0 && totalSpent > 0) {
      // Calculate real per-fill fees
      for (const fill of fills) {
        const fillCost = fill.price * fill.size;
        fill.takerFee = calculateFillFees(fillCost).takerFee;
      }
      const grossFees = fills.reduce((sum, f) => sum + f.takerFee, 0);
      
      // Scale fills down so totalSpent_scaled + grossFees_scaled = dollarAmount
      // Since flat fees don't change with fill size (below tier1Max), we just need:
      //   targetCollateral = dollarAmount - totalFees
      //   scaleFactor = targetCollateral / totalSpent
      const targetCollateral = order.dollarAmount - grossFees;
      
      if (targetCollateral > 0 && targetCollateral < totalSpent) {
        const scale = targetCollateral / totalSpent;
        totalContracts = 0;
        totalSpent = 0;
        
        for (const fill of fills) {
          fill.size = fill.size * scale;
          const newCost = fill.price * fill.size;
          totalContracts += fill.size;
          totalSpent += newCost;
          // Recalculate fee on scaled cost (may change for percentage tiers)
          fill.takerFee = calculateFillFees(newCost).takerFee;
        }
      }
      
      totalTakerFees = fills.reduce((sum, f) => sum + f.takerFee, 0);
      upfrontFee = totalTakerFees;
    }
    
    const avgPrice = totalContracts > 0 ? totalSpent / totalContracts : 0;
    
    logger.info(
      `Walk-the-book complete: ${fills.length} fills, ` +
      `${totalContracts.toFixed(6)} contracts @ avg ${avgPrice.toFixed(4)}, ` +
      `collateral $${totalSpent.toFixed(4)}, fees $${totalTakerFees.toFixed(4)}, ` +
      `total $${(totalSpent + totalTakerFees).toFixed(4)} of $${order.dollarAmount}`
    );

    if (perfEnabled) {
      logger.info(
        {
          marketId: order.marketId,
          side: order.side,
          outcome: order.outcome,
          elapsedMs: Date.now() - startTime,
          fills: fills.length,
          totalSpent,
          unfilledDollars: remainingDollars,
          perf,
        },
        '[MATCH PERF] Completed'
      );
    }
    
    return {
      orderId: '',
      fills,
      totalSpent,
      totalContracts,
      avgPrice,
      unfilledDollars: remainingDollars,
      totalTakerFees,
      upfrontFee,
      dollarAmount: order.dollarAmount,
    };
  }

  /**
   * Process a dollar-based MARKET order
   * Creates fills, updates positions, and executes on-chain
   * 
   * PERFORMANCE OPTIMIZED (v2):
   * - On-chain execution starts IMMEDIATELY after Redis matching
   * - DB updates run in BACKGROUND (batched for efficiency)
   * - Response returns to user within ~100ms instead of 12+ seconds
   */
  async processMarketOrderByDollar(order: DollarMarketOrder): Promise<DollarMatchResult> {
    const t0 = Date.now();
    
    // 1. Match against the in-memory orderbook (Redis — sub-millisecond)
    //    NOTE: Market status/expiry is already checked by the REST route (orders.ts)
    //    and by the on-chain worker (pre-flight check). Don't add DB calls here — hot path.
    const result = await this.matchMarketOrderByDollar(order);
    
    if (result.fills.length === 0) {
      return { ...result, orderId: 'cancelled' };
    }
    
    // 2. Get market data ONCE (cached in memory — instant)
    const market = await marketService.getById(order.marketId);
    if (!market) {
      logger.error(`Market ${order.marketId} not found for order processing`);
      return { ...result, orderId: 'cancelled' };
    }
    
    // 3. Generate order ID locally — NO DB ROUND-TRIP
    //    The actual DB INSERT happens asynchronously via write-behind queue
    const orderId = randomUUID();
    const filledSize = result.totalContracts;
    const remainingSize = 0;
    const orderStatus = result.unfilledDollars > 0.01 ? 'PARTIAL' : 'FILLED';
    
    // Enqueue order for batch DB persistence (write-behind)
    writeBehindService.enqueueOrder({
      id: orderId,
      clientOrderId: order.clientOrderId || Date.now(),
      marketId: order.marketId,
      userId: order.userId,
      side: order.side,
      outcome: order.outcome,
      orderType: 'MARKET',
      price: result.avgPrice.toString(),
      size: result.totalContracts.toString(),
      signature: order.signature || null,
      encodedInstruction: null,
      isMmOrder: false,
      expiresAt: order.expiresAt ? new Date(order.expiresAt) : new Date(Date.now() + 3600000),
      status: orderStatus,
      filledSize: filledSize.toString(),
      remainingSize: Math.max(0, remainingSize).toString(),
      leverage: order.leverage ? order.leverage.toString() : '1',
      marginAmount: order.marginAmount ? order.marginAmount.toString() : null,
    });
    
    // Update fills with the pre-generated order ID
    for (const fill of result.fills) {
      fill.takerOrderId = orderId;
    }
    
    const matchMs = Date.now() - t0;
    if (matchMs > 10) {
      logger.info(`[⏱️ MATCHING] ${matchMs}ms: ${result.fills.length} fills, orderId=${orderId.slice(0,8)} (write-behind)`);
    }
    
    // 4. For LEVERAGED orders: Create taker position SYNCHRONOUSLY
    //    Required because orders.ts needs the position to create the margin account
    //    For regular orders, positions are created in background for speed
    if (order.leverage && order.leverage > 1) {
      const takerIsBuy = order.side === 'BID';
      
      // Aggregate all fills by outcome for taker position
      const outcomeShares = new Map<'YES' | 'NO', number>();
      for (const fill of result.fills) {
        const current = outcomeShares.get(fill.outcome) || 0;
        outcomeShares.set(fill.outcome, current + fill.size);
      }
      
      // Update taker position for each outcome
      // Use dollarAmount as cost for buy orders so fee is baked into PnL
      const useDollarAmountAsCost = takerIsBuy && outcomeShares.size === 1;
      for (const [outcome, shares] of outcomeShares) {
        let cost: number;
        if (useDollarAmountAsCost) {
          cost = result.dollarAmount;
        } else {
          const outcomeFills = result.fills.filter(f => f.outcome === outcome);
          const outcomeNotional = outcomeFills.reduce((sum, f) => sum + f.price * f.size, 0);
          const outcomeFee = outcomeFills.reduce((sum, f) => sum + f.takerFee, 0);
          cost = takerIsBuy ? outcomeNotional + outcomeFee : outcomeNotional - outcomeFee;
        }
        
        await positionService.updateAfterTrade(
          order.userId,
          order.marketId,
          outcome,
          shares,
          cost,
          takerIsBuy
        );
      }
    }
    
    // 5. EXECUTE ON-CHAIN (async with error tracking)
    // If on-chain execution fails, trades are marked with FAILED tx status for reconciliation
    this.executeFillsOnChain(result.fills, order.marketId)
      .catch(err => {
        logger.error(`[CRITICAL] On-chain execution failed for ${result.fills.length} fills: ${err.message}`);
        // Mark affected trades as FAILED so reconciliation job can detect phantom positions
        this.markFillsAsFailed(result.fills).catch(e => logger.error(`Failed to mark fills as failed: ${e.message}`));
      });
    
    // 6. PROCESS DB UPDATES IN BACKGROUND (trades, positions, stats — batched)
    //    Trades are also enqueued to write-behind for batch insert
    this.processFillsInBackground(result.fills, order, {
      id: market.id,
      pubkey: market.pubkey,
      asset: market.asset,
      timeframe: market.timeframe,
    }, !!(order.leverage && order.leverage > 1), {
      dollarAmount: result.dollarAmount,
      upfrontFee: result.upfrontFee,
    }).catch(err => logger.error(`Background DB processing failed: ${err.message}`));
    
    return { ...result, orderId };
  }

  /**
   * Match sell order against orderbook (walk the bids)
   * Seller wants to sell shares at or above minPrice
   * 
   * SINGLE ORDERBOOK MODEL:
   * - Sell YES → Match YES BIDs (normal)
   * - Sell NO → Match YES ASKs (MM selling YES = buying NO from user)
   */
  async matchSellOrder(order: SellOrder): Promise<SellMatchResult> {
    const fills: Fill[] = [];
    let remainingSize = order.size;
    let totalProceeds = 0;
    
    const perfEnabled = this.matchingPerfEnabled();
    const perf = {
      iterations: 0,
      emptyRetries: 0,
      sleepMs: 0,
      getBestMs: 0,
      updateOrderMs: 0,
      removeOrderMs: 0,
      zcardAtTimeout: null as number | null,
    };

    // CONTINUOUS MATCHING CONFIG (same as buy orders for consistency)
    const isPerfMode = config.perfTestMode;
    const MAX_RETRIES = isPerfMode ? 3 : 10;
    const RETRY_DELAY_MS = isPerfMode ? 10 : 20;
    const MAX_MATCHING_TIME_MS = isPerfMode ? 200 : 3000;
    const startTime = Date.now();
    let emptyBookRetries = 0;
    
    // SINGLE ORDERBOOK MODEL: Transform NO sell to match YES orderbook
    const isNoOrder = order.outcome === 'NO';
    const effectiveOutcome: 'YES' | 'NO' = 'YES';
    
    logger.info(
      `Sell order: ${order.size} ${order.outcome} contracts (min price: ${order.minPrice})` +
      (isNoOrder ? ` [matching YES ASKs]` : '')
    );
    
    while (remainingSize > 0.001) {  // Min 0.001 contracts
      perf.iterations++;
      // Check total matching time
      if (Date.now() - startTime > MAX_MATCHING_TIME_MS) {
        if (perfEnabled) {
          const { RedisKeys } = await import('../db/redis.js');
          // For sell NO, we match YES:ASK; for sell YES, YES:BID. Either way, the key is helpful context.
          const key = RedisKeys.orderbook(order.marketId, effectiveOutcome, isNoOrder ? 'ASK' : 'BID');
          perf.zcardAtTimeout = await this.safeZcard(key);
        }
        logger.warn(`Sell order matching timed out after ${MAX_MATCHING_TIME_MS}ms, remaining: ${remainingSize.toFixed(6)}`);
        if (perfEnabled) {
          logger.warn(
            {
              marketId: order.marketId,
              outcome: order.outcome,
              elapsedMs: Date.now() - startTime,
              fills: fills.length,
              remainingSize,
              perf,
            },
            '[MATCH PERF] Sell timeout'
          );
        }
        break;
      }
      
      // SINGLE ORDERBOOK: 
      // - Sell YES → Get best YES BID (buyer for YES)
      // - Sell NO → Get best YES ASK (MM selling YES = buying NO from user)
      const tBest = Date.now();
      const bestOrder = isNoOrder
        ? await orderbookService.getBestAsk(order.marketId, effectiveOutcome)
        : await orderbookService.getBestBid(order.marketId, effectiveOutcome);
      perf.getBestMs += Date.now() - tBest;
      
      if (!bestOrder) {
        // CONTINUOUS MATCHING: Wait and retry for MM to replenish orderbook
        if (emptyBookRetries < MAX_RETRIES) {
          emptyBookRetries++;
          perf.emptyRetries = emptyBookRetries;
          logger.debug(`Sell: Orderbook empty, retry ${emptyBookRetries}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms...`);
          const tSleep = Date.now();
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          perf.sleepMs += Date.now() - tSleep;
          continue; // Retry the loop
        }
        
        // Exhausted retries - use DEV synthetic fill if enabled
        if (config.devAlwaysFillMarketOrders) {
          const mmUserId = getMMUserId();
          if (!mmUserId) {
            logger.warn('DEV_ALWAYS_FILL_MARKET_ORDERS enabled but MM user is not initialized');
            break;
          }

          // Use current market prices as a sane fill price (defaults to 0.50)
          const market = await marketService.getById(order.marketId);
          const yesPx = market?.yesPrice ? parseFloat(market.yesPrice) : 0.5;
          const noPx = market?.noPrice ? parseFloat(market.noPrice) : 0.5;
          const basePrice = order.outcome === 'YES' ? yesPx : noPx;
          // For sells, use the market price but ensure it meets min price
          const price = Math.max(order.minPrice, Math.min(0.99, Math.max(0.01, basePrice || 0.5)));

          const fillSize = remainingSize;
          const fillProceeds = fillSize * price;
          const { makerFee, takerFee } = calculateFillFees(fillProceeds);

          const fill: Fill = {
            makerOrderId: `mm_synth_${Date.now()}`,
            takerOrderId: 'pending',
            makerUserId: mmUserId,
            takerUserId: order.userId,
            price,
            size: fillSize,
            outcome: order.outcome,
            makerFee,
            takerFee,
            makerSide: 'BID',   // MM is buying
            takerSide: 'ASK',   // User is selling
            makerClientOrderId: Date.now(),
            takerClientOrderId: order.clientOrderId || Date.now(),
          };

          fills.push(fill);
          totalProceeds += fillProceeds;
          remainingSize = 0;

          logger.info(
            `DEV fill: synthetic MM bid ${fillSize.toFixed(6)} @ ${price.toFixed(4)} for SELL ${order.outcome}`
          );
        } else {
          logger.debug('Sell order: No more orders to match after retries');
        }
        break;
      }
      
      // Reset retry counter on successful order fetch
      emptyBookRetries = 0;
      
      // SINGLE ORDERBOOK MODEL: Calculate user's effective price
      // For NO sells, user's price is complement of YES order price
      // YES ASK @ $0.56 → User sells NO @ $0.44
      const userEffectivePrice = isNoOrder ? (1 - bestOrder.price) : bestOrder.price;
      
      // Check price floor (seller won't accept below minPrice)
      if (userEffectivePrice < order.minPrice) {
        // Devnet/testing: still fill at the user's min price if MM is available
        if (config.devAlwaysFillMarketOrders) {
          const mmUserId = getMMUserId();
          if (mmUserId) {
            const fillSize = remainingSize;
            const price = order.minPrice;
            const fillProceeds = fillSize * price;
            const { makerFee, takerFee } = calculateFillFees(fillProceeds);

            const fill: Fill = {
              makerOrderId: `mm_synth_${Date.now()}`,
              takerOrderId: 'pending',
              makerUserId: mmUserId,
              takerUserId: order.userId,
              price,
              size: fillSize,
              outcome: order.outcome,
              makerFee,
              takerFee,
              makerSide: 'BID',
              takerSide: 'ASK',
              makerClientOrderId: Date.now(),
              takerClientOrderId: order.clientOrderId || Date.now(),
              // Leveraged close: on-chain shares are owned by Lending Pool
              isLeveragedClose: order.isLeveragedClose,
            };

            fills.push(fill);
            totalProceeds += fillProceeds;
            remainingSize = 0;

            logger.info(
              `DEV fill: synthetic MM bid at min price ${fillSize.toFixed(6)} @ ${price.toFixed(4)} for SELL ${order.outcome}` +
              (order.isLeveragedClose ? ' [LEVERAGED CLOSE]' : '')
            );
            break;
          }
        }
        logger.debug(`Sell order: Price ${userEffectivePrice} below min ${order.minPrice}`);
        break;
      }
      
      // Self-trade prevention
      if (bestOrder.userId === order.userId) {
        logger.debug(`Sell order: Self-trade prevented for user ${order.userId}`);
        break;
      }
      
      // Calculate fill size and proceeds using user's effective price
      const fillSize = Math.min(remainingSize, bestOrder.remainingSize);
      const fillPrice = userEffectivePrice;  // User sees their effective price
      const fillProceeds = fillSize * fillPrice;
      
      // Calculate fees (tiered fee structure)
      const { makerFee, takerFee } = calculateFillFees(fillProceeds);
      
      // Create fill record (seller is taker, buyer is maker)
      const fill: Fill = {
        makerOrderId: bestOrder.id,
        takerOrderId: 'pending',  // Will be replaced
        makerUserId: bestOrder.userId,  // Buyer (maker)
        takerUserId: order.userId,       // Seller (taker)
        price: fillPrice,  // User's effective price
        size: fillSize,
        outcome: order.outcome,  // User's original outcome
        makerFee,
        takerFee,
        makerSide: isNoOrder ? 'ASK' : 'BID',  // For NO: maker was YES ASK
        takerSide: 'ASK',   // Seller is asking
        makerClientOrderId: bestOrder.clientOrderId || Date.now(),
        takerClientOrderId: order.clientOrderId || Date.now(),
        makerOrderPda: (bestOrder as any).orderPda,
        makerSignature: bestOrder.signature,
        makerMessage: bestOrder.binaryMessage,
        takerSignature: order.signature,
        takerMessage: order.binaryMessage,
        // Leveraged close: on-chain shares are owned by Lending Pool
        isLeveragedClose: order.isLeveragedClose,
      };
      
      fills.push(fill);
      totalProceeds += fillProceeds;
      remainingSize -= fillSize;
      
      // Update maker order in orderbook (atomic: 1 Redis round-trip via Lua)
      const newMakerRemaining = bestOrder.remainingSize - fillSize;
      const tConsume = Date.now();
      await orderbookService.consumeOrder(bestOrder, Math.max(0, newMakerRemaining));
      if (newMakerRemaining > 0) {
        perf.updateOrderMs += Date.now() - tConsume;
      } else {
        perf.removeOrderMs += Date.now() - tConsume;
      }
      
      logger.debug(
        `Sell fill: ${fillSize.toFixed(6)} contracts @ ${fillPrice} = $${fillProceeds.toFixed(4)} ` +
        `(remaining: ${remainingSize.toFixed(6)})`
      );
    }
    
    const avgPrice = fills.length > 0 && (order.size - remainingSize) > 0 
      ? totalProceeds / (order.size - remainingSize) 
      : 0;
    
    logger.info(
      `Sell order complete: ${fills.length} fills, ` +
      `${(order.size - remainingSize).toFixed(6)} sold @ avg ${avgPrice.toFixed(4)}, ` +
      `proceeds $${totalProceeds.toFixed(2)}, unsold ${remainingSize.toFixed(6)}`
    );

    if (perfEnabled) {
      logger.info(
        {
          marketId: order.marketId,
          outcome: order.outcome,
          elapsedMs: Date.now() - startTime,
          fills: fills.length,
          proceeds: totalProceeds,
          remainingSize,
          perf,
        },
        '[MATCH PERF] Sell completed'
      );
    }
    
    return {
      orderId: '',
      fills,
      totalProceeds,
      totalSold: order.size - remainingSize,
      avgPrice,
      remainingSize,
    };
  }

  /**
   * Process a sell order (user selling existing shares)
   * Creates fills, updates positions, and executes on-chain via execute_close
   * 
   * PERFORMANCE OPTIMIZED (v2):
   * - On-chain execution starts IMMEDIATELY after Redis matching
   * - DB updates run in BACKGROUND (batched for efficiency)
   */
  async processSellOrder(order: SellOrder): Promise<SellMatchResult> {
    // 1. Match against the bids (in-memory - instant)
    const result = await this.matchSellOrder(order);
    
    if (result.fills.length === 0) {
      return { ...result, orderId: 'cancelled' };
    }
    
    // 2. Get market data ONCE (cached) - needed for on-chain and DB
    const market = await marketService.getById(order.marketId);
    if (!market) {
      logger.error(`Market ${order.marketId} not found for sell order`);
      return { ...result, orderId: 'cancelled' };
    }
    
    // 3. Create taker order record (minimal DB touch before response)
    const takerOrder = await orderService.create({
      clientOrderId: order.clientOrderId || Date.now(),
      marketId: order.marketId,
      userId: order.userId,
      side: 'ASK',
      outcome: order.outcome,
      orderType: 'MARKET',
      price: result.avgPrice.toString(),
      size: result.totalSold.toString(),
      signature: order.signature || null,
      encodedInstruction: null,
      isMmOrder: false,
      expiresAt: order.expiresAt ? new Date(order.expiresAt) : new Date(Date.now() + 3600000),
      status: result.remainingSize > 0.001 ? 'PARTIAL' : 'FILLED',
      filledSize: result.totalSold,
    });
    
    // Update fills with the real taker order ID
    for (const fill of result.fills) {
      fill.takerOrderId = takerOrder.id;
    }
    
    // 4. EXECUTE ON-CHAIN (async with error tracking)
    // IMPORTANT: Pass isClosingTrade=true because sell orders are ALWAYS closing trades
    this.executeFillsOnChain(result.fills, order.marketId, true)
      .catch(err => {
        logger.error(`[CRITICAL] On-chain close execution failed for ${result.fills.length} fills: ${err.message}`);
        this.markFillsAsFailed(result.fills).catch(e => logger.error(`Failed to mark fills as failed: ${e.message}`));
      });
    
    // 5. PROCESS DB UPDATES IN BACKGROUND (batched for efficiency)
    const asMarketOrder: DollarMarketOrder = {
      marketId: order.marketId,
      userId: order.userId,
      side: 'ASK',
      outcome: order.outcome,
      dollarAmount: 0,
      maxPrice: order.minPrice,
      clientOrderId: order.clientOrderId,
      expiresAt: order.expiresAt,
      signature: order.signature,
      binaryMessage: order.binaryMessage,
    };
    
    this.processFillsInBackground(result.fills, asMarketOrder, {
      id: market.id,
      pubkey: market.pubkey,
      asset: market.asset,
      timeframe: market.timeframe,
    }).catch(err => logger.error(`Background DB processing failed: ${err.message}`));
    
    return { ...result, orderId: takerOrder.id };
  }

  /**
   * Process a delegated LIMIT order (no on-chain Order PDA)
   * Matches immediately against orderbook, adds remaining to orderbook
   */
  async processLimitOrder(order: LimitOrder): Promise<LimitMatchResult> {
    logger.info(
      `Processing delegated LIMIT ${order.side} ${order.outcome}: ` +
      `${order.size} contracts @ ${order.price}`
    );

    // Create DB order record first (needed for orderbook and fills)
    const dbOrder = await orderService.create({
      clientOrderId: order.clientOrderId || Date.now(),
      marketId: order.marketId,
      userId: order.userId,
      side: order.side,
      outcome: order.outcome,
      orderType: 'LIMIT',
      price: order.price.toString(),
      size: order.size.toString(),
      signature: order.signature || null,
      encodedInstruction: null,  // No on-chain order PDA for delegation
      isMmOrder: false,
      expiresAt: order.expiresAt ? new Date(order.expiresAt) : new Date(Date.now() + 3600000),
      // Store leverage info on order so it's visible before margin account exists
      leverage: order.leverage,
      marginAmount: order.marginAmount,
    });

    // Convert to orderbook order format
    const orderbookOrder: OrderbookOrder = {
      id: dbOrder.id,
      marketId: order.marketId,
      userId: order.userId,
      side: order.side,
      outcome: order.outcome,
      orderType: 'LIMIT',
      price: order.price,
      size: order.size,
      remainingSize: order.size,
      createdAt: Date.now(),
      clientOrderId: order.clientOrderId,
      expiresAt: order.expiresAt,
      signature: order.signature,
      binaryMessage: order.binaryMessage,
      // Leverage fields
      leverage: order.leverage,
      marginAmount: order.marginAmount,
      loanAmount: order.loanAmount,
    };

    // Process through standard matching engine
    const result = await this.processOrder(orderbookOrder);

    // Calculate stats
    const filledSize = result.fills.reduce((sum, f) => sum + f.size, 0);
    const remainingSize = order.size - filledSize;

    let status: 'open' | 'partial' | 'filled' = 'open';
    if (filledSize >= order.size - 0.001) {
      status = 'filled';
    } else if (filledSize > 0) {
      status = 'partial';
    }

    logger.info(
      `Delegated LIMIT order ${dbOrder.id}: ${status}, ` +
      `filled ${filledSize.toFixed(6)}, remaining ${remainingSize.toFixed(6)}`
    );

    return {
      orderId: dbOrder.id,
      fills: result.fills,
      filledSize,
      remainingSize,
      status,
    };
  }

  /**
   * Aggregate and execute all fills for a taker order on-chain.
   * This is the primary entry point for efficient on-chain settlement.
   * 
   * @param isClosingTrade - If true, force use of execute_close instruction (user selling existing holdings)
   */
  /**
   * Mark fills as FAILED in the database when on-chain execution fails.
   * This enables reconciliation jobs to detect and clean up phantom positions.
   */
  private async markFillsAsFailed(fills: Fill[]): Promise<void> {
    for (const fill of fills) {
      try {
        await db
          .update(trades)
          .set({
            txStatus: 'FAILED' as any,
            txSignature: `failed_${Date.now()}`,
          })
          .where(eq(trades.takerOrderId, fill.takerOrderId));
      } catch (e: any) {
        logger.error(`Failed to mark trade ${fill.takerOrderId} as FAILED: ${e.message}`);
      }
    }
  }

  private async executeFillsOnChain(fills: Fill[], marketId: string, isClosingTrade: boolean = false): Promise<void> {
    const market = await marketService.getById(marketId);
    if (!market) return;

    const marketPubkey = market.pubkey;

    // Aggregate MM fills
    const aggregatedFills = this.aggregateMmFills(fills);

    // Execute each (potentially aggregated) fill on-chain
    for (const fill of aggregatedFills) {
      try {
        const makerWallet = await this.getWalletForUser(fill.makerUserId);
        const takerWallet = await this.getWalletForUser(fill.takerUserId);

        if (!makerWallet || !takerWallet) {
          logger.warn(`Missing wallet for on-chain execution: maker=${makerWallet}, taker=${takerWallet}`);
          continue;
        }

        await this.executeMatchOrCloseOnChain(fill, marketId, marketPubkey, makerWallet, takerWallet, isClosingTrade);
      } catch (err: any) {
        logger.error(`Failed to execute fill on-chain: ${err.message}`);
      }
    }
  }

  /**
   * Helper to execute either a match or a close on-chain based on trade type.
   * 
   * @param forceClose - If true, skip position check and use execute_close directly
   *                     (used for processSellOrder where position is already updated in DB)
   */
  private async executeMatchOrCloseOnChain(
    fill: Fill,
    marketId: string,
    marketPubkey: string,
    makerWallet: string,
    takerWallet: string,
    forceClose: boolean = false
  ): Promise<void> {
    // Detect if this is a closing trade (taker is selling existing shares)
    const isClosingTrade = fill.takerSide === 'ASK';
    
    // For sell orders (forceClose=true), ALWAYS use execute_close
    // This transfers USDC from buyer to seller, not the other way around!
    if (forceClose && isClosingTrade) {
      // LEVERAGED CLOSE: On-chain shares are owned by Lending Pool, not user
      // The Lending Pool must be the on-chain seller
      let actualSellerWallet = takerWallet;
      
      if (fill.isLeveragedClose) {
        const lendingPoolWallet = lendingService.getLendingWalletPubkey()?.toBase58();
        if (!lendingPoolWallet) {
          logger.error(`[LeveragedClose] Lending pool wallet not configured, cannot execute close for user ${takerWallet.slice(0,8)}`);
          return;
        }
        actualSellerWallet = lendingPoolWallet;
        logger.info(`[LeveragedClose] Executing close on-chain: LendingPool=${actualSellerWallet.slice(0,8)} selling for user=${takerWallet.slice(0,8)}, buyer=${makerWallet.slice(0,8)}, ${fill.size} @ ${fill.price}`);
      } else {
        logger.info(`Executing CLOSE (sell) on-chain: seller=${takerWallet.slice(0,8)}, buyer=${makerWallet.slice(0,8)}, ${fill.size} @ ${fill.price} fee=${fill.takerFee}`);
      }
      
      const closeParams: CloseParams = {
        marketPubkey: marketPubkey,
        buyerWallet: makerWallet,        // Maker is buying (MM)
        sellerWallet: actualSellerWallet, // Lending Pool for leveraged, user otherwise
        outcome: fill.outcome,
        price: fill.price,
        matchSize: fill.size,
        takerFee: fill.takerFee,  // Tiered fee calculated by fee.service.ts
        makerOrderId: fill.makerOrderId,  // For updating trade with tx signature
        takerOrderId: fill.takerOrderId,  // For updating trade with tx signature
      };
      
      const idempotencyKey = `close-${fill.makerOrderId}-${fill.takerOrderId}`;
      onchainSubmitQueue.add('close', {
        type: 'close' as const,
        idempotencyKey,
        payload: closeParams,
      }, { jobId: idempotencyKey }).catch((err: any) => {
        logger.error(`Failed to enqueue close job: ${err.message}`);
      });
      return;
    }
    
    if (isClosingTrade && !forceClose) {
      // Check if seller has existing shares (use marketId for DB lookup, not marketPubkey)
      const sellerPosition = await positionService.getPosition(fill.takerUserId, marketId);
      const sellerShares = fill.outcome === 'YES'
        ? parseFloat(sellerPosition?.yesShares || '0')
        : parseFloat(sellerPosition?.noShares || '0');
      
      if (sellerShares >= fill.size - 0.0001) { // Small epsilon for float
        // True closing trade - use execute_close instruction
        const closeParams: CloseParams = {
          marketPubkey: marketPubkey,
          buyerWallet: makerWallet,  // Maker is buying
          sellerWallet: takerWallet, // Taker is selling
          outcome: fill.outcome,
          price: fill.price,
          matchSize: fill.size,
          takerFee: fill.takerFee,  // Tiered fee calculated by fee.service.ts
          makerOrderId: fill.makerOrderId,  // For updating trade with tx signature
          takerOrderId: fill.takerOrderId,  // For updating trade with tx signature
        };
        
        const idempotencyKey2 = `close-${fill.makerOrderId}-${fill.takerOrderId}`;
        onchainSubmitQueue.add('close', {
          type: 'close' as const,
          idempotencyKey: idempotencyKey2,
          payload: closeParams,
        }, { jobId: idempotencyKey2 }).catch((err: any) => {
          logger.error(`Failed to enqueue close job: ${err.message}`);
        });
        return;
      }
    }
    
    // Check for leveraged opening trade - use Lending Pool wallet instead of user
    if (fill.leverage && fill.leverage > 1 && fill.marginAmount && fill.loanAmount) {
      logger.info(`Executing LEVERAGED on-chain: ${fill.size} ${fill.outcome} @ ${fill.price} (${fill.leverage}x) - Lending Pool buying for user ${takerWallet.slice(0,8)}`);
      transactionService.executeLeveragedMatch({
        marketPubkey: marketPubkey,
        makerOrderId: fill.makerOrderId,
        takerOrderId: fill.takerOrderId,
        makerWallet,
        userWallet: takerWallet,  // User wallet for tracking (NOT used on-chain)
        makerSide: fill.makerSide,
        takerSide: fill.takerSide,
        outcome: fill.outcome,
        price: fill.price,
        matchSize: fill.size,
        takerFee: fill.takerFee,
        makerClientOrderId: fill.makerClientOrderId,
        takerClientOrderId: fill.takerClientOrderId,
        leverage: fill.leverage,
        marginAmount: fill.marginAmount,
        loanAmount: fill.loanAmount,
      }).then(async result => {
        if (!result.success) {
          logger.error(`On-chain leveraged match failed: ${result.error}`);
        } else {
          logger.info(`On-chain leveraged match success: ${result.signature}`);
          
          // Confirm margin account on-chain (allows liquidation checker to proceed)
          // The margin account is created in orders.ts after matching completes
          // We need to find it by userId + marketId and mark it as confirmed
          try {
            const marginAccount = await marginService.getByUserAndMarket(fill.takerUserId, marketId);
            if (marginAccount && !marginAccount.onChainConfirmedAt) {
              await marginService.confirmOnChain(marginAccount.id);
              logger.info(`[Leveraged] Margin account ${marginAccount.id} confirmed on-chain`);
            }
          } catch (confirmErr: any) {
            // Non-fatal: liquidation checker will retry
            logger.warn(`[Leveraged] Failed to confirm margin account: ${confirmErr.message}`);
          }
        }
      }).catch(err => logger.error(`On-chain leveraged match failed: ${err.message}`));
      return;
    }
    
    // Regular opening trade (or fallback) - use execute_match instruction
    // Use a unique tradeId per fill to avoid BullMQ jobId collisions
    const tradeId = fill.takerOrderId + '-' + Date.now();
    this.executeMatchOnChain(fill, marketPubkey, makerWallet, takerWallet, tradeId);
  }

  /**
   * Helper to get wallet address for a user (cached to avoid DB lookups in hot path)
   */
  private walletCache = new Map<string, { wallet: string; expiresAt: number }>();
  private async getWalletForUser(userId: string): Promise<string> {
    const cached = this.walletCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.wallet;
    }
    const user = await userService.findById(userId);
    const wallet = user?.walletAddress || '';
    // Cache for 5 minutes (wallet addresses don't change)
    this.walletCache.set(userId, { wallet, expiresAt: Date.now() + 300_000 });
    return wallet;
  }

  /**
   * Check if a user has approved the relayer to spend USDC
   * and if the delegated amount is sufficient for the order.
   */
  async checkDelegation(userId: string, requiredAmount: number): Promise<{
    isApproved: boolean;
    delegatedAmount: number;
    error?: string;
  }> {
    const userWallet = await this.getWalletForUser(userId);
    if (!userWallet) return { isApproved: false, delegatedAmount: 0, error: 'User wallet not found' };

    const relayerAddress = anchorClient.getRelayerPublicKey();
    if (!relayerAddress) return { isApproved: false, delegatedAmount: 0, error: 'Relayer not initialized' };

    try {
      const balanceInfo = await anchorClient.getDelegationInfo(userWallet, relayerAddress);
      const isApproved = balanceInfo.delegate === relayerAddress;
      const delegatedAmount = balanceInfo.delegatedAmount / 1_000_000;

      if (!isApproved) {
        return { isApproved: false, delegatedAmount: 0, error: 'Instant trading not enabled. Please click "Enable fast mode" in the trade modal.' };
      }

      if (delegatedAmount < requiredAmount) {
        return { 
          isApproved: true, 
          delegatedAmount, 
          error: `Insufficient delegation. You delegated $${delegatedAmount.toFixed(2)}, but this order requires $${requiredAmount.toFixed(2)} (including fees).` 
        };
      }

      return { isApproved: true, delegatedAmount };
    } catch (err: any) {
      return { isApproved: false, delegatedAmount: 0, error: `Failed to check on-chain delegation: ${err.message}` };
    }
  }

  /**
   * Helper to execute an opening trade match on-chain
   */
  private executeMatchOnChain(
    fill: Fill,
    marketPubkey: string,
    makerWallet: string,
    takerWallet: string,
    tradeId: string
  ): void {
    const matchParams: MatchParams = {
      marketPubkey: marketPubkey,
      makerOrderId: fill.makerOrderId,
      takerOrderId: fill.takerOrderId,
      makerWallet,
      takerWallet,
      makerUserId: fill.makerUserId,
      takerUserId: fill.takerUserId,
      makerSide: fill.makerSide,
      takerSide: fill.takerSide,
      outcome: fill.outcome,
      price: fill.price,
      matchSize: fill.size,
      takerFee: fill.takerFee,  // Tiered fee calculated by fee.service.ts
      makerClientOrderId: fill.makerClientOrderId,
      takerClientOrderId: fill.takerClientOrderId,
      makerOrderPda: fill.makerOrderPda,
      takerOrderPda: fill.takerOrderPda,
      makerSignature: fill.makerSignature,
      takerSignature: fill.takerSignature,
      makerMessage: fill.makerMessage,
      takerMessage: fill.takerMessage,
    };

    const matchIdempotencyKey = `match-${tradeId}`;
    onchainSubmitQueue.add('match', {
      type: 'match' as const,
      idempotencyKey: matchIdempotencyKey,
      payload: matchParams,
    }, { jobId: matchIdempotencyKey }).catch((err: any) => {
      logger.error(`Failed to enqueue match job: ${err.message}`);
    });
  }

  /**
   * Process an order: match first, then add remainder to book
   * 
   * Order Type Handling:
   * - LIMIT: Match what you can, add remainder to book
   * - MARKET: Match what you can at any price, don't add to book
   * - IOC (Immediate-Or-Cancel): Match what you can, cancel remainder
   * - FOK (Fill-Or-Kill): Only fill if entire order can be matched
   */
  async processOrder(order: OrderbookOrder): Promise<{
    fills: Fill[];
    addedToBook: boolean;
    sequenceId: number;
  }> {
    const orderType = order.orderType || 'LIMIT';
    logger.debug(`[processOrder] ${order.side} ${order.outcome} ${order.remainingSize} @ ${order.price} (type: ${orderType})`);
    
    // For FOK orders, check if we CAN fill the entire order first (without modifying state)
    if (orderType === 'FOK') {
      const availableSize = await this.getAvailableMatchSize(order);
      if (availableSize < order.remainingSize) {
        // Can't fill everything - reject the FOK order
        logger.debug(`FOK order ${order.id} rejected: only ${availableSize} available, need ${order.remainingSize}`);
        return {
          fills: [],
          addedToBook: false,
          sequenceId: 0,
        };
      }
    }
    
    // Try to match
    const matchResult = await this.matchOrder(order);
    
    let sequenceId = 0;
    let addedToBook = false;
    
    // Process fills
    for (const fill of matchResult.fills) {
      await this.processFill(fill, order.marketId, true); // Skip individual on-chain matches
    }

    // Execute aggregated matches on-chain (efficiency boost)
    if (matchResult.fills.length > 0) {
      this.executeFillsOnChain(matchResult.fills, order.marketId)
        .catch(err => logger.error(`Failed to execute aggregated fills on-chain: ${err.message}`));
    }
    
    // Add remainder to orderbook (only for LIMIT orders)
    // MARKET, IOC, and FOK orders don't rest on the book
    const shouldAddToBook = orderType === 'LIMIT' && matchResult.remainingSize > 0;
    
    if (shouldAddToBook) {
      const updatedOrder: OrderbookOrder = {
        ...order,
        remainingSize: matchResult.remainingSize,
      };
      
      const result = await orderbookService.addOrder(updatedOrder);
      sequenceId = result.sequenceId;
      addedToBook = true;
      
      // Broadcast orderbook update (use pubkey for channel, frontend subscribes by address)
      const snapshot = await orderbookService.getSnapshot(order.marketId, order.outcome);
      const marketForBroadcast = await marketService.getById(order.marketId);
      broadcastOrderbookUpdate(
        marketForBroadcast?.pubkey || order.marketId,
        snapshot.bids.map(l => [l.price, l.size] as [number, number]),
        snapshot.asks.map(l => [l.price, l.size] as [number, number]),
        sequenceId,
        order.outcome  // FIX: Pass the correct outcome so YES/NO don't get mixed up!
      );
    } else if (matchResult.remainingSize > 0 && orderType !== 'LIMIT') {
      // Log that the order was partially filled but remainder was cancelled
      logger.debug(
        `${orderType} order ${order.id}: filled ${order.size - matchResult.remainingSize}, ` +
        `cancelled remaining ${matchResult.remainingSize}`
      );
    }
    
    return {
      fills: matchResult.fills,
      addedToBook,
      sequenceId,
    };
  }

  /**
   * Process a single fill - update database, positions, broadcast, and execute on-chain
   */
  private async processFill(fill: Fill, marketId: string, skipOnChain: boolean = false): Promise<void> {
    // Calculate both perspectives
    const takerSide = fill.takerSide; // BID or ASK
    const takerOutcome = fill.outcome; // What taker is acquiring (e.g., YES)
    const takerPrice = fill.price; // Price per contract for taker's outcome
    const takerNotional = takerPrice * fill.size; // Total taker pays
    
    // Maker gets the opposite outcome
    const makerOutcome = takerOutcome === 'YES' ? 'NO' : 'YES';
    const makerPrice = 1 - takerPrice; // Complementary price (e.g., 0.48 if taker pays 0.52)
    const makerNotional = makerPrice * fill.size; // Total maker pays
    
    // Create trade record in database with both perspectives
    logger.debug(`Inserting trade: taker=${takerSide} ${takerOutcome}@${takerPrice}, maker=${makerOutcome}@${makerPrice}, size=${fill.size}`);
    const [trade] = await db
      .insert(trades)
      .values({
        marketId,
        makerOrderId: this.tradeOrderIdForDb(fill.makerUserId, fill.makerOrderId),
        takerOrderId: this.tradeOrderIdForDb(fill.takerUserId, fill.takerOrderId),
        makerUserId: fill.makerUserId,
        takerUserId: fill.takerUserId,
        // Taker's perspective
        takerSide: takerSide,
        takerOutcome: takerOutcome,
        takerPrice: takerPrice.toString(),
        takerNotional: takerNotional.toString(),
        takerFee: fill.takerFee.toString(),
        // Maker's perspective
        makerOutcome: makerOutcome,
        makerPrice: makerPrice.toString(),
        makerNotional: makerNotional.toString(),
        makerFee: fill.makerFee.toString(),
        // Common fields
        size: fill.size.toString(),
        txStatus: 'PENDING',
        // Legacy fields (for backwards compatibility)
        outcome: fill.outcome,
        price: fill.price.toString(),
        notional: takerNotional.toString(),
      })
      .returning();
    
    // Update order records in database
    if (!(config.disableMmOrderPersistence && this.isMarketMaker(fill.makerUserId))) {
      await orderService.updateAfterFill(fill.makerOrderId, fill.size);
    }
    if (!(config.disableMmOrderPersistence && this.isMarketMaker(fill.takerUserId))) {
      await orderService.updateAfterFill(fill.takerOrderId, fill.size);
    }
    
    // Update positions (off-chain tracking)
    // For OPENING trades: Both parties acquire shares (taker gets takerOutcome, maker gets opposite)
    // For CLOSING trades: Seller (ASK) loses shares, buyer (BID) gains shares
    
    // Determine if taker is buying (BID) or selling (ASK)
    const takerIsBuying = fill.takerSide === 'BID';
    
    if (takerIsBuying) {
      // OPENING TRADE: Taker is buying, maker is providing liquidity
      // Taker gains takerOutcome shares
      await positionService.updateAfterTrade(
        fill.takerUserId,
        marketId,
        takerOutcome,
        fill.size,
        takerNotional + fill.takerFee,
        true  // Taker is BUYING their outcome
      );
      
      // Maker gains opposite outcome shares  
      await positionService.updateAfterTrade(
        fill.makerUserId,
        marketId,
        makerOutcome,
        fill.size,
        makerNotional - fill.makerFee,
        true  // Maker is ACQUIRING the opposite outcome
      );
    } else {
      // CLOSING TRADE: Taker is selling, maker is buying
      // Taker loses takerOutcome shares, receives USDC
      await positionService.updateAfterTrade(
        fill.takerUserId,
        marketId,
        takerOutcome,
        fill.size,
        takerNotional - fill.takerFee,  // Proceeds (minus fee)
        false  // Taker is SELLING their outcome
      );
      
      // Maker gains takerOutcome shares (buying what taker is selling)
      await positionService.updateAfterTrade(
        fill.makerUserId,
        marketId,
        takerOutcome,  // Maker buys same outcome taker is selling
        fill.size,
        takerNotional + fill.makerFee,
        true  // Maker is BUYING
      );
    }
    
    // Update user stats
    await userService.updateTradeStats(fill.takerUserId, takerNotional);
    await userService.updateTradeStats(fill.makerUserId, makerNotional);
    
    // Update market stats (total volume = both sides)
    await marketService.incrementStats(marketId, takerNotional + makerNotional);
    await marketService.updatePrices(marketId, fill.price, 1 - fill.price);
    
    // Get market for broadcast and on-chain execution
    const market = await marketService.getById(marketId);
    
    // Execute on-chain transaction
    if (market && !skipOnChain) {
      try {
        // Derive the correct on-chain PDA from market data
        const expiryTs = Math.floor(market.expiryAt.getTime() / 1000);
        const onChainMarketPda = getMarketPda(market.asset, market.timeframe, expiryTs);
        
        // Get wallet addresses
        const makerWallet = await this.getWalletForUser(fill.makerUserId);
        const takerWallet = await this.getWalletForUser(fill.takerUserId);
        
        // Detect if this is a closing trade (taker is selling existing shares)
        const isClosingTrade = fill.takerSide === 'ASK';
        
        if (isClosingTrade) {
          // Check if seller has existing shares
          const sellerPosition = await positionService.getPosition(fill.takerUserId, marketId);
          const sellerShares = fill.outcome === 'YES'
            ? parseFloat(sellerPosition?.yesShares || '0')
            : parseFloat(sellerPosition?.noShares || '0');
          
          if (sellerShares >= fill.size) {
            // True closing trade - use execute_close instruction
            const closeParams: CloseParams = {
              marketPubkey: onChainMarketPda.toBase58(),
              buyerWallet: makerWallet,  // Maker is buying
              sellerWallet: takerWallet, // Taker is selling
              outcome: fill.outcome,
              price: fill.price,
              matchSize: fill.size,
              takerFee: fill.takerFee,  // Tiered fee calculated by fee.service.ts
              tradeId: trade.id,  // Pass trade ID to update with tx signature
            };
            
            const closeIdempotencyKey = `close-${trade.id}`;
            onchainSubmitQueue.add('close', {
              type: 'close' as const,
              idempotencyKey: closeIdempotencyKey,
              payload: closeParams,
            }, { jobId: closeIdempotencyKey }).catch((err: any) => {
              logger.error(`Failed to enqueue close job: ${err.message}`);
            });
          } else {
            // Seller doesn't have enough shares - use opening trade
            logger.debug(`Taker selling but insufficient shares (${sellerShares} < ${fill.size}), using execute_match`);
            this.executeMatchOnChain(fill, onChainMarketPda.toBase58(), makerWallet, takerWallet, trade.id);
          }
        } else {
          // Opening trade - use execute_match instruction
          this.executeMatchOnChain(fill, onChainMarketPda.toBase58(), makerWallet, takerWallet, trade.id);
        }
      } catch (err: any) {
        logger.error(`Failed to initiate on-chain transaction: ${err.message}`);
        // Trade is still recorded off-chain for retry
      }
    }
    
    // Broadcast trade
    broadcastTrade(marketId, {
      price: fill.price,
      size: fill.size,
      outcome: fill.outcome.toLowerCase(),
      side: fill.takerSide === 'BID' ? 'buy' : 'sell',
      timestamp: Date.now(),
    });
    
    // Notify users of fills
    const makerOrder = await orderService.getById(fill.makerOrderId);
    const takerOrder = await orderService.getById(fill.takerOrderId);
    
    if (makerOrder) {
      broadcastUserFill(fill.makerUserId, {
        orderId: fill.makerOrderId,
        marketAddress: market?.pubkey || '',
        side: this.toWsSide(makerOrder.side || ''),
        outcome: this.toWsOutcome(fill.outcome),
        price: fill.price,
        filledSize: fill.size,
        remainingSize: 0,
        status: 'filled',
        timestamp: Date.now(),
      });
    }
    
    if (takerOrder) {
      broadcastUserFill(fill.takerUserId, {
        orderId: fill.takerOrderId,
        marketAddress: market?.pubkey || '',
        side: this.toWsSide(takerOrder.side || ''),
        outcome: this.toWsOutcome(fill.outcome),
        price: fill.price,
        filledSize: fill.size,
        remainingSize: 0,
        status: 'filled',
        timestamp: Date.now(),
      });
    }
    
    // Log trade execution with structured logger
    logEvents.tradeExecuted({
      tradeId: trade.id,
      marketId,
      asset: market?.asset || 'UNKNOWN',
      timeframe: market?.timeframe || 'UNKNOWN',
      makerOrderId: fill.makerOrderId,
      takerOrderId: fill.takerOrderId,
      makerUserId: fill.makerUserId,
      takerUserId: fill.takerUserId,
      price: fill.price,
      size: fill.size,
      outcome: fill.outcome,
      takerSide: fill.takerSide,
      notional: takerNotional,
      makerFee: fill.makerFee,
      takerFee: fill.takerFee,
    });
  }

  // ========================================================================
  // BATCH DB OPERATIONS (Performance Optimization)
  // Reduces 110+ queries per order to ~10 queries by batching and aggregating
  // ========================================================================

  /**
   * Process all fills for an order in background with batched DB operations.
   * This runs AFTER on-chain execution has started, so the user gets instant response.
   * 
   * Optimization: Instead of 11 queries per fill (110 for 10 fills), we:
   * - Batch insert all trades (1 query)
   * - Aggregate position updates per user (2-4 queries)
   * - Aggregate user stats (2 queries)
   * - Update market stats once (1 query)
   */
  private async processFillsInBackground(
    fills: Fill[],
    order: DollarMarketOrder,
    market: { id: string; pubkey: string; asset?: string; timeframe?: string },
    skipTakerPosition: boolean = false,
    feeInfo?: { dollarAmount: number; upfrontFee: number },
  ): Promise<void> {
    logger.info(`[DEBUG] processFillsInBackground: fills=${fills.length}, market=${order.marketId.slice(0,8)}, perfTestMode=${config.perfTestMode}`);
    if (fills.length === 0) return;
    
    // Throttle concurrent background DB work to avoid pool exhaustion
    await this.acquireBgDbSlot();
    const startTime = Date.now();
    
    try {
      // 1. BATCH INSERT ALL TRADES (1 query instead of N)
      const takerIsBuying = order.side === 'BID';
      const tradeRecords = fills.map(fill => {
        const takerPrice = fill.price;
        const takerNotional = takerPrice * fill.size;
        // Maker gets opposite outcome when taker is buying, same when selling
        const makerOutcome = takerIsBuying
          ? (fill.outcome === 'YES' ? 'NO' : 'YES')
          : fill.outcome;
        const makerPrice = takerIsBuying ? (1 - takerPrice) : takerPrice;
        const makerNotional = makerPrice * fill.size;
        return {
          marketId: order.marketId,
          makerOrderId: this.tradeOrderIdForDb(fill.makerUserId, fill.makerOrderId),
          takerOrderId: this.tradeOrderIdForDb(fill.takerUserId, fill.takerOrderId),
          makerUserId: fill.makerUserId,
          takerUserId: fill.takerUserId,
          takerSide: order.side,
          takerOutcome: fill.outcome,
          takerPrice: takerPrice.toString(),
          takerNotional: takerNotional.toString(),
          takerFee: fill.takerFee.toString(),
          makerOutcome,
          makerPrice: makerPrice.toString(),
          makerNotional: makerNotional.toString(),
          makerFee: fill.makerFee.toString(),
          size: fill.size.toString(),
          txStatus: 'PENDING' as const,
          outcome: fill.outcome,
          price: fill.price.toString(),
          notional: takerNotional.toString(),
        };
      });
      
      // ── PERF MODE: Use write-behind for trades instead of direct DB insert ──
      // Direct DB insert competes for pool connections and takes 600-1400ms.
      // Write-behind batches them efficiently (1 query per batch, not per trade).
      if (config.perfTestMode) {
        // Enqueue trades to write-behind (instant — no DB round trip)
        writeBehindService.enqueueTrades(tradeRecords as any);
        
        // Broadcast trades via WebSocket (no DB)
        const tradeTimestamp = Date.now();
        for (const fill of fills) {
          const tradeSide = fill.takerSide === 'BID' ? 'buy' : 'sell';
          const tradeOutcome = String(fill.outcome).toLowerCase() as 'yes' | 'no';
          broadcastTrade(market.pubkey, {
            price: fill.price,
            size: fill.size,
            side: tradeSide,
            outcome: tradeOutcome,
            timestamp: tradeTimestamp,
            takerWallet: '',
          });
        }

        // CRITICAL: Update market volume stats — required for merkle settlement to work
        // (Without this, total_volume stays 0 and merkle settler skips the market)
        const totalVolume = fills.reduce((sum, f) => sum + 2 * f.price * f.size, 0);
        const lastFill = fills[fills.length - 1];
        logger.info(`[PERF] Volume update: market=${order.marketId.slice(0,8)}, fills=${fills.length}, volume=${totalVolume.toFixed(2)}`);
        marketService.incrementStats(order.marketId, totalVolume)
          .then(() => logger.info(`[PERF] Volume incremented for ${order.marketId.slice(0,8)}: +${totalVolume.toFixed(2)}`))
          .catch(err => logger.error(`Market stats update failed: ${err.message}`));
        marketService.updatePrices(order.marketId, lastFill.price, 1 - lastFill.price)
          .catch(err => logger.error(`Market price update failed: ${err.message}`));

        // ALSO create positions in perf mode (required for settlement testing)
        const positionUpdates = this.aggregateFillsForPositions(fills, order, feeInfo);
        for (const update of positionUpdates) {
          positionService.updateAfterTrade(
            update.userId,
            order.marketId,
            update.outcome,
            update.totalShares,
            update.totalCost,
            update.isBuy
          ).catch(err => logger.error(`[PERF] Position update failed: ${err.message}`));
        }
        logger.info(`[PERF] Created ${positionUpdates.length} position updates for settlement testing`);

        return; // Skip user stats — handled separately for perf mode
      }
      
      // Ensure the taker order is persisted before inserting trades.
      // The order was enqueued to write-behind (async) and may not be flushed yet,
      // which would violate the trades.taker_order_id FK constraint.
      const takerOrderId = fills[0]?.takerOrderId;
      if (takerOrderId) {
        await writeBehindService.flushOrderById(takerOrderId);
      }

      // Normal mode: Direct DB insert with returning() for trade IDs
      const insertedTrades = await db.insert(trades).values(tradeRecords).returning();
      
      // 2. AGGREGATE POSITION UPDATES (parallel — not sequential)
      const positionUpdates = this.aggregateFillsForPositions(fills, order, feeInfo);
      
      const positionPromises = positionUpdates
        .filter(update => !(skipTakerPosition && update.userId === order.userId))
        .map(update =>
          positionService.updateAfterTrade(
            update.userId,
            order.marketId,
            update.outcome,
            update.totalShares,
            update.totalCost,
            update.isBuy
          ).catch(err => logger.error(`Position update failed for ${update.userId}: ${err.message}`))
        );
      
      // 3. AGGREGATE USER STATS (parallel with positions)
      const takerNotional = fills.reduce((sum, f) => sum + f.price * f.size, 0);
      const statsPromises: Promise<any>[] = [
        userService.updateTradeStats(order.userId, takerNotional)
          .catch(err => logger.error(`Taker stats update failed: ${err.message}`)),
      ];
      
      const makerVolumes = new Map<string, number>();
      for (const fill of fills) {
        const current = makerVolumes.get(fill.makerUserId) || 0;
        makerVolumes.set(fill.makerUserId, current + fill.price * fill.size);
      }
      for (const [makerId, volume] of makerVolumes) {
        if (makerId !== order.userId) {
          statsPromises.push(
            userService.updateTradeStats(makerId, volume)
              .catch(err => logger.error(`Maker stats update failed: ${err.message}`))
          );
        }
      }
      
      // 4. UPDATE MARKET STATS (parallel with positions + user stats)
      const totalVolume = fills.reduce((sum, f) => sum + 2 * f.price * f.size, 0);
      const lastFill = fills[fills.length - 1];
      const marketPromises = [
        marketService.incrementStats(order.marketId, totalVolume)
          .catch(err => logger.error(`Market stats update failed: ${err.message}`)),
        marketService.updatePrices(order.marketId, lastFill.price, 1 - lastFill.price)
          .catch(err => logger.error(`Market price update failed: ${err.message}`)),
      ];
      
      // Run ALL background DB work in parallel
      await Promise.allSettled([...positionPromises, ...statsPromises, ...marketPromises]);
      
      // 5. BROADCAST TRADES (WebSocket - no DB queries)
      const takerWallet = await this.getWalletForUser(order.userId).catch(() => '');
      const tradeTimestamp = Date.now();
      
      for (let i = 0; i < fills.length; i++) {
        const fill = fills[i];
        const trade = insertedTrades[i];
        const tradeSide = fill.takerSide === 'BID' ? 'buy' : 'sell';
        const tradeOutcome = String(fill.outcome).toLowerCase() as 'yes' | 'no';
        
        // Market-specific trade feed
        broadcastTrade(market.pubkey, {
          price: fill.price,
          size: fill.size,
          side: tradeSide,
          outcome: tradeOutcome,
          timestamp: tradeTimestamp,
          takerWallet,
        });
        
        // Global trade blotter
        broadcastGlobalTrade({
          id: trade.id,
          market: `${market.asset}-${market.timeframe}`,
          marketAddress: market.pubkey,
          asset: market.asset || '',
          timeframe: market.timeframe || '',
          side: tradeSide as 'buy' | 'sell',
          outcome: tradeOutcome,
          price: fill.price,
          size: fill.size,
          notional: fill.price * fill.size,
          txSignature: null,
          timestamp: tradeTimestamp,
        });
        
        // User fills
        broadcastUserFill(fill.takerUserId, {
          orderId: fill.takerOrderId,
          marketAddress: market.pubkey,
          side: this.toWsSide(fill.takerSide),
          outcome: this.toWsOutcome(fill.outcome),
          price: fill.price,
          filledSize: fill.size,
          remainingSize: 0,
          status: 'filled',
          timestamp: tradeTimestamp,
        });
        
        broadcastUserFill(fill.makerUserId, {
          orderId: fill.makerOrderId,
          marketAddress: market.pubkey,
          side: this.toWsSide(fill.makerSide),
          outcome: this.toWsOutcome(fill.outcome),
          price: fill.price,
          filledSize: fill.size,
          remainingSize: 0,
          status: 'filled',
          timestamp: tradeTimestamp,
        });
      }
      
      // 6. UPDATE MAKER ORDERS (parallel — only for non-MM synthetic orders)
      const makerUpdatePromises = fills
        .filter(fill => {
          const makerOrderIsSynthetic = String(fill.makerOrderId || '').startsWith('mm_synth_');
          return !makerOrderIsSynthetic && !(config.disableMmOrderPersistence && this.isMarketMaker(fill.makerUserId));
        })
        .map(fill =>
          orderService.updateAfterFill(fill.makerOrderId, fill.size)
            .catch(err => logger.error(`Maker order update failed: ${err.message}`))
        );
      if (makerUpdatePromises.length > 0) {
        await Promise.allSettled(makerUpdatePromises);
      }
      
      const elapsed = Date.now() - startTime;
      logger.debug(`[PERF] Background DB processing for ${fills.length} fills completed in ${elapsed}ms`);
      
    } catch (err: any) {
      logger.error(`Background fill processing failed: ${err.message}`);
      // Non-fatal: on-chain execution already happened, user has their position
    } finally {
      this.releaseBgDbSlot();
    }
  }

  /**
   * Aggregate fills into position updates.
   * Groups by user+outcome to minimize DB queries.
   */
  private aggregateFillsForPositions(
    fills: Fill[],
    order: DollarMarketOrder,
    opts?: { dollarAmount?: number; upfrontFee?: number }
  ): Array<{
    userId: string;
    outcome: 'YES' | 'NO';
    totalShares: number;
    totalCost: number;
    isBuy: boolean;
  }> {
    const updates: Array<{
      userId: string;
      outcome: 'YES' | 'NO';
      totalShares: number;
      totalCost: number;
      isBuy: boolean;
    }> = [];
    
    // Taker position update (all fills aggregate to one update)
    const takerIsBuy = order.side === 'BID';
    const takerOutcomes = new Map<'YES' | 'NO', { shares: number; cost: number }>();
    
    for (const fill of fills) {
      const current = takerOutcomes.get(fill.outcome) || { shares: 0, cost: 0 };
      const notional = fill.price * fill.size;
      current.shares += fill.size;
      current.cost += takerIsBuy ? notional + fill.takerFee : notional - fill.takerFee;
      takerOutcomes.set(fill.outcome, current);
    }
    
    // When upfrontFee is provided (dollar market orders), use dollarAmount as the
    // taker's total cost so the DB position reflects the user's full selected amount.
    // This ensures PnL shows the fee as an initial loss.
    if (opts?.dollarAmount && opts?.upfrontFee && takerIsBuy && takerOutcomes.size === 1) {
      const [outcome, data] = [...takerOutcomes.entries()][0];
      data.cost = opts.dollarAmount;
      takerOutcomes.set(outcome, data);
    }
    
    for (const [outcome, data] of takerOutcomes) {
      updates.push({
        userId: order.userId,
        outcome,
        totalShares: data.shares,
        totalCost: data.cost,
        isBuy: takerIsBuy,
      });
    }
    
    // Maker position updates (group by maker+outcome)
    // When taker BIDs (buys), maker ACQUIRES the opposite outcome (e.g., taker buys YES → maker gets NO)
    // When taker ASKs (sells), maker ACQUIRES the same outcome (e.g., taker sells YES → maker buys YES)
    // In both cases the maker is always buying (isBuy=true), matching processFill behavior.
    const makerUpdates = new Map<string, { shares: number; cost: number }>();
    
    for (const fill of fills) {
      // Maker's outcome depends on taker direction:
      // BID: maker gets opposite (taker buys YES → maker buys NO)
      // ASK: maker gets same (taker sells YES → maker buys YES)
      const makerOutcome: 'YES' | 'NO' = takerIsBuy
        ? (fill.outcome === 'YES' ? 'NO' : 'YES')
        : fill.outcome;
      const key = `${fill.makerUserId}:${makerOutcome}`;
      const current = makerUpdates.get(key) || { shares: 0, cost: 0 };
      if (takerIsBuy) {
        // Maker pays complement price: (1 - fill.price) * size - makerFee
        const complementNotional = (1 - fill.price) * fill.size;
        current.cost += complementNotional - fill.makerFee;
      } else {
        // Maker pays fill price: fill.price * size + makerFee
        const notional = fill.price * fill.size;
        current.cost += notional + fill.makerFee;
      }
      current.shares += fill.size;
      makerUpdates.set(key, current);
    }
    
    for (const [key, data] of makerUpdates) {
      const [makerId, outcome] = key.split(':');
      updates.push({
        userId: makerId,
        outcome: outcome as 'YES' | 'NO',
        totalShares: data.shares,
        totalCost: data.cost,
        isBuy: true, // Maker always acquires shares (buying)
      });
    }
    
    return updates;
  }

  /**
   * Cancel an order and remove from orderbook
   */
  async cancelOrder(orderId: string, userId: string): Promise<boolean> {
    const order = await orderService.getById(orderId);
    
    if (!order) {
      return false;
    }
    
    if (order.userId !== userId) {
      return false;
    }
    
    if (order.status !== 'OPEN' && order.status !== 'PARTIAL') {
      return false;
    }
    
    // Remove from orderbook
    const orderbookOrder: OrderbookOrder = {
      id: order.id,
      marketId: order.marketId!,
      userId: order.userId!,
      side: order.side as 'BID' | 'ASK',
      outcome: order.outcome as 'YES' | 'NO',
      price: parseFloat(order.price),
      size: parseFloat(order.size),
      remainingSize: parseFloat(order.remainingSize || '0'),
      createdAt: order.createdAt?.getTime() || Date.now(),
    };
    
    const { sequenceId } = await orderbookService.removeOrder(orderbookOrder);
    
    // Update database
    await orderService.cancel(orderId, 'USER');
    
    // Broadcast orderbook update (use pubkey for channel, frontend subscribes by address)
    const snapshot = await orderbookService.getSnapshot(
      order.marketId!,
      order.outcome as 'YES' | 'NO'
    );
    const marketForCancel = await marketService.getById(order.marketId!);
    broadcastOrderbookUpdate(
      marketForCancel?.pubkey || order.marketId!,
      snapshot.bids.map(l => [l.price, l.size] as [number, number]),
      snapshot.asks.map(l => [l.price, l.size] as [number, number]),
      sequenceId,
      order.outcome as 'YES' | 'NO'  // FIX: Pass the correct outcome!
    );
    
    return true;
  }
}

export const matchingService = new MatchingService();


