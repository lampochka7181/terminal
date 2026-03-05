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
import { perfRoutes } from './routes/perf.js';
import { userRoutes } from './routes/user.js';
import { tradesRoutes } from './routes/trades.js';
import { marginRoutes } from './routes/margin.js';
import { wsHandler } from './routes/websocket.js';
import { metricsRoutes } from './routes/metrics.js';
import { apiLogger } from './lib/logger.js';

// Keeper Jobs
import { startKeeperJobs, stopKeeperJobs } from './jobs/index.js';

// BullMQ Queue Workers
import { startQueueWorkers, stopQueueWorkers } from './queue/index.js';

// Write-Behind Batch Queue (decouples DB writes from matching hot path)
import { writeBehindService } from './services/write-behind.service.js';

// Price Feed
import { priceFeedService } from './services/price-feed.service.js';

// Market Maker Bot V2
import { mmBotV2 } from './bot/mm-bot-v2.js';

// Anchor Client (for config endpoint)
import { anchorClient } from './lib/anchor-client.js';

// Relayer Pool (Phase 6)
import { relayerPoolService } from './services/relayer-pool.service.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Circuit Breaker for self-healing
import { circuitBreaker, circuitBreakerMiddleware } from './lib/circuit-breaker.js';

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
    let msg = 'Unknown Error';
    if (error) {
      // Handle different error formats
      if (error.stack) {
        msg = error.stack;
      } else if (error.message) {
        msg = error.message;
      } else if (typeof error === 'object') {
        // For rate limit and other structured errors
        msg = JSON.stringify(error, null, 2);
      }
    }
    logger.error(`API ${reply.statusCode} Error: ${request.method} ${request.url} (${duration.toFixed(2)}ms)\n${msg}`);
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
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
  });

  // JWT
  await app.register(jwt, {
    secret: config.jwtSecret,
    sign: {
      expiresIn: config.jwtExpiresIn,
    },
  });

  // Rate Limiting
  // 300/minute for regular users, 600/minute for agents (configurable)
  await app.register(rateLimit, {
    global: true,
    max: (request, key) => {
      if (config.perfTestMode) return 10000;
      // Agents get higher rate limits
      const user = request.user as { sub?: string; isAgent?: boolean } | undefined;
      if (user?.isAgent) return config.agent.rateLimitPerMinute;
      return 300;
    },
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      // Use user ID for authenticated requests, IP for anonymous
      // Agents get their own bucket prefix for separate tracking
      const user = request.user as { sub?: string; isAgent?: boolean } | undefined;
      if (user?.isAgent) return `agent:${user.sub}`;
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
    const mmStatus = mmBotV2.getStatus();
    const cbStatus = circuitBreaker.getStatus();

    // Determine overall status based on circuit breaker and DB health
    let status: 'ok' | 'degraded' | 'unhealthy' = 'ok';
    if (!dbHealth) {
      status = 'unhealthy';
    } else if (cbStatus.state !== 'CLOSED' || cbStatus.metrics.poolWaiting > 20) {
      status = 'degraded';
    }

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
      circuitBreaker: {
        state: cbStatus.state,
        poolWaiting: cbStatus.metrics.poolWaiting,
        poolTotal: cbStatus.metrics.poolTotal,
        poolIdle: cbStatus.metrics.poolIdle,
        trippedCount: cbStatus.metrics.trippedCount,
        recoveredCount: cbStatus.metrics.recoveredCount,
      },
      marketMaker: {
        enabled: config.mmEnabled,
        version: 'v2',
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
    agent: {
      enabled: config.agent.enabled,
      defaultFeeDiscountPct: config.agent.defaultFeeDiscountPct,
      description: 'AI agents get reduced trading fees. Authenticate via POST /auth/agent.',
    },
  }));

  // Orderbook debug endpoint (for testing)
  // SINGLE ORDERBOOK MODEL: Only YES orderbook exists, NO is derived
  app.get('/debug/orderbook/:marketId', async (request, reply) => {
    const { marketId } = request.params as { marketId: string };
    const { orderbookService } = await import('./services/orderbook.service.js');
    
    const yesSnapshot = await orderbookService.getSnapshot(marketId, 'YES');
    
    // Derive NO from YES (for debug display)
    const noBids = yesSnapshot.asks.map(l => ({ 
      price: Math.round((1 - l.price) * 100) / 100, 
      size: l.size, 
      orderCount: l.orderCount 
    })).sort((a, b) => b.price - a.price);
    const noAsks = yesSnapshot.bids.map(l => ({ 
      price: Math.round((1 - l.price) * 100) / 100, 
      size: l.size, 
      orderCount: l.orderCount 
    })).sort((a, b) => a.price - b.price);
    
    return {
      marketId,
      model: 'SINGLE_ORDERBOOK',
      YES: {
        bids: yesSnapshot.bids,
        asks: yesSnapshot.asks,
        sequenceId: yesSnapshot.sequenceId,
      },
      NO: {
        note: 'Derived from YES (complement)',
        bids: noBids,
        asks: noAsks,
        sequenceId: yesSnapshot.sequenceId,
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

  // Circuit Breaker status & control endpoint
  app.get('/debug/circuit-breaker', async () => {
    return circuitBreaker.getStatus();
  });

  // Manual circuit breaker recovery (for ops)
  app.post('/debug/circuit-breaker/recover', async () => {
    circuitBreaker.forceRecovery();
    return { success: true, status: circuitBreaker.getStatus() };
  });

  // MM Bot debug endpoint (for testing)
  app.get('/debug/mm', async () => {
    const status = mmBotV2.getStatus();
    
    // Get quote info for each market
    const marketQuotes: Record<string, any> = {};
    for (const market of status.marketDetails) {
      const quoteInfo = await mmBotV2.getQuoteInfo(market.id);
      if (quoteInfo) {
        marketQuotes[market.id] = {
          asset: market.asset,
          timeframe: market.timeframe,
          strike: market.strike,
          currentPrice: quoteInfo.currentPrice,
          fairValueYes: quoteInfo.fairValueYes,
          fairValueNo: quoteInfo.fairValueNo,
          spread: quoteInfo.spread,
          skew: quoteInfo.skew,
          quotes: quoteInfo.quotes,
          position: {
            yes: quoteInfo.yesPosition,
            no: quoteInfo.noPosition,
            imbalance: quoteInfo.imbalance,
          },
          secondsToExpiry: quoteInfo.timeToExpirySeconds,
          timeRemainingPct: quoteInfo.timeRemainingPct,
        };
      }
    }
    
    return {
      version: 'v2',
      status: {
        running: status.running,
        initialized: status.initialized,
        wallet: status.wallet,
        userId: status.userId,
        totalMarkets: status.markets,
        totalOrders: status.totalOrders,
        wsConnected: status.wsConnected,
        totalImbalance: status.totalImbalance,
      },
      config: status.config,
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
  await app.register(perfRoutes, { prefix: '/perf' });
  await app.register(userRoutes, { prefix: '/user' });
  await app.register(tradesRoutes, { prefix: '/trades' });
  await app.register(marginRoutes, { prefix: '/margin' });
  await app.register(metricsRoutes);  // Metrics at /metrics

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
    // Handle rate limit errors - @fastify/rate-limit uses statusCode 429
    // Check multiple ways since error structure can vary
    const hasRateLimitStatus = error.statusCode === 429;
    const hasRateLimitCode = (error as any)?.error?.code === 'RATE_LIMITED';
    const hasRateLimitMessage = error.message?.includes('Rate limit') || 
      error.message?.includes('Too many requests');
    
    const isRateLimitError = hasRateLimitStatus || hasRateLimitCode || hasRateLimitMessage;
    
    if (isRateLimitError) {
      // Return proper 429 with the rate limit response body
      // The errorResponseBuilder output is spread into the error object
      const rateLimitBody = (error as any).error 
        ? { error: (error as any).error }
        : {
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many requests. Please slow down.',
              details: { limit: 100, resetAt: '1 minute' }
            }
          };
      return reply.code(429).send(rateLimitBody);
    }

    // Log detailed error to apiLogger (writes to file)
    const errorMessage = error.message || error.code || 'Unknown error';
    apiLogger.error(`Request error: ${request.method} ${request.url} - ${errorMessage}`, {
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
        message: statusCode === 500 ? 'An unexpected error occurred' : errorMessage,
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
      // Stop accepting new requests
      circuitBreaker.forceTrip('shutdown');
      circuitBreaker.stopMonitoring();
      
      await mmBotV2.stop();
      priceFeedService.stop();
      stopKeeperJobs();
      await stopQueueWorkers();
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

  // Prevent crashes from unhandled promise rejections (e.g., network timeouts)
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled promise rejection: ${reason}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception (non-fatal): ${err.message}`);
    // Don't exit — keep the server running
  });

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
    
    // Start circuit breaker monitoring for self-healing
    circuitBreaker.startMonitoring(1000);
    logger.info('🔌 Circuit breaker monitoring started');
    
    // Start price feed (Coinbase WebSocket)
    priceFeedService.start();
    logger.info('📈 Price feed started (Coinbase)');
    
    // Initialize relayer pool (child wallets as fee payers)
    if (config.relayerPool.enabled) {
      try {
        const masterKeypairs: Keypair[] = [];
        if (config.relayerPrivateKey) {
          masterKeypairs.push(Keypair.fromSecretKey(bs58.decode(config.relayerPrivateKey)));
        }
        if (config.relayerPrivateKey2) {
          masterKeypairs.push(Keypair.fromSecretKey(bs58.decode(config.relayerPrivateKey2)));
        }

        if (masterKeypairs.length > 0) {
          relayerPoolService.init(anchorClient.getConnection(), masterKeypairs);
          await relayerPoolService.ensurePoolPopulated();
          const status = await relayerPoolService.getPoolStatus();
          logger.info(`🏊 Relayer pool ready: ${status.masters} master(s), ${status.active} child wallet(s)`);
        } else {
          logger.warn('⚠️  RELAYER_POOL_ENABLED but no master keypairs configured');
        }
      } catch (err: any) {
        logger.error(`❌ Relayer pool init failed (non-fatal): ${err.message}`);
      }
    }

    // Start keeper jobs (market creator, resolver, settler, etc.)
    startKeeperJobs();
    logger.info('⚙️  Keeper jobs started');

    // Start write-behind batch queue (decouples DB writes from matching)
    writeBehindService.start();
    logger.info('✍️  Write-behind queue started (50ms flush interval)');

    // Start BullMQ queue workers (on-chain submit, db-sync, ws-events)
    await startQueueWorkers();
    logger.info('📦 BullMQ queue workers started');
    
    // Start Market Maker Bot (if enabled)
    if (config.mmEnabled) {
      await mmBotV2.start();
      logger.info('🤖 MM Bot V2 started');
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
