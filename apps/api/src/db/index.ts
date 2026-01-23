import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import * as schema from './schema.js';

// Debug: Check database URL
if (!config.databaseUrl) {
  console.error('❌ DATABASE_URL is not set!');
} else {
  const isTransactionMode = config.databaseUrl.includes(':6543/');
  console.log(`🔌 Connecting to database (${isTransactionMode ? 'Transaction Mode' : 'Session Mode'})...`);
}

// Create PostgreSQL connection pool
// Optimized for Supabase's connection pooler (Supavisor) in transaction mode
// Supabase Pro plan supports 60 direct + 200+ pooled connections
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPool.max,
  min: config.dbPool.min,
  idleTimeoutMillis: config.dbPool.idleTimeoutMillis,
  connectionTimeoutMillis: config.dbPool.connectionTimeoutMillis,
  statement_timeout: 15000,   // Kill queries running > 15s (was 30s)
  ssl: config.databaseUrl?.includes('supabase') 
    ? { rejectUnauthorized: false } 
    : undefined,
  keepAlive: true,
});

// Monitor pool metrics
let lastHighLoadLog = 0;
let lastPoolStatusLog = 0;

// Log pool status periodically for debugging
const logPoolStatus = () => {
  const now = Date.now();
  const total = pool.totalCount;
  const idle = pool.idleCount;
  const waiting = pool.waitingCount;
  
  // Log every 5 seconds if there's any waiting, or every 30s otherwise
  const interval = waiting > 0 ? 5000 : 30000;
  if (now - lastPoolStatusLog > interval) {
    lastPoolStatusLog = now;
    logger.debug(`[DB Pool] total=${total}, idle=${idle}, waiting=${waiting}`);
  }
  
  // Warn if high load
  if (waiting > 30 && now - lastHighLoadLog > 60000) {
    lastHighLoadLog = now;
    logger.warn(`Database connection pool high load: total=${total}, idle=${idle}, waiting=${waiting}`);
  }
};

pool.on('acquire', logPoolStatus);
pool.on('connect', () => {
  logger.debug(`[DB Pool] New connection created (total=${pool.totalCount})`);
});
pool.on('remove', () => {
  logger.debug(`[DB Pool] Connection removed (total=${pool.totalCount})`);
});

// Handle pool errors (these are connection-level errors, not query errors)
// Supabase pooler frequently terminates idle connections - this is normal
pool.on('error', (err) => {
  const msg = err.message || '';
  // Ignore common pooler disconnection errors (expected behavior)
  const isPoolerDisconnect = 
    msg.includes('Connection terminated') ||
    msg.includes('ECONNRESET') ||
    msg.includes('connection terminated unexpectedly') ||
    msg.includes('terminating connection due to administrator command') ||
    msg.includes('server closed the connection unexpectedly');
  
  if (!isPoolerDisconnect) {
    logger.error({ err: msg }, 'Database pool error');
  }
});

// Create Drizzle ORM instance
export const db = drizzle(pool, { schema });

// Export schema for use elsewhere
export * from './schema.js';

// Health check function
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    console.log('🔍 Testing database connection...');
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('✅ Database connection successful!');
    return true;
  } catch (err) {
    console.error('❌ Database connection error:', (err as Error).message);
    logger.error('Database health check failed:', err);
    return false;
  }
}

// Graceful shutdown
export async function closeDatabaseConnection(): Promise<void> {
  await pool.end();
  logger.info('Database connection pool closed');
}

