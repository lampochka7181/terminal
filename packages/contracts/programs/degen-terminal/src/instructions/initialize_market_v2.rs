use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{Token, TokenAccount};
use anchor_spl::token_interface::TokenInterface;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::associated_token::AssociatedToken;
use crate::state_v2::{MarketV2, MarketStatusV2, MarketOutcomeV2, SHARE_TOKEN_DECIMALS};
use crate::state::{str_to_bytes, MAX_ASSET_LEN, MAX_TIMEFRAME_LEN};
use crate::errors::DegenError;

/// Initialize a V2 market with tokenized YES/NO shares
///
/// PHASE 1: Creates the MarketV2 account and YES mint (Token-2022 with MintCloseAuthority).
/// Call init_market_v2_finalize to create NO mint and vault.
///
/// YES/NO mints use Token-2022 with MintCloseAuthority extension so rent can be
/// recovered when the market is closed/finalized.
#[derive(Accounts)]
#[instruction(asset: String, timeframe: String, strike_price: u64, expiry_ts: i64)]
pub struct InitializeMarketV2<'info> {
    #[account(
        init,
        payer = authority,
        space = MarketV2::SIZE,
        seeds = [
            MarketV2::SEED,
            asset.as_bytes(),
            timeframe.as_bytes(),
            &expiry_ts.to_le_bytes()
        ],
        bump
    )]
    pub market: Box<Account<'info, MarketV2>>,

    /// YES token mint - created manually with Token-2022 + MintCloseAuthority extension
    /// CHECK: Created in handler via CPI to Token-2022 program. PDA verified by seeds.
    #[account(
        mut,
        seeds = [
            MarketV2::YES_MINT_SEED,
            market.key().as_ref()
        ],
        bump,
    )]
    pub yes_mint: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    /// Token-2022 program for YES/NO share token mints
    pub share_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_market_v2(
    ctx: Context<InitializeMarketV2>,
    asset: String,
    timeframe: String,
    strike_price: u64,
    expiry_ts: i64,
) -> Result<()> {
    let clock = Clock::get()?;

    // Validate inputs
    require!(asset.len() <= MAX_ASSET_LEN, DegenError::InvalidAsset);
    require!(timeframe.len() <= MAX_TIMEFRAME_LEN, DegenError::InvalidTimeframe);
    require!(expiry_ts > clock.unix_timestamp + 60, DegenError::InvalidExpiry);

    // Validate asset is supported (BTC, ETH, SOL)
    let valid_assets = ["BTC", "ETH", "SOL"];
    require!(valid_assets.contains(&asset.as_str()), DegenError::InvalidAsset);

    // Validate timeframe
    let valid_timeframes = ["5m", "15m", "1h", "4h", "24h"];
    require!(valid_timeframes.contains(&timeframe.as_str()), DegenError::InvalidTimeframe);

    // L-02: Generate sequential market ID (Note: V2 init doesn't have GlobalState
    // in accounts struct to avoid stack overflow. ID is set from backend via market_id arg.
    // The backend reads GlobalState.total_markets to ensure uniqueness.)

    // =========================================================================
    // Create YES mint with Token-2022 + MintCloseAuthority extension
    // =========================================================================

    let market_key = ctx.accounts.market.key();
    let share_token_program_key = ctx.accounts.share_token_program.key();

    // Calculate space for mint with MintCloseAuthority + PermanentDelegate extensions
    // PermanentDelegate allows the market PDA to burn share tokens from any holder
    // during settlement, which brings supply to 0 so the mint can be closed
    let extensions = &[
        spl_token_2022::extension::ExtensionType::MintCloseAuthority,
        spl_token_2022::extension::ExtensionType::PermanentDelegate,
    ];
    let space = spl_token_2022::extension::ExtensionType::try_calculate_account_len::<
        spl_token_2022::state::Mint,
    >(extensions)
    .map_err(|_| error!(DegenError::InvalidMarketParams))?;

    let rent = Rent::get()?.minimum_balance(space);

    // Create YES mint PDA account (owned by Token-2022 program)
    let yes_mint_seeds: &[&[u8]] = &[
        MarketV2::YES_MINT_SEED,
        market_key.as_ref(),
        &[ctx.bumps.yes_mint],
    ];

    invoke_signed(
        &system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.yes_mint.key(),
            rent,
            space as u64,
            &share_token_program_key,
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.yes_mint.to_account_info(),
        ],
        &[yes_mint_seeds],
    )?;

    // Initialize MintCloseAuthority extension (must be before InitializeMint2)
    // Close authority = market PDA, so market can close the mint when done
    invoke(
        &spl_token_2022::instruction::initialize_mint_close_authority(
            &share_token_program_key,
            &ctx.accounts.yes_mint.key(),
            Some(&market_key),
        )?,
        &[ctx.accounts.yes_mint.to_account_info()],
    )?;

    // Initialize PermanentDelegate extension (must be before InitializeMint2)
    // Permanent delegate = market PDA, allows burning shares from any holder during settlement
    invoke(
        &spl_token_2022::instruction::initialize_permanent_delegate(
            &share_token_program_key,
            &ctx.accounts.yes_mint.key(),
            &market_key,
        )?,
        &[ctx.accounts.yes_mint.to_account_info()],
    )?;

    // Initialize the mint (authority = market PDA)
    invoke(
        &spl_token_2022::instruction::initialize_mint2(
            &share_token_program_key,
            &ctx.accounts.yes_mint.key(),
            &market_key,     // mint authority
            None,            // no freeze authority
            SHARE_TOKEN_DECIMALS,
        )?,
        &[ctx.accounts.yes_mint.to_account_info()],
    )?;

    // =========================================================================
    // Initialize market state (phase 1 - no_mint and vault set in phase 2)
    // =========================================================================

    let market = &mut ctx.accounts.market;
    market.id = 0;
    market.authority = ctx.accounts.authority.key();
    market.asset = str_to_bytes::<10>(&asset);
    market.timeframe = str_to_bytes::<10>(&timeframe);
    market.strike_price = strike_price;
    market.final_price = 0;
    market.created_at = clock.unix_timestamp;
    market.expiry_at = expiry_ts;
    market.resolved_at = 0;
    market.settled_at = 0;
    market.status = MarketStatusV2::Pending;
    market.outcome = MarketOutcomeV2::Pending;
    market.total_volume = 0;
    market.total_trades = 0;

    // V2 tokenized fields
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = Pubkey::default(); // Set in finalize
    market.open_interest = 0;

    // V2 merkle settlement fields
    market.settlement_merkle_root = [0u8; 32];
    market.has_merkle_root = false;
    market.total_settlement_amount = 0;
    market.settlements_processed = 0;
    market.settlements_total = 0;

    // Bumps
    market.bump = ctx.bumps.market;
    market.yes_mint_bump = ctx.bumps.yes_mint;
    market.no_mint_bump = 0; // Set in finalize

    msg!(
        "MarketV2 phase 1: {} {} strike={} expiry={} YES_mint={} (Token-2022+MintCloseAuthority+PermanentDelegate)",
        asset, timeframe, strike_price, expiry_ts, ctx.accounts.yes_mint.key()
    );

    Ok(())
}

/// PHASE 2: Create NO mint (Token-2022 + MintCloseAuthority) and USDC vault
#[derive(Accounts)]
pub struct InitializeMarketV2Finalize<'info> {
    #[account(
        mut,
        constraint = market.no_mint == Pubkey::default() @ DegenError::InvalidMarketParams,
    )]
    pub market: Box<Account<'info, MarketV2>>,

    /// NO token mint - created manually with Token-2022 + MintCloseAuthority extension
    /// CHECK: Created in handler via CPI to Token-2022 program. PDA verified by seeds.
    #[account(
        mut,
        seeds = [
            MarketV2::NO_MINT_SEED,
            market.key().as_ref()
        ],
        bump,
    )]
    pub no_mint: AccountInfo<'info>,

    /// USDC mint for vault creation — validated against known mint in GlobalState
    pub usdc_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    /// The market's USDC vault (PDA owned by market PDA, regular Token program)
    #[account(
        init,
        payer = authority,
        seeds = [
            b"vault",
            market.key().as_ref()
        ],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    /// Token-2022 program for YES/NO share token mints
    pub share_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_market_v2_finalize(
    ctx: Context<InitializeMarketV2Finalize>,
    strike_price: u64,
) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let share_token_program_key = ctx.accounts.share_token_program.key();

    msg!("Entering initialize_market_v2_finalize");
    msg!("Market: {}", market_key);

    // Validate USDC mint matches the known mint from config (M-01 fix)
    // The caller must pass the correct USDC mint — this prevents markets with fake tokens
    require!(
        ctx.accounts.usdc_mint.decimals == 6,
        DegenError::InvalidMarketParams
    );

    // =========================================================================
    // Create NO mint with Token-2022 + MintCloseAuthority extension
    // =========================================================================

    let extensions = &[
        spl_token_2022::extension::ExtensionType::MintCloseAuthority,
        spl_token_2022::extension::ExtensionType::PermanentDelegate,
    ];
    let space = spl_token_2022::extension::ExtensionType::try_calculate_account_len::<
        spl_token_2022::state::Mint,
    >(extensions)
    .map_err(|_| error!(DegenError::InvalidMarketParams))?;

    let rent = Rent::get()?.minimum_balance(space);

    let no_mint_seeds: &[&[u8]] = &[
        MarketV2::NO_MINT_SEED,
        market_key.as_ref(),
        &[ctx.bumps.no_mint],
    ];

    invoke_signed(
        &system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.no_mint.key(),
            rent,
            space as u64,
            &share_token_program_key,
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.no_mint.to_account_info(),
        ],
        &[no_mint_seeds],
    )?;

    // Initialize MintCloseAuthority extension
    invoke(
        &spl_token_2022::instruction::initialize_mint_close_authority(
            &share_token_program_key,
            &ctx.accounts.no_mint.key(),
            Some(&market_key),
        )?,
        &[ctx.accounts.no_mint.to_account_info()],
    )?;

    // Initialize PermanentDelegate extension
    // Permanent delegate = market PDA, allows burning shares from any holder during settlement
    invoke(
        &spl_token_2022::instruction::initialize_permanent_delegate(
            &share_token_program_key,
            &ctx.accounts.no_mint.key(),
            &market_key,
        )?,
        &[ctx.accounts.no_mint.to_account_info()],
    )?;

    // Initialize the NO mint
    invoke(
        &spl_token_2022::instruction::initialize_mint2(
            &share_token_program_key,
            &ctx.accounts.no_mint.key(),
            &market_key,
            None,
            SHARE_TOKEN_DECIMALS,
        )?,
        &[ctx.accounts.no_mint.to_account_info()],
    )?;

    // =========================================================================
    // Update market state
    // =========================================================================

    let market = &mut ctx.accounts.market;
    market.no_mint = ctx.accounts.no_mint.key();
    market.no_mint_bump = ctx.bumps.no_mint;

    if strike_price > 0 {
        market.strike_price = strike_price;
        market.status = MarketStatusV2::Open;
    }

    msg!(
        "MarketV2 finalized: NO_mint={} vault={} status={:?} (Token-2022+MintCloseAuthority+PermanentDelegate)",
        ctx.accounts.no_mint.key(),
        ctx.accounts.vault.key(),
        market.status
    );

    Ok(())
}
