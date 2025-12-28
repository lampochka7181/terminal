import { logger, keeperLogger, logEvents } from '../lib/logger.js';
import { marketCreatorJob } from './market-creator.js';
import { marketActivatorJob } from './market-activator.js';
import { marketResolverJob } from './market-resolver.js';
import { positionSettlerJob } from './position-settler.js';
import { orderExpirerJob } from './order-expirer.js';
import { marketCloserJob } from './market-closer.js';
import { db, pool } from '../db/index.js'; // To check pool load directly

/**
 * Keeper Jobs Manager
 * 
 * Schedules and manages all background jobs:
 * - Market Creator: Pre-creates markets with PENDING status (DB only, no on-chain)
 * - Market Activator: Activates PENDING markets when they go live (sets strike price, creates on-chain)
 * - Market Resolver: Resolves expired markets using oracle prices
 * - Position Settler: Pays out winners after market resolution
 * - Order Expirer: Cancels orders before market close and expired GTT orders
 * - Market Closer: Closes settled markets to recover rent (~$1.20/market)
 */

interface JobConfig {
  name: string;
  intervalMs: number;
  job: () => Promise<void>;
  enabled: boolean;
}

const jobs: JobConfig[] = [
  {
    name: 'Market Creator',
    intervalMs: 30 * 1000, // Every 30 seconds (pre-creates PENDING markets in DB)
    job: marketCreatorJob,
    enabled: true,
  },
  {
    name: 'Market Activator',
    intervalMs: 5 * 1000, // Every 5 seconds (activates markets when they go live)
    job: marketActivatorJob,
    enabled: true,
  },
  {
    name: 'Market Resolver',
    intervalMs: 5 * 1000, // Every 5 seconds (fast resolution for better UX)
    job: marketResolverJob,
    enabled: true,
  },
  {
    name: 'Position Settler',
    intervalMs: 5 * 1000, // Every 5 seconds (fast settlement for better UX)
    job: positionSettlerJob,
    enabled: true,
  },
  {
    name: 'Order Expirer',
    intervalMs: 10 * 1000, // Every 10 seconds
    job: orderExpirerJob,
    enabled: true,
  },
  {
    name: 'Market Closer',
    intervalMs: 20 * 1000, // Every 20 seconds (recover rent faster)
    job: marketCloserJob,
    enabled: true,
  },
];

/**
 * Run a job loop using setTimeout to prevent overlap
 */
async function runJobLoop(config: JobConfig): Promise<void> {
  if (!runningIntervals.has(config.name)) return;

  await runJobSafe(config);
  
  // Schedule next run only after this one completes
  const timer = setTimeout(() => runJobLoop(config), config.intervalMs);
  runningTimers.set(config.name, timer);
}

const runningTimers = new Map<string, NodeJS.Timeout>();
const runningJobs = new Set<string>();

function isTransientDbError(err: unknown): boolean {
  const msg = (err as any)?.message ? String((err as any).message) : String(err);
  return (
    msg.includes('Connection terminated') ||
    msg.includes('connection terminated unexpectedly') ||
    msg.includes('server closed the connection unexpectedly') ||
    msg.includes('ECONNRESET') ||
    msg.includes('Connection terminated due to connection timeout') ||
    msg.includes('timeout') // conservative; job-level retry is bounded
  );
}

/**
 * Start all keeper jobs
 */
export function startKeeperJobs(): void {
  keeperLogger.info('Starting keeper jobs...', { source: 'KEEPER' });
  
  for (const config of jobs) {
    if (!config.enabled) {
      keeperLogger.info(`Job "${config.name}" is disabled`, { source: 'KEEPER', jobName: config.name });
      continue;
    }
    
    runningIntervals.add(config.name);
    
    // Start the recursive loop
    runJobLoop(config);
    
    keeperLogger.info(`Scheduled "${config.name}" every ${config.intervalMs / 1000}s`, {
      source: 'KEEPER',
      jobName: config.name,
      intervalMs: config.intervalMs,
    });
  }
}

/**
 * Stop all keeper jobs
 */
export function stopKeeperJobs(): void {
  keeperLogger.info('Stopping keeper jobs...', { source: 'KEEPER' });
  
  for (const timer of runningTimers.values()) {
    clearTimeout(timer);
  }
  
  runningTimers.clear();
  runningIntervals.clear();
  keeperLogger.info('All keeper jobs stopped', { source: 'KEEPER' });
}

// Track names of running jobs
const runningIntervals = new Set<string>();

/**
 * Run a job with error handling and timing
 */
async function runJobSafe(config: JobConfig): Promise<void> {
  // HIGH LOAD SHIELD: If the DB is already struggling, don't add more pressure.
  // This helps prioritize existing queries and prevents the pool from freezing.
  const waitingCount = (pool as any).waitingCount || 0;
  
  if (waitingCount > 5 && config.name !== 'Market Closer') {
    keeperLogger.warn(`[KEEPER] Skipping "${config.name}" - DB load high (waiting=${waitingCount})`);
    return;
  }

  const startTime = Date.now();
  logEvents.keeperJobStarted(config.name);
  
  try {
    // Retry transient DB failures (Supavisor/network blips) a couple times.
    // IMPORTANT: keep this bounded so we don't create overlapping backlog.
    const maxAttempts = 3;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      try {
        await config.job();
        break;
      } catch (e) {
        if (attempt >= maxAttempts || !isTransientDbError(e)) {
          throw e;
        }

        const waitingCount = (pool as any).waitingCount || 0;
        const total = (pool as any).totalCount ?? 'n/a';
        const idle = (pool as any).idleCount ?? 'n/a';
        keeperLogger.warn(
          `[KEEPER] "${config.name}" transient DB error (attempt ${attempt}/${maxAttempts}); retrying soon... pool(total=${total}, idle=${idle}, waiting=${waitingCount})`
        );

        // small exponential backoff with jitter
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 5000) + Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    const duration = Date.now() - startTime;
    logEvents.keeperJobCompleted(config.name, duration);
  } catch (err) {
    const duration = Date.now() - startTime;
    const error = err as Error;
    logEvents.keeperJobFailed(config.name, error.message);
    
    // Detailed error logging for debugging
    if (process.env.NODE_ENV !== 'production') {
      logger.error({ err: error, jobName: config.name, duration }, `Job "${config.name}" failed: ${error.message}`);
    } else {
      logger.error(`Job "${config.name}" failed after ${duration}ms: ${error.message}`);
    }
    // TODO: Send alert (Discord, PagerDuty, etc.)
  }
}


