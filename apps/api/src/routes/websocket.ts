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
      if (now - client.lastPing > PING_TIMEOUT) {
        logger.info('Client timed out, closing connection');
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
  logger.info('WebSocket client connected');
  
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
    logger.info('WebSocket client disconnected');
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
  client.lastPing = Date.now();
  socket.send(JSON.stringify({
    op: 'pong',
    serverTime: Date.now(),
  }));
}

async function handleSubscribe(
  socket: WebSocket,
  client: ClientState,
  message: any
) {
  const { channel, market, assets } = message;

  // Validate channel
  const validChannels = ['orderbook', 'trades', 'prices', 'market'];
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
    // Get orderbook from Redis
    const [bidData, askData, sequenceId] = await Promise.all([
      redis.zrevrange(RedisKeys.orderbook(marketId, 'YES', 'BID'), 0, -1, 'WITHSCORES'),
      redis.zrange(RedisKeys.orderbook(marketId, 'YES', 'ASK'), 0, -1, 'WITHSCORES'),
      redis.get(RedisKeys.sequence(marketId)),
    ]);

    const bids = parseOrderbookData(bidData);
    const asks = parseOrderbookData(askData);

    socket.send(JSON.stringify({
      channel: 'orderbook',
      market: marketId,
      snapshot: isFullSnapshot,
      data: {
        bids,
        asks,
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

  for (let i = 0; i < data.length; i += 2) {
    const size = parseFloat(data[i]);
    const price = parseFloat(data[i + 1]);

    if (!isNaN(price) && !isNaN(size)) {
      result.push([price / 1000000, size]); // Convert from 6 decimals
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
