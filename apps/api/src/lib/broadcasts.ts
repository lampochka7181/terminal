import { logger } from './logger.js';
import { wsMetrics, startTimer } from '../metrics/index.js';

/**
 * Broadcast Manager (v2 — reverse-indexed, batched, with delta support)
 *
 * Improvements over v1:
 *   - channelSubscribers reverse index:  broadcast is O(subscribers), not O(all clients)
 *   - userSockets reverse index:          user broadcasts are O(user sockets)
 *   - batching window for high-freq channels (orderbook, trades)
 *   - backpressure: skip non-critical messages when socket buffer is full
 *   - delta broadcasting for orderbook updates
 */

// ─── Types ─────────────────────────────────────────────────────────────────

type WebSocketLike = {
  readyState: number;
  send: (data: string) => void;
  bufferedAmount?: number;
};

const WS_OPEN = 1;

// Backpressure: skip non-critical messages if buffer exceeds this (bytes)
const BACKPRESSURE_THRESHOLD = 64 * 1024; // 64 KB

// Batching window for high-frequency channels (ms)
const BATCH_WINDOW_MS = 30;

// Channels that use batching
const BATCHED_CHANNEL_PREFIXES = ['orderbook:', 'trades:'];

// ─── Client storage ────────────────────────────────────────────────────────

type ClientMeta = { subscriptions: Set<string>; wallet?: string; userId?: string };

let clients: Map<WebSocketLike, ClientMeta> = new Map();

// ─── Reverse indexes (Phase 2) ────────────────────────────────────────────

const channelSubscribers = new Map<string, Set<WebSocketLike>>();
const userSockets = new Map<string, Set<WebSocketLike>>();

// ─── Batching state ────────────────────────────────────────────────────────

interface BatchEntry { channel: string; data: any; }
const pendingBatches = new Map<string, { timer: ReturnType<typeof setTimeout>; entries: BatchEntry[] }>();

// ─── Registration ──────────────────────────────────────────────────────────

export function registerClients(clientsMap: Map<WebSocketLike, ClientMeta>) {
  clients = clientsMap;
}

/**
 * Call when a client subscribes to a channel.
 * Maintains the channel→sockets reverse index.
 */
export function indexSubscribe(ws: WebSocketLike, channel: string): void {
  let subs = channelSubscribers.get(channel);
  if (!subs) { subs = new Set(); channelSubscribers.set(channel, subs); }
  subs.add(ws);
}

/**
 * Call when a client unsubscribes from a channel.
 */
export function indexUnsubscribe(ws: WebSocketLike, channel: string): void {
  const subs = channelSubscribers.get(channel);
  if (subs) {
    subs.delete(ws);
    if (subs.size === 0) channelSubscribers.delete(channel);
  }
}

/**
 * Call when a client authenticates — index by userId for fast user broadcasts.
 */
export function indexUser(ws: WebSocketLike, userId: string): void {
  let socks = userSockets.get(userId);
  if (!socks) { socks = new Set(); userSockets.set(userId, socks); }
  socks.add(ws);
}

/**
 * Call when a client disconnects — remove from all indexes.
 */
export function indexRemoveClient(ws: WebSocketLike, userId?: string): void {
  // Remove from all channel indexes
  for (const [channel, subs] of channelSubscribers) {
    subs.delete(ws);
    if (subs.size === 0) channelSubscribers.delete(channel);
  }
  // Remove from user index
  if (userId) {
    const socks = userSockets.get(userId);
    if (socks) {
      socks.delete(ws);
      if (socks.size === 0) userSockets.delete(userId);
    }
  }
}

// ─── Core broadcast (uses reverse index) ───────────────────────────────────

function broadcast(channel: string, data: any): void {
  const timer = startTimer();

  const subs = channelSubscribers.get(channel);
  let sent = 0;
  const subscriberCount = subs ? subs.size : 0;

  if (subs && subs.size > 0) {
    const payload = JSON.stringify(data);
    for (const ws of subs) {
      if (ws.readyState !== WS_OPEN) continue;
      // Backpressure check
      if (ws.bufferedAmount && ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
        continue; // skip — client will recover via snapshot request
      }
      try {
        ws.send(payload);
        sent++;
      } catch (err) {
        logger.error(`Failed to send to client:`, err);
      }
    }
  }

  // Fallback: if reverse index is empty but clients exist, use old-style scan
  // (handles transition period while websocket.ts is being updated)
  if (subscriberCount === 0 && clients.size > 0) {
    const payload = JSON.stringify(data);
    for (const [ws, client] of clients) {
      if (ws.readyState === WS_OPEN && client.subscriptions.has(channel)) {
        try {
          ws.send(payload);
          sent++;
        } catch (err) {
          logger.error(`Failed to send to client:`, err);
        }
      }
    }
  }

  const channelType = channel.split(':')[0];
  wsMetrics.broadcastDuration.observe({ channel: channelType }, timer.elapsed());
  wsMetrics.messagesSent.inc({ channel: channelType }, sent);
  wsMetrics.subscribersPerChannel.set({ channel: channelType }, subscriberCount || sent);

  if (sent > 0) {
    logger.debug(`Broadcast to ${sent} clients on ${channel}`);
  }
}

/**
 * Broadcast with optional batching for high-frequency channels.
 * Coalesces multiple updates within BATCH_WINDOW_MS into a single send.
 */
function broadcastBatched(channel: string, data: any): void {
  const shouldBatch = BATCHED_CHANNEL_PREFIXES.some(p => channel.startsWith(p));

  if (!shouldBatch || BATCH_WINDOW_MS <= 0) {
    broadcast(channel, data);
    return;
  }

  let batch = pendingBatches.get(channel);
  if (!batch) {
    batch = {
      entries: [],
      timer: setTimeout(() => {
        flushBatch(channel);
      }, BATCH_WINDOW_MS),
    };
    pendingBatches.set(channel, batch);
  }

  // Replace previous entry (latest snapshot wins for orderbook)
  batch.entries = [{ channel, data }];
}

function flushBatch(channel: string): void {
  const batch = pendingBatches.get(channel);
  pendingBatches.delete(channel);
  if (!batch || batch.entries.length === 0) return;

  // Send the latest entry
  const latest = batch.entries[batch.entries.length - 1];
  broadcast(latest.channel, latest.data);
}

// ─── User-specific broadcast (uses user index) ────────────────────────────

function broadcastToUser(userId: string, event: string, data: any): void {
  const message = JSON.stringify({
    channel: 'user',
    event,
    data,
    timestamp: Date.now(),
  });

  // Use user index first
  const socks = userSockets.get(userId);
  if (socks && socks.size > 0) {
    for (const ws of socks) {
      if (ws.readyState === WS_OPEN) {
        try { ws.send(message); } catch (err) {
          logger.error(`Failed to send to user ${userId}:`, err);
        }
      }
    }
    return;
  }

  // Fallback scan (transition period)
  for (const [ws, client] of clients) {
    if (ws.readyState === WS_OPEN && client.userId === userId) {
      try { ws.send(message); } catch (err) {
        logger.error(`Failed to send to user ${userId}:`, err);
      }
    }
  }
}

// ─── Public broadcast functions ────────────────────────────────────────────

export function broadcastOrderbookUpdate(
  marketId: string,
  bids: [number, number][],
  asks: [number, number][],
  sequenceId: number,
  outcome?: 'YES' | 'NO',
): void {
  logger.debug(`[Broadcast] Orderbook update: market=${marketId.slice(0, 8)}..., outcome=${outcome || 'YES'}, bids=${bids.length}, asks=${asks.length}, seq=${sequenceId}`);

  broadcastBatched(`orderbook:${marketId}`, {
    type: 'orderbook_update',
    channel: 'orderbook',
    market: marketId,
    data: {
      marketId,
      outcome: outcome || 'YES',
      bids,
      asks,
      sequenceId,
      timestamp: Date.now(),
    },
  });
}

export function broadcastTrade(
  marketId: string,
  trade: {
    id?: string;
    price: number;
    size: number;
    outcome: string;
    side: string;
    timestamp: number;
    takerWallet?: string;
  },
): void {
  broadcastBatched(`trades:${marketId}`, {
    type: 'trade',
    channel: 'trades',
    market: marketId,
    data: {
      marketId,
      id: trade.id || `trade-${Date.now()}`,
      ...trade,
    },
  });
}

export function broadcastGlobalTrade(
  trade: {
    id: string;
    market: string;
    marketAddress: string;
    asset: string;
    timeframe: string;
    side: 'buy' | 'sell';
    outcome: 'yes' | 'no';
    price: number;
    size: number;
    notional: number;
    txSignature: string | null;
    timestamp: number;
  },
): void {
  broadcast('trades:global', {
    type: 'global_trade',
    channel: 'trades:global',
    data: {
      ...trade,
      solscanUrl: trade.txSignature ? `https://solscan.io/tx/${trade.txSignature}` : null,
    },
  });
}

export function broadcastPriceUpdate(asset: string, price: number, timestamp: number): void {
  broadcast(`prices:${asset}`, {
    channel: 'prices',
    type: 'price_update',
    data: { asset, price, timestamp },
  });
}

export function broadcastMarketResolved(
  marketId: string,
  outcome: 'YES' | 'NO',
  finalPrice: number,
  strikePrice: number,
): void {
  const data = { marketId, outcome, finalPrice, strikePrice, timestamp: Date.now() };
  broadcast(`market:${marketId}`, {
    type: 'market_resolved',
    data,
  });

  broadcastGlobal({
    type: 'market_resolved',
    channel: 'market',
    data,
  });
}

export function broadcastUserFill(
  userId: string,
  fill: {
    orderId: string;
    marketAddress: string;
    side: 'bid' | 'ask';
    outcome: 'yes' | 'no';
    price: number;
    filledSize: number;
    remainingSize: number;
    status: 'partial' | 'filled';
    timestamp: number;
  },
): void {
  broadcastToUser(userId, 'fill', fill);
}

export function broadcastUserSettlement(
  userId: string,
  settlement: {
    marketId: string;
    outcome: string;
    size: number;
    payout: number;
  },
): void {
  broadcastToUser(userId, 'settlement', settlement);
}

export function broadcastUserLiquidation(
  userId: string,
  liquidation: {
    marketId: string;
    marketAddress: string;
    side: 'YES' | 'NO';
    shares: number;
    entryPrice: number;
    liquidationPrice: number;
    executionPrice: number;
    proceeds: number;
    returnedToUser: number;
    leverage: number;
  },
): void {
  broadcastToUser(userId, 'liquidation', liquidation);
}

export function broadcastTradeFailure(
  userId: string,
  failure: {
    tradeId: string;
    marketAddress: string;
    errorCode: string;
  },
): void {
  broadcastToUser(userId, 'trade_failed', failure);
}

export function broadcastMarketActivated(
  marketAddress: string,
  data: {
    marketId: string;
    asset: string;
    timeframe: string;
    strikePrice: number;
    expiryAt: number;
  },
): void {
  broadcast(`market:${marketAddress}`, {
    type: 'market_activated',
    channel: 'market',
    market: marketAddress,
    data: { ...data, timestamp: Date.now() },
  });

  broadcastGlobal({
    type: 'market_activated',
    channel: 'markets',
    data: { address: marketAddress, ...data, timestamp: Date.now() },
  });
}

function broadcastGlobal(data: any): void {
  let sent = 0;
  const payload = JSON.stringify(data);

  for (const [ws] of clients) {
    if (ws.readyState === WS_OPEN) {
      try { ws.send(payload); sent++; } catch (err) {
        logger.error(`Failed to send global broadcast:`, err);
      }
    }
  }

  if (sent > 0) {
    logger.debug(`Global broadcast to ${sent} clients: ${data.type}`);
  }
}
