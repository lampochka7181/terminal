import { FastifyRequest, FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { logger } from '../lib/logger.js';
import { redis, RedisKeys } from '../db/redis.js';
import { 
  registerClients, 
  broadcastOrderbookUpdate, 
  broadcastTrade, 
  broadcastPriceUpdate, 
  broadcastMarketResolved,
  broadcastUserFill,
  broadcastUserSettlement
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

// Start heartbeat checker
let heartbeatInterval: NodeJS.Timeout | null = null;

/**
 * Update broadcast clients when subscriptions change
 */
function updateBroadcastClient(socket: WebSocket, client: ClientState) {
  const subs = new Set<string>();
  
  for (const sub of client.subscriptions) {
    // Convert subscription to channel string
    if (sub.channel === 'orderbook' && sub.market) {
      subs.add(`orderbook:${sub.market}`);
    } else if (sub.channel === 'trades' && sub.market) {
      subs.add(`trades:${sub.market}`);
    } else if (sub.channel === 'trades:global') {
      // Global trade blotter - no market needed
      subs.add('trades:global');
    } else if (sub.channel === 'prices' && sub.assets) {
      for (const asset of sub.assets) {
        subs.add(`prices:${asset}`);
      }
    } else if (sub.channel === 'market' && sub.market) {
      subs.add(`market:${sub.market}`);
    }
  }
  
  broadcastClients.set(socket, {
    subscriptions: subs,
    wallet: client.address,
    userId: client.userId,
  });
}

function startHeartbeatChecker() {
  if (heartbeatInterval) return;
  
  heartbeatInterval = setInterval(() => {
    const now = Date.now();
    
    for (const [socket, client] of clients) {
      const timeSinceLastPing = now - client.lastPing;
      
      if (timeSinceLastPing > PING_TIMEOUT) {
        logger.info(`Client timed out after ${timeSinceLastPing}ms (timeout=${PING_TIMEOUT}ms), subscriptions: ${client.subscriptions.length}`);
        socket.close(1000, 'Ping timeout');
        clients.delete(socket);
      }
    }
  }, PING_INTERVAL);
}

export async function wsHandler(
  socket: WebSocket,
  request: FastifyRequest
) {
  const totalClients = clients.size + 1;
  logger.info(`WebSocket client connected (total=${totalClients})`);
  
  // Warn if many connections from same origin
  if (totalClients > 10) {
    logger.warn(`[WS] High connection count: ${totalClients} total clients`);
  }
  
  // Initialize client state
  const initialState: ClientState = {
    subscriptions: [],
    authenticated: false,
    lastPing: Date.now(),
  };
  clients.set(socket, initialState);
  broadcastClients.set(socket, { subscriptions: new Set(), wallet: undefined, userId: undefined });

  // Start heartbeat checker if not running
  startHeartbeatChecker();

  // Handle incoming messages
  socket.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      await handleMessage(socket, message, request);
    } catch (err) {
      socket.send(JSON.stringify({
        error: {
          code: 'INVALID_MESSAGE',
          message: 'Invalid JSON format',
        },
      }));
    }
  });

  // Handle disconnect
  socket.on('close', () => {
    clients.delete(socket);
    broadcastClients.delete(socket);
    logger.info(`WebSocket client disconnected (remaining=${clients.size})`);
  });

  // Handle errors
  socket.on('error', (err) => {
    logger.error('WebSocket error:', err);
    clients.delete(socket);
    broadcastClients.delete(socket);
  });

  // Send welcome message
  socket.send(JSON.stringify({
    op: 'welcome',
    serverTime: Date.now(),
  }));
}

async function handleMessage(
  socket: WebSocket,
  message: any,
  request: FastifyRequest
) {
  const client = clients.get(socket);
  if (!client) return;

  const { op } = message;

  switch (op) {
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
        error: {
          code: 'UNKNOWN_OPERATION',
          message: `Unknown operation: ${op}`,
        },
      }));
  }
}

function handlePing(socket: WebSocket, client: ClientState) {
  const now = Date.now();
  const timeSinceLastPing = now - client.lastPing;
  logger.debug(`[WS] Ping received (last ping ${timeSinceLastPing}ms ago)`);
  client.lastPing = now;
  socket.send(JSON.stringify({
    op: 'pong',
    serverTime: now,
  }));
}

async function handleSubscribe(
  socket: WebSocket,
  client: ClientState,
  message: any
) {
  const { channel, market, assets } = message;

  // Validate channel
  const validChannels = ['orderbook', 'trades', 'trades:global', 'prices', 'market'];
  if (!validChannels.includes(channel)) {
    socket.send(JSON.stringify({
      error: {
        code: 'INVALID_CHANNEL',
        message: `Invalid channel: ${channel}`,
      },
    }));
    return;
  }

  // User channel requires authentication
  if (channel === 'user' && !client.authenticated) {
    socket.send(JSON.stringify({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required for user channel',
      },
    }));
    return;
  }

  // Add subscription
  client.subscriptions.push({ channel, market, assets });
  updateBroadcastClient(socket, client);
  
  // DEBUG: Log subscription details
  logger.info(`[WS] Client subscribed: channel=${channel}, market=${market || 'N/A'}, assets=${assets?.join(',') || 'N/A'}`);

  socket.send(JSON.stringify({
    op: 'subscribed',
    channel,
    market,
    assets,
  }));

  // Send initial data based on channel
  if (channel === 'orderbook' && market) {
    await sendOrderbookSnapshot(socket, market);
  } else if (channel === 'prices' && assets) {
    await sendPriceSnapshot(socket, assets);
  }
}

function handleUnsubscribe(
  socket: WebSocket,
  client: ClientState,
  message: any
) {
  const { channel, market } = message;

  client.subscriptions = client.subscriptions.filter(
    (sub) => !(sub.channel === channel && sub.market === market)
  );
  updateBroadcastClient(socket, client);

  socket.send(JSON.stringify({
    op: 'unsubscribed',
    channel,
    market,
  }));
}

async function handleAuth(
  socket: WebSocket,
  client: ClientState,
  message: any,
  request: FastifyRequest
) {
  const { token } = message;

  if (!token) {
    socket.send(JSON.stringify({
      op: 'auth',
      status: 'error',
      error: {
        code: 'INVALID_TOKEN',
        message: 'Token is required',
      },
    }));
    return;
  }

  try {
    // Verify JWT using Fastify's JWT plugin
    const decoded = request.server.jwt.verify<{
      sub: string;
      address: string;
    }>(token);

    client.authenticated = true;
    client.userId = decoded.sub;
    client.address = decoded.address;

    socket.send(JSON.stringify({
      op: 'auth',
      status: 'authenticated',
      wallet: decoded.address,
    }));

    // Auto-subscribe to user channel
    client.subscriptions.push({
      channel: 'user',
      market: undefined,
    });
    updateBroadcastClient(socket, client);

    logger.info(`WebSocket authenticated: ${decoded.address}`);
  } catch (err) {
    socket.send(JSON.stringify({
      op: 'auth',
      status: 'error',
      error: {
        code: 'INVALID_TOKEN',
        message: 'Token verification failed',
      },
    }));
  }
}

async function handleSnapshot(socket: WebSocket, message: any) {
  const { channel, market, lastSeqId } = message;

  if (channel === 'orderbook' && market) {
    // Get current sequence ID
    const currentSeqId = await redis.get(RedisKeys.sequence(market));
    const currentSeq = parseInt(currentSeqId || '0');

    // If there's a gap, send full snapshot
    if (!lastSeqId || currentSeq > lastSeqId + 1) {
      await sendOrderbookSnapshot(socket, market, true);
    }
  }
}

async function sendOrderbookSnapshot(
  socket: WebSocket,
  marketId: string,
  isFullSnapshot: boolean = false
) {
  try {
    // Get orderbook from Redis for BOTH YES and NO outcomes
    // NOTE: Bids use NEGATIVE scores (-price * 1M), so zrange returns highest prices first
    const [yesBidData, yesAskData, noBidData, noAskData, sequenceId] = await Promise.all([
      redis.zrange(RedisKeys.orderbook(marketId, 'YES', 'BID'), 0, -1, 'WITHSCORES'),  // zrange for negative scores!
      redis.zrange(RedisKeys.orderbook(marketId, 'YES', 'ASK'), 0, -1, 'WITHSCORES'),
      redis.zrange(RedisKeys.orderbook(marketId, 'NO', 'BID'), 0, -1, 'WITHSCORES'),   // zrange for negative scores!
      redis.zrange(RedisKeys.orderbook(marketId, 'NO', 'ASK'), 0, -1, 'WITHSCORES'),
      redis.get(RedisKeys.sequence(marketId)),
    ]);

    const yesBids = parseOrderbookData(yesBidData);
    const yesAsks = parseOrderbookData(yesAskData);
    const noBids = parseOrderbookData(noBidData);
    const noAsks = parseOrderbookData(noAskData);

    // Send YES orderbook snapshot
    socket.send(JSON.stringify({
      channel: 'orderbook',
      market: marketId,
      snapshot: isFullSnapshot,
      data: {
        outcome: 'YES',
        bids: yesBids,
        asks: yesAsks,
        sequenceId: parseInt(sequenceId || '0'),
      },
    }));
    
    // Send NO orderbook snapshot
    socket.send(JSON.stringify({
      channel: 'orderbook',
      market: marketId,
      snapshot: isFullSnapshot,
      data: {
        outcome: 'NO',
        bids: noBids,
        asks: noAsks,
        sequenceId: parseInt(sequenceId || '0'),
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
      if (cached) {
        prices[asset] = JSON.parse(cached);
      }
    }

    socket.send(JSON.stringify({
      channel: 'prices',
      data: prices,
    }));
  } catch (err) {
    logger.error('Error sending price snapshot:', err);
  }
}

function parseOrderbookData(data: string[]): [number, number][] {
  const result: [number, number][] = [];

  // Data comes as [member, score, member, score, ...]
  // member = "orderId:size:timestamp", score = price * 1000000 (negative for bids)
  for (let i = 0; i < data.length; i += 2) {
    const member = data[i];
    const scoreStr = data[i + 1];
    
    // Extract size from member (format: orderId:size:timestamp)
    const parts = member.split(':');
    const size = parts.length >= 2 ? parseFloat(parts[1]) : NaN;
    const price = Math.abs(parseFloat(scoreStr)) / 1000000;  // Use Math.abs for negative bid scores

    if (!isNaN(price) && !isNaN(size) && size > 0) {
      result.push([price, size]);
    }
  }

  return result;
}

// Export broadcasting functions moved to broadcasts.ts
export { 
  broadcastOrderbookUpdate, 
  broadcastTrade, 
  broadcastPriceUpdate, 
  broadcastMarketResolved,
  broadcastUserFill,
  broadcastUserSettlement
};
