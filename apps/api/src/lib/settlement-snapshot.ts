/**
 * Settlement Snapshot — on-chain holder enumeration for merkle settlement.
 *
 * Replaces the DB-positions input to the merkle tree builder. The source of
 * truth for "who owns what at settlement time" is the on-chain token mint and
 * its holder ATAs, not the DB positions table. DB drifts from chain under
 * load; chain is authoritative.
 *
 * Primary method: Helius DAS `getTokenAccounts` — paginated, optimized for
 * listing all holders of a mint. Fast and has its own rate-limit bucket.
 *
 * Fallback: standard `getProgramAccounts` with a mint memcmp filter on the
 * Token-2022 program. Works on any RPC, slower, subject to the general
 * per-method rate limit.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../config.js';
import { logger } from './logger.js';

export interface MintHolder {
  /** Wallet that owns the token account (NOT the ATA pubkey). */
  owner: PublicKey;
  /** Balance in the mint's smallest unit (matches Token.amount field). */
  amount: bigint;
}

/** Max holders per DAS page. Helius caps at 1000 per request. */
const DAS_PAGE_LIMIT = 1000;

/** Max pages we'll fetch before giving up. 1000 × 100 = 100k holders. */
const DAS_MAX_PAGES = 100;

/**
 * Fetch all non-zero holders of a given mint. Aggregates by owner (a single
 * wallet may have multiple token accounts for the same mint in pathological
 * cases, though ATAs are deterministic per owner+mint).
 *
 * Returns holders in deterministic order: sorted by owner pubkey ascending.
 * Merkle tree construction is order-sensitive (leaf positions affect the
 * root), so any caller building a tree MUST use this order.
 */
export async function fetchMintHolders(
  connection: Connection,
  mint: PublicKey,
): Promise<MintHolder[]> {
  // Detect Helius endpoint from the connection's RPC URL. Both
  // `helius-rpc.com` (mainnet/devnet) and `helius.xyz` (legacy) get routed to
  // the DAS path. Anything else falls back to getProgramAccounts.
  const rpcUrl = (connection as any)._rpcEndpoint || config.solanaRpcUrl;
  const isHelius = typeof rpcUrl === 'string' &&
    (rpcUrl.includes('helius-rpc.com') || rpcUrl.includes('helius.xyz'));

  if (isHelius) {
    try {
      return await fetchViaDas(rpcUrl, mint);
    } catch (err: any) {
      logger.warn(`[SettlementSnapshot] DAS failed for ${mint.toBase58().slice(0, 8)}, falling back to getProgramAccounts: ${err.message}`);
      // Fall through to the gPA path
    }
  }

  return fetchViaProgramAccounts(connection, mint);
}

// ─────────────────────────────────────────────────────────────────────────
// Helius DAS path
// ─────────────────────────────────────────────────────────────────────────

interface DasTokenAccount {
  address: string;
  mint: string;
  owner: string;
  amount: string | number;
}

interface DasResponse {
  jsonrpc: string;
  id: string;
  result?: {
    total: number;
    limit: number;
    page: number;
    token_accounts: DasTokenAccount[];
  };
  error?: { code: number; message: string };
}

async function fetchViaDas(rpcUrl: string, mint: PublicKey): Promise<MintHolder[]> {
  const mintStr = mint.toBase58();
  const aggregates = new Map<string, bigint>();
  let totalPages = 0;

  for (let page = 1; page <= DAS_MAX_PAGES; page++) {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `settlement-snapshot-${mintStr.slice(0, 6)}-${page}`,
        method: 'getTokenAccounts',
        params: { mint: mintStr, limit: DAS_PAGE_LIMIT, page },
      }),
    });

    if (!resp.ok) {
      throw new Error(`DAS HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }

    const body = (await resp.json()) as DasResponse;
    if (body.error) {
      throw new Error(`DAS error ${body.error.code}: ${body.error.message}`);
    }

    const result = body.result;
    if (!result || !Array.isArray(result.token_accounts)) {
      throw new Error('DAS response missing result.token_accounts');
    }

    for (const acct of result.token_accounts) {
      if (!acct.owner || acct.amount === undefined || acct.amount === null) continue;
      const amount = typeof acct.amount === 'string' ? BigInt(acct.amount) : BigInt(acct.amount);
      if (amount === 0n) continue;
      const prev = aggregates.get(acct.owner) ?? 0n;
      aggregates.set(acct.owner, prev + amount);
    }

    totalPages = page;
    // Pagination termination: if this page came back under-filled, or we've
    // already consumed all `total` entries, we're done.
    if (result.token_accounts.length < DAS_PAGE_LIMIT) break;
    if (result.total && page * DAS_PAGE_LIMIT >= result.total) break;
  }

  logger.debug(`[SettlementSnapshot] DAS: ${aggregates.size} holders of ${mintStr.slice(0, 8)} across ${totalPages} page(s)`);
  return toSortedHolders(aggregates);
}

// ─────────────────────────────────────────────────────────────────────────
// getProgramAccounts fallback path
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse a Token-2022 token account's first 72 bytes to extract (owner, amount).
 * Layout: mint(32) | owner(32) | amount(u64 LE) | ...extensions
 * Valid for both base Token accounts and Token-2022 accounts with extensions —
 * extensions are appended AFTER the base 165-byte region, so the first 72
 * bytes always contain mint/owner/amount.
 */
function parseTokenAccount(data: Buffer): { owner: PublicKey; amount: bigint } | null {
  if (data.length < 72) return null;
  const owner = new PublicKey(data.subarray(32, 64));
  const amount = data.readBigUInt64LE(64);
  return { owner, amount };
}

async function fetchViaProgramAccounts(
  connection: Connection,
  mint: PublicKey,
): Promise<MintHolder[]> {
  // Filter by mint (offset 0, 32 bytes). Don't filter on dataSize — Token-2022
  // accounts can have variable size due to extensions, and our share mints
  // use MintCloseAuthority + PermanentDelegate which push holder accounts
  // above the base 165-byte footprint.
  const accounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });

  const aggregates = new Map<string, bigint>();
  for (const { account } of accounts) {
    const parsed = parseTokenAccount(account.data as Buffer);
    if (!parsed) continue;
    if (parsed.amount === 0n) continue;
    const key = parsed.owner.toBase58();
    const prev = aggregates.get(key) ?? 0n;
    aggregates.set(key, prev + parsed.amount);
  }

  logger.debug(`[SettlementSnapshot] gPA: ${aggregates.size} holders of ${mint.toBase58().slice(0, 8)}`);
  return toSortedHolders(aggregates);
}

function toSortedHolders(aggregates: Map<string, bigint>): MintHolder[] {
  const ownerKeys = [...aggregates.keys()].sort();
  return ownerKeys.map((k) => ({ owner: new PublicKey(k), amount: aggregates.get(k)! }));
}
