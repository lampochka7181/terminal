use anchor_lang::prelude::*;

pub const MAX_SESSION_DURATION_SECONDS: i64 = 7 * 24 * 60 * 60;

#[account]
pub struct SessionAuthority {
    pub wallet: Pubkey,
    pub session_pubkey: Pubkey,
    pub expires_at: i64,
    pub revoked: bool,
    pub created_at: i64,
    pub bump: u8,
}

impl SessionAuthority {
    pub const SEED: &'static [u8] = b"session_authority";

    pub const SIZE: usize = 8 + // discriminator
        32 +                    // wallet
        32 +                    // session_pubkey
        8 +                     // expires_at
        1 +                     // revoked
        8 +                     // created_at
        1;                      // bump

    pub fn is_active(&self, now: i64) -> bool {
        !self.revoked && self.expires_at > now
    }
}
