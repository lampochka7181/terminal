use anchor_lang::prelude::*;

// ============================================================================
// V2 STATE - TOKENIZED SHARES MODEL
// ============================================================================
//
// This module contains the V2 state structures for the tokenized shares model.
// In V2, positions are represented as SPL tokens instead of Position PDAs.
//
// Key changes from V1:
// - Market has YES/NO token mints instead of position tracking
// - Users hold YES/NO tokens in their ATAs
// - Settlement uses merkle proofs for batch processing
// - New SETTLING status for merkle-based settlement

/// V2 Market status (includes SETTLING for merkle settlement)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketStatusV2 {
    Pending = 0,    // Pre-created, awaiting activation (strike price not set)
    Open = 1,       // Trading active, YES/NO tokens being minted
    Closed = 2,     // Trading stopped, awaiting resolution
    Resolved = 3,   // Outcome determined
    Settling = 4,   // NEW: Merkle root posted, batches processing
    Settled = 5,    // All positions paid out
}

impl Default for MarketStatusV2 {
    fn default() -> Self {
        MarketStatusV2::Pending
    }
}

/// V2 Market outcome result
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketOutcomeV2 {
    Pending = 0,
    Yes = 1,
    No = 2,
}

impl Default for MarketOutcomeV2 {
    fn default() -> Self {
        MarketOutcomeV2::Pending
    }
}

// ============================================================================
// V2 CONSTANTS
// ============================================================================

/// Maximum merkle proof depth (supports up to 2^20 = 1M settlements)
pub const MAX_MERKLE_PROOF_DEPTH: usize = 20;

/// Maximum settlements per batch instruction (V2 individual proofs)
pub const MAX_SETTLEMENTS_PER_BATCH: usize = 15;

/// Maximum entries in a compact settlement batch V3 (must be power of 2)
pub const MAX_COMPACT_BATCH_SIZE: usize = 16;

/// Maximum bridge proof depth for compact batches
/// Global tree max depth (20) - log2(MAX_COMPACT_BATCH_SIZE=16) = 16
pub const MAX_COMPACT_BRIDGE_DEPTH: usize = 16;

/// YES/NO token decimals (same as USDC for simplicity)
pub const SHARE_TOKEN_DECIMALS: u8 = 6;

// ============================================================================
// V2 ACCOUNTS
// ============================================================================

/// V2 Market account with tokenized shares
#[account]
pub struct MarketV2 {
    /// Unique market ID (incrementing)
    pub id: u64,
    /// Authority (the relayer that can resolve/settle)
    pub authority: Pubkey,
    /// Asset symbol (BTC, ETH, SOL)
    pub asset: [u8; 10],  // MAX_ASSET_LEN
    /// Timeframe (5m, 15m, 1h, 4h, 24h)
    pub timeframe: [u8; 10],  // MAX_TIMEFRAME_LEN
    /// Strike price (8 decimals to match oracle precision)
    pub strike_price: u64,
    /// Final oracle price at resolution (8 decimals)
    pub final_price: u64,
    /// Market creation timestamp
    pub created_at: i64,
    /// Market expiry timestamp
    pub expiry_at: i64,
    /// Resolution timestamp (when outcome was set)
    pub resolved_at: i64,
    /// Settlement completion timestamp
    pub settled_at: i64,
    /// Market status (V2 with SETTLING)
    pub status: MarketStatusV2,
    /// Market outcome (only valid when status >= Resolved)
    pub outcome: MarketOutcomeV2,
    /// Total volume traded (USDC, 6 decimals)
    pub total_volume: u64,
    /// Total number of trades
    pub total_trades: u32,

    // =========================================================================
    // V2 TOKENIZED FIELDS (replaces position tracking)
    // =========================================================================

    /// YES token mint (SPL token representing YES shares)
    pub yes_mint: Pubkey,
    /// NO token mint (SPL token representing NO shares)
    pub no_mint: Pubkey,
    /// Open interest (total YES/NO token pairs minted)
    pub open_interest: u64,

    // =========================================================================
    // V2 MERKLE SETTLEMENT FIELDS
    // =========================================================================

    /// Merkle root for settlement (set when market enters SETTLING)
    /// Hash of all (recipient, payout) pairs
    pub settlement_merkle_root: [u8; 32],
    /// Whether merkle root has been set
    pub has_merkle_root: bool,
    /// Total USDC to be distributed in settlement
    pub total_settlement_amount: u64,
    /// Number of settlements processed so far
    pub settlements_processed: u64,
    /// Total number of settlements expected
    pub settlements_total: u64,

    /// Bump seed for PDA
    pub bump: u8,
    /// Bump for YES mint PDA
    pub yes_mint_bump: u8,
    /// Bump for NO mint PDA
    pub no_mint_bump: u8,
}

impl MarketV2 {
    pub const SEED: &'static [u8] = b"market_v2";
    pub const YES_MINT_SEED: &'static [u8] = b"yes_mint";
    pub const NO_MINT_SEED: &'static [u8] = b"no_mint";

    pub const SIZE: usize = 8 +     // discriminator
        8 +                         // id
        32 +                        // authority
        10 +                        // asset
        10 +                        // timeframe
        8 +                         // strike_price
        8 +                         // final_price
        8 +                         // created_at
        8 +                         // expiry_at
        8 +                         // resolved_at
        8 +                         // settled_at
        1 +                         // status
        1 +                         // outcome
        8 +                         // total_volume
        4 +                         // total_trades
        // V2 tokenized fields
        32 +                        // yes_mint
        32 +                        // no_mint
        8 +                         // open_interest
        // V2 merkle settlement fields
        32 +                        // settlement_merkle_root
        1 +                         // has_merkle_root
        8 +                         // total_settlement_amount
        8 +                         // settlements_processed
        8 +                         // settlements_total
        // Bumps
        1 +                         // bump
        1 +                         // yes_mint_bump
        1;                          // no_mint_bump

    /// Check if market is open for trading
    pub fn is_trading_open(&self, current_time: i64) -> bool {
        self.status == MarketStatusV2::Open &&
        current_time < self.expiry_at - 2  // TRADING_CLOSE_BUFFER
    }

    /// Get asset as string
    pub fn asset_str(&self) -> String {
        String::from_utf8_lossy(&self.asset)
            .trim_end_matches('\0')
            .to_string()
    }

    /// Get timeframe as string
    pub fn timeframe_str(&self) -> String {
        String::from_utf8_lossy(&self.timeframe)
            .trim_end_matches('\0')
            .to_string()
    }

    /// Get asset bytes without null padding (for PDA signing)
    pub fn asset_bytes(&self) -> &[u8] {
        let len = self.asset.iter().position(|&x| x == 0).unwrap_or(self.asset.len());
        &self.asset[..len]
    }

    /// Get timeframe bytes without null padding (for PDA signing)
    pub fn timeframe_bytes(&self) -> &[u8] {
        let len = self.timeframe.iter().position(|&x| x == 0).unwrap_or(self.timeframe.len());
        &self.timeframe[..len]
    }

    /// Check if all settlements are complete
    pub fn is_settlement_complete(&self) -> bool {
        self.has_merkle_root && self.settlements_processed >= self.settlements_total
    }
}

/// Settlement bitmap for tracking which leaves have been claimed
/// Supports up to 8192 settlements per bitmap account (1024 bytes)
#[account]
pub struct SettlementBitmap {
    /// The market this bitmap belongs to
    pub market: Pubkey,
    /// Bitmap chunk index (0 = settlements 0-8191, 1 = 8192-16383, etc.)
    pub chunk_index: u16,
    /// Bitmap data (1 bit per settlement, 1 = claimed)
    pub bitmap: [u8; 1024],
    /// Bump seed for PDA
    pub bump: u8,
}

impl SettlementBitmap {
    pub const SEED: &'static [u8] = b"settlement_bitmap";

    pub const SIZE: usize = 8 +     // discriminator
        32 +                        // market
        2 +                         // chunk_index
        1024 +                      // bitmap
        1;                          // bump

    /// Check if a settlement index has been claimed
    pub fn is_claimed(&self, index_in_chunk: usize) -> bool {
        let byte_index = index_in_chunk / 8;
        let bit_index = index_in_chunk % 8;
        (self.bitmap[byte_index] & (1 << bit_index)) != 0
    }

    /// Mark a settlement index as claimed
    pub fn mark_claimed(&mut self, index_in_chunk: usize) {
        let byte_index = index_in_chunk / 8;
        let bit_index = index_in_chunk % 8;
        self.bitmap[byte_index] |= 1 << bit_index;
    }
}

// ============================================================================
// V2 HELPER FUNCTIONS
// ============================================================================

/// Verify a merkle proof
/// Returns true if the proof is valid for the given leaf and root
pub fn verify_merkle_proof(
    proof: &[[u8; 32]],
    root: &[u8; 32],
    leaf: [u8; 32],
    index: u64,
) -> bool {
    let mut computed_hash = leaf;
    let mut idx = index;

    for proof_element in proof.iter() {
        if idx % 2 == 0 {
            // Leaf is on the left, proof element is on the right
            computed_hash = hash_pair(&computed_hash, proof_element);
        } else {
            // Leaf is on the right, proof element is on the left
            computed_hash = hash_pair(proof_element, &computed_hash);
        }
        idx /= 2;
    }

    computed_hash == *root
}

/// Domain separation prefixes to prevent leaf/internal node confusion
/// Leaves are prefixed with 0x00, internal nodes with 0x01
const LEAF_PREFIX: u8 = 0x00;
const NODE_PREFIX: u8 = 0x01;

/// Hash two 32-byte values together using keccak256
/// For merkle tree construction, we sort the pair to ensure deterministic ordering
/// Uses NODE_PREFIX (0x01) domain separation to distinguish from leaf hashes
pub fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    use anchor_lang::solana_program::keccak;

    // Domain separation: prefix with 0x01 for internal nodes
    let mut data = [0u8; 65]; // 1 prefix + 32 + 32
    data[0] = NODE_PREFIX;
    if left < right {
        data[1..33].copy_from_slice(left);
        data[33..65].copy_from_slice(right);
    } else {
        data[1..33].copy_from_slice(right);
        data[33..65].copy_from_slice(left);
    }

    keccak::hash(&data).0
}

/// Create a leaf hash from recipient and amount
/// Uses LEAF_PREFIX (0x00) domain separation to distinguish from internal nodes
pub fn create_settlement_leaf(recipient: &Pubkey, amount: u64) -> [u8; 32] {
    use anchor_lang::solana_program::keccak;

    let mut data = [0u8; 41]; // 1 prefix + 32 bytes pubkey + 8 bytes amount
    data[0] = LEAF_PREFIX;
    data[1..33].copy_from_slice(recipient.as_ref());
    data[33..41].copy_from_slice(&amount.to_le_bytes());

    keccak::hash(&data).0
}

// ============================================================================
// V3 COMPACT BATCH SETTLEMENT HELPERS
// ============================================================================

/// Empty leaf hash for padding subtrees in compact batch settlement.
/// MUST match TypeScript: keccak256(new Uint8Array(40)) — 40 zero bytes.
/// This is NOT create_settlement_leaf(Pubkey::default(), 0) which uses 41 bytes
/// (includes LEAF_PREFIX byte).
pub fn empty_leaf_hash() -> [u8; 32] {
    use anchor_lang::solana_program::keccak;
    keccak::hash(&[0u8; 40]).0
}

/// Round up to the next power of 2 (for subtree construction).
/// Returns 1 for n=0 or n=1.
pub fn next_power_of_2(n: usize) -> usize {
    let mut v = 1usize;
    while v < n {
        v *= 2;
    }
    v
}

/// log2 of a power-of-2 value. Panics if n is not a power of 2.
pub fn log2_pow2(n: usize) -> usize {
    assert!(n > 0 && (n & (n - 1)) == 0, "n must be a power of 2");
    n.trailing_zeros() as usize
}

/// Build a subtree root from leaf hashes by hashing pairs bottom-up.
/// `leaves` must have length equal to a power of 2.
pub fn build_subtree_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    let n = leaves.len();
    assert!(n > 0 && (n & (n - 1)) == 0, "leaves must be power of 2");

    let mut current: Vec<[u8; 32]> = leaves.to_vec();
    while current.len() > 1 {
        let mut next = Vec::with_capacity(current.len() / 2);
        for i in (0..current.len()).step_by(2) {
            next.push(hash_pair(&current[i], &current[i + 1]));
        }
        current = next;
    }
    current[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_settlement_bitmap() {
        let mut bitmap = SettlementBitmap {
            market: Pubkey::default(),
            chunk_index: 0,
            bitmap: [0u8; 1024],
            bump: 0,
        };

        // Test initial state
        assert!(!bitmap.is_claimed(0));
        assert!(!bitmap.is_claimed(100));
        assert!(!bitmap.is_claimed(8191));

        // Test claiming
        bitmap.mark_claimed(0);
        assert!(bitmap.is_claimed(0));
        assert!(!bitmap.is_claimed(1));

        bitmap.mark_claimed(100);
        assert!(bitmap.is_claimed(100));
        assert!(!bitmap.is_claimed(99));
        assert!(!bitmap.is_claimed(101));
    }

    #[test]
    fn test_merkle_verification() {
        use anchor_lang::solana_program::keccak;
        // Simple test with 2-leaf tree using proper leaf hashing
        let recipient1 = Pubkey::new_unique();
        let recipient2 = Pubkey::new_unique();
        let leaf1 = create_settlement_leaf(&recipient1, 1_000_000);
        let leaf2 = create_settlement_leaf(&recipient2, 2_000_000);

        let root = hash_pair(&leaf1, &leaf2);

        // Verify leaf1 with proof [leaf2]
        assert!(verify_merkle_proof(&[leaf2], &root, leaf1, 0));

        // Verify leaf2 with proof [leaf1]
        assert!(verify_merkle_proof(&[leaf1], &root, leaf2, 1));

        // Invalid proofs should fail
        assert!(!verify_merkle_proof(&[leaf1], &root, leaf1, 0));
    }

    #[test]
    fn test_domain_separation() {
        // Ensure leaves and internal nodes produce different hashes
        let recipient = Pubkey::new_unique();
        let leaf = create_settlement_leaf(&recipient, 1_000_000);

        // An internal node hash should differ from a leaf with the same data
        let fake_leaf = hash_pair(&[0u8; 32], &[1u8; 32]);
        assert_ne!(leaf, fake_leaf);
    }

    #[test]
    fn test_empty_leaf_hash_differs_from_settlement_leaf() {
        // empty_leaf_hash = keccak256(40 zeros)
        // create_settlement_leaf(default, 0) = keccak256(0x00 || 32_zeros || 8_zeros) = keccak256(41 bytes)
        let empty = empty_leaf_hash();
        let settlement_default = create_settlement_leaf(&Pubkey::default(), 0);
        assert_ne!(empty, settlement_default, "empty_leaf_hash must differ from create_settlement_leaf(default, 0)");
    }

    #[test]
    fn test_next_power_of_2() {
        assert_eq!(next_power_of_2(0), 1);
        assert_eq!(next_power_of_2(1), 1);
        assert_eq!(next_power_of_2(2), 2);
        assert_eq!(next_power_of_2(3), 4);
        assert_eq!(next_power_of_2(5), 8);
        assert_eq!(next_power_of_2(8), 8);
        assert_eq!(next_power_of_2(200), 256);
    }

    #[test]
    fn test_log2_pow2() {
        assert_eq!(log2_pow2(1), 0);
        assert_eq!(log2_pow2(2), 1);
        assert_eq!(log2_pow2(4), 2);
        assert_eq!(log2_pow2(8), 3);
        assert_eq!(log2_pow2(16), 4);
    }

    #[test]
    fn test_build_subtree_root() {
        let r1 = Pubkey::new_unique();
        let r2 = Pubkey::new_unique();
        let leaf1 = create_settlement_leaf(&r1, 1_000_000);
        let leaf2 = create_settlement_leaf(&r2, 2_000_000);

        // 2-leaf subtree: root should equal hash_pair(leaf1, leaf2)
        let root = build_subtree_root(&[leaf1, leaf2]);
        let expected = hash_pair(&leaf1, &leaf2);
        assert_eq!(root, expected);

        // 4-leaf subtree with padding
        let empty = empty_leaf_hash();
        let root4 = build_subtree_root(&[leaf1, leaf2, empty, empty]);
        let pair_left = hash_pair(&leaf1, &leaf2);
        let pair_right = hash_pair(&empty, &empty);
        let expected4 = hash_pair(&pair_left, &pair_right);
        assert_eq!(root4, expected4);
    }
}
