/**
 * Authentication tools for AI agents.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate, getWalletAddress, getAgentName, initAuth, isAuthInitialized } from '../auth.js';
import { isAuthenticated } from '../api-client.js';

export function registerAuthTools(server: McpServer) {
  server.tool(
    'authenticate_wallet',
    'Authenticate this MCP session with a base58-encoded Solana wallet private key.',
    {
      privateKey: z.string().min(1).describe('Base58-encoded Solana wallet private key'),
      agentName: z.string().optional().describe('Optional display name to register for this agent session'),
    },
    async ({ privateKey, agentName }) => {
      try {
        const wallet = initAuth(privateKey);
        await authenticate(agentName);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              wallet,
              authenticated: true,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Wallet authentication failed: ${err.message}`,
          }],
        };
      }
    },
  );

  server.tool(
    'get_auth_status',
    'Get the current wallet authentication status for this MCP session.',
    {},
    async () => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          initialized: isAuthInitialized(),
          authenticated: isAuthenticated(),
          wallet: getWalletAddress() || null,
          agentName: getAgentName() || null,
        }, null, 2),
      }],
    }),
  );
}
