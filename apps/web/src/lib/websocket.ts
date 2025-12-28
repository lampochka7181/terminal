/**
 * WebSocket Service for Degen Terminal
 * Handles real-time data streams
 */

import { getAuthToken } from './api';

// WebSocket URL - ensure it includes the /ws path
const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000';
const WS_URL = WS_BASE_URL.endsWith('/ws') ? WS_BASE_URL : `${WS_BASE_URL}/ws`;

export type Channel = 'orderbook' | 'trades' | 'prices' | 'user' | 'market';

export interface WSMessage {
  op?: string;
  channel?: Channel;
  type?: string;  // Backend uses 'type' for broadcast messages
  market?: string;
  assets?: string[];
  event?: string;
  data?: unknown;
  status?: string;
  serverTime?: number;
  token?: string;
  lastSeqId?: number;
  snapshot?: boolean;
}

export interface OrderbookUpdate {
  channel: 'orderbook';
  market: string;
  data: {
    bids: [number, number][];
    asks: [number, number][];
    sequenceId: number;
  };
}

export interface TradeUpdate {
  channel: 'trades';
  market: string;
  data: {
    id: string;
    price: number;
    size: number;
    outcome: 'yes' | 'no';
    side: 'buy' | 'sell';
    timestamp: number;
    txSignature?: string;
  };
}

export interface PriceUpdate {
  channel: 'prices';
  data: {
    asset: 'BTC' | 'ETH' | 'SOL';
    price: number;
    timestamp: number;
  };
}

export interface MarketResolvedUpdate {
  channel: 'market';
  market: string;
  event: 'resolved';
  data: {
    outcome: 'yes' | 'no';
    finalPrice: number;
    strikePrice: number;
    resolvedAt: number;
  };
}

export interface MarketActivatedUpdate {
  channel: 'market';
  type: 'market_activated';
  market?: string;
  data: {
    address?: string;
    marketId: string;
    asset: 'BTC' | 'ETH' | 'SOL';
    timeframe: string;
    strikePrice: number;
    expiryAt: number;
    timestamp: number;
  };
}

export interface UserFillUpdate {
  channel: 'user';
  event: 'fill';
  data: {
    orderId: string;
    marketAddress: string;
    side: 'bid' | 'ask';
    outcome: 'yes' | 'no';
    price: number;
    filledSize: number;
    remainingSize: number;
    status: 'partial' | 'filled';
    timestamp: number;
  };
}

export interface UserSettlementUpdate {
  channel: 'user';
  event: 'settlement';
  data: {
    marketAddress: string;
    outcome: 'yes' | 'no';
    yourShares: number;
    payout: number;
    profit: number;
    newBalance: number;
    txSignature: string;
  };
}

type WSUpdate =
  | OrderbookUpdate
  | TradeUpdate
  | PriceUpdate
  | MarketResolvedUpdate
  | MarketActivatedUpdate
  | UserFillUpdate
  | UserSettlementUpdate;

type MessageHandler = (message: WSUpdate) => void;
type ConnectionHandler = () => void;
type ErrorHandler = (error: Event) => void;

export class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private pingInterval: NodeJS.Timeout | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private connectHandlers: Set<ConnectionHandler> = new Set();
  private disconnectHandlers: Set<ConnectionHandler> = new Set();
  private errorHandlers: Set<ErrorHandler> = new Set();
  private subscriptions: Map<string, WSMessage> = new Map();
  private isAuthenticated = false;
  private lastSequenceIds: Map<string, number> = new Map();

  constructor(url: string = WS_URL) {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      // If already connecting, wait
      if (this.ws?.readyState === WebSocket.CONNECTING) {
        const checkReady = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            clearInterval(checkReady);
            resolve();
          } else if (this.ws?.readyState !== WebSocket.CONNECTING) {
            clearInterval(checkReady);
            reject(new Error('Connection failed'));
          }
        }, 100);
        return;
      }

      try {
        console.log('[WS] Connecting to', this.url);
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log('[WS] Connected');
          this.reconnectAttempts = 0;
          this.startPingInterval();
          
          // Small delay to ensure WebSocket is fully ready before sending
          setTimeout(() => {
            // First resubscribe to existing subscriptions
            this.resubscribe();
            // Then notify handlers
            this.connectHandlers.forEach((handler) => {
              try {
                handler();
              } catch (err) {
                console.error('[WS] Connect handler error:', err);
              }
            });
          }, 50);
          
          resolve();
        };

        this.ws.onclose = (event) => {
          console.log('[WS] Disconnected', event.code, event.reason);
          this.stopPingInterval();
          this.isAuthenticated = false;
          this.disconnectHandlers.forEach((handler) => handler());

          // Auto-reconnect unless intentionally closed
          if (event.code !== 1000) {
            this.attemptReconnect();
          }
        };

        this.ws.onerror = (error) => {
          console.error('[WS] Error', error);
          this.errorHandlers.forEach((handler) => handler(error));
          // Don't reject here - let onclose handle it
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as WSMessage;
            this.handleMessage(message);
          } catch (err) {
            console.error('[WS] Failed to parse message', err);
          }
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.subscriptions.clear();
    this.lastSequenceIds.clear();
    this.isAuthenticated = false;
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      this.send({ op: 'ping' });
    }, 30000); // 30 second heartbeat
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch(console.error);
    }, delay);
  }

  private resubscribe(): void {
    // Re-authenticate if we have a token
    const token = getAuthToken();
    if (token && !this.isAuthenticated) {
      this.authenticate(token);
    }

    // Resubscribe to all channels
    this.subscriptions.forEach((subscription) => {
      this.send(subscription);
    });
  }

  private handleMessage(message: WSMessage): void {
    // Handle pong
    if (message.op === 'pong') {
      return;
    }

    // Handle auth response
    if (message.op === 'auth') {
      this.isAuthenticated = message.status === 'authenticated';
      return;
    }

    // Handle welcome message
    if (message.op === 'welcome') {
      console.log('[WS] Received welcome, server time:', message.serverTime);
      return;
    }

    // Handle subscription confirmations
    if (message.op === 'subscribed' || message.op === 'unsubscribed') {
      console.log(`[WS] ${message.op}: ${message.channel}`, message.market || message.assets);
      return;
    }

    // Normalize message format - backend uses both 'channel' and 'type'
    // Convert 'type' based messages to 'channel' format for handlers
    let normalizedMessage = message;
    
    if (message.type && !message.channel) {
      // Map backend 'type' to frontend 'channel'
      if (message.type === 'price_update') {
        normalizedMessage = {
          ...message,
          channel: 'prices',
        };
      } else if (message.type === 'orderbook_update') {
        normalizedMessage = {
          ...message,
          channel: 'orderbook',
        };
      } else if (message.type === 'trade') {
        normalizedMessage = {
          ...message,
          channel: 'trades',
        };
      } else if (message.type === 'market_resolved') {
        normalizedMessage = {
          ...message,
          channel: 'market',
        };
      } else if (message.type === 'market_activated') {
        normalizedMessage = {
          ...message,
          channel: message.channel || 'market',
        };
      } else if (message.type === 'fill') {
        normalizedMessage = {
          ...message,
          channel: 'user',
          event: 'fill',
        };
      } else if (message.type === 'settlement') {
        normalizedMessage = {
          ...message,
          channel: 'user',
          event: 'settlement',
        };
      }
    }

    // Handle channel messages
    if (normalizedMessage.channel) {
      // Check for sequence gaps (orderbook only)
      if (normalizedMessage.channel === 'orderbook' && normalizedMessage.market) {
        const data = normalizedMessage.data as { sequenceId?: number };
        if (data?.sequenceId !== undefined) {
          const lastSeq = this.lastSequenceIds.get(normalizedMessage.market);
          
          if (lastSeq !== undefined && data.sequenceId > lastSeq + 1) {
            console.warn(`[WS] Sequence gap detected for ${normalizedMessage.market}: ${lastSeq} -> ${data.sequenceId}`);
            // Request snapshot to fill gap
            this.requestSnapshot(normalizedMessage.market, lastSeq);
          }
          
          this.lastSequenceIds.set(normalizedMessage.market, data.sequenceId);
        }
      }

      // Dispatch to handlers
      this.messageHandlers.forEach((handler) => {
        try {
          handler(normalizedMessage as WSUpdate);
        } catch (err) {
          console.error('[WS] Handler error:', err);
        }
      });
    }
  }

  private send(message: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Queue the message to be sent when connected
      console.debug('[WS] Queuing message, not connected yet:', message.op, message.channel);
    }
  }

  // Public API
  authenticate(token: string): void {
    this.send({ op: 'auth', token });
  }

  subscribeOrderbook(marketAddress: string): void {
    const key = `orderbook:${marketAddress}`;
    const message: WSMessage = {
      op: 'subscribe',
      channel: 'orderbook',
      market: marketAddress,
    };
    this.subscriptions.set(key, message);
    this.send(message);
  }

  unsubscribeOrderbook(marketAddress: string): void {
    const key = `orderbook:${marketAddress}`;
    this.subscriptions.delete(key);
    this.lastSequenceIds.delete(marketAddress);
    this.send({
      op: 'unsubscribe',
      channel: 'orderbook',
      market: marketAddress,
    });
  }

  subscribeTrades(marketAddress: string): void {
    const key = `trades:${marketAddress}`;
    const message: WSMessage = {
      op: 'subscribe',
      channel: 'trades',
      market: marketAddress,
    };
    this.subscriptions.set(key, message);
    this.send(message);
  }

  unsubscribeTrades(marketAddress: string): void {
    const key = `trades:${marketAddress}`;
    this.subscriptions.delete(key);
    this.send({
      op: 'unsubscribe',
      channel: 'trades',
      market: marketAddress,
    });
  }

  subscribePrices(assets: ('BTC' | 'ETH' | 'SOL')[] = ['BTC', 'ETH', 'SOL']): void {
    const key = `prices:${assets.join(',')}`;
    const message: WSMessage = {
      op: 'subscribe',
      channel: 'prices',
      assets,
    };
    this.subscriptions.set(key, message);
    this.send(message);
  }

  unsubscribePrices(): void {
    // Remove all price subscriptions
    for (const key of this.subscriptions.keys()) {
      if (key.startsWith('prices:')) {
        this.subscriptions.delete(key);
      }
    }
    this.send({
      op: 'unsubscribe',
      channel: 'prices',
    });
  }

  subscribeMarket(marketAddress: string): void {
    const key = `market:${marketAddress}`;
    const message: WSMessage = {
      op: 'subscribe',
      channel: 'market',
      market: marketAddress,
    };
    this.subscriptions.set(key, message);
    this.send(message);
  }

  unsubscribeMarket(marketAddress: string): void {
    const key = `market:${marketAddress}`;
    this.subscriptions.delete(key);
    this.send({
      op: 'unsubscribe',
      channel: 'market',
      market: marketAddress,
    });
  }

  requestSnapshot(marketAddress: string, lastSeqId: number): void {
    this.send({
      op: 'snapshot',
      channel: 'orderbook',
      market: marketAddress,
      lastSeqId,
    });
  }

  // Event handlers
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onConnect(handler: ConnectionHandler): () => void {
    this.connectHandlers.add(handler);
    return () => this.connectHandlers.delete(handler);
  }

  onDisconnect(handler: ConnectionHandler): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  // Status
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get authenticated(): boolean {
    return this.isAuthenticated;
  }
}

// Singleton instance
let wsInstance: WebSocketService | null = null;

export function getWebSocket(): WebSocketService {
  if (!wsInstance) {
    wsInstance = new WebSocketService();
  }
  return wsInstance;
}

export function createWebSocket(url?: string): WebSocketService {
  return new WebSocketService(url);
}

export default WebSocketService;

