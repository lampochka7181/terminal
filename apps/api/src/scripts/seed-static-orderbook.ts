/**
 * Seed Static Orderbook Script
 * 
 * SINGLE ORDERBOOK MODEL:
 * Creates static limit orders on the YES orderbook only.
 * NO orderbook is derived as complement by the frontend.
 * 
 * This ensures: ABOVE + BELOW = $1.00 always (no arbitrage)
 * 
 * Usage: npx tsx apps/api/src/scripts/seed-static-orderbook.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';

// Load environment variables
dotenvConfig({ path: resolve(process.cwd(), '.env') });

import { db, orders } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { marketService } from '../services/market.service.js';
import { userService } from '../services/user.service.js';
import { orderbookService } from '../services/orderbook.service.js';
import { orderService } from '../services/order.service.js';
import { randomUUID } from 'crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Configuration
const TARGET_TIMEFRAME = '24h';  // Target the 24h market
const TARGET_ASSET = 'BTC';
const CONTRACTS_PER_LEVEL = 1000;  // 1000 contracts per price level

// SINGLE ORDERBOOK MODEL: Only YES prices are specified
// NO prices are derived by frontend as complement (1 - YES price)
//
// Example: YES ASK @ $0.52 → user sees BELOW @ $0.48 (derived)
// When user buys BELOW @ $0.48, they match against YES BID @ $0.52

const YES_BIDS = [0.45, 0.46, 0.47, 0.48, 0.49];  // Buyers willing to pay these prices for YES
const YES_ASKS = [0.51, 0.52, 0.53, 0.54, 0.55];  // Sellers asking these prices for YES

// NO orders are NO LONGER placed - frontend derives from YES

function getRelayerWallet(): string {
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerPrivateKey) {
    throw new Error('RELAYER_PRIVATE_KEY not set in .env');
  }
  
  let keypair: Keypair;
  try {
    // Try base58 format first
    const secretKey = bs58.decode(relayerPrivateKey);
    keypair = Keypair.fromSecretKey(secretKey);
  } catch {
    try {
      // Try JSON array format
      const secretKey = JSON.parse(relayerPrivateKey);
      keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
    } catch {
      throw new Error('Invalid RELAYER_PRIVATE_KEY format');
    }
  }
  
  return keypair.publicKey.toBase58();
}

async function main() {
  console.log('🌱 Seeding Static Orderbook');
  console.log('==========================');
  
  // 1. Find the target market
  const markets = await marketService.getMarkets({ status: 'OPEN' });
  const targetMarket = markets.find(m => 
    m.asset === TARGET_ASSET && 
    m.timeframe === TARGET_TIMEFRAME &&
    parseFloat(m.strikePrice) > 0
  );
  
  if (!targetMarket) {
    console.error(`❌ No active ${TARGET_ASSET}-${TARGET_TIMEFRAME} market found`);
    process.exit(1);
  }
  
  console.log(`📍 Target Market: ${targetMarket.asset}-${targetMarket.timeframe}`);
  console.log(`   ID: ${targetMarket.id}`);
  console.log(`   Pubkey: ${targetMarket.pubkey}`);
  console.log(`   Strike: $${parseFloat(targetMarket.strikePrice).toFixed(2)}`);
  console.log(`   Expiry: ${targetMarket.expiryAt}`);
  
  // 2. Get or create a test user (use relayer wallet)
  const RELAYER_WALLET = getRelayerWallet();
  console.log(`\n🔑 Relayer Wallet: ${RELAYER_WALLET}`);
  
  let testUser = await userService.findByWallet(RELAYER_WALLET);
  if (!testUser) {
    testUser = await userService.getOrCreate(RELAYER_WALLET);
    console.log(`✅ Created test user: ${testUser.id}`);
  } else {
    console.log(`✅ Using existing user: ${testUser.id}`);
  }
  
  // 3. Clear existing orders from this user on this market (optional)
  console.log('\n🧹 Clearing existing orders from test user...');
  const { orders: existingOrders } = await orderService.getUserOrders(testUser.id, {
    status: ['OPEN', 'PARTIAL'],
    marketId: targetMarket.id,
    limit: 1000,
  });
  
  for (const order of existingOrders) {
    await orderbookService.removeOrder({
      id: order.id,
      marketId: targetMarket.id,
      userId: testUser.id,
      side: order.side as 'BID' | 'ASK',
      outcome: order.outcome as 'YES' | 'NO',
      price: parseFloat(order.price),
      size: parseFloat(order.size),
      remainingSize: parseFloat(order.remainingSize || order.size),
      createdAt: Date.now(),
    });
    // Cancel via direct DB update
    await db.update(orders).set({ status: 'CANCELLED' }).where(eq(orders.id, order.id));
  }
  console.log(`   Cleared ${existingOrders.length} existing orders`);
  
  // 4. Place YES orders only (SINGLE ORDERBOOK MODEL)
  console.log('\n📊 Placing YES orders (single orderbook model)...');
  console.log('   NO orders are derived by frontend as complement');
  
  for (const price of YES_BIDS) {
    await placeOrder(targetMarket.id, testUser.id, 'BID', 'YES', price, CONTRACTS_PER_LEVEL);
    const derivedNoAsk = (1 - price).toFixed(2);
    console.log(`   ✅ YES BID: ${CONTRACTS_PER_LEVEL} @ $${price.toFixed(2)} → NO ASK: $${derivedNoAsk} (derived)`);
  }
  
  for (const price of YES_ASKS) {
    await placeOrder(targetMarket.id, testUser.id, 'ASK', 'YES', price, CONTRACTS_PER_LEVEL);
    const derivedNoBid = (1 - price).toFixed(2);
    console.log(`   ✅ YES ASK: ${CONTRACTS_PER_LEVEL} @ $${price.toFixed(2)} → NO BID: $${derivedNoBid} (derived)`);
  }
  
  // NO orders are not placed - they're derived by the frontend
  
  // 5. Print final orderbook state (SINGLE ORDERBOOK MODEL)
  console.log('\n📋 Final Orderbook State (Single Orderbook Model):');
  
  const yesSnapshot = await orderbookService.getSnapshot(targetMarket.id, 'YES');
  
  console.log('\n   YES Orderbook (real):');
  console.log('   BIDS (MM buying YES / user selling YES):');
  for (const level of yesSnapshot.bids.slice(0, 5)) {
    console.log(`      $${level.price.toFixed(2)} x ${level.size.toFixed(0)}`);
  }
  console.log('   ASKS (MM selling YES / user buying YES):');
  for (const level of yesSnapshot.asks.slice(0, 5)) {
    console.log(`      $${level.price.toFixed(2)} x ${level.size.toFixed(0)}`);
  }
  
  console.log('\n   NO Orderbook (derived from YES):');
  console.log('   BIDS (derived from YES ASKs):');
  for (const level of yesSnapshot.asks.slice(0, 5)) {
    console.log(`      $${(1 - level.price).toFixed(2)} x ${level.size.toFixed(0)}`);
  }
  console.log('   ASKS (derived from YES BIDs):');
  for (const level of yesSnapshot.bids.slice(0, 5)) {
    console.log(`      $${(1 - level.price).toFixed(2)} x ${level.size.toFixed(0)}`);
  }
  
  const bestYesAsk = yesSnapshot.asks[0]?.price || 0.51;
  const bestYesBid = yesSnapshot.bids[0]?.price || 0.49;
  
  console.log('\n✅ Static orderbook seeded successfully!');
  console.log(`\n📍 Test on market: ${targetMarket.pubkey}`);
  console.log('\n   SINGLE ORDERBOOK MODEL ensures: ABOVE + BELOW = $1.00');
  console.log('\n   Expected prices in trade modal:');
  console.log(`   - ABOVE (buy YES): $${bestYesAsk.toFixed(2)} (best YES ask)`);
  console.log(`   - BELOW (buy NO):  $${(1 - bestYesAsk).toFixed(2)} (complement of YES ask)`);
  console.log(`   - Sum: $${(bestYesAsk + (1 - bestYesAsk)).toFixed(2)} (always $1.00)`);
  
  process.exit(0);
}

let orderCounter = 0;

async function placeOrder(
  marketId: string,
  userId: string,
  side: 'BID' | 'ASK',
  outcome: 'YES' | 'NO',
  price: number,
  size: number
): Promise<void> {
  const orderId = randomUUID();
  const now = Date.now();
  orderCounter++;
  
  // Create order in database - use counter to ensure unique client order IDs
  const dbOrder = await orderService.create({
    clientOrderId: now + orderCounter * 1000 + Math.floor(Math.random() * 100),
    marketId,
    userId,
    side,
    outcome,
    orderType: 'LIMIT',
    price: price.toString(),
    size: size.toString(),
    signature: null,
    binaryMessage: null,
    expiresAt: new Date(now + 24 * 60 * 60 * 1000), // 24h expiry
  });
  
  // Add to Redis orderbook
  await orderbookService.addOrder({
    id: dbOrder.id,
    marketId,
    userId,
    side,
    outcome,
    price,
    size,
    remainingSize: size,
    createdAt: now,
  });
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});

