use anchor_lang::prelude::*;
use crate::state::{Market, MarketStatus};
use crate::errors::DegenError;

#[derive(Accounts)]
pub struct ActivateMarket<'info> {
    #[account(
        mut,
        constraint = market.status == MarketStatus::Pending @ DegenError::MarketNotPending,
        constraint = market.authority == authority.key() @ DegenError::Unauthorized,
    )]
    pub market: Account<'info, Market>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
}

/// Activate a pending market by setting the strike price
/// 
/// This instruction is called when a market's trading window starts.
/// It sets the real strike price (from current WebSocket feed) and
/// changes status from Pending to Open.
/// 
/// # Arguments
/// * `strike_price` - The strike price to set (8 decimals precision)
pub fn activate_market(
    ctx: Context<ActivateMarket>,
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
    market.status = MarketStatus::Open;
    
    msg!(
        "Market #{} activated: {} {} strike={}", 
        market.id, 
        market.asset_str(),
        market.timeframe_str(),
        strike_price
    );
    
    Ok(())
}

