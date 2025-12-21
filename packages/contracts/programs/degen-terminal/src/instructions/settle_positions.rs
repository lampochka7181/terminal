use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{Market, UserPosition, MarketStatus, MarketOutcome};
use crate::errors::DegenError;

#[derive(Accounts)]
pub struct SettlePositions<'info> {
    /// Market account - validated by Anchor's account discriminator check
    #[account(mut)]
    pub market: Account<'info, Market>,
    
    /// Market's USDC vault - validated to be the market's ATA
    #[account(
        mut,
        constraint = vault.owner == market.key() @ DegenError::InvalidMarketParams
    )]
    pub vault: Account<'info, TokenAccount>,
    
    /// User's position to settle
    #[account(
        mut,
        seeds = [UserPosition::SEED, market.key().as_ref(), position.owner.as_ref()],
        bump = position.bump,
        constraint = position.market == market.key() @ DegenError::InvalidMarketParams,
        close = authority
    )]
    pub position: Account<'info, UserPosition>,
    
    /// User's USDC token account (receives payout) - validated to belong to position owner
    #[account(
        mut,
        constraint = user_usdc.owner == position.owner @ DegenError::Unauthorized
    )]
    pub user_usdc: Account<'info, TokenAccount>,
    
    /// Authority (keeper) that triggers settlement
    pub authority: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

/// Settle a user's position after market resolution.
/// Pays out $1.00 per winning contract.
/// Shares are stored in 6 decimals (1_000_000 = 1 contract = $1 payout)
/// So shares directly equal payout in microUSDC.
pub fn settle_positions(ctx: Context<SettlePositions>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.position;
    
    // Ensure market is resolved
    require!(market.status == MarketStatus::Resolved, DegenError::MarketNotResolved);
    require!(market.outcome != MarketOutcome::Pending, DegenError::MarketNotResolved);
    
    // Ensure position not already settled
    require!(!position.settled, DegenError::PositionAlreadySettled);
    
    // Calculate payout based on outcome
    // Shares are in 6 decimals: 1_000_000 shares = 1 contract = $1 = 1_000_000 microUSDC
    // So payout = shares directly (no multiplication needed)
    let payout = match market.outcome {
        MarketOutcome::Yes => position.yes_shares,
        MarketOutcome::No => position.no_shares,
        MarketOutcome::Pending => {
            return Err(DegenError::MarketNotResolved.into());
        }
    };
    
    // Transfer payout from vault to user (if any)
    if payout > 0 {
        require!(ctx.accounts.vault.amount >= payout, DegenError::InsufficientVaultBalance);
        
        // Use correct market PDA seeds for signing (must match market creation seeds)
        // Market creation uses raw string bytes, so we use the trimmed helper methods
        let expiry_bytes = market.expiry_at.to_le_bytes();
        let bump = market.bump;
        let seeds = &[
            Market::SEED,
            market.asset_bytes(),
            market.timeframe_bytes(),
            expiry_bytes.as_ref(),
            &[bump]
        ];
        let signer_seeds = &[&seeds[..]];
        
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: market.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, payout)?;
    }
    
    // Update market stats
    market.settled_positions += 1;
    if market.settled_positions >= market.total_positions {
        market.status = MarketStatus::Settled;
        market.settled_at = Clock::get()?.unix_timestamp;
        msg!("Market #{} fully settled", market.id);
    }
    
    msg!("Position settled: payout={}", payout);
    
    Ok(())
}
