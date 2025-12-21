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
  
  // CORS
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  
  // Solana
  solanaNetwork: process.env.SOLANA_NETWORK || 'devnet',
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
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
  
  // Fees
  makerFeeBps: 0,    // 0.00%
  takerFeeBps: 20,   // 0.20%
  
  // Profitability
  minNotionalValue: 10.0, // Minimum $10.00 notional to ensure fee > gas
};


