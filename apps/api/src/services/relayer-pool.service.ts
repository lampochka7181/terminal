/**
 * Relayer Pool Service (Phase 6)
 *
 * Fault-tolerant pool of child wallets that pay Solana TX fees,
 * while the master wallet(s) remain the relayer authority for delegation.
 *
 * Architecture:
 *   - Master 1 (RELAYER_PRIVATE_KEY):   relayer authority + funding source
 *   - Master 2 (RELAYER_PRIVATE_KEY_2): backup funding source + fallback fee payer
 *   - Child wallets (DB-stored):        primary fee payers (round-robin)
 *
 * Features:
 *   - Auto-generates child wallets on first boot
 *   - acquireFeePayer(): round-robin with balance awareness + fallback chain
 *   - releaseFeePayer(): updates stats, circuit breaker on consecutive failures
 *   - Auto-funding keeper: monitors balances, funds from master1 then master2
 *   - getPoolStatus(): health overview
 *
 * Fallback chain: child1 → child2 → ... → childN → master1 → master2
 */

import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import bs58 from 'bs58';
import { sql } from 'drizzle-orm';
import crypto from 'crypto';

// ============================================================================
// KEY ENCRYPTION HELPERS
// ============================================================================

const ENCRYPTION_KEY = process.env.RELAYER_ENCRYPTION_KEY || '';
const ENCRYPTION_ALGO = 'aes-256-gcm';

function deriveKey(masterKey: string): Buffer {
  return crypto.createHash('sha256').update(masterKey).digest();
}

function encryptSecret(plaintext: string): string {
  if (!ENCRYPTION_KEY) return plaintext;
  const key = deriveKey(ENCRYPTION_KEY);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptSecret(ciphertext: string): string {
  if (!ENCRYPTION_KEY) return ciphertext;
  try {
    const buf = Buffer.from(ciphertext, 'base64');
    if (buf.length < 29) return ciphertext;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, deriveKey(ENCRYPTION_KEY), iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch {
    logger.warn('[RELAYER-POOL] Failed to decrypt secret key, treating as plaintext');
    return ciphertext;
  }
}

// ============================================================================
// TYPES
// ============================================================================

export interface AcquiredFeePayer {
  pubkey: string;
  keypair: Keypair;
  isMaster: boolean;
}

// ============================================================================
// SERVICE
// ============================================================================

class RelayerPoolService {
  private connection: Connection | null = null;
  private masterKeypairs: Keypair[] = [];
  private initialized = false;

  /**
   * Initialize the pool with a Solana connection and master wallet(s).
   */
  init(connection: Connection, masterKeypairs: Keypair[]): void {
    this.connection = connection;
    this.masterKeypairs = masterKeypairs;
    this.initialized = true;
    const pubkeys = masterKeypairs.map((kp, i) => `master${i + 1}=${kp.publicKey.toBase58().slice(0, 8)}...`);
    logger.info(`[RELAYER-POOL] Initialized with ${masterKeypairs.length} master(s): ${pubkeys.join(', ')}`);
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Ensure the pool has the configured number of child wallets.
   * Generates missing wallets and funds them from master.
   */
  async ensurePoolPopulated(): Promise<void> {
    if (!this.connection || this.masterKeypairs.length === 0) return;

    const poolSize = config.relayerPool.size;

    // If pool size is 0, skip child wallet generation entirely (use masters only)
    if (poolSize <= 0) {
      logger.info('[RELAYER-POOL] Pool size is 0 — using master wallets only');
      return;
    }

    const existing = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM relayer_wallets
    `);
    const count = (existing.rows?.[0] as any)?.cnt || 0;

    if (count >= poolSize) {
      logger.info(`[RELAYER-POOL] Pool already has ${count} child wallet(s)`);
      return;
    }

    const toGenerate = poolSize - count;
    logger.info(`[RELAYER-POOL] Generating ${toGenerate} child wallet(s)...`);

    for (let i = 0; i < toGenerate; i++) {
      const keypair = Keypair.generate();
      const pubkey = keypair.publicKey.toBase58();
      const secretKey = encryptSecret(bs58.encode(keypair.secretKey));

      await db.execute(sql`
        INSERT INTO relayer_wallets (pubkey, secret_key, status, balance_lamports, active_jobs, total_submitted, total_failed, consecutive_failures)
        VALUES (${pubkey}, ${secretKey}, 'active', 0, 0, 0, 0, 0)
        ON CONFLICT (pubkey) DO NOTHING
      `);

      logger.info(`[RELAYER-POOL] Generated child wallet [${count + i + 1}]: ${pubkey.slice(0, 12)}...`);
    }

    // Fund the newly generated wallets
    logger.info('[RELAYER-POOL] Funding new child wallets...');
    await this.autoFundKeeper();
  }

  /**
   * Acquire a fee payer with fallback chain:
   *   child wallets (round-robin) → master1 → master2
   *
   * Child selection: active status, not in cooldown, lowest active_jobs.
   * Balance check: skip children with balance below threshold.
   */
  async acquireFeePayer(): Promise<AcquiredFeePayer | null> {
    if (!this.initialized) return null;

    // Restore wallets from cooldown
    await db.execute(sql`
      UPDATE relayer_wallets
      SET status = 'active', consecutive_failures = 0, cooldown_until = NULL
      WHERE status = 'cooldown' AND cooldown_until < NOW()
    `).catch(() => {});

    const minLamports = Math.floor(config.relayerPool.minBalanceSol * LAMPORTS_PER_SOL);

    // Try child wallets first — round-robin with balance awareness
    const rows = await db.execute(sql`
      SELECT pubkey, secret_key
      FROM relayer_wallets
      WHERE status = 'active' AND balance_lamports >= ${minLamports}
      ORDER BY active_jobs ASC, last_used_at ASC NULLS FIRST
      LIMIT 1
    `).catch(() => ({ rows: [] }));

    if (rows.rows && rows.rows.length > 0) {
      const row = rows.rows[0] as any;
      const pubkey = row.pubkey;

      await db.execute(sql`
        UPDATE relayer_wallets
        SET active_jobs = active_jobs + 1, last_used_at = NOW()
        WHERE pubkey = ${pubkey}
      `).catch(() => {});

      const decryptedKey = decryptSecret(row.secret_key);
      const keypair = Keypair.fromSecretKey(bs58.decode(decryptedKey));

      logger.debug(`[RELAYER-POOL] Acquired child fee payer: ${pubkey.slice(0, 8)}...`);
      return { pubkey, keypair, isMaster: false };
    }

    // Fallback: try master wallets
    for (let i = 0; i < this.masterKeypairs.length; i++) {
      const master = this.masterKeypairs[i];
      try {
        if (this.connection) {
          const balance = await this.connection.getBalance(master.publicKey);
          if (balance < minLamports) {
            logger.warn(`[RELAYER-POOL] Master ${i + 1} balance too low (${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL), trying next`);
            continue;
          }
        }
        logger.info(`[RELAYER-POOL] Using master ${i + 1} as fee payer (all children unavailable)`);
        return { pubkey: master.publicKey.toBase58(), keypair: master, isMaster: true };
      } catch (err: any) {
        logger.warn(`[RELAYER-POOL] Master ${i + 1} balance check failed: ${err.message}`);
        continue;
      }
    }

    logger.error('[RELAYER-POOL] No fee payers available (all children + masters exhausted)');
    return null;
  }

  /**
   * Release a fee payer after job completion.
   * Skips DB updates for master wallets.
   */
  async releaseFeePayer(pubkey: string, success: boolean, isMaster?: boolean): Promise<void> {
    if (isMaster) return;

    if (success) {
      await db.execute(sql`
        UPDATE relayer_wallets
        SET
          active_jobs = GREATEST(active_jobs - 1, 0),
          total_submitted = total_submitted + 1,
          consecutive_failures = 0
        WHERE pubkey = ${pubkey}
      `).catch(() => {});
    } else {
      const result = await db.execute(sql`
        UPDATE relayer_wallets
        SET
          active_jobs = GREATEST(active_jobs - 1, 0),
          total_failed = total_failed + 1,
          consecutive_failures = consecutive_failures + 1
        WHERE pubkey = ${pubkey}
        RETURNING consecutive_failures
      `).catch(() => ({ rows: [] }));

      const failures = (result.rows?.[0] as any)?.consecutive_failures || 0;

      if (failures >= config.relayerPool.maxConsecutiveFailures) {
        const cooldownUntil = new Date(Date.now() + config.relayerPool.cooldownDurationMs);
        await db.execute(sql`
          UPDATE relayer_wallets
          SET status = 'cooldown', cooldown_until = ${cooldownUntil}
          WHERE pubkey = ${pubkey}
        `).catch(() => {});
        logger.warn(`[RELAYER-POOL] Child ${pubkey.slice(0, 8)} entered cooldown (${failures} consecutive failures)`);
      }
    }

    logger.debug(`[RELAYER-POOL] Released fee payer ${pubkey.slice(0, 8)} (success=${success})`);
  }

  // Legacy compatibility — maps to acquireFeePayer/releaseFeePayer
  async acquireRelayer(): Promise<AcquiredFeePayer | null> {
    return this.acquireFeePayer();
  }
  async releaseRelayer(pubkey: string, success: boolean): Promise<void> {
    return this.releaseFeePayer(pubkey, success);
  }

  /**
   * Get pool health status.
   */
  async getPoolStatus(): Promise<{
    total: number;
    active: number;
    cooldown: number;
    disabled: number;
    totalActiveJobs: number;
    masters: number;
  }> {
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE status = 'cooldown')::int AS cooldown,
        COUNT(*) FILTER (WHERE status = 'disabled')::int AS disabled,
        COALESCE(SUM(active_jobs), 0)::int AS total_active_jobs
      FROM relayer_wallets
    `).catch(() => ({ rows: [{}] }));

    const row = result.rows?.[0] as any || {};
    return {
      total: row.total || 0,
      active: row.active || 0,
      cooldown: row.cooldown || 0,
      disabled: row.disabled || 0,
      totalActiveJobs: row.total_active_jobs || 0,
      masters: this.masterKeypairs.length,
    };
  }

  /**
   * Auto-funding keeper: check child wallet balances and top up from masters.
   * Tries master1 first; if master1 is low, tries master2.
   * Called periodically (every 30s) by the keeper job.
   */
  async autoFundKeeper(): Promise<void> {
    if (!this.connection || this.masterKeypairs.length === 0) return;

    const minBalance = Math.floor(config.relayerPool.minBalanceSol * LAMPORTS_PER_SOL);
    const fundAmount = Math.floor(config.relayerPool.fundAmountSol * LAMPORTS_PER_SOL);

    const rows = await db.execute(sql`
      SELECT pubkey FROM relayer_wallets WHERE status != 'disabled'
    `);

    if (!rows.rows || rows.rows.length === 0) return;

    for (const row of rows.rows) {
      const pubkey = (row as any).pubkey;
      try {
        const balance = await this.connection.getBalance(new PublicKey(pubkey));

        // Update stored balance
        await db.execute(sql`
          UPDATE relayer_wallets SET balance_lamports = ${balance} WHERE pubkey = ${pubkey}
        `);

        if (balance >= minBalance) continue;

        const needed = fundAmount - balance;
        if (needed <= 0) continue;

        // Try each master wallet for funding
        let funded = false;
        for (let i = 0; i < this.masterKeypairs.length; i++) {
          const master = this.masterKeypairs[i];
          try {
            const masterBalance = await this.connection.getBalance(master.publicKey);
            // Need enough for the transfer + some buffer for the TX fee
            if (masterBalance < needed + 10_000) {
              logger.warn(`[RELAYER-POOL] Master ${i + 1} too low to fund ${pubkey.slice(0, 8)} (${(masterBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
              continue;
            }

            logger.info(`[RELAYER-POOL] Funding child ${pubkey.slice(0, 8)} with ${(needed / LAMPORTS_PER_SOL).toFixed(4)} SOL from master ${i + 1}`);

            const tx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: master.publicKey,
                toPubkey: new PublicKey(pubkey),
                lamports: needed,
              }),
            );

            const sig = await sendAndConfirmTransaction(this.connection, tx, [master]);
            logger.info(`[RELAYER-POOL] Funded child ${pubkey.slice(0, 8)}: ${sig}`);

            // Update balance after funding
            const newBalance = await this.connection.getBalance(new PublicKey(pubkey));
            await db.execute(sql`
              UPDATE relayer_wallets SET balance_lamports = ${newBalance} WHERE pubkey = ${pubkey}
            `);

            funded = true;
            break;
          } catch (err: any) {
            logger.error(`[RELAYER-POOL] Master ${i + 1} failed to fund ${pubkey.slice(0, 8)}: ${err.message}`);
            continue;
          }
        }

        if (!funded) {
          logger.error(`[RELAYER-POOL] Could not fund child ${pubkey.slice(0, 8)} — all masters exhausted`);
        }
      } catch (err: any) {
        logger.error(`[RELAYER-POOL] Error checking ${pubkey.slice(0, 8)}: ${err.message}`);
      }
    }
  }
}

export const relayerPoolService = new RelayerPoolService();
