/**
 * WebSocket Events Worker
 *
 * Processes WebSocket broadcast events.
 * Best-effort delivery — no retries (1 attempt).
 * Concurrency: 100.
 */

import { Worker, Job } from 'bullmq';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import {
  broadcastOrderbookUpdate,
  broadcastTrade,
  broadcastGlobalTrade,
  broadcastPriceUpdate,
  broadcastMarketResolved,
  broadcastUserFill,
  broadcastUserSettlement,
  broadcastTradeFailure,
} from '../../lib/broadcasts.js';
import type { WsEventsJobData } from '../queues.js';

function redisOpts() {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    maxRetriesPerRequest: null as null,
  };
}

async function processJob(job: Job<WsEventsJobData>): Promise<void> {
  const { channel, eventType, data } = job.data;

  try {
    switch (eventType) {
      case 'orderbook_update':
        broadcastOrderbookUpdate(
          data.marketId,
          data.bids,
          data.asks,
          data.sequenceId,
          data.outcome,
        );
        break;

      case 'trade':
        broadcastTrade(data.marketId, data.trade);
        break;

      case 'global_trade':
        broadcastGlobalTrade(data.trade);
        break;

      case 'price_update':
        broadcastPriceUpdate(data.asset, data.price, data.timestamp);
        break;

      case 'market_resolved':
        broadcastMarketResolved(data.marketId, data.outcome, data.finalPrice, data.strikePrice);
        break;

      case 'user_fill':
        broadcastUserFill(data.userId, data.fill);
        break;

      case 'user_settlement':
        broadcastUserSettlement(data.userId, data.settlement);
        break;

      case 'trade_failed':
        broadcastTradeFailure(data.userId, {
          tradeId: data.tradeId,
          marketAddress: data.marketAddress,
          errorCode: data.errorCode,
        });
        break;

      default:
        logger.warn(`[QUEUE:ws] Unknown event type: ${eventType}`);
    }
  } catch (err: any) {
    logger.error(`[QUEUE:ws] Failed to broadcast ${eventType}: ${err.message}`);
    // Don't throw — ws events are best-effort
  }
}

export function startWsEventsWorker(): Worker {
  const worker = new Worker('ws-events', processJob, {
    connection: redisOpts(),
    concurrency: 10,
  });

  worker.on('error', (err) => {
    logger.error(`[QUEUE:ws] Worker error: ${err.message}`);
  });

  logger.info('[QUEUE:ws] Worker started (concurrency=10)');
  return worker;
}
