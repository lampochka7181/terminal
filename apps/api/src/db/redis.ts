import Redis from 'ioredis';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

console.log('🔴 Redis URL:', config.redisUrl);

// Create Redis client
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
  connectTimeout: 5000,
  // Don't throw on connection failure
  enableOfflineQueue: false,
});

// Event handlers
redis.on('connect', () => {
  logger.info('Redis connected');
});

redis.on('error', (err) => {
  logger.error('Redis error:', err);
});

redis.on('close', () => {
  logger.warn('Redis connection closed');
});

// Health check function
export async function checkRedisHealth(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (err) {
    logger.error('Redis health check failed:', err);
    return false;
  }
}

// Connect function
export async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
  } catch (err) {
    // Connection might already be established
    if ((err as Error).message !== 'Redis is already connecting/connected') {
      throw err;
    }
  }
}

// Graceful shutdown
export async function closeRedisConnection(): Promise<void> {
  await redis.quit();
  logger.info('Redis connection closed');
}

// Redis key prefixes
export const RedisKeys = {
  // Orderbook keys
  orderbook: (marketId: string, outcome: string, side: string) => 
    `orderbook:${marketId}:${outcome}:${side}`,
  
  // Sequence ID for orderbook updates
  sequence: (marketId: string) => `sequence:${marketId}`,
  
  // Price cache
  price: (asset: string) => `price:${asset}`,
  
  // Session/nonce cache (for auth)
  nonce: (address: string) => `nonce:${address}`,
  
  // Rate limiting
  rateLimit: (address: string, endpoint: string) => `ratelimit:${address}:${endpoint}`,
  
  // Markets cache
  markets: (filter: string) => `markets:list:${filter}`,
  
  // WebSocket subscriptions
  wsSubscription: (market: string, channel: string) => `ws:${market}:${channel}`,
} as const;

