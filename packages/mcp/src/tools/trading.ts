/**
 * Trading tools for AI agents.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { api } from '../api-client.js';
import { ensureAuthenticated } from '../auth.js';
import { ensureDelegation, setupDelegation } from '../delegation.js';

export function registerTradingTools(server: McpServer) {
  server.tool(
    'place_order',
    `Place a buy or sell order on a prediction market.
For BUY orders: specify side="bid", pick outcome (yes/no), set price ($0.01-$0.99) and size (number of contracts), or use dollarAmount for market orders.
For SELL orders: specify side="ask" to sell existing position shares.
The agent gets reduced trading fees automatically.`,
    {
      marketAddress: z.string().describe('Market on-chain address (pubkey)'),
      side: z.enum(['bid', 'ask']).describe('"bid" to buy, "ask" to sell'),
      outcome: z.enum(['yes', 'no']).describe('Which outcome to trade'),
      type: z.enum(['limit', 'market']).default('limit').describe('Order type'),
      price: z.number().min(0.01).max(0.99).describe('Price per contract ($0.01-$0.99)'),
      size: z.number().min(0.001).max(100000).describe('Number of contracts'),
      dollarAmount: z.number().min(0.02).max(1000000).optional().describe('Total dollar amount for market orders'),
    },
    async ({ marketAddress, side, outcome, type, price, size, dollarAmount }) => {
      await ensureAuthenticated();

      // Check delegation before trading
      const delStatus = await ensureDelegation(dollarAmount || price * size);
      if (!delStatus.ready) {
        return {
          content: [{
            type: 'text' as const,
            text: delStatus.message + '\n\nUse the setup_delegation tool to authorize USDC spending for trading.',
          }],
        };
      }

      try {
        const result = await api.post('/orders/notify', {
          marketAddress,
          side,
          outcome,
          type,
          price,
          size,
          dollarAmount,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              orderId: result.orderId,
              status: result.status,
              fills: result.fills,
              filledSize: result.filledSize,
              avgPrice: result.avgPrice,
              position: result.position,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Order failed: ${err.message}`,
          }],
        };
      }
    },
  );

  server.tool(
    'cancel_order',
    'Cancel an open order by its ID.',
    {
      orderId: z.string().describe('Order UUID to cancel'),
    },
    async ({ orderId }) => {
      await ensureAuthenticated();

      try {
        const result = await api.delete(`/orders/${orderId}`, {
          signature: 'agent-cancel', // Agent orders don't need real signatures
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, cancelled: orderId, ...result }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Cancel failed: ${err.message}`,
          }],
        };
      }
    },
  );

  server.tool(
    'cancel_all_orders',
    'Cancel all open orders, optionally filtered by market.',
    {
      marketAddress: z.string().optional().describe('Only cancel orders in this market'),
    },
    async ({ marketAddress }) => {
      await ensureAuthenticated();

      try {
        const params = marketAddress ? `?marketAddress=${marketAddress}` : '';
        const result = await api.delete(`/orders${params}`);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, ...result }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Cancel all failed: ${err.message}`,
          }],
        };
      }
    },
  );

  server.tool(
    'setup_delegation',
    `Authorize the platform to trade USDC on your behalf. This creates an on-chain "approve" transaction
that allows the relayer to execute trades using your USDC. You must do this before placing orders.`,
    {
      amount: z.number().min(1).describe('Amount of USDC to authorize for trading'),
    },
    async ({ amount }) => {
      await ensureAuthenticated();

      try {
        const signature = await setupDelegation(amount);

        return {
          content: [{
            type: 'text' as const,
            text: `Delegation set up successfully!\n\nAuthorized $${amount.toFixed(2)} USDC for trading.\nTransaction: ${signature}\n\nYou can now place orders.`,
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Delegation setup failed: ${err.message}\n\nMake sure your wallet has SOL for transaction fees and USDC for trading.`,
          }],
        };
      }
    },
  );
}
