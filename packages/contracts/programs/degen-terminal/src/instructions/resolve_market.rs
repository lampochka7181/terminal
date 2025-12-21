use anchor_lang::prelude::*;
use crate::state::{Market, MarketStatus, MarketOutcome};
use crate::errors::DegenError;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ResolveMarketArgs {
    /// Outcome determined by relayer (0 = Yes, 1 = No)
    pub outcome: u8,
    /// Final price at resolution (8 decimals)
    pub final_price: u64,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    
    /// Authority (keeper/relayer) that triggers resolution
    pub authority: Signer<'info>,
}

/// Resolve a market with outcome determined by the relayer.
/// The relayer fetches the real price from Binance/Coinbase and determines the winner.
/// Can only be called after the market has expired.
pub fn resolve_market(ctx: Context<ResolveMarket>, args: ResolveMarketArgs) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;
    
    // Ensure market has expired
    require!(clock.unix_timestamp >= market.expiry_at, DegenError::MarketNotExpired);
    
    // Ensure not already resolved
    require!(market.status == MarketStatus::Open || market.status == MarketStatus::Closed, DegenError::MarketAlreadyResolved);
    
    // Validate outcome
    require!(args.outcome <= 1, DegenError::InvalidMarketParams);
    require!(args.final_price > 0, DegenError::InvalidOraclePrice);
    
    // Update market with relayer-provided data
    market.final_price = args.final_price;
    market.resolved_at = clock.unix_timestamp;
    market.status = MarketStatus::Resolved;
    
    // Set outcome from relayer
    if args.outcome == 0 {
        market.outcome = MarketOutcome::Yes;
        msg!(
            "Market #{} resolved: YES wins (final={} > strike={})",
            market.id, args.final_price, market.strike_price
        );
    } else {
        market.outcome = MarketOutcome::No;
        msg!(
            "Market #{} resolved: NO wins (final={} <= strike={})",
            market.id, args.final_price, market.strike_price
        );
    }
    
    Ok(())
}
