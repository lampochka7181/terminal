import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { logger } from '../lib/logger.js';

/**
 * Metrics Infrastructure
 *
 * Provides Prometheus-compatible metrics for monitoring system performance.
 * Use these metrics to establish baselines and measure optimization improvements.
 */

// Create a custom registry to avoid conflicts with default metrics
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry });

// ============================================================================
// WEBSOCKET METRICS
// ============================================================================

export const wsMetrics = {
  // Total connected clients
  connectedClients: new Gauge({
    name: 'ws_connected_clients',
    help: 'Number of currently connected WebSocket clients',
    registers: [metricsRegistry],
  }),

  // Connections total (counter for connection rate)
  connectionsTotal: new Counter({
    name: 'ws_connections_total',
    help: 'Total number of WebSocket connections established',
    registers: [metricsRegistry],
  }),

  // Disconnections total
  disconnectionsTotal: new Counter({
    name: 'ws_disconnections_total',
    help: 'Total number of WebSocket disconnections',
    registers: [metricsRegistry],
  }),

  // Messages sent per channel
  messagesSent: new Counter({
    name: 'ws_messages_sent_total',
    help: 'Total messages sent by channel',
    labelNames: ['channel'],
    registers: [metricsRegistry],
  }),

  // Broadcast duration histogram
  broadcastDuration: new Histogram({
    name: 'ws_broadcast_duration_seconds',
    help: 'Time taken to broadcast to all subscribers',
    labelNames: ['channel'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [metricsRegistry],
  }),

  // Subscribers per channel
  subscribersPerChannel: new Gauge({
    name: 'ws_subscribers_per_channel',
    help: 'Number of subscribers per channel',
    labelNames: ['channel'],
    registers: [metricsRegistry],
  }),

  // Dropped messages due to backpressure
  droppedMessages: new Counter({
    name: 'ws_dropped_messages_total',
    help: 'Messages dropped due to backpressure',
    labelNames: ['channel'],
    registers: [metricsRegistry],
  }),
};

// ============================================================================
// REDIS METRICS
// ============================================================================

export const redisMetrics = {
  // Operations counter by command type
  operationsTotal: new Counter({
    name: 'redis_operations_total',
    help: 'Total Redis operations by command',
    labelNames: ['command', 'key_type'],
    registers: [metricsRegistry],
  }),

  // Operation duration histogram
  operationDuration: new Histogram({
    name: 'redis_operation_duration_seconds',
    help: 'Redis operation duration',
    labelNames: ['command', 'key_type'],
    buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
    registers: [metricsRegistry],
  }),

  // Orderbook-specific metrics
  orderbookOperations: new Counter({
    name: 'redis_orderbook_operations_total',
    help: 'Orderbook-specific Redis operations',
    labelNames: ['operation'], // add, remove, update, snapshot
    registers: [metricsRegistry],
  }),

  // Orderbook operation duration
  orderbookOperationDuration: new Histogram({
    name: 'redis_orderbook_operation_duration_seconds',
    help: 'Orderbook operation duration',
    labelNames: ['operation'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
    registers: [metricsRegistry],
  }),

  // Size of orderbook (orders count)
  orderbookSize: new Gauge({
    name: 'redis_orderbook_size',
    help: 'Number of orders in orderbook',
    labelNames: ['market', 'side', 'outcome'],
    registers: [metricsRegistry],
  }),
};

// ============================================================================
// DATABASE METRICS
// ============================================================================

export const dbMetrics = {
  // Connection pool stats
  poolTotalConnections: new Gauge({
    name: 'db_pool_total_connections',
    help: 'Total connections in pool',
    registers: [metricsRegistry],
  }),

  poolIdleConnections: new Gauge({
    name: 'db_pool_idle_connections',
    help: 'Idle connections in pool',
    registers: [metricsRegistry],
  }),

  poolWaitingClients: new Gauge({
    name: 'db_pool_waiting_clients',
    help: 'Clients waiting for a connection',
    registers: [metricsRegistry],
  }),

  // Query counter by endpoint/operation
  queriesTotal: new Counter({
    name: 'db_queries_total',
    help: 'Total database queries',
    labelNames: ['operation', 'table'],
    registers: [metricsRegistry],
  }),

  // Query duration histogram
  queryDuration: new Histogram({
    name: 'db_query_duration_seconds',
    help: 'Database query duration',
    labelNames: ['operation', 'table'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [metricsRegistry],
  }),

  // Errors
  queryErrors: new Counter({
    name: 'db_query_errors_total',
    help: 'Database query errors',
    labelNames: ['operation', 'table'],
    registers: [metricsRegistry],
  }),
};

// ============================================================================
// SOLANA/ON-CHAIN METRICS
// ============================================================================

export const solanaMetrics = {
  // Transaction submissions
  transactionsSubmitted: new Counter({
    name: 'solana_transactions_submitted_total',
    help: 'Total transactions submitted to Solana',
    labelNames: ['instruction_type'], // execute_match, settle_positions, etc.
    registers: [metricsRegistry],
  }),

  // Transaction confirmations
  transactionsConfirmed: new Counter({
    name: 'solana_transactions_confirmed_total',
    help: 'Transactions confirmed on Solana',
    labelNames: ['instruction_type'],
    registers: [metricsRegistry],
  }),

  // Transaction failures
  transactionsFailed: new Counter({
    name: 'solana_transactions_failed_total',
    help: 'Transactions that failed',
    labelNames: ['instruction_type', 'error_type'],
    registers: [metricsRegistry],
  }),

  // Confirmation time histogram
  confirmationTime: new Histogram({
    name: 'solana_confirmation_time_seconds',
    help: 'Time to confirm transaction',
    labelNames: ['instruction_type'],
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
    registers: [metricsRegistry],
  }),

  // Retry count
  transactionRetries: new Histogram({
    name: 'solana_transaction_retries',
    help: 'Number of retries per transaction',
    labelNames: ['instruction_type'],
    buckets: [0, 1, 2, 3, 4, 5],
    registers: [metricsRegistry],
  }),

  // Queue depth (pending transactions)
  queueDepth: new Gauge({
    name: 'solana_queue_depth',
    help: 'Number of pending transactions in queue',
    labelNames: ['queue_type'], // settlement, matching, etc.
    registers: [metricsRegistry],
  }),
};

// ============================================================================
// MATCHING ENGINE METRICS
// ============================================================================

export const matchingMetrics = {
  // Orders processed
  ordersProcessed: new Counter({
    name: 'matching_orders_processed_total',
    help: 'Total orders processed by matching engine',
    labelNames: ['order_type', 'side', 'outcome'],
    registers: [metricsRegistry],
  }),

  // Fills generated
  fillsGenerated: new Counter({
    name: 'matching_fills_generated_total',
    help: 'Total fills generated',
    labelNames: ['trade_type'], // opening, closing
    registers: [metricsRegistry],
  }),

  // Matching duration
  matchingDuration: new Histogram({
    name: 'matching_duration_seconds',
    help: 'Time to complete matching for an order',
    labelNames: ['order_type'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [metricsRegistry],
  }),

  // Partial fills
  partialFills: new Counter({
    name: 'matching_partial_fills_total',
    help: 'Orders that were partially filled',
    registers: [metricsRegistry],
  }),

  // Matching timeouts
  matchingTimeouts: new Counter({
    name: 'matching_timeouts_total',
    help: 'Matching operations that timed out',
    registers: [metricsRegistry],
  }),
};

// ============================================================================
// SETTLEMENT METRICS
// ============================================================================

export const settlementMetrics = {
  // Positions settled
  positionsSettled: new Counter({
    name: 'settlement_positions_settled_total',
    help: 'Total positions settled',
    labelNames: ['outcome'], // YES, NO
    registers: [metricsRegistry],
  }),

  // Settlement batches
  settlementBatches: new Counter({
    name: 'settlement_batches_total',
    help: 'Total settlement batches processed',
    labelNames: ['status'], // success, failed
    registers: [metricsRegistry],
  }),

  // Settlement duration (per batch)
  settlementDuration: new Histogram({
    name: 'settlement_batch_duration_seconds',
    help: 'Time to process a settlement batch',
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
    registers: [metricsRegistry],
  }),

  // Market settlement time (total time to settle all positions in a market)
  marketSettlementTime: new Histogram({
    name: 'settlement_market_duration_seconds',
    help: 'Total time to settle all positions in a market',
    buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
    registers: [metricsRegistry],
  }),

  // Positions per market
  positionsPerMarket: new Histogram({
    name: 'settlement_positions_per_market',
    help: 'Number of positions to settle per market',
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
    registers: [metricsRegistry],
  }),
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Timer utility for measuring operation duration
 */
export function startTimer() {
  const start = process.hrtime.bigint();
  return {
    /** Returns elapsed time in seconds */
    elapsed: () => Number(process.hrtime.bigint() - start) / 1e9,
  };
}

/**
 * Wrap an async function with timing metrics
 */
export function withMetrics<T>(
  histogram: Histogram<string>,
  labels: Record<string, string>,
  fn: () => Promise<T>
): Promise<T> {
  const timer = startTimer();
  return fn().finally(() => {
    histogram.observe(labels, timer.elapsed());
  });
}

/**
 * Get all metrics as text (Prometheus format)
 */
export async function getMetricsText(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Get all metrics as JSON
 */
export async function getMetricsJson(): Promise<object> {
  return metricsRegistry.getMetricsAsJSON();
}

logger.info('Metrics infrastructure initialized');
