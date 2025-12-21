use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{GlobalState, Market, UserPosition, Side, Outcome, MarketStatus, TradeType, USDC_MULTIPLIER, SHARE_MULTIPLIER, MAX_POSITION_SIZE, MIN_PRICE, MAX_PRICE, MIN_ORDER_SIZE, MAX_ORDER_SIZE};
use crate::errors::DegenError;

/// Arguments for execute_close instruction
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CloseTradeArgs {
    pub outcome: Outcome,      // YES or NO being sold
    pub price: u64,            // Execution price (6 decimals)
    pub size: u64,             // Number of shares (6 decimals)
}

#[derive(Accounts)]
pub struct ExecuteClose<'info> {
    #[account(
        seeds = [GlobalState::SEED],
        bump = global_state.bump
    )]
    pub global_state: Box<Account<'info, GlobalState>>,
    
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    
    /// Fee recipient's USDC account
    #[account(
        mut,
        constraint = fee_recipient.owner == global_state.fee_recipient @ DegenError::Unauthorized
    )]
    pub fee_recipient: Box<Account<'info, TokenAccount>>,
    
    // Buyer (BID side - paying USDC, receiving shares)
    /// CHECK: Buyer wallet - validated by relayer
    pub buyer: AccountInfo<'info>,
    
    #[account(
        mut,
        seeds = [UserPosition::SEED, market.key().as_ref(), buyer.key().as_ref()],
        bump = buyer_position.bump,
        constraint = buyer_position.owner == buyer.key() @ DegenError::Unauthorized
    )]
    pub buyer_position: Box<Account<'info, UserPosition>>,
    
    /// Buyer's USDC account (source of payment)
    #[account(
        mut,
        constraint = buyer_usdc.owner == buyer.key() @ DegenError::Unauthorized
    )]
    pub buyer_usdc: Box<Account<'info, TokenAccount>>,
    
    // Seller (ASK side - selling shares, receiving USDC)
    /// CHECK: Seller wallet - validated by relayer
    pub seller: AccountInfo<'info>,
    
    #[account(
        mut,
        seeds = [UserPosition::SEED, market.key().as_ref(), seller.key().as_ref()],
        bump = seller_position.bump,
        constraint = seller_position.owner == seller.key() @ DegenError::Unauthorized
    )]
    pub seller_position: Box<Account<'info, UserPosition>>,
    
    /// Seller's USDC account (receives payment)
    #[account(
        mut,
        constraint = seller_usdc.owner == seller.key() @ DegenError::Unauthorized
    )]
    pub seller_usdc: Box<Account<'info, TokenAccount>>,
    
    /// Relayer that submits the tx (delegate for MM transfers)
    #[account(mut)]
    pub relayer: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

pub fn execute_close(
    ctx: Context<ExecuteClose>,
    args: CloseTradeArgs,
) -> Result<()> {
    let global_state = &ctx.accounts.global_state;
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;
    
    // Validations
    require!(!global_state.paused, DegenError::ProtocolPaused);
    require!(market.status == MarketStatus::Open, DegenError::MarketNotOpen);
    require!(market.is_trading_open(clock.unix_timestamp), DegenError::MarketClosing);
    require!(ctx.accounts.buyer.key() != ctx.accounts.seller.key(), DegenError::SelfTrade);
    require!(args.price >= MIN_PRICE && args.price <= MAX_PRICE, DegenError::InvalidPrice);
    require!(args.size >= MIN_ORDER_SIZE && args.size <= MAX_ORDER_SIZE, DegenError::InvalidSize);
    
    let seller_position = &mut ctx.accounts.seller_position;
    let buyer_position = &mut ctx.accounts.buyer_position;
    
    // Validate seller has enough shares
    let seller_shares = match args.outcome {
        Outcome::Yes => seller_position.yes_shares,
        Outcome::No => seller_position.no_shares,
    };
    require!(seller_shares >= args.size, DegenError::InsufficientShares);
    
    // Check buyer position limit
    let buyer_new_shares = match args.outcome {
        Outcome::Yes => buyer_position.yes_shares.checked_add(args.size).ok_or(DegenError::MathOverflow)?,
        Outcome::No => buyer_position.no_shares.checked_add(args.size).ok_or(DegenError::MathOverflow)?,
    };
    require!(buyer_new_shares <= MAX_POSITION_SIZE, DegenError::PositionLimitExceeded);
    
    // Calculate transfer amount: price * size / SHARE_MULTIPLIER
    let transfer_amount = args.price
        .checked_mul(args.size).ok_or(DegenError::MathOverflow)?
        .checked_add(SHARE_MULTIPLIER - 1).ok_or(DegenError::MathOverflow)?
        .checked_div(SHARE_MULTIPLIER).ok_or(DegenError::DivisionByZero)?;
    
    // Calculate fee (taker fee on buyer)
    let fee = transfer_amount
        .checked_mul(global_state.taker_fee_bps as u64).ok_or(DegenError::MathOverflow)?
        .checked_div(10_000).ok_or(DegenError::DivisionByZero)?;
    
    let seller_receives = transfer_amount.saturating_sub(fee);
    
    // Transfer USDC from buyer to seller (using relayer as delegate)
    msg!("Closing trade: {} USDC from buyer to seller", seller_receives);
    let cpi_accounts = Transfer {
        from: ctx.accounts.buyer_usdc.to_account_info(),
        to: ctx.accounts.seller_usdc.to_account_info(),
        authority: ctx.accounts.relayer.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, seller_receives)?;
    
    // Transfer fee from buyer to fee recipient
    if fee > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.buyer_usdc.to_account_info(),
            to: ctx.accounts.fee_recipient.to_account_info(),
            authority: ctx.accounts.relayer.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, fee)?;
    }
    
    // Calculate seller's realized PnL
    let seller_cost_basis = match args.outcome {
        Outcome::Yes => seller_position.yes_cost_basis,
        Outcome::No => seller_position.no_cost_basis,
    };
    let cost_per_share = if seller_shares > 0 {
        seller_cost_basis.checked_div(seller_shares).unwrap_or(0)
    } else {
        0
    };
    let cost_basis_sold = cost_per_share
        .checked_mul(args.size).ok_or(DegenError::MathOverflow)?
        .checked_div(SHARE_MULTIPLIER).ok_or(DegenError::DivisionByZero)?;
    let realized_pnl = (transfer_amount as i64).checked_sub(cost_basis_sold as i64).unwrap_or(0);
    
    // Update seller position: reduce shares, add realized PnL
    match args.outcome {
        Outcome::Yes => {
            seller_position.yes_shares = seller_position.yes_shares.checked_sub(args.size).ok_or(DegenError::MathOverflow)?;
            // Reduce cost basis proportionally
            let cost_reduction = seller_cost_basis
                .checked_mul(args.size).ok_or(DegenError::MathOverflow)?
                .checked_div(seller_shares).ok_or(DegenError::DivisionByZero)?;
            seller_position.yes_cost_basis = seller_position.yes_cost_basis.saturating_sub(cost_reduction);
        }
        Outcome::No => {
            seller_position.no_shares = seller_position.no_shares.checked_sub(args.size).ok_or(DegenError::MathOverflow)?;
            let cost_reduction = seller_cost_basis
                .checked_mul(args.size).ok_or(DegenError::MathOverflow)?
                .checked_div(seller_shares).ok_or(DegenError::DivisionByZero)?;
            seller_position.no_cost_basis = seller_position.no_cost_basis.saturating_sub(cost_reduction);
        }
    }
    seller_position.realized_pnl = seller_position.realized_pnl.checked_add(realized_pnl).unwrap_or(seller_position.realized_pnl);
    
    // Update buyer position: add shares and cost basis
    let buyer_total_cost = transfer_amount.checked_add(fee).ok_or(DegenError::MathOverflow)?;
    match args.outcome {
        Outcome::Yes => {
            buyer_position.yes_shares = buyer_position.yes_shares.checked_add(args.size).ok_or(DegenError::MathOverflow)?;
            buyer_position.yes_cost_basis = buyer_position.yes_cost_basis.checked_add(buyer_total_cost).ok_or(DegenError::MathOverflow)?;
        }
        Outcome::No => {
            buyer_position.no_shares = buyer_position.no_shares.checked_add(args.size).ok_or(DegenError::MathOverflow)?;
            buyer_position.no_cost_basis = buyer_position.no_cost_basis.checked_add(buyer_total_cost).ok_or(DegenError::MathOverflow)?;
        }
    }
    
    // Update market stats (volume increases, open_interest unchanged)
    market.total_volume = market.total_volume.checked_add(transfer_amount).ok_or(DegenError::MathOverflow)?;
    market.total_trades = market.total_trades.checked_add(1).ok_or(DegenError::MathOverflow)?;
    
    msg!("Close executed: {} {:?} shares @ {} (transfer={}, fee={})", 
         args.size, args.outcome, args.price, transfer_amount, fee);
    
    emit!(CloseExecuted {
        market: market.key(),
        buyer: ctx.accounts.buyer.key(),
        seller: ctx.accounts.seller.key(),
        outcome: args.outcome,
        price: args.price,
        size: args.size,
        transfer_amount,
        fee,
        seller_realized_pnl: realized_pnl,
    });
    
    Ok(())
}

#[event]
pub struct CloseExecuted {
    pub market: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub outcome: Outcome,
    pub price: u64,
    pub size: u64,
    pub transfer_amount: u64,
    pub fee: u64,
    pub seller_realized_pnl: i64,
}

