use anchor_lang::prelude::*;

use crate::errors::DegenError;
use crate::session::SessionAuthority;

#[derive(Accounts)]
pub struct RevokeSessionAuthority<'info> {
    #[account(
        mut,
        has_one = wallet @ DegenError::Unauthorized,
        seeds = [SessionAuthority::SEED, wallet.key().as_ref(), session_authority.session_pubkey.as_ref()],
        bump = session_authority.bump
    )]
    pub session_authority: Account<'info, SessionAuthority>,

    #[account(mut)]
    pub wallet: Signer<'info>,
}

pub fn revoke_session_authority(ctx: Context<RevokeSessionAuthority>) -> Result<()> {
    ctx.accounts.session_authority.revoked = true;
    Ok(())
}
