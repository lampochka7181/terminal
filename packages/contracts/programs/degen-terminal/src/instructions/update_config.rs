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
        let old = global_state.maker_fee_bps;
        global_state.maker_fee_bps = fee;
        msg!("maker_fee_bps: {} -> {}", old, fee);
    }

    if let Some(fee) = taker_fee_bps {
        require!(fee <= 500, DegenError::InvalidFeeConfig);
        let old = global_state.taker_fee_bps;
        global_state.taker_fee_bps = fee;
        msg!("taker_fee_bps: {} -> {}", old, fee);
    }

    if let Some(recipient) = &ctx.accounts.new_fee_recipient {
        let old = global_state.fee_recipient;
        global_state.fee_recipient = recipient.key();
        // L-08: Log fee recipient changes for audit trail
        msg!("fee_recipient changed: {} -> {}", old, recipient.key());
        emit!(ConfigUpdated {
            admin: ctx.accounts.admin.key(),
            field: "fee_recipient".to_string(),
            old_value: old.to_string(),
            new_value: recipient.key().to_string(),
        });
    }

    msg!("Global config updated: maker_fee={}bps, taker_fee={}bps, recipient={}",
        global_state.maker_fee_bps, global_state.taker_fee_bps, global_state.fee_recipient);

    Ok(())
}

// L-03: Two-step admin transfer — propose step
#[derive(Accounts)]
pub struct ProposeAdminTransfer<'info> {
    #[account(
        mut,
        seeds = [GlobalState::SEED],
        bump = global_state.bump,
        has_one = admin @ DegenError::Unauthorized
    )]
    pub global_state: Account<'info, GlobalState>,

    pub admin: Signer<'info>,

    /// CHECK: New admin address (will need to accept)
    pub new_admin: AccountInfo<'info>,
}

pub fn propose_admin_transfer(ctx: Context<ProposeAdminTransfer>) -> Result<()> {
    let global_state = &mut ctx.accounts.global_state;
    global_state.pending_admin = ctx.accounts.new_admin.key();

    msg!(
        "Admin transfer proposed: {} -> {} (pending acceptance)",
        global_state.admin, ctx.accounts.new_admin.key()
    );

    emit!(ConfigUpdated {
        admin: ctx.accounts.admin.key(),
        field: "pending_admin".to_string(),
        old_value: Pubkey::default().to_string(),
        new_value: ctx.accounts.new_admin.key().to_string(),
    });

    Ok(())
}

// L-03: Two-step admin transfer — accept step
#[derive(Accounts)]
pub struct AcceptAdminTransfer<'info> {
    #[account(
        mut,
        seeds = [GlobalState::SEED],
        bump = global_state.bump,
        constraint = global_state.pending_admin == new_admin.key() @ DegenError::Unauthorized
    )]
    pub global_state: Account<'info, GlobalState>,

    pub new_admin: Signer<'info>,
}

pub fn accept_admin_transfer(ctx: Context<AcceptAdminTransfer>) -> Result<()> {
    let global_state = &mut ctx.accounts.global_state;
    let old_admin = global_state.admin;

    global_state.admin = ctx.accounts.new_admin.key();
    global_state.pending_admin = Pubkey::default();

    msg!(
        "Admin transfer accepted: {} -> {}",
        old_admin, ctx.accounts.new_admin.key()
    );

    emit!(ConfigUpdated {
        admin: ctx.accounts.new_admin.key(),
        field: "admin".to_string(),
        old_value: old_admin.to_string(),
        new_value: ctx.accounts.new_admin.key().to_string(),
    });

    Ok(())
}

// Keep legacy single-step transfer for emergency use but require pending_admin == default
// to prevent accidental use when two-step is intended
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
    global_state.pending_admin = Pubkey::default();

    msg!(
        "Admin transferred (direct): {} -> {}",
        old_admin, ctx.accounts.new_admin.key()
    );

    Ok(())
}

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub field: String,
    pub old_value: String,
    pub new_value: String,
}
