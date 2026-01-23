import { logger, keeperLogger, logEvents } from '../lib/logger.js';
import { marketCreatorJob } from './market-creator.js';
import { marketActivatorJob } from './market-activator.js';
import { marketResolverJob } from './market-resolver.js';
import { positionSettlerJob } from './position-settler.js';
import { orderExpirerJob } from './order-expirer.js';
import { marketCloserJob } from './market-closer.js';
import { liquidationCheckerJob, lendingPoolSyncJob } from './liquidation-checker.js';
import { db, pool } from '../db/index.js'; // To check pool load directly
import { config } from '../config.js';

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
  startupDelayMs?: number; // Delay before first run to prevent thundering herd at boot
}

/**
 * Job configuration with STAGGERED startup delays to prevent thundering herd.
 * 
 * Delays are spread across 60 seconds to avoid DB connection pool contention at boot.
 * Each job also adds random jitter to its interval to prevent synchronization.
 */
const jobs: JobConfig[] = [
  {
    name: 'Lending Pool Sync',
    intervalMs: 60 * 1000, // Every 60 seconds
    job: lendingPoolSyncJob,
    enabled: !!config.lendingWalletPrivateKey,
    startupDelayMs: 2000, // Run early to init lending pool state
  },
  {
    name: 'Market Activator',
    intervalMs: 5 * 1000, // Every 5 seconds (activates markets when they go live)
    job: marketActivatorJob,
    enabled: true,
    startupDelayMs: 5000, // Wait 5s after boot
  },
  {
    name: 'Market Resolver',
    intervalMs: 3 * 1000, // Every 3 seconds (slightly slower to reduce DB load)
    job: marketResolverJob,
    enabled: true,
    startupDelayMs: 12000, // Wait 12s - no markets to resolve at boot anyway
  },
  {
    name: 'Liquidation Checker',
    intervalMs: 2 * 1000, // Every 2 seconds (was 1s - 2s is still fast enough)
    job: liquidationCheckerJob,
    enabled: !!config.lendingWalletPrivateKey,
    startupDelayMs: 20000, // Wait 20s - no leveraged positions at boot anyway
  },
  {
    name: 'Position Settler',
    intervalMs: 5 * 1000, // Every 5 seconds (fast settlement for better UX)
    job: positionSettlerJob,
    enabled: true,
    startupDelayMs: 28000, // Wait 28s - no positions to settle at boot
  },
  {
    name: 'Market Creator',
    intervalMs: 30 * 1000, // Every 30 seconds (pre-creates PENDING markets in DB)
    job: marketCreatorJob,
    enabled: true,
    startupDelayMs: 35000, // Wait 35s after boot - not urgent
  },
  {
    name: 'Order Expirer',
    intervalMs: 10 * 1000, // Every 10 seconds
    job: orderExpirerJob,
    enabled: true,
    startupDelayMs: 45000, // Wait 45s - not urgent at boot
  },
  {
    name: 'Market Closer',
    intervalMs: 30 * 1000, // Every 30 seconds (was 20s - not urgent)
    job: marketCloserJob,
    enabled: true,
    startupDelayMs: 55000, // Wait 55s - definitely not urgent at boot
  },
];

/**
 * Run a job loop using setTimeout to prevent overlap.
 * Adds random jitter (0-500ms) to prevent job synchronization.
 */
async function runJobLoop(config: JobConfig): Promise<void> {
  if (!runningIntervals.has(config.name)) return;

  await runJobSafe(config);
  
  // Schedule next run only after this one completes
  // Add random jitter (0-500ms) to prevent jobs from synchronizing
  const jitter = Math.floor(Math.random() * 500);
  const timer = setTimeout(() => runJobLoop(config), config.intervalMs + jitter);
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
  
  for (const jobConfig of jobs) {
    if (!jobConfig.enabled) {
      keeperLogger.info(`Job "${jobConfig.name}" is disabled`, { source: 'KEEPER', jobName: jobConfig.name });
      continue;
    }
    
    runningIntervals.add(jobConfig.name);
    
    // Apply startup delay to stagger jobs and prevent thundering herd
    const startupDelay = jobConfig.startupDelayMs || 0;
    
    if (startupDelay > 0) {
      setTimeout(() => {
        if (runningIntervals.has(jobConfig.name)) {
          runJobLoop(jobConfig);
        }
      }, startupDelay);
      
      keeperLogger.info(`Scheduled "${jobConfig.name}" every ${jobConfig.intervalMs / 1000}s (starts in ${startupDelay / 1000}s)`, {
        source: 'KEEPER',
        jobName: jobConfig.name,
        intervalMs: jobConfig.intervalMs,
        startupDelayMs: startupDelay,
      });
    } else {
      // Start immediately
      runJobLoop(jobConfig);
      
      keeperLogger.info(`Scheduled "${jobConfig.name}" every ${jobConfig.intervalMs / 1000}s`, {
        source: 'KEEPER',
        jobName: jobConfig.name,
        intervalMs: jobConfig.intervalMs,
      });
    }
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
  //
  // Thresholds are intentionally LOW to prevent cascade failures:
  // - Default pool max is 30, so waiting > 15 means we're using 50%+ capacity
  // - Market Resolver gets higher threshold since it's critical for lifecycle
  // - Market Closer can always run since it helps recover resources
  const waitingCount = (pool as any).waitingCount || 0;

  // Skip thresholds - scaled to be conservative
  // Critical jobs (Market Resolver): skip at 25 waiting
  // Normal jobs: skip at 15 waiting
  // This prevents jobs from piling up when DB is already under pressure
  let skipThreshold: number;
  switch (config.name) {
    case 'Market Resolver':
      skipThreshold = 25; // Critical - needs higher threshold
      break;
    case 'Market Closer':
      skipThreshold = Infinity; // Never skip - helps recover resources
      break;
    case 'Lending Pool Sync':
      skipThreshold = 20; // Less critical, can wait
      break;
    default:
      skipThreshold = 15; // Conservative default
  }

  if (waitingCount > skipThreshold) {
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


