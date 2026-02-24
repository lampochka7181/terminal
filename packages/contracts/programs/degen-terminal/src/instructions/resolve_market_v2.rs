use anchor_lang::prelude::*;
use crate::state_v2::{MarketV2, MarketStatusV2, MarketOutcomeV2};
use crate::errors::DegenError;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ResolveMarketArgsV2 {
    /// Outcome determined by relayer (0 = Yes, 1 = No)
    pub outcome: u8,
    /// Final price at resolution (8 decimals)
    pub final_price: u64,
}

#[derive(Accounts)]
pub struct ResolveMarketV2<'info> {
    #[account(
        mut,
        constraint = market.authority == authority.key() @ DegenError::Unauthorized
    )]
    pub market: Account<'info, MarketV2>,

    /// Authority (keeper/relayer) that triggers resolution
    pub authority: Signer<'info>,
}

/// Resolve a V2 market with outcome determined by the relayer.
///
/// The relayer fetches the real price from Binance/Coinbase and determines the winner.
/// Can only be called after the market has expired.
///
/// After resolution, the market transitions to RESOLVED status.
/// The keeper then posts a merkle root to begin batch settlement.
pub fn resolve_market_v2(ctx: Context<ResolveMarketV2>, args: ResolveMarketArgsV2) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    // Ensure market has expired
    require!(clock.unix_timestamp >= market.expiry_at, DegenError::MarketNotExpired);

    // Ensure not already resolved
    require!(
        market.status == MarketStatusV2::Open || market.status == MarketStatusV2::Closed,
        DegenError::MarketAlreadyResolved
    );

    // Validate outcome
    require!(args.outcome <= 1, DegenError::InvalidMarketParams);
    require!(args.final_price > 0, DegenError::InvalidOraclePrice);

    // Update market with relayer-provided data
    market.final_price = args.final_price;
    market.resolved_at = clock.unix_timestamp;
    market.status = MarketStatusV2::Resolved;

    // Set outcome from relayer
    if args.outcome == 0 {
        market.outcome = MarketOutcomeV2::Yes;
        msg!(
            "MarketV2 #{} resolved: YES wins (final={} > strike={})",
            market.id, args.final_price, market.strike_price
        );
    } else {
        market.outcome = MarketOutcomeV2::No;
        msg!(
            "MarketV2 #{} resolved: NO wins (final={} <= strike={})",
            market.id, args.final_price, market.strike_price
        );
    }

    emit!(MarketV2Resolved {
        market: market.key(),
        market_id: market.id,
        outcome: market.outcome,
        final_price: args.final_price,
        strike_price: market.strike_price,
        resolved_at: clock.unix_timestamp,
        open_interest: market.open_interest,
    });

    Ok(())
}

#[event]
pub struct MarketV2Resolved {
    pub market: Pubkey,
    pub market_id: u64,
    pub outcome: MarketOutcomeV2,
    pub final_price: u64,
    pub strike_price: u64,
    pub resolved_at: i64,
    pub open_interest: u64,
}
