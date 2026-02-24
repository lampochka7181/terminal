import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try multiple .env locations
const envPaths = [
  path.resolve(__dirname, '../../../.env'),     // Root: degen_terminal/.env
  path.resolve(__dirname, '../../.env'),        // apps/api/.env
  path.resolve(process.cwd(), '.env'),          // Current working directory
];

let envLoaded = false;
for (const envPath of envPaths) {
  const result = dotenv.config({ path: envPath });
  if (!result.error) {
    console.log(`✅ Loaded .env from: ${envPath}`);
    envLoaded = true;
    break;
  }
}

if (!envLoaded) {
  console.warn('⚠️  No .env file found! Tried:', envPaths);
}

// Debug: Log loaded config (mask sensitive values)
console.log('📋 Config loaded:');
console.log('   DATABASE_URL:', process.env.DATABASE_URL ? `${process.env.DATABASE_URL.substring(0, 30)}...` : '❌ NOT SET');
console.log('   REDIS_URL:', process.env.REDIS_URL || '(using default: redis://localhost:6379)');
console.log('   SUPABASE_URL:', process.env.SUPABASE_URL || '❌ NOT SET');
console.log('   JWT_SECRET:', process.env.JWT_SECRET ? '✅ SET' : '⚠️ using default');

export const config = {
  // Server
  port: parseInt(process.env.API_PORT || '4000'),
  host: process.env.API_HOST || '0.0.0.0',

  // Database pool tuning (override in .env as needed)
  // NOTE: Defaults are intentionally conservative for local/dev to avoid exhausting
  // Supabase pooler / local Postgres under bursty keeper workloads.
  dbPool: {
    max: parseInt(process.env.DB_POOL_MAX || '25'),
    min: parseInt(process.env.DB_POOL_MIN || '2'),
    idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS || '15000'),
    connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONN_TIMEOUT_MS || '10000'),
  },
  
  // Supabase
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  
  // Direct DB connection (for complex queries)
  databaseUrl: process.env.DATABASE_URL || '',
  
  // Redis (for orderbook cache)
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  
  // Auth
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
  
  // CORS - supports: "*", single origin, or comma-separated origins
  corsOrigin: (() => {
    const origin = process.env.CORS_ORIGIN || 'http://localhost:3000';
    if (origin === '*' || origin === 'true') return true;
    if (origin.includes(',')) return origin.split(',').map(o => o.trim());
    return origin;
  })(),
  
  // Solana
  solanaNetwork: process.env.SOLANA_NETWORK || 'devnet',
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  // Optional: dedicated RPC endpoint for on-chain execution (sendTransaction, confirm)
  // Falls back to solanaRpcUrl if not set. Use a separate Helius key to avoid rate contention.
  solanaExecutionRpcUrl: process.env.SOLANA_EXECUTION_RPC_URL || '',
  // Additional RPC endpoints for connection pooling (each adds ~50 RPC/s capacity)
  // The anchor client round-robins TX submission across all available connections
  solanaRpcUrl2: process.env.SOLANA_RPC_URL_2 || '',
  solanaRpcUrl3: process.env.SOLANA_RPC_URL_3 || '',
  // Helius Sender — ultra-low latency TX submission (15 tx/sec vs 5 tx/sec standard)
  // Dual-routes to validators + Jito. Free, no credits consumed. MAINNET ONLY (Jito required).
  // Backend: http://ewr-sender.helius-rpc.com/fast  Frontend: https://sender.helius-rpc.com/fast
  heliusSenderUrl: process.env.HELIUS_SENDER_URL || '',
  // Jito tip in SOL per TX (minimum 0.0002 SOL required by Sender)
  jitoTipSol: parseFloat(process.env.JITO_TIP_SOL || '0.0002'),
  programId: process.env.PROGRAM_ID || '5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk',
  relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY || '',
  // USDC-dev on devnet (use mainnet USDC for production)
  usdcMint: process.env.USDC_MINT || 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
  // Fee recipient for trading fees
  feeRecipient: process.env.FEE_RECIPIENT || '',
  
  // Oracles
  pythEndpoint: process.env.PYTH_ENDPOINT || 'https://hermes.pyth.network',
  pythBtcFeed: process.env.PYTH_BTC_USD || '',
  pythEthFeed: process.env.PYTH_ETH_USD || '',
  pythSolFeed: process.env.PYTH_SOL_USD || '',
  
  // Market Maker
  mmEnabled: process.env.MM_ENABLED === 'true',
  mmPrivateKey: process.env.MM_PRIVATE_KEY || process.env.MM_WALLET_PRIVATE_KEY || '',

  // Temporary: reduce DB usage by not persisting MM orders (they remain in Redis orderbook only)
  // Auto-enabled in PERF_TEST_MODE to avoid DB pool saturation from MM order writes
  disableMmOrderPersistence: process.env.DISABLE_MM_ORDER_PERSISTENCE === 'true' || process.env.PERF_TEST_MODE === 'true',

  // Devnet/testing: if the book is empty, force-fill market orders against MM at a reasonable price.
  // DEPRECATED: Now that MM bot is working properly, this should be disabled to use real orderbook matching.
  // Only enable for testing when no MM is running.
  devAlwaysFillMarketOrders: process.env.DEV_ALWAYS_FILL_MARKET_ORDERS === 'true' && process.env.MM_ENABLED !== 'true',
  
  // Fees - Maker orders (limit orders adding liquidity)
  makerFeeBps: 0,    // 0.00% - free to encourage liquidity
  
  // Fees - Tiered Taker Fee Structure (charged per fill, not per order)
  // Tier 1: $0 to tier1Max → flat fee
  // Tier 2: tier1Max to tier2Max → tier2Bps
  // Tier 3: tier2Max to tier3Max → tier3Bps
  // Tier 4: tier3Max+ → tier4Bps
  fees: {
    flatFeeUsd: parseFloat(process.env.FEE_FLAT_USD || '0.02'),
    tier1Max: parseFloat(process.env.FEE_TIER1_MAX || '50'),      // $0 - $50: flat fee
    tier2Max: parseFloat(process.env.FEE_TIER2_MAX || '500'),     // $50 - $500
    tier2Bps: parseInt(process.env.FEE_TIER2_BPS || '5'),         // 5 bps = 0.05%
    tier3Max: parseFloat(process.env.FEE_TIER3_MAX || '2000'),    // $500 - $2000
    tier3Bps: parseInt(process.env.FEE_TIER3_BPS || '4'),         // 4 bps = 0.04%
    tier4Bps: parseInt(process.env.FEE_TIER4_BPS || '3'),         // $2000+: 3 bps = 0.03%
  },
  
  // Order Minimums
  minBuyNotional: parseFloat(process.env.MIN_BUY_NOTIONAL || '5.0'),   // $5.00 minimum buy
  minSellNotional: parseFloat(process.env.MIN_SELL_NOTIONAL || '0.02'), // $0.02 minimum sell (= flat fee)
  
  // Gas Cost (for reference/monitoring - actual cost ~$0.00135 at current settings)
  gasCostUsd: parseFloat(process.env.GAS_COST_USD || '0.00135'),
  
  // On-chain max fee cap (basis points) - must accommodate per-fill flat fees
  // With aggregated fills + flat fee per fill, effective fee % can be high for small trades:
  // Example: $50 trade with 12 fills × $0.06 flat = $0.72 = 1.44%
  // Set to max allowed (500 bps = 5%) since relayer is trusted
  takerFeeBps: 500,   // 5% max fee cap for on-chain validation
  minNotionalValue: 10.0, // Legacy - use minBuyNotional/minSellNotional instead
  
  // ============================================================================
  // LEVERAGE CONFIGURATION
  // ============================================================================
  
  // Lending Pool Wallet - provides USDC loans for leveraged positions
  lendingWalletPrivateKey: process.env.LENDING_WALLET_PRIVATE_KEY || process.env.LENDING_WALLET || '',
  
  // Insurance Fund Wallet - receives liquidation penalties, covers bad debt
  insuranceWalletPrivateKey: process.env.INSURANCE_WALLET_PRIVATE_KEY || process.env.INSURANCE_WALLET || '',
  
  // Leverage Settings
  leverage: {
    maxLeverage: parseFloat(process.env.MAX_LEVERAGE || '10'),           // Maximum 10x leverage
    minLeverage: 1.0,                                                     // Minimum (no leverage)
    maintenanceMarginPct: parseFloat(process.env.MAINTENANCE_MARGIN_PCT || '3') / 100,  // 3% = 0.03 (liquidate later, ~30% returned with new penalty calc)
    liquidationPenaltyPct: parseFloat(process.env.LIQUIDATION_PENALTY_PCT || '2') / 100, // 2% = 0.02
    minMarginUsd: parseFloat(process.env.MIN_MARGIN_USD || '5'),          // Minimum $5 margin
    maxSingleLoanPct: parseFloat(process.env.MAX_SINGLE_LOAN_PCT || '10') / 100,  // Max 10% of pool per loan
    maxUserExposurePct: parseFloat(process.env.MAX_USER_EXPOSURE_PCT || '20') / 100, // Max 20% of pool per user
    minPoolReservePct: parseFloat(process.env.MIN_POOL_RESERVE_PCT || '10') / 100,   // Keep 10% always available
  },

  // ============================================================================
  // V2 TOKENIZED SHARES (Feature Flag)
  // ============================================================================
  // Enable V2 flow: tokenized YES/NO shares + merkle batch settlement
  // When enabled:
  // - New markets use initialize_market_v2 (creates YES/NO token mints)
  // - Trades use execute_match_v2 (mints tokens instead of Position PDAs)
  // - Settlement uses merkle proofs for batch processing
  // When disabled (default):
  // - Uses V1 flow with Position PDAs and individual settlements
  useV2: process.env.USE_V2 === 'true',

  // ============================================================================
  // AGENT API CONFIGURATION
  // ============================================================================
  agent: {
    enabled: process.env.AGENT_API_ENABLED !== 'false', // Enabled by default
    defaultFeeDiscountPct: parseInt(process.env.AGENT_DEFAULT_FEE_DISCOUNT_PCT || '25'), // 25% off taker fees
    defaultDelegationAmount: parseFloat(process.env.AGENT_DEFAULT_DELEGATION_USDC || '100'), // USDC auto-delegation
    rateLimitPerMinute: parseInt(process.env.AGENT_RATE_LIMIT || '600'), // 600/min (vs 300/min for regular users)
  },

  // ============================================================================
  // PERFORMANCE TESTING
  // ============================================================================
  // Enable performance test mode:
  //   - MM places deep liquidity (20 levels, 100k contracts each)
  //   - POST /perf/* endpoints become available (bypasses auth/signing)
  //   - Rate limit increased to 10,000/min
  //   - BullMQ concurrency boosted
  perfTestMode: process.env.PERF_TEST_MODE === 'true',
};


