import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { logger } from './logger.js';

/**
 * M-04: Database-backed advisory locks for multi-instance concurrency safety.
 *
 * Uses PostgreSQL pg_try_advisory_lock / pg_advisory_unlock to ensure only one
 * API instance processes a given market at a time. Advisory locks are session-scoped
 * (released on connection close) and don't block — tryAdvisoryLock returns false
 * immediately if the lock is held by another session.
 *
 * Lock key space:
 *   - Namespace 1 ('resolve'): market-resolver job
 *   - Namespace 2 ('settle'):  merkle-settler job
 *
 * The lock key is derived from (namespace_int, market_uuid_hash) to fit
 * pg_try_advisory_lock(bigint) or pg_try_advisory_lock(int, int).
 */

const NAMESPACE: Record<string, number> = {
  resolve: 1,
  settle: 2,
};

/**
 * Convert a UUID string to a stable 32-bit integer hash for use as an advisory lock key.
 * Uses the first 8 hex chars of the UUID (first segment) parsed as a 32-bit int.
 */
function uuidToInt(uuid: string): number {
  const hex = uuid.replace(/-/g, '').slice(0, 8);
  return parseInt(hex, 16) | 0; // coerce to signed 32-bit int
}

/**
 * Try to acquire a PostgreSQL advisory lock.
 * Returns true if the lock was acquired, false if it's held by another session.
 */
export async function tryAdvisoryLock(namespace: string, marketId: string): Promise<boolean> {
  const ns = NAMESPACE[namespace];
  if (ns === undefined) {
    logger.warn(`[AdvisoryLock] Unknown namespace: ${namespace}`);
    return true; // fail open
  }
  const key = uuidToInt(marketId);
  try {
    const result = await db.execute(sql`SELECT pg_try_advisory_lock(${ns}, ${key}) AS acquired`);
    const acquired = (result.rows?.[0] as any)?.acquired === true;
    if (!acquired) {
      logger.debug(`[AdvisoryLock] Lock ${namespace}:${marketId.slice(0, 8)} held by another instance`);
    }
    return acquired;
  } catch (err: any) {
    logger.warn(`[AdvisoryLock] Failed to acquire lock: ${err.message}`);
    return true; // fail open — don't block processing if DB advisory lock fails
  }
}

/**
 * Release a PostgreSQL advisory lock.
 */
export async function releaseAdvisoryLock(namespace: string, marketId: string): Promise<void> {
  const ns = NAMESPACE[namespace];
  if (ns === undefined) return;
  const key = uuidToInt(marketId);
  try {
    await db.execute(sql`SELECT pg_advisory_unlock(${ns}, ${key})`);
  } catch (err: any) {
    logger.warn(`[AdvisoryLock] Failed to release lock: ${err.message}`);
  }
}
