use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{Market, Order, TRADING_CLOSE_BUFFER};
use crate::errors::DegenError;

#[derive(Accounts)]
pub struct CancelOrderByRelayer<'info> {
    /// The market for this order
    #[account(
        constraint = market.key() == order.market @ DegenError::InvalidMarketParams
    )]
    pub market: Account<'info, Market>,
    
    /// Market's USDC vault - holds escrowed funds
    #[account(
        mut,
        constraint = vault.owner == market.key() @ DegenError::InvalidMarketParams
    )]
    pub vault: Account<'info, TokenAccount>,
    
    /// User's USDC token account - will receive refund
    #[account(
        mut,
        constraint = user_usdc.owner == owner.key() @ DegenError::Unauthorized
    )]
    pub user_usdc: Account<'info, TokenAccount>,
    
    /// The order to cancel (rent returned to owner)
    #[account(
        mut,
        constraint = order.is_active() @ DegenError::OrderNotActive,
        close = owner
    )]
    pub order: Account<'info, Order>,
    
    /// The order owner - receives rent refund
    #[account(
        mut,
        address = order.owner @ DegenError::Unauthorized
    )]
    pub owner: SystemAccount<'info>,
    
    /// Market authority (relayer) that can force-cancel after close
    #[account(
        constraint = authority.key() == market.authority @ DegenError::Unauthorized
    )]
    pub authority: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

/// Cancel an order after the market is no longer accepting trades.
///
/// This is designed for rent + escrow recovery when the market has closed/expired
/// and users have not manually cancelled their open orders.
///
/// Safety:
/// - Only the market `authority` (relayer) can call this
/// - Only allowed once trading is closed (expiry_at - buffer)
/// - Refunds remaining escrow from vault to the user's USDC ATA
/// - Closes the Order account and returns rent to the owner
pub fn cancel_order_by_relayer(ctx: Context<CancelOrderByRelayer>) -> Result<()> {
    let order = &ctx.accounts.order;
    let market = &ctx.accounts.market;
    let clock = Clock::get()?;
    
    // Only allow forced cancellation once the market is closed to trading.
    // (Within the last 30s buffer or after expiry.)
    require!(
        clock.unix_timestamp >= market.expiry_at - TRADING_CLOSE_BUFFER,
        DegenError::MarketNotOpen
    );
    
    // Calculate refund amount based on remaining size
    let refund_amount = if order.filled_size == 0 {
        order.locked_amount
    } else if order.filled_size >= order.size {
        0
    } else {
        let remaining = order.size.saturating_sub(order.filled_size);
        order.locked_amount
            .checked_mul(remaining)
            .unwrap_or(0)
            .checked_div(order.size)
            .unwrap_or(0)
    };
    
    // Transfer USDC from vault back to user if there's a refund
    if refund_amount > 0 {
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
            to: ctx.accounts.user_usdc.to_account_info(),
            authority: market.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, refund_amount)?;
        
        msg!("Refunded {} USDC to user (forced cancel)", refund_amount);
    }
    
    msg!(
        "Order force-cancelled by relayer: order={} owner={} remaining_size={} refund={}",
        order.key(),
        order.owner,
        order.remaining_size(),
        refund_amount
    );
    
    Ok(())
}


