#!/usr/bin/env node

/**
 * Degen Terminal MCP Server
 *
 * Enables AI agents (Claude, Cursor, etc.) to trade on prediction markets
 * via the Model Context Protocol.
 *
 * Configuration (env vars):
 *   WALLET_PRIVATE_KEY  - Base58-encoded Solana wallet private key (required)
 *   API_URL             - Degen Terminal API URL (default: http://localhost:4000)
 *   AGENT_NAME          - Agent display name (optional)
 *   DELEGATION_AMOUNT   - USDC amount for auto-delegation (optional)
 *   SOLANA_RPC_URL      - Solana RPC URL override (optional)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { setApiUrl } from './api-client.js';
import { initAuth, authenticate } from './auth.js';
import { registerMarketTools } from './tools/markets.js';
import { registerTradingTools } from './tools/trading.js';
import { registerPortfolioTools } from './tools/portfolio.js';

// ========================================
// Configuration
// ========================================
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
const API_URL = process.env.API_URL || 'http://localhost:4000';
const AGENT_NAME = process.env.AGENT_NAME || 'mcp-agent';

if (!WALLET_PRIVATE_KEY) {
  console.error('Error: WALLET_PRIVATE_KEY environment variable is required.');
  console.error('Set it to your base58-encoded Solana wallet private key.');
  process.exit(1);
}

// ========================================
// Initialize
// ========================================
setApiUrl(API_URL);
const walletAddress = initAuth(WALLET_PRIVATE_KEY);

// ========================================
// Create MCP Server
// ========================================
const server = new McpServer({
  name: 'degen-terminal',
  version: '1.0.0',
});

// Register all tools
registerMarketTools(server);
registerTradingTools(server);
registerPortfolioTools(server);

// ========================================
// Start Server
// ========================================
async function main() {
  // Pre-authenticate on startup
  try {
    await authenticate(AGENT_NAME);
    console.error(`[degen-terminal] Authenticated as ${walletAddress}`);
  } catch (err: any) {
    console.error(`[degen-terminal] Auth failed (will retry on first tool call): ${err.message}`);
  }

  // Connect via stdio transport (for Claude Desktop, Cursor, etc.)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[degen-terminal] MCP server running (wallet: ${walletAddress})`);
}

main().catch((err) => {
  console.error('[degen-terminal] Fatal error:', err);
  process.exit(1);
});
