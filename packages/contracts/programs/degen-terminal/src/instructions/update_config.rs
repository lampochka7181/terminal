use anchor_lang::prelude::*;
use crate::state::GlobalState;
use crate::errors::DegenError;

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [GlobalState::SEED],
        bump = global_state.bump,
        has_one = admin @ DegenError::Unauthorized
    )]
    pub global_state: Account<'info, GlobalState>,
    
    pub admin: Signer<'info>,
    
    /// CHECK: New fee recipient account (optional)
    pub new_fee_recipient: Option<AccountInfo<'info>>,
}

pub fn update_config(
    ctx: Context<UpdateConfig>,
    maker_fee_bps: Option<u16>,
    taker_fee_bps: Option<u16>,
) -> Result<()> {
    let global_state = &mut ctx.accounts.global_state;
    
    if let Some(fee) = maker_fee_bps {
        require!(fee <= 500, DegenError::InvalidFeeConfig);
        global_state.maker_fee_bps = fee;
    }
    
    if let Some(fee) = taker_fee_bps {
        require!(fee <= 500, DegenError::InvalidFeeConfig);
        global_state.taker_fee_bps = fee;
    }
    
    if let Some(recipient) = &ctx.accounts.new_fee_recipient {
        global_state.fee_recipient = recipient.key();
    }
    
    msg!("Global config updated: maker_fee={}bps, taker_fee={}bps, recipient={}", 
        global_state.maker_fee_bps, global_state.taker_fee_bps, global_state.fee_recipient);
    
    Ok(())
}

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    #[account(
        mut,
        seeds = [GlobalState::SEED],
        bump = global_state.bump,
        has_one = admin @ DegenError::Unauthorized
    )]
    pub global_state: Account<'info, GlobalState>,
    
    pub admin: Signer<'info>,
    
    /// CHECK: New admin address
    pub new_admin: AccountInfo<'info>,
}

pub fn transfer_admin(ctx: Context<TransferAdmin>) -> Result<()> {
    let global_state = &mut ctx.accounts.global_state;
    let old_admin = global_state.admin;
    
    global_state.admin = ctx.accounts.new_admin.key();
    
    msg!(
        "Admin transferred: {} -> {}",
        old_admin, ctx.accounts.new_admin.key()
    );
    
    Ok(())
}

