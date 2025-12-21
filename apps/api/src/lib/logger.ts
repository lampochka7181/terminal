import pino, { Logger, LoggerOptions, DestinationStream, TransportTargetOptions } from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const isDev = process.env.NODE_ENV !== 'production';

// Get directory of current file and set logs relative to apps/api
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Logs will be in apps/api/logs by default
const LOG_DIR = process.env.LOG_DIR || path.resolve(__dirname, '../../logs');
const WRITE_LOGS_TO_FILE = process.env.WRITE_LOGS_TO_FILE !== 'false'; // Default: always write to files

// Sources to suppress from console output (still logged to files)
const CONSOLE_SUPPRESSED_SOURCES = new Set(['MM_BOT', 'KEEPER', 'API_REQUEST']);

// Log the directory on startup for debugging
console.log(`📁 Log directory: ${LOG_DIR}`);

// Ensure log directories exist
function ensureLogDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Get date string for log file paths
function getDateString(): string {
  return new Date().toISOString().split('T')[0];
}

// Get hour string for granular log files
function getHourString(): string {
  const now = new Date();
  return `${now.getHours().toString().padStart(2, '0')}`;
}

/**
 * Log Categories
 */
export type LogCategory = 'orders' | 'trades' | 'markets' | 'positions' | 'system' | 'api' | 'ws' | 'keeper';

/**
 * Market/Asset types supported
 */
export type Asset = 'BTC' | 'ETH' | 'SOL';
export type Timeframe = '5m' | '15m' | '1h' | '4h';

/**
 * Context for contextual logging
 */
export interface LogContext {
  asset?: Asset | string;
  timeframe?: Timeframe | string;
  marketId?: string;
  orderId?: string;
  tradeId?: string;
  userId?: string;
  wallet?: string;
  source?: string;  // e.g., 'MM_BOT' - used to suppress from console
  [key: string]: unknown;
}

/**
 * Base logger configuration
 */
const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/**
 * Create a file destination for a specific category/subcategory
 */
function createFileDestination(category: LogCategory, subcategory?: string): string {
  const date = getDateString();
  const baseDir = path.join(LOG_DIR, category, date);
  ensureLogDir(baseDir);
  
  const filename = subcategory ? `${subcategory}.log` : `${category}.log`;
  return path.join(baseDir, filename);
}

/**
 * Create transport configuration for development (pretty print to console)
 */
function createDevTransport(): TransportTargetOptions[] {
  return [
    {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
      level: 'debug',
    },
  ];
}

/**
 * Create transport configuration for production (files + console)
 */
function createProdTransports(category: LogCategory): TransportTargetOptions[] {
  const date = getDateString();
  const categoryDir = path.join(LOG_DIR, category, date);
  ensureLogDir(categoryDir);
  
  return [
    // Console output (errors only in prod)
    {
      target: 'pino/file',
      options: { destination: 1 }, // stdout
      level: 'warn',
    },
    // Category-specific file
    {
      target: 'pino/file',
      options: { destination: path.join(categoryDir, `${category}.log`) },
      level: 'debug',
    },
  ];
}

/**
 * Main system logger - for general application logs
 */
export const logger = pino({
  ...baseOptions,
  name: 'system',
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  }),
});

/**
 * Category-specific logger factory
 */
class CategoryLogger {
  private category: LogCategory;
  private baseLogger: Logger;
  private fileLoggers: Map<string, Logger> = new Map();
  
  constructor(category: LogCategory) {
    this.category = category;
    this.baseLogger = pino({
      ...baseOptions,
      name: category,
      ...(isDev && {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
            messageFormat: `[${category.toUpperCase()}] {msg}`,
          },
        },
      }),
    });
  }
  
  /**
   * Get or create a file logger for a specific subcategory
   */
  private getFileLogger(subcategory: string): Logger | null {
    if (isDev) return null;
    
    const key = `${getDateString()}-${subcategory}`;
    
    if (!this.fileLoggers.has(key)) {
      const filePath = createFileDestination(this.category, subcategory);
      const stream = pino.destination({ dest: filePath, sync: false });
      const fileLogger = pino({
        ...baseOptions,
        name: `${this.category}-${subcategory}`,
      }, stream);
      
      this.fileLoggers.set(key, fileLogger);
    }
    
    return this.fileLoggers.get(key) || null;
  }
  
  /**
   * Log to category file and optionally to asset/timeframe specific files
   */
  private logToFiles(level: string, msg: string, context: LogContext): void {
    if (!WRITE_LOGS_TO_FILE) return;
    
    const date = getDateString();
    const categoryDir = path.join(LOG_DIR, this.category, date);
    ensureLogDir(categoryDir);
    
    // Main category file
    const mainFilePath = path.join(categoryDir, `${this.category}.log`);
    const mainEntry = JSON.stringify({
      time: new Date().toISOString(),
      level,
      category: this.category,
      msg,
      ...context,
    }) + '\n';
    fs.appendFileSync(mainFilePath, mainEntry);
    
    // Asset-specific file
    if (context.asset) {
      const asset = context.asset.toUpperCase();
      const assetDir = path.join(categoryDir, asset);
      ensureLogDir(assetDir);
      
      const assetFilePath = path.join(assetDir, `${asset}.log`);
      fs.appendFileSync(assetFilePath, mainEntry);
      
      // Timeframe-specific file
      if (context.timeframe) {
        const tf = context.timeframe;
        const tfFilePath = path.join(assetDir, `${asset}-${tf}.log`);
        fs.appendFileSync(tfFilePath, mainEntry);
      }
    }
  }
  
  /**
   * Log with context
   */
  private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, context: LogContext = {}): void {
    const logData = { ...context };
    
    // Check if this source should be suppressed from console
    const suppressConsole = context.source && CONSOLE_SUPPRESSED_SOURCES.has(context.source);
    
    // Console log in dev (unless suppressed)
    if (!suppressConsole) {
      this.baseLogger[level](logData, msg);
    }
    
    // Always write to files
    this.logToFiles(level, msg, context);
  }
  
  debug(msg: string, context?: LogContext): void {
    this.log('debug', msg, context);
  }
  
  info(msg: string, context?: LogContext): void {
    this.log('info', msg, context);
  }
  
  warn(msg: string, context?: LogContext): void {
    this.log('warn', msg, context);
  }
  
  error(msg: string, context?: LogContext): void {
    this.log('error', msg, context);
  }
}

/**
 * Order Logger - logs order-related events
 */
export const orderLogger = new CategoryLogger('orders');

/**
 * Trade Logger - logs trade/fill events
 */
export const tradeLogger = new CategoryLogger('trades');

/**
 * Market Logger - logs market lifecycle events
 */
export const marketLogger = new CategoryLogger('markets');

/**
 * Position Logger - logs position updates
 */
export const positionLogger = new CategoryLogger('positions');

/**
 * Keeper Logger - logs keeper job events
 */
export const keeperLogger = new CategoryLogger('keeper');

/**
 * API Logger - logs API request/response events
 */
export const apiLogger = new CategoryLogger('api');

/**
 * WebSocket Logger - logs websocket events
 */
export const wsLogger = new CategoryLogger('ws');

/**
 * Fastify Request Logger - suppressed from console in dev, writes to file
 */
export const fastifyLogger = pino({
  ...baseOptions,
  name: 'api',
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  }),
}, pino.multistream([
  {
    // Write everything to category file
    stream: fs.createWriteStream(createFileDestination('api', 'requests'), { flags: 'a' }),
  },
  {
    // Console output (filtered)
    level: 'info',
    stream: {
      write: (msg: string) => {
        if (!isDev) return;
        try {
          const entry = JSON.parse(msg);
          // Suppress standard request logs from console if desired
          // Fastify request logs usually don't have a 'source' property by default
          // but we can check the message or add it via serializers
          if (entry.msg === 'request completed' || entry.msg === 'incoming request') {
            return;
          }
          process.stdout.write(msg);
        } catch {
          process.stdout.write(msg);
        }
      }
    } as any
  }
]));

/**
 * MM Bot Logger - suppressed from console, only writes to files
 * Used for high-frequency MM bot operations
 */
class MMBotLogger {
  // Use shared instances to prevent exceeding process listener limits
  private get orderLogger() { return orderLogger; }
  private get tradeLogger() { return tradeLogger; }
  
  private addMMSource(context?: LogContext): LogContext {
    return { ...context, source: 'MM_BOT' };
  }
  
  // Order-related MM logs
  orderPlaced(msg: string, context?: LogContext): void {
    this.orderLogger.info(msg, this.addMMSource(context));
  }
  
  orderCancelled(msg: string, context?: LogContext): void {
    this.orderLogger.info(msg, this.addMMSource(context));
  }
  
  // Trade-related MM logs
  fill(msg: string, context?: LogContext): void {
    this.tradeLogger.info(msg, this.addMMSource(context));
  }
  
  // General MM logs (goes to orders category)
  info(msg: string, context?: LogContext): void {
    this.orderLogger.info(msg, this.addMMSource(context));
  }
  
  debug(msg: string, context?: LogContext): void {
    this.orderLogger.debug(msg, this.addMMSource(context));
  }
  
  warn(msg: string, context?: LogContext): void {
    this.orderLogger.warn(msg, this.addMMSource(context));
  }
  
  error(msg: string, context?: LogContext): void {
    this.orderLogger.error(msg, this.addMMSource(context));
  }
}

export const mmLogger = new MMBotLogger();

/**
 * Structured log helpers for common events
 */
export const logEvents = {
  // Order events
  orderPlaced: (data: {
    orderId: string;
    userId: string;
    wallet: string;
    marketId: string;
    asset: string;
    timeframe: string;
    side: string;
    outcome: string;
    price: number;
    size: number;
    orderType?: string;
  }) => {
    orderLogger.info(
      `ORDER PLACED: ${data.side} ${data.outcome} ${data.size} @ ${data.price}`,
      {
        orderId: data.orderId,
        userId: data.userId,
        wallet: data.wallet,
        marketId: data.marketId,
        asset: data.asset,
        timeframe: data.timeframe,
        side: data.side,
        outcome: data.outcome,
        price: data.price,
        size: data.size,
        orderType: data.orderType || 'LIMIT',
        event: 'ORDER_PLACED',
      }
    );
  },
  
  orderCancelled: (data: {
    orderId: string;
    userId: string;
    marketId: string;
    asset: string;
    timeframe: string;
    reason: string;
    remainingSize?: number;
  }) => {
    orderLogger.info(
      `ORDER CANCELLED: ${data.orderId} (${data.reason})`,
      {
        orderId: data.orderId,
        userId: data.userId,
        marketId: data.marketId,
        asset: data.asset,
        timeframe: data.timeframe,
        reason: data.reason,
        remainingSize: data.remainingSize,
        event: 'ORDER_CANCELLED',
      }
    );
  },
  
  orderFilled: (data: {
    orderId: string;
    userId: string;
    marketId: string;
    asset: string;
    timeframe: string;
    filledSize: number;
    remainingSize: number;
    status: string;
  }) => {
    orderLogger.info(
      `ORDER FILLED: ${data.orderId} filled ${data.filledSize} (${data.status})`,
      {
        orderId: data.orderId,
        userId: data.userId,
        marketId: data.marketId,
        asset: data.asset,
        timeframe: data.timeframe,
        filledSize: data.filledSize,
        remainingSize: data.remainingSize,
        status: data.status,
        event: 'ORDER_FILLED',
      }
    );
  },
  
  orderExpired: (data: {
    orderId: string;
    userId: string;
    marketId: string;
    asset: string;
    timeframe: string;
  }) => {
    orderLogger.info(
      `ORDER EXPIRED: ${data.orderId}`,
      {
        orderId: data.orderId,
        userId: data.userId,
        marketId: data.marketId,
        asset: data.asset,
        timeframe: data.timeframe,
        event: 'ORDER_EXPIRED',
      }
    );
  },
  
  // Trade events
  tradeExecuted: (data: {
    tradeId: string;
    marketId: string;
    asset: string;
    timeframe: string;
    makerOrderId: string;
    takerOrderId: string;
    makerUserId: string;
    takerUserId: string;
    price: number;
    size: number;
    outcome: string;
    takerSide: string;
    notional: number;
    makerFee: number;
    takerFee: number;
  }) => {
    tradeLogger.info(
      `TRADE: ${data.takerSide} ${data.size} ${data.outcome} @ ${data.price} ($${data.notional.toFixed(2)})`,
      {
        tradeId: data.tradeId,
        marketId: data.marketId,
        asset: data.asset,
        timeframe: data.timeframe,
        makerOrderId: data.makerOrderId,
        takerOrderId: data.takerOrderId,
        makerUserId: data.makerUserId,
        takerUserId: data.takerUserId,
        price: data.price,
        size: data.size,
        outcome: data.outcome,
        takerSide: data.takerSide,
        notional: data.notional,
        makerFee: data.makerFee,
        takerFee: data.takerFee,
        event: 'TRADE_EXECUTED',
      }
    );
  },
  
  tradeSettled: (data: {
    tradeId: string;
    marketId: string;
    asset: string;
    timeframe: string;
    txSignature: string;
  }) => {
    tradeLogger.info(
      `TRADE SETTLED: ${data.tradeId} (tx: ${data.txSignature.slice(0, 16)}...)`,
      {
        tradeId: data.tradeId,
        marketId: data.marketId,
        asset: data.asset,
        timeframe: data.timeframe,
        txSignature: data.txSignature,
        event: 'TRADE_SETTLED',
      }
    );
  },
  
  // Market events
  marketCreated: (data: {
    marketId: string;
    pubkey: string;
    asset: string;
    timeframe: string;
    strikePrice: number;
    expiryAt: Date;
  }) => {
    marketLogger.info(
      `MARKET CREATED: ${data.asset}-${data.timeframe} strike=${data.strikePrice}`,
      {
        marketId: data.marketId,
        pubkey: data.pubkey,
        asset: data.asset,
        timeframe: data.timeframe,
        strikePrice: data.strikePrice,
        expiryAt: data.expiryAt.toISOString(),
        event: 'MARKET_CREATED',
      }
    );
  },
  
  marketClosed: (data: {
    marketId: string;
    asset: string;
    timeframe: string;
    openOrdersCancelled: number;
  }) => {
    marketLogger.info(
      `MARKET CLOSED: ${data.asset}-${data.timeframe} (${data.openOrdersCancelled} orders cancelled)`,
      {
        marketId: data.marketId,
        asset: data.asset,
        timeframe: data.timeframe,
        openOrdersCancelled: data.openOrdersCancelled,
        event: 'MARKET_CLOSED',
      }
    );
  },
  
  marketResolved: (data: {
    marketId: string;
    asset: string;
    timeframe: string;
    outcome: string;
    strikePrice: number;
    finalPrice: number;
  }) => {
    marketLogger.info(
      `MARKET RESOLVED: ${data.asset}-${data.timeframe} outcome=${data.outcome} (strike=${data.strikePrice}, final=${data.finalPrice})`,
      {
        marketId: data.marketId,
        asset: data.asset,
        timeframe: data.timeframe,
        outcome: data.outcome,
        strikePrice: data.strikePrice,
        finalPrice: data.finalPrice,
        event: 'MARKET_RESOLVED',
      }
    );
  },
  
  marketSettled: (data: {
    marketId: string;
    asset: string;
    timeframe: string;
    positionsSettled: number;
    totalPayout: number;
  }) => {
    marketLogger.info(
      `MARKET SETTLED: ${data.asset}-${data.timeframe} (${data.positionsSettled} positions, $${data.totalPayout.toFixed(2)} payout)`,
      {
        marketId: data.marketId,
        asset: data.asset,
        timeframe: data.timeframe,
        positionsSettled: data.positionsSettled,
        totalPayout: data.totalPayout,
        event: 'MARKET_SETTLED',
      }
    );
  },
  
  // Position events
  positionUpdated: (data: {
    positionId: string;
    userId: string;
    marketId: string;
    asset: string;
    timeframe: string;
    yesShares: number;
    noShares: number;
    totalCost: number;
  }) => {
    positionLogger.info(
      `POSITION UPDATED: ${data.asset}-${data.timeframe} YES=${data.yesShares} NO=${data.noShares}`,
      {
        positionId: data.positionId,
        userId: data.userId,
        marketId: data.marketId,
        asset: data.asset,
        timeframe: data.timeframe,
        yesShares: data.yesShares,
        noShares: data.noShares,
        totalCost: data.totalCost,
        event: 'POSITION_UPDATED',
      }
    );
  },
  
  positionSettled: (data: {
    positionId: string;
    userId: string;
    marketId: string;
    asset: string;
    timeframe: string;
    outcome: string;
    winningShares: number;
    payout: number;
    profit: number;
  }) => {
    positionLogger.info(
      `POSITION SETTLED: ${data.asset}-${data.timeframe} payout=$${data.payout.toFixed(2)} profit=$${data.profit.toFixed(2)}`,
      {
        positionId: data.positionId,
        userId: data.userId,
        marketId: data.marketId,
        asset: data.asset,
        timeframe: data.timeframe,
        outcome: data.outcome,
        winningShares: data.winningShares,
        payout: data.payout,
        profit: data.profit,
        event: 'POSITION_SETTLED',
      }
    );
  },
  
  // Keeper events (suppressed from console)
  keeperJobStarted: (jobName: string) => {
    keeperLogger.info(`JOB STARTED: ${jobName}`, { source: 'KEEPER', jobName, event: 'KEEPER_JOB_STARTED' });
  },
  
  keeperJobCompleted: (jobName: string, duration: number, result?: Record<string, unknown>) => {
    keeperLogger.info(`JOB COMPLETED: ${jobName} (${duration}ms)`, {
      source: 'KEEPER',
      jobName,
      duration,
      ...result,
      event: 'KEEPER_JOB_COMPLETED',
    });
  },
  
  keeperJobFailed: (jobName: string, error: string) => {
    keeperLogger.error(`JOB FAILED: ${jobName} - ${error}`, {
      source: 'KEEPER',
      jobName,
      error,
      event: 'KEEPER_JOB_FAILED',
    });
  },
};

/**
 * Daily log rotation helper - call this at midnight or on server restart
 */
export function rotateLogsIfNeeded(): void {
  // The date-based directory structure automatically handles rotation
  // Old logs will be in previous date folders
  logger.debug('Log rotation check - using date-based directories');
}

/**
 * Get log file paths for a category and date
 */
export function getLogPaths(category: LogCategory, date?: string): string[] {
  const targetDate = date || getDateString();
  const categoryDir = path.join(LOG_DIR, category, targetDate);
  
  if (!fs.existsSync(categoryDir)) {
    return [];
  }
  
  const files: string[] = [];
  
  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith('.log')) {
        files.push(fullPath);
      }
    }
  }
  
  walkDir(categoryDir);
  return files;
}

/**
 * Summary stats for logs
 */
export async function getLogStats(category: LogCategory, date?: string): Promise<{
  totalLines: number;
  byLevel: Record<string, number>;
  byAsset: Record<string, number>;
  byTimeframe: Record<string, number>;
}> {
  const files = getLogPaths(category, date);
  const stats = {
    totalLines: 0,
    byLevel: {} as Record<string, number>,
    byAsset: {} as Record<string, number>,
    byTimeframe: {} as Record<string, number>,
  };
  
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        stats.totalLines++;
        
        // Count by level
        if (entry.level) {
          stats.byLevel[entry.level] = (stats.byLevel[entry.level] || 0) + 1;
        }
        
        // Count by asset
        if (entry.asset) {
          stats.byAsset[entry.asset] = (stats.byAsset[entry.asset] || 0) + 1;
        }
        
        // Count by timeframe
        if (entry.timeframe) {
          stats.byTimeframe[entry.timeframe] = (stats.byTimeframe[entry.timeframe] || 0) + 1;
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  }
  
  return stats;
}
