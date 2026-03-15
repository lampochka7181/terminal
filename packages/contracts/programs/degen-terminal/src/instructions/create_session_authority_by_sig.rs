use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::ID as SYSVAR_INSTRUCTIONS_ID;

use crate::errors::DegenError;
use crate::security::require_session_grant_authorization;
use crate::session::{SessionAuthority, MAX_SESSION_DURATION_SECONDS};

#[derive(Accounts)]
#[instruction(session_pubkey: Pubkey)]
pub struct CreateSessionAuthorityBySig<'info> {
    #[account(
        init,
        payer = payer,
        space = SessionAuthority::SIZE,
        seeds = [SessionAuthority::SEED, user.key().as_ref(), session_pubkey.as_ref()],
        bump
    )]
    pub session_authority: Account<'info, SessionAuthority>,

    /// CHECK: Wallet authority is verified by the Ed25519 instruction + signed payload.
    pub user: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Address is verified to be the instructions sysvar.
    #[account(address = SYSVAR_INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn create_session_authority_by_sig(
    ctx: Context<CreateSessionAuthorityBySig>,
    session_pubkey: Pubkey,
    expires_at: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(expires_at > now, DegenError::SessionExpired);
    require!(
        expires_at <= now + MAX_SESSION_DURATION_SECONDS,
        DegenError::InvalidSessionDuration
    );

    require_session_grant_authorization(
        &ctx.accounts.instructions,
        &ctx.accounts.session_authority.key(),
        &ctx.accounts.user.key(),
        &session_pubkey,
        expires_at,
    )?;

    let session_authority = &mut ctx.accounts.session_authority;
    session_authority.wallet = ctx.accounts.user.key();
    session_authority.session_pubkey = session_pubkey;
    session_authority.expires_at = expires_at;
    session_authority.revoked = false;
    session_authority.created_at = now;
    session_authority.bump = ctx.bumps.session_authority;

    Ok(())
}
