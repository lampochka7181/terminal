/**
 * Relayer Pool Service (Phase 6)
 *
 * Manages a pool of Solana relayer wallets for parallel on-chain submissions.
 *
 * Features:
 *   - acquireRelayer(): round-robin with load awareness (fewest active jobs)
 *   - releaseRelayer(): decrements active jobs, updates stats
 *   - Circuit breaker: 5 consecutive failures → cooldown for 60s
 *   - Auto-funding keeper: monitors balances, funds from master when < 0.1 SOL
 *   - getPoolStatus(): health overview
 *
 * Pool size: 5 relayers (devnet), scale to 20 for production.
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
// Relayer private keys are stored encrypted at rest using AES-256-GCM.
// The encryption master key comes from the RELAYER_ENCRYPTION_KEY env var.
// If no encryption key is set, keys are read as plaintext (backward compat).

const ENCRYPTION_KEY = process.env.RELAYER_ENCRYPTION_KEY || '';
const ENCRYPTION_ALGO = 'aes-256-gcm';

function deriveKey(masterKey: string): Buffer {
  return crypto.createHash('sha256').update(masterKey).digest();
}

function encryptSecret(plaintext: string): string {
  if (!ENCRYPTION_KEY) return plaintext; // fallback: no encryption
  const key = deriveKey(ENCRYPTION_KEY);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptSecret(ciphertext: string): string {
  if (!ENCRYPTION_KEY) return ciphertext; // fallback: plaintext
  // Check if this looks like base64 encrypted data (encrypted strings are always longer)
  try {
    const buf = Buffer.from(ciphertext, 'base64');
    if (buf.length < 29) return ciphertext; // too short to be encrypted, treat as plaintext
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, deriveKey(ENCRYPTION_KEY), iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch {
    // If decryption fails, assume plaintext (migration scenario)
    logger.warn('[RELAYER-POOL] Failed to decrypt secret key, treating as plaintext (migration needed)');
    return ciphertext;
  }
}

// Cooldown settings
const MAX_CONSECUTIVE_FAILURES = 5;
const COOLDOWN_DURATION_MS = 60_000; // 60 seconds
const MIN_BALANCE_LAMPORTS = 0.1 * LAMPORTS_PER_SOL; // 0.1 SOL
const FUND_AMOUNT_LAMPORTS = 0.5 * LAMPORTS_PER_SOL;  // top-up to 0.5 SOL

interface RelayerWallet {
  pubkey: string;
  secretKey: string;
  balanceLamports: number;
  activeJobs: number;
  totalSubmitted: number;
  totalFailed: number;
  consecutiveFailures: number;
  status: 'active' | 'cooldown' | 'disabled';
  cooldownUntil: Date | null;
  lastUsedAt: Date | null;
}

interface AcquiredRelayer {
  pubkey: string;
  keypair: Keypair;
}

class RelayerPoolService {
  private connection: Connection | null = null;
  private masterKeypair: Keypair | null = null;

  /**
   * Initialize the pool with a Solana connection and master wallet.
   */
  init(connection: Connection, masterKeypair: Keypair): void {
    this.connection = connection;
    this.masterKeypair = masterKeypair;
    logger.info('[RELAYER-POOL] Initialized');
  }

  /**
   * Acquire a relayer with the fewest active jobs.
   * Restores wallets from cooldown if their cooldown period has elapsed.
   */
  async acquireRelayer(): Promise<AcquiredRelayer | null> {
    // First, restore any wallets whose cooldown has expired
    await db.execute(sql`
      UPDATE relayer_wallets
      SET status = 'active', consecutive_failures = 0, cooldown_until = NULL
      WHERE status = 'cooldown' AND cooldown_until < NOW()
    `);

    // Select the active relayer with fewest active jobs
    const rows = await db.execute(sql`
      SELECT pubkey, secret_key
      FROM relayer_wallets
      WHERE status = 'active'
      ORDER BY active_jobs ASC, last_used_at ASC NULLS FIRST
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    if (!rows.rows || rows.rows.length === 0) {
      logger.warn('[RELAYER-POOL] No available relayers');
      return null;
    }

    const row = rows.rows[0] as any;
    const pubkey = row.pubkey;
    const secretKey = row.secret_key;

    // Increment active_jobs atomically
    await db.execute(sql`
      UPDATE relayer_wallets
      SET active_jobs = active_jobs + 1, last_used_at = NOW()
      WHERE pubkey = ${pubkey}
    `);

    const decryptedKey = decryptSecret(secretKey);
    const keypair = Keypair.fromSecretKey(bs58.decode(decryptedKey));

    logger.debug(`[RELAYER-POOL] Acquired relayer ${pubkey.slice(0, 8)}...`);
    return { pubkey, keypair };
  }

  /**
   * Release a relayer after job completion.
   */
  async releaseRelayer(pubkey: string, success: boolean): Promise<void> {
    if (success) {
      await db.execute(sql`
        UPDATE relayer_wallets
        SET
          active_jobs = GREATEST(active_jobs - 1, 0),
          total_submitted = total_submitted + 1,
          consecutive_failures = 0
        WHERE pubkey = ${pubkey}
      `);
    } else {
      // Check if we need to trigger cooldown
      const result = await db.execute(sql`
        UPDATE relayer_wallets
        SET
          active_jobs = GREATEST(active_jobs - 1, 0),
          total_failed = total_failed + 1,
          consecutive_failures = consecutive_failures + 1
        WHERE pubkey = ${pubkey}
        RETURNING consecutive_failures
      `);

      const failures = (result.rows?.[0] as any)?.consecutive_failures || 0;

      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        const cooldownUntil = new Date(Date.now() + COOLDOWN_DURATION_MS);
        await db.execute(sql`
          UPDATE relayer_wallets
          SET status = 'cooldown', cooldown_until = ${cooldownUntil}
          WHERE pubkey = ${pubkey}
        `);
        logger.warn(`[RELAYER-POOL] Relayer ${pubkey.slice(0, 8)} entered cooldown (${failures} consecutive failures)`);
      }
    }

    logger.debug(`[RELAYER-POOL] Released relayer ${pubkey.slice(0, 8)} (success=${success})`);
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
  }> {
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE status = 'cooldown')::int AS cooldown,
        COUNT(*) FILTER (WHERE status = 'disabled')::int AS disabled,
        COALESCE(SUM(active_jobs), 0)::int AS total_active_jobs
      FROM relayer_wallets
    `);

    const row = result.rows?.[0] as any || {};
    return {
      total: row.total || 0,
      active: row.active || 0,
      cooldown: row.cooldown || 0,
      disabled: row.disabled || 0,
      totalActiveJobs: row.total_active_jobs || 0,
    };
  }

  /**
   * Auto-funding keeper: check balances and fund wallets that are low.
   * Should be called periodically (every 30s).
   */
  async autoFundKeeper(): Promise<void> {
    if (!this.connection || !this.masterKeypair) {
      return; // Not initialized
    }

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

        if (balance < MIN_BALANCE_LAMPORTS) {
          const needed = FUND_AMOUNT_LAMPORTS - balance;
          if (needed <= 0) continue;

          logger.info(`[RELAYER-POOL] Funding relayer ${pubkey.slice(0, 8)}: ${(needed / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: this.masterKeypair.publicKey,
              toPubkey: new PublicKey(pubkey),
              lamports: needed,
            }),
          );

          const sig = await sendAndConfirmTransaction(this.connection, tx, [this.masterKeypair]);
          logger.info(`[RELAYER-POOL] Funded relayer ${pubkey.slice(0, 8)}: ${sig}`);
        }
      } catch (err: any) {
        logger.error(`[RELAYER-POOL] Error funding ${pubkey.slice(0, 8)}: ${err.message}`);
      }
    }
  }
}

export const relayerPoolService = new RelayerPoolService();
