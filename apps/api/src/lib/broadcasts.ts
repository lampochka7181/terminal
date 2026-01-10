import { logger } from './logger.js';

/**
 * Broadcast Manager
 * 
 * Handles WebSocket broadcasting without circular dependencies.
 * WebSocket handlers register their connections here.
 */

// Minimal WebSocket shape we need (avoid importing 'ws' just for types/constants)
type WebSocketLike = {
  readyState: number;
  send: (data: string) => void;
};

const WS_OPEN = 1; // WebSocket.OPEN

// Client connection storage (managed by websocket.ts)
let clients: Map<WebSocketLike, { subscriptions: Set<string>; wallet?: string; userId?: string }> = new Map();

/**
 * Register the clients map from websocket handler
 */
export function registerClients(clientsMap: Map<WebSocketLike, { subscriptions: Set<string>; wallet?: string; userId?: string }>) {
  clients = clientsMap;
}

/**
 * Broadcast to all clients subscribed to a channel
 */
function broadcast(channel: string, data: any): void {
  let sent = 0;
  let totalClients = 0;
  let subscribed = 0;
  let ready = 0;
  
  for (const [ws, client] of clients) {
    totalClients++;
    if (ws.readyState === WS_OPEN) {
      ready++;
      if (client.subscriptions.has(channel)) {
        subscribed++;
        try {
          ws.send(JSON.stringify(data));
          sent++;
        } catch (err) {
          logger.error(`Failed to send to client:`, err);
        }
      }
    }
  }
  
  // Only log when actually sending to clients (reduce noise)
  if (sent > 0) {
    logger.debug(`Broadcast to ${sent} clients on ${channel}`);
  }
}

/**
 * Broadcast to a specific user by their UUID
 * Direct format for frontend 'user' channel
 */
function broadcastToUser(userId: string, event: string, data: any): void {
  const message = JSON.stringify({
    channel: 'user',
    event,
    data,
    timestamp: Date.now(),
  });

  for (const [ws, client] of clients) {
    if (ws.readyState === WS_OPEN && client.userId === userId) {
      try {
        ws.send(message);
      } catch (err) {
        logger.error(`Failed to send to user ${userId}:`, err);
      }
    }
  }
}

// ========================
// Public Broadcast Functions
// ========================

export function broadcastOrderbookUpdate(
  marketId: string, 
  bids: [number, number][], 
  asks: [number, number][],
  sequenceId: number,
  outcome?: 'YES' | 'NO'
): void {
  // DEBUG: Log broadcast details
  logger.debug(`[Broadcast] Orderbook update: market=${marketId.slice(0, 8)}..., outcome=${outcome || 'YES'}, bids=${bids.length}, asks=${asks.length}, seq=${sequenceId}`);
  
  // Broadcast to market-specific channel
  broadcast(`orderbook:${marketId}`, {
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
  }
): void {
  broadcast(`trades:${marketId}`, {
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

/**
 * Broadcast a trade to the global trade blotter
 * Shows all trades across the platform in real-time
 */
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
  }
): void {
  // Broadcast to global trades channel
  broadcast('trades:global', {
    type: 'global_trade',
    channel: 'trades:global',
    data: {
      ...trade,
      solscanUrl: trade.txSignature ? `https://solscan.io/tx/${trade.txSignature}` : null,
    },
  });
}

export function broadcastPriceUpdate(
  asset: string,
  price: number,
  timestamp: number
): void {
  broadcast(`prices:${asset}`, {
    channel: 'prices',
    type: 'price_update',
    data: {
      asset,
      price,
      timestamp,
    },
  });
}

export function broadcastMarketResolved(
  marketId: string,
  outcome: 'YES' | 'NO',
  finalPrice: number,
  strikePrice: number
): void {
  broadcast(`market:${marketId}`, {
    type: 'market_resolved',
    data: {
      marketId,
      outcome,
      finalPrice,
      strikePrice,
      timestamp: Date.now(),
    },
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
  }
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
  }
): void {
  broadcastToUser(userId, 'settlement', settlement);
}

/**
 * Broadcast market activation (strike price set, trading now enabled)
 * This allows frontends to immediately update without waiting for polling
 */
export function broadcastMarketActivated(
  marketAddress: string,
  data: {
    marketId: string;
    asset: string;
    timeframe: string;
    strikePrice: number;
    expiryAt: number;
  }
): void {
  broadcast(`market:${marketAddress}`, {
    type: 'market_activated',
    channel: 'market',
    market: marketAddress,
    data: {
      ...data,
      timestamp: Date.now(),
    },
  });
  
  // Also broadcast to a global 'markets' channel for clients that aren't subscribed to specific markets yet
  broadcastGlobal({
    type: 'market_activated',
    channel: 'markets',
    data: {
      address: marketAddress,
      ...data,
      timestamp: Date.now(),
    },
  });
}

/**
 * Broadcast to all connected clients (global channel)
 */
function broadcastGlobal(data: any): void {
  let sent = 0;
  
  for (const [ws] of clients) {
    if (ws.readyState === WS_OPEN) {
      try {
        ws.send(JSON.stringify(data));
        sent++;
      } catch (err) {
        logger.error(`Failed to send global broadcast:`, err);
      }
    }
  }
  
  if (sent > 0) {
    logger.debug(`Global broadcast to ${sent} clients: ${data.type}`);
  }
}
