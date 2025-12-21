use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{GlobalState, Market, UserPosition, Order, OrderStatus, Side, Outcome, MarketStatus, TradeType, USDC_MULTIPLIER, SHARE_MULTIPLIER, MAX_POSITION_SIZE, MIN_PRICE, MAX_PRICE, MIN_ORDER_SIZE, MAX_ORDER_SIZE};
use crate::instructions::PlaceOrderArgs;
use crate::errors::DegenError;

#[derive(Accounts)]
pub struct ExecuteMatch<'info> {
    #[account(
        seeds = [GlobalState::SEED],
        bump = global_state.bump
    )]
    pub global_state: Box<Account<'info, GlobalState>>,
    
    /// Market account - validated by Anchor's account discriminator check
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    
    /// Market's USDC vault - validated to be owned by market PDA
    #[account(
        mut,
        constraint = vault.owner == market.key() @ DegenError::InvalidMarketParams
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    
    /// Fee recipient's USDC account - validated against global state
    #[account(
        mut,
        constraint = fee_recipient.owner == global_state.fee_recipient @ DegenError::Unauthorized
    )]
    pub fee_recipient: Box<Account<'info, TokenAccount>>,
    
    // Maker accounts
    /// CHECK: Maker wallet - trusted by relayer (user orders verified via place_order)
    pub maker: AccountInfo<'info>,
    
    #[account(
        init_if_needed,
        payer = relayer,
        space = UserPosition::SIZE,
        seeds = [UserPosition::SEED, market.key().as_ref(), maker.key().as_ref()],
        bump
    )]
    pub maker_position: Box<Account<'info, UserPosition>>,
    
    /// Maker's USDC account - validated to be owned by maker
    #[account(
        mut,
        constraint = maker_usdc.owner == maker.key() @ DegenError::Unauthorized
    )]
    pub maker_usdc: Box<Account<'info, TokenAccount>>,
    
    /// Maker's Order PDA (optional - only for user orders, not MM)
    /// If provided, USDC is already locked in vault. Mutable to update filled_size.
    #[account(mut)]
    pub maker_order: Option<Account<'info, Order>>,
    
    // Taker accounts
    /// CHECK: Taker wallet - trusted by relayer (user orders verified via place_order)
    pub taker: AccountInfo<'info>,
    
    #[account(
        init_if_needed,
        payer = relayer,
        space = UserPosition::SIZE,
        seeds = [UserPosition::SEED, market.key().as_ref(), taker.key().as_ref()],
        bump
    )]
    pub taker_position: Box<Account<'info, UserPosition>>,
    
    /// Taker's USDC account - validated to be owned by taker
    #[account(
        mut,
        constraint = taker_usdc.owner == taker.key() @ DegenError::Unauthorized
    )]
    pub taker_usdc: Box<Account<'info, TokenAccount>>,
    
    /// Taker's Order PDA (optional - only for user orders, not MM)
    /// If provided, USDC is already locked in vault. Mutable to update filled_size.
    #[account(mut)]
    pub taker_order: Option<Account<'info, Order>>,
    
    /// Seller's USDC receive account (optional - reserved for future closing trades)
    /// Currently unused - all trades are opening trades
    #[account(mut)]
    pub seller_usdc_receive: Option<Account<'info, TokenAccount>>,
    
    /// Relayer that pays for account creation and submits the tx
    /// Also used as delegate authority for MM token transfers
    #[account(mut)]
    pub relayer: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn execute_match(
    ctx: Context<ExecuteMatch>,
    maker_args: PlaceOrderArgs,
    taker_args: PlaceOrderArgs,
    match_size: u64,
) -> Result<()> {
    let global_state = &ctx.accounts.global_state;
    let market_info = ctx.accounts.market.to_account_info();
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;
    
    // Get order data - prefer Order PDA if available, otherwise use args
    let maker_has_order = ctx.accounts.maker_order.is_some();
    let taker_has_order = ctx.accounts.taker_order.is_some();
    let maker_has_escrow = maker_has_order;
    let taker_has_escrow = taker_has_order;
    
    // Extract order parameters
    let (maker_side, maker_outcome, maker_price, maker_size, maker_expiry) = if let Some(ref order) = ctx.accounts.maker_order {
        require!(order.owner == ctx.accounts.maker.key(), DegenError::Unauthorized);
        require!(order.market == market.key(), DegenError::InvalidMarketParams);
        require!(order.is_active(), DegenError::OrderNotActive);
        (order.side, order.outcome, order.price, order.size, order.expiry_ts)
    } else {
        (maker_args.side, maker_args.outcome, maker_args.price, maker_args.size, maker_args.expiry_ts)
    };
    
    let (taker_side, taker_outcome, taker_price, taker_size, taker_expiry) = if let Some(ref order) = ctx.accounts.taker_order {
        require!(order.owner == ctx.accounts.taker.key(), DegenError::Unauthorized);
        require!(order.market == market.key(), DegenError::InvalidMarketParams);
        require!(order.is_active(), DegenError::OrderNotActive);
        (order.side, order.outcome, order.price, order.size, order.expiry_ts)
    } else {
        (taker_args.side, taker_args.outcome, taker_args.price, taker_args.size, taker_args.expiry_ts)
    };
    
    msg!("Executing match: maker_has_order={}, taker_has_order={}", maker_has_order, taker_has_order);
    
    // Validations
    require!(!global_state.paused, DegenError::ProtocolPaused);
    require!(market.status == MarketStatus::Open, DegenError::MarketNotOpen);
    require!(market.is_trading_open(clock.unix_timestamp), DegenError::MarketClosing);
    require!(ctx.accounts.maker.key() != ctx.accounts.taker.key(), DegenError::SelfTrade);
    require!(maker_side != taker_side, DegenError::SameSide);
    require!(maker_outcome == taker_outcome, DegenError::OutcomeMismatch);
    require!(maker_expiry > clock.unix_timestamp, DegenError::OrderExpired);
    require!(taker_expiry > clock.unix_timestamp, DegenError::OrderExpired);
    require!(maker_price >= MIN_PRICE && maker_price <= MAX_PRICE, DegenError::InvalidPrice);
    require!(taker_price >= MIN_PRICE && taker_price <= MAX_PRICE, DegenError::InvalidPrice);
    require!(maker_size >= MIN_ORDER_SIZE && maker_size <= MAX_ORDER_SIZE, DegenError::InvalidSize);
    require!(taker_size >= MIN_ORDER_SIZE && taker_size <= MAX_ORDER_SIZE, DegenError::InvalidSize);
    require!(match_size >= MIN_ORDER_SIZE && match_size <= MAX_ORDER_SIZE, DegenError::InvalidSize);
    
    // Price validation - orders must cross
    let execution_price = maker_price;
    if maker_side == Side::Bid {
        require!(taker_price <= maker_price, DegenError::PriceMismatch);
    } else {
        require!(taker_price >= maker_price, DegenError::PriceMismatch);
    }
    
    // Calculate costs
    let outcome = maker_outcome;
    let yes_price = if outcome == Outcome::Yes { execution_price } else { USDC_MULTIPLIER - execution_price };
    let no_price = USDC_MULTIPLIER - yes_price;
    
    let yes_cost = yes_price
        .checked_mul(match_size).ok_or(DegenError::MathOverflow)?
        .checked_add(SHARE_MULTIPLIER - 1).ok_or(DegenError::MathOverflow)?
        .checked_div(SHARE_MULTIPLIER).ok_or(DegenError::DivisionByZero)?;
    
    let no_cost = no_price
        .checked_mul(match_size).ok_or(DegenError::MathOverflow)?
        .checked_add(SHARE_MULTIPLIER - 1).ok_or(DegenError::MathOverflow)?
        .checked_div(SHARE_MULTIPLIER).ok_or(DegenError::DivisionByZero)?;
    
    // Determine YES/NO buyers
    let is_maker_yes_buyer = (maker_side == Side::Bid && outcome == Outcome::Yes) ||
                             (maker_side == Side::Ask && outcome == Outcome::No);
    
    // Position references
    let maker_position = &mut ctx.accounts.maker_position;
    let taker_position = &mut ctx.accounts.taker_position;
    
    // Position limit checks
    if is_maker_yes_buyer {
        require!(
            maker_position.yes_shares.checked_add(match_size).ok_or(DegenError::MathOverflow)? <= MAX_POSITION_SIZE,
            DegenError::PositionLimitExceeded
        );
        require!(
            taker_position.no_shares.checked_add(match_size).ok_or(DegenError::MathOverflow)? <= MAX_POSITION_SIZE,
            DegenError::PositionLimitExceeded
        );
    } else {
        require!(
            taker_position.yes_shares.checked_add(match_size).ok_or(DegenError::MathOverflow)? <= MAX_POSITION_SIZE,
            DegenError::PositionLimitExceeded
        );
        require!(
            maker_position.no_shares.checked_add(match_size).ok_or(DegenError::MathOverflow)? <= MAX_POSITION_SIZE,
            DegenError::PositionLimitExceeded
        );
    }
    
    // Calculate fees
    let taker_fee = if is_maker_yes_buyer {
        no_cost.checked_mul(global_state.taker_fee_bps as u64).ok_or(DegenError::MathOverflow)?
            .checked_div(10_000).ok_or(DegenError::DivisionByZero)?
    } else {
        yes_cost.checked_mul(global_state.taker_fee_bps as u64).ok_or(DegenError::MathOverflow)?
            .checked_div(10_000).ok_or(DegenError::DivisionByZero)?
    };
    
    // Calculate costs
    let (maker_cost, taker_cost) = if is_maker_yes_buyer {
        (yes_cost, no_cost.checked_add(taker_fee).ok_or(DegenError::MathOverflow)?)
    } else {
        (no_cost, yes_cost.checked_add(taker_fee).ok_or(DegenError::MathOverflow)?)
    };
    
    // Token transfers - Opening trade: both parties deposit USDC to vault
    if !maker_has_escrow {
        msg!("Transferring {} USDC from maker via delegation", maker_cost);
        let cpi_accounts = Transfer {
            from: ctx.accounts.maker_usdc.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.relayer.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, maker_cost)?;
    }
    
    if !taker_has_escrow {
        msg!("Transferring {} USDC from taker via delegation", taker_cost);
        let cpi_accounts = Transfer {
            from: ctx.accounts.taker_usdc.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.relayer.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, taker_cost)?;
    }
    
    // Transfer fees
    if taker_fee > 0 {
        let market_seeds = &[
            Market::SEED,
            market.asset_bytes(),
            market.timeframe_bytes(),
            &market.expiry_at.to_le_bytes(),
            &[market.bump],
        ];
        let signer_seeds = &[&market_seeds[..]];
        
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.fee_recipient.to_account_info(),
            authority: market_info.clone(),
        };
        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, taker_fee)?;
    }
    
    // Update Order PDAs
    if let Some(ref mut maker_order) = ctx.accounts.maker_order {
        maker_order.filled_size = maker_order.filled_size.checked_add(match_size).ok_or(DegenError::MathOverflow)?;
        maker_order.status = if maker_order.filled_size >= maker_order.size { OrderStatus::Filled } else { OrderStatus::PartialFill };
    }
    
    if let Some(ref mut taker_order) = ctx.accounts.taker_order {
        taker_order.filled_size = taker_order.filled_size.checked_add(match_size).ok_or(DegenError::MathOverflow)?;
        taker_order.status = if taker_order.filled_size >= taker_order.size { OrderStatus::Filled } else { OrderStatus::PartialFill };
    }
    
    // Initialize positions if needed
    if maker_position.owner == Pubkey::default() {
        maker_position.owner = ctx.accounts.maker.key();
        maker_position.market = market.key();
        maker_position.bump = ctx.bumps.maker_position;
        market.total_positions += 1;
    }
    
    if taker_position.owner == Pubkey::default() {
        taker_position.owner = ctx.accounts.taker.key();
        taker_position.market = market.key();
        taker_position.bump = ctx.bumps.taker_position;
        market.total_positions += 1;
    }
    
    // Update positions - Opening trade: mint new shares
    if is_maker_yes_buyer {
        maker_position.yes_shares = maker_position.yes_shares.checked_add(match_size).ok_or(DegenError::MathOverflow)?;
        maker_position.yes_cost_basis = maker_position.yes_cost_basis.checked_add(yes_cost).ok_or(DegenError::MathOverflow)?;
        taker_position.no_shares = taker_position.no_shares.checked_add(match_size).ok_or(DegenError::MathOverflow)?;
        taker_position.no_cost_basis = taker_position.no_cost_basis.checked_add(no_cost.checked_add(taker_fee).ok_or(DegenError::MathOverflow)?).ok_or(DegenError::MathOverflow)?;
    } else {
        taker_position.yes_shares = taker_position.yes_shares.checked_add(match_size).ok_or(DegenError::MathOverflow)?;
        taker_position.yes_cost_basis = taker_position.yes_cost_basis.checked_add(yes_cost.checked_add(taker_fee).ok_or(DegenError::MathOverflow)?).ok_or(DegenError::MathOverflow)?;
        maker_position.no_shares = maker_position.no_shares.checked_add(match_size).ok_or(DegenError::MathOverflow)?;
        maker_position.no_cost_basis = maker_position.no_cost_basis.checked_add(no_cost).ok_or(DegenError::MathOverflow)?;
    }
    
    // Update market stats
    market.open_interest = market.open_interest.checked_add(match_size).ok_or(DegenError::MathOverflow)?;
    market.total_volume = market.total_volume.checked_add(yes_cost.checked_add(no_cost).ok_or(DegenError::MathOverflow)?).ok_or(DegenError::MathOverflow)?;
    market.total_trades = market.total_trades.checked_add(1).ok_or(DegenError::MathOverflow)?;
    
    msg!("Match executed: {} shares @ {} (yes={}, no={}, fee={})", match_size, execution_price, yes_cost, no_cost, taker_fee);
    
    emit!(MatchExecuted {
        market: market.key(),
        maker: ctx.accounts.maker.key(),
        taker: ctx.accounts.taker.key(),
        outcome,
        price: execution_price,
        size: match_size,
        yes_cost,
        no_cost,
        taker_fee,
        maker_has_escrow,
        taker_has_escrow,
        trade_type: TradeType::Opening,
    });
    
    Ok(())
}

#[event]
pub struct MatchExecuted {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub outcome: Outcome,
    pub price: u64,
    pub size: u64,
    pub yes_cost: u64,
    pub no_cost: u64,
    pub taker_fee: u64,
    pub maker_has_escrow: bool,
    pub taker_has_escrow: bool,
    pub trade_type: TradeType,
}
