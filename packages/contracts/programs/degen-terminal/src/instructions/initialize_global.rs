use anchor_lang::prelude::*;
use crate::state::GlobalState;
use crate::errors::DegenError;

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    #[account(
        init,
        payer = admin,
        space = GlobalState::SIZE,
        seeds = [GlobalState::SEED],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,
    
    #[account(mut)]
    pub admin: Signer<'info>,
    
    /// CHECK: Fee recipient account - can be any account
    pub fee_recipient: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}

pub fn initialize_global(
    ctx: Context<InitializeGlobal>,
    maker_fee_bps: u16,
    taker_fee_bps: u16,
) -> Result<()> {
    // Validate fee configuration (max 5% = 500 bps)
    require!(maker_fee_bps <= 500, DegenError::InvalidFeeConfig);
    require!(taker_fee_bps <= 500, DegenError::InvalidFeeConfig);
    
    let global_state = &mut ctx.accounts.global_state;
    
    global_state.admin = ctx.accounts.admin.key();
    global_state.fee_recipient = ctx.accounts.fee_recipient.key();
    global_state.maker_fee_bps = maker_fee_bps;
    global_state.taker_fee_bps = taker_fee_bps;
    global_state.paused = false;
    global_state.pause_reason = [0u8; 100];
    global_state.paused_at = 0;
    global_state.total_markets = 0;
    global_state.total_volume = 0;
    global_state.bump = ctx.bumps.global_state;
    
    msg!("Global state initialized: admin={}, maker_fee={}bps, taker_fee={}bps", 
        global_state.admin, maker_fee_bps, taker_fee_bps);
    
    Ok(())
}
