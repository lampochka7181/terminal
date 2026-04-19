/**
 * Drift Reconciler — surfaces divergence between DB positions and on-chain
 * mint / vault state.
 *
 * Intent: observational, not corrective. The settlement path is already
 * robust to DB drift (it settles from on-chain truth). But users see DB
 * positions in the UI, so a persistent divergence still matters. This job
 * logs structured diagnostics so we can hunt the upstream position-tracking
 * bug with real data.
 *
 * For each active market, compares:
 *   - on-chain `market.open_interest` (authoritative USDC in vault)
 *   - on-chain YES mint supply
 *   - on-chain NO mint supply
 *   - DB sum(yes_shares) across positions
 *   - DB sum(no_shares) across positions
 *
 * In a correct system, all five numbers are equal. Any mismatch is a bug.
 */

import { sql } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import { db } from '../db/index.js';
import { anchorClient, getYesMintPda, getNoMintPda, fetchMarketV2OnChainState } from '../lib/anchor-client.js';
import { logger } from '../lib/logger.js';

const MARKETS_PER_CYCLE = 25;

/**
 * Fetch the raw mint supply via standard RPC. Returns bigint of the smallest
 * unit (i.e. matches Token.amount). Uses `getTokenSupply` which hits a single
 * method and avoids the fan-out cost of fetching every holder account.
 */
async function fetchMintSupply(mintPubkey: PublicKey): Promise<bigint | null> {
  try {
    const resp = await anchorClient.getConnection().getTokenSupply(mintPubkey);
    return BigInt(resp.value.amount);
  } catch (err: any) {
    logger.debug(`[DriftReconciler] getTokenSupply failed for ${mintPubkey.toBase58().slice(0, 8)}: ${err.message}`);
    return null;
  }
}

interface DriftRow {
  marketId: string;
  pubkey: string;
  asset: string;
  timeframe: string;
  status: string;
  yes_shares_sum: string;
  no_shares_sum: string;
}

export async function driftReconcilerJob(): Promise<void> {
  if (!anchorClient.isReady()) return;

  // Pull active markets with pre-aggregated position sums. Status filter
  // excludes SETTLED (nothing to reconcile) and SETTLEMENT_FAILED (operator
  // is already aware).
  const rows = await db.execute(sql`
    SELECT
      m.id::text                     AS "marketId",
      m.pubkey                       AS "pubkey",
      m.asset                        AS "asset",
      m.timeframe                    AS "timeframe",
      m.status                       AS "status",
      COALESCE(SUM(p.yes_shares::numeric), 0)::text AS "yes_shares_sum",
      COALESCE(SUM(p.no_shares::numeric),  0)::text AS "no_shares_sum"
    FROM markets m
    LEFT JOIN positions p
      ON p.market_id = m.id AND p.status = 'OPEN'
    WHERE m.status IN ('OPEN', 'CLOSED', 'RESOLVED')
    GROUP BY m.id, m.pubkey, m.asset, m.timeframe, m.status
    ORDER BY m.created_at DESC
    LIMIT ${MARKETS_PER_CYCLE}
  `);

  const markets = (rows.rows || []) as unknown as DriftRow[];
  if (markets.length === 0) return;

  let driftCount = 0;

  for (const m of markets) {
    try {
      const marketPk = new PublicKey(m.pubkey);
      const [chain, yesSupplyRaw, noSupplyRaw] = await Promise.all([
        fetchMarketV2OnChainState(anchorClient.getConnection(), marketPk),
        fetchMintSupply(getYesMintPda(marketPk)),
        fetchMintSupply(getNoMintPda(marketPk)),
      ]);

      // Market account missing → already finalized or never existed on-chain. Skip.
      if (!chain) continue;

      const openInterest = chain.openInterest;
      const yesSupply = yesSupplyRaw ?? 0n;
      const noSupply = noSupplyRaw ?? 0n;
      // Decimal share strings are in human USDC (6-decimal) units. Convert to
      // integer micro-units for apples-to-apples comparison with mint supplies.
      const yesDbMicro = decimalUsdcToMicro(m.yes_shares_sum);
      const noDbMicro = decimalUsdcToMicro(m.no_shares_sum);

      // Expected invariants:
      //   open_interest == yes_supply == no_supply   (mints pair on open trades)
      //   yes_supply    == yes_db_sum                (DB tracks chain)
      //   no_supply     == no_db_sum                 (DB tracks chain)
      const mintsPaired = openInterest === yesSupply && yesSupply === noSupply;
      const yesDbMatches = yesSupply === yesDbMicro;
      const noDbMatches = noSupply === noDbMicro;

      if (mintsPaired && yesDbMatches && noDbMatches) continue;

      driftCount++;
      logger.warn(
        {
          marketId: m.marketId,
          pubkey: m.pubkey,
          asset: m.asset,
          timeframe: m.timeframe,
          status: m.status,
          onChain: {
            openInterest: openInterest.toString(),
            yesSupply: yesSupply.toString(),
            noSupply: noSupply.toString(),
          },
          dbPositions: {
            yesSharesMicro: yesDbMicro.toString(),
            noSharesMicro: noDbMicro.toString(),
          },
          drift: {
            mintsPairedOnChain: mintsPaired,
            dbYesVsSupplyLamports: (yesDbMicro - yesSupply).toString(),
            dbNoVsSupplyLamports: (noDbMicro - noSupply).toString(),
            supplyVsOpenInterestYes: (yesSupply - openInterest).toString(),
            supplyVsOpenInterestNo: (noSupply - openInterest).toString(),
          },
        },
        '[DriftReconciler] drift detected'
      );
    } catch (err: any) {
      logger.debug(`[DriftReconciler] Failed to check market ${m.marketId}: ${err.message}`);
    }
  }

  if (driftCount > 0) {
    logger.info(`[DriftReconciler] Checked ${markets.length} market(s), ${driftCount} showed drift`);
  }
}

/**
 * Parse a decimal USDC string (e.g. "123.456000") into integer micro-USDC.
 * Accepts up to 6 fractional digits, rounds half-up beyond that.
 */
function decimalUsdcToMicro(value: string): bigint {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '0') return 0n;
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const dot = unsigned.indexOf('.');
  let intPart: string;
  let fracPart: string;
  if (dot === -1) {
    intPart = unsigned;
    fracPart = '';
  } else {
    intPart = unsigned.slice(0, dot) || '0';
    fracPart = unsigned.slice(dot + 1);
  }
  let rounded = 0n;
  if (fracPart.length > 6) {
    const seventh = parseInt(fracPart[6], 10);
    fracPart = fracPart.slice(0, 6);
    rounded = seventh >= 5 ? 1n : 0n;
  }
  fracPart = fracPart.padEnd(6, '0');
  const micro = BigInt(intPart || '0') * 1_000_000n + BigInt(fracPart || '0') + rounded;
  return negative ? -micro : micro;
}
