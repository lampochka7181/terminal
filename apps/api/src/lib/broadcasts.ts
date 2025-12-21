import { WebSocket } from 'ws';
import { logger } from './logger.js';

/**
 * Broadcast Manager
 * 
 * Handles WebSocket broadcasting without circular dependencies.
 * WebSocket handlers register their connections here.
 */

// Client connection storage (managed by websocket.ts)
let clients: Map<WebSocket, { subscriptions: Set<string>; wallet?: string }> = new Map();

/**
 * Register the clients map from websocket handler
 */
export function registerClients(clientsMap: Map<WebSocket, { subscriptions: Set<string>; wallet?: string }>) {
  clients = clientsMap;
}

/**
 * Broadcast to all clients subscribed to a channel
 */
function broadcast(channel: string, data: any): void {
  let sent = 0;
  
  for (const [ws, client] of clients) {
    if (ws.readyState === WebSocket.OPEN && client.subscriptions.has(channel)) {
      try {
        ws.send(JSON.stringify(data));
        sent++;
      } catch (err) {
        logger.error(`Failed to send to client:`, err);
      }
    }
  }
  
  if (sent > 0) {
    logger.debug(`Broadcast to ${sent} clients on ${channel}`);
  }
}

/**
 * Broadcast to a specific user
 */
function broadcastToUser(wallet: string, data: any): void {
  for (const [ws, client] of clients) {
    if (ws.readyState === WebSocket.OPEN && client.wallet === wallet) {
      try {
        ws.send(JSON.stringify(data));
      } catch (err) {
        logger.error(`Failed to send to user ${wallet}:`, err);
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

export function broadcastPriceUpdate(
  asset: string,
  price: number,
  timestamp: number
): void {
  broadcast(`prices:${asset}`, {
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
  wallet: string,
  fill: {
    tradeId?: string;
    orderId: string;
    marketId: string;
    side: string;
    outcome: string;
    price: number;
    size: number;
    fee: number;
  }
): void {
  broadcastToUser(wallet, {
    type: 'fill',
    data: fill,
  });
}

export function broadcastUserSettlement(
  wallet: string,
  settlement: {
    marketId: string;
    outcome: string;
    size: number;
    payout: number;
  }
): void {
  broadcastToUser(wallet, {
    type: 'settlement',
    data: settlement,
  });
}



