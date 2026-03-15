use anchor_lang::prelude::*;

use crate::errors::DegenError;
use crate::session::{SessionAuthority, MAX_SESSION_DURATION_SECONDS};

#[derive(Accounts)]
#[instruction(session_pubkey: Pubkey)]
pub struct CreateSessionAuthority<'info> {
    #[account(
        init,
        payer = user,
        space = SessionAuthority::SIZE,
        seeds = [SessionAuthority::SEED, user.key().as_ref(), session_pubkey.as_ref()],
        bump
    )]
    pub session_authority: Account<'info, SessionAuthority>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn create_session_authority(
    ctx: Context<CreateSessionAuthority>,
    session_pubkey: Pubkey,
    expires_at: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(expires_at > now, DegenError::SessionExpired);
    require!(
        expires_at <= now + MAX_SESSION_DURATION_SECONDS,
        DegenError::InvalidSessionDuration
    );

    let session_authority = &mut ctx.accounts.session_authority;
    session_authority.wallet = ctx.accounts.user.key();
    session_authority.session_pubkey = session_pubkey;
    session_authority.expires_at = expires_at;
    session_authority.revoked = false;
    session_authority.created_at = now;
    session_authority.bump = ctx.bumps.session_authority;

    Ok(())
}
