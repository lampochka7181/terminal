import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { config } from '../config.js';
import { logger } from './logger.js';

// Ed25519 program ID for signature verification
const ED25519_PROGRAM_ID = new PublicKey('Ed25519SigVerify111111111111111111111111111');

/**
 * Build an Ed25519 signature verification instruction
 * This instruction verifies that a signature is valid for a given pubkey and message
 */
function buildEd25519VerifyInstruction(
  pubkey: PublicKey,
  message: Buffer,
  signature: Buffer
): TransactionInstruction {
  // Ed25519 instruction data format:
  // - 1 byte: number of signatures (always 1 for us)
  // - 2 bytes: padding
  // - For each signature (we have 1):
  //   - 2 bytes: signature offset (relative to start of data)
  //   - 2 bytes: signature instruction index (0xFF = same instruction)
  //   - 2 bytes: pubkey offset
  //   - 2 bytes: pubkey instruction index (0xFF = same instruction)
  //   - 2 bytes: message data offset
  //   - 2 bytes: message data size
  //   - 2 bytes: message instruction index (0xFF = same instruction)
  // Then: signature (64 bytes), pubkey (32 bytes), message (variable)
  
  const numSignatures = 1;
  const headerSize = 2; // 1 byte count + 1 byte padding
  const offsetsSize = 14; // 7 x 2 bytes
  const signatureSize = 64;
  const pubkeySize = 32;
  const messageSize = message.length;
  
  const totalSize = headerSize + offsetsSize + signatureSize + pubkeySize + messageSize;
  const data = Buffer.alloc(totalSize);
  
  let offset = 0;
  
  // Number of signatures (1 byte)
  data.writeUInt8(numSignatures, offset);
  offset += 1;
  
  // Padding (1 byte)
  data.writeUInt8(0, offset);
  offset += 1;
  
  // Signature offset (2 bytes, little endian)
  const signatureOffset = headerSize + offsetsSize;
  data.writeUInt16LE(signatureOffset, offset);
  offset += 2;
  
  // Signature instruction index (2 bytes) - 0xFFFF means same instruction
  data.writeUInt16LE(0xFFFF, offset);
  offset += 2;
  
  // Pubkey offset (2 bytes)
  const pubkeyOffset = signatureOffset + signatureSize;
  data.writeUInt16LE(pubkeyOffset, offset);
  offset += 2;
  
  // Pubkey instruction index (2 bytes)
  data.writeUInt16LE(0xFFFF, offset);
  offset += 2;
  
  // Message data offset (2 bytes)
  const messageOffset = pubkeyOffset + pubkeySize;
  data.writeUInt16LE(messageOffset, offset);
  offset += 2;
  
  // Message data size (2 bytes)
  data.writeUInt16LE(messageSize, offset);
  offset += 2;
  
  // Message instruction index (2 bytes)
  data.writeUInt16LE(0xFFFF, offset);
  offset += 2;
  
  // Now write the actual data
  // Signature (64 bytes)
  signature.copy(data, signatureOffset);
  
  // Pubkey (32 bytes)
  pubkey.toBuffer().copy(data, pubkeyOffset);
  
  // Message (variable)
  message.copy(data, messageOffset);
  
  return new TransactionInstruction({
    keys: [],
    programId: ED25519_PROGRAM_ID,
    data,
  });
}

/**
 * Compute Anchor instruction discriminator
 * Anchor uses sha256("global:<snake_case_name>")[0:8]
 */
function computeDiscriminator(instructionName: string): Buffer {
  const hash = createHash('sha256')
    .update(`global:${instructionName}`)
    .digest();
  return hash.slice(0, 8);
}

// Get directory for loading IDL
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load IDL at runtime to avoid ESM import issues
let idl: any = null;
try {
  const idlPath = path.resolve(__dirname, '../../../../packages/contracts/target/idl/degen_terminal.json');
  if (fs.existsSync(idlPath)) {
    idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
    logger.info(`✅ Loaded IDL from: ${idlPath}`);
  } else {
    logger.warn(`❌ IDL file not found at: ${idlPath}`);
  }
} catch (err) {
  logger.warn('❌ Could not load IDL:', err);
}

export const PROGRAM_ID = new PublicKey(config.programId || '11111111111111111111111111111111');
export const USDC_MINT = new PublicKey(config.usdcMint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// PlaceOrderArgs type matching the on-chain structure
export interface PlaceOrderArgs {
  side: 'BID' | 'ASK';
  outcome: 'YES' | 'NO';
  orderType: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
  price: number;  // In 6 decimals (500000 = $0.50)
  size: number;   // Number of contracts
  expiryTs: number;
  clientOrderId: number;
}

// PDA derivation functions
export function getGlobalStatePda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('global')],
    PROGRAM_ID
  );
  return pda;
}

export function getMarketPda(asset: string, timeframe: string, expiryTs: number): PublicKey {
  // Seeds must match on-chain: [b"market", asset.as_bytes(), timeframe.as_bytes(), expiry_ts.to_le_bytes()]
  // Note: asset and timeframe are NOT padded - use raw string bytes
  const expiryBuffer = Buffer.alloc(8);
  expiryBuffer.writeBigInt64LE(BigInt(expiryTs), 0);
  
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('market'),
      Buffer.from(asset),      // Raw bytes, no padding
      Buffer.from(timeframe),  // Raw bytes, no padding
      expiryBuffer,
    ],
    PROGRAM_ID
  );
  return pda;
}

export function getMarketVaultPda(marketPubkey: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), marketPubkey.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

export function getUserPositionPda(marketPubkey: PublicKey, user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), marketPubkey.toBuffer(), user.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

export function getOrderPda(marketPubkey: PublicKey, owner: PublicKey, clientOrderId: number): PublicKey {
  // Seeds must match on-chain:
  // ["order", market.key(), owner.key(), client_order_id.to_le_bytes()]
  const clientIdBuffer = Buffer.alloc(8);
  clientIdBuffer.writeBigUInt64LE(BigInt(clientOrderId), 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('order'), marketPubkey.toBuffer(), owner.toBuffer(), clientIdBuffer],
    PROGRAM_ID
  );
  return pda;
}

// ============================================================================
// V2 PDA DERIVATION FUNCTIONS (Tokenized Shares Model)
// ============================================================================

export function getMarketV2Pda(asset: string, timeframe: string, expiryTs: number): PublicKey {
  // Seeds: [b"market_v2", asset.as_bytes(), timeframe.as_bytes(), expiry_ts.to_le_bytes()]
  const expiryBuffer = Buffer.alloc(8);
  expiryBuffer.writeBigInt64LE(BigInt(expiryTs), 0);

  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('market_v2'),
      Buffer.from(asset),
      Buffer.from(timeframe),
      expiryBuffer,
    ],
    PROGRAM_ID
  );
  return pda;
}

export function getYesMintPda(marketV2Pubkey: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('yes_mint'), marketV2Pubkey.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

export function getNoMintPda(marketV2Pubkey: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('no_mint'), marketV2Pubkey.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

export function getSettlementBitmapPda(marketV2Pubkey: PublicKey, chunkIndex: number): PublicKey {
  const chunkBuffer = Buffer.alloc(2);
  chunkBuffer.writeUInt16LE(chunkIndex, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('settlement_bitmap'), marketV2Pubkey.toBuffer(), chunkBuffer],
    PROGRAM_ID
  );
  return pda;
}

// On-chain MarketStatusV2 enum values (must match state_v2.rs)
const CHAIN_STATUS_MAP: Record<number, string> = {
  0: 'OPEN',       // Pending on-chain (DB uses OPEN + strikePrice='0')
  1: 'OPEN',       // Open
  2: 'CLOSED',     // Closed
  3: 'RESOLVED',   // Resolved
  4: 'RESOLVED',   // Settling on-chain; maps to RESOLVED in DB (transient state)
  5: 'SETTLED',    // Fully settled
};

// Byte offset of `status` field inside a MarketV2 account (after 8-byte discriminator)
// 8(disc) + 8(id) + 32(authority) + 10(asset) + 10(timeframe) + 8(strike) + 8(final) + 8(created) + 8(expiry) + 8(resolved) + 8(settled) = 116
const MARKET_V2_STATUS_OFFSET = 116;
// open_interest offset: status(1) + outcome(1) + volume(8) + trades(4) + yes_mint(32) + no_mint(32) = +78 from status
const MARKET_V2_OPEN_INTEREST_OFFSET = MARKET_V2_STATUS_OFFSET + 1 + 1 + 8 + 4 + 32 + 32; // 194

export interface MarketV2ChainState {
  status: string;       // Mapped DB status string
  statusRaw: number;    // Raw on-chain enum value
  openInterest: bigint; // Raw open_interest (USDC lamports)
}

/**
 * Read the on-chain status and open_interest of a MarketV2 account.
 * Returns null if the account does not exist (already finalized/closed).
 */
export async function fetchMarketV2OnChainState(
  connection: Connection,
  marketPubkey: PublicKey,
): Promise<MarketV2ChainState | null> {
  const info = await connection.getAccountInfo(marketPubkey);
  if (!info || !info.data || info.data.length < MARKET_V2_OPEN_INTEREST_OFFSET + 8) {
    return null;
  }

  const statusRaw = info.data[MARKET_V2_STATUS_OFFSET];
  const status = CHAIN_STATUS_MAP[statusRaw] ?? 'OPEN';
  const openInterest = info.data.readBigUInt64LE(MARKET_V2_OPEN_INTEREST_OFFSET);

  return { status, statusRaw, openInterest };
}

/**
 * Solana client for interacting with the Degen Terminal program
 * Uses raw instruction building for maximum compatibility
 */
export class AnchorClient {
  private connection: Connection;
  private executionConnection: Connection;  // Dedicated connection for TX submission (avoids rate contention)
  private relayerKeypair: Keypair | null = null;
  private mmKeypair: Keypair | null = null;
  private relayerUsdcAtaReady: boolean | null = null;

  // ── RPC Connection Pool ──
  // Round-robins TX submission across multiple RPC endpoints for higher throughput.
  // Each endpoint has its own rate limit (~50 RPC/s on Helius Dev), so 3 endpoints = ~150 RPC/s.
  private execConnectionPool: Connection[] = [];
  private execPoolIndex = 0;

  // ── Blockhash cache (saves 1 RPC call per TX) ──
  private cachedBlockhash: { blockhash: string; lastValidBlockHeight: number; fetchedAt: number } | null = null;
  private blockhashInflight: Promise<{ blockhash: string; lastValidBlockHeight: number }> | null = null;
  private readonly BLOCKHASH_CACHE_TTL_MS = 5000; // Reuse blockhash for 5s (valid for ~60-90s, saves RPC calls under sustained load)

  // ── Helius Sender (15 tx/sec via Jito dual-routing) ──
  private readonly heliusSenderUrl: string;
  private readonly jitoTipLamports: number;
  // Official Jito tip accounts (mainnet-beta) — full list from Helius docs
  private readonly JITO_TIP_ACCOUNTS = [
    '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
    'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
    '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
    '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
    '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
    '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
    'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
    '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
    '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
    '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
  ];

  constructor() {
    this.connection = new Connection(
      config.solanaRpcUrl,
      { commitment: 'confirmed' }
    );

    // Build execution connection pool from all available RPC URLs
    const execUrl = config.solanaExecutionRpcUrl || config.solanaRpcUrl;
    this.executionConnection = new Connection(execUrl, { commitment: 'confirmed' });
    this.execConnectionPool.push(this.executionConnection);

    // Add additional RPC endpoints to the pool
    const additionalUrls = [config.solanaRpcUrl2, config.solanaRpcUrl3].filter(u => u);
    for (const url of additionalUrls) {
      this.execConnectionPool.push(new Connection(url, { commitment: 'confirmed' }));
    }

    if (this.execConnectionPool.length > 1) {
      logger.info(`🔗 RPC connection pool: ${this.execConnectionPool.length} endpoints (${this.execConnectionPool.length * 50} est. RPC/s)`);
    } else if (config.solanaExecutionRpcUrl) {
      logger.info(`🔗 Separate execution RPC configured: ${execUrl.slice(0, 50)}...`);
    }

    // Helius Sender setup (mainnet ONLY: 15 tx/sec via Jito dual-routing)
    // Sender requires Jito which doesn't exist on devnet — auto-disable for devnet
    const isDevnet = config.solanaRpcUrl.includes('devnet');
    if (config.heliusSenderUrl && isDevnet) {
      logger.warn(`⚠️  Helius Sender disabled: Jito (required by Sender) is not available on devnet`);
      this.heliusSenderUrl = '';
    } else {
      this.heliusSenderUrl = config.heliusSenderUrl;
    }
    this.jitoTipLamports = Math.floor(config.jitoTipSol * LAMPORTS_PER_SOL);
    if (this.heliusSenderUrl) {
      logger.info(`🚀 Helius Sender enabled: ${this.heliusSenderUrl} (tip: ${config.jitoTipSol} SOL/tx)`);
    }

    // Load relayer keypair
    if (config.relayerPrivateKey) {
      try {
        const secretKey = bs58.decode(config.relayerPrivateKey);
        this.relayerKeypair = Keypair.fromSecretKey(secretKey);
        logger.info(`✅ Relayer wallet loaded: ${this.relayerKeypair.publicKey.toBase58()}`);
      } catch (err) {
        logger.warn('❌ Invalid RELAYER_PRIVATE_KEY');
      }
    } else {
      logger.warn('⚠️  RELAYER_PRIVATE_KEY not set - on-chain operations will be simulated');
    }

    // Load MM keypair
    const mmKey = config.mmPrivateKey;
    if (mmKey) {
      try {
        const secretKey = bs58.decode(mmKey);
        this.mmKeypair = Keypair.fromSecretKey(secretKey);
        logger.info(`✅ MM wallet loaded: ${this.mmKeypair.publicKey.toBase58()}`);
      } catch (err) {
        logger.warn('❌ Invalid MM_WALLET_PRIVATE_KEY');
      }
    }
    
    // Log ready status
    if (this.isReady()) {
      logger.info(`✅ Anchor client ready for on-chain operations`);
    } else {
      logger.warn(`⚠️  Anchor client NOT ready - trades/settlements will be SIMULATED`);
      if (!this.relayerKeypair) logger.warn('   - Missing: RELAYER_PRIVATE_KEY');
      if (!idl) logger.warn('   - Missing: IDL file');
    }
  }

  /**
   * Get the relayer public key
   */
  getRelayerPublicKey(): string | null {
    return this.relayerKeypair?.publicKey.toBase58() || null;
  }

  /**
   * Get the MM public key
   */
  getMmPublicKey(): string | null {
    return this.mmKeypair?.publicKey.toBase58() || null;
  }

  /**
   * Check if client is ready for on-chain operations
   */
  isReady(): boolean {
    return this.relayerKeypair !== null && idl !== null;
  }

  /**
   * Get read connection (for account lookups, balance checks, etc.)
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get execution connection (for sending transactions — may use separate RPC)
   */
  getExecutionConnection(): Connection {
    return this.executionConnection;
  }

  /**
   * Whether Helius Sender is effectively enabled (mainnet + configured).
   * Worker uses this to set appropriate concurrency/rate limits.
   */
  get isSenderEnabled(): boolean {
    return !!this.heliusSenderUrl;
  }

  /**
   * Get next execution connection from the pool (round-robin).
   * Each connection points to a different RPC endpoint with its own rate limit.
   * This multiplies our effective RPC throughput: N endpoints × 50 RPC/s each.
   */
  private getNextExecConnection(): Connection {
    const conn = this.execConnectionPool[this.execPoolIndex % this.execConnectionPool.length];
    this.execPoolIndex++;
    return conn;
  }

  /**
   * Send a serialized TX via Helius Sender (15 tx/sec, dual-routed to validators + Jito).
   * Returns the signature string on success, or null to fall back to standard send.
   */
  private async sendViaHeliusSender(serializedTx: Buffer): Promise<string | null> {
    if (!this.heliusSenderUrl) return null;

    try {
      const response = await fetch(this.heliusSenderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now().toString(),
          method: 'sendTransaction',
          params: [
            serializedTx.toString('base64'),
            {
              encoding: 'base64',
              skipPreflight: true,
              maxRetries: 0,
            },
          ],
        }),
      });

      const json = await response.json() as any;
      if (json.error) {
        logger.warn(`[Sender] Helius Sender error: ${json.error.message}`);
        return null; // Fall back to standard send
      }

      return json.result as string;
    } catch (err: any) {
      logger.warn(`[Sender] Helius Sender fetch failed: ${err.message}`);
      return null; // Fall back to standard send
    }
  }

  /**
   * Poll-based TX confirmation (used with Helius Sender since we can't use confirmTransaction
   * on a different endpoint than the one that sent the TX).
   *
   * Timeout: 10 seconds (20 attempts * 500ms) for good UX.
   * If not confirmed within timeout, returns null and caller should retry.
   */
  private async pollConfirmation(
    signature: string,
    connection: Connection,
    maxAttempts = 20,  // 20 * 500ms = 10 seconds max
    intervalMs = 500
  ): Promise<{ err: any } | null> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const status = await connection.getSignatureStatuses([signature]);
        const result = status?.value?.[0];
        if (result) {
          if (result.confirmationStatus === 'confirmed' || result.confirmationStatus === 'finalized') {
            return { err: result.err };
          }
        }
      } catch {
        // Ignore polling errors, retry
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    // Timed out — return null (treat as unknown)
    return null;
  }

  /**
   * Get a random Jito tip instruction (SOL transfer to a random tip account).
   * Required by Helius Sender for dual-routing to Jito validators.
   */
  private getJitoTipInstruction(feePayer?: PublicKey): TransactionInstruction {
    const tipAccount = this.JITO_TIP_ACCOUNTS[
      Math.floor(Math.random() * this.JITO_TIP_ACCOUNTS.length)
    ];
    return SystemProgram.transfer({
      fromPubkey: feePayer || this.relayerKeypair!.publicKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: this.jitoTipLamports,
    });
  }

  /**
   * Get a recent blockhash, with caching + single-flight to minimize RPC calls.
   * Multiple concurrent callers share the same fetch; result is cached for 2s.
   */
  private async getCachedBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const now = Date.now();
    if (this.cachedBlockhash && (now - this.cachedBlockhash.fetchedAt) < this.BLOCKHASH_CACHE_TTL_MS) {
      return { blockhash: this.cachedBlockhash.blockhash, lastValidBlockHeight: this.cachedBlockhash.lastValidBlockHeight };
    }
    // Single-flight: if someone is already fetching, wait for them
    if (this.blockhashInflight) {
      return this.blockhashInflight;
    }
    this.blockhashInflight = (async () => {
      try {
        const result = await this.executionConnection.getLatestBlockhash('confirmed');
        this.cachedBlockhash = { ...result, fetchedAt: Date.now() };
        return result;
      } finally {
        this.blockhashInflight = null;
      }
    })();
    return this.blockhashInflight;
  }

  /**
   * Ensure the relayer has a USDC ATA.
   * Needed for `close_market` which expects `relayer_usdc` to be initialized.
   *
   * Returns zero or one instructions (create ATA).
   */
  async ensureRelayerUsdcAtaIxs(): Promise<TransactionInstruction[]> {
    if (!this.relayerKeypair) throw new Error('Relayer not initialized');
    if (this.relayerUsdcAtaReady === true) return [];

    const relayer = this.relayerKeypair.publicKey;
    const ata = await getAssociatedTokenAddress(USDC_MINT, relayer);

    const info = await this.connection.getAccountInfo(ata, 'confirmed');
    if (info) {
      this.relayerUsdcAtaReady = true;
      return [];
    }

    // Avoid spamming ATA creates in the same process loop
    this.relayerUsdcAtaReady = false;

    return [
      createAssociatedTokenAccountInstruction(
        relayer, // payer
        ata,     // ata
        relayer, // owner
        USDC_MINT
      ),
    ];
  }

  /**
   * Encode PlaceOrderArgs to buffer matching Anchor's Borsh serialization
   * 
   * Borsh is a packed format - no padding between fields.
   * Struct layout:
   *   - side: u8 (enum)
   *   - outcome: u8 (enum)  
   *   - orderType: u8 (enum)
   *   - price: u64
   *   - size: u64
   *   - expiryTs: i64
   *   - clientOrderId: u64
   * Total: 3 + 8 + 8 + 8 + 8 = 35 bytes
   */
  private encodePlaceOrderArgs(args: PlaceOrderArgs): Buffer {
    const buffer = Buffer.alloc(35);
    let offset = 0;

    // Side enum (0 = Bid, 1 = Ask)
    buffer.writeUInt8(args.side === 'BID' ? 0 : 1, offset);
    offset += 1;

    // Outcome enum (0 = Yes, 1 = No)
    buffer.writeUInt8(args.outcome === 'YES' ? 0 : 1, offset);
    offset += 1;

    // OrderType enum (0 = Limit, 1 = Market, 2 = IOC, 3 = FOK)
    const orderTypeMap: Record<string, number> = { LIMIT: 0, MARKET: 1, IOC: 2, FOK: 3 };
    buffer.writeUInt8(orderTypeMap[args.orderType] || 0, offset);
    offset += 1;

    // Price (u64, 6 decimals)
    buffer.writeBigUInt64LE(BigInt(args.price), offset);
    offset += 8;

    // Size (u64)
    buffer.writeBigUInt64LE(BigInt(args.size), offset);
    offset += 8;

    // ExpiryTs (i64)
    buffer.writeBigInt64LE(BigInt(args.expiryTs), offset);
    offset += 8;

    // ClientOrderId (u64)
    buffer.writeBigUInt64LE(BigInt(args.clientOrderId), offset);
    offset += 8;

    logger.debug(`Encoded PlaceOrderArgs: side=${args.side}, outcome=${args.outcome}, type=${args.orderType}, price=${args.price}, size=${args.size}`);
    
    return buffer;
  }

  /**
   * Build execute_match instruction using raw encoding
   * Supports hybrid model: Order PDAs for user orders, direct transfer for MM orders
   */
  async buildExecuteMatchInstruction(params: {
    marketPubkey: PublicKey;
    makerWallet: PublicKey;
    takerWallet: PublicKey;
    makerArgs: PlaceOrderArgs;
    takerArgs: PlaceOrderArgs;
    matchSize: number;
    takerFee: number;  // Fee in USDC (6 decimals) - calculated by relayer
    makerOrderPda?: PublicKey | null;  // Order PDA if user order
    takerOrderPda?: PublicKey | null;  // Order PDA if user order
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const globalState = getGlobalStatePda();
    const market = params.marketPubkey;
    
    // Get vault as market's ATA
    const vault = await getAssociatedTokenAddress(USDC_MINT, market, true);
    
    // Get positions PDAs
    const makerPosition = getUserPositionPda(market, params.makerWallet);
    const takerPosition = getUserPositionPda(market, params.takerWallet);

    // Get USDC ATAs
    const makerUsdc = await getAssociatedTokenAddress(USDC_MINT, params.makerWallet);
    const takerUsdc = await getAssociatedTokenAddress(USDC_MINT, params.takerWallet);

    // Get fee recipient from config or use relayer
    const feeRecipientWallet = config.feeRecipient 
      ? new PublicKey(config.feeRecipient)
      : this.relayerKeypair.publicKey;
    const feeRecipient = await getAssociatedTokenAddress(USDC_MINT, feeRecipientWallet);

    // Build instruction data
    // Anchor discriminator = sha256("global:execute_match")[0:8]
    const discriminator = computeDiscriminator('execute_match');
    logger.debug(`execute_match discriminator: ${discriminator.toString('hex')}`);
    
    const makerArgsBuffer = this.encodePlaceOrderArgs(params.makerArgs);
    const takerArgsBuffer = this.encodePlaceOrderArgs(params.takerArgs);
    const matchSizeBuffer = Buffer.alloc(8);
    matchSizeBuffer.writeBigUInt64LE(BigInt(params.matchSize), 0);
    const takerFeeBuffer = Buffer.alloc(8);
    takerFeeBuffer.writeBigUInt64LE(BigInt(params.takerFee), 0);

    const data = Buffer.concat([discriminator, makerArgsBuffer, takerArgsBuffer, matchSizeBuffer, takerFeeBuffer]);

    // Build accounts list
    // Note: Order PDAs are optional (None = no account, Some = account present)
    // For Anchor optional accounts, we pass the program ID to indicate None
    const makerOrderAccount = params.makerOrderPda || PROGRAM_ID;  // None if not provided
    const takerOrderAccount = params.takerOrderPda || PROGRAM_ID;  // None if not provided
    // seller_usdc_receive is reserved for future closing trades, pass None for now
    const sellerUsdcReceive = PROGRAM_ID;

    logger.info(`execute_match: market=${market.toBase58()}`);
    logger.info(`execute_match: maker=${params.makerWallet.toBase58()}, makerPosition=${makerPosition.toBase58()}`);
    logger.info(`execute_match: taker=${params.takerWallet.toBase58()}, takerPosition=${takerPosition.toBase58()}`);
    logger.info(`execute_match: makerOrder=${params.makerOrderPda?.toBase58() || 'None'}, takerOrder=${params.takerOrderPda?.toBase58() || 'None'}`);

    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: globalState, isSigner: false, isWritable: false },
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        // Maker accounts
        { pubkey: params.makerWallet, isSigner: false, isWritable: false },
        { pubkey: makerPosition, isSigner: false, isWritable: true },
        { pubkey: makerUsdc, isSigner: false, isWritable: true },
        { pubkey: makerOrderAccount, isSigner: false, isWritable: params.makerOrderPda ? true : false },  // Optional Order PDA
        // Taker accounts
        { pubkey: params.takerWallet, isSigner: false, isWritable: false },
        { pubkey: takerPosition, isSigner: false, isWritable: true },
        { pubkey: takerUsdc, isSigner: false, isWritable: true },
        { pubkey: takerOrderAccount, isSigner: false, isWritable: params.takerOrderPda ? true : false },  // Optional Order PDA
        // Seller USDC receive (optional - reserved for closing trades, pass None)
        { pubkey: sellerUsdcReceive, isSigner: false, isWritable: false },
        // Common accounts
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Build all instructions needed for execute_match including Ed25519 signature verifications
   * Returns [makerEd25519, takerEd25519, executeMatch]
   */
  async buildExecuteMatchWithSignatures(params: {
    marketPubkey: PublicKey;
    makerWallet: PublicKey;
    takerWallet: PublicKey;
    makerArgs: PlaceOrderArgs;
    takerArgs: PlaceOrderArgs;
    matchSize: number;
    makerSignature: string;  // Base58 encoded signature
    takerSignature: string;  // Base58 encoded signature
    makerMessage: string;    // Base64 encoded binary message
    takerMessage: string;    // Base64 encoded binary message
  }): Promise<TransactionInstruction[]> {
    // Decode signatures and messages
    const makerSigBuffer = Buffer.from(bs58.decode(params.makerSignature));
    const takerSigBuffer = Buffer.from(bs58.decode(params.takerSignature));
    const makerMsgBuffer = Buffer.from(params.makerMessage, 'base64');
    const takerMsgBuffer = Buffer.from(params.takerMessage, 'base64');

    // Build Ed25519 verify instructions
    const makerEd25519Ix = buildEd25519VerifyInstruction(
      params.makerWallet,
      makerMsgBuffer,
      makerSigBuffer
    );

    const takerEd25519Ix = buildEd25519VerifyInstruction(
      params.takerWallet,
      takerMsgBuffer,
      takerSigBuffer
    );

    // Build execute_match instruction
    // Note: This legacy function is for Ed25519 signed orders - fee defaults to flat minimum
    const executeMatchIx = await this.buildExecuteMatchInstruction({
      marketPubkey: params.marketPubkey,
      makerWallet: params.makerWallet,
      takerWallet: params.takerWallet,
      makerArgs: params.makerArgs,
      takerArgs: params.takerArgs,
      matchSize: params.matchSize,
      takerFee: 20_000,  // Default $0.02 flat fee for legacy signed orders
    });

    // Order matters: Ed25519 verifications must come before execute_match
    // so the contract can read them from the instructions sysvar
    return [makerEd25519Ix, takerEd25519Ix, executeMatchIx];
  }

  /**
   * Build settle_positions instruction using raw encoding
   */
  async buildSettlePositionInstruction(params: {
    marketPubkey: PublicKey;
    userWallet: PublicKey;
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const market = params.marketPubkey;
    const vault = await getAssociatedTokenAddress(USDC_MINT, market, true);
    const position = getUserPositionPda(market, params.userWallet);
    const userUsdc = await getAssociatedTokenAddress(USDC_MINT, params.userWallet);

    // Anchor discriminator = sha256("global:settle_positions")[0:8]
    const discriminator = computeDiscriminator('settle_positions');
    logger.info(`settle_positions: market=${market.toBase58()}`);
    logger.info(`settle_positions: user=${params.userWallet.toBase58()}, position=${position.toBase58()}`);

    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: userUsdc, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: discriminator,
    });
  }

  /**
   * Submit a transaction with compute budget and confirmation.
   * Routes via Helius Sender (15 tx/sec) when configured, otherwise standard RPC (5 tx/sec).
   */
  async submitTransaction(
    instructions: TransactionInstruction[],
    additionalSigners: Keypair[] = [],
    contextLabel: string = 'Transaction',
    opts?: { priorityMicroLamports?: number; computeUnits?: number; feePayerOverride?: Keypair; skipSimulation?: boolean }
  ): Promise<string> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer keypair not set');
    }

    const feePayer = opts?.feePayerOverride || this.relayerKeypair;
    const transaction = new Transaction();

    // Add compute budget with priority fee (override-able for settlement ops)
    const computeUnits = opts?.computeUnits ?? 400000;
    const priorityFee = opts?.priorityMicroLamports ?? 10000;
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee })
    );

    // Add instructions
    for (const ix of instructions) {
      transaction.add(ix);
    }

    // Add Jito tip instruction when using Helius Sender (required for dual-routing)
    if (this.heliusSenderUrl) {
      transaction.add(this.getJitoTipInstruction(feePayer.publicKey));
    }

    // Get recent blockhash (cached to save RPC calls under high throughput)
    const { blockhash, lastValidBlockHeight } = await this.getCachedBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = feePayer.publicKey;

    // Sign with fee payer + relayer (if different) + additional signers
    const signers: Keypair[] = [feePayer];
    if (opts?.feePayerOverride) {
      signers.push(this.relayerKeypair); // Master also signs as relayer authority
    }
    signers.push(...additionalSigners);
    transaction.sign(...signers);

    const serializedTx = transaction.serialize();
    const execConn = this.getNextExecConnection();

    try {
      let signature: string;

      // ── Try Helius Sender first (15 tx/sec, dual-routed to validators + Jito) ──
      const senderSig = await this.sendViaHeliusSender(serializedTx as Buffer);

      if (senderSig) {
        signature = senderSig;
        // Sender uses a different endpoint — confirm via polling on our RPC connection
        const pollResult = await this.pollConfirmation(signature, execConn);
        if (pollResult === null) {
          // Timeout — TX may have landed but we can't confirm. Treat as success (caller retries if needed)
          logger.warn(`[Sender] ${contextLabel}: confirmation timed out for ${signature.slice(0, 16)}...`);
          return signature;
        }
        if (pollResult.err) {
          // TX confirmed but failed on-chain
          let logMessages: string[] | undefined;
          try {
            const tx = await this.connection.getTransaction(signature, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            } as any);
            logMessages = (tx as any)?.meta?.logMessages;
          } catch { /* ignore */ }
          const errJson = JSON.stringify(pollResult.err);
          const logsStr = logMessages ? JSON.stringify(logMessages, null, 2) : 'No logs available';
          const error = new Error(`[${contextLabel}] CONFIRMED BUT FAILED: ${errJson}\nLogs: ${logsStr}`);
          (error as any).logs = logMessages;
          throw error;
        }
        return signature;
      }

      // ── Fallback: standard sendRawTransaction with aggressive resend loop ──
      // On devnet (no Helius Sender) the RPC's built-in retry is insufficient.
      // We resend the same signed TX every 2s to reach new leaders as they rotate,
      // while confirmTransaction waits for inclusion or block-height expiry.

      // Run preflight simulation FIRST to fail fast on invalid transactions
      // instead of waiting ~60s for block height to expire.
      // Skip simulation for speed-critical paths (match/close) when configured.
      const shouldSimulate = !opts?.skipSimulation && !config.skipPreflightSimulation;
      if (shouldSimulate) {
        try {
          const simResult = await execConn.simulateTransaction(transaction);
          if (simResult.value.err) {
            const simLogs = simResult.value.logs || [];
            const errJson = JSON.stringify(simResult.value.err);
            const logText = simLogs.join(' ');

            // Map simulation errors to recognizable keywords that downstream handlers check for.
            // Without this, the preflight wraps errors in a new message format that breaks
            // idempotent "already in use" / "AccountNotInitialized" detection.
            if (logText.includes('already in use') || errJson.includes('"Custom":0}')) {
              logger.debug(`[${contextLabel}] Preflight: account already in use (idempotent)`);
              const error = new Error(`already in use (0x0)`);
              (error as any).logs = simLogs;
              throw error;
            }
            if (logText.includes('AccountNotInitialized') || errJson.includes('"Custom":3012')) {
              logger.debug(`[${contextLabel}] Preflight: AccountNotInitialized (race condition)`);
              const error = new Error(`AccountNotInitialized (0xbc4)`);
              (error as any).logs = simLogs;
              throw error;
            }
            if (logText.includes('MarketClosing') || errJson.includes('"Custom":6007')) {
              logger.warn(`[${contextLabel}] Preflight: MarketClosing (within trading close buffer)`);
              const error = new Error(`MarketClosing (0x1777)`);
              (error as any).logs = simLogs;
              throw error;
            }
            if (logText.includes('MarketNotExpired') || errJson.includes('"Custom":6009')) {
              logger.warn(`[${contextLabel}] Preflight: MarketNotExpired (clock skew)`);
              const error = new Error(`MarketNotExpired (0x1779)`);
              (error as any).logs = simLogs;
              throw error;
            }
            if (logText.includes('MarketAlreadyResolved') || errJson.includes('"Custom":6011')) {
              logger.debug(`[${contextLabel}] Preflight: MarketAlreadyResolved (idempotent)`);
              const error = new Error(`MarketAlreadyResolved (0x177B)`);
              (error as any).logs = simLogs;
              throw error;
            }

            // Genuinely unexpected failure — log full details at ERROR
            logger.error(`[${contextLabel}] Preflight simulation FAILED: ${errJson}`);
            if (simLogs.length > 0) {
              logger.error(`[${contextLabel}] Simulation logs:\n${simLogs.join('\n')}`);
            }
            const error = new Error(`[${contextLabel}] Preflight simulation failed: ${errJson}`);
            (error as any).logs = simLogs;
            throw error;
          }
          logger.debug(`[${contextLabel}] Preflight simulation OK (units: ${simResult.value.unitsConsumed})`);
        } catch (simErr: any) {
          // Re-throw errors from our own preflight handling above
          if (simErr.logs !== undefined) throw simErr;
          // Network errors — log and proceed with send anyway (simulation endpoint might be down)
          logger.warn(`[${contextLabel}] Preflight simulation request failed (proceeding anyway): ${simErr.message?.slice(0, 100)}`);
        }
      } else {
        logger.debug(`[${contextLabel}] Skipping preflight simulation (speed-critical path)`);
      }

      signature = await execConn.sendRawTransaction(
        serializedTx,
        { skipPreflight: true, maxRetries: 0 } // We manage retries ourselves
      );

      // Aggressive resend: keep forwarding the TX to new leaders every 2 seconds
      // across ALL connections in the pool for maximum propagation.
      const resendIntervalMs = 2000;
      const resendTimer = setInterval(async () => {
        for (const conn of this.execConnectionPool) {
          try {
            await conn.sendRawTransaction(serializedTx, { skipPreflight: true, maxRetries: 0 });
          } catch { /* ignore — TX may already be confirmed or blockhash expired */ }
        }
      }, resendIntervalMs);

      try {
        // Confirm transaction with a hard timeout to avoid waiting 60+ seconds on devnet.
        // Solana's confirmTransaction waits for block height expiry (~151 blocks = ~60s on devnet).
        // For good UX, we timeout after 10 seconds - if not confirmed, BullMQ will retry.
        const MAX_CONFIRM_TIMEOUT_MS = 10_000;

        const confirmationPromise = execConn.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed'
        );

        const timeoutPromise = new Promise<{ value: { err: null }, timedOut: true }>((resolve) => {
          setTimeout(() => resolve({ value: { err: null }, timedOut: true }), MAX_CONFIRM_TIMEOUT_MS);
        });

        const confirmation = await Promise.race([confirmationPromise, timeoutPromise]) as any;

        // If timed out, return signature - tx may still confirm later, caller can retry via BullMQ
        if (confirmation.timedOut) {
          logger.warn(`[${contextLabel}] Confirmation timeout (${MAX_CONFIRM_TIMEOUT_MS}ms) for ${signature.slice(0, 16)}... — will retry`);
          // Clear resend timer before returning
          clearInterval(resendTimer);
          // Throw to trigger BullMQ retry
          throw new Error(`Confirmation timeout after ${MAX_CONFIRM_TIMEOUT_MS}ms`);
        }

        // IMPORTANT: confirmTransaction does NOT throw if the tx executed and failed.
        // We must explicitly check `err` and surface a real failure so callers don't
        // assume the transaction succeeded (e.g. market creation).
        if (confirmation?.value?.err) {
          // Best-effort fetch logs for debugging (may be null depending on RPC)
          let logMessages: string[] | undefined;
          try {
            const tx = await this.connection.getTransaction(signature, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            } as any);
            logMessages = (tx as any)?.meta?.logMessages;
          } catch {
            // ignore
          }
          const errJson = JSON.stringify(confirmation.value.err);
          const logsStr = logMessages ? JSON.stringify(logMessages, null, 2) : 'No logs available';
          const error = new Error(`[${contextLabel}] CONFIRMED BUT FAILED: ${errJson}\nLogs: ${logsStr}`);
          // Attach logs for existing error handler formatting
          (error as any).logs = logMessages;
          throw error;
        }
      } finally {
        clearInterval(resendTimer);
      }

      return signature;
    } catch (err: any) {
      const logsStr = err.logs ? JSON.stringify(err.logs, null, 2) : 'No logs available';
      const errorMsg = err.message || '';

      // Invalidate blockhash cache on expiry errors so retries get a fresh one
      if (errorMsg.includes('block height exceeded') || errorMsg.includes('Blockhash not found') || errorMsg.includes('expired')) {
        this.cachedBlockhash = null;
      }
      
      // Downgrade common "drift" errors to DEBUG level to avoid terminal noise
      const isCommonError = 
        errorMsg.includes('already in use') || 
        errorMsg.includes('0x0') ||
        errorMsg.includes('AccountNotInitialized') ||
        errorMsg.includes('0xbc4') ||
        errorMsg.includes('MarketNotPending') ||
        errorMsg.includes('0x1774'); // MarketNotPending error code (6004)

      if (isCommonError) {
        logger.debug(`[${contextLabel}] skipped (expected): ${errorMsg.slice(0, 100)}...`);
      } else {
        logger.error(`[${contextLabel}] FAILED: ${errorMsg}\nLogs: ${logsStr}`);
      }
      throw err;
    }
  }

  /**
   * Execute a match on-chain
   * 
   * @param params Match parameters including signatures for Ed25519 verification
   * @returns Transaction signature
   */
  async executeMatch(params: {
    marketPubkey: string;
    makerWallet: string;
    takerWallet: string;
    makerSide: 'BID' | 'ASK';
    takerSide: 'BID' | 'ASK';
    outcome: 'YES' | 'NO';
    price: number;
    matchSize: number;
    takerFee: number;  // Fee in USD (will be converted to 6 decimals)
    makerClientOrderId: number;
    takerClientOrderId: number;
    makerExpiryTs: number;
    takerExpiryTs: number;
    // On-chain Order PDAs (for user orders - trustless verification)
    makerOrderPda?: string;   // On-chain Order account (if user order)
    takerOrderPda?: string;   // On-chain Order account (if user order)
    // Legacy: signatures for MM orders (off-chain verification)
    makerSignature?: string;  // Base58 encoded Ed25519 signature
    takerSignature?: string;  // Base58 encoded Ed25519 signature
    makerMessage?: string;    // Base64 encoded binary message
    takerMessage?: string;    // Base64 encoded binary message
    feePayerKeypair?: Keypair; // Pool child wallet as fee payer
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready - check RELAYER_PRIVATE_KEY');
    }

    const market = new PublicKey(params.marketPubkey);
    const makerWallet = new PublicKey(params.makerWallet);
    const takerWallet = new PublicKey(params.takerWallet);

    // Convert to instruction format
    // Price: 6 decimals (0.52 -> 520_000)
    // Size: 6 decimals for fractional contracts (1.5 contracts -> 1_500_000)
    // Fee: 6 decimals ($0.02 -> 20_000)
    const priceU64 = Math.floor(params.price * 1_000_000);
    const sizeU64 = Math.floor(params.matchSize * 1_000_000);
    const feeU64 = Math.floor(params.takerFee * 1_000_000);

    const makerArgs: PlaceOrderArgs = {
      side: params.makerSide,
      outcome: params.outcome,
      orderType: 'LIMIT',
      price: priceU64,
      size: sizeU64,  // Fractional: 6 decimals
      expiryTs: params.makerExpiryTs,
      clientOrderId: params.makerClientOrderId,
    };

    const takerArgs: PlaceOrderArgs = {
      side: params.takerSide,
      outcome: params.outcome,
      orderType: 'LIMIT',
      price: priceU64,
      size: sizeU64,  // Fractional: 6 decimals
      expiryTs: params.takerExpiryTs,
      clientOrderId: params.takerClientOrderId,
    };

    // Parse Order PDAs if provided
    const makerOrderPda = params.makerOrderPda ? new PublicKey(params.makerOrderPda) : null;
    const takerOrderPda = params.takerOrderPda ? new PublicKey(params.takerOrderPda) : null;

    logger.debug(`executeMatch: makerHasOrderPda=${!!makerOrderPda}, takerHasOrderPda=${!!takerOrderPda}`);

    // Build execute_match instruction with optional Order PDAs
    const ix = await this.buildExecuteMatchInstruction({
      marketPubkey: market,
      makerWallet,
      takerWallet,
      makerArgs,
      takerArgs,
      matchSize: sizeU64,  // Fractional: 6 decimals
      takerFee: feeU64,    // Tiered fee calculated by relayer
      makerOrderPda,
      takerOrderPda,
    });

    const signature = await this.submitTransaction([ix], [], `Match ${params.matchSize} shares`, {
      feePayerOverride: params.feePayerKeypair,
      skipSimulation: true, // Speed-critical: skip preflight to save 100-500ms
    });
    logger.debug(`Match executed on-chain: ${signature}`);

    return signature;
  }

  /**
   * Execute a LEVERAGED match on-chain
   * 
   * Key difference from executeMatch: The Lending Pool wallet acts as the taker (buyer),
   * executing the trade from its funds. The position is owned by Lending Pool on-chain,
   * but tracked to the user in the database.
   * 
   * NOTE: The Lending Pool must have delegation set up to the relayer (just like MM).
   * Run: npx ts-node apps/api/src/scripts/setup-lending-delegation.ts
   * 
   * @param params Match parameters
   * @returns Transaction signature
   */
  async executeLeveragedMatch(params: {
    marketPubkey: string;
    makerWallet: string;       // MM wallet (selling)
    lendingPoolWallet: string; // Lending pool wallet (buying on behalf of user)
    userWallet: string;        // User wallet (for tracking only - not used on-chain)
    makerSide: 'BID' | 'ASK';
    takerSide: 'BID' | 'ASK';
    outcome: 'YES' | 'NO';
    price: number;
    matchSize: number;
    takerFee: number;
    makerClientOrderId: number;
    takerClientOrderId: number;
    makerExpiryTs: number;
    takerExpiryTs: number;
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready - check RELAYER_PRIVATE_KEY');
    }

    const market = new PublicKey(params.marketPubkey);
    const makerWallet = new PublicKey(params.makerWallet);
    const lendingPoolWalletPubkey = new PublicKey(params.lendingPoolWallet);

    // Convert to instruction format (6 decimals)
    const priceU64 = Math.floor(params.price * 1_000_000);
    const sizeU64 = Math.floor(params.matchSize * 1_000_000);
    const feeU64 = Math.floor(params.takerFee * 1_000_000);

    const makerArgs: PlaceOrderArgs = {
      side: params.makerSide,
      outcome: params.outcome,
      orderType: 'LIMIT',
      price: priceU64,
      size: sizeU64,
      expiryTs: params.makerExpiryTs,
      clientOrderId: params.makerClientOrderId,
    };

    const takerArgs: PlaceOrderArgs = {
      side: params.takerSide,
      outcome: params.outcome,
      orderType: 'LIMIT',
      price: priceU64,
      size: sizeU64,
      expiryTs: params.takerExpiryTs,
      clientOrderId: params.takerClientOrderId,
    };

    logger.info(`executeLeveragedMatch: Lending Pool ${lendingPoolWalletPubkey.toBase58().slice(0,8)} buying on behalf of user ${params.userWallet.slice(0,8)}`);
    logger.info(`executeLeveragedMatch: ${params.matchSize} shares @ ${params.price}`);

    // Build execute_match instruction with Lending Pool as taker (buyer)
    // The relayer has delegation authority over Lending Pool's USDC (same as MM)
    const ix = await this.buildExecuteMatchInstruction({
      marketPubkey: market,
      makerWallet,
      takerWallet: lendingPoolWalletPubkey, // Lending pool is the taker!
      makerArgs,
      takerArgs,
      matchSize: sizeU64,
      takerFee: feeU64,
      makerOrderPda: null,  // MM orders don't have PDAs
      takerOrderPda: null,  // Lending pool doesn't use order PDAs
    });

    // Submit transaction - relayer signs and uses delegation for Lending Pool transfer
    // (no additional signer needed since relayer has delegation authority)
    const signature = await this.submitTransaction(
      [ix], 
      [], // No additional signers - relayer has delegation authority
      `Leveraged Match ${params.matchSize} shares for user ${params.userWallet.slice(0,8)}`
    );
    
    logger.info(`Leveraged match executed on-chain: ${signature}`);
    
    return signature;
  }

  /**
   * Build execute_close instruction for closing trades
   * (seller sells existing shares to buyer)
   */
  async buildExecuteCloseInstruction(params: {
    marketPubkey: PublicKey;
    buyerWallet: PublicKey;
    sellerWallet: PublicKey;
    outcome: 'YES' | 'NO';
    price: number;    // In 6 decimals
    size: number;     // In 6 decimals
    takerFee: number; // In 6 decimals
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const globalState = getGlobalStatePda();
    const market = params.marketPubkey;

    // Get fee recipient from config or use relayer
    const feeRecipientWallet = config.feeRecipient 
      ? new PublicKey(config.feeRecipient)
      : this.relayerKeypair.publicKey;
    const feeRecipient = await getAssociatedTokenAddress(USDC_MINT, feeRecipientWallet);

    // Get positions PDAs
    const buyerPosition = getUserPositionPda(market, params.buyerWallet);
    const sellerPosition = getUserPositionPda(market, params.sellerWallet);

    // Get USDC ATAs
    const buyerUsdc = await getAssociatedTokenAddress(USDC_MINT, params.buyerWallet);
    const sellerUsdc = await getAssociatedTokenAddress(USDC_MINT, params.sellerWallet);

    // Build instruction data
    // Anchor discriminator = sha256("global:execute_close")[0:8]
    const discriminator = computeDiscriminator('execute_close');
    
    // CloseTradeArgs: outcome (u8) + price (u64) + size (u64) + taker_fee (u64)
    const argsBuffer = Buffer.alloc(25);
    argsBuffer.writeUInt8(params.outcome === 'YES' ? 0 : 1, 0);  // outcome: 0=Yes, 1=No
    argsBuffer.writeBigUInt64LE(BigInt(params.price), 1);
    argsBuffer.writeBigUInt64LE(BigInt(params.size), 9);
    argsBuffer.writeBigUInt64LE(BigInt(params.takerFee), 17);

    const data = Buffer.concat([discriminator, argsBuffer]);

    logger.info(`execute_close: market=${market.toBase58()}`);
    logger.info(`execute_close: buyer=${params.buyerWallet.toBase58()}, buyerPosition=${buyerPosition.toBase58()}`);
    logger.info(`execute_close: seller=${params.sellerWallet.toBase58()}, sellerPosition=${sellerPosition.toBase58()}`);
    logger.info(`execute_close: outcome=${params.outcome}, price=${params.price}, size=${params.size}`);

    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: globalState, isSigner: false, isWritable: false },
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        // Buyer accounts
        { pubkey: params.buyerWallet, isSigner: false, isWritable: false },
        { pubkey: buyerPosition, isSigner: false, isWritable: true },
        { pubkey: buyerUsdc, isSigner: false, isWritable: true },
        // Seller accounts
        { pubkey: params.sellerWallet, isSigner: false, isWritable: false },
        { pubkey: sellerPosition, isSigner: false, isWritable: true },
        { pubkey: sellerUsdc, isSigner: false, isWritable: true },
        // Common accounts
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Execute a closing trade on-chain
   * (seller sells existing shares to buyer)
   * 
   * @param params Close trade parameters
   * @returns Transaction signature
   */
  async executeClose(params: {
    marketPubkey: string;
    buyerWallet: string;
    sellerWallet: string;
    outcome: 'YES' | 'NO';
    price: number;      // Price in dollars (e.g., 0.52)
    matchSize: number;  // Number of contracts (e.g., 100)
    takerFee: number;   // Fee in USD (e.g., 0.02)
    feePayerKeypair?: Keypair; // Pool child wallet as fee payer
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready - check RELAYER_PRIVATE_KEY');
    }

    const market = new PublicKey(params.marketPubkey);
    const buyerWallet = new PublicKey(params.buyerWallet);
    const sellerWallet = new PublicKey(params.sellerWallet);

    // Convert to instruction format
    // Price: 6 decimals (0.52 -> 520_000)
    // Size: 6 decimals for fractional contracts (1.5 contracts -> 1_500_000)
    // Fee: 6 decimals ($0.02 -> 20_000)
    const priceU64 = Math.floor(params.price * 1_000_000);
    const sizeU64 = Math.floor(params.matchSize * 1_000_000);
    const feeU64 = Math.floor(params.takerFee * 1_000_000);

    const ix = await this.buildExecuteCloseInstruction({
      marketPubkey: market,
      buyerWallet,
      sellerWallet,
      outcome: params.outcome,
      price: priceU64,
      size: sizeU64,
      takerFee: feeU64,
    });

    const signature = await this.submitTransaction([ix], [], `Close Position ${params.matchSize} shares`, {
      feePayerOverride: params.feePayerKeypair,
      skipSimulation: true, // Speed-critical: skip preflight to save 100-500ms
    });
    logger.debug(`Close executed on-chain: ${signature}`);
    
    return signature;
  }

  /**
   * Settle a user's position after market resolution
   */
  async settlePosition(params: {
    marketPubkey: string;
    userWallet: string;
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready - check RELAYER_PRIVATE_KEY');
    }

    const market = new PublicKey(params.marketPubkey);
    const userWallet = new PublicKey(params.userWallet);

    const instruction = await this.buildSettlePositionInstruction({
      marketPubkey: market,
      userWallet,
    });

    const signature = await this.submitTransaction([instruction], [], `Settle Position ${params.userWallet.slice(0, 8)}`);
    logger.debug(`Position settled on-chain: ${signature}`);

    return signature;
  }

  /**
   * Batch settle multiple positions in ONE or MORE transactions
   * Handles chunking to stay within Solana transaction size limits
   */
  async settlePositionsBatch(params: {
    marketPubkey: string;
    userWallets: string[];
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready - check RELAYER_PRIVATE_KEY');
    }

    if (params.userWallets.length === 0) {
      throw new Error('No user wallets provided for batch settlement');
    }

    const market = new PublicKey(params.marketPubkey);
    
    // Solana tx size limit is 1232 bytes.
    // Each settle_position instruction has 6 accounts + discriminator + overhead.
    // We can safely fit about 5 instructions per transaction.
    const CHUNK_SIZE = 5;
    const signatures: string[] = [];

    for (let i = 0; i < params.userWallets.length; i += CHUNK_SIZE) {
      const chunk = params.userWallets.slice(i, i + CHUNK_SIZE);
      
      // Build instructions for this chunk
      const instructions = await Promise.all(
        chunk.map(wallet => 
          this.buildSettlePositionInstruction({
            marketPubkey: market,
            userWallet: new PublicKey(wallet),
          })
        )
      );

      logger.info(`Sending batch settlement chunk (${chunk.length} positions)`);
      const signature = await this.submitTransaction(
        instructions, 
        [], 
        `Batch Settle ${chunk.length} positions (Market ${params.marketPubkey.slice(0, 8)})`
      );
      signatures.push(signature);
      logger.debug(`Chunk settlement successful: ${signature}`);
    }

    // Return the last signature or a joined string
    return signatures[signatures.length - 1];
  }

  /**
   * Resolve a market on-chain after expiry
   * The relayer determines the outcome from real price feeds (Binance/Coinbase)
   * and passes it to the on-chain instruction.
   * 
   * @param params.marketPubkey - The market PDA address
   * @param params.outcome - 'YES' or 'NO' determined by relayer
   * @param params.finalPrice - Final price at resolution (will be stored on-chain)
   */
  async resolveMarket(params: {
    marketPubkey: string;
    outcome: 'YES' | 'NO';
    finalPrice: number;
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready - check RELAYER_PRIVATE_KEY');
    }

    const market = new PublicKey(params.marketPubkey);
    
    // Build instruction data: discriminator + ResolveMarketArgs
    const discriminator = computeDiscriminator('resolve_market');
    
    // ResolveMarketArgs: outcome (u8) + final_price (u64)
    const argsBuffer = Buffer.alloc(9);
    argsBuffer.writeUInt8(params.outcome === 'YES' ? 0 : 1, 0);  // outcome: 0=Yes, 1=No
    // Final price with 8 decimals (matching on-chain strike price format)
    const finalPriceU64 = BigInt(Math.floor(params.finalPrice * 100_000_000));
    argsBuffer.writeBigUInt64LE(finalPriceU64, 1);
    
    const data = Buffer.concat([discriminator, argsBuffer]);

    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair!.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    });

    const signature = await this.submitTransaction([instruction], [], `Resolve Market ${params.marketPubkey.slice(0, 8)} (${params.outcome})`);
    logger.info(`Market resolved on-chain: ${signature} (outcome=${params.outcome}, price=${params.finalPrice})`);

    return signature;
  }

  /**
   * Build initialize_market instruction
   */
  async buildInitializeMarketInstruction(params: {
    asset: string;
    timeframe: string;
    strikePrice: number;
    expiryTs: number;
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const globalState = getGlobalStatePda();
    const market = getMarketPda(params.asset, params.timeframe, params.expiryTs);
    const vault = await getAssociatedTokenAddress(USDC_MINT, market, true);

    const discriminator = computeDiscriminator('initialize_market');
    
    const assetBytes = Buffer.from(params.asset);
    const assetLenBuffer = Buffer.alloc(4);
    assetLenBuffer.writeUInt32LE(assetBytes.length, 0);
    
    const timeframeBytes = Buffer.from(params.timeframe);
    const timeframeLenBuffer = Buffer.alloc(4);
    timeframeLenBuffer.writeUInt32LE(timeframeBytes.length, 0);
    
    const strikePriceU64 = BigInt(Math.floor(params.strikePrice * 100_000_000));
    const strikePriceBuffer = Buffer.alloc(8);
    strikePriceBuffer.writeBigUInt64LE(strikePriceU64, 0);
    
    const expiryTsBuffer = Buffer.alloc(8);
    expiryTsBuffer.writeBigInt64LE(BigInt(params.expiryTs), 0);

    const data = Buffer.concat([
      discriminator,
      assetLenBuffer,
      assetBytes,
      timeframeLenBuffer,
      timeframeBytes,
      strikePriceBuffer,
      expiryTsBuffer,
    ]);

    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: globalState, isSigner: false, isWritable: true },
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: USDC_MINT, isSigner: false, isWritable: false },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Initialize a market on-chain
   * If strikePrice = 0, market is created with PENDING status
   * If strikePrice > 0, market is created with OPEN status
   */
  async initializeMarket(params: {
    asset: string;
    timeframe: string;
    strikePrice: number;
    expiryTs: number;  // Unix timestamp in seconds
  }): Promise<string> {
    const market = getMarketPda(params.asset, params.timeframe, params.expiryTs);
    const instruction = await this.buildInitializeMarketInstruction(params);
    const status = params.strikePrice > 0 ? 'OPEN' : 'PENDING';
    const signature = await this.submitTransaction([instruction], [], `Init Market ${params.asset}-${params.timeframe} (${status}) (${market.toBase58().slice(0, 8)})`);
    
    logger.info(`Market initialized on-chain: ${market.toBase58()} (status=${status}, tx: ${signature})`);
    
    return signature;
  }

  /**
   * Build activate_market instruction
   * Sets the strike price and changes status from PENDING to OPEN
   */
  async buildActivateMarketInstruction(params: {
    marketPubkey: string;
    strikePrice: number;  // Strike price in dollars (e.g., 95432.50)
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const market = new PublicKey(params.marketPubkey);
    const discriminator = computeDiscriminator('activate_market');
    
    // Strike price with 8 decimals (matching on-chain format)
    const strikePriceU64 = BigInt(Math.floor(params.strikePrice * 100_000_000));
    const strikePriceBuffer = Buffer.alloc(8);
    strikePriceBuffer.writeBigUInt64LE(strikePriceU64, 0);

    const data = Buffer.concat([discriminator, strikePriceBuffer]);

    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
      ],
      data,
    });
  }

  /**
   * Activate a pending market on-chain
   * Sets the strike price and changes status from PENDING to OPEN
   */
  async activateMarket(params: {
    marketPubkey: string;
    strikePrice: number;  // Strike price in dollars (e.g., 95432.50)
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready - check RELAYER_PRIVATE_KEY');
    }

    const instruction = await this.buildActivateMarketInstruction(params);
    const signature = await this.submitTransaction([instruction], [], `Activate Market ${params.marketPubkey.slice(0, 8)} (strike=${params.strikePrice})`);
    
    logger.info(`Market activated on-chain: ${params.marketPubkey} (strike=${params.strikePrice}, tx: ${signature})`);
    
    return signature;
  }

  /**
   * Build close_market instruction
   */
  async buildCloseMarketInstruction(params: {
    marketPubkey: string;
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const market = new PublicKey(params.marketPubkey);
    const vault = await getAssociatedTokenAddress(USDC_MINT, market, true);
    const relayerUsdc = await getAssociatedTokenAddress(USDC_MINT, this.relayerKeypair.publicKey);
    const discriminator = computeDiscriminator('close_market');

    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: relayerUsdc, isSigner: false, isWritable: true }, // Added relayer_usdc
        { pubkey: this.relayerKeypair!.publicKey, isSigner: true, isWritable: false },
        { pubkey: this.relayerKeypair!.publicKey, isSigner: false, isWritable: true }, // rent_recipient
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: discriminator,
    });
  }

  /**
   * Build cancel_order_by_relayer instruction (force-cancel user orders after market close)
   */
  async buildCancelOrderByRelayerInstruction(params: {
    marketPubkey: string;
    ownerPubkey: string;
    clientOrderId: number;
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const market = new PublicKey(params.marketPubkey);
    const owner = new PublicKey(params.ownerPubkey);

    // Market vault is the USDC ATA owned by the market PDA
    const vault = await getAssociatedTokenAddress(USDC_MINT, market, true);
    const userUsdc = await getAssociatedTokenAddress(USDC_MINT, owner);
    const orderPda = getOrderPda(market, owner, params.clientOrderId);

    const discriminator = computeDiscriminator('cancel_order_by_relayer');

    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: false }, // market
        { pubkey: vault, isSigner: false, isWritable: true }, // vault
        { pubkey: userUsdc, isSigner: false, isWritable: true }, // user_usdc
        { pubkey: orderPda, isSigner: false, isWritable: true }, // order (close = owner)
        { pubkey: owner, isSigner: false, isWritable: true }, // owner (rent recipient)
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: false }, // authority
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
      ],
      data: discriminator,
    });
  }

  /**
   * Force-cancel a batch of user orders after market close to recover user rent + refund escrow.
   * Retries individually if a batch fails.
   */
  async cancelOrdersByRelayer(params: {
    marketPubkey: string;
    orders: Array<{ ownerPubkey: string; clientOrderId: number }>;
    batchSize?: number;
  }): Promise<void> {
    const batchSize = params.batchSize ?? 3;
    if (params.orders.length === 0) return;

    for (let i = 0; i < params.orders.length; i += batchSize) {
      const batch = params.orders.slice(i, i + batchSize);
      try {
        const instructions = await Promise.all(
          batch.map((o) =>
            this.buildCancelOrderByRelayerInstruction({
              marketPubkey: params.marketPubkey,
              ownerPubkey: o.ownerPubkey,
              clientOrderId: o.clientOrderId,
            })
          )
        );
        const sig = await this.submitTransaction(instructions, [], `Force-cancel ${batch.length} orders`);
        logger.info(`✅ Force-cancelled ${batch.length} orders on-chain: ${sig}`);
      } catch (err: any) {
        const msg = err?.message || String(err);
        logger.warn(`Batch force-cancel failed (${batch.length} orders), retrying individually: ${msg}`);
        for (const o of batch) {
          try {
            const ix = await this.buildCancelOrderByRelayerInstruction({
              marketPubkey: params.marketPubkey,
              ownerPubkey: o.ownerPubkey,
              clientOrderId: o.clientOrderId,
            });
            const sig = await this.submitTransaction([ix], [], `Force-cancel 1 order`);
            logger.info(`✅ Force-cancelled order on-chain (clientOrderId=${o.clientOrderId}): ${sig}`);
          } catch (inner: any) {
            const innerMsg = inner?.message || String(inner);
            // Common cases: already closed, never existed, wrong network
            if (
              innerMsg.includes('AccountNotFound') ||
              innerMsg.includes('AccountNotInitialized') ||
              innerMsg.includes('0xbc4')
            ) {
              logger.debug(`Order PDA missing for clientOrderId=${o.clientOrderId}; skipping`);
            } else {
              logger.error(`Force-cancel failed for clientOrderId=${o.clientOrderId}: ${innerMsg}`);
            }
          }
        }
      }
    }
  }

  /**
   * Close a fully settled market and recover rent
   * Returns ~0.0039 SOL to the relayer wallet
   */
  async closeMarket(params: {
    marketPubkey: string;
  }): Promise<string> {
    const pre = await this.ensureRelayerUsdcAtaIxs();
    const instruction = await this.buildCloseMarketInstruction(params);
    const signature = await this.submitTransaction([...pre, instruction], [], `Close Market ${params.marketPubkey.slice(0, 8)}`);
    logger.info(`Market closed on-chain: ${params.marketPubkey} (tx: ${signature})`);
    
    return signature;
  }

  /**
   * Get user's USDC balance
   */
  async getUsdcBalance(wallet: string): Promise<number> {
    try {
      const walletPubkey = new PublicKey(wallet);
      const ata = await getAssociatedTokenAddress(USDC_MINT, walletPubkey);
      const balance = await this.connection.getTokenAccountBalance(ata);
      return parseFloat(balance.value.uiAmountString || '0');
    } catch (err) {
      return 0;
    }
  }

  /**
   * Get SPL token delegation info for a wallet
   */
  async getDelegationInfo(wallet: string, delegate: string): Promise<{
    delegate: string | null;
    delegatedAmount: number;
    balance: number;
  }> {
    try {
      const walletPubkey = new PublicKey(wallet);
      const ata = await getAssociatedTokenAddress(USDC_MINT, walletPubkey);
      const account = await getAccount(this.connection, ata);

      return {
        delegate: account.delegate ? account.delegate.toBase58() : null,
        delegatedAmount: Number(account.delegatedAmount),
        balance: Number(account.amount),
      };
    } catch (err) {
      return { delegate: null, delegatedAmount: 0, balance: 0 };
    }
  }

  /**
   * Get MM keypair for signing (used by MM bot)
   */
  getMmKeypair(): Keypair | null {
    return this.mmKeypair;
  }

  /**
   * Get relayer keypair (for internal use)
   */
  getRelayerKeypair(): Keypair | null {
    return this.relayerKeypair;
  }

  // ============================================================================
  // V2 INSTRUCTIONS (Tokenized Shares Model)
  // ============================================================================

  /**
   * Build initialize_market_v2 instruction
   * Creates a V2 market with YES/NO token mints
   */
  /**
   * Build initialize_market_v2 instruction (Phase 1)
   * Creates MarketV2 account and YES mint only
   */
  async buildInitializeMarketV2Instruction(params: {
    asset: string;
    timeframe: string;
    strikePrice: number;
    expiryTs: number;
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const market = getMarketV2Pda(params.asset, params.timeframe, params.expiryTs);
    const yesMint = getYesMintPda(market);

    const discriminator = computeDiscriminator('initialize_market_v2');

    const assetBytes = Buffer.from(params.asset);
    const assetLenBuffer = Buffer.alloc(4);
    assetLenBuffer.writeUInt32LE(assetBytes.length, 0);

    const timeframeBytes = Buffer.from(params.timeframe);
    const timeframeLenBuffer = Buffer.alloc(4);
    timeframeLenBuffer.writeUInt32LE(timeframeBytes.length, 0);

    const strikePriceU64 = BigInt(Math.floor(params.strikePrice * 100_000_000));
    const strikePriceBuffer = Buffer.alloc(8);
    strikePriceBuffer.writeBigUInt64LE(strikePriceU64, 0);

    const expiryTsBuffer = Buffer.alloc(8);
    expiryTsBuffer.writeBigInt64LE(BigInt(params.expiryTs), 0);

    const data = Buffer.concat([
      discriminator,
      assetLenBuffer,
      assetBytes,
      timeframeLenBuffer,
      timeframeBytes,
      strikePriceBuffer,
      expiryTsBuffer,
    ]);

    logger.info(`initialize_market_v2 (phase 1): market=${market.toBase58()}, yesMint=${yesMint.toBase58()} (Token-2022)`);

    // Phase 1: market + yes_mint + authority + token_program + share_token_program + system_program
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: yesMint, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },  // share_token_program (Token-2022)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Build initialize_market_v2_finalize instruction (Phase 2)
   * Creates NO mint and USDC vault
   */
  async buildInitializeMarketV2FinalizeInstruction(params: {
    marketPubkey: PublicKey;
    strikePrice: number;
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const noMint = getNoMintPda(params.marketPubkey);
    // Use PDA vault instead of ATA to avoid "Provided owner is not allowed" error with PDAs
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), params.marketPubkey.toBuffer()],
      PROGRAM_ID
    );

    const discriminator = computeDiscriminator('initialize_market_v2_finalize');

    const strikePriceU64 = BigInt(Math.floor(params.strikePrice * 100_000_000));
    const strikePriceBuffer = Buffer.alloc(8);
    strikePriceBuffer.writeBigUInt64LE(strikePriceU64, 0);

    const data = Buffer.concat([discriminator, strikePriceBuffer]);

    logger.info(`initialize_market_v2_finalize (phase 2): market=${params.marketPubkey.toBase58()}, noMint=${noMint.toBase58()} (Token-2022)`);

    // Phase 2: market + no_mint + usdc_mint + vault + authority + programs
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: params.marketPubkey, isSigner: false, isWritable: true },
        { pubkey: noMint, isSigner: false, isWritable: true },
        { pubkey: USDC_MINT, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },  // share_token_program (Token-2022)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Initialize a V2 market on-chain with YES/NO token mints
   * Uses two-phase initialization to avoid stack overflow:
   * - Phase 1: Create market + YES mint
   * - Phase 2: Create NO mint + vault (with retries to ensure completion)
   */
  async initializeMarketV2(params: {
    asset: string;
    timeframe: string;
    strikePrice: number;
    expiryTs: number;
  }): Promise<{ signature: string; marketPubkey: string; yesMint: string; noMint: string }> {
    const market = getMarketV2Pda(params.asset, params.timeframe, params.expiryTs);
    const yesMint = getYesMintPda(market);
    const noMint = getNoMintPda(market);

    // Measure SOL spent on market creation (rent + tx fees)
    let balanceBefore = 0;
    try {
      balanceBefore = await this.connection.getBalance(this.relayerKeypair!.publicKey, 'confirmed');
    } catch { /* ignore */ }

    // Phase 1: Create market + YES mint (idempotent — skip if already exists)
    // Retries on transient failures (e.g. block height exceeded / expired blockhash)
    const PHASE1_MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= PHASE1_MAX_RETRIES; attempt++) {
      try {
        const ix1 = await this.buildInitializeMarketV2Instruction(params);
        const sig1 = await this.submitTransaction([ix1], [], `Init MarketV2 ${params.asset}-${params.timeframe} (phase 1)`);
        logger.info(`MarketV2 phase 1 complete: ${market.toBase58()} (tx: ${sig1})`);
        break; // Success
      } catch (err: any) {
        const msg = err.message || '';
        if (msg.includes('already in use') || msg.includes('0x0')) {
          logger.info(`MarketV2 phase 1 already exists: ${market.toBase58()} — proceeding to phase 2`);
          break;
        }
        // Retry on transient errors (expired blockhash, timeout, network issues)
        const isTransient =
          msg.includes('block height exceeded') ||
          msg.includes('Blockhash not found') ||
          msg.includes('expired') ||
          msg.includes('timeout') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('socket hang up');
        if (isTransient && attempt < PHASE1_MAX_RETRIES) {
          logger.warn(`MarketV2 phase 1 attempt ${attempt}/${PHASE1_MAX_RETRIES} failed (transient): ${msg.slice(0, 120)}`);
          // Exponential backoff: 2s, 4s — fresh blockhash on next submitTransaction call
          await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
          continue;
        }
        if (attempt === PHASE1_MAX_RETRIES) {
          logger.error(`MarketV2 phase 1 FAILED after ${PHASE1_MAX_RETRIES} attempts for ${market.toBase58()}`);
        }
        throw err; // Non-idempotent / non-transient error — Phase 1 genuinely failed
      }
    }

    // Phase 2: Create NO mint + vault (with retries — Phase 1 is already on-chain)
    const PHASE2_MAX_RETRIES = 3;
    let signature = '';
    for (let attempt = 1; attempt <= PHASE2_MAX_RETRIES; attempt++) {
      try {
        // Check if Phase 2 is already complete by checking if NO mint account exists
        // This prevents "InvalidMarketParams" errors when retrying a finalized market
        try {
          const noMintInfo = await this.connection.getAccountInfo(noMint, 'confirmed');
          // If NO mint account exists and has data, Phase 2 is already done
          if (noMintInfo && noMintInfo.data.length > 0) {
            logger.info(`MarketV2 phase 2 already completed for ${market.toBase58()} (noMint account exists)`);
            signature = 'already_initialized';
            break;
          }
        } catch (fetchErr) {
          // Ignore fetch errors — proceed to attempt Phase 2
        }

        const ix2 = await this.buildInitializeMarketV2FinalizeInstruction({
          marketPubkey: market,
          strikePrice: params.strikePrice,
        });
        signature = await this.submitTransaction([ix2], [], `Init MarketV2 ${params.asset}-${params.timeframe} (phase 2)`);
        logger.info(`MarketV2 phase 2 complete: ${market.toBase58()} (tx: ${signature})`);
        break; // Success
      } catch (err: any) {
        const msg = err.message || '';
        // If "already in use" → Phase 2 was already completed (idempotent)
        if (msg.includes('already in use') || msg.includes('0x0')) {
          logger.info(`MarketV2 phase 2 already completed for ${market.toBase58()}`);
          signature = 'already_initialized';
          break;
        }
        // Don't retry non-transient program errors (they'll never succeed)
        const isNonRecoverable =
          msg.includes('IllegalOwner') ||
          msg.includes('owner is not allowed') ||
          msg.includes('InvalidExpiry') ||
          msg.includes('InvalidAsset') ||
          msg.includes('InvalidTimeframe') ||
          msg.includes('InvalidMarketParams');
        if (isNonRecoverable) {
          logger.error(`MarketV2 phase 2 FAILED (non-recoverable) for ${market.toBase58()}: ${msg.split('\n')[0].slice(0, 150)}`);
          throw err;
        }

        logger.warn(`MarketV2 phase 2 attempt ${attempt}/${PHASE2_MAX_RETRIES} failed: ${msg.split('\n')[0].slice(0, 150)}`);
        if (attempt === PHASE2_MAX_RETRIES) {
          logger.error(`MarketV2 phase 2 FAILED after ${PHASE2_MAX_RETRIES} attempts for ${market.toBase58()} — market has NO mint missing!`);
          throw err; // Re-throw so caller knows Phase 2 failed
        }
        // Exponential backoff: 2s, 4s, 8s
        await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
      }
    }

    // Log SOL cost for market creation
    let costLog = '';
    if (balanceBefore > 0) {
      try {
        const balanceAfter = await this.connection.getBalance(this.relayerKeypair!.publicKey, 'confirmed');
        const spent = balanceBefore - balanceAfter;
        costLog = `, cost: -${(spent / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
      } catch { /* ignore */ }
    }

    const status = params.strikePrice > 0 ? 'OPEN' : 'PENDING';
    logger.info(`MarketV2 initialized: ${market.toBase58()} (status=${status}${costLog})`);
    logger.info(`  YES mint: ${yesMint.toBase58()}`);
    logger.info(`  NO mint: ${noMint.toBase58()}`);

    return {
      signature,
      marketPubkey: market.toBase58(),
      yesMint: yesMint.toBase58(),
      noMint: noMint.toBase58(),
    };
  }

  /**
   * Complete Phase 2 for a market that only has Phase 1 done.
   * Called by the market creator as a recovery step for orphaned markets.
   */
  async completeMarketV2Phase2(marketPubkey: PublicKey, strikePrice: number = 0): Promise<string> {
    logger.info(`[Recovery] Attempting Phase 2 completion for market ${marketPubkey.toBase58()}`);
    try {
      const ix2 = await this.buildInitializeMarketV2FinalizeInstruction({
        marketPubkey,
        strikePrice,
      });
      const sig = await this.submitTransaction([ix2], [], `Recovery Phase 2: ${marketPubkey.toBase58().slice(0, 8)}`);
      logger.info(`[Recovery] Phase 2 complete for ${marketPubkey.toBase58()} (tx: ${sig})`);
      return sig;
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.includes('already in use') || msg.includes('0x0')) {
        logger.info(`[Recovery] Phase 2 already done for ${marketPubkey.toBase58()}`);
        return 'already_initialized';
      }
      throw err;
    }
  }

  /**
   * Build execute_match_v2 instruction (tokenized shares)
   * Mints YES/NO tokens instead of updating Position PDAs
   */
  async buildExecuteMatchV2Instruction(params: {
    marketPubkey: PublicKey;
    yesMint: PublicKey;
    noMint: PublicKey;
    makerWallet: PublicKey;
    takerWallet: PublicKey;
    makerArgs: PlaceOrderArgs;
    takerArgs: PlaceOrderArgs;
    matchSize: number;
    takerFee: number;
    makerOrderPda?: PublicKey | null;
    takerOrderPda?: PublicKey | null;
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const globalState = getGlobalStatePda();
    const market = params.marketPubkey;
    // Vault is a PDA, NOT an ATA (created in Phase 2 with seeds ["vault", market])
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), market.toBuffer()],
      PROGRAM_ID
    );

    // Get fee recipient
    const feeRecipientWallet = config.feeRecipient
      ? new PublicKey(config.feeRecipient)
      : this.relayerKeypair.publicKey;
    const feeRecipient = await getAssociatedTokenAddress(USDC_MINT, feeRecipientWallet);

    // Get USDC ATAs
    const makerUsdc = await getAssociatedTokenAddress(USDC_MINT, params.makerWallet);
    const takerUsdc = await getAssociatedTokenAddress(USDC_MINT, params.takerWallet);

    // Get YES/NO ATAs for both parties (Token-2022 program for share tokens)
    const makerYesAta = await getAssociatedTokenAddress(params.yesMint, params.makerWallet, false, TOKEN_2022_PROGRAM_ID);
    const makerNoAta = await getAssociatedTokenAddress(params.noMint, params.makerWallet, false, TOKEN_2022_PROGRAM_ID);
    const takerYesAta = await getAssociatedTokenAddress(params.yesMint, params.takerWallet, false, TOKEN_2022_PROGRAM_ID);
    const takerNoAta = await getAssociatedTokenAddress(params.noMint, params.takerWallet, false, TOKEN_2022_PROGRAM_ID);

    // Build instruction data
    const discriminator = computeDiscriminator('execute_match_v2');
    const makerArgsBuffer = this.encodePlaceOrderArgs(params.makerArgs);
    const takerArgsBuffer = this.encodePlaceOrderArgs(params.takerArgs);
    const matchSizeBuffer = Buffer.alloc(8);
    matchSizeBuffer.writeBigUInt64LE(BigInt(params.matchSize), 0);
    const takerFeeBuffer = Buffer.alloc(8);
    takerFeeBuffer.writeBigUInt64LE(BigInt(params.takerFee), 0);

    const data = Buffer.concat([discriminator, makerArgsBuffer, takerArgsBuffer, matchSizeBuffer, takerFeeBuffer]);

    // Optional Order PDAs
    const makerOrderAccount = params.makerOrderPda || PROGRAM_ID;
    const takerOrderAccount = params.takerOrderPda || PROGRAM_ID;

    logger.info(`execute_match_v2: market=${market.toBase58()}`);
    logger.info(`execute_match_v2: maker=${params.makerWallet.toBase58()}, taker=${params.takerWallet.toBase58()}`);

    // NOTE: ATAs must be pre-created before this instruction is called
    // The instruction no longer uses init_if_needed for stack optimization
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: globalState, isSigner: false, isWritable: false },
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: params.yesMint, isSigner: false, isWritable: true },
        { pubkey: params.noMint, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        // Maker accounts
        { pubkey: params.makerWallet, isSigner: false, isWritable: false },
        { pubkey: makerUsdc, isSigner: false, isWritable: true },
        { pubkey: makerYesAta, isSigner: false, isWritable: true },
        { pubkey: makerNoAta, isSigner: false, isWritable: true },
        { pubkey: makerOrderAccount, isSigner: false, isWritable: params.makerOrderPda ? true : false },
        // Taker accounts
        { pubkey: params.takerWallet, isSigner: false, isWritable: false },
        { pubkey: takerUsdc, isSigner: false, isWritable: true },
        { pubkey: takerYesAta, isSigner: false, isWritable: true },
        { pubkey: takerNoAta, isSigner: false, isWritable: true },
        { pubkey: takerOrderAccount, isSigner: false, isWritable: params.takerOrderPda ? true : false },
        // Common accounts
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },           // USDC operations
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },      // share_token_program (Token-2022 for YES/NO mint)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Execute a V2 match on-chain (tokenized shares)
   * Mints YES tokens to YES buyer, NO tokens to NO buyer
   */
  async executeMatchV2(params: {
    marketPubkey: string;
    yesMint: string;
    noMint: string;
    makerWallet: string;
    takerWallet: string;
    makerSide: 'BID' | 'ASK';
    takerSide: 'BID' | 'ASK';
    outcome: 'YES' | 'NO';
    price: number;
    matchSize: number;
    takerFee: number;
    makerClientOrderId: number;
    takerClientOrderId: number;
    makerExpiryTs: number;
    takerExpiryTs: number;
    makerOrderPda?: string;
    takerOrderPda?: string;
    feePayerKeypair?: Keypair; // Pool child wallet as fee payer
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready - check RELAYER_PRIVATE_KEY');
    }

    const market = new PublicKey(params.marketPubkey);
    const yesMint = new PublicKey(params.yesMint);
    const noMint = new PublicKey(params.noMint);
    const makerWallet = new PublicKey(params.makerWallet);
    const takerWallet = new PublicKey(params.takerWallet);

    // Convert to 6 decimals
    const priceU64 = Math.floor(params.price * 1_000_000);
    const sizeU64 = Math.floor(params.matchSize * 1_000_000);
    const feeU64 = Math.floor(params.takerFee * 1_000_000);

    const makerArgs: PlaceOrderArgs = {
      side: params.makerSide,
      outcome: params.outcome,
      orderType: 'LIMIT',
      price: priceU64,
      size: sizeU64,
      expiryTs: params.makerExpiryTs,
      clientOrderId: params.makerClientOrderId,
    };

    const takerArgs: PlaceOrderArgs = {
      side: params.takerSide,
      outcome: params.outcome,
      orderType: 'LIMIT',
      price: priceU64,
      size: sizeU64,
      expiryTs: params.takerExpiryTs,
      clientOrderId: params.takerClientOrderId,
    };

    const makerOrderPda = params.makerOrderPda ? new PublicKey(params.makerOrderPda) : null;
    const takerOrderPda = params.takerOrderPda ? new PublicKey(params.takerOrderPda) : null;

    // Pre-create ATAs for both parties (idempotent - skips if already exists)
    // Token-2022 program for YES/NO share tokens
    const makerYesAta = await getAssociatedTokenAddress(yesMint, makerWallet, false, TOKEN_2022_PROGRAM_ID);
    const makerNoAta = await getAssociatedTokenAddress(noMint, makerWallet, false, TOKEN_2022_PROGRAM_ID);
    const takerYesAta = await getAssociatedTokenAddress(yesMint, takerWallet, false, TOKEN_2022_PROGRAM_ID);
    const takerNoAta = await getAssociatedTokenAddress(noMint, takerWallet, false, TOKEN_2022_PROGRAM_ID);

    // ATA creation payer: use fee payer override if available (child pays rent too)
    const ataPayer = params.feePayerKeypair?.publicKey || this.relayerKeypair!.publicKey;

    // Check which ATAs need to be created (avoid idempotent instruction bug with Token-2022)
    const createAtaIxs: TransactionInstruction[] = [];
    const conn = this.getConnection();

    // Helper to check if ATA exists and add creation instruction if needed
    const maybeCreateAta = async (ata: PublicKey, owner: PublicKey, mint: PublicKey) => {
      try {
        const info = await conn.getAccountInfo(ata);
        if (!info) {
          createAtaIxs.push(
            createAssociatedTokenAccountIdempotentInstruction(
              ataPayer,
              ata,
              owner,
              mint,
              TOKEN_2022_PROGRAM_ID,
              ASSOCIATED_TOKEN_PROGRAM_ID
            )
          );
        }
      } catch {
        createAtaIxs.push(
          createAssociatedTokenAccountIdempotentInstruction(
            ataPayer,
            ata,
            owner,
            mint,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }
    };

    // Check all 4 ATAs in parallel
    await Promise.all([
      maybeCreateAta(makerYesAta, makerWallet, yesMint),
      maybeCreateAta(makerNoAta, makerWallet, noMint),
      maybeCreateAta(takerYesAta, takerWallet, yesMint),
      maybeCreateAta(takerNoAta, takerWallet, noMint),
    ]);

    const matchIx = await this.buildExecuteMatchV2Instruction({
      marketPubkey: market,
      yesMint,
      noMint,
      makerWallet,
      takerWallet,
      makerArgs,
      takerArgs,
      matchSize: sizeU64,
      takerFee: feeU64,
      makerOrderPda,
      takerOrderPda,
    });

    // Combine ATA creation with match in single transaction
    const allIxs = [...createAtaIxs, matchIx];
    const signature = await this.submitTransaction(allIxs, [], `MatchV2 ${params.matchSize} shares`, {
      feePayerOverride: params.feePayerKeypair,
      skipSimulation: true, // Speed-critical: skip preflight to save 100-500ms
    });
    logger.info(`MatchV2 executed on-chain: ${signature}`);

    return signature;
  }

  /**
   * Build activate_market_v2 instruction
   */
  async buildActivateMarketV2Instruction(params: {
    marketPubkey: string;
    strikePrice: number;
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const market = new PublicKey(params.marketPubkey);
    const discriminator = computeDiscriminator('activate_market_v2');

    const strikePriceU64 = BigInt(Math.floor(params.strikePrice * 100_000_000));
    const strikePriceBuffer = Buffer.alloc(8);
    strikePriceBuffer.writeBigUInt64LE(strikePriceU64, 0);

    const data = Buffer.concat([discriminator, strikePriceBuffer]);

    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
      ],
      data,
    });
  }

  /**
   * Activate a pending V2 market
   */
  async activateMarketV2(params: {
    marketPubkey: string;
    strikePrice: number;
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready - check RELAYER_PRIVATE_KEY');
    }

    const instruction = await this.buildActivateMarketV2Instruction(params);
    const signature = await this.submitTransaction([instruction], [], `Activate MarketV2 ${params.marketPubkey.slice(0, 8)}`);

    logger.info(`MarketV2 activated on-chain: ${params.marketPubkey} (strike=${params.strikePrice}, tx: ${signature})`);

    return signature;
  }

  /**
   * Build resolve_market_v2 instruction
   */
  async buildResolveMarketV2Instruction(params: {
    marketPubkey: string;
    outcome: 'YES' | 'NO';
    finalPrice: number;
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const market = new PublicKey(params.marketPubkey);
    const discriminator = computeDiscriminator('resolve_market_v2');

    // ResolveMarketArgsV2: outcome (u8) + final_price (u64)
    const argsBuffer = Buffer.alloc(9);
    argsBuffer.writeUInt8(params.outcome === 'YES' ? 0 : 1, 0);
    const finalPriceU64 = BigInt(Math.floor(params.finalPrice * 100_000_000));
    argsBuffer.writeBigUInt64LE(finalPriceU64, 1);

    const data = Buffer.concat([discriminator, argsBuffer]);

    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Resolve a V2 market
   */
  async resolveMarketV2(params: {
    marketPubkey: string;
    outcome: 'YES' | 'NO';
    finalPrice: number;
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready - check RELAYER_PRIVATE_KEY');
    }

    const instruction = await this.buildResolveMarketV2Instruction(params);
    const signature = await this.submitTransaction(
      [instruction], [],
      `Resolve MarketV2 ${params.marketPubkey.slice(0, 8)} (${params.outcome})`,
      { priorityMicroLamports: 50000 }  // 5x priority for settlement speed
    );

    logger.info(`MarketV2 resolved on-chain: ${signature} (outcome=${params.outcome}, price=${params.finalPrice})`);

    return signature;
  }

  /**
   * Build execute_close_v2 instruction
   */
  async buildExecuteCloseV2Instruction(params: {
    marketPubkey: PublicKey;
    yesMint: PublicKey;
    noMint: PublicKey;
    buyerWallet: PublicKey;
    sellerWallet: PublicKey;
    outcome: 'YES' | 'NO';
    price: number;      // 6 decimals
    size: number;       // 6 decimals
    takerFee: number;   // 6 decimals
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const globalState = getGlobalStatePda();

    // Get fee recipient (same pattern as buildExecuteMatchV2Instruction)
    const feeRecipientWallet = config.feeRecipient
      ? new PublicKey(config.feeRecipient)
      : this.relayerKeypair.publicKey;
    const feeRecipientAta = await getAssociatedTokenAddress(USDC_MINT, feeRecipientWallet);

    // Buyer accounts (USDC: regular Token, YES/NO: Token-2022)
    const buyerUsdc = await getAssociatedTokenAddress(USDC_MINT, params.buyerWallet);
    const buyerYesAta = await getAssociatedTokenAddress(params.yesMint, params.buyerWallet, false, TOKEN_2022_PROGRAM_ID);
    const buyerNoAta = await getAssociatedTokenAddress(params.noMint, params.buyerWallet, false, TOKEN_2022_PROGRAM_ID);

    // Seller accounts (USDC: regular Token, YES/NO: Token-2022)
    const sellerUsdc = await getAssociatedTokenAddress(USDC_MINT, params.sellerWallet);
    const sellerYesAta = await getAssociatedTokenAddress(params.yesMint, params.sellerWallet, false, TOKEN_2022_PROGRAM_ID);
    const sellerNoAta = await getAssociatedTokenAddress(params.noMint, params.sellerWallet, false, TOKEN_2022_PROGRAM_ID);

    const discriminator = computeDiscriminator('execute_close_v2');

    // CloseTradeArgsV2: outcome (u8) + price (u64) + size (u64) + taker_fee (u64) = 25 bytes
    const argsBuffer = Buffer.alloc(25);
    argsBuffer.writeUInt8(params.outcome === 'YES' ? 0 : 1, 0);
    argsBuffer.writeBigUInt64LE(BigInt(params.price), 1);
    argsBuffer.writeBigUInt64LE(BigInt(params.size), 9);
    argsBuffer.writeBigUInt64LE(BigInt(params.takerFee), 17);

    const data = Buffer.concat([discriminator, argsBuffer]);

    // NOTE: Buyer ATAs must be pre-created before this instruction is called
    // The instruction no longer uses init_if_needed for stack optimization
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: globalState, isSigner: false, isWritable: false },
        { pubkey: params.marketPubkey, isSigner: false, isWritable: true },
        { pubkey: params.yesMint, isSigner: false, isWritable: false },
        { pubkey: params.noMint, isSigner: false, isWritable: false },
        { pubkey: feeRecipientAta, isSigner: false, isWritable: true },
        { pubkey: params.buyerWallet, isSigner: false, isWritable: false },
        { pubkey: buyerUsdc, isSigner: false, isWritable: true },
        { pubkey: buyerYesAta, isSigner: false, isWritable: true },
        { pubkey: buyerNoAta, isSigner: false, isWritable: true },
        { pubkey: params.sellerWallet, isSigner: false, isWritable: false },
        { pubkey: sellerUsdc, isSigner: false, isWritable: true },
        { pubkey: sellerYesAta, isSigner: false, isWritable: true },
        { pubkey: sellerNoAta, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },           // USDC operations
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },      // share_token_program (Token-2022 for YES/NO transfers)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Execute a close trade in a V2 market (tokenized shares)
   */
  async executeCloseV2(params: {
    marketPubkey: string;
    yesMint: string;
    noMint: string;
    buyerWallet: string;
    sellerWallet: string;
    outcome: 'YES' | 'NO';
    price: number;      // Price in dollars (e.g., 0.52)
    matchSize: number;  // Number of shares (e.g., 100)
    takerFee: number;   // Fee in USD (e.g., 0.02)
    feePayerKeypair?: Keypair; // Pool child wallet as fee payer
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready - check RELAYER_PRIVATE_KEY');
    }

    const market = new PublicKey(params.marketPubkey);
    const yesMint = new PublicKey(params.yesMint);
    const noMint = new PublicKey(params.noMint);
    const buyerWallet = new PublicKey(params.buyerWallet);
    const sellerWallet = new PublicKey(params.sellerWallet);

    // Convert to 6 decimals
    const priceU64 = Math.floor(params.price * 1_000_000);
    const sizeU64 = Math.floor(params.matchSize * 1_000_000);
    const feeU64 = Math.floor(params.takerFee * 1_000_000);

    // ATA creation payer: use fee payer override if available (child pays rent too)
    const ataPayer = params.feePayerKeypair?.publicKey || this.relayerKeypair!.publicKey;

    // Pre-create buyer ATAs (idempotent - skips if already exists)
    // Token-2022 program for YES/NO share tokens
    const buyerYesAta = await getAssociatedTokenAddress(yesMint, buyerWallet, false, TOKEN_2022_PROGRAM_ID);
    const buyerNoAta = await getAssociatedTokenAddress(noMint, buyerWallet, false, TOKEN_2022_PROGRAM_ID);

    const createAtaIxs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(
        ataPayer,
        buyerYesAta,
        buyerWallet,
        yesMint,
        TOKEN_2022_PROGRAM_ID  // Token-2022 for share tokens
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        ataPayer,
        buyerNoAta,
        buyerWallet,
        noMint,
        TOKEN_2022_PROGRAM_ID
      ),
    ];

    const closeIx = await this.buildExecuteCloseV2Instruction({
      marketPubkey: market,
      yesMint,
      noMint,
      buyerWallet,
      sellerWallet,
      outcome: params.outcome,
      price: priceU64,
      size: sizeU64,
      takerFee: feeU64,
    });

    // Combine ATA creation with close in single transaction
    const allIxs = [...createAtaIxs, closeIx];
    const signature = await this.submitTransaction(allIxs, [], `CloseV2 ${params.matchSize} shares`, {
      feePayerOverride: params.feePayerKeypair,
      skipSimulation: true, // Speed-critical: skip preflight to save 100-500ms
    });
    logger.info(`CloseV2 executed on-chain: ${signature}`);

    return signature;
  }

  /**
   * Build close_market_v2 instruction (for zero-trade V2 markets)
   * This closes a V2 market that has no trading activity (open_interest = 0)
   */
  async buildCloseMarketV2Instruction(params: {
    marketPubkey: string;
    yesMint: string;
    noMint: string;
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const market = new PublicKey(params.marketPubkey);
    const yesMint = new PublicKey(params.yesMint);
    const noMint = new PublicKey(params.noMint);
    // Vault is a PDA, NOT an ATA (created in Phase 2 with seeds ["vault", market])
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), market.toBuffer()],
      PROGRAM_ID
    );

    const discriminator = computeDiscriminator('close_market_v2');

    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: yesMint, isSigner: false, isWritable: true },       // writable - closed via Token-2022 MintCloseAuthority
        { pubkey: noMint, isSigner: false, isWritable: true },        // writable - closed via Token-2022 MintCloseAuthority
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: this.relayerKeypair.publicKey, isSigner: false, isWritable: true }, // rent_recipient
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },             // USDC vault close
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },        // share_token_program (Token-2022 for mint close)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: discriminator,
    });
  }

  /**
   * Close a zero-trade V2 market
   * For markets with no trades (open_interest = 0), this directly closes the market
   * without going through the merkle settlement flow.
   */
  async closeMarketV2(params: {
    marketPubkey: string;
    yesMint: string;
    noMint: string;
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready - check RELAYER_PRIVATE_KEY');
    }

    const ix = await this.buildCloseMarketV2Instruction(params);
    const signature = await this.submitTransaction([ix], [], `CloseMarketV2 ${params.marketPubkey.slice(0,8)}`);
    logger.info(`CloseMarketV2 executed: ${signature}`);

    return signature;
  }

  // =========================================================================
  // V2 Merkle Settlement Instructions
  // =========================================================================

  /**
   * Post merkle root to begin batch settlement.
   * Transitions market from RESOLVED → SETTLING on-chain.
   */
  async postMerkleRoot(params: {
    marketPubkey: string;
    merkleRoot: Uint8Array;    // 32 bytes
    totalAmount: bigint;       // USDC native units (6 decimals)
    totalSettlements: number;
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready');
    }

    const market = new PublicKey(params.marketPubkey);
    const bitmapPda = getSettlementBitmapPda(market, 0);

    const discriminator = computeDiscriminator('post_merkle_root');

    // Args: merkle_root [u8;32] + total_amount u64 + total_settlements u64
    const argsBuffer = Buffer.alloc(48);
    Buffer.from(params.merkleRoot).copy(argsBuffer, 0, 0, 32);
    argsBuffer.writeBigUInt64LE(params.totalAmount, 32);
    argsBuffer.writeBigUInt64LE(BigInt(params.totalSettlements), 40);

    const data = Buffer.concat([discriminator, argsBuffer]);

    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: bitmapPda, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair!.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const signature = await this.submitTransaction(
      [instruction], [],
      `PostMerkleRoot ${params.marketPubkey.slice(0, 8)} (${params.totalSettlements} settlements)`,
      { priorityMicroLamports: 50000 }  // 5x priority for settlement speed
    );
    logger.info(`PostMerkleRoot executed: ${signature}`);
    return signature;
  }

  /**
   * Batch settle V2 — submit up to 15 settlements with merkle proofs.
   * Recipient USDC ATAs must exist (pass createAta instructions separately).
   */
  async batchSettleV2(params: {
    marketPubkey: string;
    bitmapChunkIndex: number;
    settlements: Array<{
      recipient: string;       // pubkey base58
      amount: bigint;          // USDC native units
      index: number;           // leaf index in merkle tree
      proof: Uint8Array[];     // array of 32-byte hashes
    }>;
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready');
    }

    const market = new PublicKey(params.marketPubkey);
    // Vault is a PDA, NOT an ATA (created in Phase 2 with seeds ["vault", market])
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), market.toBuffer()],
      PROGRAM_ID
    );
    const bitmapPda = getSettlementBitmapPda(market, params.bitmapChunkIndex);

    const discriminator = computeDiscriminator('batch_settle_v2');

    // Borsh-serialize Vec<SettlementEntry>
    // u32 LE vec length, then per entry: pubkey(32) + amount(u64) + index(u64) + proof_vec(u32_len + N*32)
    const entries = params.settlements;
    const bufParts: Buffer[] = [];

    // Vec length prefix
    const vecLen = Buffer.alloc(4);
    vecLen.writeUInt32LE(entries.length, 0);
    bufParts.push(vecLen);

    for (const entry of entries) {
      // recipient pubkey (32 bytes)
      bufParts.push(Buffer.from(new PublicKey(entry.recipient).toBytes()));
      // amount u64 LE
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(entry.amount, 0);
      bufParts.push(amountBuf);
      // index u64 LE
      const indexBuf = Buffer.alloc(8);
      indexBuf.writeBigUInt64LE(BigInt(entry.index), 0);
      bufParts.push(indexBuf);
      // proof Vec<[u8;32]>: u32 length prefix + N * 32 bytes
      const proofLen = Buffer.alloc(4);
      proofLen.writeUInt32LE(entry.proof.length, 0);
      bufParts.push(proofLen);
      for (const proofElement of entry.proof) {
        bufParts.push(Buffer.from(proofElement));
      }
    }

    const argsBuffer = Buffer.concat(bufParts);
    const data = Buffer.concat([discriminator, argsBuffer]);

    // Build remaining accounts — recipient USDC ATAs in same order as settlements
    const remainingAccounts = await Promise.all(
      entries.map(async (entry) => {
        const recipientPubkey = new PublicKey(entry.recipient);
        const ata = await getAssociatedTokenAddress(USDC_MINT, recipientPubkey);
        return { pubkey: ata, isSigner: false, isWritable: true };
      }),
    );

    // Pre-create ATAs if needed (idempotent)
    const createAtaIxs: TransactionInstruction[] = [];
    for (const entry of entries) {
      const recipientPubkey = new PublicKey(entry.recipient);
      createAtaIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          this.relayerKeypair!.publicKey,
          await getAssociatedTokenAddress(USDC_MINT, recipientPubkey),
          recipientPubkey,
          USDC_MINT,
        ),
      );
    }

    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: bitmapPda, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair!.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...remainingAccounts,
      ],
      data,
    });

    const allIxs = [...createAtaIxs, instruction];
    const signature = await this.submitTransaction(
      allIxs, [],
      `BatchSettleV2 ${entries.length} entries (Market ${params.marketPubkey.slice(0, 8)})`,
      { priorityMicroLamports: 50000 }  // 5x priority for settlement speed
    );
    logger.info(`BatchSettleV2 executed: ${signature} (${entries.length} settlements)`);
    return signature;
  }

  /**
   * Compact batch settlement (V3).
   *
   * Sends N consecutive settlements with a single shared bridge proof instead
   * of N individual full proofs. 4-8x more TX-efficient for large markets.
   *
   * @param params.marketPubkey - Market public key
   * @param params.bitmapChunkIndex - Settlement bitmap chunk (0 for most markets)
   * @param params.startIndex - First leaf index (must be aligned to subtreeSize)
   * @param params.subtreeSize - Power-of-2 subtree size (e.g. 8 or 16)
   * @param params.settlements - Array of { recipient, amount } (no proofs needed)
   * @param params.bridgeProof - Shared bridge proof from subtree root to global root
   */
  async batchSettleV3(params: {
    marketPubkey: string;
    bitmapChunkIndex: number;
    startIndex: number;
    subtreeSize: number;
    settlements: Array<{
      recipient: string;   // pubkey base58
      amount: bigint;      // USDC native units
    }>;
    bridgeProof: Uint8Array[];  // array of 32-byte hashes
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready');
    }

    const market = new PublicKey(params.marketPubkey);
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), market.toBuffer()],
      PROGRAM_ID
    );
    const bitmapPda = getSettlementBitmapPda(market, params.bitmapChunkIndex);

    const discriminator = computeDiscriminator('batch_settle_v3');

    // Borsh-serialize CompactBatchSettlement:
    // start_index: u64, count: u8, amounts: Vec<u64>, bridge_proof: Vec<[u8;32]>
    const bufParts: Buffer[] = [];

    // start_index: u64 LE
    const startIndexBuf = Buffer.alloc(8);
    startIndexBuf.writeBigUInt64LE(BigInt(params.startIndex), 0);
    bufParts.push(startIndexBuf);

    // count: u8
    const countBuf = Buffer.alloc(1);
    countBuf.writeUInt8(params.settlements.length, 0);
    bufParts.push(countBuf);

    // amounts: Vec<u64> — u32 length prefix + count × u64 LE
    const amountsLenBuf = Buffer.alloc(4);
    amountsLenBuf.writeUInt32LE(params.settlements.length, 0);
    bufParts.push(amountsLenBuf);
    for (const entry of params.settlements) {
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(entry.amount, 0);
      bufParts.push(amountBuf);
    }

    // bridge_proof: Vec<[u8;32]> — u32 length prefix + N × 32 bytes
    const bridgeLenBuf = Buffer.alloc(4);
    bridgeLenBuf.writeUInt32LE(params.bridgeProof.length, 0);
    bufParts.push(bridgeLenBuf);
    for (const proofElement of params.bridgeProof) {
      bufParts.push(Buffer.from(proofElement));
    }

    const argsBuffer = Buffer.concat(bufParts);
    const data = Buffer.concat([discriminator, argsBuffer]);

    // Build remaining accounts — recipient USDC ATAs in same order as settlements
    const remainingAccounts = await Promise.all(
      params.settlements.map(async (entry) => {
        const recipientPubkey = new PublicKey(entry.recipient);
        const ata = await getAssociatedTokenAddress(USDC_MINT, recipientPubkey);
        return { pubkey: ata, isSigner: false, isWritable: true };
      }),
    );

    // Pre-create ATAs if needed (idempotent)
    const createAtaIxs: TransactionInstruction[] = [];
    for (const entry of params.settlements) {
      const recipientPubkey = new PublicKey(entry.recipient);
      createAtaIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          this.relayerKeypair!.publicKey,
          await getAssociatedTokenAddress(USDC_MINT, recipientPubkey),
          recipientPubkey,
          USDC_MINT,
        ),
      );
    }

    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: bitmapPda, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair!.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...remainingAccounts,
      ],
      data,
    });

    const allIxs = [...createAtaIxs, instruction];
    const signature = await this.submitTransaction(
      allIxs, [],
      `BatchSettleV3 ${params.settlements.length} entries (Market ${params.marketPubkey.slice(0, 8)})`,
      { priorityMicroLamports: 50000 }  // 5x priority for settlement speed
    );
    logger.info(`BatchSettleV3 executed: ${signature} (${params.settlements.length} settlements, subtree=${params.subtreeSize})`);
    return signature;
  }

  /**
   * Burn remaining share tokens from user ATAs using PermanentDelegate.
   * Called after batch_settle_v2 completes and before finalize_market_v2.
   * Burns all YES/NO tokens from the passed user ATAs, bringing mint supply to 0
   * so mints can be closed during finalize to recover rent.
   */
  async burnRemainingSharesV2(params: {
    marketPubkey: string;
    yesMint: string;
    noMint: string;
    userShareAtas: string[]; // pubkeys of user YES/NO ATAs with tokens to burn
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready');
    }

    const market = new PublicKey(params.marketPubkey);
    const yesMint = new PublicKey(params.yesMint);
    const noMint = new PublicKey(params.noMint);

    const discriminator = computeDiscriminator('burn_remaining_shares_v2');

    // Fixed accounts
    const keys = [
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: yesMint, isSigner: false, isWritable: true },
      { pubkey: noMint, isSigner: false, isWritable: true },
      { pubkey: this.relayerKeypair!.publicKey, isSigner: true, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // share_token_program
    ];

    // Remaining accounts: user share ATAs
    for (const ata of params.userShareAtas) {
      keys.push({ pubkey: new PublicKey(ata), isSigner: false, isWritable: true });
    }

    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys,
      data: discriminator,
    });

    const signature = await this.submitTransaction(
      [instruction], [],
      `BurnRemainingSharesV2 ${params.userShareAtas.length} ATAs (Market ${params.marketPubkey.slice(0, 8)})`,
      { priorityMicroLamports: 50000 }  // 5x priority for settlement speed
    );
    logger.info(`BurnRemainingSharesV2 executed: ${signature} (${params.userShareAtas.length} ATAs burned)`);
    return signature;
  }

  /**
   * Finalize a V2 market after all merkle settlements are complete.
   * Closes vault, recovers rent, transitions to SETTLED.
   */
  async finalizeMarketV2(params: {
    marketPubkey: string;
    yesMint: string;
    noMint: string;
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready');
    }

    const market = new PublicKey(params.marketPubkey);
    const yesMint = new PublicKey(params.yesMint);
    const noMint = new PublicKey(params.noMint);
    // Vault is a PDA, NOT an ATA (created in Phase 2 with seeds ["vault", market])
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), market.toBuffer()],
      PROGRAM_ID
    );

    const discriminator = computeDiscriminator('finalize_market_v2');

    // Authority's USDC ATA to receive vault dust
    const authorityAta = await getAssociatedTokenAddress(USDC_MINT, this.relayerKeypair!.publicKey);

    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: yesMint, isSigner: false, isWritable: true },       // closed via Token-2022 MintCloseAuthority
        { pubkey: noMint, isSigner: false, isWritable: true },        // closed via Token-2022 MintCloseAuthority
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair!.publicKey, isSigner: true, isWritable: true },
        { pubkey: authorityAta, isSigner: false, isWritable: true }, // authority_ata for dust
        { pubkey: this.relayerKeypair!.publicKey, isSigner: false, isWritable: true }, // rent_recipient
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },             // USDC vault operations
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },        // share_token_program (Token-2022 for mint close)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: discriminator,
    });

    const signature = await this.submitTransaction(
      [instruction], [],
      `FinalizeMarketV2 ${params.marketPubkey.slice(0, 8)}`,
      { priorityMicroLamports: 50000 }  // 5x priority for settlement speed
    );
    logger.info(`FinalizeMarketV2 executed: ${signature}`);
    return signature;
  }

  /**
   * Atomically resolve a V2 market AND post the merkle root in one TX.
   * Saves ~2s by eliminating one full TX round-trip between resolve and postMerkleRoot.
   * Market transitions directly from Open/Closed → Settling.
   */
  async resolveAndPostMerkleRootV2(params: {
    marketPubkey: string;
    outcome: 'YES' | 'NO';
    finalPrice: number;
    merkleRoot: Uint8Array;    // 32 bytes
    totalAmount: bigint;       // USDC native units (6 decimals)
    totalSettlements: number;
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready');
    }

    const market = new PublicKey(params.marketPubkey);
    const bitmapPda = getSettlementBitmapPda(market, 0);

    const discriminator = computeDiscriminator('resolve_and_post_merkle_root_v2');

    // Args: outcome (u8) + final_price (u64) + merkle_root [u8;32] + total_amount (u64) + total_settlements (u64)
    // Total: 1 + 8 + 32 + 8 + 8 = 57 bytes
    const argsBuffer = Buffer.alloc(57);
    argsBuffer.writeUInt8(params.outcome === 'YES' ? 0 : 1, 0);
    const finalPriceU64 = BigInt(Math.floor(params.finalPrice * 100_000_000));
    argsBuffer.writeBigUInt64LE(finalPriceU64, 1);
    Buffer.from(params.merkleRoot).copy(argsBuffer, 9, 0, 32);
    argsBuffer.writeBigUInt64LE(params.totalAmount, 41);
    argsBuffer.writeBigUInt64LE(BigInt(params.totalSettlements), 49);

    const data = Buffer.concat([discriminator, argsBuffer]);

    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: bitmapPda, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair!.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const signature = await this.submitTransaction(
      [instruction], [],
      `ResolveAndPostMerkleRoot ${params.marketPubkey.slice(0, 8)} (${params.outcome}, ${params.totalSettlements} settlements)`,
      { priorityMicroLamports: 50000 }  // 5x priority for settlement speed
    );
    logger.info(`ResolveAndPostMerkleRootV2 executed: ${signature} (outcome=${params.outcome}, settlements=${params.totalSettlements})`);
    return signature;
  }
}

// Singleton instance
export const anchorClient = new AnchorClient();
