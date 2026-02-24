use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state_v2::{MarketV2, MarketStatusV2, SettlementBitmap, verify_merkle_proof, create_settlement_leaf, MAX_SETTLEMENTS_PER_BATCH, MAX_MERKLE_PROOF_DEPTH};
use crate::errors::DegenError;

/// A single settlement entry with proof
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SettlementEntry {
    /// Recipient's wallet pubkey
    pub recipient: Pubkey,
    /// Payout amount in USDC (6 decimals)
    pub amount: u64,
    /// Index in the merkle tree (for proof verification)
    pub index: u64,
    /// Merkle proof (variable length, max MAX_MERKLE_PROOF_DEPTH)
    pub proof: Vec<[u8; 32]>,
}

/// Batch settle multiple users with merkle proofs
///
/// This instruction settles up to MAX_SETTLEMENTS_PER_BATCH users in one tx.
/// Each settlement is verified against the merkle root before payout.
/// A bitmap tracks which leaves have been claimed to prevent double-settlement.
#[derive(Accounts)]
#[instruction(settlements: Vec<SettlementEntry>)]
pub struct BatchSettleV2<'info> {
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
    /// Must match the chunk that contains the settlement indices
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

    // Remaining accounts: recipient USDC token accounts (in same order as settlements)
}

pub fn batch_settle_v2<'info>(
    ctx: Context<'_, '_, 'info, 'info, BatchSettleV2<'info>>,
    settlements: Vec<SettlementEntry>,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let bitmap = &mut ctx.accounts.settlement_bitmap;

    // Validate batch size
    require!(
        settlements.len() > 0 && settlements.len() <= MAX_SETTLEMENTS_PER_BATCH,
        DegenError::InvalidBatchSize
    );

    // Validate we have enough remaining accounts for recipients
    require!(
        ctx.remaining_accounts.len() == settlements.len(),
        DegenError::InvalidAccountCount
    );

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

    // Process each settlement
    for (i, settlement) in settlements.iter().enumerate() {
        // Validate proof length
        require!(
            settlement.proof.len() <= MAX_MERKLE_PROOF_DEPTH,
            DegenError::InvalidMerkleProof
        );

        // Check if already claimed
        let chunk_size = 8192u64; // 1024 bytes * 8 bits
        let chunk_index = (settlement.index / chunk_size) as u16;
        let index_in_chunk = (settlement.index % chunk_size) as usize;

        // Ensure this settlement belongs to the current bitmap chunk
        require!(
            chunk_index == bitmap.chunk_index,
            DegenError::WrongBitmapChunk
        );

        // Check not already claimed
        require!(
            !bitmap.is_claimed(index_in_chunk),
            DegenError::AlreadyClaimed
        );

        // Verify merkle proof
        let leaf = create_settlement_leaf(&settlement.recipient, settlement.amount);
        let proof_slice: Vec<[u8; 32]> = settlement.proof.clone();

        require!(
            verify_merkle_proof(&proof_slice, &market.settlement_merkle_root, leaf, settlement.index),
            DegenError::InvalidMerkleProof
        );

        // Get recipient's USDC account from remaining accounts
        let recipient_usdc = &ctx.remaining_accounts[i];

        // Validate it's a token account owned by the recipient
        let recipient_token: Account<TokenAccount> = Account::try_from(recipient_usdc)?;
        require!(
            recipient_token.owner == settlement.recipient,
            DegenError::InvalidRecipient
        );

        // Transfer USDC from vault to recipient
        if settlement.amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: recipient_usdc.to_account_info(),
                authority: market_account_info.clone(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds
            );
            token::transfer(cpi_ctx, settlement.amount)?;

            total_paid = total_paid.checked_add(settlement.amount).ok_or(DegenError::MathOverflow)?;
        }

        // Mark as claimed
        bitmap.mark_claimed(index_in_chunk);
        settlements_count += 1;

        msg!(
            "Settled #{}: {} receives {} USDC",
            settlement.index,
            settlement.recipient,
            settlement.amount
        );
    }

    // Update market settlement progress
    let market = &mut ctx.accounts.market;
    market.settlements_processed = market.settlements_processed
        .checked_add(settlements_count)
        .ok_or(DegenError::MathOverflow)?;

    msg!(
        "Batch settlement complete: {} settlements, {} USDC paid, {}/{} total processed",
        settlements_count,
        total_paid,
        market.settlements_processed,
        market.settlements_total
    );

    emit!(BatchSettled {
        market: market.key(),
        settlements_in_batch: settlements_count,
        total_paid,
        settlements_processed: market.settlements_processed,
        settlements_total: market.settlements_total,
    });

    Ok(())
}

#[event]
pub struct BatchSettled {
    pub market: Pubkey,
    pub settlements_in_batch: u64,
    pub total_paid: u64,
    pub settlements_processed: u64,
    pub settlements_total: u64,
}
