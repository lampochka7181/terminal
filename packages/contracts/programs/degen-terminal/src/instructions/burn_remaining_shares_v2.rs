use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::TokenInterface;
use anchor_spl::token_2022::spl_token_2022;
use crate::state_v2::{MarketV2, MarketStatusV2};
use crate::errors::DegenError;

/// Burn remaining share tokens from user ATAs using PermanentDelegate authority.
///
/// Called after batch_settle_v2 completes all settlements and before finalize_market_v2.
/// The market PDA is the PermanentDelegate on both YES and NO mints, allowing it to
/// burn tokens from any holder's ATA without their signature.
///
/// Once all tokens are burned (supply = 0), the mints can be closed in finalize_market_v2
/// to recover rent.
///
/// remaining_accounts: user share token ATAs (YES and/or NO) to burn from.
/// Each account must belong to either yes_mint or no_mint.
#[derive(Accounts)]
pub struct BurnRemainingSharesV2<'info> {
    #[account(
        constraint = market.status == MarketStatusV2::Settling @ DegenError::MarketNotSettling,
        constraint = market.is_settlement_complete() @ DegenError::SettlementNotComplete,
    )]
    pub market: Box<Account<'info, MarketV2>>,

    /// YES token mint (Token-2022)
    /// CHECK: Verified by constraint against market state
    #[account(
        mut,
        constraint = yes_mint.key() == market.yes_mint @ DegenError::InvalidMarketParams
    )]
    pub yes_mint: AccountInfo<'info>,

    /// NO token mint (Token-2022)
    /// CHECK: Verified by constraint against market state
    #[account(
        mut,
        constraint = no_mint.key() == market.no_mint @ DegenError::InvalidMarketParams
    )]
    pub no_mint: AccountInfo<'info>,

    /// Authority (keeper/relayer)
    #[account(
        constraint = market.authority == authority.key() @ DegenError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// Token-2022 program for burn operations
    pub share_token_program: Interface<'info, TokenInterface>,

    // remaining_accounts: user share token ATAs to burn from
}

/// Read the mint pubkey from a Token-2022 token account (bytes 0-32)
fn read_token_account_mint(data: &[u8]) -> Result<Pubkey> {
    if data.len() < 72 {
        return Err(DegenError::InvalidMarketParams.into());
    }
    Ok(Pubkey::new_from_array(data[0..32].try_into().unwrap()))
}

/// Read the balance from a Token-2022 token account (bytes 64-72)
fn read_token_account_balance(data: &[u8]) -> Result<u64> {
    if data.len() < 72 {
        return Err(DegenError::InvalidMarketParams.into());
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

pub fn burn_remaining_shares_v2<'info>(
    ctx: Context<'_, '_, 'info, 'info, BurnRemainingSharesV2<'info>>,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let yes_mint_key = market.yes_mint;
    let no_mint_key = market.no_mint;

    // Pre-compute market seeds for PDA signing (market PDA = permanent delegate)
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

    let share_token_program_key = ctx.accounts.share_token_program.key();
    let mut total_burned = 0u64;
    let mut accounts_processed = 0u64;

    for token_account_info in ctx.remaining_accounts.iter() {
        // Read mint and balance from the token account
        let (mint_key, balance) = {
            let data = token_account_info.try_borrow_data()?;
            let mint = read_token_account_mint(&data)?;
            let bal = read_token_account_balance(&data)?;
            (mint, bal)
        };

        // Verify the token account belongs to one of our mints
        let mint_info = if mint_key == yes_mint_key {
            ctx.accounts.yes_mint.to_account_info()
        } else if mint_key == no_mint_key {
            ctx.accounts.no_mint.to_account_info()
        } else {
            msg!("Skipping account {} - not a YES/NO mint ATA", token_account_info.key());
            continue;
        };

        if balance == 0 {
            // Already burned or never had tokens
            continue;
        }

        // Burn tokens using PermanentDelegate authority (market PDA)
        invoke_signed(
            &spl_token_2022::instruction::burn(
                &share_token_program_key,
                token_account_info.key,
                &mint_key,
                &market_account_info.key(),
                &[],
                balance,
            )?,
            &[
                token_account_info.clone(),
                mint_info,
                market_account_info.clone(),
            ],
            signer_seeds,
        )?;

        total_burned = total_burned.checked_add(balance).ok_or(DegenError::MathOverflow)?;
        accounts_processed += 1;
    }

    msg!(
        "Burned {} share tokens from {} accounts (market={})",
        total_burned,
        accounts_processed,
        ctx.accounts.market.key()
    );

    emit!(SharesBurned {
        market: ctx.accounts.market.key(),
        total_burned,
        accounts_processed,
    });

    Ok(())
}

#[event]
pub struct SharesBurned {
    pub market: Pubkey,
    pub total_burned: u64,
    pub accounts_processed: u64,
}
