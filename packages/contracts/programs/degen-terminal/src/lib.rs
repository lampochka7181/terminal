use anchor_lang::prelude::*;

declare_id!("5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk");

pub mod state;
pub mod state_v2;  // V2 tokenized shares state
pub mod session;
pub mod instructions;
pub mod errors;
pub mod security;

use instructions::*;

#[program]
pub mod degen_terminal {
    use super::*;

    // =========================================================================
    // Admin Instructions
    // =========================================================================

    /// Initialize the global state (one-time setup)
    /// 
    /// # Arguments
    /// * `maker_fee_bps` - Maker fee in basis points (0 = 0.00%, 10 = 0.10%)
    /// * `taker_fee_bps` - Taker fee in basis points (0 = 0.00%, 10 = 0.10%)
    pub fn initialize_global(
        ctx: Context<InitializeGlobal>,
        maker_fee_bps: u16,
        taker_fee_bps: u16,
    ) -> Result<()> {
        instructions::initialize_global(ctx, maker_fee_bps, taker_fee_bps)
    }

    /// Pause or unpause the protocol
    /// 
    /// # Arguments
    /// * `paused` - True to pause, false to unpause
    /// * `reason` - Optional reason for pausing
    pub fn pause_protocol(
        ctx: Context<PauseProtocol>, 
        paused: bool,
        reason: Option<String>,
    ) -> Result<()> {
        instructions::pause_protocol(ctx, paused, reason)
    }

    /// Update global configuration (fees, recipient)
    /// 
    /// # Arguments
    /// * `maker_fee_bps` - Optional new maker fee in basis points
    /// * `taker_fee_bps` - Optional new taker fee in basis points (used as max fee cap)
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        maker_fee_bps: Option<u16>,
        taker_fee_bps: Option<u16>,
    ) -> Result<()> {
        instructions::update_config(ctx, maker_fee_bps, taker_fee_bps)
    }

    /// Transfer admin authority to a new address
    pub fn transfer_admin(ctx: Context<TransferAdmin>) -> Result<()> {
        instructions::transfer_admin(ctx)
    }

    // =========================================================================
    // Market Instructions
    // =========================================================================

    /// Create a new binary outcome market
    /// 
    /// If strike_price = 0, market is created with PENDING status.
    /// If strike_price > 0, market is created with OPEN status (direct activation).
    /// 
    /// # Arguments
    /// * `asset` - Asset symbol (BTC, ETH, SOL)
    /// * `timeframe` - Market timeframe (5m, 15m, 1h, 4h, 24h)
    /// * `strike_price` - Strike price with 8 decimals (0 for pending markets)
    /// * `expiry_ts` - Unix timestamp when market expires
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        asset: String,
        timeframe: String,
        strike_price: u64,
        expiry_ts: i64,
    ) -> Result<()> {
        instructions::initialize_market(ctx, asset, timeframe, strike_price, expiry_ts)
    }

    /// Activate a pending market by setting the strike price
    /// 
    /// Called when a market's trading window starts. Sets the real strike price
    /// from the current WebSocket feed and changes status from Pending to Open.
    /// 
    /// # Arguments
    /// * `strike_price` - The actual strike price (from live price feed)
    pub fn activate_market(
        ctx: Context<ActivateMarket>,
        strike_price: u64,
    ) -> Result<()> {
        instructions::activate_market(ctx, strike_price)
    }

    pub fn create_session_authority(
        ctx: Context<CreateSessionAuthority>,
        session_pubkey: Pubkey,
        expires_at: i64,
    ) -> Result<()> {
        instructions::create_session_authority(ctx, session_pubkey, expires_at)
    }

    pub fn create_session_authority_by_sig(
        ctx: Context<CreateSessionAuthorityBySig>,
        session_pubkey: Pubkey,
        expires_at: i64,
    ) -> Result<()> {
        instructions::create_session_authority_by_sig(ctx, session_pubkey, expires_at)
    }

    pub fn revoke_session_authority(ctx: Context<RevokeSessionAuthority>) -> Result<()> {
        instructions::revoke_session_authority(ctx)
    }

    /// Resolve a market with outcome from relayer
    /// 
    /// Called by keeper after market expiry. The relayer determines the outcome
    /// by comparing the final price (from Binance/Coinbase) to the strike price.
    /// 
    /// # Arguments
    /// * `args` - Resolution parameters (outcome, final_price)
    pub fn resolve_market(ctx: Context<ResolveMarket>, args: ResolveMarketArgs) -> Result<()> {
        instructions::resolve_market(ctx, args)
    }

    // =========================================================================
    // Trading Instructions
    // =========================================================================

    /// Place an order on-chain (creates Order PDA)
    /// 
    /// This instruction creates an on-chain order that can be matched by the relayer.
    /// The order is stored in a PDA, providing trustless order storage for users.
    /// 
    /// # Arguments
    /// * `args` - Order parameters (side, outcome, price, size, etc.)
    pub fn place_order(
        ctx: Context<PlaceOrder>,
        args: PlaceOrderArgs,
    ) -> Result<()> {
        instructions::place_order(ctx, args)
    }

    /// Cancel an order and return rent to owner
    /// 
    /// Only the order owner can cancel their order. The order must be active
    /// (Open or PartialFill status). Rent is returned to the owner.
    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        instructions::cancel_order(ctx)
    }

    /// Cancel an order after the market has closed, called by the market authority (relayer).
    ///
    /// This is used to recover user SOL rent + refund escrowed USDC when users leave open
    /// on-chain orders past market close/expiry.
    pub fn cancel_order_by_relayer(ctx: Context<CancelOrderByRelayer>) -> Result<()> {
        instructions::cancel_order_by_relayer(ctx)
    }

    /// Execute a match between maker and taker orders (Opening Trade)
    /// 
    /// This is the core trading instruction that atomically:
    /// 1. Validates both orders
    /// 2. Transfers USDC from both parties to vault
    /// 3. Updates position accounts with YES/NO shares
    /// 4. Collects trading fees
    /// 
    /// # Arguments
    /// * `maker_args` - Maker's order parameters
    /// * `taker_args` - Taker's order parameters  
    /// * `match_size` - Number of contracts to match
    /// * `taker_fee` - Fee amount in USDC (6 decimals), calculated by relayer using tiered structure
    pub fn execute_match(
        ctx: Context<ExecuteMatch>,
        maker_args: PlaceOrderArgs,
        taker_args: PlaceOrderArgs,
        match_size: u64,
        taker_fee: u64,
    ) -> Result<()> {
        instructions::execute_match(ctx, maker_args, taker_args, match_size, taker_fee)
    }

    /// Execute a closing trade (seller sells existing shares to buyer)
    /// 
    /// This instruction handles secondary market trades where:
    /// 1. Seller has existing shares they want to sell
    /// 2. Buyer pays seller directly (not through vault)
    /// 3. Shares transfer from seller to buyer
    /// 4. Open interest unchanged (no new shares minted)
    /// 
    /// # Arguments
    /// * `args` - Close trade parameters (outcome, price, size)
    pub fn execute_close(
        ctx: Context<ExecuteClose>,
        args: CloseTradeArgs,
    ) -> Result<()> {
        instructions::execute_close(ctx, args)
    }

    // =========================================================================
    // Settlement Instructions
    // =========================================================================

    /// Settle a user's position after market resolution
    /// 
    /// Pays out $1.00 per winning share to the user.
    /// Called by keeper in batches after resolve_market.
    pub fn settle_positions(ctx: Context<SettlePositions>) -> Result<()> {
        instructions::settle_positions(ctx)
    }

    /// Close a fully settled market and recover rent
    ///
    /// This instruction closes the market account and its vault after all positions
    /// have been settled. The rent (~0.006 SOL) is returned to the specified recipient.
    ///
    /// Requirements:
    /// - Market status must be `Settled` (all positions paid out)
    /// - Vault balance must be 0
    /// - Caller must be the market authority (relayer)
    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        instructions::close_market(ctx)
    }

    // =========================================================================
    // V2 INSTRUCTIONS (Tokenized Shares Model)
    // =========================================================================

    /// Create a new V2 market with tokenized YES/NO shares
    ///
    /// Unlike V1 which uses Position PDAs, V2 markets use Token-2022 tokens:
    /// - Creates YES token mint (Token-2022 + MintCloseAuthority, authority: market PDA)
    /// - Creates NO token mint (Token-2022 + MintCloseAuthority, authority: market PDA)
    /// - Users hold YES/NO tokens in Token-2022 ATAs
    /// - MintCloseAuthority allows rent recovery when market closes
    ///
    /// # Arguments
    /// * `asset` - Asset symbol (BTC, ETH, SOL)
    /// * `timeframe` - Market timeframe (5m, 15m, 1h, 4h, 24h)
    /// * `strike_price` - Strike price with 8 decimals (0 for pending markets)
    /// * `expiry_ts` - Unix timestamp when market expires
    pub fn initialize_market_v2(
        ctx: Context<InitializeMarketV2>,
        asset: String,
        timeframe: String,
        strike_price: u64,
        expiry_ts: i64,
    ) -> Result<()> {
        instructions::initialize_market_v2(ctx, asset, timeframe, strike_price, expiry_ts)
    }

    /// Finalize V2 market initialization (phase 2)
    ///
    /// Creates the NO token mint and USDC vault. This two-phase initialization
    /// is required to avoid stack overflow from too many init accounts.
    ///
    /// # Arguments
    /// * `strike_price` - Strike price (can override initial, or pass 0 to keep pending)
    pub fn initialize_market_v2_finalize(
        ctx: Context<InitializeMarketV2Finalize>,
        strike_price: u64,
    ) -> Result<()> {
        instructions::initialize_market_v2_finalize(ctx, strike_price)
    }

    /// Execute a match in a V2 market (tokenized shares)
    ///
    /// Instead of updating Position PDAs, this instruction:
    /// 1. Transfers USDC from both parties to vault
    /// 2. Mints YES tokens to the YES buyer
    /// 3. Mints NO tokens to the NO buyer
    /// 4. Collects trading fees
    ///
    /// # Arguments
    /// * `maker_args` - Maker's order parameters
    /// * `taker_args` - Taker's order parameters
    /// * `match_size` - Number of contracts to match
    /// * `taker_fee` - Fee amount in USDC (6 decimals)
    pub fn execute_match_v2(
        ctx: Context<ExecuteMatchV2>,
        maker_args: PlaceOrderArgs,
        taker_args: PlaceOrderArgs,
        match_size: u64,
        taker_fee: u64,
        maker_signer: Pubkey,
        taker_signer: Pubkey,
    ) -> Result<()> {
        instructions::execute_match_v2(ctx, maker_args, taker_args, match_size, taker_fee, maker_signer, taker_signer)
    }

    /// Execute a closing trade in a V2 market (token transfer)
    ///
    /// For secondary market trades where:
    /// 1. Seller has existing YES/NO tokens they want to sell
    /// 2. Buyer pays seller directly (not through vault)
    /// 3. Tokens transfer from seller to buyer
    /// 4. Open interest unchanged (no new tokens minted)
    ///
    /// # Arguments
    /// * `buyer_args` - Buy-side order parameters
    /// * `seller_args` - Sell-side order parameters
    /// * `match_size` - Number of shares matched
    /// * `taker_fee` - Fee amount in USDC (6 decimals)
    pub fn execute_close_v2(
        ctx: Context<ExecuteCloseV2>,
        buyer_args: PlaceOrderArgs,
        seller_args: PlaceOrderArgs,
        match_size: u64,
        taker_fee: u64,
        buyer_signer: Pubkey,
        seller_signer: Pubkey,
    ) -> Result<()> {
        instructions::execute_close_v2(ctx, buyer_args, seller_args, match_size, taker_fee, buyer_signer, seller_signer)
    }

    /// Activate a pending V2 market by setting the strike price
    ///
    /// Called when a market's trading window starts. Sets the real strike price
    /// from the current WebSocket feed and changes status from Pending to Open.
    ///
    /// # Arguments
    /// * `strike_price` - The actual strike price (from live price feed)
    pub fn activate_market_v2(
        ctx: Context<ActivateMarketV2>,
        strike_price: u64,
    ) -> Result<()> {
        instructions::activate_market_v2(ctx, strike_price)
    }

    /// Resolve a V2 market with outcome from relayer
    ///
    /// Called by keeper after market expiry. The relayer determines the outcome
    /// by comparing the final price (from Binance/Coinbase) to the strike price.
    /// After resolution, market enters RESOLVED status, ready for merkle settlement.
    ///
    /// # Arguments
    /// * `args` - Resolution parameters (outcome, final_price)
    pub fn resolve_market_v2(ctx: Context<ResolveMarketV2>, args: ResolveMarketArgsV2) -> Result<()> {
        instructions::resolve_market_v2(ctx, args)
    }

    // =========================================================================
    // V2 MERKLE SETTLEMENT INSTRUCTIONS
    // =========================================================================

    /// Post the merkle root to begin batch settlement
    ///
    /// After market resolution, the keeper builds a merkle tree off-chain with all
    /// (recipient, payout) pairs and posts the root here. This transitions the
    /// market from RESOLVED to SETTLING status.
    ///
    /// # Arguments
    /// * `args` - Merkle root, total amount, and settlement count
    pub fn post_merkle_root(ctx: Context<PostMerkleRoot>, args: PostMerkleRootArgs) -> Result<()> {
        instructions::post_merkle_root(ctx, args)
    }

    /// Initialize an additional settlement bitmap chunk for large markets.
    pub fn init_settlement_bitmap(
        ctx: Context<InitSettlementBitmap>,
        chunk_index: u16,
    ) -> Result<()> {
        instructions::init_settlement_bitmap(ctx, chunk_index)
    }

    /// Atomically resolve a V2 market AND post the merkle root in one TX
    ///
    /// Combines resolve_market_v2 + post_merkle_root into a single instruction,
    /// saving ~2s by eliminating one full TX round-trip. The market transitions
    /// directly from Open/Closed to SETTLING status.
    ///
    /// # Arguments
    /// * `args` - Combined resolution + merkle root parameters
    pub fn resolve_and_post_merkle_root_v2(
        ctx: Context<ResolveAndPostMerkleRootV2>,
        args: ResolveAndPostMerkleRootArgsV2,
    ) -> Result<()> {
        instructions::resolve_and_post_merkle_root_v2(ctx, args)
    }

    /// Batch settle multiple users with merkle proofs
    ///
    /// Settles up to 15 users in one transaction. Each settlement is verified
    /// against the merkle root before payout. A bitmap tracks claimed leaves
    /// to prevent double-settlement.
    ///
    /// # Arguments
    /// * `settlements` - Vector of settlement entries with proofs
    pub fn batch_settle_v2<'info>(
        ctx: Context<'_, '_, 'info, 'info, BatchSettleV2<'info>>,
        settlements: Vec<SettlementEntry>,
    ) -> Result<()> {
        instructions::batch_settle_v2(ctx, settlements)
    }

    /// Compact batch settle using shared subtree proofs (V3)
    ///
    /// Settles up to 16 consecutive users in one TX using a single shared
    /// bridge proof instead of individual full proofs. The on-chain program
    /// reconstructs the subtree from (recipient, amount) pairs and verifies
    /// the bridge proof against the global merkle root.
    ///
    /// This is 4-8x more TX-efficient than V2 for large markets.
    ///
    /// # Arguments
    /// * `settlement` - Compact batch data (start_index, amounts, bridge_proof)
    pub fn batch_settle_v3<'info>(
        ctx: Context<'_, '_, 'info, 'info, BatchSettleV3<'info>>,
        settlement: CompactBatchSettlement,
    ) -> Result<()> {
        instructions::batch_settle_v3(ctx, settlement)
    }

    /// Burn remaining share tokens from user ATAs using PermanentDelegate
    ///
    /// Called after batch_settle_v2 completes and before finalize_market_v2.
    /// Burns all YES/NO tokens from the passed remaining_accounts, bringing
    /// mint supply to 0 so mints can be closed during finalize.
    pub fn burn_remaining_shares_v2<'info>(
        ctx: Context<'_, '_, 'info, 'info, BurnRemainingSharesV2<'info>>,
    ) -> Result<()> {
        instructions::burn_remaining_shares_v2(ctx)
    }

    /// Finalize a V2 market after all settlements are complete
    ///
    /// This instruction verifies all settlements are done, closes the vault,
    /// closes YES/NO mints (Token-2022 MintCloseAuthority), recovers all rent,
    /// and transitions market to SETTLED status.
    pub fn finalize_market_v2<'info>(
        ctx: Context<'_, '_, 'info, 'info, FinalizeMarketV2<'info>>,
    ) -> Result<()> {
        instructions::finalize_market_v2(ctx)
    }

    /// Close a V2 market that has no trading activity
    ///
    /// For zero-trade markets, this skips the merkle settlement flow and
    /// directly closes the vault, YES/NO mints (Token-2022), and market PDA.
    /// Recovers all rent. Market must be RESOLVED with open_interest = 0.
    pub fn close_market_v2(ctx: Context<CloseMarketV2>) -> Result<()> {
        instructions::close_market_v2(ctx)
    }
}
