use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::{self, Mint as MintInterface, TokenInterface, TokenAccount as TokenAccountInterface, TransferChecked as TransferCheckedInterface};
use crate::state_v2::{MarketV2, MarketStatusV2, SHARE_TOKEN_DECIMALS};
use crate::state::{GlobalState, Outcome, SHARE_MULTIPLIER, MIN_PRICE, MAX_PRICE, MIN_ORDER_SIZE, MAX_ORDER_SIZE, MIN_TAKER_FEE, Side};
use crate::instructions::PlaceOrderArgs;
use crate::errors::DegenError;
use crate::security::require_order_authorization;

/// Execute a closing trade in a V2 market (tokenized shares)
///
/// In V2, closing trades involve:
/// 1. Seller transfers YES/NO tokens to buyer (via Token-2022)
/// 2. Buyer pays USDC directly to seller (via regular Token program)
/// 3. Fee is deducted from payment to seller
///
/// This does NOT change open interest (no minting/burning)
///
/// NOTE: ATAs must be pre-created before calling this instruction.
/// The relayer should ensure all token accounts exist beforehand.
#[derive(Accounts)]
pub struct ExecuteCloseV2<'info> {
    #[account(
        seeds = [GlobalState::SEED],
        bump = global_state.bump
    )]
    pub global_state: Box<Account<'info, GlobalState>>,

    /// V2 Market account
    #[account(mut)]
    pub market: Box<Account<'info, MarketV2>>,

    /// YES token mint (Token-2022, for reference)
    #[account(
        constraint = yes_mint.key() == market.yes_mint @ DegenError::InvalidMarketParams
    )]
    pub yes_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// NO token mint (Token-2022, for reference)
    #[account(
        constraint = no_mint.key() == market.no_mint @ DegenError::InvalidMarketParams
    )]
    pub no_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Fee recipient's USDC account (regular Token program)
    #[account(
        mut,
        constraint = fee_recipient.owner == global_state.fee_recipient @ DegenError::Unauthorized,
        constraint = fee_recipient.mint == market.usdc_mint @ DegenError::InvalidMarketParams
    )]
    pub fee_recipient: Box<Account<'info, TokenAccount>>,

    // Buyer accounts (BID side - pays USDC, receives tokens)
    /// CHECK: Buyer wallet - validated by relayer
    pub buyer: AccountInfo<'info>,

    /// Buyer's USDC account (source of payment, regular Token program)
    #[account(
        mut,
        constraint = buyer_usdc.owner == buyer.key() @ DegenError::Unauthorized,
        constraint = buyer_usdc.mint == market.usdc_mint @ DegenError::InvalidMarketParams
    )]
    pub buyer_usdc: Box<Account<'info, TokenAccount>>,

    /// Buyer's token account for the outcome being purchased (Token-2022 ATA)
    /// CHECK: Validated manually against seller_args.outcome
    #[account(mut)]
    pub buyer_token_ata: AccountInfo<'info>,

    // Seller accounts (ASK side - sells tokens, receives USDC)
    /// CHECK: Seller wallet - validated by relayer
    pub seller: AccountInfo<'info>,

    /// Seller's USDC account (receives payment, regular Token program)
    #[account(
        mut,
        constraint = seller_usdc.owner == seller.key() @ DegenError::Unauthorized,
        constraint = seller_usdc.mint == market.usdc_mint @ DegenError::InvalidMarketParams
    )]
    pub seller_usdc: Box<Account<'info, TokenAccount>>,

    /// Seller's token account for the outcome being sold (Token-2022 ATA)
    #[account(
        mut,
        constraint = seller_token_ata.owner == seller.key() @ DegenError::Unauthorized
    )]
    pub seller_token_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Relayer that submits the tx (delegate for transfers)
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// Regular Token program for USDC operations
    pub token_program: Program<'info, Token>,
    /// Token-2022 program for YES/NO share token transfers
    pub share_token_program: Interface<'info, TokenInterface>,

    /// CHECK: Instructions sysvar for Ed25519 verification
    pub instructions: AccountInfo<'info>,
    /// CHECK: Session authority PDA when buyer uses a session signer, otherwise placeholder
    pub buyer_session_authority: AccountInfo<'info>,
    /// CHECK: Session authority PDA when seller uses a session signer, otherwise placeholder
    pub seller_session_authority: AccountInfo<'info>,
}

pub fn execute_close_v2(
    ctx: Context<ExecuteCloseV2>,
    buyer_args: PlaceOrderArgs,
    seller_args: PlaceOrderArgs,
    match_size: u64,
    taker_fee: u64,
    buyer_signer: Pubkey,
    seller_signer: Pubkey,
) -> Result<()> {
    let global_state = &ctx.accounts.global_state;
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;
    require!(ctx.accounts.relayer.key() == market.authority, DegenError::Unauthorized);

    // Validate buyer token ATA exists and belongs to the expected owner + mint.
    let validate_buyer_ata = |account: &AccountInfo, expected_owner: &Pubkey, expected_mint: &Pubkey| -> Result<()> {
        require!(account.data_len() > 0, DegenError::InvalidMarketParams);
        require!(*account.owner == ctx.accounts.share_token_program.key(), DegenError::InvalidMarketParams);
        let data = account.try_borrow_data()?;
        require!(data.len() >= 72, DegenError::InvalidMarketParams);
        let mint_bytes: [u8; 32] = data[0..32].try_into().unwrap();
        let owner_bytes: [u8; 32] = data[32..64].try_into().unwrap();
        require!(Pubkey::new_from_array(mint_bytes) == *expected_mint, DegenError::InvalidMarketParams);
        require!(Pubkey::new_from_array(owner_bytes) == *expected_owner, DegenError::Unauthorized);
        Ok(())
    };

    let expected_mint = match seller_args.outcome {
        Outcome::Yes => ctx.accounts.yes_mint.key(),
        Outcome::No => ctx.accounts.no_mint.key(),
    };
    validate_buyer_ata(&ctx.accounts.buyer_token_ata, &ctx.accounts.buyer.key(), &expected_mint)?;
    require!(ctx.accounts.seller_token_ata.mint == expected_mint, DegenError::InvalidMarketParams);

    let market_key = market.key();
    if buyer_signer != Pubkey::default() {
        require_order_authorization(
            &ctx.accounts.instructions,
            &ctx.accounts.buyer_session_authority,
            &market_key,
            &ctx.accounts.buyer.key(),
            &buyer_signer,
            &buyer_args,
        )?;
    }
    if seller_signer != Pubkey::default() {
        require_order_authorization(
            &ctx.accounts.instructions,
            &ctx.accounts.seller_session_authority,
            &market_key,
            &ctx.accounts.seller.key(),
            &seller_signer,
            &seller_args,
        )?;
    }

    // Validations
    require!(!global_state.paused, DegenError::ProtocolPaused);
    require!(market.status == MarketStatusV2::Open, DegenError::MarketNotOpen);
    require!(market.is_trading_open(clock.unix_timestamp), DegenError::MarketClosing);
    require!(ctx.accounts.buyer.key() != ctx.accounts.seller.key(), DegenError::SelfTrade);
    require!(buyer_args.side == Side::Bid, DegenError::SameSide);
    require!(seller_args.side == Side::Ask, DegenError::SameSide);
    require!(buyer_args.outcome == seller_args.outcome, DegenError::OutcomeMismatch);
    require!(buyer_args.price == seller_args.price, DegenError::PriceMismatch);
    require!(buyer_args.price >= MIN_PRICE && buyer_args.price <= MAX_PRICE, DegenError::InvalidPrice);
    require!(match_size >= MIN_ORDER_SIZE && match_size <= MAX_ORDER_SIZE, DegenError::InvalidSize);
    require!(buyer_args.expiry_ts > clock.unix_timestamp, DegenError::OrderExpired);
    require!(seller_args.expiry_ts > clock.unix_timestamp, DegenError::OrderExpired);
    require!(match_size <= buyer_args.size, DegenError::InvalidSize);
    require!(match_size <= seller_args.size, DegenError::InvalidSize);

    // Validate seller has enough tokens
    let seller_token_balance = ctx.accounts.seller_token_ata.amount;
    require!(seller_token_balance >= match_size, DegenError::InsufficientShares);

    // Calculate transfer amount: price * size / SHARE_MULTIPLIER
    let transfer_amount = buyer_args.price
        .checked_mul(match_size).ok_or(DegenError::MathOverflow)?
        .checked_add(SHARE_MULTIPLIER - 1).ok_or(DegenError::MathOverflow)?
        .checked_div(SHARE_MULTIPLIER).ok_or(DegenError::DivisionByZero)?;

    // Validate minimum fee (covers relayer gas costs)
    require!(taker_fee >= MIN_TAKER_FEE, DegenError::FeeTooLow);

    let fee = taker_fee;
    let seller_receives = transfer_amount.saturating_sub(fee);

    // =========================================================================
    // USDC TRANSFERS: Buyer pays seller directly (regular Token program)
    // =========================================================================

    // Transfer USDC from buyer to seller (using relayer as delegate)
    msg!("CloseV2: {} USDC from buyer to seller", seller_receives);
    let cpi_accounts = Transfer {
        from: ctx.accounts.buyer_usdc.to_account_info(),
        to: ctx.accounts.seller_usdc.to_account_info(),
        authority: ctx.accounts.relayer.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, seller_receives)?;

    // Transfer fee from buyer to fee recipient
    if fee > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.buyer_usdc.to_account_info(),
            to: ctx.accounts.fee_recipient.to_account_info(),
            authority: ctx.accounts.relayer.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, fee)?;
    }

    // =========================================================================
    // TOKEN TRANSFERS: Seller transfers YES/NO tokens to buyer (Token-2022)
    // Uses market PDA as PermanentDelegate authority (can transfer from any holder)
    // =========================================================================

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
    let market_account_info = market.to_account_info();

    match seller_args.outcome {
        Outcome::Yes => {
            msg!("CloseV2: Transferring {} YES tokens from seller to buyer (Token-2022, PermanentDelegate)", match_size);
            let cpi_accounts = TransferCheckedInterface {
                from: ctx.accounts.seller_token_ata.to_account_info(),
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.buyer_token_ata.to_account_info(),
                authority: market_account_info.clone(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.share_token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token_interface::transfer_checked(cpi_ctx, match_size, SHARE_TOKEN_DECIMALS)?;
        }
        Outcome::No => {
            msg!("CloseV2: Transferring {} NO tokens from seller to buyer (Token-2022, PermanentDelegate)", match_size);
            let cpi_accounts = TransferCheckedInterface {
                from: ctx.accounts.seller_token_ata.to_account_info(),
                mint: ctx.accounts.no_mint.to_account_info(),
                to: ctx.accounts.buyer_token_ata.to_account_info(),
                authority: market_account_info.clone(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.share_token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token_interface::transfer_checked(cpi_ctx, match_size, SHARE_TOKEN_DECIMALS)?;
        }
    }

    // =========================================================================
    // UPDATE MARKET STATS
    // =========================================================================

    // Volume increases, but open_interest stays the same (no new pairs minted)
    market.total_volume = market.total_volume.checked_add(transfer_amount).ok_or(DegenError::MathOverflow)?;
    market.total_trades = market.total_trades.checked_add(1).ok_or(DegenError::MathOverflow)?;

    msg!("CloseV2 executed: {} {:?} shares @ {} (transfer={}, fee={})",
         match_size, seller_args.outcome, buyer_args.price, transfer_amount, fee);

    emit!(CloseExecutedV2 {
        market: market.key(),
        buyer: ctx.accounts.buyer.key(),
        seller: ctx.accounts.seller.key(),
        outcome: seller_args.outcome,
        price: buyer_args.price,
        size: match_size,
        transfer_amount,
        fee,
    });

    Ok(())
}

#[event]
pub struct CloseExecutedV2 {
    pub market: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub outcome: Outcome,
    pub price: u64,
    pub size: u64,
    pub transfer_amount: u64,
    pub fee: u64,
}
