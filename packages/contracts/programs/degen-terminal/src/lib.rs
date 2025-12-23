use anchor_lang::prelude::*;

declare_id!("5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk");

pub mod state;
pub mod instructions;
pub mod errors;

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
    /// * `taker_fee_bps` - Optional new taker fee in basis points
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
    /// # Arguments
    /// * `asset` - Asset symbol (BTC, ETH, SOL)
    /// * `timeframe` - Market timeframe (5m, 15m, 1h, 4h)
    /// * `strike_price` - Strike price with 8 decimals
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
    pub fn execute_match(
        ctx: Context<ExecuteMatch>,
        maker_args: PlaceOrderArgs,
        taker_args: PlaceOrderArgs,
        match_size: u64,
    ) -> Result<()> {
        instructions::execute_match(ctx, maker_args, taker_args, match_size)
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
}
