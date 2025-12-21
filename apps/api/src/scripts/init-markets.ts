/**
 * Initialize Markets On-Chain Script
 * 
 * This script initializes all OPEN markets from the database on-chain.
 * Run this after init-protocol to set up markets for trading.
 * 
 * Usage: npx tsx src/scripts/init-markets.ts
 */

import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { marketService } from '../services/market.service.js';
import { anchorClient, PROGRAM_ID, USDC_MINT } from '../lib/anchor-client.js';
import { config } from '../config.js';

async function initializeMarkets() {
  console.log('🏪 Initializing markets on-chain...\n');

  // Check if client is ready
  if (!anchorClient.isReady()) {
    console.error('❌ Anchor client not ready. Check RELAYER_PRIVATE_KEY in .env');
    process.exit(1);
  }

  console.log('Program ID:', PROGRAM_ID.toBase58());
  console.log('USDC Mint:', USDC_MINT.toBase58());
  console.log('Relayer:', anchorClient.getRelayerPublicKey());

  // Get all OPEN markets from database
  const markets = await marketService.getMarkets({ status: 'OPEN' });
  console.log(`\nFound ${markets.length} OPEN markets in database\n`);

  if (markets.length === 0) {
    console.log('No markets to initialize. Run the API to create some markets first.');
    process.exit(0);
  }

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (const market of markets) {
    const expiryTs = Math.floor(market.expiryAt.getTime() / 1000);
    
    // Derive the correct PDA
    const derivedPda = deriveMarketPda(market.asset, market.timeframe, expiryTs);
    
    console.log(`\n📦 Market: ${market.asset}-${market.timeframe}`);
    console.log(`   DB pubkey: ${market.pubkey}`);
    console.log(`   Derived PDA: ${derivedPda}`);
    console.log(`   Strike: $${market.strikePrice}`);
    console.log(`   Expiry: ${market.expiryAt.toISOString()}`);

    // Check if pubkeys match
    if (market.pubkey !== derivedPda) {
      console.log(`   ⚠️  Pubkey mismatch! Will update DB after on-chain init`);
    }

    // Check if already expired
    if (expiryTs <= Math.floor(Date.now() / 1000)) {
      console.log(`   ⏭️  Skipping - already expired`);
      skipCount++;
      continue;
    }

    // Check if already exists on-chain
    const connection = anchorClient.getConnection();
    const accountInfo = await connection.getAccountInfo(new PublicKey(derivedPda));
    
    if (accountInfo) {
      console.log(`   ✅ Already exists on-chain (${accountInfo.data.length} bytes)`);
      skipCount++;
      continue;
    }

    // Initialize on-chain
    try {
      const signature = await anchorClient.initializeMarket({
        asset: market.asset,
        timeframe: market.timeframe,
        strikePrice: parseFloat(market.strikePrice),
        expiryTs,
      });
      console.log(`   ✅ Initialized! Tx: ${signature}`);
      successCount++;
    } catch (err: any) {
      console.log(`   ❌ Failed: ${err.message}`);
      if (err.logs) {
        console.log('   Logs:', err.logs.slice(-3).join('\n        '));
      }
      failCount++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ Initialized: ${successCount}`);
  console.log(`⏭️  Skipped: ${skipCount}`);
  console.log(`❌ Failed: ${failCount}`);
  console.log(`${'='.repeat(50)}\n`);

  process.exit(failCount > 0 ? 1 : 0);
}

/**
 * Derive the market PDA from seeds
 * Note: asset and timeframe use raw bytes, NOT padded
 */
function deriveMarketPda(
  asset: string,
  timeframe: string,
  expiryTs: number
): string {
  const expiryBuffer = Buffer.alloc(8);
  expiryBuffer.writeBigInt64LE(BigInt(expiryTs), 0);
  
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('market'),
      Buffer.from(asset),      // Raw bytes
      Buffer.from(timeframe),  // Raw bytes
      expiryBuffer,
    ],
    PROGRAM_ID
  );
  
  return pda.toBase58();
}

// Run
initializeMarkets().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

