import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
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
    logger.info(`âœ… Loaded IDL from: ${idlPath}`);
  } else {
    logger.warn(`âŒ IDL file not found at: ${idlPath}`);
  }
} catch (err) {
  logger.warn('âŒ Could not load IDL:', err);
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

export function getSessionAuthorityPda(wallet: PublicKey, sessionSigner: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('session_authority'), wallet.toBuffer(), sessionSigner.toBuffer()],
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

// Byte offset of `status` field inside a MarketV2 account (after 8-byte discriminator).
// New layout adds `usdc_mint` + `vault` (64 bytes) before the asset bytes.
const MARKET_V2_STRIKE_PRICE_OFFSET = 132;
const MARKET_V2_STATUS_OFFSET = 180;
// open_interest offset: status(1) + outcome(1) + volume(8) + trades(4) + yes_mint(32) + no_mint(32) = +78 from status
const MARKET_V2_OPEN_INTEREST_OFFSET = MARKET_V2_STATUS_OFFSET + 1 + 1 + 8 + 4 + 32 + 32; // 258

export interface MarketV2ChainState {
  status: string;       // Mapped DB status string
  statusRaw: number;    // Raw on-chain enum value
  strikePriceRaw: bigint;
  strikePrice: number;
  openInterest: bigint; // Raw open_interest (USDC lamports)
  // Merkle settlement state (populated when has_merkle_root=true)
  hasMerkleRoot: boolean;
  settlementMerkleRoot: Uint8Array;        // 32 bytes, zero-filled if !hasMerkleRoot
  totalSettlementAmount: bigint;
  settlementAmountPaid: bigint;
  settlementsProcessed: bigint;
  settlementsTotal: bigint;
}

// Offsets for the merkle settlement block, counted forward from open_interest.
// open_interest (8) + settlement_merkle_root (32) + has_merkle_root (1) ...
const MARKET_V2_MERKLE_ROOT_OFFSET = MARKET_V2_OPEN_INTEREST_OFFSET + 8;                      // 266
const MARKET_V2_HAS_MERKLE_ROOT_OFFSET = MARKET_V2_MERKLE_ROOT_OFFSET + 32;                   // 298
const MARKET_V2_TOTAL_SETTLEMENT_AMOUNT_OFFSET = MARKET_V2_HAS_MERKLE_ROOT_OFFSET + 1;        // 299
const MARKET_V2_SETTLEMENT_AMOUNT_PAID_OFFSET = MARKET_V2_TOTAL_SETTLEMENT_AMOUNT_OFFSET + 8; // 307
const MARKET_V2_SETTLEMENTS_PROCESSED_OFFSET = MARKET_V2_SETTLEMENT_AMOUNT_PAID_OFFSET + 8;   // 315
const MARKET_V2_SETTLEMENTS_TOTAL_OFFSET = MARKET_V2_SETTLEMENTS_PROCESSED_OFFSET + 8;        // 323
const MARKET_V2_MERKLE_BLOCK_END = MARKET_V2_SETTLEMENTS_TOTAL_OFFSET + 8;                    // 331

/**
 * Read the on-chain status, open_interest, and merkle settlement state of a
 * MarketV2 account. Returns null if the account does not exist (already
 * finalized/closed).
 */
export async function fetchMarketV2OnChainState(
  connection: Connection,
  marketPubkey: PublicKey,
): Promise<MarketV2ChainState | null> {
  const info = await connection.getAccountInfo(marketPubkey);
  if (!info || !info.data || info.data.length < MARKET_V2_OPEN_INTEREST_OFFSET + 8) {
    return null;
  }

  const strikePriceRaw = info.data.readBigUInt64LE(MARKET_V2_STRIKE_PRICE_OFFSET);
  const statusRaw = info.data[MARKET_V2_STATUS_OFFSET];
  const status = CHAIN_STATUS_MAP[statusRaw] ?? 'OPEN';
  const openInterest = info.data.readBigUInt64LE(MARKET_V2_OPEN_INTEREST_OFFSET);

  let hasMerkleRoot = false;
  let settlementMerkleRoot = new Uint8Array(32);
  let totalSettlementAmount = 0n;
  let settlementAmountPaid = 0n;
  let settlementsProcessed = 0n;
  let settlementsTotal = 0n;

  if (info.data.length >= MARKET_V2_MERKLE_BLOCK_END) {
    settlementMerkleRoot = new Uint8Array(
      info.data.slice(MARKET_V2_MERKLE_ROOT_OFFSET, MARKET_V2_MERKLE_ROOT_OFFSET + 32)
    );
    hasMerkleRoot = info.data[MARKET_V2_HAS_MERKLE_ROOT_OFFSET] !== 0;
    totalSettlementAmount = info.data.readBigUInt64LE(MARKET_V2_TOTAL_SETTLEMENT_AMOUNT_OFFSET);
    settlementAmountPaid = info.data.readBigUInt64LE(MARKET_V2_SETTLEMENT_AMOUNT_PAID_OFFSET);
    settlementsProcessed = info.data.readBigUInt64LE(MARKET_V2_SETTLEMENTS_PROCESSED_OFFSET);
    settlementsTotal = info.data.readBigUInt64LE(MARKET_V2_SETTLEMENTS_TOTAL_OFFSET);
  }

  return {
    status,
    statusRaw,
    strikePriceRaw,
    strikePrice: Number(strikePriceRaw) / 100_000_000,
    openInterest,
    hasMerkleRoot,
    settlementMerkleRoot,
    totalSettlementAmount,
    settlementAmountPaid,
    settlementsProcessed,
    settlementsTotal,
  };
}

/**
 * Fetch the settlement_bitmap account for a market+chunk and return the set of
 * leaf indices that have already been claimed. One bitmap account covers 8192
 * leaves (1024 bytes × 8 bits). For markets with more than 8192 leaves, call
 * this once per chunk and union the results.
 *
 * Returns an empty set if the bitmap PDA doesn't exist yet (chunk not
 * initialized, or no batches have run).
 *
 * SettlementBitmap layout (from state_v2.rs):
 *   8 (discriminator) + 32 (market) + 2 (chunk_index) + 1024 (bitmap) + 1 (bump)
 */
export async function fetchSettlementBitmap(
  connection: Connection,
  marketPubkey: PublicKey,
  chunkIndex: number,
): Promise<Set<number>> {
  const pda = getSettlementBitmapPda(marketPubkey, chunkIndex);
  const info = await connection.getAccountInfo(pda);
  const claimed = new Set<number>();
  if (!info || !info.data) return claimed;

  const BITMAP_OFFSET = 8 + 32 + 2;
  const BITMAP_BYTES = 1024;
  if (info.data.length < BITMAP_OFFSET + BITMAP_BYTES) return claimed;

  const base = chunkIndex * 8192;
  for (let byte = 0; byte < BITMAP_BYTES; byte++) {
    const b = info.data[BITMAP_OFFSET + byte];
    if (b === 0) continue;
    for (let bit = 0; bit < 8; bit++) {
      if (b & (1 << bit)) {
        claimed.add(base + byte * 8 + bit);
      }
    }
  }
  return claimed;
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

  // â”€â”€ RPC Connection Pool â”€â”€
  // Round-robins TX submission across multiple RPC endpoints for higher throughput.
  // Each endpoint has its own rate limit (~50 RPC/s on Helius Dev), so 3 endpoints = ~150 RPC/s.
  private execConnectionPool: Connection[] = [];
  private execPoolIndex = 0;

  // â”€â”€ Blockhash cache (saves 1 RPC call per TX) â”€â”€
  private cachedBlockhash: { blockhash: string; lastValidBlockHeight: number; fetchedAt: number } | null = null;
  private blockhashInflight: Promise<{ blockhash: string; lastValidBlockHeight: number }> | null = null;
  private readonly BLOCKHASH_CACHE_TTL_MS = 5000; // Reuse blockhash for 5s (valid for ~60-90s, saves RPC calls under sustained load)

  // â”€â”€ ATA existence cache (saves 4 RPC calls per match once warm) â”€â”€
  // Once an ATA exists on-chain it cannot be uncreated, so a positive result
  // is effectively permanent. We cap the set at ~50k entries to bound memory
  // (that's ~1.7MB of pubkey strings, plenty for an active trading session).
  private readonly knownAtas = new Set<string>();
  private readonly KNOWN_ATA_CAP = 50_000;

  private markAtaExists(ata: PublicKey): void {
    if (this.knownAtas.size >= this.KNOWN_ATA_CAP) return; // stop growing; existing entries stay valid
    this.knownAtas.add(ata.toBase58());
  }

  private ataIsKnown(ata: PublicKey): boolean {
    return this.knownAtas.has(ata.toBase58());
  }

  // â”€â”€ Helius Sender (15 tx/sec via Jito dual-routing) â”€â”€
  private readonly heliusSenderUrl: string;
  private readonly jitoTipLamports: number;
  // Official Jito tip accounts (mainnet-beta) â€” full list from Helius docs
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

  /**
   * Derive a WebSocket URL for Solana confirmation subscriptions from an HTTP
   * RPC URL. Helius exposes WS at the same host with wss:// scheme, which also
   * matches Triton, QuickNode, and the public solana.com endpoints. Returns
   * undefined if the URL can't be safely converted (e.g. custom proxies).
   */
  private deriveWsUrl(httpUrl: string): string | undefined {
    if (!httpUrl) return undefined;
    if (httpUrl.startsWith('https://')) return 'wss://' + httpUrl.slice('https://'.length);
    if (httpUrl.startsWith('http://')) return 'ws://' + httpUrl.slice('http://'.length);
    return undefined;
  }

  /**
   * Resolve the WS endpoint to attach to a given Connection. Prefers the
   * explicit SOLANA_WS_URL override; otherwise auto-derives from the HTTP URL.
   * Having a WS endpoint makes confirmTransaction use a single signatureSubscribe
   * stream instead of polling getSignatureStatuses — the single biggest driver
   * of per-method rate-limit 429s at modest order rates.
   */
  private resolveWsEndpoint(httpUrl: string): string | undefined {
    if (config.solanaWsUrl) return config.solanaWsUrl;
    return this.deriveWsUrl(httpUrl);
  }

  constructor() {
    const mainWs = this.resolveWsEndpoint(config.solanaRpcUrl);
    this.connection = new Connection(
      config.solanaRpcUrl,
      { commitment: 'confirmed', wsEndpoint: mainWs }
    );

    // Build execution connection pool from all available RPC URLs
    const execUrl = config.solanaExecutionRpcUrl || config.solanaRpcUrl;
    const execWs = this.resolveWsEndpoint(execUrl);
    this.executionConnection = new Connection(execUrl, { commitment: 'confirmed', wsEndpoint: execWs });
    this.execConnectionPool.push(this.executionConnection);

    // Add additional RPC endpoints to the pool
    const additionalUrls = [config.solanaRpcUrl2, config.solanaRpcUrl3].filter(u => u);
    for (const url of additionalUrls) {
      this.execConnectionPool.push(new Connection(url, { commitment: 'confirmed', wsEndpoint: this.resolveWsEndpoint(url) }));
    }

    if (this.execConnectionPool.length > 1) {
      logger.info(`ðŸ”— RPC connection pool: ${this.execConnectionPool.length} endpoints (${this.execConnectionPool.length * 50} est. RPC/s)`);
    } else if (config.solanaExecutionRpcUrl) {
      logger.info(`ðŸ”— Separate execution RPC configured: ${execUrl.slice(0, 50)}...`);
    }

    if (execWs) {
      logger.info(`ðŸ”Œ WS confirmation endpoint: ${execWs.slice(0, 50)}... (signatureSubscribe via onSignature)`);
    } else {
      logger.warn(`âš ï¸  No WS endpoint configured — confirmViaWs will time out every TX; set SOLANA_WS_URL or use an https:// RPC URL`);
    }

    // Helius Sender setup (mainnet ONLY: 15 tx/sec via Jito dual-routing)
    // Sender requires Jito which doesn't exist on devnet â€” auto-disable for devnet
    const isDevnet = config.solanaRpcUrl.includes('devnet');
    if (config.heliusSenderUrl && isDevnet) {
      logger.warn(`âš ï¸  Helius Sender disabled: Jito (required by Sender) is not available on devnet`);
      this.heliusSenderUrl = '';
    } else {
      this.heliusSenderUrl = config.heliusSenderUrl;
    }
    this.jitoTipLamports = Math.floor(config.jitoTipSol * LAMPORTS_PER_SOL);
    if (this.heliusSenderUrl) {
      logger.info(`ðŸš€ Helius Sender enabled: ${this.heliusSenderUrl} (tip: ${config.jitoTipSol} SOL/tx)`);
    }

    // Load relayer keypair
    if (config.relayerPrivateKey) {
      try {
        const secretKey = bs58.decode(config.relayerPrivateKey);
        this.relayerKeypair = Keypair.fromSecretKey(secretKey);
        logger.info(`âœ… Relayer wallet loaded: ${this.relayerKeypair.publicKey.toBase58()}`);
      } catch (err) {
        logger.warn('âŒ Invalid RELAYER_PRIVATE_KEY');
      }
    } else {
      logger.warn('âš ï¸  RELAYER_PRIVATE_KEY not set - on-chain operations will be simulated');
    }

    // Load MM keypair
    const mmKey = config.mmPrivateKey;
    if (mmKey) {
      try {
        const secretKey = bs58.decode(mmKey);
        this.mmKeypair = Keypair.fromSecretKey(secretKey);
        logger.info(`âœ… MM wallet loaded: ${this.mmKeypair.publicKey.toBase58()}`);
      } catch (err) {
        logger.warn('âŒ Invalid MM_WALLET_PRIVATE_KEY');
      }
    }
    
    // Log ready status
    if (this.isReady()) {
      logger.info(`âœ… Anchor client ready for on-chain operations`);
    } else {
      logger.warn(`âš ï¸  Anchor client NOT ready - trades/settlements will be SIMULATED`);
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

  // ─────────────────────────────────────────────────────────────────────────
  // Address Lookup Tables (ALTs) for batch settlement
  // ─────────────────────────────────────────────────────────────────────────
  // ALTs let versioned transactions reference accounts by 1-byte index
  // instead of inlining 32-byte pubkeys. Required to fit large batch settles
  // (subtreeSize=32) under the 1232-byte TX size cap.
  //
  // Lifecycle: created at settlement time (not market activation — keeps the
  // hot path free), populated with the recipient list + fixed accounts in
  // 1–2 extension TXs, then referenced by all V3 batch settle TXs for the
  // market. Closed by a follow-up cleanup pass after market is fully
  // settled (deferred — leaving rent unrecovered for now).
  //
  // Caps:
  //   - One ALT holds up to 256 addresses.
  //   - We enable ALT only when settlement count ≥ ALT_RECIPIENT_THRESHOLD
  //     (below that the setup overhead outweighs the per-batch savings).

  /** Below this many holders we don't bother with an ALT — k=4/k=8 is fast enough. */
  static readonly ALT_RECIPIENT_THRESHOLD = 64;
  /** Each `extendLookupTable` TX can hold this many addresses without exceeding 1232 bytes. */
  static readonly MAX_ADDRESSES_PER_EXTEND = 28;
  /** Total addresses an ALT can hold (Solana protocol limit). */
  static readonly MAX_ADDRESSES_PER_LUT = 256;

  /**
   * Create an Address Lookup Table for a market's batch settlement and
   * populate it with the union of fixed accounts (program + market PDAs)
   * and recipient USDC ATAs. Returns the ALT pubkey.
   *
   * The caller must wait until the ALT is observable on a slot >= the
   * extend slot before referencing it in a versioned TX (see
   * `waitForLookupTableActive`). On Solana, this is typically 1-2 slots
   * after the last extend.
   *
   * @param marketPubkey   The MarketV2 PDA this ALT serves.
   * @param recipientWallets  Wallet pubkeys of all settlement recipients.
   *                           USDC ATAs will be derived and added.
   * @returns ALT pubkey (base58 string), or null if recipients exceeds
   *          MAX_ADDRESSES_PER_LUT minus the fixed-account count.
   */
  async createMarketLookupTable(
    marketPubkey: PublicKey,
    recipientWallets: PublicKey[],
  ): Promise<string | null> {
    if (!this.relayerKeypair) throw new Error('Relayer not initialized');

    // Derive recipient USDC ATAs (deduplicated). Multiple settlements for the
    // same wallet share one ATA, so dedupe before sizing.
    const recipientAtas = await Promise.all(
      recipientWallets.map((w) => getAssociatedTokenAddress(USDC_MINT, w)),
    );
    const uniqueAtaSet = new Map<string, PublicKey>();
    for (const ata of recipientAtas) uniqueAtaSet.set(ata.toBase58(), ata);
    const dedupedAtas = [...uniqueAtaSet.values()];

    // Fixed accounts referenced by every BatchSettleV3 TX.
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), marketPubkey.toBuffer()],
      PROGRAM_ID,
    );
    const bitmapPda = getSettlementBitmapPda(marketPubkey, 0);
    const fixedAddresses = [
      marketPubkey,
      vault,
      bitmapPda,
      this.relayerKeypair.publicKey,
      TOKEN_PROGRAM_ID,
      SystemProgram.programId,
      USDC_MINT,
    ];

    const totalNeeded = fixedAddresses.length + dedupedAtas.length;
    if (totalNeeded > AnchorClient.MAX_ADDRESSES_PER_LUT) {
      logger.warn(
        `[ALT] Market ${marketPubkey.toBase58().slice(0, 8)} would need ${totalNeeded} addresses ` +
        `(>${AnchorClient.MAX_ADDRESSES_PER_LUT}). Falling back to legacy TX path for this market.`
      );
      return null;
    }

    // Step 1: create the ALT. The instruction takes the slot the ALT will be
    // derived from — must be a recent finalized slot.
    const recentSlot = await this.connection.getSlot('finalized');
    const [createIx, lookupTablePubkey] = AddressLookupTableProgram.createLookupTable({
      authority: this.relayerKeypair.publicKey,
      payer: this.relayerKeypair.publicKey,
      recentSlot,
    });

    await this.submitTransaction(
      [createIx], [], `ALT.create ${marketPubkey.toBase58().slice(0, 8)}`,
    );
    logger.info(`[ALT] Created lookup table ${lookupTablePubkey.toBase58().slice(0, 8)}... for market ${marketPubkey.toBase58().slice(0, 8)}`);

    // Step 2: extend the ALT in chunks. Fixed accounts go in the first chunk.
    const allAddresses = [...fixedAddresses, ...dedupedAtas];
    for (let i = 0; i < allAddresses.length; i += AnchorClient.MAX_ADDRESSES_PER_EXTEND) {
      const chunk = allAddresses.slice(i, i + AnchorClient.MAX_ADDRESSES_PER_EXTEND);
      const extendIx = AddressLookupTableProgram.extendLookupTable({
        payer: this.relayerKeypair.publicKey,
        authority: this.relayerKeypair.publicKey,
        lookupTable: lookupTablePubkey,
        addresses: chunk,
      });
      await this.submitTransaction(
        [extendIx], [],
        `ALT.extend ${lookupTablePubkey.toBase58().slice(0, 8)} +${chunk.length} (${i + chunk.length}/${allAddresses.length})`,
      );
    }

    return lookupTablePubkey.toBase58();
  }

  /**
   * Fetch a lookup table from chain. Returns null if it doesn't exist or
   * isn't yet observable on the connection's commitment level.
   */
  async fetchLookupTable(pubkey: string): Promise<AddressLookupTableAccount | null> {
    const lutPk = new PublicKey(pubkey);
    const resp = await this.connection.getAddressLookupTable(lutPk);
    return resp.value;
  }

  /**
   * Wait for an ALT to become observable AND for its address list to have
   * propagated past `lastExtendSlot + 1`. Without the slot wait, a freshly
   * extended ALT can be visible on its own account but the address list
   * hasn't yet been activated for use in versioned TXs.
   *
   * Returns the loaded ALT once ready, or null on timeout.
   */
  async waitForLookupTableActive(
    pubkey: string,
    expectedAddressCount: number,
    timeoutMs: number = 8_000,
  ): Promise<AddressLookupTableAccount | null> {
    const deadline = Date.now() + timeoutMs;
    let lastSeenCount = -1;
    while (Date.now() < deadline) {
      const lut = await this.fetchLookupTable(pubkey).catch(() => null);
      if (lut) {
        const count = lut.state.addresses.length;
        if (count !== lastSeenCount) {
          logger.debug(`[ALT] ${pubkey.slice(0, 8)} now has ${count}/${expectedAddressCount} addresses`);
          lastSeenCount = count;
        }
        if (count >= expectedAddressCount) {
          // One more slot wait so the ALT is referenceable in versioned TXs.
          await new Promise((r) => setTimeout(r, 600));
          return lut;
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    logger.warn(`[ALT] Timeout waiting for ${pubkey.slice(0, 8)} to reach ${expectedAddressCount} addresses (last seen ${lastSeenCount})`);
    return null;
  }

  /**
   * Get read connection (for account lookups, balance checks, etc.)
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get execution connection (for sending transactions â€” may use separate RPC)
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
   * This multiplies our effective RPC throughput: N endpoints Ã— 50 RPC/s each.
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
   * WS-only confirmation via signatureSubscribe. Replaces web3.js's
   * confirmTransaction which spawns an internal getBlockHeight polling loop
   * that leaks unhandled-rejection 429s on rate-limited RPC providers.
   *
   * Returns either the signature result (with its err field) or a timed-out
   * sentinel. No HTTP polling; the subscription is cleaned up on both the
   * success and timeout paths.
   */
  private confirmViaWs(
    conn: Connection,
    signature: string,
    commitment: 'processed' | 'confirmed' | 'finalized',
    timeoutMs: number,
    contextLabel: string,
  ): Promise<{ value: { err: any }; timedOut?: false } | { value: { err: null }; timedOut: true }> {
    return new Promise((resolve) => {
      let settled = false;
      let subId: number | null = null;

      const cleanup = () => {
        if (subId !== null) {
          // removeSignatureListener returns a Promise; swallow rejections to
          // avoid leaking if the socket is already gone.
          Promise.resolve(conn.removeSignatureListener(subId)).catch(() => {});
          subId = null;
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        logger.debug(`[${contextLabel}] confirmViaWs timeout for ${signature.slice(0, 16)}...`);
        resolve({ value: { err: null }, timedOut: true });
      }, timeoutMs);

      try {
        subId = conn.onSignature(
          signature,
          (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve({ value: { err: result.err } });
          },
          commitment,
        );
      } catch (err: any) {
        // onSignature is synchronous in web3.js but defensive — if the WS
        // subscription can't be created at all, fall through to timeout.
        logger.warn(`[${contextLabel}] confirmViaWs subscribe failed: ${err?.message}`);
      }
    });
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
    // Timed out â€” return null (treat as unknown)
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

  async submitTransaction(
    instructions: TransactionInstruction[],
    additionalSigners: Keypair[] = [],
    contextLabel: string = 'Transaction',
    opts?: {
      priorityMicroLamports?: number;
      computeUnits?: number;
      feePayerOverride?: Keypair;
      skipSimulation?: boolean;
      omitComputeBudgetIxs?: boolean;
      omitJitoTip?: boolean;
      addressLookupTableAccounts?: AddressLookupTableAccount[];
    }
  ): Promise<{ signature: string; confirmed: boolean }> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer keypair not set');
    }

    const feePayer = opts?.feePayerOverride || this.relayerKeypair;
    const useVersionedTx = !!(opts?.addressLookupTableAccounts && opts.addressLookupTableAccounts.length > 0);

    // Assemble the full instruction list (compute-budget + caller's ixs + jito tip).
    const allInstructions: TransactionInstruction[] = [];
    if (!opts?.omitComputeBudgetIxs) {
      const computeUnits = opts?.computeUnits ?? 400000;
      const priorityFee = opts?.priorityMicroLamports ?? 10000;
      allInstructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      );
    }
    allInstructions.push(...instructions);
    if (this.heliusSenderUrl && !opts?.omitJitoTip) {
      allInstructions.push(this.getJitoTipInstruction(feePayer.publicKey));
    }

    const { blockhash, lastValidBlockHeight } = await this.getCachedBlockhash();

    const signers: Keypair[] = [feePayer];
    if (opts?.feePayerOverride) {
      signers.push(this.relayerKeypair);
    }
    signers.push(...additionalSigners);

    // Branch on TX version. Versioned TXs let us reference accounts by 1-byte
    // ALT index instead of inlining 32-byte pubkeys — required to fit large
    // batch settles (k=32) under the 1232-byte TX size cap. Both branches
    // produce a serialized byte buffer that the rest of this function (send,
    // simulate, confirm) handles uniformly.
    let serializedTx: Uint8Array;
    let transaction: Transaction | VersionedTransaction;
    if (useVersionedTx) {
      const message = new TransactionMessage({
        payerKey: feePayer.publicKey,
        recentBlockhash: blockhash,
        instructions: allInstructions,
      }).compileToV0Message(opts!.addressLookupTableAccounts);
      const vtx = new VersionedTransaction(message);
      vtx.sign(signers);
      transaction = vtx;
      serializedTx = vtx.serialize();
    } else {
      const tx = new Transaction();
      for (const ix of allInstructions) tx.add(ix);
      tx.recentBlockhash = blockhash;
      tx.feePayer = feePayer.publicKey;
      tx.sign(...signers);
      transaction = tx;
      serializedTx = tx.serialize();
    }
    const execConn = this.getNextExecConnection();

    try {
      let signature: string;

      const senderSig = await this.sendViaHeliusSender(serializedTx as Buffer);

      if (senderSig) {
        signature = senderSig;
        const pollResult = await this.pollConfirmation(signature, execConn);
        if (pollResult === null) {
          logger.warn(`[Sender] ${contextLabel}: confirmation timed out for ${signature.slice(0, 16)}...`);
          return { signature, confirmed: false };
        }
        if (pollResult.err) {
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
        return { signature, confirmed: true };
      }

      const shouldSimulate = !opts?.skipSimulation && !config.skipPreflightSimulation;
      if (shouldSimulate) {
        try {
          // Cast to any: web3.js's simulateTransaction has separate overloads
          // for Transaction vs VersionedTransaction and the union here doesn't
          // satisfy either directly. The runtime accepts both.
          const simResult = await (execConn as any).simulateTransaction(transaction as any);
          if (simResult.value.err) {
            const simLogs = simResult.value.logs || [];
            const errJson = JSON.stringify(simResult.value.err);
            const logText = simLogs.join(' ');

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
          if (simErr.logs !== undefined) throw simErr;
          logger.warn(`[${contextLabel}] Preflight simulation request failed (proceeding anyway): ${simErr.message?.slice(0, 100)}`);
        }
      } else {
        logger.debug(`[${contextLabel}] Skipping preflight simulation (speed-critical path)`);
      }

      signature = await execConn.sendRawTransaction(
        serializedTx,
        { skipPreflight: true, maxRetries: 0 }
      );

      const resendIntervalMs = config.solanaResendIntervalMs;
      const resendTimer = setInterval(() => {
        // Fire-and-forget sends across the pool. Each send has its own try/catch
        // AND we attach a terminal .catch to the outer Promise so that any
        // rejection (including provider 429s surfacing asynchronously) cannot
        // escape as an unhandledRejection.
        (async () => {
          for (const conn of this.execConnectionPool) {
            try {
              await conn.sendRawTransaction(serializedTx, { skipPreflight: true, maxRetries: 0 });
            } catch { /* ignore */ }
          }
        })().catch(() => { /* defensive: never leak */ });
      }, resendIntervalMs);

      try {
        const MAX_CONFIRM_TIMEOUT_MS = 10_000;

        // Bypass web3.js's confirmTransaction because it spawns an internal
        // getBlockHeight polling loop to check blockhash expiry. Under load
        // that loop hits Helius per-method limits, and the rejections leak
        // out with no user-code frame on the stack (they're siblings of the
        // promise we await, not the promise itself). Using onSignature
        // directly gives us a pure WS subscription with no HTTP polling.
        const confirmation = await this.confirmViaWs(
          execConn,
          signature,
          'confirmed',
          MAX_CONFIRM_TIMEOUT_MS,
          contextLabel,
        );

        if (confirmation.timedOut) {
          logger.warn(`[${contextLabel}] Confirmation timeout (${MAX_CONFIRM_TIMEOUT_MS}ms) for ${signature.slice(0, 16)}... — will retry`);
          clearInterval(resendTimer);
          throw new Error(`Confirmation timeout after ${MAX_CONFIRM_TIMEOUT_MS}ms`);
        }

        if (confirmation?.value?.err) {
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
          (error as any).logs = logMessages;
          throw error;
        }
      } finally {
        clearInterval(resendTimer);
      }

      return { signature, confirmed: true };
    } catch (err: any) {
      const logsStr = err.logs ? JSON.stringify(err.logs, null, 2) : 'No logs available';
      const errorMsg = err.message || '';

      if (errorMsg.includes('block height exceeded') || errorMsg.includes('Blockhash not found') || errorMsg.includes('expired')) {
        this.cachedBlockhash = null;
      }
      
      const isCommonError = 
        errorMsg.includes('already in use') || 
        errorMsg.includes('0x0') ||
        errorMsg.includes('AccountNotInitialized') ||
        errorMsg.includes('0xbc4') ||
        errorMsg.includes('MarketNotPending') ||
        errorMsg.includes('0x1774');

      if (isCommonError) {
        logger.debug(`[${contextLabel}] skipped (expected): ${errorMsg.slice(0, 100)}...`);
      } else {
        logger.error(`[${contextLabel}] FAILED: ${errorMsg}\nLogs: ${logsStr}`);
      }
      throw err;
    }
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

  async buildCreateSessionAuthorityBySigInstruction(params: {
    walletAddress: string;
    sessionPublicKey: string;
    expiresAt: number;
  }): Promise<TransactionInstruction> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer not initialized');
    }

    const wallet = new PublicKey(params.walletAddress);
    const sessionPubkey = new PublicKey(params.sessionPublicKey);
    const sessionAuthority = getSessionAuthorityPda(wallet, sessionPubkey);
    const discriminator = computeDiscriminator('create_session_authority_by_sig');
    const expiresAtBuffer = Buffer.alloc(8);
    expiresAtBuffer.writeBigInt64LE(BigInt(params.expiresAt), 0);
    const data = Buffer.concat([discriminator, sessionPubkey.toBuffer(), expiresAtBuffer]);

    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: sessionAuthority, isSigner: false, isWritable: true },
        { pubkey: wallet, isSigner: false, isWritable: false },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  async createSessionAuthorityBySig(params: {
    walletAddress: string;
    sessionPublicKey: string;
    expiresAt: number;
    signature: string;
    binaryMessage: string;
  }): Promise<string> {
    const wallet = new PublicKey(params.walletAddress);
    const authIx = buildEd25519VerifyInstruction(
      wallet,
      Buffer.from(params.binaryMessage, 'base64'),
      Buffer.from(bs58.decode(params.signature))
    );
    const instruction = await this.buildCreateSessionAuthorityBySigInstruction(params);
    const { signature } = await this.submitTransaction(
      [authIx, instruction],
      [],
      `CreateSessionAuthorityBySig ${params.sessionPublicKey.slice(0, 8)}`
    );
    logger.info(`SessionAuthority created on-chain: ${signature}`);
    return signature;
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
        { pubkey: USDC_MINT, isSigner: false, isWritable: false },
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

    // Phase 1: Create market + YES mint (idempotent â€” skip if already exists)
    // Retries on transient failures (e.g. block height exceeded / expired blockhash)
    const PHASE1_MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= PHASE1_MAX_RETRIES; attempt++) {
      try {
        const ix1 = await this.buildInitializeMarketV2Instruction(params);
        const { signature: sig1 } = await this.submitTransaction([ix1], [], `Init MarketV2 ${params.asset}-${params.timeframe} (phase 1)`);
        logger.info(`MarketV2 phase 1 complete: ${market.toBase58()} (tx: ${sig1})`);
        break; // Success
      } catch (err: any) {
        const msg = err.message || '';
        if (msg.includes('already in use') || msg.includes('0x0')) {
          logger.info(`MarketV2 phase 1 already exists: ${market.toBase58()} â€” proceeding to phase 2`);
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
          // Exponential backoff: 2s, 4s â€” fresh blockhash on next submitTransaction call
          await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
          continue;
        }
        if (attempt === PHASE1_MAX_RETRIES) {
          logger.error(`MarketV2 phase 1 FAILED after ${PHASE1_MAX_RETRIES} attempts for ${market.toBase58()}`);
        }
        throw err; // Non-idempotent / non-transient error â€” Phase 1 genuinely failed
      }
    }

    // Phase 2: Create NO mint + vault (with retries â€” Phase 1 is already on-chain)
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
          // Ignore fetch errors â€” proceed to attempt Phase 2
        }

        const ix2 = await this.buildInitializeMarketV2FinalizeInstruction({
          marketPubkey: market,
          strikePrice: params.strikePrice,
        });
        const { signature: phase2Signature } = await this.submitTransaction([ix2], [], `Init MarketV2 ${params.asset}-${params.timeframe} (phase 2)`);
        signature = phase2Signature;
        logger.info(`MarketV2 phase 2 complete: ${market.toBase58()} (tx: ${signature})`);
        break; // Success
      } catch (err: any) {
        const msg = err.message || '';
        // If "already in use" â†’ Phase 2 was already completed (idempotent)
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

        // InsufficientFundsForRent: relayer doesn't have enough SOL to cover
        // rent for the new accounts (NO mint ~0.0035 SOL, vault ~0.002 SOL).
        // Retrying won't help â€” the balance won't change between attempts.
        // Throw immediately so the market creator can skip and retry next cycle
        // after the auto-funding keeper has topped up the relayer.
        if (msg.includes('InsufficientFundsForRent') || msg.includes('insufficient lamports')) {
          logger.error(`MarketV2 phase 2 FAILED (insufficient SOL for rent) for ${market.toBase58()}. Relayer needs more SOL.`);
          throw err;
        }

        logger.warn(`MarketV2 phase 2 attempt ${attempt}/${PHASE2_MAX_RETRIES} failed: ${msg.split('\n')[0].slice(0, 150)}`);
        if (attempt === PHASE2_MAX_RETRIES) {
          logger.error(`MarketV2 phase 2 FAILED after ${PHASE2_MAX_RETRIES} attempts for ${market.toBase58()} â€” market has NO mint missing!`);
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
      const { signature: sig } = await this.submitTransaction([ix2], [], `Recovery Phase 2: ${marketPubkey.toBase58().slice(0, 8)}`);
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
    makerSigner: PublicKey;
    takerSigner: PublicKey;
    makerSessionAuthority: PublicKey;
    takerSessionAuthority: PublicKey;
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
    const makerSignerBuffer = Buffer.from(params.makerSigner.toBytes());
    const takerSignerBuffer = Buffer.from(params.takerSigner.toBytes());

    const data = Buffer.concat([
      discriminator,
      makerArgsBuffer,
      takerArgsBuffer,
      matchSizeBuffer,
      takerFeeBuffer,
      makerSignerBuffer,
      takerSignerBuffer,
    ]);

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
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: params.makerSessionAuthority, isSigner: false, isWritable: false },
        { pubkey: params.takerSessionAuthority, isSigner: false, isWritable: false },
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
    makerOrderType: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
    takerOrderType: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
    outcome: 'YES' | 'NO';
    price: number;
    matchSize: number;
    takerFee: number;
    makerClientOrderId: number;
    takerClientOrderId: number;
    makerExpiryTs: number;
    takerExpiryTs: number;
    makerSignature?: string;
    takerSignature?: string;
    makerMessage?: string;
    takerMessage?: string;
    makerSessionPublicKey?: string;
    takerSessionPublicKey?: string;
    makerOrderPda?: string;
    takerOrderPda?: string;
    feePayerKeypair?: Keypair; // Pool child wallet as fee payer
  }): Promise<{ signature: string; confirmed: boolean }> {
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
    const sizeU64 = Math.round(params.matchSize * 1_000_000);
    const feeU64 = Math.floor(params.takerFee * 1_000_000);

    const makerArgs: PlaceOrderArgs = {
      side: params.makerSide,
      outcome: params.outcome,
      orderType: params.makerOrderType,
      price: priceU64,
      size: sizeU64,
      expiryTs: params.makerExpiryTs,
      clientOrderId: params.makerClientOrderId,
    };

    const takerArgs: PlaceOrderArgs = {
      side: params.takerSide,
      outcome: params.outcome,
      orderType: params.takerOrderType,
      price: priceU64,
      size: sizeU64,
      expiryTs: params.takerExpiryTs,
      clientOrderId: params.takerClientOrderId,
    };

    const makerOrderPda = params.makerOrderPda ? new PublicKey(params.makerOrderPda) : null;
    const takerOrderPda = params.takerOrderPda ? new PublicKey(params.takerOrderPda) : null;
    const mmWallet = this.mmKeypair?.publicKey.toBase58();
    const makerRequiresAuth = !makerOrderPda &&
      !!params.makerSignature &&
      !!params.makerMessage &&
      params.makerWallet !== mmWallet;
    const takerRequiresAuth = !takerOrderPda &&
      !!params.takerSignature &&
      !!params.takerMessage &&
      params.takerWallet !== mmWallet;
    const defaultSigner = new PublicKey(new Uint8Array(32));
    const makerSigner = makerRequiresAuth
      ? new PublicKey(params.makerSessionPublicKey || params.makerWallet)
      : defaultSigner;
    const takerSigner = takerRequiresAuth
      ? new PublicKey(params.takerSessionPublicKey || params.takerWallet)
      : defaultSigner;
    const makerSessionAuthority = makerRequiresAuth && params.makerSessionPublicKey
      ? getSessionAuthorityPda(makerWallet, makerSigner)
      : PROGRAM_ID;
    const takerSessionAuthority = takerRequiresAuth && params.takerSessionPublicKey
      ? getSessionAuthorityPda(takerWallet, takerSigner)
      : PROGRAM_ID;

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

    // Helper to check if ATA exists and add creation instruction if needed.
    // An ATA, once created, cannot be closed back into non-existence for share
    // tokens, so a cached hit is safe to trust indefinitely. On a miss we fall
    // back to an RPC getAccountInfo and cache the result on success.
    const maybeCreateAta = async (ata: PublicKey, owner: PublicKey, mint: PublicKey) => {
      if (this.ataIsKnown(ata)) return; // cache hit — skip RPC and skip ix
      try {
        const info = await conn.getAccountInfo(ata);
        if (info) {
          this.markAtaExists(ata);
          return;
        }
      } catch {
        // fall through to enqueue creation on RPC failure — safer than silently
        // skipping; createAssociatedTokenAccountIdempotentInstruction is a no-op
        // if the ATA already exists.
      }
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
    };

    // Check all 4 ATAs in parallel
    await Promise.all([
      maybeCreateAta(makerYesAta, makerWallet, yesMint),
      maybeCreateAta(makerNoAta, makerWallet, noMint),
      maybeCreateAta(takerYesAta, takerWallet, yesMint),
      maybeCreateAta(takerNoAta, takerWallet, noMint),
    ]);

    // After a successful send the ATAs in createAtaIxs will exist on-chain.
    // We mark them as known so the next match for the same wallets skips the
    // 4 getAccountInfo calls entirely (the common case once traders are warm).
    if (createAtaIxs.length === 0) {
      this.markAtaExists(makerYesAta);
      this.markAtaExists(makerNoAta);
      this.markAtaExists(takerYesAta);
      this.markAtaExists(takerNoAta);
    }

    const authIxs: TransactionInstruction[] = [];
    if (makerRequiresAuth) {
      authIxs.push(buildEd25519VerifyInstruction(
        makerSigner,
        Buffer.from(params.makerMessage, 'base64'),
        Buffer.from(bs58.decode(params.makerSignature)),
      ));
    }
    if (takerRequiresAuth) {
      authIxs.push(buildEd25519VerifyInstruction(
        takerSigner,
        Buffer.from(params.takerMessage, 'base64'),
        Buffer.from(bs58.decode(params.takerSignature)),
      ));
    }

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
      makerSigner,
      takerSigner,
      makerSessionAuthority,
      takerSessionAuthority,
      makerOrderPda,
      takerOrderPda,
    });

    // ATA setup can push relayed + Ed25519 verified matches over Solana's
    // 1232-byte transaction limit, so submit setup separately when needed.
    if (createAtaIxs.length > 0) {
      await this.submitTransaction(
        createAtaIxs,
        [],
        `MatchV2 ATA setup ${params.matchSize} shares`,
        {
          feePayerOverride: params.feePayerKeypair,
          skipSimulation: true,
        }
      );
    }

    // When Ed25519 auth instructions are present, using a fee payer override adds
    // a second signer (64 bytes) which can push the TX over Solana's 1232-byte limit.
    // In that case, use the relayer as fee payer (it's already a required signer as authority).
    const useOverride = authIxs.length === 0 ? params.feePayerKeypair : undefined;

    const result = await this.submitTransaction([...authIxs, matchIx], [], `MatchV2 ${params.matchSize} shares`, {
      feePayerOverride: useOverride,
      skipSimulation: true, // Speed-critical: skip preflight to save 100-500ms
      omitComputeBudgetIxs: true,
      omitJitoTip: true,
    });
    logger.info(`MatchV2 executed on-chain: ${result.signature} (confirmed=${result.confirmed})`);

    return result;
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
    const { signature } = await this.submitTransaction(
      [instruction], [], `Activate MarketV2 ${params.marketPubkey.slice(0, 8)}`,
      { skipSimulation: true },
    );

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
    const { signature } = await this.submitTransaction(
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
    buyerArgs: PlaceOrderArgs;
    sellerArgs: PlaceOrderArgs;
    outcome: 'YES' | 'NO';
    price: number;      // 6 decimals
    size: number;       // 6 decimals
    takerFee: number;   // 6 decimals
    buyerSigner: PublicKey;
    sellerSigner: PublicKey;
    buyerSessionAuthority: PublicKey;
    sellerSessionAuthority: PublicKey;
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

    // Buyer accounts (USDC: regular Token, one outcome ATA: Token-2022)
    const buyerUsdc = await getAssociatedTokenAddress(USDC_MINT, params.buyerWallet);
    const buyerTokenAta = await getAssociatedTokenAddress(
      params.outcome === 'YES' ? params.yesMint : params.noMint,
      params.buyerWallet,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    // Seller accounts (USDC: regular Token, one outcome ATA: Token-2022)
    const sellerUsdc = await getAssociatedTokenAddress(USDC_MINT, params.sellerWallet);
    const sellerTokenAta = await getAssociatedTokenAddress(
      params.outcome === 'YES' ? params.yesMint : params.noMint,
      params.sellerWallet,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const discriminator = computeDiscriminator('execute_close_v2');
    const buyerArgsBuffer = this.encodePlaceOrderArgs(params.buyerArgs);
    const sellerArgsBuffer = this.encodePlaceOrderArgs(params.sellerArgs);
    const matchSizeBuffer = Buffer.alloc(8);
    matchSizeBuffer.writeBigUInt64LE(BigInt(params.size), 0);
    const takerFeeBuffer = Buffer.alloc(8);
    takerFeeBuffer.writeBigUInt64LE(BigInt(params.takerFee), 0);
    const buyerSignerBuffer = Buffer.from(params.buyerSigner.toBytes());
    const sellerSignerBuffer = Buffer.from(params.sellerSigner.toBytes());

    const data = Buffer.concat([
      discriminator,
      buyerArgsBuffer,
      sellerArgsBuffer,
      matchSizeBuffer,
      takerFeeBuffer,
      buyerSignerBuffer,
      sellerSignerBuffer,
    ]);

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
        { pubkey: buyerTokenAta, isSigner: false, isWritable: true },
        { pubkey: params.sellerWallet, isSigner: false, isWritable: false },
        { pubkey: sellerUsdc, isSigner: false, isWritable: true },
        { pubkey: sellerTokenAta, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },           // USDC operations
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },      // share_token_program (Token-2022 for YES/NO transfers)
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: params.buyerSessionAuthority, isSigner: false, isWritable: false },
        { pubkey: params.sellerSessionAuthority, isSigner: false, isWritable: false },
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
    buyerOrderType: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
    sellerOrderType: 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
    buyerClientOrderId: number;
    sellerClientOrderId: number;
    buyerExpiryTs: number;
    sellerExpiryTs: number;
    buyerSignature?: string;
    sellerSignature?: string;
    buyerMessage?: string;
    sellerMessage?: string;
    buyerSessionPublicKey?: string;
    sellerSessionPublicKey?: string;
    feePayerKeypair?: Keypair; // Pool child wallet as fee payer
  }): Promise<{ signature: string; confirmed: boolean }> {
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
    let sizeU64 = Math.round(params.matchSize * 1_000_000);
    const feeU64 = Math.floor(params.takerFee * 1_000_000);

    // Guard: require the seller's confirmed on-chain token balance to cover the
    // full requested close size. Silently partial-closing here would desync the
    // off-chain matched trade from the on-chain executed size.
    try {
      const sellerMint = params.outcome === 'YES' ? yesMint : noMint;
      const sellerAta = await getAssociatedTokenAddress(sellerMint, sellerWallet, false, TOKEN_2022_PROGRAM_ID);
      const sellerAccount = await getAccount(this.connection, sellerAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
      const onChainBalance = Number(sellerAccount.amount);
      if (sizeU64 > onChainBalance) {
        throw new Error(
          `PENDING_POSITION_SYNC: requested close ${sizeU64} lamports exceeds confirmed on-chain balance ${onChainBalance}`
        );
      }
    } catch (err: any) {
      // ATA missing or insufficient confirmed balance means the position is not
      // currently sellable on-chain.
      if (String(err?.message || '').includes('PENDING_POSITION_SYNC')) {
        throw err;
      }
      logger.warn(`[CloseV2] Could not fetch seller token balance: ${err.message}`);
    }

    const MIN_ORDER_SIZE_LAMPORTS = 1_000; // 0.001 shares, matches on-chain MIN_ORDER_SIZE
    if (sizeU64 < MIN_ORDER_SIZE_LAMPORTS) {
      throw new Error(`NO_SELLABLE_BALANCE: seller on-chain balance too low for close (${sizeU64} lamports)`);
    }

    // ATA creation payer: use fee payer override if available (child pays rent too)
    const ataPayer = params.feePayerKeypair?.publicKey || this.relayerKeypair!.publicKey;

    // Pre-create buyer ATAs (idempotent - skips if already exists)
    // Token-2022 program for YES/NO share tokens
    const buyerTokenMint = params.outcome === 'YES' ? yesMint : noMint;
    const buyerTokenAta = await getAssociatedTokenAddress(
      buyerTokenMint,
      buyerWallet,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const createAtaIxs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(
        ataPayer,
        buyerTokenAta,
        buyerWallet,
        buyerTokenMint,
        TOKEN_2022_PROGRAM_ID
      ),
    ];

    const buyerArgs: PlaceOrderArgs = {
      side: 'BID',
      outcome: params.outcome,
      orderType: params.buyerOrderType,
      price: priceU64,
      size: sizeU64,
      expiryTs: params.buyerExpiryTs,
      clientOrderId: params.buyerClientOrderId,
    };
    const sellerArgs: PlaceOrderArgs = {
      side: 'ASK',
      outcome: params.outcome,
      orderType: params.sellerOrderType,
      price: priceU64,
      size: sizeU64,
      expiryTs: params.sellerExpiryTs,
      clientOrderId: params.sellerClientOrderId,
    };
    const mmWallet = this.mmKeypair?.publicKey.toBase58();
    const buyerRequiresAuth = Boolean(
      params.buyerSignature &&
      params.buyerMessage &&
      params.buyerWallet !== mmWallet
    );
    const sellerRequiresAuth = Boolean(
      params.sellerSignature &&
      params.sellerMessage &&
      params.sellerWallet !== mmWallet
    );
    const defaultSigner = new PublicKey(new Uint8Array(32)); // Represents Pubkey::default()
    const buyerSigner = buyerRequiresAuth
      ? new PublicKey(params.buyerSessionPublicKey || params.buyerWallet)
      : defaultSigner;
    const sellerSigner = sellerRequiresAuth
      ? new PublicKey(params.sellerSessionPublicKey || params.sellerWallet)
      : defaultSigner;
    const buyerSessionAuthority = buyerRequiresAuth && params.buyerSessionPublicKey
      ? getSessionAuthorityPda(buyerWallet, buyerSigner)
      : PROGRAM_ID;
    const sellerSessionAuthority = sellerRequiresAuth && params.sellerSessionPublicKey
      ? getSessionAuthorityPda(sellerWallet, sellerSigner)
      : PROGRAM_ID;
    const authIxs: TransactionInstruction[] = [];
    if (buyerRequiresAuth) {
      authIxs.push(buildEd25519VerifyInstruction(
        buyerSigner,
        Buffer.from(params.buyerMessage, 'base64'),
        Buffer.from(bs58.decode(params.buyerSignature)),
      ));
    }
    if (sellerRequiresAuth) {
      authIxs.push(buildEd25519VerifyInstruction(
        sellerSigner,
        Buffer.from(params.sellerMessage, 'base64'),
        Buffer.from(bs58.decode(params.sellerSignature)),
      ));
    }

    const closeIx = await this.buildExecuteCloseV2Instruction({
      marketPubkey: market,
      yesMint,
      noMint,
      buyerWallet,
      sellerWallet,
      buyerArgs,
      sellerArgs,
      outcome: params.outcome,
      price: priceU64,
      size: sizeU64,
      takerFee: feeU64,
      buyerSigner,
      sellerSigner,
      buyerSessionAuthority,
      sellerSessionAuthority,
    });

    // ATA setup can push relayed closes over Solana's 1232-byte limit,
    // so submit setup separately when needed.
    if (createAtaIxs.length > 0) {
      await this.submitTransaction(
        createAtaIxs,
        [],
        `CloseV2 ATA setup ${params.matchSize} shares`,
        {
          feePayerOverride: params.feePayerKeypair,
          skipSimulation: true,
        }
      );
    }

    const result = await this.submitTransaction([...authIxs, closeIx], [], `CloseV2 ${params.matchSize} shares`, {
      feePayerOverride: params.feePayerKeypair,
      skipSimulation: true, // Speed-critical: skip preflight to save 100-500ms
      omitComputeBudgetIxs: true,
      omitJitoTip: true,
    });
    logger.info(`CloseV2 executed on-chain: ${result.signature} (confirmed=${result.confirmed})`);

    return result;
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
    const { signature } = await this.submitTransaction([ix], [], `CloseMarketV2 ${params.marketPubkey.slice(0,8)}`);
    logger.info(`CloseMarketV2 executed: ${signature}`);

    return signature;
  }

  // =========================================================================
  // V2 Merkle Settlement Instructions
  // =========================================================================

  /**
   * Post merkle root to begin batch settlement.
   * Transitions market from RESOLVED â†’ SETTLING on-chain.
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

    const { signature } = await this.submitTransaction(
      [instruction], [],
      `PostMerkleRoot ${params.marketPubkey.slice(0, 8)} (${params.totalSettlements} settlements)`,
      { priorityMicroLamports: 50000 }  // 5x priority for settlement speed
    );
    logger.info(`PostMerkleRoot executed: ${signature}`);
    return signature;
  }

  async initSettlementBitmapChunk(params: {
    marketPubkey: string;
    chunkIndex: number;
  }): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Anchor client not ready');
    }

    const market = new PublicKey(params.marketPubkey);
    const bitmapPda = getSettlementBitmapPda(market, params.chunkIndex);
    const discriminator = computeDiscriminator('init_settlement_bitmap');
    const args = Buffer.alloc(2);
    args.writeUInt16LE(params.chunkIndex, 0);

    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: bitmapPda, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair!.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([discriminator, args]),
    });

    const { signature } = await this.submitTransaction(
      [instruction], [],
      `InitSettlementBitmap ${params.marketPubkey.slice(0, 8)} chunk ${params.chunkIndex}`,
      { priorityMicroLamports: 50000 }
    );
    return signature;
  }

  /**
   * Batch settle V2 â€” submit up to 15 settlements with merkle proofs.
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

    // Build remaining accounts â€” recipient USDC ATAs in same order as settlements
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
    const { signature } = await this.submitTransaction(
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
    /**
     * Optional Address Lookup Table for this market. When provided, the TX
     * is built as a versioned message that references accounts via 1-byte
     * indices, allowing larger batches (subtreeSize=32) to fit in 1232 bytes.
     */
    lookupTablePubkey?: string;
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

    // amounts: Vec<u64> â€” u32 length prefix + count Ã— u64 LE
    const amountsLenBuf = Buffer.alloc(4);
    amountsLenBuf.writeUInt32LE(params.settlements.length, 0);
    bufParts.push(amountsLenBuf);
    for (const entry of params.settlements) {
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(entry.amount, 0);
      bufParts.push(amountBuf);
    }

    // bridge_proof: Vec<[u8;32]> â€” u32 length prefix + N Ã— 32 bytes
    const bridgeLenBuf = Buffer.alloc(4);
    bridgeLenBuf.writeUInt32LE(params.bridgeProof.length, 0);
    bufParts.push(bridgeLenBuf);
    for (const proofElement of params.bridgeProof) {
      bufParts.push(Buffer.from(proofElement));
    }

    const argsBuffer = Buffer.concat(bufParts);
    const data = Buffer.concat([discriminator, argsBuffer]);

    // Resolve every recipient's USDC ATA exactly once and decide whether we
    // can skip the createIdempotent ix for it (cache says it already exists).
    // Skipping shaves ~42 bytes per entry from the TX (createATA framing +
    // recipient wallet account meta), which is what unlocks subtreeSize=8 on
    // the V3 sizing formula. The ATA cache (knownAtas) is shared with the
    // match path; a positive entry is effectively permanent because ATAs
    // can't be uncreated.
    const ataDecisions: Array<{ ata: PublicKey; recipient: PublicKey; skippedCreate: boolean }> = [];
    for (const entry of params.settlements) {
      const recipientPubkey = new PublicKey(entry.recipient);
      const ata = await getAssociatedTokenAddress(USDC_MINT, recipientPubkey);
      ataDecisions.push({ ata, recipient: recipientPubkey, skippedCreate: this.ataIsKnown(ata) });
    }

    const remainingAccounts = ataDecisions.map((d) => ({
      pubkey: d.ata,
      isSigner: false,
      isWritable: true,
    }));

    // Only emit createATA instructions for ATAs we don't already know exist.
    const createAtaIxs: TransactionInstruction[] = [];
    for (const d of ataDecisions) {
      if (d.skippedCreate) continue;
      createAtaIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          this.relayerKeypair!.publicKey,
          d.ata,
          d.recipient,
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

    // Optionally use a versioned TX with a market-specific Address Lookup
    // Table. This shrinks each account reference from 32 bytes to 1 byte,
    // letting subtreeSize=32 fit comfortably in 1232 bytes. If the ALT can't
    // be loaded for any reason, fall back to a legacy TX (which works as
    // long as the sizing formula chose a small-enough k).
    let lookupTableAccounts: AddressLookupTableAccount[] | undefined;
    if (params.lookupTablePubkey) {
      try {
        const lut = await this.fetchLookupTable(params.lookupTablePubkey);
        if (lut) {
          lookupTableAccounts = [lut];
        } else {
          logger.warn(`[BatchSettleV3] ALT ${params.lookupTablePubkey.slice(0, 8)} not yet observable; using legacy TX (k must fit without ALT compression)`);
        }
      } catch (err: any) {
        logger.warn(`[BatchSettleV3] ALT fetch failed (${err.message}); using legacy TX`);
      }
    }

    try {
      const { signature } = await this.submitTransaction(
        allIxs, [],
        `BatchSettleV3 ${params.settlements.length} entries (Market ${params.marketPubkey.slice(0, 8)})`,
        {
          priorityMicroLamports: 50000,  // 5x priority for settlement speed
          addressLookupTableAccounts: lookupTableAccounts,
        }
      );
      // TX landed → every recipient's USDC ATA now provably exists. Mark
      // them all so future batches for these recipients can skip createATA.
      for (const d of ataDecisions) this.markAtaExists(d.ata);
      logger.info(
        `BatchSettleV3 executed: ${signature} ` +
        `(${params.settlements.length} settlements, subtree=${params.subtreeSize}, ` +
        `createAtaSkipped=${params.settlements.length - createAtaIxs.length}/${params.settlements.length}, ` +
        `alt=${lookupTableAccounts ? 'yes' : 'no'})`
      );
      return signature;
    } catch (err) {
      // Evict the cache for entries we trusted on this attempt — if we
      // skipped createATA but the TX still failed, the ATA may not actually
      // exist (rare: cache poisoning, ATA was closed by user, etc.). The
      // BullMQ retry will then re-include the createATA.
      for (const d of ataDecisions) {
        if (d.skippedCreate) this.knownAtas.delete(d.ata.toBase58());
      }
      throw err;
    }
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

    const { signature } = await this.submitTransaction(
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

    // Derive settlement bitmap PDA (chunk 0) â€” closed during finalize to recover ~0.008 SOL
    const chunkBuffer = Buffer.alloc(2);
    chunkBuffer.writeUInt16LE(0, 0); // chunk_index = 0
    const [settlementBitmap] = PublicKey.findProgramAddressSync(
      [Buffer.from('settlement_bitmap'), market.toBuffer(), chunkBuffer],
      PROGRAM_ID
    );

    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: yesMint, isSigner: false, isWritable: true },       // closed via Token-2022 MintCloseAuthority
        { pubkey: noMint, isSigner: false, isWritable: true },        // closed via Token-2022 MintCloseAuthority
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: this.relayerKeypair!.publicKey, isSigner: true, isWritable: true },
        { pubkey: authorityAta, isSigner: false, isWritable: true }, // authority_ata for dust
        { pubkey: settlementBitmap, isSigner: false, isWritable: true }, // settlement_bitmap (closed to recover rent)
        { pubkey: this.relayerKeypair!.publicKey, isSigner: false, isWritable: true }, // rent_recipient
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },             // USDC vault operations
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },        // share_token_program (Token-2022 for mint close)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: discriminator,
    });

    const { signature } = await this.submitTransaction(
      [instruction], [],
      `FinalizeMarketV2 ${params.marketPubkey.slice(0, 8)}`,
      { priorityMicroLamports: 50000 }  // 5x priority for settlement speed
    );
    logger.info(`FinalizeMarketV2 executed: ${signature}`);
    return signature;
  }

}

// Singleton instance
export const anchorClient = new AnchorClient();
