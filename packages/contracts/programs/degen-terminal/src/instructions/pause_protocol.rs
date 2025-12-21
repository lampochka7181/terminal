use anchor_lang::prelude::*;
use crate::state::{GlobalState, str_to_bytes, MAX_PAUSE_REASON_LEN};
use crate::errors::DegenError;

#[derive(Accounts)]
pub struct PauseProtocol<'info> {
    #[account(
        mut,
        seeds = [GlobalState::SEED],
        bump = global_state.bump,
        has_one = admin @ DegenError::Unauthorized
    )]
    pub global_state: Account<'info, GlobalState>,
    
    pub admin: Signer<'info>,
}

/// Pause or unpause the protocol.
/// When paused, no new orders can be placed or matched.
/// Existing positions and settlements continue to work.
pub fn pause_protocol(
    ctx: Context<PauseProtocol>, 
    paused: bool,
    reason: Option<String>,
) -> Result<()> {
    let global_state = &mut ctx.accounts.global_state;
    let clock = Clock::get()?;
    
    global_state.paused = paused;
    
    if paused {
        global_state.paused_at = clock.unix_timestamp;
        if let Some(reason_str) = reason {
            global_state.pause_reason = str_to_bytes::<MAX_PAUSE_REASON_LEN>(&reason_str);
        }
        msg!("Protocol PAUSED by admin at {}", clock.unix_timestamp);
    } else {
        global_state.paused_at = 0;
        global_state.pause_reason = [0u8; MAX_PAUSE_REASON_LEN];
        msg!("Protocol UNPAUSED by admin");
    }
    
    Ok(())
}
