import { orderbookService, OrderbookOrder } from './orderbook.service.js';
import { orderService } from './order.service.js';
import { positionService } from './position.service.js';
import { marketService } from './market.service.js';
import { userService } from './user.service.js';
import { transactionService, MatchParams, CloseParams } from './transaction.service.js';
import { getMarketPda, anchorClient } from '../lib/anchor-client.js';
import { db, trades, type NewTrade } from '../db/index.js';
import { logger, tradeLogger, orderLogger, logEvents } from '../lib/logger.js';
import { broadcastOrderbookUpdate, broadcastTrade, broadcastUserFill } from '../lib/broadcasts.js';
import { config } from '../config.js';
import { mmBot } from '../bot/mm-bot.js';

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
}

// Fee configuration (in basis points) - Moved to config.ts
const MAKER_FEE_BPS = config.makerFeeBps;
const TAKER_FEE_BPS = config.takerFeeBps;

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
}

export interface DollarMatchResult {
  fills: Fill[];
  totalSpent: number;
  totalContracts: number;
  avgPrice: number;
  unfilledDollars: number;
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
}

export interface SellMatchResult {
  fills: Fill[];
  totalProceeds: number;    // Total USDC received
  totalSold: number;        // Total contracts sold
  avgPrice: number;
  remainingSize: number;    // Unsold contracts
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
   * Helper to check if a user is the Market Maker bot
   */
  private isMarketMaker(userId: string): boolean {
    const mmStatus = mmBot.getStatus();
    return userId === mmStatus.userId;
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
    
    // Determine which side of the book to match against
    // BID (buy) matches against ASK (sell) and vice versa
    const matchSide = takerOrder.side === 'BID' ? 'ASK' : 'BID';
    
    // For MARKET orders, use extreme prices to guarantee matching
    // BID (buy) uses 0.99 to match any ask
    // ASK (sell) uses 0.01 to match any bid
    const isMarketOrder = takerOrder.orderType === 'MARKET';
    const effectivePrice = isMarketOrder
      ? (takerOrder.side === 'BID' ? 0.99 : 0.01)
      : takerOrder.price;
    
    logger.debug(
      `Matching ${takerOrder.side} ${takerOrder.outcome} ${takerOrder.orderType || 'LIMIT'} order for ` +
      `${takerOrder.remainingSize} @ ${takerOrder.price} (effective: ${effectivePrice})`
    );
    
    while (remainingSize > 0) {
      // Get best opposing order
      const bestOrder = matchSide === 'ASK'
        ? await orderbookService.getBestAsk(takerOrder.marketId, takerOrder.outcome)
        : await orderbookService.getBestBid(takerOrder.marketId, takerOrder.outcome);
      
      if (!bestOrder) {
        logger.debug('No opposing orders in book');
        break;
      }
      
      // Check if prices cross
      // For market orders, use effective price (0.99 for BID, 0.01 for ASK) to guarantee crossing
      const pricesCross = takerOrder.side === 'BID'
        ? effectivePrice >= bestOrder.price  // Buyer willing to pay >= seller asking
        : effectivePrice <= bestOrder.price; // Seller willing to accept <= buyer bidding
      
      if (!pricesCross) {
        logger.debug(`Prices don't cross: taker ${effectivePrice} vs maker ${bestOrder.price}`);
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
      
      // Execute at maker's price (price improvement for taker)
      const fillPrice = bestOrder.price;
      
      // Calculate fees
      const notional = fillPrice * fillSize;
      const makerFee = (notional * MAKER_FEE_BPS) / 10000;
      const takerFee = (notional * TAKER_FEE_BPS) / 10000;
      
      // Create fill record with order PDAs for on-chain verification
      const fill: Fill = {
        makerOrderId: bestOrder.id,
        takerOrderId: takerOrder.id,
        makerUserId: bestOrder.userId,
        takerUserId: takerOrder.userId,
        price: fillPrice,
        size: fillSize,
        outcome: takerOrder.outcome,
        makerFee,
        takerFee,
        makerSide: bestOrder.side,
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
      };
      
      fills.push(fill);
      
      // Update maker order in orderbook
      const newMakerRemaining = bestOrder.remainingSize - fillSize;
      if (newMakerRemaining > 0) {
        await orderbookService.updateOrderSize(bestOrder, newMakerRemaining);
      } else {
        await orderbookService.removeOrder(bestOrder);
      }
      
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
   * @param order Dollar-based market order parameters
   * @returns Match result with all fills and aggregated stats
   */
  async matchMarketOrderByDollar(order: DollarMarketOrder): Promise<DollarMatchResult> {
    const fills: Fill[] = [];
    let remainingDollars = order.dollarAmount;
    let totalContracts = 0;
    let totalSpent = 0;
    
    // For BID (buy), match against ASKs
    // For ASK (sell), match against BIDs
    const matchSide = order.side === 'BID' ? 'ASK' : 'BID';
    
    logger.info(
      `Walk-the-book MARKET ${order.side} ${order.outcome}: ` +
      `$${order.dollarAmount} (max price: ${order.maxPrice})`
    );
    
    while (remainingDollars > 0) {
      // Get best opposing order
      const bestOrder = matchSide === 'ASK'
        ? await orderbookService.getBestAsk(order.marketId, order.outcome)
        : await orderbookService.getBestBid(order.marketId, order.outcome);
      
      if (!bestOrder) {
        logger.debug('Walk-the-book: No more opposing orders');
        break;
      }
      
      // Check price protection
      const exceedsMaxPrice = order.side === 'BID'
        ? bestOrder.price > order.maxPrice
        : bestOrder.price < order.maxPrice;
      
      if (exceedsMaxPrice) {
        logger.debug(
          `Walk-the-book: Price ${bestOrder.price} exceeds max ${order.maxPrice}`
        );
        break;
      }
      
      // Self-trade prevention
      if (bestOrder.userId === order.userId) {
        logger.debug(`Walk-the-book: Self-trade prevented for user ${order.userId}`);
        // Skip this order and try next
        await orderbookService.removeOrder(bestOrder);
        continue;
      }
      
      // Calculate how many contracts we can afford at this price (fractional allowed)
      const maxContractsAtPrice = remainingDollars / bestOrder.price;
      
      // Minimum fill threshold: 0.01 contracts (1 cent payout worth)
      const MIN_FILL_SIZE = 0.01;
      if (maxContractsAtPrice < MIN_FILL_SIZE) {
        logger.debug(`Walk-the-book: Remaining $${remainingDollars.toFixed(4)} not enough for minimum ${MIN_FILL_SIZE} contracts`);
        break;
      }
      
      // Calculate fill size (minimum of what we can afford and what's available)
      // No Math.floor() - allow fractional contracts
      const fillSize = Math.min(maxContractsAtPrice, bestOrder.remainingSize);
      const fillPrice = bestOrder.price;
      const fillCost = fillSize * fillPrice;
      
      // Calculate fees
      const notional = fillCost;
      const makerFee = (notional * MAKER_FEE_BPS) / 10000;
      const takerFee = (notional * TAKER_FEE_BPS) / 10000;
      
      // Placeholder for taker order ID - will be replaced after order is created
      const takerOrderId = 'pending';
      
      // Create fill record
      const fill: Fill = {
        makerOrderId: bestOrder.id,
        takerOrderId,
        makerUserId: bestOrder.userId,
        takerUserId: order.userId,
        price: fillPrice,
        size: fillSize,
        outcome: order.outcome,
        makerFee,
        takerFee,
        makerSide: bestOrder.side,
        takerSide: order.side,
        makerClientOrderId: bestOrder.clientOrderId || Date.now(),
        takerClientOrderId: order.clientOrderId || Date.now(),
        makerOrderPda: (bestOrder as any).orderPda,
        makerSignature: bestOrder.signature,
        makerMessage: bestOrder.binaryMessage,
        takerSignature: order.signature,
        takerMessage: order.binaryMessage,
      };
      
      fills.push(fill);
      totalContracts += fillSize;
      totalSpent += fillCost;
      remainingDollars -= fillCost;
      
      // Update maker order in orderbook
      const newMakerRemaining = bestOrder.remainingSize - fillSize;
      if (newMakerRemaining > 0) {
        await orderbookService.updateOrderSize(bestOrder, newMakerRemaining);
      } else {
        await orderbookService.removeOrder(bestOrder);
      }
      
      logger.debug(
        `Walk-the-book fill: ${fillSize.toFixed(6)} contracts @ ${fillPrice} = $${fillCost.toFixed(4)} ` +
        `(remaining: $${remainingDollars.toFixed(4)})`
      );
    }
    
    const avgPrice = totalContracts > 0 ? totalSpent / totalContracts : 0;
    
    logger.info(
      `Walk-the-book complete: ${fills.length} fills, ` +
      `${totalContracts.toFixed(6)} contracts @ avg ${avgPrice.toFixed(4)}, ` +
      `spent $${totalSpent.toFixed(2)}, unfilled $${remainingDollars.toFixed(4)}`
    );
    
    return {
      fills,
      totalSpent,
      totalContracts,
      avgPrice,
      unfilledDollars: remainingDollars,
    };
  }

  /**
   * Process a dollar-based MARKET order
   * Creates fills, updates positions, and executes on-chain
   */
  async processMarketOrderByDollar(order: DollarMarketOrder): Promise<DollarMatchResult> {
    // Match against the orderbook (in-memory, instant)
    const result = await this.matchMarketOrderByDollar(order);
    
    if (result.fills.length === 0) {
      return result;
    }
    
    // Create taker order record synchronously (needed for response)
    const takerOrder = await orderService.create({
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
    });
    
    // Update fills with the real taker order ID
    for (const fill of result.fills) {
      fill.takerOrderId = takerOrder.id;
    }
    
    // FIRE-AND-FORGET: Process fills asynchronously for instant response
    // All DB writes, position updates, and on-chain execution happen in background
    this.processFillsAsync(result.fills, order, takerOrder.id, result.totalContracts)
      .catch(err => logger.error(`Async fill processing failed: ${err.message}`));
    
    // Return immediately - user sees instant fill
    return result;
  }

  /**
   * Match sell order against orderbook (walk the bids)
   * Seller wants to sell shares at or above minPrice
   */
  async matchSellOrder(order: SellOrder): Promise<SellMatchResult> {
    const fills: Fill[] = [];
    let remainingSize = order.size;
    let totalProceeds = 0;
    
    logger.info(
      `Sell order: ${order.size} ${order.outcome} contracts (min price: ${order.minPrice})`
    );
    
    while (remainingSize > 0.001) {  // Min 0.001 contracts
      // Get best bid (highest price buyer)
      const bestBid = await orderbookService.getBestBid(order.marketId, order.outcome);
      
      if (!bestBid) {
        logger.debug('Sell order: No more bids');
        break;
      }
      
      // Check price floor (seller won't accept below minPrice)
      if (bestBid.price < order.minPrice) {
        logger.debug(`Sell order: Bid ${bestBid.price} below min ${order.minPrice}`);
        break;
      }
      
      // Self-trade prevention
      if (bestBid.userId === order.userId) {
        logger.debug(`Sell order: Self-trade prevented for user ${order.userId}`);
        await orderbookService.removeOrder(bestBid);
        continue;
      }
      
      // Calculate fill size
      const fillSize = Math.min(remainingSize, bestBid.remainingSize);
      const fillPrice = bestBid.price;
      const fillProceeds = fillSize * fillPrice;
      
      // Calculate fees
      const makerFee = (fillProceeds * MAKER_FEE_BPS) / 10000;
      const takerFee = (fillProceeds * TAKER_FEE_BPS) / 10000;
      
      // Create fill record (seller is taker, buyer is maker)
      const fill: Fill = {
        makerOrderId: bestBid.id,
        takerOrderId: 'pending',  // Will be replaced
        makerUserId: bestBid.userId,  // Buyer (maker)
        takerUserId: order.userId,     // Seller (taker)
        price: fillPrice,
        size: fillSize,
        outcome: order.outcome,
        makerFee,
        takerFee,
        makerSide: 'BID',   // Buyer is bidding
        takerSide: 'ASK',   // Seller is asking
        makerClientOrderId: bestBid.clientOrderId || Date.now(),
        takerClientOrderId: order.clientOrderId || Date.now(),
        makerOrderPda: (bestBid as any).orderPda,
        makerSignature: bestBid.signature,
        makerMessage: bestBid.binaryMessage,
        takerSignature: order.signature,
        takerMessage: order.binaryMessage,
      };
      
      fills.push(fill);
      totalProceeds += fillProceeds;
      remainingSize -= fillSize;
      
      // Update maker order in orderbook
      const newMakerRemaining = bestBid.remainingSize - fillSize;
      if (newMakerRemaining > 0) {
        await orderbookService.updateOrderSize(bestBid, newMakerRemaining);
      } else {
        await orderbookService.removeOrder(bestBid);
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
    
    return {
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
   */
  async processSellOrder(order: SellOrder): Promise<SellMatchResult> {
    // Match against the orderbook (in-memory, instant)
    const result = await this.matchSellOrder(order);
    
    if (result.fills.length === 0) {
      return result;
    }
    
    // Create taker order record synchronously (needed for response)
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
      encodedInstruction: null,  // No on-chain order for sell via delegation
      isMmOrder: false,
      expiresAt: order.expiresAt ? new Date(order.expiresAt) : new Date(Date.now() + 3600000),
    });
    
    // Update fills with the real taker order ID
    for (const fill of result.fills) {
      fill.takerOrderId = takerOrder.id;
    }
    
    // FIRE-AND-FORGET: Process fills asynchronously for instant response
    this.processSellFillsAsync(result.fills, order, takerOrder.id, result.totalSold)
      .catch(err => logger.error(`Async sell fill processing failed: ${err.message}`));
    
    // Return immediately - user sees instant fill
    return result;
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
   * Process fills asynchronously (fire-and-forget from HTTP response)
   * Handles all DB writes, position updates, and on-chain execution
   */
  private async processFillsAsync(
    fills: Fill[],
    order: DollarMarketOrder,
    takerOrderId: string,
    totalContracts: number
  ): Promise<void> {
    try {
      // 1. Process all fills for DB/Stats/Positions (individual records)
      await Promise.all(fills.map(fill => this.processFillForDollarOrderFast(fill, order, true)));
      
      // 2. Execute aggregated matches on-chain
      await this.executeFillsOnChain(fills, order.marketId);

      // 3. Mark taker order as filled
      await orderService.updateAfterFill(takerOrderId, totalContracts);
    } catch (err: any) {
      logger.error(`Error in async fill processing: ${err.message}`);
    }
  }

  /**
   * Process sell fills asynchronously (fire-and-forget from HTTP response)
   */
  private async processSellFillsAsync(
    fills: Fill[],
    order: SellOrder,
    takerOrderId: string,
    totalSold: number
  ): Promise<void> {
    try {
      // Convert SellOrder to DollarMarketOrder format for reusing processFillForDollarOrderFast
      const asMarketOrder: DollarMarketOrder = {
        marketId: order.marketId,
        userId: order.userId,
        side: 'ASK',  // Seller
        outcome: order.outcome,
        dollarAmount: 0,  // Not used for sells
        maxPrice: order.minPrice,  // Using minPrice as the threshold
        clientOrderId: order.clientOrderId,
        expiresAt: order.expiresAt,
        signature: order.signature,
        binaryMessage: order.binaryMessage,
      };
      
      // 1. Process all fills for DB/Stats/Positions (individual records)
      await Promise.all(fills.map(fill => this.processFillForDollarOrderFast(fill, asMarketOrder, true)));
      
      // 2. Execute aggregated matches on-chain
      await this.executeFillsOnChain(fills, order.marketId);

      // 3. Mark taker order as filled
      await orderService.updateAfterFill(takerOrderId, totalSold);
    } catch (err: any) {
      logger.error(`Error in async sell fill processing: ${err.message}`);
    }
  }

  /**
   * FAST version of processFillForDollarOrder - parallelizes all DB operations
   * Used by processFillsAsync for instant order response
   */
  private async processFillForDollarOrderFast(
    fill: Fill, 
    order: DollarMarketOrder, 
    skipOnChain: boolean = false
  ): Promise<void> {
    const takerSide = order.side;
    const takerOutcome = fill.outcome;
    const takerPrice = fill.price;
    const takerNotional = takerPrice * fill.size;
    const makerOutcome = takerOutcome === 'YES' ? 'NO' : 'YES';
    const makerPrice = 1 - takerPrice;
    const makerNotional = makerPrice * fill.size;

    // Get market data first (needed for on-chain execution)
    const market = await marketService.getById(order.marketId);

    // IMPORTANT: Check if this is a closing trade BEFORE updating positions!
    // For sell orders (ASK), check seller's shares before we reduce them
    const isClosingTrade = takerSide === 'ASK';
    let sellerHasShares = false;
    if (isClosingTrade) {
      const sellerPosition = await positionService.getPosition(fill.takerUserId, order.marketId);
      const sellerShares = takerOutcome === 'YES' 
        ? parseFloat(sellerPosition?.yesShares || '0')
        : parseFloat(sellerPosition?.noShares || '0');
      sellerHasShares = sellerShares >= fill.size;
      logger.debug(`Closing trade check: seller has ${sellerShares} ${takerOutcome} shares, need ${fill.size}, isClosing=${sellerHasShares}`);
    }

    // PARALLEL: All independent DB operations at once
    const [tradeResult, , , , , , , , makerWallet, takerWallet] = await Promise.all([
      // 1. Insert trade record
      db.insert(trades).values({
        marketId: order.marketId,
        makerOrderId: fill.makerOrderId,
        takerOrderId: fill.takerOrderId,
        makerUserId: fill.makerUserId,
        takerUserId: fill.takerUserId,
        takerSide: takerSide,
        takerOutcome: takerOutcome,
        takerPrice: takerPrice.toString(),
        takerNotional: takerNotional.toString(),
        takerFee: fill.takerFee.toString(),
        makerOutcome: makerOutcome,
        makerPrice: makerPrice.toString(),
        makerNotional: makerNotional.toString(),
        makerFee: fill.makerFee.toString(),
        size: fill.size.toString(),
        txStatus: 'PENDING',
        outcome: fill.outcome,
        price: fill.price.toString(),
        notional: takerNotional.toString(),
      }).returning(),
      // 2. Update maker order
      orderService.updateAfterFill(fill.makerOrderId, fill.size),
      // 3. Update taker position (BID = buying, ASK = selling)
      positionService.updateAfterTrade(
        fill.takerUserId, 
        order.marketId, 
        takerSide === 'BID' ? takerOutcome : takerOutcome,  // Same outcome either way
        fill.size, 
        takerSide === 'BID' ? takerNotional + fill.takerFee : takerNotional - fill.takerFee,
        takerSide === 'BID'  // true if buying, false if selling
      ),
      // 4. Update maker position (for closing trades, maker buys what taker sells)
      positionService.updateAfterTrade(
        fill.makerUserId, 
        order.marketId, 
        takerSide === 'BID' ? makerOutcome : takerOutcome,  // If taker sells, maker buys same outcome
        fill.size, 
        takerSide === 'BID' ? makerNotional - fill.makerFee : takerNotional + fill.makerFee,
        true  // Maker is always acquiring
      ),
      // 5. Update taker stats
      userService.updateTradeStats(fill.takerUserId, takerNotional),
      // 6. Update maker stats
      userService.updateTradeStats(fill.makerUserId, makerNotional),
      // 7. Update market volume
      marketService.incrementStats(order.marketId, takerNotional + makerNotional),
      // 8. Update market prices
      marketService.updatePrices(order.marketId, fill.price, 1 - fill.price),
      // 9. Get wallets for on-chain (parallel with above)
      this.getWalletForUser(fill.makerUserId),
      this.getWalletForUser(fill.takerUserId),
    ]);

    const trade = tradeResult[0];

    // On-chain execution (fire-and-forget)
    if (market && makerWallet && takerWallet && !skipOnChain) {
      // Use the stored on-chain pubkey from the database
      const onChainMarketPubkey = market.pubkey;

      // Use pre-checked closing trade flag (checked BEFORE position update)
      if (isClosingTrade && sellerHasShares) {
        // True closing trade - use execute_close instruction
        // Transfers USDC from buyer to seller, transfers shares from seller to buyer
        const closeParams: CloseParams = {
          marketPubkey: onChainMarketPubkey,
          buyerWallet: makerWallet,  // Maker is buying
          sellerWallet: takerWallet, // Taker is selling
          outcome: takerOutcome,
          price: fill.price,
          matchSize: fill.size,
        };
        logger.info(`Executing on-chain CLOSE: ${fill.size} ${takerOutcome} @ ${fill.price} (seller=${takerWallet}, buyer=${makerWallet})`);
        transactionService.executeClose(closeParams).catch(err => 
          logger.error(`On-chain close failed: ${err.message}`)
        );
      } else if (isClosingTrade && !sellerHasShares) {
        // Seller doesn't have enough shares - this shouldn't happen for validated sell orders
        logger.warn(`Taker selling but insufficient shares, using execute_match as fallback`);
        transactionService.executeMatch({
          marketPubkey: onChainMarketPubkey,
          makerOrderId: fill.makerOrderId,
          takerOrderId: fill.takerOrderId,
          makerWallet,
          takerWallet,
          makerSide: fill.makerSide,
          takerSide: fill.takerSide,
          outcome: fill.outcome,
          price: fill.price,
          matchSize: fill.size,
          makerClientOrderId: fill.makerClientOrderId,
          takerClientOrderId: fill.takerClientOrderId,
          makerOrderPda: fill.makerOrderPda,
          takerOrderPda: fill.takerOrderPda,
          makerSignature: fill.makerSignature,
          takerSignature: fill.takerSignature,
          makerMessage: fill.makerMessage,
          takerMessage: fill.takerMessage,
        }).catch(err => logger.error(`On-chain match failed: ${err.message}`));
      } else {
        // Opening trade - use execute_match instruction
        transactionService.executeMatch({
          marketPubkey: onChainMarketPubkey,
          makerOrderId: fill.makerOrderId,
          takerOrderId: fill.takerOrderId,
          makerWallet,
          takerWallet,
          makerSide: fill.makerSide,
          takerSide: fill.takerSide,
          outcome: fill.outcome,
          price: fill.price,
          matchSize: fill.size,
          makerClientOrderId: fill.makerClientOrderId,
          takerClientOrderId: fill.takerClientOrderId,
          makerOrderPda: fill.makerOrderPda,
          takerOrderPda: fill.takerOrderPda,
          makerSignature: fill.makerSignature,
          takerSignature: fill.takerSignature,
          makerMessage: fill.makerMessage,
          takerMessage: fill.takerMessage,
        }).catch(err => logger.error(`On-chain match failed: ${err.message}`));
      }

      // Broadcast trade and fills (sync, fast)
      broadcastTrade(market.pubkey, {
        price: fill.price,
        size: fill.size,
        side: fill.takerSide,
        outcome: fill.outcome,
        timestamp: Date.now(),
      });

      broadcastUserFill(fill.takerUserId, {
        tradeId: trade.id,
        orderId: fill.takerOrderId,
        marketId: order.marketId,
        side: fill.takerSide,
        outcome: fill.outcome,
        price: fill.price,
        size: fill.size,
        fee: fill.takerFee,
      });

      broadcastUserFill(fill.makerUserId, {
        tradeId: trade.id,
        orderId: fill.makerOrderId,
        marketId: order.marketId,
        side: fill.makerSide,
        outcome: fill.outcome,
        price: fill.price,
        size: fill.size,
        fee: fill.makerFee,
      });

      // Log trade
      logEvents.tradeExecuted({
        tradeId: trade.id,
        marketId: order.marketId,
        asset: market.asset,
        timeframe: market.timeframe,
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
  }

  /**
   * Aggregate and execute all fills for a taker order on-chain.
   * This is the primary entry point for efficient on-chain settlement.
   */
  private async executeFillsOnChain(fills: Fill[], marketId: string): Promise<void> {
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

        await this.executeMatchOrCloseOnChain(fill, marketPubkey, makerWallet, takerWallet);
      } catch (err: any) {
        logger.error(`Failed to execute fill on-chain: ${err.message}`);
      }
    }
  }

  /**
   * Helper to execute either a match or a close on-chain based on trade type.
   */
  private async executeMatchOrCloseOnChain(
    fill: Fill,
    marketPubkey: string,
    makerWallet: string,
    takerWallet: string
  ): Promise<void> {
    // Detect if this is a closing trade (taker is selling existing shares)
    const isClosingTrade = fill.takerSide === 'ASK';
    
    if (isClosingTrade) {
      // Check if seller has existing shares
      const sellerPosition = await positionService.getPosition(fill.takerUserId, marketPubkey);
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
        };
        
        transactionService.executeClose(closeParams).then(result => {
          if (!result.success) {
            logger.warn(`On-chain close failed: ${result.error}`);
          }
        }).catch(err => {
          logger.error(`Failed to execute on-chain close: ${err.message}`);
        });
        return;
      }
    }
    
    // Opening trade (or fallback) - use execute_match instruction
    this.executeMatchOnChain(fill, marketPubkey, makerWallet, takerWallet, 'aggregated');
  }

  /**
   * Helper to get wallet address for a user
   */
  private async getWalletForUser(userId: string): Promise<string> {
    const user = await userService.findById(userId);
    return user?.walletAddress || '';
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
      makerClientOrderId: fill.makerClientOrderId,
      takerClientOrderId: fill.takerClientOrderId,
      makerOrderPda: fill.makerOrderPda,
      takerOrderPda: fill.takerOrderPda,
      makerSignature: fill.makerSignature,
      takerSignature: fill.takerSignature,
      makerMessage: fill.makerMessage,
      takerMessage: fill.takerMessage,
    };

    transactionService.executeMatch(matchParams).then(result => {
      if (!result.success) {
        const errorMsg = result.error || '';
        if (errorMsg.includes('AccountNotInitialized') || errorMsg.includes('0xbc4')) {
          logger.warn(`Market ${marketPubkey} does not exist on-chain. Marking as archived in DB.`);
          marketService.markArchivedByPubkey(marketPubkey);
        }
        logger.warn(`On-chain match failed for trade ${tradeId}: ${errorMsg}`);
      } else {
        logger.debug(`On-chain match executed: ${result.signature}`);
      }
    }).catch(err => {
      logger.error(`Failed to execute on-chain match: ${err.message}`);
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
      
      // Broadcast orderbook update
      const snapshot = await orderbookService.getSnapshot(order.marketId, order.outcome);
      broadcastOrderbookUpdate(
        order.marketId,
        snapshot.bids.map(l => [l.price, l.size] as [number, number]),
        snapshot.asks.map(l => [l.price, l.size] as [number, number]),
        sequenceId
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
        makerOrderId: fill.makerOrderId,
        takerOrderId: fill.takerOrderId,
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
    await orderService.updateAfterFill(fill.makerOrderId, fill.size);
    await orderService.updateAfterFill(fill.takerOrderId, fill.size);
    
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
            };
            
            transactionService.executeClose(closeParams).then(result => {
              if (!result.success) {
                logger.warn(`On-chain close failed for trade ${trade.id}: ${result.error}`);
              } else {
                logger.debug(`On-chain close executed: ${result.signature}`);
              }
            }).catch(err => {
              logger.error(`Failed to execute on-chain close: ${err.message}`);
            });
          } else {
            // Seller doesn't have enough shares - use opening trade
            logger.debug(`Taker selling but insufficient shares (${sellerShares} < ${fill.size}), using execute_match`);
            this.executeMatchOnChain(fill, onChainMarketPda, makerWallet, takerWallet, trade.id);
          }
        } else {
          // Opening trade - use execute_match instruction
          this.executeMatchOnChain(fill, onChainMarketPda, makerWallet, takerWallet, trade.id);
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
        tradeId: trade.id,
        orderId: fill.makerOrderId,
        marketId: market?.id || '',
        side: makerOrder.side || '',
        outcome: fill.outcome,
        price: fill.price,
        size: fill.size,
        fee: fill.makerFee,
      });
    }
    
    if (takerOrder) {
      broadcastUserFill(fill.takerUserId, {
        tradeId: trade.id,
        orderId: fill.takerOrderId,
        marketId: market?.id || '',
        side: takerOrder.side || '',
        outcome: fill.outcome,
        price: fill.price,
        size: fill.size,
        fee: fill.takerFee,
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
    
    // Broadcast orderbook update
    const snapshot = await orderbookService.getSnapshot(
      order.marketId!,
      order.outcome as 'YES' | 'NO'
    );
    broadcastOrderbookUpdate(
      order.marketId!,
      snapshot.bids.map(l => [l.price, l.size] as [number, number]),
      snapshot.asks.map(l => [l.price, l.size] as [number, number]),
      sequenceId
    );
    
    return true;
  }
}

export const matchingService = new MatchingService();

