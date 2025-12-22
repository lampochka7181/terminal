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
// Optimized for Supabase's connection pooler (Supavisor)
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,                    // Increased from 10 to prevent job-contention timeouts
  min: 5,                     // Keep more connections ready for bursts
  idleTimeoutMillis: 30000,   // Release idle connections after 30s
  connectionTimeoutMillis: 30000, // Increased from 15s for extra resilience against Supabase cold-starts
  ssl: config.databaseUrl?.includes('supabase') 
    ? { rejectUnauthorized: false } 
    : undefined,
  // Keepalive settings to prevent connection drops
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Monitor pool metrics
let lastHighLoadLog = 0;
pool.on('acquire', () => {
  const total = pool.totalCount;
  const idle = pool.idleCount;
  const waiting = pool.waitingCount;
  
  // Only log if there's actual pressure (waiting clients) and not too frequently
  if (waiting > 2 && Date.now() - lastHighLoadLog > 30000) {
    lastHighLoadLog = Date.now();
    logger.warn(`Database connection pool high load: total=${total}, idle=${idle}, waiting=${waiting}`);
  }
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

