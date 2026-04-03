#!/usr/bin/env node

/**
 * Degen Terminal MCP Server
 *
 * Enables AI agents (Claude, Cursor, etc.) to trade on prediction markets
 * via the Model Context Protocol.
 *
 * Configuration (env vars):
 *   WALLET_PRIVATE_KEY  - Base58-encoded Solana wallet private key (optional)
 *   API_URL             - Degen Terminal API URL (default: http://localhost:4000)
 *   AGENT_NAME          - Agent display name (optional)
 *   DELEGATION_AMOUNT   - USDC amount for auto-delegation (optional)
 *   SOLANA_RPC_URL      - Solana RPC URL override (optional)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { setApiUrl } from './api-client.js';
import { initAuth, authenticate, isAuthInitialized, getWalletAddress } from './auth.js';
import { setupDelegation, checkDelegation } from './delegation.js';
import { registerAuthTools } from './tools/auth.js';
import { registerMarketTools } from './tools/markets.js';
import { registerTradingTools } from './tools/trading.js';
import { registerPortfolioTools } from './tools/portfolio.js';

// ========================================
// Configuration
// ========================================
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
const API_URL = process.env.API_URL || 'http://localhost:4000';
const AGENT_NAME = process.env.AGENT_NAME || 'mcp-agent';
const DELEGATION_AMOUNT = process.env.DELEGATION_AMOUNT ? parseFloat(process.env.DELEGATION_AMOUNT) : undefined;

// ========================================
// Initialize
// ========================================
setApiUrl(API_URL);
if (WALLET_PRIVATE_KEY) {
  initAuth(WALLET_PRIVATE_KEY);
}

// ========================================
// Create MCP Server
// ========================================
const server = new McpServer({
  name: 'degen-terminal',
  version: '1.0.0',
});

// Register all tools
registerAuthTools(server);
registerMarketTools(server);
registerTradingTools(server);
registerPortfolioTools(server);

// ========================================
// Start Server
// ========================================
async function main() {
  if (isAuthInitialized()) {
    try {
      await authenticate(AGENT_NAME);
    } catch (err: any) {
      console.error(`[degen-terminal] Auth failed (will retry on first tool call): ${err.message}`);
    }

    // Auto-delegate USDC on startup if DELEGATION_AMOUNT is set
    if (DELEGATION_AMOUNT && DELEGATION_AMOUNT > 0) {
      try {
        const status = await checkDelegation();
        if (!status.isDelegated || status.delegatedAmount < DELEGATION_AMOUNT) {
          console.error(`[degen-terminal] Setting up delegation for $${DELEGATION_AMOUNT} USDC...`);
          const sig = await setupDelegation(DELEGATION_AMOUNT);
          console.error(`[degen-terminal] Delegation active ($${DELEGATION_AMOUNT} USDC). tx: ${sig}`);
        } else {
          console.error(`[degen-terminal] Delegation already active ($${status.delegatedAmount.toFixed(2)} USDC)`);
        }
      } catch (err: any) {
        console.error(`[degen-terminal] Auto-delegation failed (use setup_delegation tool): ${err.message}`);
      }
    }
  } else {
    console.error('[degen-terminal] No wallet configured. Public market tools available; call authenticate_wallet to unlock trading.');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const wallet = getWalletAddress();
  console.error(
    wallet
      ? `[degen-terminal] MCP server running (wallet: ${wallet})`
      : '[degen-terminal] MCP server running (unauthenticated)',
  );
}

main().catch((err) => {
  console.error('[degen-terminal] Fatal error:', err);
  process.exit(1);
});
