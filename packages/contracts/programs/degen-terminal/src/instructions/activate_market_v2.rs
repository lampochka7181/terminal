use anchor_lang::prelude::*;
use crate::state_v2::{MarketV2, MarketStatusV2};
use crate::errors::DegenError;

#[derive(Accounts)]
pub struct ActivateMarketV2<'info> {
    #[account(
        mut,
        constraint = market.status == MarketStatusV2::Pending @ DegenError::MarketNotPending,
        constraint = market.authority == authority.key() @ DegenError::Unauthorized,
    )]
    pub market: Account<'info, MarketV2>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

/// Activate a pending V2 market by setting the strike price
///
/// This instruction is called when a market's trading window starts.
/// It sets the real strike price (from current WebSocket feed) and
/// changes status from Pending to Open.
///
/// # Arguments
/// * `strike_price` - The strike price to set (8 decimals precision)
pub fn activate_market_v2(
    ctx: Context<ActivateMarketV2>,
    strike_price: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let market = &mut ctx.accounts.market;

    // Validate strike price
    require!(strike_price > 0, DegenError::InvalidMarketParams);

    // Ensure market hasn't expired yet
    require!(
        clock.unix_timestamp < market.expiry_at,
        DegenError::MarketExpired
    );

    // Set strike price and activate
    market.strike_price = strike_price;
    market.status = MarketStatusV2::Open;

    msg!(
        "MarketV2 #{} activated: {} {} strike={}",
        market.id,
        market.asset_str(),
        market.timeframe_str(),
        strike_price
    );

    emit!(MarketV2Activated {
        market: market.key(),
        market_id: market.id,
        strike_price,
        activated_at: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct MarketV2Activated {
    pub market: Pubkey,
    pub market_id: u64,
    pub strike_price: u64,
    pub activated_at: i64,
}
