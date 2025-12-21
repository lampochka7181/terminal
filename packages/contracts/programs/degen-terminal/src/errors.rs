use anchor_lang::prelude::*;

#[error_code]
pub enum DegenError {
    // =========================================================================
    // Protocol Errors (6000-6009)
    // =========================================================================
    
    #[msg("Protocol is paused")]
    ProtocolPaused,
    
    #[msg("Unauthorized - only admin can perform this action")]
    Unauthorized,
    
    #[msg("Invalid fee configuration")]
    InvalidFeeConfig,
    
    // =========================================================================
    // Market Errors (6010-6029)
    // =========================================================================
    
    #[msg("Market is not open for trading")]
    MarketNotOpen,
    
    #[msg("Market is closing soon (within 30 seconds)")]
    MarketClosing,
    
    #[msg("Market has already expired")]
    MarketExpired,
    
    #[msg("Market has not expired yet")]
    MarketNotExpired,
    
    #[msg("Market is not resolved yet")]
    MarketNotResolved,
    
    #[msg("Market is already resolved")]
    MarketAlreadyResolved,
    
    #[msg("Market settlement is not complete")]
    MarketNotSettled,
    
    #[msg("Market settlement is already complete")]
    MarketAlreadySettled,
    
    #[msg("Invalid market parameters")]
    InvalidMarketParams,
    
    #[msg("Invalid asset symbol")]
    InvalidAsset,
    
    #[msg("Invalid timeframe")]
    InvalidTimeframe,
    
    #[msg("Invalid expiry timestamp")]
    InvalidExpiry,
    
    // =========================================================================
    // Order Errors (6030-6049)
    // =========================================================================
    
    #[msg("Invalid price - must be between $0.01 and $0.99")]
    InvalidPrice,
    
    #[msg("Invalid size - must be between 1 and 100,000 contracts")]
    InvalidSize,
    
    #[msg("Invalid tick size - price must be on $0.01 increments")]
    InvalidTickSize,
    
    #[msg("Order has expired")]
    OrderExpired,
    
    #[msg("Orders have the same side - cannot match")]
    SameSide,
    
    #[msg("Order outcomes do not match")]
    OutcomeMismatch,
    
    #[msg("Self-trade not allowed")]
    SelfTrade,
    
    #[msg("Price mismatch - orders do not cross")]
    PriceMismatch,
    
    #[msg("Order is not active (already filled, cancelled, or expired)")]
    OrderNotActive,
    
    #[msg("Order not found")]
    OrderNotFound,
    
    #[msg("Missing seller USDC receive account (required for closing trades)")]
    MissingSellerAccount,
    
    // =========================================================================
    // Position Errors (6050-6069)
    // =========================================================================
    
    #[msg("Insufficient shares to sell")]
    InsufficientShares,
    
    #[msg("Position limit exceeded - max 500,000 contracts per position")]
    PositionLimitExceeded,
    
    #[msg("Position already settled")]
    PositionAlreadySettled,
    
    #[msg("Position not found")]
    PositionNotFound,
    
    // =========================================================================
    // Balance Errors (6070-6089)
    // =========================================================================
    
    #[msg("Insufficient USDC balance")]
    InsufficientBalance,
    
    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance,
    
    #[msg("Vault is not empty - cannot close")]
    VaultNotEmpty,
    
    #[msg("Transfer failed")]
    TransferFailed,
    
    // =========================================================================
    // Oracle Errors (6090-6099)
    // =========================================================================
    
    #[msg("Invalid oracle account")]
    InvalidOracle,
    
    #[msg("Oracle price is stale (older than 60 seconds)")]
    StaleOraclePrice,
    
    #[msg("Oracle price is invalid or unavailable")]
    InvalidOraclePrice,
    
    #[msg("Oracle confidence interval too wide")]
    OracleConfidenceTooWide,
    
    // =========================================================================
    // Math Errors (6100-6109)
    // =========================================================================
    
    #[msg("Math overflow")]
    MathOverflow,
    
    #[msg("Math underflow")]
    MathUnderflow,
    
    #[msg("Division by zero")]
    DivisionByZero,
    
    // =========================================================================
    // Signature Errors (6110-6119)
    // =========================================================================
    
    #[msg("Invalid signature - verification failed")]
    InvalidSignature,
    
    #[msg("Missing Ed25519 signature verification instruction")]
    MissingSignatureVerification,
    
    #[msg("Signature does not match the expected signer")]
    SignerMismatch,
}
