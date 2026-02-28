import { PublicKey } from '@solana/web3.js';
import { anchorClient, fetchMarketV2OnChainState, type MarketV2ChainState } from './anchor-client.js';
import { marketService } from '../services/market.service.js';
import { logger } from './logger.js';

/**
 * Read on-chain MarketV2 status and sync it to the database.
 *
 * Returns the on-chain state, or null if the account is gone (already finalized).
 * When the account is gone the market is archived in the DB automatically.
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
    // Account is gone — already finalized/closed on-chain
    if (currentDbStatus && currentDbStatus !== 'SETTLED') {
      logger.info(`[ChainSync] Market ${pubkey.slice(0, 8)} on-chain account gone, marking SETTLED + archived`);
      await marketService.markSettled(marketId);
    }
    await marketService.markArchived(marketId);
    return null;
  }

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
