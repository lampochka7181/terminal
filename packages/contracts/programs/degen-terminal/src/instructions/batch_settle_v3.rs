use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state_v2::{
    MarketV2, MarketStatusV2, SettlementBitmap,
    verify_merkle_proof, create_settlement_leaf, hash_pair,
    empty_leaf_hash, build_subtree_root, log2_pow2, next_power_of_2,
    MAX_COMPACT_BATCH_SIZE, MAX_COMPACT_BRIDGE_DEPTH,
};
use crate::errors::DegenError;

/// Compact batch settlement data.
///
/// Instead of N individual full merkle proofs, we send N consecutive leaves
/// (identified by their amounts + remaining_accounts recipients) plus one
/// shared "bridge proof" from the subtree root to the global merkle root.
///
/// The on-chain program:
/// 1. Reconstructs leaf hashes from (recipient, amount) pairs
/// 2. Pads to subtree_size with empty_leaf_hash()
/// 3. Builds the subtree root by hashing pairs bottom-up
/// 4. Verifies the bridge proof against the global root
/// 5. Processes settlements (bitmap check + USDC transfer)
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CompactBatchSettlement {
    /// Starting leaf index in the global merkle tree.
    /// Must be aligned to subtree_size (start_index % subtree_size == 0).
    pub start_index: u64,
    /// Number of real settlement entries (1..=MAX_COMPACT_BATCH_SIZE).
    /// Remaining slots up to subtree_size are padded with empty_leaf_hash().
    pub count: u8,
    /// USDC payout amounts per entry (len == count), 6 decimals.
    pub amounts: Vec<u64>,
    /// Bridge proof: siblings from the subtree root level up to the global root.
    /// Length = global_depth - log2(subtree_size).
    pub bridge_proof: Vec<[u8; 32]>,
}

/// Compact batch settlement instruction (V3)
///
/// Settles up to MAX_COMPACT_BATCH_SIZE users in one TX using shared proofs.
/// Remaining accounts = recipient USDC ATAs (one per real entry, in order).
#[derive(Accounts)]
#[instruction(settlement: CompactBatchSettlement)]
pub struct BatchSettleV3<'info> {
    #[account(
        mut,
        constraint = market.status == MarketStatusV2::Settling @ DegenError::MarketNotSettling,
        constraint = market.has_merkle_root @ DegenError::MerkleRootNotSet,
    )]
    pub market: Box<Account<'info, MarketV2>>,

    /// The market's USDC vault (source of payouts)
    #[account(
        mut,
        constraint = vault.owner == market.key() @ DegenError::InvalidMarketParams
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// Settlement bitmap for tracking claimed settlements
    #[account(
        mut,
        seeds = [
            SettlementBitmap::SEED,
            market.key().as_ref(),
            &settlement_bitmap.chunk_index.to_le_bytes()
        ],
        bump = settlement_bitmap.bump,
        constraint = settlement_bitmap.market == market.key() @ DegenError::InvalidMarketParams
    )]
    pub settlement_bitmap: Box<Account<'info, SettlementBitmap>>,

    /// Relayer that submits the settlement batch - must be market authority
    #[account(
        mut,
        constraint = market.authority == relayer.key() @ DegenError::Unauthorized
    )]
    pub relayer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    // Remaining accounts: recipient USDC token accounts (in same order as amounts)
}

pub fn batch_settle_v3<'info>(
    ctx: Context<'_, '_, 'info, 'info, BatchSettleV3<'info>>,
    settlement: CompactBatchSettlement,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let bitmap = &mut ctx.accounts.settlement_bitmap;

    let count = settlement.count as usize;

    // =========================================================================
    // 1. Validate inputs
    // =========================================================================
    require!(
        count > 0 && count <= MAX_COMPACT_BATCH_SIZE,
        DegenError::InvalidBatchSize
    );
    require!(
        ctx.remaining_accounts.len() == count,
        DegenError::InvalidAccountCount
    );
    require!(
        settlement.amounts.len() == count,
        DegenError::InvalidAccountCount
    );
    require!(
        settlement.bridge_proof.len() <= MAX_COMPACT_BRIDGE_DEPTH,
        DegenError::InvalidMerkleProof
    );

    // Compute subtree_size: smallest power-of-2 >= count.
    // The API picks this same value and provides a bridge proof of length
    // (global_depth - subtree_depth) to connect the subtree root to the global root.
    let subtree_size = next_power_of_2(count);

    // Validate alignment
    require!(
        settlement.start_index % (subtree_size as u64) == 0,
        DegenError::InvalidCompactAlignment
    );

    // =========================================================================
    // 2. Compute leaf hashes from (recipient, amount) pairs
    // =========================================================================
    let mut leaf_hashes: Vec<[u8; 32]> = Vec::with_capacity(subtree_size);

    for i in 0..count {
        let recipient_account = &ctx.remaining_accounts[i];
        let recipient_token: Account<TokenAccount> = Account::try_from(recipient_account)?;

        let leaf = create_settlement_leaf(&recipient_token.owner, settlement.amounts[i]);
        leaf_hashes.push(leaf);
    }

    // =========================================================================
    // 3. Pad to subtree_size with empty_leaf_hash()
    // =========================================================================
    let empty = empty_leaf_hash();
    while leaf_hashes.len() < subtree_size {
        leaf_hashes.push(empty);
    }

    // =========================================================================
    // 4. Build subtree root
    // =========================================================================
    let subtree_root = build_subtree_root(&leaf_hashes);

    // =========================================================================
    // 5. Verify bridge proof: subtree_root → global root
    // =========================================================================
    // The subtree root is at index (start_index / subtree_size) in the
    // level above the subtree. We verify it against the global root.
    let subtree_index = settlement.start_index / (subtree_size as u64);
    require!(
        verify_merkle_proof(
            &settlement.bridge_proof,
            &market.settlement_merkle_root,
            subtree_root,
            subtree_index,
        ),
        DegenError::InvalidMerkleProof
    );

    // =========================================================================
    // 6. Process settlements (bitmap + transfers)
    // =========================================================================
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
    let mut total_paid = 0u64;
    let mut settlements_count = 0u64;

    let chunk_size = 8192u64; // 1024 bytes * 8 bits

    for i in 0..count {
        let global_index = settlement.start_index + (i as u64);

        // Check bitmap chunk
        let chunk_index = (global_index / chunk_size) as u16;
        let index_in_chunk = (global_index % chunk_size) as usize;

        require!(
            chunk_index == bitmap.chunk_index,
            DegenError::WrongBitmapChunk
        );

        // Check not already claimed
        require!(
            !bitmap.is_claimed(index_in_chunk),
            DegenError::AlreadyClaimed
        );

        // Transfer USDC from vault to recipient
        let amount = settlement.amounts[i];
        if amount > 0 {
            let recipient_account = &ctx.remaining_accounts[i];
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: recipient_account.to_account_info(),
                authority: market_account_info.clone(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, amount)?;

            total_paid = total_paid.checked_add(amount).ok_or(DegenError::MathOverflow)?;
        }

        // Mark as claimed
        bitmap.mark_claimed(index_in_chunk);
        settlements_count += 1;
    }

    // =========================================================================
    // 7. Update market settlement progress
    // =========================================================================
    let market = &mut ctx.accounts.market;
    market.settlements_processed = market.settlements_processed
        .checked_add(settlements_count)
        .ok_or(DegenError::MathOverflow)?;

    msg!(
        "V3 compact batch: {} settlements from index {}, {} USDC paid, {}/{} total",
        settlements_count,
        settlement.start_index,
        total_paid,
        market.settlements_processed,
        market.settlements_total
    );

    emit!(BatchSettledV3 {
        market: market.key(),
        start_index: settlement.start_index,
        settlements_in_batch: settlements_count,
        total_paid,
        settlements_processed: market.settlements_processed,
        settlements_total: market.settlements_total,
    });

    Ok(())
}

#[event]
pub struct BatchSettledV3 {
    pub market: Pubkey,
    pub start_index: u64,
    pub settlements_in_batch: u64,
    pub total_paid: u64,
    pub settlements_processed: u64,
    pub settlements_total: u64,
}
