use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::{self, Mint as MintInterface, TokenInterface, TokenAccount as TokenAccountInterface, TransferChecked as TransferCheckedInterface};
use crate::state_v2::{MarketV2, MarketStatusV2, SHARE_TOKEN_DECIMALS};
use crate::state::{GlobalState, Outcome, SHARE_MULTIPLIER, MIN_PRICE, MAX_PRICE, MIN_ORDER_SIZE, MAX_ORDER_SIZE, MIN_TAKER_FEE};
use crate::errors::DegenError;

/// Arguments for execute_close_v2 instruction
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CloseTradeArgsV2 {
    pub outcome: Outcome,      // YES or NO being sold
    pub price: u64,            // Execution price (6 decimals)
    pub size: u64,             // Number of shares (6 decimals)
    pub taker_fee: u64,        // Fee specified by relayer
}

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
        constraint = fee_recipient.owner == global_state.fee_recipient @ DegenError::Unauthorized
    )]
    pub fee_recipient: Box<Account<'info, TokenAccount>>,

    // Buyer accounts (BID side - pays USDC, receives tokens)
    /// CHECK: Buyer wallet - validated by relayer
    pub buyer: AccountInfo<'info>,

    /// Buyer's USDC account (source of payment, regular Token program)
    #[account(
        mut,
        constraint = buyer_usdc.owner == buyer.key() @ DegenError::Unauthorized
    )]
    pub buyer_usdc: Box<Account<'info, TokenAccount>>,

    /// Buyer's YES token account (Token-2022 ATA, must be pre-created)
    /// CHECK: Validated manually - must be ATA for buyer+yes_mint
    #[account(mut)]
    pub buyer_yes_ata: AccountInfo<'info>,

    /// Buyer's NO token account (Token-2022 ATA, must be pre-created)
    /// CHECK: Validated manually - must be ATA for buyer+no_mint
    #[account(mut)]
    pub buyer_no_ata: AccountInfo<'info>,

    // Seller accounts (ASK side - sells tokens, receives USDC)
    /// CHECK: Seller wallet - validated by relayer
    pub seller: AccountInfo<'info>,

    /// Seller's USDC account (receives payment, regular Token program)
    #[account(
        mut,
        constraint = seller_usdc.owner == seller.key() @ DegenError::Unauthorized
    )]
    pub seller_usdc: Box<Account<'info, TokenAccount>>,

    /// Seller's YES token account (Token-2022 ATA, source if selling YES)
    #[account(
        mut,
        constraint = seller_yes_ata.owner == seller.key() @ DegenError::Unauthorized,
        constraint = seller_yes_ata.mint == yes_mint.key() @ DegenError::InvalidMarketParams
    )]
    pub seller_yes_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Seller's NO token account (Token-2022 ATA, source if selling NO)
    #[account(
        mut,
        constraint = seller_no_ata.owner == seller.key() @ DegenError::Unauthorized,
        constraint = seller_no_ata.mint == no_mint.key() @ DegenError::InvalidMarketParams
    )]
    pub seller_no_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Relayer that submits the tx (delegate for transfers)
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// Regular Token program for USDC operations
    pub token_program: Program<'info, Token>,
    /// Token-2022 program for YES/NO share token transfers
    pub share_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn execute_close_v2(
    ctx: Context<ExecuteCloseV2>,
    args: CloseTradeArgsV2,
) -> Result<()> {
    let global_state = &ctx.accounts.global_state;
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    // Validate buyer ATAs exist (must be pre-created)
    require!(
        ctx.accounts.buyer_yes_ata.data_len() > 0,
        DegenError::InvalidMarketParams
    );
    require!(
        ctx.accounts.buyer_no_ata.data_len() > 0,
        DegenError::InvalidMarketParams
    );

    // Validations
    require!(!global_state.paused, DegenError::ProtocolPaused);
    require!(market.status == MarketStatusV2::Open, DegenError::MarketNotOpen);
    require!(market.is_trading_open(clock.unix_timestamp), DegenError::MarketClosing);
    require!(ctx.accounts.buyer.key() != ctx.accounts.seller.key(), DegenError::SelfTrade);
    require!(args.price >= MIN_PRICE && args.price <= MAX_PRICE, DegenError::InvalidPrice);
    require!(args.size >= MIN_ORDER_SIZE && args.size <= MAX_ORDER_SIZE, DegenError::InvalidSize);

    // Validate seller has enough tokens
    let seller_token_balance = match args.outcome {
        Outcome::Yes => ctx.accounts.seller_yes_ata.amount,
        Outcome::No => ctx.accounts.seller_no_ata.amount,
    };
    require!(seller_token_balance >= args.size, DegenError::InsufficientShares);

    // Calculate transfer amount: price * size / SHARE_MULTIPLIER
    let transfer_amount = args.price
        .checked_mul(args.size).ok_or(DegenError::MathOverflow)?
        .checked_add(SHARE_MULTIPLIER - 1).ok_or(DegenError::MathOverflow)?
        .checked_div(SHARE_MULTIPLIER).ok_or(DegenError::DivisionByZero)?;

    // Validate minimum fee (covers relayer gas costs)
    require!(args.taker_fee >= MIN_TAKER_FEE, DegenError::FeeTooLow);

    let fee = args.taker_fee;
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

    match args.outcome {
        Outcome::Yes => {
            msg!("CloseV2: Transferring {} YES tokens from seller to buyer (Token-2022, PermanentDelegate)", args.size);
            let cpi_accounts = TransferCheckedInterface {
                from: ctx.accounts.seller_yes_ata.to_account_info(),
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.buyer_yes_ata.to_account_info(),
                authority: market_account_info.clone(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.share_token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token_interface::transfer_checked(cpi_ctx, args.size, SHARE_TOKEN_DECIMALS)?;
        }
        Outcome::No => {
            msg!("CloseV2: Transferring {} NO tokens from seller to buyer (Token-2022, PermanentDelegate)", args.size);
            let cpi_accounts = TransferCheckedInterface {
                from: ctx.accounts.seller_no_ata.to_account_info(),
                mint: ctx.accounts.no_mint.to_account_info(),
                to: ctx.accounts.buyer_no_ata.to_account_info(),
                authority: market_account_info.clone(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.share_token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token_interface::transfer_checked(cpi_ctx, args.size, SHARE_TOKEN_DECIMALS)?;
        }
    }

    // =========================================================================
    // UPDATE MARKET STATS
    // =========================================================================

    // Volume increases, but open_interest stays the same (no new pairs minted)
    market.total_volume = market.total_volume.checked_add(transfer_amount).ok_or(DegenError::MathOverflow)?;
    market.total_trades = market.total_trades.checked_add(1).ok_or(DegenError::MathOverflow)?;

    msg!("CloseV2 executed: {} {:?} shares @ {} (transfer={}, fee={})",
         args.size, args.outcome, args.price, transfer_amount, fee);

    emit!(CloseExecutedV2 {
        market: market.key(),
        buyer: ctx.accounts.buyer.key(),
        seller: ctx.accounts.seller.key(),
        outcome: args.outcome,
        price: args.price,
        size: args.size,
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
