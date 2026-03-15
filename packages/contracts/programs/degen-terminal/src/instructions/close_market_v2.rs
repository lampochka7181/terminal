use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, CloseAccount};
use anchor_spl::token_interface::{self, TokenInterface, CloseAccount as CloseAccountInterface};
use crate::state_v2::MarketV2;
use crate::state_v2::MarketStatusV2;
use crate::errors::DegenError;
use crate::security::require_market_v2_vault;

/// Read the supply field from a Token/Token-2022 mint account.
/// Supply is a little-endian u64 at byte offset 36 in the base mint layout.
fn read_mint_supply(mint_data: &[u8]) -> Result<u64> {
    if mint_data.len() < 44 {
        return Err(DegenError::InvalidMarketParams.into());
    }
    Ok(u64::from_le_bytes(mint_data[36..44].try_into().unwrap()))
}

/// Close a V2 market that has no trading activity
///
/// This instruction is for closing markets with zero open interest (no trades).
/// For markets with trades, use the merkle settlement flow instead:
/// post_merkle_root -> batch_settle_v2 -> finalize_market_v2
///
/// Recovers rent from:
/// - USDC vault (regular Token program)
/// - YES mint (Token-2022, closed via MintCloseAuthority)
/// - NO mint (Token-2022, closed via MintCloseAuthority)
/// - MarketV2 PDA (via Anchor close constraint)
///
/// Requirements:
/// - Market status must be RESOLVED
/// - Open interest must be 0 (no trades)
/// - Vault balance should be 0
#[derive(Accounts)]
pub struct CloseMarketV2<'info> {
    #[account(
        mut,
        close = rent_recipient,
        constraint = market.status == MarketStatusV2::Resolved @ DegenError::MarketNotResolved,
        constraint = market.open_interest == 0 @ DegenError::MarketHasOpenInterest,
    )]
    pub market: Box<Account<'info, MarketV2>>,

    /// YES token mint (Token-2022, will be closed via MintCloseAuthority)
    /// CHECK: Verified by constraint. Closed in handler via CPI to Token-2022.
    #[account(
        mut,
        constraint = yes_mint.key() == market.yes_mint @ DegenError::InvalidMarketParams
    )]
    pub yes_mint: AccountInfo<'info>,

    /// NO token mint (Token-2022, will be closed via MintCloseAuthority)
    /// CHECK: Verified by constraint. Closed in handler via CPI to Token-2022.
    #[account(
        mut,
        constraint = no_mint.key() == market.no_mint @ DegenError::InvalidMarketParams
    )]
    pub no_mint: AccountInfo<'info>,

    /// Market's USDC vault (should be empty, regular Token program)
    #[account(
        mut,
        constraint = market.vault == vault.key() @ DegenError::InvalidMarketParams,
        constraint = vault.owner == market.key() @ DegenError::InvalidMarketParams,
        constraint = vault.mint == market.usdc_mint @ DegenError::InvalidMarketParams
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// Authority (keeper/relayer) that closes the market
    #[account(
        mut,
        constraint = market.authority == authority.key() @ DegenError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// Rent recipient for recovered lamports
    /// CHECK: Any account can receive rent
    #[account(mut)]
    pub rent_recipient: AccountInfo<'info>,

    /// Regular Token program for USDC vault close
    pub token_program: Program<'info, Token>,
    /// Token-2022 program for closing YES/NO mints
    pub share_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn close_market_v2(ctx: Context<CloseMarketV2>) -> Result<()> {
    let market = &ctx.accounts.market;
    let clock = Clock::get()?;
    require_market_v2_vault(market, &market.key(), &ctx.accounts.vault.key(), &ctx.accounts.vault)?;

    // Verify vault is empty
    let vault_balance = ctx.accounts.vault.amount;
    require!(vault_balance == 0, DegenError::VaultNotEmpty);

    // Pre-compute market seeds for PDA signing
    let asset_len = market.asset.iter().position(|&x| x == 0).unwrap_or(market.asset.len());
    let timeframe_len = market.timeframe.iter().position(|&x| x == 0).unwrap_or(market.timeframe.len());
    let mut asset_bytes = [0u8; 10];
    let mut timeframe_bytes = [0u8; 10];
    asset_bytes[..asset_len].copy_from_slice(&market.asset[..asset_len]);
    timeframe_bytes[..timeframe_len].copy_from_slice(&market.timeframe[..timeframe_len]);
    let expiry_bytes = market.expiry_at.to_le_bytes();
    let market_bump = market.bump;

    let market_seeds = &[
        MarketV2::SEED,
        &asset_bytes[..asset_len],
        &timeframe_bytes[..timeframe_len],
        &expiry_bytes,
        &[market_bump],
    ];
    let signer_seeds = &[&market_seeds[..]];
    let market_account_info = ctx.accounts.market.to_account_info();

    // =========================================================================
    // Close the USDC vault (regular Token program)
    // =========================================================================
    let close_vault_accounts = CloseAccount {
        account: ctx.accounts.vault.to_account_info(),
        destination: ctx.accounts.rent_recipient.to_account_info(),
        authority: market_account_info.clone(),
    };
    let close_vault_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        close_vault_accounts,
        signer_seeds
    );
    token::close_account(close_vault_ctx)?;
    msg!("Vault closed, rent recovered");

    // =========================================================================
    // Close YES mint (Token-2022 via MintCloseAuthority) if supply is 0
    // Token-2022 requires supply = 0 before closing. For close_market_v2
    // (zero-trade markets), supply should always be 0, but check defensively.
    // =========================================================================
    {
        let yes_supply = {
            let yes_data = ctx.accounts.yes_mint.try_borrow_data()?;
            read_mint_supply(&yes_data)?
        };
        if yes_supply == 0 {
            let close_yes_accounts = CloseAccountInterface {
                account: ctx.accounts.yes_mint.to_account_info(),
                destination: ctx.accounts.rent_recipient.to_account_info(),
                authority: market_account_info.clone(),
            };
            let close_yes_ctx = CpiContext::new_with_signer(
                ctx.accounts.share_token_program.to_account_info(),
                close_yes_accounts,
                signer_seeds,
            );
            token_interface::close_account(close_yes_ctx)?;
            msg!("YES mint closed (Token-2022), rent recovered");
        } else {
            msg!("YES mint has supply {}, skipping closure", yes_supply);
        }
    }

    // =========================================================================
    // Close NO mint (Token-2022 via MintCloseAuthority) if supply is 0
    // =========================================================================
    {
        let no_supply = {
            let no_data = ctx.accounts.no_mint.try_borrow_data()?;
            read_mint_supply(&no_data)?
        };
        if no_supply == 0 {
            let close_no_accounts = CloseAccountInterface {
                account: ctx.accounts.no_mint.to_account_info(),
                destination: ctx.accounts.rent_recipient.to_account_info(),
                authority: market_account_info.clone(),
            };
            let close_no_ctx = CpiContext::new_with_signer(
                ctx.accounts.share_token_program.to_account_info(),
                close_no_accounts,
                signer_seeds,
            );
            token_interface::close_account(close_no_ctx)?;
            msg!("NO mint closed (Token-2022), rent recovered");
        } else {
            msg!("NO mint has supply {}, skipping closure", no_supply);
        }
    }

    // Emit event before account is closed by Anchor's `close` constraint
    let market = &ctx.accounts.market;
    msg!(
        "MarketV2 closed (zero trades): {} {} - rent recovered (PDA + vault, mints closed if supply=0)",
        std::str::from_utf8(&market.asset[..asset_len]).unwrap_or("?"),
        std::str::from_utf8(&market.timeframe[..timeframe_len]).unwrap_or("?")
    );

    emit!(MarketV2Closed {
        market: market.key(),
        market_id: market.id,
        closed_at: clock.unix_timestamp,
    });

    // Note: MarketV2 PDA is closed automatically by Anchor's `close = rent_recipient`
    // constraint after this handler returns, recovering ~0.003 SOL of rent.
    // YES/NO mints are now also closed via Token-2022 MintCloseAuthority, recovering
    // ~0.003 SOL combined.

    Ok(())
}

#[event]
pub struct MarketV2Closed {
    pub market: Pubkey,
    pub market_id: u64,
    pub closed_at: i64,
}
