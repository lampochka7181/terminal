use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, CloseAccount, Transfer};
use crate::state::{Market, MarketStatus};
use crate::errors::DegenError;

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    /// Market account to close - must be fully settled
    #[account(
        mut,
        close = rent_recipient
    )]
    pub market: Account<'info, Market>,
    
    /// Market's USDC vault - will be closed and rent returned
    #[account(
        mut,
        constraint = vault.owner == market.key() @ DegenError::InvalidMarketParams,
    )]
    pub vault: Account<'info, TokenAccount>,
    
    /// Relayer's USDC account to receive leftover dust (rounding remainders)
    #[account(
        mut,
        constraint = relayer_usdc.owner == rent_recipient.key() @ DegenError::Unauthorized
    )]
    pub relayer_usdc: Account<'info, TokenAccount>,
    
    /// Authority (keeper/admin) that triggers closure
    #[account(
        constraint = authority.key() == market.authority @ DegenError::Unauthorized
    )]
    pub authority: Signer<'info>,
    
    /// Account to receive the rent refund (usually the relayer)
    /// CHECK: This is just the destination for rent, no validation needed
    #[account(mut)]
    pub rent_recipient: AccountInfo<'info>,
    
    pub token_program: Program<'info, Token>,
}

/// Close a fully settled market and recover rent.
/// 
/// This instruction:
/// 1. Validates the market is fully settled (all positions paid out)
/// 2. Sweeps any leftover USDC dust (rounding remainders) to the relayer
/// 3. Closes the market's USDC vault
/// 4. Closes the market account
/// 5. Returns all rent to the specified recipient
pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
    let market = &ctx.accounts.market;
    let clock = Clock::get()?;

    // Market must be expired before it can be closed (even for empty/no-trade markets)
    require!(clock.unix_timestamp >= market.expiry_at, DegenError::MarketNotExpired);

    // Allow closure in two safe cases:
    // 1) Normal path: market is Settled (all payouts complete) OR Resolved with 0 positions (legacy)
    // 2) No-trade path: market has no trades (open_interest==0 and total_positions==0)
    let is_settled_or_resolved_empty =
        market.status == MarketStatus::Settled ||
        (market.status == MarketStatus::Resolved && market.total_positions == 0);
    let is_no_trade_market = market.total_positions == 0 && market.open_interest == 0;

    require!(
        is_settled_or_resolved_empty || is_no_trade_market,
        DegenError::MarketNotSettled
    );

    // SAFETY: For no-trade markets, the vault must be empty. Otherwise, there are still
    // user funds escrowed (e.g. open orders) and we must not sweep them to the relayer.
    if is_no_trade_market {
        require!(ctx.accounts.vault.amount == 0, DegenError::VaultNotEmpty);
    }

    let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
    let market_lamports = market.to_account_info().lamports();
    let dust_amount = ctx.accounts.vault.amount;
    
    // Log closure details
    msg!(
        "Closing market #{}: {} {} (Recovering {} + {} lamports, Sweeping {} dust)",
        market.id,
        String::from_utf8_lossy(&market.asset).trim_matches('\0'),
        String::from_utf8_lossy(&market.timeframe).trim_matches('\0'),
        vault_lamports,
        market_lamports,
        dust_amount
    );
    
    // Prepare signer seeds for the market PDA
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

    // 1. Sweep any leftover USDC dust to the relayer
    if dust_amount > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.relayer_usdc.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, dust_amount)?;
        msg!("Swept {} microUSDC dust to relayer", dust_amount);
    }
    
    // 2. Close the vault token account
    let cpi_ctx_close = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.rent_recipient.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        },
        signer_seeds,
    );
    token::close_account(cpi_ctx_close)?;
    
    msg!("Market closed, vault and account rent recovered to {}", ctx.accounts.rent_recipient.key());
    
    Ok(())
}


