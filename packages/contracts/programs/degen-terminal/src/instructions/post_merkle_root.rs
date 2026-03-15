use anchor_lang::prelude::*;
use crate::state_v2::{MarketV2, MarketStatusV2, MarketOutcomeV2, SettlementBitmap};
use crate::errors::DegenError;

/// Arguments for post_merkle_root instruction
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PostMerkleRootArgs {
    /// The merkle root of all settlement leaves
    pub merkle_root: [u8; 32],
    /// Total USDC amount to be distributed
    pub total_amount: u64,
    /// Total number of settlements (leaves in the tree)
    pub total_settlements: u64,
}

/// Post the merkle root to begin batch settlement
///
/// This instruction transitions the market from RESOLVED to SETTLING.
/// The keeper builds a merkle tree off-chain with all (recipient, payout) pairs
/// and posts the root here to enable trustless batch settlement.
#[derive(Accounts)]
pub struct PostMerkleRoot<'info> {
    #[account(
        mut,
        constraint = market.status == MarketStatusV2::Resolved @ DegenError::MarketNotResolved,
        constraint = market.outcome != MarketOutcomeV2::Pending @ DegenError::MarketNotResolved,
        constraint = !market.has_merkle_root @ DegenError::MerkleRootAlreadySet,
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

    /// Authority (keeper/relayer) that posts the root
    #[account(
        mut,
        constraint = market.authority == authority.key() @ DegenError::Unauthorized
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn post_merkle_root(
    ctx: Context<PostMerkleRoot>,
    args: PostMerkleRootArgs,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    // Validate the merkle root is non-zero
    require!(args.merkle_root != [0u8; 32], DegenError::InvalidMerkleRoot);
    require!(args.total_settlements > 0, DegenError::InvalidMerkleRoot);

    // Exact payout must match open interest after fees have already been removed from the vault.
    require!(args.total_amount == market.open_interest, DegenError::InvalidSettlementAmount);
    let chunk_count = ((args.total_settlements + 8191) / 8192) as u16;
    require!(chunk_count > 0, DegenError::InvalidSettlementAmount);

    // Update market with merkle settlement data
    market.settlement_merkle_root = args.merkle_root;
    market.has_merkle_root = true;
    market.total_settlement_amount = args.total_amount;
    market.settlement_amount_paid = 0;
    market.settlements_total = args.total_settlements;
    market.settlements_processed = 0;
    market.settlement_bitmap_chunks = chunk_count;
    market.status = MarketStatusV2::Settling;

    // Initialize the bitmap
    let bitmap = &mut ctx.accounts.settlement_bitmap;
    bitmap.market = market.key();
    bitmap.chunk_index = 0;
    bitmap.bitmap = [0u8; 1024];
    bitmap.bump = ctx.bumps.settlement_bitmap;

    msg!(
        "MarketV2 #{} merkle root posted: {} settlements, {} USDC total",
        market.id,
        args.total_settlements,
        args.total_amount
    );

    emit!(MerkleRootPosted {
        market: market.key(),
        market_id: market.id,
        merkle_root: args.merkle_root,
        total_settlements: args.total_settlements,
        total_amount: args.total_amount,
        posted_at: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct MerkleRootPosted {
    pub market: Pubkey,
    pub market_id: u64,
    pub merkle_root: [u8; 32],
    pub total_settlements: u64,
    pub total_amount: u64,
    pub posted_at: i64,
}
