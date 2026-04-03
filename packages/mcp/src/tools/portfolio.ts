/**
 * Portfolio and account tools for AI agents.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { api } from '../api-client.js';
import { ensureAuthenticated, getWalletAddress } from '../auth.js';
import { checkDelegation } from '../delegation.js';

export function registerPortfolioTools(server: McpServer) {
  server.tool(
    'get_positions',
    'Get all your open positions across all markets. Shows YES/NO share counts, average entry prices, and unrealized P&L.',
    {},
    async () => {
      await ensureAuthenticated();

      const positions = await api.get('/user/positions');

      if (!positions || (Array.isArray(positions) && positions.length === 0)) {
        return { content: [{ type: 'text', text: 'No open positions.' }] };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(positions, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_balance',
    'Get your USDC balance breakdown (total, available, locked in positions).',
    {},
    async () => {
      await ensureAuthenticated();

      const balance = await api.get('/user/balance');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(balance, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_trades',
    'Get your recent trade history.',
    {
      limit: z.number().min(1).max(100).default(20).optional().describe('Number of trades to return'),
    },
    async ({ limit }) => {
      await ensureAuthenticated();

      const trades = await api.get('/user/trades', {
        limit: String(limit || 20),
      });

      if (!trades || (Array.isArray(trades) && trades.length === 0)) {
        return { content: [{ type: 'text', text: 'No trades found.' }] };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(trades, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_orders',
    'Get your open/pending orders.',
    {},
    async () => {
      await ensureAuthenticated();

      const orders = await api.get('/user/orders');

      if (!orders || (Array.isArray(orders) && orders.length === 0)) {
        return { content: [{ type: 'text', text: 'No open orders.' }] };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(orders, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_account_status',
    `Call this first when starting a trading session.
Returns wallet address, on-chain USDC balance, delegation status, and platform balance.
If isDelegated=false, call setup_delegation before placing any orders.`,
    {},
    async () => {
      await ensureAuthenticated();

      const wallet = getWalletAddress();
      const delegation = await checkDelegation();

      let balanceInfo: any = {};
      try {
        balanceInfo = await api.get('/user/balance');
      } catch {
        // May fail if user has no trades yet
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            wallet,
            onChainUsdcBalance: delegation.balance,
            delegatedAmount: delegation.delegatedAmount,
            isDelegated: delegation.isDelegated,
            platformBalance: balanceInfo,
          }, null, 2),
        }],
      };
    },
  );
}
