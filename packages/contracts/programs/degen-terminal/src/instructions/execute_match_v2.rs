use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::{self, Mint as MintInterface, MintTo as MintToInterface, TokenInterface};
use crate::state_v2::{MarketV2, MarketStatusV2};
use crate::state::{GlobalState, Order, OrderStatus, Side, Outcome, TradeType, USDC_MULTIPLIER, SHARE_MULTIPLIER, MIN_PRICE, MAX_PRICE, MIN_ORDER_SIZE, MAX_ORDER_SIZE, MIN_TAKER_FEE};
use crate::instructions::PlaceOrderArgs;
use crate::errors::DegenError;

/// Execute a match in a V2 market (tokenized shares)
///
/// Instead of creating/updating Position PDAs, this instruction:
/// 1. Transfers USDC from both parties to vault
/// 2. Mints YES tokens to the YES buyer (via Token-2022)
/// 3. Mints NO tokens to the NO buyer (via Token-2022)
/// 4. Transfers fees to fee recipient
///
/// NOTE: ATAs must be pre-created before calling this instruction.
/// The relayer should ensure all token accounts exist beforehand
/// (use createIdempotent with Token-2022 program for YES/NO ATAs).
#[derive(Accounts)]
pub struct ExecuteMatchV2<'info> {
    #[account(
        seeds = [GlobalState::SEED],
        bump = global_state.bump
    )]
    pub global_state: Box<Account<'info, GlobalState>>,

    /// V2 Market account
    #[account(mut)]
    pub market: Box<Account<'info, MarketV2>>,

    /// YES token mint (Token-2022, for minting to YES buyer)
    #[account(
        mut,
        constraint = yes_mint.key() == market.yes_mint @ DegenError::InvalidMarketParams
    )]
    pub yes_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// NO token mint (Token-2022, for minting to NO buyer)
    #[account(
        mut,
        constraint = no_mint.key() == market.no_mint @ DegenError::InvalidMarketParams
    )]
    pub no_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Market's USDC vault (regular Token program)
    #[account(
        mut,
        constraint = vault.owner == market.key() @ DegenError::InvalidMarketParams
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// Fee recipient's USDC account (regular Token program)
    #[account(
        mut,
        constraint = fee_recipient.owner == global_state.fee_recipient @ DegenError::Unauthorized
    )]
    pub fee_recipient: Box<Account<'info, TokenAccount>>,

    // Maker accounts
    /// CHECK: Maker wallet - trusted by relayer
    pub maker: AccountInfo<'info>,

    /// Maker's USDC account (must exist, regular Token program)
    #[account(
        mut,
        constraint = maker_usdc.owner == maker.key() @ DegenError::Unauthorized
    )]
    pub maker_usdc: Box<Account<'info, TokenAccount>>,

    /// Maker's YES token account (Token-2022 ATA, must be pre-created)
    /// CHECK: Validated manually - must be ATA for maker+yes_mint
    #[account(mut)]
    pub maker_yes_ata: AccountInfo<'info>,

    /// Maker's NO token account (Token-2022 ATA, must be pre-created)
    /// CHECK: Validated manually - must be ATA for maker+no_mint
    #[account(mut)]
    pub maker_no_ata: AccountInfo<'info>,

    /// Maker's Order PDA (optional - only for user orders, not MM)
    #[account(mut)]
    pub maker_order: Option<Account<'info, Order>>,

    // Taker accounts
    /// CHECK: Taker wallet - trusted by relayer
    pub taker: AccountInfo<'info>,

    /// Taker's USDC account (must exist, regular Token program)
    #[account(
        mut,
        constraint = taker_usdc.owner == taker.key() @ DegenError::Unauthorized
    )]
    pub taker_usdc: Box<Account<'info, TokenAccount>>,

    /// Taker's YES token account (Token-2022 ATA, must be pre-created)
    /// CHECK: Validated manually - must be ATA for taker+yes_mint
    #[account(mut)]
    pub taker_yes_ata: AccountInfo<'info>,

    /// Taker's NO token account (Token-2022 ATA, must be pre-created)
    /// CHECK: Validated manually - must be ATA for taker+no_mint
    #[account(mut)]
    pub taker_no_ata: AccountInfo<'info>,

    /// Taker's Order PDA (optional - only for user orders, not MM)
    #[account(mut)]
    pub taker_order: Option<Account<'info, Order>>,

    /// Relayer that submits the tx
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// Regular Token program for USDC operations
    pub token_program: Program<'info, Token>,
    /// Token-2022 program for YES/NO share token operations (mint_to)
    pub share_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn execute_match_v2(
    ctx: Context<ExecuteMatchV2>,
    maker_args: PlaceOrderArgs,
    taker_args: PlaceOrderArgs,
    match_size: u64,
    taker_fee: u64,
) -> Result<()> {
    let global_state = &ctx.accounts.global_state;
    let clock = Clock::get()?;

    // Validate ATAs exist and belong to the correct owner+mint
    // (They must be pre-created by relayer before calling this instruction)
    {
        // Helper: deserialize a Token-2022 account and validate owner + mint
        let validate_ata = |account: &AccountInfo, expected_owner: &Pubkey, expected_mint: &Pubkey, label: &str| -> Result<()> {
            require!(account.data_len() > 0, DegenError::InvalidMarketParams);
            // Verify the account is owned by the Token-2022 program
            require!(
                *account.owner == ctx.accounts.share_token_program.key(),
                DegenError::InvalidMarketParams
            );
            // Deserialize and check owner + mint
            let data = account.try_borrow_data()?;
            // SPL token account layout: mint (32) + owner (32) at offsets 0 and 32
            require!(data.len() >= 72, DegenError::InvalidMarketParams);
            let mint_bytes: [u8; 32] = data[0..32].try_into().unwrap();
            let owner_bytes: [u8; 32] = data[32..64].try_into().unwrap();
            let ata_mint = Pubkey::new_from_array(mint_bytes);
            let ata_owner = Pubkey::new_from_array(owner_bytes);
            require!(ata_owner == *expected_owner, DegenError::Unauthorized);
            require!(ata_mint == *expected_mint, DegenError::InvalidMarketParams);
            msg!("Validated {} ATA: owner={}, mint={}", label, ata_owner, ata_mint);
            Ok(())
        };

        let yes_mint_key = ctx.accounts.yes_mint.key();
        let no_mint_key = ctx.accounts.no_mint.key();
        let maker_key = ctx.accounts.maker.key();
        let taker_key = ctx.accounts.taker.key();

        validate_ata(&ctx.accounts.maker_yes_ata, &maker_key, &yes_mint_key, "maker_yes")?;
        validate_ata(&ctx.accounts.maker_no_ata, &maker_key, &no_mint_key, "maker_no")?;
        validate_ata(&ctx.accounts.taker_yes_ata, &taker_key, &yes_mint_key, "taker_yes")?;
        validate_ata(&ctx.accounts.taker_no_ata, &taker_key, &no_mint_key, "taker_no")?;
    }

    // Get order data - prefer Order PDA if available, otherwise use args
    let maker_has_order = ctx.accounts.maker_order.is_some();
    let taker_has_order = ctx.accounts.taker_order.is_some();
    let maker_has_escrow = maker_has_order;
    let taker_has_escrow = taker_has_order;

    // Capture immutable market data BEFORE taking mutable borrow
    let market_key = ctx.accounts.market.key();
    let market_status = ctx.accounts.market.status;
    let market_expiry_at = ctx.accounts.market.expiry_at;
    let market_bump = ctx.accounts.market.bump;
    let market_account_info = ctx.accounts.market.to_account_info();

    // Copy asset and timeframe bytes for PDA seeds
    let asset_len = ctx.accounts.market.asset.iter().position(|&x| x == 0).unwrap_or(ctx.accounts.market.asset.len());
    let timeframe_len = ctx.accounts.market.timeframe.iter().position(|&x| x == 0).unwrap_or(ctx.accounts.market.timeframe.len());
    let mut asset_bytes = [0u8; 10];
    let mut timeframe_bytes = [0u8; 10];
    asset_bytes[..asset_len].copy_from_slice(&ctx.accounts.market.asset[..asset_len]);
    timeframe_bytes[..timeframe_len].copy_from_slice(&ctx.accounts.market.timeframe[..timeframe_len]);

    // Extract order parameters
    let (maker_side, maker_outcome, maker_price, maker_size, maker_expiry) = if let Some(ref order) = ctx.accounts.maker_order {
        require!(order.owner == ctx.accounts.maker.key(), DegenError::Unauthorized);
        require!(order.market == market_key, DegenError::InvalidMarketParams);
        require!(order.is_active(), DegenError::OrderNotActive);
        (order.side, order.outcome, order.price, order.size, order.expiry_ts)
    } else {
        (maker_args.side, maker_args.outcome, maker_args.price, maker_args.size, maker_args.expiry_ts)
    };

    let (taker_side, taker_outcome, taker_price, taker_size, taker_expiry) = if let Some(ref order) = ctx.accounts.taker_order {
        require!(order.owner == ctx.accounts.taker.key(), DegenError::Unauthorized);
        require!(order.market == market_key, DegenError::InvalidMarketParams);
        require!(order.is_active(), DegenError::OrderNotActive);
        (order.side, order.outcome, order.price, order.size, order.expiry_ts)
    } else {
        (taker_args.side, taker_args.outcome, taker_args.price, taker_args.size, taker_args.expiry_ts)
    };

    msg!("ExecuteMatchV2: maker_has_order={}, taker_has_order={}", maker_has_order, taker_has_order);

    // Validations
    require!(!global_state.paused, DegenError::ProtocolPaused);
    require!(market_status == MarketStatusV2::Open, DegenError::MarketNotOpen);
    require!(market_status == MarketStatusV2::Open && clock.unix_timestamp < market_expiry_at - 2, DegenError::MarketClosing);
    require!(ctx.accounts.maker.key() != ctx.accounts.taker.key(), DegenError::SelfTrade);
    require!(maker_side != taker_side, DegenError::SameSide);
    require!(maker_outcome == taker_outcome, DegenError::OutcomeMismatch);
    require!(maker_expiry > clock.unix_timestamp, DegenError::OrderExpired);
    require!(taker_expiry > clock.unix_timestamp, DegenError::OrderExpired);
    require!(maker_price >= MIN_PRICE && maker_price <= MAX_PRICE, DegenError::InvalidPrice);
    require!(taker_price >= MIN_PRICE && taker_price <= MAX_PRICE, DegenError::InvalidPrice);
    require!(maker_size >= MIN_ORDER_SIZE && maker_size <= MAX_ORDER_SIZE, DegenError::InvalidSize);
    require!(taker_size >= MIN_ORDER_SIZE && taker_size <= MAX_ORDER_SIZE, DegenError::InvalidSize);
    require!(match_size >= MIN_ORDER_SIZE && match_size <= MAX_ORDER_SIZE, DegenError::InvalidSize);

    // Price validation - orders must cross
    let execution_price = maker_price;
    if maker_side == Side::Bid {
        require!(taker_price <= maker_price, DegenError::PriceMismatch);
    } else {
        require!(taker_price >= maker_price, DegenError::PriceMismatch);
    }

    // Calculate costs
    let outcome = maker_outcome;
    let yes_price = if outcome == Outcome::Yes { execution_price } else { USDC_MULTIPLIER - execution_price };
    let no_price = USDC_MULTIPLIER - yes_price;

    let yes_cost = yes_price
        .checked_mul(match_size).ok_or(DegenError::MathOverflow)?
        .checked_add(SHARE_MULTIPLIER - 1).ok_or(DegenError::MathOverflow)?
        .checked_div(SHARE_MULTIPLIER).ok_or(DegenError::DivisionByZero)?;

    let no_cost = no_price
        .checked_mul(match_size).ok_or(DegenError::MathOverflow)?
        .checked_add(SHARE_MULTIPLIER - 1).ok_or(DegenError::MathOverflow)?
        .checked_div(SHARE_MULTIPLIER).ok_or(DegenError::DivisionByZero)?;

    // Determine YES/NO buyers
    let is_maker_yes_buyer = (maker_side == Side::Bid && outcome == Outcome::Yes) ||
                             (maker_side == Side::Ask && outcome == Outcome::No);

    // Validate fee (minimum and maximum bounds)
    require!(taker_fee >= MIN_TAKER_FEE, DegenError::FeeTooLow);
    // Cap fee at 5% of the taker's cost to prevent fee extraction attacks
    let max_fee = no_cost.max(yes_cost)
        .checked_mul(5).ok_or(DegenError::MathOverflow)?
        .checked_div(100).ok_or(DegenError::DivisionByZero)?;
    require!(taker_fee <= max_fee.max(MIN_TAKER_FEE), DegenError::FeeTooHigh);

    // Validate match_size doesn't exceed order remaining size (prevent overfill)
    if let Some(ref order) = ctx.accounts.maker_order {
        let remaining = order.size.checked_sub(order.filled_size).ok_or(DegenError::MathOverflow)?;
        require!(match_size <= remaining, DegenError::InvalidSize);
    }
    if let Some(ref order) = ctx.accounts.taker_order {
        let remaining = order.size.checked_sub(order.filled_size).ok_or(DegenError::MathOverflow)?;
        require!(match_size <= remaining, DegenError::InvalidSize);
    }

    // Calculate costs including fee
    let (maker_cost, taker_cost) = if is_maker_yes_buyer {
        (yes_cost, no_cost.checked_add(taker_fee).ok_or(DegenError::MathOverflow)?)
    } else {
        (no_cost, yes_cost.checked_add(taker_fee).ok_or(DegenError::MathOverflow)?)
    };

    // =========================================================================
    // USDC TRANSFERS - Opening trade: both parties deposit USDC to vault
    // (Uses regular Token program since USDC is regular SPL token)
    // =========================================================================

    if !maker_has_escrow {
        msg!("Transferring {} USDC from maker via delegation", maker_cost);
        let cpi_accounts = Transfer {
            from: ctx.accounts.maker_usdc.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.relayer.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, maker_cost)?;
    }

    if !taker_has_escrow {
        msg!("Transferring {} USDC from taker via delegation", taker_cost);
        let cpi_accounts = Transfer {
            from: ctx.accounts.taker_usdc.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.relayer.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, taker_cost)?;
    }

    // =========================================================================
    // FEE TRANSFER (USDC, regular Token program)
    // =========================================================================

    // Pre-compute expiry bytes for PDA seeds
    let expiry_bytes = market_expiry_at.to_le_bytes();

    if taker_fee > 0 {
        let market_seeds = &[
            MarketV2::SEED,
            &asset_bytes[..asset_len],
            &timeframe_bytes[..timeframe_len],
            &expiry_bytes,
            &[market_bump],
        ];
        let signer_seeds = &[&market_seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.fee_recipient.to_account_info(),
            authority: market_account_info.clone(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds
        );
        token::transfer(cpi_ctx, taker_fee)?;
    }

    // =========================================================================
    // V2: MINT TOKENS using Token-2022 (share_token_program)
    // =========================================================================

    let market_seeds = &[
        MarketV2::SEED,
        &asset_bytes[..asset_len],
        &timeframe_bytes[..timeframe_len],
        &expiry_bytes,
        &[market_bump],
    ];
    let signer_seeds = &[&market_seeds[..]];

    if is_maker_yes_buyer {
        // Maker gets YES, Taker gets NO
        msg!("Minting {} YES tokens to maker, {} NO tokens to taker (Token-2022)", match_size, match_size);

        // Mint YES to maker (via Token-2022)
        let cpi_accounts = MintToInterface {
            mint: ctx.accounts.yes_mint.to_account_info(),
            to: ctx.accounts.maker_yes_ata.to_account_info(),
            authority: market_account_info.clone(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.share_token_program.to_account_info(),
            cpi_accounts,
            signer_seeds
        );
        token_interface::mint_to(cpi_ctx, match_size)?;

        // Mint NO to taker (via Token-2022)
        let cpi_accounts = MintToInterface {
            mint: ctx.accounts.no_mint.to_account_info(),
            to: ctx.accounts.taker_no_ata.to_account_info(),
            authority: market_account_info.clone(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.share_token_program.to_account_info(),
            cpi_accounts,
            signer_seeds
        );
        token_interface::mint_to(cpi_ctx, match_size)?;
    } else {
        // Taker gets YES, Maker gets NO
        msg!("Minting {} YES tokens to taker, {} NO tokens to maker (Token-2022)", match_size, match_size);

        // Mint YES to taker (via Token-2022)
        let cpi_accounts = MintToInterface {
            mint: ctx.accounts.yes_mint.to_account_info(),
            to: ctx.accounts.taker_yes_ata.to_account_info(),
            authority: market_account_info.clone(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.share_token_program.to_account_info(),
            cpi_accounts,
            signer_seeds
        );
        token_interface::mint_to(cpi_ctx, match_size)?;

        // Mint NO to maker (via Token-2022)
        let cpi_accounts = MintToInterface {
            mint: ctx.accounts.no_mint.to_account_info(),
            to: ctx.accounts.maker_no_ata.to_account_info(),
            authority: market_account_info.clone(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.share_token_program.to_account_info(),
            cpi_accounts,
            signer_seeds
        );
        token_interface::mint_to(cpi_ctx, match_size)?;
    }

    // =========================================================================
    // UPDATE ORDER PDAS
    // =========================================================================

    if let Some(ref mut maker_order) = ctx.accounts.maker_order {
        maker_order.filled_size = maker_order.filled_size.checked_add(match_size).ok_or(DegenError::MathOverflow)?;
        maker_order.status = if maker_order.filled_size >= maker_order.size { OrderStatus::Filled } else { OrderStatus::PartialFill };
    }

    if let Some(ref mut taker_order) = ctx.accounts.taker_order {
        taker_order.filled_size = taker_order.filled_size.checked_add(match_size).ok_or(DegenError::MathOverflow)?;
        taker_order.status = if taker_order.filled_size >= taker_order.size { OrderStatus::Filled } else { OrderStatus::PartialFill };
    }

    // =========================================================================
    // UPDATE MARKET STATS
    // =========================================================================

    // Now safe to take mutable borrow after all CPI calls are done
    let market = &mut ctx.accounts.market;
    market.open_interest = market.open_interest.checked_add(match_size).ok_or(DegenError::MathOverflow)?;
    market.total_volume = market.total_volume.checked_add(yes_cost.checked_add(no_cost).ok_or(DegenError::MathOverflow)?).ok_or(DegenError::MathOverflow)?;
    market.total_trades = market.total_trades.checked_add(1).ok_or(DegenError::MathOverflow)?;

    msg!("MatchV2 executed: {} shares @ {} (yes={}, no={}, fee={})", match_size, execution_price, yes_cost, no_cost, taker_fee);

    emit!(MatchExecutedV2 {
        market: market_key,
        maker: ctx.accounts.maker.key(),
        taker: ctx.accounts.taker.key(),
        outcome,
        price: execution_price,
        size: match_size,
        yes_cost,
        no_cost,
        taker_fee,
        maker_has_escrow,
        taker_has_escrow,
        trade_type: TradeType::Opening,
    });

    Ok(())
}

#[event]
pub struct MatchExecutedV2 {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub outcome: Outcome,
    pub price: u64,
    pub size: u64,
    pub yes_cost: u64,
    pub no_cost: u64,
    pub taker_fee: u64,
    pub maker_has_escrow: bool,
    pub taker_has_escrow: bool,
    pub trade_type: TradeType,
}
