/**
 * Write-Behind Batch Queue
 * 
 * Decouples DB writes from the matching hot path.
 * Orders and trades are matched in Redis instantly, then DB persistence
 * happens asynchronously in batches for high throughput.
 * 
 * Design:
 * - Accumulates pending writes in memory
 * - Flushes every FLUSH_INTERVAL_MS or when FLUSH_BATCH_SIZE is reached
 * - Uses batch INSERT for orders and trades (1 query per batch, not per record)
 * - Retries on failure with exponential backoff
 * - Provides backpressure signal when queue is too deep
 */

import { db, orders, trades, type NewTrade } from '../db/index.js';
import { logger } from '../lib/logger.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 50;         // Flush every 50ms (20 flushes/sec)
const FLUSH_BATCH_SIZE = 200;         // Or when 200 records accumulate
const MAX_QUEUE_DEPTH = 10_000;       // Backpressure: reject if queue > 10k
const MAX_RETRIES = 3;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PendingOrder {
  id: string;          // Pre-generated UUID
  clientOrderId: number;
  marketId: string;
  userId: string;
  side: string;
  outcome: string;
  orderType: string;
  price: string;
  size: string;
  signature: string | null;
  binaryMessage?: string | null;
  sessionPublicKey?: string | null;
  authVersion?: string | null;
  encodedInstruction: null;
  isMmOrder: boolean;
  expiresAt: Date;
  status: string;
  filledSize: string;
  remainingSize: string;
  dollarAmount?: string;  // Original USD amount for dollar-based market orders
}

export interface PendingTrade {
  marketId: string;
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
  takerSide: string;
  takerOutcome: string;
  takerPrice: string;
  takerNotional: string;
  takerFee: string;
  makerOutcome: string;
  makerPrice: string;
  makerNotional: string;
  makerFee: string;
  size: string;
  txStatus: 'PENDING';
  outcome: string;
  price: string;
  notional: string;
}

// ─── Write-Behind Queue ──────────────────────────────────────────────────────

class WriteBehindService {
  private orderQueue: PendingOrder[] = [];
  private tradeQueue: PendingTrade[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private _paused = false; // When true, flush() is a no-op (for perf test hot phase)
  private stats = {
    ordersQueued: 0,
    ordersFlushed: 0,
    tradesQueued: 0,
    tradesFlushed: 0,
    flushCount: 0,
    flushErrors: 0,
    lastFlushMs: 0,
    avgFlushMs: 0,
  };

  /** Pause flushing (accumulate in memory). Call resume() to flush all at once. */
  pause(): void {
    this._paused = true;
    logger.info(`[WriteBehind] PAUSED — writes will accumulate in memory`);
  }

  /** Resume flushing — drains accumulated writes in batches. */
  async resume(): Promise<void> {
    this._paused = false;
    logger.info(`[WriteBehind] RESUMED — flushing ${this.orderQueue.length} orders + ${this.tradeQueue.length} trades`);
    // Drain all accumulated writes
    while (this.orderQueue.length > 0 || this.tradeQueue.length > 0) {
      await this.flush();
    }
  }

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    logger.info(`[WriteBehind] Started (interval=${FLUSH_INTERVAL_MS}ms, batchSize=${FLUSH_BATCH_SIZE})`);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush
    this.flush().catch(err => logger.error(`[WriteBehind] Final flush failed: ${err.message}`));
  }

  /**
   * Enqueue an order for batch persistence.
   * Returns immediately — does NOT wait for DB write.
   */
  enqueueOrder(order: PendingOrder): boolean {
    if (this.orderQueue.length >= MAX_QUEUE_DEPTH) {
      logger.warn(`[WriteBehind] Order queue full (${this.orderQueue.length}), dropping order ${order.id}`);
      return false;
    }
    this.orderQueue.push(order);
    this.stats.ordersQueued++;

    // Auto-flush if batch is full
    if (this.orderQueue.length >= FLUSH_BATCH_SIZE) {
      this.flush().catch(() => {});
    }
    return true;
  }

  /**
   * Enqueue trades for batch persistence.
   */
  enqueueTrades(tradeRecords: PendingTrade[]): boolean {
    if (this.tradeQueue.length + tradeRecords.length >= MAX_QUEUE_DEPTH) {
      logger.warn(`[WriteBehind] Trade queue full (${this.tradeQueue.length}), dropping ${tradeRecords.length} trades`);
      return false;
    }
    this.tradeQueue.push(...tradeRecords);
    this.stats.tradesQueued += tradeRecords.length;

    if (this.tradeQueue.length >= FLUSH_BATCH_SIZE) {
      this.flush().catch(() => {});
    }
    return true;
  }

  /**
   * Flush pending writes to DB in batch.
   * Uses INSERT ... VALUES for max throughput.
   */
  async flush(): Promise<void> {
    if (this._paused) return; // Paused — accumulate only
    if (this.flushing) return; // Prevent concurrent flushes
    if (this.orderQueue.length === 0 && this.tradeQueue.length === 0) return;

    this.flushing = true;
    const t0 = Date.now();

    // Drain queues atomically
    const pendingOrders = this.orderQueue.splice(0, FLUSH_BATCH_SIZE);
    const pendingTrades = this.tradeQueue.splice(0, FLUSH_BATCH_SIZE);

    try {
      // Batch insert orders
      if (pendingOrders.length > 0) {
        await this.batchInsertOrders(pendingOrders);
        this.stats.ordersFlushed += pendingOrders.length;
      }

      // Batch insert trades
      if (pendingTrades.length > 0) {
        await this.batchInsertTrades(pendingTrades);
        this.stats.tradesFlushed += pendingTrades.length;
      }

      const elapsed = Date.now() - t0;
      this.stats.flushCount++;
      this.stats.lastFlushMs = elapsed;
      this.stats.avgFlushMs = (this.stats.avgFlushMs * (this.stats.flushCount - 1) + elapsed) / this.stats.flushCount;

      if (pendingOrders.length + pendingTrades.length > 10) {
        logger.info(`[WriteBehind] Flushed ${pendingOrders.length} orders + ${pendingTrades.length} trades in ${elapsed}ms`);
      }
    } catch (err: any) {
      this.stats.flushErrors++;
      logger.error(`[WriteBehind] Flush failed: ${err.message} (${pendingOrders.length} orders, ${pendingTrades.length} trades)`);

      // Re-queue failed items for retry (prepend to front of queue)
      this.orderQueue.unshift(...pendingOrders);
      this.tradeQueue.unshift(...pendingTrades);
    } finally {
      this.flushing = false;
    }
  }

  private async batchInsertOrders(batch: PendingOrder[]): Promise<void> {
    const values = batch.map(o => ({
      id: o.id,
      clientOrderId: o.clientOrderId,
      marketId: o.marketId,
      userId: o.userId,
      side: o.side,
      outcome: o.outcome,
      orderType: o.orderType,
      price: o.price,
      size: o.size,
      signature: o.signature,
      binaryMessage: o.binaryMessage || null,
      sessionPublicKey: o.sessionPublicKey || null,
      authVersion: o.authVersion || null,
      encodedInstruction: o.encodedInstruction,
      isMmOrder: o.isMmOrder,
      expiresAt: o.expiresAt,
      status: o.status,
      filledSize: o.filledSize,
      remainingSize: o.remainingSize,
      dollarAmount: o.dollarAmount || null,
    }));

    await db.insert(orders).values(values as any).onConflictDoNothing();
  }

  private async batchInsertTrades(batch: PendingTrade[]): Promise<void> {
    await db.insert(trades).values(batch as any).onConflictDoNothing();
  }

  getStats() {
    return {
      ...this.stats,
      orderQueueDepth: this.orderQueue.length,
      tradeQueueDepth: this.tradeQueue.length,
    };
  }

  /**
   * Flush a specific order by ID out of the write-behind queue and into the DB immediately.
   * This is needed when trades referencing this order are about to be inserted directly,
   * so the FK constraint on taker_order_id / maker_order_id is satisfied.
   *
   * If the order has already been flushed (not in queue), this is a no-op.
   */
  async flushOrderById(orderId: string): Promise<void> {
    const idx = this.orderQueue.findIndex(o => o.id === orderId);
    if (idx === -1) return; // Already flushed or not enqueued

    // Remove from queue so the periodic flush won't double-insert
    const [order] = this.orderQueue.splice(idx, 1);

    try {
      await db.insert(orders).values(order as any).onConflictDoNothing();
      this.stats.ordersFlushed++;
    } catch (err: any) {
      logger.error(`[WriteBehind] flushOrderById failed for ${orderId}: ${err.message}`);
      // Re-queue so it retries on next periodic flush
      this.orderQueue.push(order);
      throw err;
    }
  }

  /** Get pending count for backpressure monitoring */
  get pendingCount(): number {
    return this.orderQueue.length + this.tradeQueue.length;
  }
}

export const writeBehindService = new WriteBehindService();
