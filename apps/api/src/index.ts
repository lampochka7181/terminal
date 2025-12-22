process.setMaxListeners(20);

import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { logger } from './lib/logger.js';

// Database
import { checkDatabaseHealth, closeDatabaseConnection } from './db/index.js';
import { redis, checkRedisHealth, connectRedis, closeRedisConnection } from './db/redis.js';

// Routes
import { authRoutes } from './routes/auth.js';
import { marketRoutes } from './routes/markets.js';
import { orderRoutes } from './routes/orders.js';
import { userRoutes } from './routes/user.js';
import { wsHandler } from './routes/websocket.js';
import { apiLogger } from './lib/logger.js';

// Keeper Jobs
import { startKeeperJobs, stopKeeperJobs } from './jobs/index.js';

// Price Feed
import { priceFeedService } from './services/price-feed.service.js';

// Market Maker Bot
import { mmBot } from './bot/mm-bot.js';

// Anchor Client (for config endpoint)
import { anchorClient } from './lib/anchor-client.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    ...(process.env.NODE_ENV !== 'production' && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    }),
  },
  disableRequestLogging: true, // Disable standard verbose request logging
});

// Add hook to capture errors for onResponse logging
app.addHook('onError', async (request, reply, error) => {
  (reply as any).error = error;
});

// Add hook to log requests to apiLogger (writes to file, suppressed from console)
app.addHook('onResponse', async (request, reply) => {
  const duration = reply.elapsedTime;
  apiLogger.info(`${request.method} ${request.url} - ${reply.statusCode} (${duration.toFixed(2)}ms)`, {
    method: request.method,
    url: request.url,
    statusCode: reply.statusCode,
    responseTime: duration,
    source: 'API_REQUEST',
  });

  // If it's a 500 error, also log it to the system logger so it shows in the terminal
  if (reply.statusCode >= 500) {
    const error = (reply as any).error || (request as any).error;
    const msg = error ? (error.stack || error.message) : 'Unknown Error';
    logger.error(`API 500 Error: ${request.method} ${request.url} (${duration.toFixed(2)}ms)\n${msg}`);
  }
});

async function main() {
  // ========================
  // Initialize Connections
  // ========================
  
  console.log('🚀 Initializing connections...\n');
  
  // Connect to Redis (optional - app works without it)
  try {
    await connectRedis();
    console.log('✅ Redis connected\n');
  } catch (err) {
    console.log('⚠️  Redis not available - continuing without cache\n');
    console.log('   (This is OK for development. Orderbook will use DB fallback)\n');
  }

  // Test database connection (required)
  const dbHealthy = await checkDatabaseHealth();
  if (!dbHealthy) {
    console.error('\n❌ Cannot connect to database. Check your DATABASE_URL in .env\n');
    console.error('   Expected format: postgresql://user:password@host:port/database\n');
    process.exit(1);
  }
  console.log('');

  // ========================
  // Register Plugins
  // ========================

  // CORS
  await app.register(cors, {
    origin: config.corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // JWT
  await app.register(jwt, {
    secret: config.jwtSecret,
    sign: {
      expiresIn: config.jwtExpiresIn,
    },
  });

  // Rate Limiting
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      // Use user ID for authenticated requests, IP for anonymous
      const user = request.user as { sub?: string } | undefined;
      return user?.sub || request.ip;
    },
    errorResponseBuilder: (request, context) => ({
      error: {
        code: 'RATE_LIMITED',
        message: `Too many requests. Please slow down.`,
        details: {
          limit: context.max,
          remaining: context.remaining,
          resetAt: context.after,
        },
      },
    }),
  });

  // WebSocket
  await app.register(websocket);

  // ========================
  // System Endpoints
  // ========================

  // Health check
  app.get('/health', async () => {
    const [dbHealth, redisHealth] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
    ]);
    
    const priceFeedHealth = priceFeedService.isHealthy();
    const mmStatus = mmBot.getStatus();

    const status = dbHealth ? 'ok' : 'degraded';

    return {
      status,
      timestamp: Date.now(),
      version: '0.1.0',
      services: {
        database: dbHealth ? 'ok' : 'error',
        redis: redisHealth ? 'ok' : 'error',
        priceFeed: priceFeedHealth ? 'ok' : 'degraded',
        marketMaker: mmStatus.running ? 'ok' : 'disabled',
        solana: 'ok', // TODO: Add Solana RPC health check
      },
      marketMaker: {
        enabled: config.mmEnabled,
        running: mmStatus.running,
        markets: mmStatus.markets,
        orders: mmStatus.totalOrders,
      },
    };
  });

  // Server time (for client clock sync)
  app.get('/time', async () => ({
    serverTime: Date.now(),
  }));

  // Fee schedule
  app.get('/fees', async () => ({
    trading: {
      makerFee: config.makerFeeBps / 10000,
      takerFee: config.takerFeeBps / 10000,
    },
    settlement: {
      claimFee: 0,
    },
    discounts: {
      volumeTiers: [
        { minVolume: 0, makerDiscount: 0, takerDiscount: 0 },
        { minVolume: 100000, makerDiscount: 0, takerDiscount: 0.10 },
        { minVolume: 1000000, makerDiscount: 0, takerDiscount: 0.25 },
      ],
    },
  }));

  // Orderbook debug endpoint (for testing)
  app.get('/debug/orderbook/:marketId', async (request, reply) => {
    const { marketId } = request.params as { marketId: string };
    const { orderbookService } = await import('./services/orderbook.service.js');
    
    const [yesSnapshot, noSnapshot] = await Promise.all([
      orderbookService.getSnapshot(marketId, 'YES'),
      orderbookService.getSnapshot(marketId, 'NO'),
    ]);
    
    return {
      marketId,
      YES: {
        bids: yesSnapshot.bids,
        asks: yesSnapshot.asks,
        sequenceId: yesSnapshot.sequenceId,
      },
      NO: {
        bids: noSnapshot.bids,
        asks: noSnapshot.asks,
        sequenceId: noSnapshot.sequenceId,
      },
    };
  });

  // Trades debug endpoint (for testing)
  app.get('/debug/trades', async (request, reply) => {
    const { trades } = await import('./db/index.js');
    const { desc, sql } = await import('drizzle-orm');
    
    const result = await db
      .select({
        id: trades.id,
        outcome: trades.outcome,
        price: trades.price,
        size: trades.size,
        executedAt: trades.executedAt,
        makerOrderId: trades.makerOrderId,
        takerOrderId: trades.takerOrderId,
      })
      .from(trades)
      .orderBy(desc(trades.executedAt))
      .limit(20);
    
    // Count by outcome
    const yesCount = result.filter(t => t.outcome === 'YES').length;
    const noCount = result.filter(t => t.outcome === 'NO').length;
    
    return {
      summary: {
        total: result.length,
        yesCount,
        noCount,
      },
      trades: result.map(t => ({
        ...t,
        price: parseFloat(t.price || '0'),
        size: parseFloat(t.size || '0'),
      })),
    };
  });

  // MM Bot debug endpoint (for testing)
  app.get('/debug/mm', async () => {
    const status = mmBot.getStatus();
    
    // Get quote info for each market
    const marketQuotes: Record<string, any> = {};
    for (const market of status.marketDetails) {
      const quoteInfo = await mmBot.getQuoteInfo(market.id);
      if (quoteInfo) {
        marketQuotes[market.id] = {
          asset: market.asset,
          timeframe: market.timeframe,
          strike: market.strike,
          currentPrice: quoteInfo.currentPrice,
          fairValue: quoteInfo.fairValue,
          inventorySkew: quoteInfo.inventorySkew,
          yesBids: quoteInfo.quotes.bids,
          yesAsks: quoteInfo.quotes.asks,
          position: {
            yes: market.yesPosition,
            no: market.noPosition,
          },
          secondsToExpiry: market.secondsToExpiry,
        };
      }
    }
    
    return {
      status: {
        running: status.running,
        initialized: status.initialized,
        wallet: status.wallet,
        userId: status.userId,
        totalMarkets: status.markets,
        totalOrders: status.totalOrders,
      },
      markets: marketQuotes,
    };
  });

  // ========================
  // API Routes
  // ========================

  // Register route plugins
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(marketRoutes, { prefix: '/markets' });
  await app.register(orderRoutes, { prefix: '/orders' });
  await app.register(userRoutes, { prefix: '/user' });

  // Public config endpoint (relayer address for delegation)
  app.get('/config', async () => {
    return {
      relayerAddress: anchorClient.getRelayerPublicKey() || null,
      usdcMint: config.usdcMint,
      programId: config.programId,
      delegationEnabled: true,
    };
  });

  // WebSocket endpoint
  app.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, wsHandler);
  });

  // ========================
  // Error Handlers
  // ========================

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    // Log detailed error to apiLogger (writes to file)
    apiLogger.error(`Request error: ${request.method} ${request.url} - ${error.message}`, {
      err: error,
      url: request.url,
      method: request.method,
      statusCode: error.statusCode,
      source: 'API_ERROR',
    });

    // Also log to console in dev
    if (process.env.NODE_ENV !== 'production') {
      logger.error({ err: error, url: request.url }, 'Request error');
    }
    if (error.validation) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Validation failed',
          details: error.validation,
        },
      });
    }

    // Handle JWT errors
    if (error.code === 'FST_JWT_NO_AUTHORIZATION_IN_HEADER' ||
        error.code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED' ||
        error.code === 'FST_JWT_AUTHORIZATION_TOKEN_INVALID') {
      return reply.code(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired authentication token',
        },
      });
    }

    // Default error response
    const statusCode = error.statusCode || 500;
    return reply.code(statusCode).send({
      error: {
        code: statusCode === 500 ? 'INTERNAL_ERROR' : 'ERROR',
        message: statusCode === 500 ? 'An unexpected error occurred' : error.message,
      },
    });
  });

  // 404 handler
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
      },
    });
  });

  // ========================
  // Graceful Shutdown
  // ========================

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    
    try {
      await mmBot.stop();
      priceFeedService.stop();
      stopKeeperJobs();
      await app.close();
      await closeRedisConnection();
      await closeDatabaseConnection();
      logger.info('Server shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ========================
  // Start Server
  // ========================

  try {
    await app.listen({
      port: config.port,
      host: config.host,
    });
    
    logger.info(`🚀 Server running on http://${config.host}:${config.port}`);
    logger.info(`📡 WebSocket available at ws://${config.host}:${config.port}/ws`);
    logger.info(`📋 Health check at http://${config.host}:${config.port}/health`);
    
    // Start price feed (Binance WebSocket)
    priceFeedService.start();
    logger.info('📈 Price feed started (Binance)');
    
    // Start keeper jobs (market creator, resolver, settler, etc.)
    startKeeperJobs();
    logger.info('⚙️  Keeper jobs started');
    
    // Start Market Maker Bot (if enabled)
    if (config.mmEnabled) {
      await mmBot.start();
      logger.info('🤖 MM Bot started');
    } else {
      logger.info('🤖 MM Bot disabled (set MM_ENABLED=true to enable)');
    }
  } catch (err) {
    console.error('Failed to start server:');
    console.error(err);
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

main();
