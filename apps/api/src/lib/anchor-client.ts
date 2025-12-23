import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
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

/**
 * Solana client for interacting with the Degen Terminal program
 * Uses raw instruction building for maximum compatibility
 */
export class AnchorClient {
  private connection: Connection;
  private relayerKeypair: Keypair | null = null;
  private mmKeypair: Keypair | null = null;
  private relayerUsdcAtaReady: boolean | null = null;

  constructor() {
    this.connection = new Connection(
      config.solanaRpcUrl,
      { commitment: 'confirmed' }
    );

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
   * Get connection
   */
  getConnection(): Connection {
    return this.connection;
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

    const data = Buffer.concat([discriminator, makerArgsBuffer, takerArgsBuffer, matchSizeBuffer]);

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
    const executeMatchIx = await this.buildExecuteMatchInstruction({
      marketPubkey: params.marketPubkey,
      makerWallet: params.makerWallet,
      takerWallet: params.takerWallet,
      makerArgs: params.makerArgs,
      takerArgs: params.takerArgs,
      matchSize: params.matchSize,
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
   * Submit a transaction with compute budget and confirmation
   */
  async submitTransaction(
    instructions: TransactionInstruction[],
    additionalSigners: Keypair[] = [],
    contextLabel: string = 'Transaction'
  ): Promise<string> {
    if (!this.relayerKeypair) {
      throw new Error('Relayer keypair not set');
    }

    const transaction = new Transaction();

    // Add compute budget with higher priority fee for faster inclusion
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 })  // 10x priority for faster slot inclusion
    );

    // Add instructions
    for (const ix of instructions) {
      transaction.add(ix);
    }

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.relayerKeypair.publicKey;

    // Sign with relayer
    transaction.sign(this.relayerKeypair, ...additionalSigners);

    // Send transaction
    try {
      const signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        { skipPreflight: false, preflightCommitment: 'confirmed' }
      );

      // Confirm transaction
      const confirmation = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

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

      return signature;
    } catch (err: any) {
      const logsStr = err.logs ? JSON.stringify(err.logs, null, 2) : 'No logs available';
      const errorMsg = err.message || '';
      
      // Downgrade common "drift" errors to DEBUG level to avoid terminal noise
      const isCommonError = 
        errorMsg.includes('already in use') || 
        errorMsg.includes('0x0') ||
        errorMsg.includes('AccountNotInitialized') ||
        errorMsg.includes('0xbc4');

      if (isCommonError) {
        logger.debug(`[${contextLabel}] failed (Expected/Drift): ${errorMsg}\nLogs: ${logsStr}`);
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
    const priceU64 = Math.floor(params.price * 1_000_000);
    const sizeU64 = Math.floor(params.matchSize * 1_000_000);

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
      makerOrderPda,
      takerOrderPda,
    });

    const signature = await this.submitTransaction([ix], [], `Match ${params.matchSize} shares`);
    logger.debug(`Match executed on-chain: ${signature}`);
    
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
    price: number;  // In 6 decimals
    size: number;   // In 6 decimals
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
    
    // CloseTradeArgs: outcome (u8) + price (u64) + size (u64)
    const argsBuffer = Buffer.alloc(17);
    argsBuffer.writeUInt8(params.outcome === 'YES' ? 0 : 1, 0);  // outcome: 0=Yes, 1=No
    argsBuffer.writeBigUInt64LE(BigInt(params.price), 1);
    argsBuffer.writeBigUInt64LE(BigInt(params.size), 9);

    const data = Buffer.concat([discriminator, argsBuffer]);

    logger.info(`execute_close: market=${market.toBase58()}`);
    logger.info(`execute_close: buyer=${params.buyerWallet.toBase58()}, seller=${params.sellerWallet.toBase58()}`);
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
    const priceU64 = Math.floor(params.price * 1_000_000);
    const sizeU64 = Math.floor(params.matchSize * 1_000_000);

    const ix = await this.buildExecuteCloseInstruction({
      marketPubkey: market,
      buyerWallet,
      sellerWallet,
      outcome: params.outcome,
      price: priceU64,
      size: sizeU64,
    });

    const signature = await this.submitTransaction([ix], [], `Close Position ${params.matchSize} shares`);
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
   */
  async initializeMarket(params: {
    asset: string;
    timeframe: string;
    strikePrice: number;
    expiryTs: number;  // Unix timestamp in seconds
  }): Promise<string> {
    const market = getMarketPda(params.asset, params.timeframe, params.expiryTs);
    const instruction = await this.buildInitializeMarketInstruction(params);
    const signature = await this.submitTransaction([instruction], [], `Init Market ${params.asset}-${params.timeframe} (${market.toBase58().slice(0, 8)})`);
    
    logger.info(`Market initialized on-chain: ${market.toBase58()} (tx: ${signature})`);
    
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
  }> {
    try {
      const walletPubkey = new PublicKey(wallet);
      const ata = await getAssociatedTokenAddress(USDC_MINT, walletPubkey);
      const account = await getAccount(this.connection, ata);
      
      return {
        delegate: account.delegate ? account.delegate.toBase58() : null,
        delegatedAmount: Number(account.delegatedAmount),
      };
    } catch (err) {
      return { delegate: null, delegatedAmount: 0 };
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
}

// Singleton instance
export const anchorClient = new AnchorClient();
