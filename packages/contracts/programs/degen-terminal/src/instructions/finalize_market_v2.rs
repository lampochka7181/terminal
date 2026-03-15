use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, CloseAccount, Transfer};
use anchor_spl::token_interface::{self, TokenInterface, CloseAccount as CloseAccountInterface};
use anchor_lang::system_program;
use crate::state_v2::{MarketV2, MarketStatusV2, SettlementBitmap};
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

fn close_bitmap_account(bitmap: &AccountInfo, destination: &AccountInfo) -> Result<()> {
    let lamports = bitmap.lamports();
    **destination.try_borrow_mut_lamports()? = destination
        .lamports()
        .checked_add(lamports)
        .ok_or(DegenError::MathOverflow)?;
    **bitmap.try_borrow_mut_lamports()? = 0;
    bitmap.assign(&system_program::ID);
    bitmap.realloc(0, false)?;
    Ok(())
}

/// Finalize a V2 market after all settlements are complete
///
/// This instruction:
/// 1. Verifies all settlements have been processed
/// 2. Transfers any vault dust to authority
/// 3. Closes the vault to recover rent (regular Token program)
/// 4. Closes YES mint via Token-2022 MintCloseAuthority
/// 5. Closes NO mint via Token-2022 MintCloseAuthority
/// 6. Closes SettlementBitmap to recover rent (via Anchor `close` constraint)
/// 7. Closes the MarketV2 PDA to recover rent (via Anchor `close` constraint)
///
/// Total rent recovered: ~0.017 SOL (market PDA + vault + YES/NO mints + bitmap)
#[derive(Accounts)]
pub struct FinalizeMarketV2<'info> {
    #[account(
        mut,
        close = rent_recipient,
        constraint = market.status == MarketStatusV2::Settling @ DegenError::MarketNotSettling,
        constraint = market.is_settlement_complete() @ DegenError::SettlementNotComplete,
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

    /// Market's USDC vault (should be empty or near-empty)
    #[account(
        mut,
        constraint = market.vault == vault.key() @ DegenError::InvalidMarketParams,
        constraint = vault.owner == market.key() @ DegenError::InvalidMarketParams,
        constraint = vault.mint == market.usdc_mint @ DegenError::InvalidMarketParams
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// Authority (keeper/relayer) that finalizes the market
    #[account(
        mut,
        constraint = market.authority == authority.key() @ DegenError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// Authority's USDC ATA to receive vault dust
    #[account(
        mut,
        constraint = authority_ata.mint == market.usdc_mint @ DegenError::InvalidMarketParams
    )]
    pub authority_ata: Box<Account<'info, TokenAccount>>,

    /// Settlement bitmap (chunk 0) — closed to recover rent (~0.008 SOL)
    #[account(
        mut,
        close = rent_recipient,
        seeds = [
            SettlementBitmap::SEED,
            market.key().as_ref(),
            &0u16.to_le_bytes()  // chunk_index = 0
        ],
        bump = settlement_bitmap.bump,
        constraint = settlement_bitmap.market == market.key() @ DegenError::InvalidMarketParams
    )]
    pub settlement_bitmap: Box<Account<'info, SettlementBitmap>>,

    /// Rent recipient for recovered lamports
    /// CHECK: Any account can receive rent
    #[account(mut)]
    pub rent_recipient: AccountInfo<'info>,

    /// Regular Token program for USDC vault operations
    pub token_program: Program<'info, Token>,
    /// Token-2022 program for closing YES/NO mints
    pub share_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn finalize_market_v2<'info>(
    ctx: Context<'_, '_, 'info, 'info, FinalizeMarketV2<'info>>,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let clock = Clock::get()?;
    require_market_v2_vault(market, &market.key(), &ctx.accounts.vault.key(), &ctx.accounts.vault)?;

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

    let vault_balance = ctx.accounts.vault.amount;

    // Close any additional bitmap chunks passed as remaining accounts before
    // Anchor closes chunk 0 via the account constraint.
    let mut extra_chunks_closed = 0u16;
    for bitmap_info in ctx.remaining_accounts.iter() {
        let bitmap: Account<SettlementBitmap> = Account::try_from(bitmap_info)?;
        require!(bitmap.market == market.key(), DegenError::InvalidMarketParams);
        require!(bitmap.chunk_index > 0, DegenError::WrongBitmapChunk);
        require!(bitmap.chunk_index < market.settlement_bitmap_chunks, DegenError::WrongBitmapChunk);
        close_bitmap_account(bitmap_info, &ctx.accounts.rent_recipient.to_account_info())?;
        extra_chunks_closed = extra_chunks_closed.checked_add(1).ok_or(DegenError::MathOverflow)?;
    }
    if market.settlement_bitmap_chunks > 1 && extra_chunks_closed + 1 != market.settlement_bitmap_chunks {
        msg!(
            "FinalizeMarketV2: {} bitmap chunks expected, {} closed in this call",
            market.settlement_bitmap_chunks,
            extra_chunks_closed + 1
        );
    }

    // =========================================================================
    // Sweep any leftover USDC dust, then close the vault.
    // execute_match_v2 rounds YES/NO leg collateral independently, so the vault
    // can retain a tiny remainder even when total settlement amount matches
    // open_interest exactly.
    // =========================================================================
    if vault_balance > 0 {
        let sweep_dust_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.authority_ata.to_account_info(),
            authority: market_account_info.clone(),
        };
        let sweep_dust_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            sweep_dust_accounts,
            signer_seeds
        );
        token::transfer(sweep_dust_ctx, vault_balance)?;
        msg!("Swept {} microUSDC dust from vault to authority ATA", vault_balance);
    }

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
    // Token-2022 requires mint supply = 0 before closing. Share tokens are held
    // by users and not burned during settlement (settlement pays USDC only).
    // If supply > 0, skip closure — mint rent (~0.0015 SOL) is not recovered.
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
            msg!("YES mint has supply {}, skipping closure (tokens still in circulation)", yes_supply);
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
            msg!("NO mint has supply {}, skipping closure (tokens still in circulation)", no_supply);
        }
    }

    // Emit event before account is closed by Anchor's `close` constraint
    let market = &ctx.accounts.market;
    msg!(
        "MarketV2 #{} finalized: {} settlements, {} USDC distributed - rent recovered (PDA + vault, mints closed if supply=0)",
        market.id,
        market.settlements_processed,
        market.total_settlement_amount
    );

    emit!(MarketV2Finalized {
        market: market.key(),
        market_id: market.id,
        settlements_processed: market.settlements_processed,
        total_amount_distributed: market.total_settlement_amount,
        settled_at: clock.unix_timestamp,
    });

    // Note: MarketV2 PDA and SettlementBitmap are closed automatically by Anchor's
    // `close = rent_recipient` constraint after this handler returns.
    // Total rent recovered:
    // - MarketV2 PDA: ~0.003 SOL
    // - USDC vault: ~0.002 SOL
    // - YES mint: ~0.002 SOL
    // - NO mint: ~0.002 SOL
    // - SettlementBitmap: ~0.008 SOL
    // Total: ~0.017 SOL per market

    Ok(())
}

#[event]
pub struct MarketV2Finalized {
    pub market: Pubkey,
    pub market_id: u64,
    pub settlements_processed: u64,
    pub total_amount_distributed: u64,
    pub settled_at: i64,
}
