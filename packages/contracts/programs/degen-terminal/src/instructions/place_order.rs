use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use crate::state::{GlobalState, Market, Order, OrderStatus, Side, Outcome, OrderType, USDC_MULTIPLIER, SHARE_MULTIPLIER, MIN_PRICE, MAX_PRICE, MIN_ORDER_SIZE, MAX_ORDER_SIZE};
use crate::errors::DegenError;

/// Arguments for placing an order
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PlaceOrderArgs {
    /// Order side (Bid = buy, Ask = sell)
    pub side: Side,
    /// Outcome being traded (Yes or No)
    pub outcome: Outcome,
    /// Order type (Limit, Market, IOC, FOK)
    pub order_type: OrderType,
    /// Limit price in 6 decimals (500_000 = $0.50)
    pub price: u64,
    /// Number of contracts
    pub size: u64,
    /// Order expiration timestamp
    pub expiry_ts: i64,
    /// Client-provided order ID (for replay protection)
    pub client_order_id: u64,
}

#[derive(Accounts)]
#[instruction(args: PlaceOrderArgs)]
pub struct PlaceOrder<'info> {
    #[account(
        seeds = [GlobalState::SEED],
        bump = global_state.bump
    )]
    pub global_state: Account<'info, GlobalState>,
    
    #[account(
        constraint = market.is_trading_open(Clock::get()?.unix_timestamp) @ DegenError::MarketNotOpen
    )]
    pub market: Account<'info, Market>,
    
    /// The order account to be created (PDA)
    #[account(
        init,
        payer = user,
        space = Order::SIZE,
        seeds = [
            Order::SEED,
            market.key().as_ref(),
            user.key().as_ref(),
            &args.client_order_id.to_le_bytes()
        ],
        bump
    )]
    pub order: Account<'info, Order>,
    
    /// Market's USDC vault - holds escrowed funds
    #[account(
        mut,
        constraint = vault.owner == market.key() @ DegenError::InvalidMarketParams
    )]
    pub vault: Account<'info, TokenAccount>,
    
    /// User's USDC token account
    #[account(
        mut,
        constraint = user_usdc.owner == user.key() @ DegenError::Unauthorized
    )]
    pub user_usdc: Account<'info, TokenAccount>,
    
    /// The user placing the order (must sign and pay for account creation)
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Place an order on-chain (creates Order PDA and locks USDC)
/// 
/// This instruction:
/// 1. Creates an on-chain Order PDA
/// 2. Transfers USDC from user to market vault (escrow)
/// 3. The escrowed USDC is used when the order matches
pub fn place_order(
    ctx: Context<PlaceOrder>,
    args: PlaceOrderArgs,
) -> Result<()> {
    let global_state = &ctx.accounts.global_state;
    let order = &mut ctx.accounts.order;
    let clock = Clock::get()?;
    
    // Check protocol is not paused
    require!(!global_state.paused, DegenError::ProtocolPaused);
    
    // Validate price ($0.01 - $0.99)
    require!(args.price >= MIN_PRICE && args.price <= MAX_PRICE, DegenError::InvalidPrice);
    
    // Validate price is on tick grid ($0.01 increments = 10_000 in 6 decimals)
    require!(args.price % 10_000 == 0, DegenError::InvalidTickSize);
    
    // Validate size (1 - 100,000 contracts)
    require!(args.size >= MIN_ORDER_SIZE && args.size <= MAX_ORDER_SIZE, DegenError::InvalidSize);
    
    // Check order hasn't expired (for limit orders)
    if args.order_type == OrderType::Limit {
        require!(args.expiry_ts > clock.unix_timestamp, DegenError::OrderExpired);
    }
    
    // Calculate the USDC amount to lock based on order side
    // Price is in 6 decimals (e.g., 500_000 = $0.50)
    // Size is in 6 decimals (e.g., 192_307_692 = 192.3 contracts)
    // Result should be in USDC smallest units (6 decimals)
    // 
    // Example: price=500_000 ($0.50), size=100_000_000 (100 contracts)
    // Cost = (500_000 * 100_000_000) / 1_000_000 = 50_000_000 = $50 USDC ✓
    //
    // For BID (buying): lock price * size / SHARE_MULTIPLIER
    // For ASK (selling): lock (1 - price) * size / SHARE_MULTIPLIER
    let lock_amount = if args.side == Side::Bid {
        // Buying: lock price * size / SHARE_MULTIPLIER
        args.price
            .checked_mul(args.size)
            .ok_or(DegenError::MathOverflow)?
            .checked_add(SHARE_MULTIPLIER - 1)  // Round up
            .ok_or(DegenError::MathOverflow)?
            .checked_div(SHARE_MULTIPLIER)
            .ok_or(DegenError::DivisionByZero)?
    } else {
        // Selling: lock (1 - price) * size / SHARE_MULTIPLIER
        (USDC_MULTIPLIER - args.price)
            .checked_mul(args.size)
            .ok_or(DegenError::MathOverflow)?
            .checked_add(SHARE_MULTIPLIER - 1)  // Round up
            .ok_or(DegenError::MathOverflow)?
            .checked_div(SHARE_MULTIPLIER)
            .ok_or(DegenError::DivisionByZero)?
    };
    
    // Verify user has sufficient balance
    require!(
        ctx.accounts.user_usdc.amount >= lock_amount,
        DegenError::InsufficientBalance
    );
    
    // Transfer USDC from user to vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.user_usdc.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    token::transfer(cpi_ctx, lock_amount)?;
    
    msg!("Locked {} USDC in vault for order", lock_amount);
    
    // Initialize the order account
    order.owner = ctx.accounts.user.key();
    order.market = ctx.accounts.market.key();
    order.side = args.side;
    order.outcome = args.outcome;
    order.order_type = args.order_type;
    order.price = args.price;
    order.size = args.size;
    order.filled_size = 0;
    order.status = OrderStatus::Open;
    order.client_order_id = args.client_order_id;
    order.expiry_ts = args.expiry_ts;
    order.created_at = clock.unix_timestamp;
    order.bump = ctx.bumps.order;
    order.locked_amount = lock_amount;  // Track locked USDC
    
    msg!(
        "Order placed: order={} user={} {:?} {:?} {}@{} locked={} (client_id={})",
        ctx.accounts.order.key(),
        ctx.accounts.user.key(),
        args.side,
        args.outcome,
        args.size,
        args.price,
        lock_amount,
        args.client_order_id
    );
    
    // Emit event for backend to listen
    emit!(OrderPlaced {
        order: ctx.accounts.order.key(),
        owner: ctx.accounts.user.key(),
        market: ctx.accounts.market.key(),
        side: args.side,
        outcome: args.outcome,
        order_type: args.order_type,
        price: args.price,
        size: args.size,
        locked_amount: lock_amount,
        client_order_id: args.client_order_id,
        expiry_ts: args.expiry_ts,
        created_at: clock.unix_timestamp,
    });
    
    Ok(())
}

// ============================================================================
// EVENTS
// ============================================================================

#[event]
pub struct OrderPlaced {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: Side,
    pub outcome: Outcome,
    pub order_type: OrderType,
    pub price: u64,
    pub size: u64,
    pub locked_amount: u64,
    pub client_order_id: u64,
    pub expiry_ts: i64,
    pub created_at: i64,
}
