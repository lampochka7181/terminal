use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{Market, Order};
use crate::errors::DegenError;

#[derive(Accounts)]
pub struct CancelOrder<'info> {
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
    
    /// The order to cancel
    #[account(
        mut,
        has_one = owner @ DegenError::Unauthorized,
        constraint = order.is_active() @ DegenError::OrderNotActive,
        close = owner  // Return rent to owner
    )]
    pub order: Account<'info, Order>,
    
    /// The order owner (must sign to cancel)
    #[account(mut)]
    pub owner: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

/// Cancel an order, return locked USDC to user, and refund rent
/// 
/// Only the order owner can cancel their order.
/// The order must be in Open or PartialFill status.
/// Remaining locked USDC is returned from vault to user.
pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
    let order = &ctx.accounts.order;
    let market = &ctx.accounts.market;
    
    // Calculate refund amount based on remaining size
    // locked_amount is for full order, refund proportional to remaining
    let refund_amount = if order.filled_size == 0 {
        // Order was never filled, return full locked amount
        order.locked_amount
    } else if order.filled_size >= order.size {
        // Order is fully filled, no refund
        0
    } else {
        // Partially filled - refund proportional to remaining
        let remaining = order.size.saturating_sub(order.filled_size);
        order.locked_amount
            .checked_mul(remaining)
            .unwrap_or(0)
            .checked_div(order.size)
            .unwrap_or(0)
    };
    
    // Transfer USDC from vault back to user if there's a refund
    if refund_amount > 0 {
        // Build market PDA seeds for signing (use trimmed bytes to match original PDA)
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
        
        msg!("Refunded {} USDC to user", refund_amount);
    }
    
    msg!(
        "Order cancelled: order={} owner={} remaining_size={} refund={}",
        order.key(),
        order.owner,
        order.remaining_size(),
        refund_amount
    );
    
    // Emit event for backend to listen
    emit!(OrderCancelled {
        order: order.key(),
        owner: order.owner,
        market: order.market,
        remaining_size: order.remaining_size(),
        refund_amount,
    });
    
    // Note: The order account is automatically closed via the `close = owner` constraint
    // which returns the rent to the owner
    
    Ok(())
}

// ============================================================================
// EVENTS
// ============================================================================

#[event]
pub struct OrderCancelled {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub remaining_size: u64,
    pub refund_amount: u64,
}

