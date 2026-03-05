import { FastifyRequest, FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { logger } from '../lib/logger.js';
import { redis, RedisKeys } from '../db/redis.js';
import { wsMetrics } from '../metrics/index.js';
import { orderbookService } from '../services/orderbook.service.js';
import { marketService } from '../services/market.service.js';
import {
  registerClients,
  indexSubscribe,
  indexUnsubscribe,
  indexUser,
  indexRemoveClient,
  broadcastOrderbookUpdate,
  broadcastTrade,
  broadcastPriceUpdate,
  broadcastMarketResolved,
  broadcastUserFill,
  broadcastUserSettlement,
} from '../lib/broadcasts.js';

interface Subscription {
  channel: string;
  market?: string;
  assets?: string[];
}

interface ClientState {
  subscriptions: Subscription[];
  authenticated: boolean;
  userId?: string;
  address?: string;
  lastPing: number;
}

// Connected clients (internal state)
const clients = new Map<WebSocket, ClientState>();

// Broadcast clients (simpler format for broadcasts.ts)
const broadcastClients = new Map<WebSocket, { subscriptions: Set<string>; wallet?: string; userId?: string }>();
registerClients(broadcastClients);

// Ping interval (30 seconds)
const PING_INTERVAL = 30000;
const PING_TIMEOUT = 60000;

let heartbeatInterval: NodeJS.Timeout | null = null;

/**
 * Convert subscription to channel string(s) and maintain indexes.
 */
function updateBroadcastClient(socket: WebSocket, client: ClientState) {
  const oldSubs = broadcastClients.get(socket)?.subscriptions || new Set<string>();
  const newSubs = new Set<string>();

  for (const sub of client.subscriptions) {
    if (sub.channel === 'orderbook' && sub.market) {
      newSubs.add(`orderbook:${sub.market}`);
    } else if (sub.channel === 'trades' && sub.market) {
      newSubs.add(`trades:${sub.market}`);
    } else if (sub.channel === 'trades:global') {
      newSubs.add('trades:global');
    } else if (sub.channel === 'prices' && sub.assets) {
      for (const asset of sub.assets) {
        newSubs.add(`prices:${asset}`);
      }
    } else if (sub.channel === 'market' && sub.market) {
      newSubs.add(`market:${sub.market}`);
    }
  }

  // Update reverse indexes: remove old, add new
  for (const ch of oldSubs) {
    if (!newSubs.has(ch)) indexUnsubscribe(socket, ch);
  }
  for (const ch of newSubs) {
    if (!oldSubs.has(ch)) indexSubscribe(socket, ch);
  }

  broadcastClients.set(socket, {
    subscriptions: newSubs,
    wallet: client.address,
    userId: client.userId,
  });
}

function startHeartbeatChecker() {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(() => {
    const now = Date.now();

    for (const [socket, client] of clients) {
      if (now - client.lastPing > PING_TIMEOUT) {
        logger.info(`Client timed out after ${now - client.lastPing}ms`);
        socket.close(1000, 'Ping timeout');
        removeClient(socket);
      }
    }
  }, PING_INTERVAL);
}

function removeClient(socket: WebSocket) {
  const client = clients.get(socket);
  clients.delete(socket);
  broadcastClients.delete(socket);
  indexRemoveClient(socket, client?.userId);
}

export async function wsHandler(
  socket: WebSocket,
  request: FastifyRequest,
) {
  const totalClients = clients.size + 1;
  logger.info(`WebSocket client connected (total=${totalClients})`);

  wsMetrics.connectionsTotal.inc();
  wsMetrics.connectedClients.set(totalClients);

  if (totalClients > 10) {
    logger.warn(`[WS] High connection count: ${totalClients} total clients`);
  }

  const initialState: ClientState = {
    subscriptions: [],
    authenticated: false,
    lastPing: Date.now(),
  };
  clients.set(socket, initialState);
  broadcastClients.set(socket, { subscriptions: new Set(), wallet: undefined, userId: undefined });

  startHeartbeatChecker();

  socket.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      await handleMessage(socket, message, request);
    } catch {
      socket.send(JSON.stringify({
        error: { code: 'INVALID_MESSAGE', message: 'Invalid JSON format' },
      }));
    }
  });

  socket.on('close', () => {
    removeClient(socket);
    wsMetrics.disconnectionsTotal.inc();
    wsMetrics.connectedClients.set(clients.size);
    logger.info(`WebSocket client disconnected (remaining=${clients.size})`);
  });

  socket.on('error', (err) => {
    logger.error('WebSocket error:', err);
    removeClient(socket);
  });

  socket.send(JSON.stringify({ op: 'welcome', serverTime: Date.now() }));
}

async function handleMessage(socket: WebSocket, message: any, request: FastifyRequest) {
  const client = clients.get(socket);
  if (!client) return;

  switch (message.op) {
    case 'ping':
      handlePing(socket, client);
      break;
    case 'subscribe':
      await handleSubscribe(socket, client, message);
      break;
    case 'unsubscribe':
      handleUnsubscribe(socket, client, message);
      break;
    case 'auth':
      await handleAuth(socket, client, message, request);
      break;
    case 'snapshot':
      await handleSnapshot(socket, message);
      break;
    default:
      socket.send(JSON.stringify({
        error: { code: 'UNKNOWN_OPERATION', message: `Unknown operation: ${message.op}` },
      }));
  }
}

function handlePing(socket: WebSocket, client: ClientState) {
  const now = Date.now();
  logger.debug(`[WS] Ping received (last ping ${now - client.lastPing}ms ago)`);
  client.lastPing = now;
  socket.send(JSON.stringify({ op: 'pong', serverTime: now }));
}

async function handleSubscribe(socket: WebSocket, client: ClientState, message: any) {
  const { channel, market, assets } = message;

  const validChannels = ['orderbook', 'trades', 'trades:global', 'prices', 'market'];
  if (!validChannels.includes(channel)) {
    socket.send(JSON.stringify({ error: { code: 'INVALID_CHANNEL', message: `Invalid channel: ${channel}` } }));
    return;
  }

  if (channel === 'user' && !client.authenticated) {
    socket.send(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required for user channel' } }));
    return;
  }

  client.subscriptions.push({ channel, market, assets });
  updateBroadcastClient(socket, client);

  logger.info(`[WS] Client subscribed: channel=${channel}, market=${market || 'N/A'}, assets=${assets?.join(',') || 'N/A'}`);
  socket.send(JSON.stringify({ op: 'subscribed', channel, market, assets }));

  // Send initial data
  if (channel === 'orderbook' && market) {
    await sendOrderbookSnapshot(socket, market);
  } else if (channel === 'prices' && assets) {
    await sendPriceSnapshot(socket, assets);
  }
}

function handleUnsubscribe(socket: WebSocket, client: ClientState, message: any) {
  const { channel, market } = message;

  client.subscriptions = client.subscriptions.filter(
    (sub) => !(sub.channel === channel && sub.market === market),
  );
  updateBroadcastClient(socket, client);

  socket.send(JSON.stringify({ op: 'unsubscribed', channel, market }));
}

async function handleAuth(socket: WebSocket, client: ClientState, message: any, request: FastifyRequest) {
  const { token } = message;

  if (!token) {
    socket.send(JSON.stringify({ op: 'auth', status: 'error', error: { code: 'INVALID_TOKEN', message: 'Token is required' } }));
    return;
  }

  try {
    const decoded = request.server.jwt.verify<{ sub: string; address: string }>(token);

    client.authenticated = true;
    client.userId = decoded.sub;
    client.address = decoded.address;

    // Index user for fast user-specific broadcasts
    indexUser(socket, decoded.sub);

    socket.send(JSON.stringify({ op: 'auth', status: 'authenticated', wallet: decoded.address }));

    client.subscriptions.push({ channel: 'user', market: undefined });
    updateBroadcastClient(socket, client);

    logger.info(`WebSocket authenticated: userId=${decoded.sub.slice(0, 8)} wallet=${decoded.address.slice(0, 8)}`);
  } catch (err) {
    logger.warn(`WebSocket auth failed: ${(err as Error).message || 'unknown error'}`);
    socket.send(JSON.stringify({ op: 'auth', status: 'error', error: { code: 'INVALID_TOKEN', message: 'Token verification failed' } }));
  }
}

async function handleSnapshot(socket: WebSocket, message: any) {
  const { channel, market, lastSeqId } = message;

  if (channel === 'orderbook' && market) {
    const currentSeq = await orderbookService.getSequence(market);
    if (!lastSeqId || currentSeq > lastSeqId + 1) {
      await sendOrderbookSnapshot(socket, market, true);
    }
  }
}

/**
 * Send orderbook snapshot using the orderbookService (O(levels) from pre-aggregated data).
 *
 * SINGLE ORDERBOOK MODEL: Always sends composite YES view.
 * The frontend derives NO from YES complement, so we merge any NO orders
 * into the YES snapshot before sending.
 *
 * Also resolves pubkey → DB UUID for correct Redis key lookup.
 */
async function sendOrderbookSnapshot(socket: WebSocket, marketPubkey: string, isFullSnapshot = false) {
  try {
    // Resolve pubkey to DB UUID for correct Redis key lookup
    const market = await marketService.getByPubkey(marketPubkey);
    const dbMarketId = market?.id || marketPubkey;

    const snapshot = await orderbookService.getCompositeSnapshot(dbMarketId);

    socket.send(JSON.stringify({
      channel: 'orderbook',
      market: marketPubkey,
      snapshot: isFullSnapshot,
      data: {
        outcome: 'YES',
        bids: snapshot.bids.map(l => [l.price, l.size]),
        asks: snapshot.asks.map(l => [l.price, l.size]),
        sequenceId: snapshot.sequenceId,
      },
    }));
  } catch (err) {
    logger.error('Error sending orderbook snapshot:', err);
  }
}

async function sendPriceSnapshot(socket: WebSocket, assets: string[]) {
  try {
    const prices: Record<string, any> = {};
    for (const asset of assets) {
      const cached = await redis.get(RedisKeys.price(asset));
      if (cached) prices[asset] = JSON.parse(cached);
    }
    socket.send(JSON.stringify({ channel: 'prices', data: prices }));
  } catch (err) {
    logger.error('Error sending price snapshot:', err);
  }
}

// Re-export broadcast functions for backward compatibility
export {
  broadcastOrderbookUpdate,
  broadcastTrade,
  broadcastPriceUpdate,
  broadcastMarketResolved,
  broadcastUserFill,
  broadcastUserSettlement,
};
