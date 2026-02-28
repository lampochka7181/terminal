use anchor_lang::prelude::*;
use crate::state_v2::{MarketV2, MarketStatusV2, MarketOutcomeV2, SettlementBitmap};
use crate::errors::DegenError;

/// Combined arguments for atomic resolve + post_merkle_root
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ResolveAndPostMerkleRootArgsV2 {
    /// Outcome determined by relayer (0 = Yes, 1 = No)
    pub outcome: u8,
    /// Final price at resolution (8 decimals)
    pub final_price: u64,
    /// The merkle root of all settlement leaves
    pub merkle_root: [u8; 32],
    /// Total USDC amount to be distributed
    pub total_amount: u64,
    /// Total number of settlements (leaves in the tree)
    pub total_settlements: u64,
}

/// Combined resolve + post merkle root instruction
///
/// Atomically resolves a V2 market AND posts the merkle root in a single TX.
/// This saves ~2s by eliminating a full TX round-trip between resolve and
/// post_merkle_root. The state transitions Open/Closed → Resolved → Settling
/// happen within a single instruction.
///
/// Accounts are the union of ResolveMarketV2 and PostMerkleRoot:
/// - market (from both)
/// - settlement_bitmap (from post_merkle_root, init)
/// - authority (from both)
/// - system_program (from post_merkle_root)
#[derive(Accounts)]
pub struct ResolveAndPostMerkleRootV2<'info> {
    #[account(
        mut,
        constraint = market.authority == authority.key() @ DegenError::Unauthorized
    )]
    pub market: Box<Account<'info, MarketV2>>,

    /// Initialize the first settlement bitmap (chunk 0)
    #[account(
        init,
        payer = authority,
        space = SettlementBitmap::SIZE,
        seeds = [
            SettlementBitmap::SEED,
            market.key().as_ref(),
            &0u16.to_le_bytes()  // chunk_index = 0
        ],
        bump
    )]
    pub settlement_bitmap: Box<Account<'info, SettlementBitmap>>,

    /// Authority (keeper/relayer) that triggers resolution + settlement
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Atomically resolve a V2 market and post the merkle root.
///
/// This combined instruction eliminates one full TX round-trip (~2s) by
/// performing both operations in a single transaction. The relayer pre-builds
/// the merkle tree while waiting for the resolve TX, so the root is ready
/// immediately.
pub fn resolve_and_post_merkle_root_v2(
    ctx: Context<ResolveAndPostMerkleRootV2>,
    args: ResolveAndPostMerkleRootArgsV2,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    // =========================================================================
    // Phase 1: Resolve (same logic as resolve_market_v2)
    // =========================================================================

    // Ensure market has expired
    require!(clock.unix_timestamp >= market.expiry_at, DegenError::MarketNotExpired);

    // Ensure not already resolved
    require!(
        market.status == MarketStatusV2::Open || market.status == MarketStatusV2::Closed,
        DegenError::MarketAlreadyResolved
    );

    // Validate outcome
    require!(args.outcome <= 1, DegenError::InvalidMarketParams);
    require!(args.final_price > 0, DegenError::InvalidOraclePrice);

    // Update market with resolution data
    market.final_price = args.final_price;
    market.resolved_at = clock.unix_timestamp;
    // Don't set status to Resolved yet - we'll go straight to Settling

    // Set outcome from relayer
    if args.outcome == 0 {
        market.outcome = MarketOutcomeV2::Yes;
    } else {
        market.outcome = MarketOutcomeV2::No;
    }

    // =========================================================================
    // Phase 2: Post Merkle Root (same logic as post_merkle_root)
    // =========================================================================

    // Validate the merkle root is non-zero
    require!(args.merkle_root != [0u8; 32], DegenError::InvalidMerkleRoot);
    require!(args.total_settlements > 0, DegenError::InvalidMerkleRoot);

    // Validate total amount against open interest
    let max_payout = market.open_interest;
    require!(args.total_amount <= max_payout, DegenError::InvalidSettlementAmount);

    // Update market with merkle settlement data
    market.settlement_merkle_root = args.merkle_root;
    market.has_merkle_root = true;
    market.total_settlement_amount = args.total_amount;
    market.settlements_total = args.total_settlements;
    market.settlements_processed = 0;
    // Skip Resolved, go directly to Settling
    market.status = MarketStatusV2::Settling;

    // Initialize the bitmap
    let bitmap = &mut ctx.accounts.settlement_bitmap;
    bitmap.market = market.key();
    bitmap.chunk_index = 0;
    bitmap.bitmap = [0u8; 1024];
    bitmap.bump = ctx.bumps.settlement_bitmap;

    // Log both operations
    if args.outcome == 0 {
        msg!(
            "MarketV2 #{} resolved+settling: YES wins (final={} > strike={}), {} settlements, {} USDC",
            market.id, args.final_price, market.strike_price,
            args.total_settlements, args.total_amount
        );
    } else {
        msg!(
            "MarketV2 #{} resolved+settling: NO wins (final={} <= strike={}), {} settlements, {} USDC",
            market.id, args.final_price, market.strike_price,
            args.total_settlements, args.total_amount
        );
    }

    // Emit both events for compatibility with indexers/listeners
    emit!(MarketV2ResolvedAndSettling {
        market: market.key(),
        market_id: market.id,
        outcome: market.outcome,
        final_price: args.final_price,
        strike_price: market.strike_price,
        resolved_at: clock.unix_timestamp,
        open_interest: market.open_interest,
        merkle_root: args.merkle_root,
        total_settlements: args.total_settlements,
        total_amount: args.total_amount,
    });

    Ok(())
}

#[event]
pub struct MarketV2ResolvedAndSettling {
    pub market: Pubkey,
    pub market_id: u64,
    pub outcome: MarketOutcomeV2,
    pub final_price: u64,
    pub strike_price: u64,
    pub resolved_at: i64,
    pub open_interest: u64,
    pub merkle_root: [u8; 32],
    pub total_settlements: u64,
    pub total_amount: u64,
}
