/**
 * Market discovery tools for AI agents.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { api } from '../api-client.js';

export function registerMarketTools(server: McpServer) {
  server.tool(
    'list_markets',
    'List active prediction markets. Returns markets with current prices, assets (BTC/ETH/SOL), and timeframes.',
    {
      asset: z.enum(['BTC', 'ETH', 'SOL']).optional().describe('Filter by asset'),
      status: z.enum(['OPEN', 'CLOSED', 'RESOLVED']).optional().describe('Filter by status (default: OPEN)'),
      timeframe: z.string().optional().describe('Filter by timeframe (e.g. 1H, 4H, 1D)'),
    },
    async ({ asset, status, timeframe }) => {
      const params: Record<string, string> = {};
      if (asset) params.asset = asset;
      if (status) params.status = status;
      if (timeframe) params.timeframe = timeframe;

      const raw = await api.get('/markets', params);

      const marketArray: any[] = Array.isArray(raw) ? raw : (raw?.markets || []);

      if (marketArray.length === 0) {
        return { content: [{ type: 'text', text: 'No markets found matching your filters.' }] };
      }

      const list = marketArray.map((m: any) => ({
        address: m.address || m.pubkey,
        asset: m.asset,
        timeframe: m.timeframe,
        strikePrice: m.strike || m.strikePrice,
        yesPrice: m.yesPrice,
        noPrice: m.noPrice,
        status: m.status,
        expiresAt: m.expiry || m.expiryAt,
        volume: m.volume24h || m.totalVolume,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(list, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_market',
    'Get detailed information about a specific prediction market including orderbook depth.',
    {
      address: z.string().describe('Market on-chain address (pubkey)'),
    },
    async ({ address }) => {
      const market = await api.get(`/markets/${address}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(market, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_orderbook',
    'Get the current orderbook for a market. Shows bids and asks with price levels and sizes.',
    {
      address: z.string().describe('Market on-chain address (pubkey)'),
    },
    async ({ address }) => {
      const orderbook = await api.get(`/markets/${address}/orderbook`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(orderbook, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_prices',
    'Get current crypto prices (BTC, ETH, SOL) from the platform price feed.',
    {},
    async () => {
      const prices = await api.get('/markets/prices');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(prices, null, 2),
        }],
      };
    },
  );
}
