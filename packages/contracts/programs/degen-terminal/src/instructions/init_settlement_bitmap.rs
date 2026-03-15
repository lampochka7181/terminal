use anchor_lang::prelude::*;

use crate::errors::DegenError;
use crate::state_v2::{MarketStatusV2, MarketV2, SettlementBitmap};

#[derive(Accounts)]
#[instruction(chunk_index: u16)]
pub struct InitSettlementBitmap<'info> {
    #[account(
        mut,
        constraint = market.authority == authority.key() @ DegenError::Unauthorized,
        constraint = market.status == MarketStatusV2::Settling @ DegenError::MarketNotSettling,
        constraint = market.has_merkle_root @ DegenError::MerkleRootNotSet,
        constraint = chunk_index > 0 @ DegenError::WrongBitmapChunk,
        constraint = chunk_index < market.settlement_bitmap_chunks @ DegenError::WrongBitmapChunk,
    )]
    pub market: Box<Account<'info, MarketV2>>,

    #[account(
        init,
        payer = authority,
        space = SettlementBitmap::SIZE,
        seeds = [
            SettlementBitmap::SEED,
            market.key().as_ref(),
            &chunk_index.to_le_bytes()
        ],
        bump
    )]
    pub settlement_bitmap: Box<Account<'info, SettlementBitmap>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn init_settlement_bitmap(
    ctx: Context<InitSettlementBitmap>,
    chunk_index: u16,
) -> Result<()> {
    let bitmap = &mut ctx.accounts.settlement_bitmap;
    bitmap.market = ctx.accounts.market.key();
    bitmap.chunk_index = chunk_index;
    bitmap.bitmap = [0u8; 1024];
    bitmap.bump = ctx.bumps.settlement_bitmap;

    Ok(())
}
