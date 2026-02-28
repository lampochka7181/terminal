use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Mint};
use anchor_spl::associated_token::AssociatedToken;
use crate::state::{GlobalState, Market, MarketStatus, MarketOutcome, str_to_bytes, MAX_ASSET_LEN, MAX_TIMEFRAME_LEN};
use crate::errors::DegenError;

#[derive(Accounts)]
#[instruction(asset: String, timeframe: String, strike_price: u64, expiry_ts: i64)]
pub struct InitializeMarket<'info> {
    #[account(
        mut,
        seeds = [GlobalState::SEED],
        bump = global_state.bump
    )]
    pub global_state: Account<'info, GlobalState>,
    
    #[account(
        init,
        payer = authority,
        space = Market::SIZE,
        seeds = [
            Market::SEED,
            asset.as_bytes(),
            timeframe.as_bytes(),
            &expiry_ts.to_le_bytes()
        ],
        bump
    )]
    pub market: Account<'info, Market>,
    
    /// The market's USDC vault (ATA owned by market PDA)
    #[account(
        init,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = market,
    )]
    pub vault: Account<'info, TokenAccount>,
    
    /// USDC mint
    pub usdc_mint: Account<'info, Mint>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_market(
    ctx: Context<InitializeMarket>,
    asset: String,
    timeframe: String,
    strike_price: u64,
    expiry_ts: i64,
) -> Result<()> {
    let clock = Clock::get()?;
    
    // Validate inputs
    require!(asset.len() <= MAX_ASSET_LEN, DegenError::InvalidAsset);
    require!(timeframe.len() <= MAX_TIMEFRAME_LEN, DegenError::InvalidTimeframe);
    // strike_price = 0 is allowed for PENDING markets (will be set at activation)
    require!(expiry_ts > clock.unix_timestamp + 60, DegenError::InvalidExpiry); // At least 1 minute in future
    
    // Validate asset is supported (BTC, ETH, SOL)
    let valid_assets = ["BTC", "ETH", "SOL"];
    require!(valid_assets.contains(&asset.as_str()), DegenError::InvalidAsset);
    
    // Validate timeframe
    let valid_timeframes = ["5m", "15m", "1h", "4h", "24h"];
    require!(valid_timeframes.contains(&timeframe.as_str()), DegenError::InvalidTimeframe);
    
    // Update global state
    let global_state = &mut ctx.accounts.global_state;
    global_state.total_markets += 1;
    let market_id = global_state.total_markets;
    
    // Initialize market
    // If strike_price = 0, market is created as PENDING and will be activated later
    // If strike_price > 0, market is created as OPEN (direct activation)
    let market = &mut ctx.accounts.market;
    market.id = market_id;
    market.authority = ctx.accounts.authority.key();
    market.asset = str_to_bytes::<MAX_ASSET_LEN>(&asset);
    market.timeframe = str_to_bytes::<MAX_TIMEFRAME_LEN>(&timeframe);
    market.strike_price = strike_price;
    market.final_price = 0;
    market.created_at = clock.unix_timestamp;
    market.expiry_at = expiry_ts;
    market.resolved_at = 0;
    market.settled_at = 0;
    market.status = if strike_price > 0 { MarketStatus::Open } else { MarketStatus::Pending };
    market.outcome = MarketOutcome::Pending;
    market.total_volume = 0;
    market.total_trades = 0;
    market.total_positions = 0;
    market.settled_positions = 0;
    market.open_interest = 0;
    market.bump = ctx.bumps.market;
    
    msg!(
        "Market #{} initialized: {} {} strike={} expiry={} status={:?}", 
        market_id, asset, timeframe, strike_price, expiry_ts, market.status
    );
    
    Ok(())
}
