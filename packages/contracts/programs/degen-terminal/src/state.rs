use anchor_lang::prelude::*;

// ============================================================================
// ENUMS
// ============================================================================

/// Order side
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Bid = 0,  // Buy
    Ask = 1,  // Sell
}

/// Order outcome
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Yes = 0,
    No = 1,
}

/// Order type
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum OrderType {
    Limit = 0,
    Market = 1,
    IOC = 2,    // Immediate-Or-Cancel
    FOK = 3,    // Fill-Or-Kill
}

/// Market status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketStatus {
    Pending = 0,    // Pre-created, awaiting activation (strike price not set)
    Open = 1,       // Trading active
    Closed = 2,     // Trading stopped, awaiting resolution
    Resolved = 3,   // Outcome determined
    Settled = 4,    // All positions paid out
}

/// Order status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum OrderStatus {
    Open = 0,       // Active, can be matched
    PartialFill = 1, // Partially filled
    Filled = 2,     // Fully filled
    Cancelled = 3,  // Cancelled by user
    Expired = 4,    // Expired (past expiry_ts)
}

impl Default for OrderStatus {
    fn default() -> Self {
        OrderStatus::Open
    }
}

impl Default for MarketStatus {
    fn default() -> Self {
        MarketStatus::Pending
    }
}

/// Market outcome result
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketOutcome {
    Pending = 0,
    Yes = 1,
    No = 2,
}

/// Trade type - determines how USDC and shares flow
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum TradeType {
    /// Opening trade: Both parties deposit USDC, mint YES/NO pair
    /// USDC: buyer → vault, seller → vault
    /// Shares: mint new YES to buyer, NO to seller (or vice versa)
    /// Open interest: +match_size
    Opening = 0,
    
    /// Closing trade: Seller transfers existing shares, buyer pays USDC
    /// USDC: buyer → seller (not through vault)
    /// Shares: transfer from seller to buyer
    /// Open interest: unchanged
    Closing = 1,
}

impl Default for MarketOutcome {
    fn default() -> Self {
        MarketOutcome::Pending
    }
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// USDC has 6 decimals
pub const USDC_DECIMALS: u8 = 6;
pub const USDC_MULTIPLIER: u64 = 1_000_000;

/// Price decimals (6 decimals, so 500_000 = $0.50)
pub const PRICE_DECIMALS: u8 = 6;
pub const PRICE_MULTIPLIER: u64 = 1_000_000;

/// Share decimals (6 decimals for fractional contracts)
/// 1_000_000 = 1.000000 contract
pub const SHARE_DECIMALS: u8 = 6;
pub const SHARE_MULTIPLIER: u64 = 1_000_000;

/// Min/max price bounds ($0.01 - $0.99)
pub const MIN_PRICE: u64 = 10_000;      // $0.01
pub const MAX_PRICE: u64 = 990_000;     // $0.99

/// Min/max order size (in 6 decimals: 1_000_000 = 1 contract)
pub const MIN_ORDER_SIZE: u64 = 1_000;         // 0.001 contracts minimum
pub const MAX_ORDER_SIZE: u64 = 100_000_000_000;  // 100,000 contracts max

/// Max position size per user per market (in 6 decimals)
pub const MAX_POSITION_SIZE: u64 = 500_000_000_000;  // 500,000 contracts

/// Trading closes 30 seconds before expiry
pub const TRADING_CLOSE_BUFFER: i64 = 30;

/// Max string lengths
pub const MAX_ASSET_LEN: usize = 10;
pub const MAX_TIMEFRAME_LEN: usize = 10;
pub const MAX_PAUSE_REASON_LEN: usize = 100;

// ============================================================================
// ACCOUNTS
// ============================================================================

/// Global protocol configuration (singleton)
#[account]
pub struct GlobalState {
    /// Admin authority (can pause, update fees)
    pub admin: Pubkey,
    /// Fee recipient treasury
    pub fee_recipient: Pubkey,
    /// Maker fee in basis points (0 = 0.00%)
    pub maker_fee_bps: u16,
    /// Taker fee in basis points (10 = 0.10%)
    pub taker_fee_bps: u16,
    /// Protocol paused flag
    pub paused: bool,
    /// Pause reason (optional)
    pub pause_reason: [u8; MAX_PAUSE_REASON_LEN],
    /// When paused (unix timestamp)
    pub paused_at: i64,
    /// Total markets created
    pub total_markets: u64,
    /// Total volume traded (USDC)
    pub total_volume: u64,
    /// Bump seed for PDA
    pub bump: u8,
}

impl GlobalState {
    pub const SEED: &'static [u8] = b"global";
    
    pub const SIZE: usize = 8 +     // discriminator
        32 +                        // admin
        32 +                        // fee_recipient
        2 +                         // maker_fee_bps
        2 +                         // taker_fee_bps
        1 +                         // paused
        MAX_PAUSE_REASON_LEN +      // pause_reason
        8 +                         // paused_at
        8 +                         // total_markets
        8 +                         // total_volume
        1;                          // bump
}

/// A binary outcome market
#[account]
pub struct Market {
    /// Unique market ID (incrementing)
    pub id: u64,
    /// Authority (the relayer that can resolve/settle)
    pub authority: Pubkey,
    /// Asset symbol (BTC, ETH, SOL)
    pub asset: [u8; MAX_ASSET_LEN],
    /// Timeframe (5m, 15m, 1h, 4h, 24h)
    pub timeframe: [u8; MAX_TIMEFRAME_LEN],
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
    /// Market status
    pub status: MarketStatus,
    /// Market outcome (only valid when status >= Resolved)
    pub outcome: MarketOutcome,
    /// Total volume traded (USDC, 6 decimals)
    pub total_volume: u64,
    /// Total number of trades
    pub total_trades: u32,
    /// Total number of positions created
    pub total_positions: u32,
    /// Number of positions settled
    pub settled_positions: u32,
    /// Open interest (number of YES/NO pairs)
    pub open_interest: u64,
    /// Bump seed for PDA
    pub bump: u8,
}

impl Market {
    pub const SEED: &'static [u8] = b"market";
    
    pub const SIZE: usize = 8 +     // discriminator
        8 +                         // id
        32 +                        // authority
        MAX_ASSET_LEN +             // asset
        MAX_TIMEFRAME_LEN +         // timeframe
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
        4 +                         // total_positions
        4 +                         // settled_positions
        8 +                         // open_interest
        1;                          // bump
    
    /// Check if market is open for trading
    pub fn is_trading_open(&self, current_time: i64) -> bool {
        self.status == MarketStatus::Open && 
        current_time < self.expiry_at - TRADING_CLOSE_BUFFER
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
}

/// Market vault for holding USDC collateral
#[account]
pub struct MarketVault {
    /// The market this vault belongs to
    pub market: Pubkey,
    /// USDC token account
    pub token_account: Pubkey,
    /// Bump seed for PDA
    pub bump: u8,
}

impl MarketVault {
    pub const SEED: &'static [u8] = b"vault";
    
    pub const SIZE: usize = 8 +     // discriminator
        32 +                        // market
        32 +                        // token_account
        1;                          // bump
}

/// User's position in a specific market
#[account]
pub struct UserPosition {
    /// Position owner
    pub owner: Pubkey,
    /// Market this position is for
    pub market: Pubkey,
    /// Number of YES shares (6 decimals: 1_000_000 = 1 contract)
    pub yes_shares: u64,
    /// Number of NO shares (6 decimals: 1_000_000 = 1 contract)
    pub no_shares: u64,
    /// Total USDC paid for YES shares (cost basis)
    pub yes_cost_basis: u64,
    /// Total USDC paid for NO shares (cost basis)
    pub no_cost_basis: u64,
    /// Realized P&L from closing positions
    pub realized_pnl: i64,
    /// Whether position has been settled
    pub settled: bool,
    /// Payout amount (set after settlement)
    pub payout: u64,
    /// Bump seed for PDA
    pub bump: u8,
}

impl UserPosition {
    pub const SEED: &'static [u8] = b"position";
    
    pub const SIZE: usize = 8 +     // discriminator
        32 +                        // owner
        32 +                        // market
        8 +                         // yes_shares
        8 +                         // no_shares
        8 +                         // yes_cost_basis
        8 +                         // no_cost_basis
        8 +                         // realized_pnl
        1 +                         // settled
        8 +                         // payout
        1;                          // bump
    
    /// Check if position has any shares
    pub fn has_position(&self) -> bool {
        self.yes_shares > 0 || self.no_shares > 0
    }
    
    /// Total cost basis
    pub fn total_cost(&self) -> u64 {
        self.yes_cost_basis + self.no_cost_basis
    }
}

/// On-chain order (for user orders - trustless storage)
#[account]
pub struct Order {
    /// Order owner
    pub owner: Pubkey,
    /// Market this order is for
    pub market: Pubkey,
    /// Order side (Bid = buy, Ask = sell)
    pub side: Side,
    /// Outcome being traded (Yes or No)
    pub outcome: Outcome,
    /// Order type (Limit, Market, IOC, FOK)
    pub order_type: OrderType,
    /// Limit price in 6 decimals (500_000 = $0.50)
    pub price: u64,
    /// Original order size (contracts)
    pub size: u64,
    /// Amount already filled
    pub filled_size: u64,
    /// Order status
    pub status: OrderStatus,
    /// Client-provided order ID (for replay protection)
    pub client_order_id: u64,
    /// Order expiration timestamp
    pub expiry_ts: i64,
    /// Order creation timestamp
    pub created_at: i64,
    /// Amount of USDC locked in vault for this order
    pub locked_amount: u64,
    /// Bump seed for PDA
    pub bump: u8,
}

impl Order {
    pub const SEED: &'static [u8] = b"order";
    
    pub const SIZE: usize = 8 +     // discriminator
        32 +                        // owner
        32 +                        // market
        1 +                         // side
        1 +                         // outcome
        1 +                         // order_type
        8 +                         // price
        8 +                         // size
        8 +                         // filled_size
        1 +                         // status
        8 +                         // client_order_id
        8 +                         // expiry_ts
        8 +                         // created_at
        8 +                         // locked_amount
        1;                          // bump
    
    /// Get remaining size
    pub fn remaining_size(&self) -> u64 {
        self.size.saturating_sub(self.filled_size)
    }
    
    /// Check if order is active (can be matched)
    pub fn is_active(&self) -> bool {
        matches!(self.status, OrderStatus::Open | OrderStatus::PartialFill)
    }
    
    /// Check if order is expired
    pub fn is_expired(&self, current_time: i64) -> bool {
        self.order_type == OrderType::Limit && current_time > self.expiry_ts
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Convert a string to a fixed-size byte array, padding with zeros
pub fn str_to_bytes<const N: usize>(s: &str) -> [u8; N] {
    let mut bytes = [0u8; N];
    let s_bytes = s.as_bytes();
    let len = s_bytes.len().min(N);
    bytes[..len].copy_from_slice(&s_bytes[..len]);
    bytes
}
