import { PublicKey } from '@solana/web3.js';
import { anchorClient, fetchMarketV2OnChainState, type MarketV2ChainState } from './anchor-client.js';
import { marketService } from '../services/market.service.js';
import { logger } from './logger.js';

// L-09: Track consecutive "account not found" results before archiving.
// A single null result could be a transient RPC issue; require 3 consecutive
// confirmations before taking the irreversible archive action.
const accountGoneCount = new Map<string, number>();

/**
 * Read on-chain MarketV2 status and sync it to the database.
 *
 * Returns the on-chain state, or null if the account is gone (already finalized).
 * When the account is gone the market is archived in the DB automatically
 * (after 3 consecutive confirmations to guard against transient RPC errors).
 */
export async function syncMarketStatusFromChain(
  marketId: string,
  pubkey: string,
  currentDbStatus?: string,
): Promise<MarketV2ChainState | null> {
  if (!anchorClient.isReady()) return null;

  const connection = anchorClient.getConnection();
  const state = await fetchMarketV2OnChainState(connection, new PublicKey(pubkey));

  if (!state) {
    // L-09: Don't archive immediately — require 3 consecutive confirmations
    const count = (accountGoneCount.get(marketId) || 0) + 1;
    accountGoneCount.set(marketId, count);

    if (count < 3) {
      logger.warn(`[ChainSync] Market ${pubkey.slice(0, 8)} on-chain account not found (attempt ${count}/3), will retry before archiving`);
      return null;
    }

    // Confirmed gone after 3 checks — safe to archive
    accountGoneCount.delete(marketId);
    if (currentDbStatus && currentDbStatus !== 'SETTLED') {
      logger.info(`[ChainSync] Market ${pubkey.slice(0, 8)} on-chain account confirmed gone after ${count} checks, marking SETTLED + archived`);
      await marketService.markSettled(marketId);
    }
    await marketService.markArchived(marketId);
    return null;
  }

  // Account found — reset any "gone" counter
  accountGoneCount.delete(marketId);

  // Only update DB if chain status has *advanced* past DB status
  if (currentDbStatus && currentDbStatus !== state.status) {
    const dbOrdinal = STATUS_ORDINAL[currentDbStatus] ?? -1;
    const chainOrdinal = STATUS_ORDINAL[state.status] ?? -1;

    if (chainOrdinal > dbOrdinal) {
      logger.info(`[ChainSync] Market ${pubkey.slice(0, 8)} DB=${currentDbStatus} chain=${state.status}, updating DB`);
      await marketService.updateStatus(marketId, state.status as any);
    }
  }

  return state;
}

const STATUS_ORDINAL: Record<string, number> = {
  OPEN: 0,
  CLOSED: 1,
  RESOLVED: 2,
  SETTLED: 3,
  SETTLEMENT_FAILED: 4,
};
