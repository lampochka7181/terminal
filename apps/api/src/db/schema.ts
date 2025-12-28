import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  numeric,
  integer,
  smallint,
  boolean,
  text,
  jsonb,
  bigint,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Enums
// Note: PENDING exists in DB enum but we don't use it - we use strikePrice = '0' to indicate pending
// This avoids Supabase connection pooler enum caching issues
export const marketStatusEnum = pgEnum('market_status', ['OPEN', 'CLOSED', 'RESOLVED', 'SETTLED']);
export const orderSideEnum = pgEnum('order_side', ['BID', 'ASK']);
export const orderOutcomeEnum = pgEnum('order_outcome', ['YES', 'NO']);
export const orderTypeEnum = pgEnum('order_type', ['LIMIT', 'MARKET', 'IOC', 'FOK']);
export const orderStatusEnum = pgEnum('order_status', ['OPEN', 'PARTIAL', 'FILLED', 'CANCELLED']);
export const txStatusEnum = pgEnum('tx_status', ['PENDING', 'CONFIRMED', 'FAILED']);
export const ledgerTypeEnum = pgEnum('ledger_type', ['DEPOSIT', 'WITHDRAW', 'TRADE', 'SETTLE', 'FEE']);

// Users table
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  walletAddress: varchar('wallet_address', { length: 44 }).unique().notNull(),
  nonce: varchar('nonce', { length: 64 }),
  nonceExpiresAt: timestamp('nonce_expires_at'),
  createdAt: timestamp('created_at').defaultNow(),
  lastLoginAt: timestamp('last_login_at'),
  totalVolume: numeric('total_volume', { precision: 20, scale: 6 }).default('0'),
  totalTrades: integer('total_trades').default(0),
  feeTier: smallint('fee_tier').default(0),
  isBanned: boolean('is_banned').default(false),
  metadata: jsonb('metadata'),
});

// Markets table
export const markets = pgTable('markets', {
  id: uuid('id').primaryKey().defaultRandom(),
  pubkey: varchar('pubkey', { length: 44 }).unique().notNull(),
  asset: varchar('asset', { length: 10 }).notNull(),
  timeframe: varchar('timeframe', { length: 10 }).notNull(),
  strikePrice: numeric('strike_price', { precision: 20, scale: 8 }).notNull(),
  finalPrice: numeric('final_price', { precision: 20, scale: 8 }),
  createdAt: timestamp('created_at').defaultNow(),
  expiryAt: timestamp('expiry_at').notNull(),
  resolvedAt: timestamp('resolved_at'),
  settledAt: timestamp('settled_at'),
  status: marketStatusEnum('status').default('OPEN'),
  outcome: varchar('outcome', { length: 10 }),
  totalVolume: numeric('total_volume', { precision: 20, scale: 6 }).default('0'),
  totalTrades: integer('total_trades').default(0),
  openInterest: numeric('open_interest', { precision: 20, scale: 6 }).default('0'),
  yesPrice: numeric('yes_price', { precision: 10, scale: 6 }),
  noPrice: numeric('no_price', { precision: 10, scale: 6 }),
});

// Orders table
export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientOrderId: bigint('client_order_id', { mode: 'number' }).notNull(),
  marketId: uuid('market_id').references(() => markets.id),
  userId: uuid('user_id').references(() => users.id),
  side: orderSideEnum('side').notNull(),
  outcome: orderOutcomeEnum('outcome').notNull(),
  orderType: orderTypeEnum('order_type').default('LIMIT'),
  price: numeric('price', { precision: 10, scale: 6 }).notNull(),
  size: numeric('size', { precision: 20, scale: 6 }).notNull(),
  filledSize: numeric('filled_size', { precision: 20, scale: 6 }).default('0'),
  remainingSize: numeric('remaining_size', { precision: 20, scale: 6 }),
  status: orderStatusEnum('status').default('OPEN'),
  signature: text('signature'), // Nullable for dollar-based MARKET orders
  encodedInstruction: text('encoded_instruction'), // Nullable - MM orders don't have this
  binaryMessage: text('binary_message'), // For signature verification (base64 encoded)
  isMmOrder: boolean('is_mm_order').default(false).notNull(), // True for Market Maker bot orders
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  cancelledAt: timestamp('cancelled_at'),
  cancelReason: varchar('cancel_reason', { length: 50 }),
});

// Trades table
// Each record represents a single match between taker and maker
// Captures BOTH perspectives: taker's side and maker's side
export const trades = pgTable('trades', {
  id: uuid('id').primaryKey().defaultRandom(),
  marketId: uuid('market_id').references(() => markets.id),
  makerOrderId: uuid('maker_order_id').references(() => orders.id),
  takerOrderId: uuid('taker_order_id').references(() => orders.id),
  makerUserId: uuid('maker_user_id').references(() => users.id),
  takerUserId: uuid('taker_user_id').references(() => users.id),
  
  // Taker's perspective (the one who initiated/took liquidity)
  takerSide: orderSideEnum('taker_side').notNull(),        // BID or ASK
  takerOutcome: orderOutcomeEnum('taker_outcome').notNull(), // What taker acquired (YES or NO)
  takerPrice: numeric('taker_price', { precision: 10, scale: 6 }).notNull(), // Price taker paid per contract
  takerNotional: numeric('taker_notional', { precision: 20, scale: 6 }).notNull(), // Total taker paid
  takerFee: numeric('taker_fee', { precision: 20, scale: 6 }).notNull(),
  
  // Maker's perspective (the one who provided liquidity)
  makerOutcome: orderOutcomeEnum('maker_outcome').notNull(), // What maker acquired (opposite of taker)
  makerPrice: numeric('maker_price', { precision: 10, scale: 6 }).notNull(), // Price maker paid per contract
  makerNotional: numeric('maker_notional', { precision: 20, scale: 6 }).notNull(), // Total maker paid
  makerFee: numeric('maker_fee', { precision: 20, scale: 6 }).default('0'),
  
  // Common fields
  size: numeric('size', { precision: 20, scale: 6 }).notNull(), // Number of contracts
  txSignature: varchar('tx_signature', { length: 88 }),
  txStatus: txStatusEnum('tx_status').default('PENDING'),
  executedAt: timestamp('executed_at').defaultNow(),
  confirmedAt: timestamp('confirmed_at'),
  
  // Legacy fields (kept for backwards compatibility, will deprecate)
  outcome: orderOutcomeEnum('outcome'),  // Deprecated: use takerOutcome
  price: numeric('price', { precision: 10, scale: 6 }), // Deprecated: use takerPrice
  notional: numeric('notional', { precision: 20, scale: 6 }), // Deprecated: use takerNotional
});

// Positions table
export const positions = pgTable('positions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  marketId: uuid('market_id').references(() => markets.id),
  pubkey: varchar('pubkey', { length: 44 }).unique(),
  yesShares: numeric('yes_shares', { precision: 20, scale: 6 }).default('0'),
  noShares: numeric('no_shares', { precision: 20, scale: 6 }).default('0'),
  avgEntryYes: numeric('avg_entry_yes', { precision: 10, scale: 6 }),
  avgEntryNo: numeric('avg_entry_no', { precision: 10, scale: 6 }),
  totalCost: numeric('total_cost', { precision: 20, scale: 6 }).default('0'),
  realizedPnl: numeric('realized_pnl', { precision: 20, scale: 6 }).default('0'),
  status: varchar('status', { length: 20 }).default('OPEN'),
  payout: numeric('payout', { precision: 20, scale: 6 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  settledAt: timestamp('settled_at'),
});

// Settlements table
export const settlements = pgTable('settlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  positionId: uuid('position_id').references(() => positions.id),
  userId: uuid('user_id').references(() => users.id),
  marketId: uuid('market_id').references(() => markets.id),
  outcome: varchar('outcome', { length: 10 }).notNull(),
  winningShares: numeric('winning_shares', { precision: 20, scale: 6 }).notNull(),
  payoutAmount: numeric('payout_amount', { precision: 20, scale: 6 }).notNull(),
  profit: numeric('profit', { precision: 20, scale: 6 }).notNull(),
  txSignature: varchar('tx_signature', { length: 88 }),
  txStatus: txStatusEnum('tx_status').default('PENDING'),
  batchId: uuid('batch_id'),
  createdAt: timestamp('created_at').defaultNow(),
  confirmedAt: timestamp('confirmed_at'),
});

// Balance ledger table
export const balanceLedger = pgTable('balance_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  type: ledgerTypeEnum('type').notNull(),
  amount: numeric('amount', { precision: 20, scale: 6 }).notNull(),
  balanceBefore: numeric('balance_before', { precision: 20, scale: 6 }).notNull(),
  balanceAfter: numeric('balance_after', { precision: 20, scale: 6 }).notNull(),
  referenceType: varchar('reference_type', { length: 20 }),
  referenceId: uuid('reference_id'),
  txSignature: varchar('tx_signature', { length: 88 }),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Market snapshots table
export const marketSnapshots = pgTable('market_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  marketId: uuid('market_id').references(() => markets.id),
  outcome: orderOutcomeEnum('outcome').notNull(),
  interval: varchar('interval', { length: 10 }).notNull(),
  timestamp: timestamp('timestamp').notNull(),
  open: numeric('open', { precision: 10, scale: 6 }),
  high: numeric('high', { precision: 10, scale: 6 }),
  low: numeric('low', { precision: 10, scale: 6 }),
  close: numeric('close', { precision: 10, scale: 6 }),
  volume: numeric('volume', { precision: 20, scale: 6 }).default('0'),
  trades: integer('trades').default(0),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  orders: many(orders),
  positions: many(positions),
  settlements: many(settlements),
  balanceLedger: many(balanceLedger),
}));

export const marketsRelations = relations(markets, ({ many }) => ({
  orders: many(orders),
  trades: many(trades),
  positions: many(positions),
  settlements: many(settlements),
  snapshots: many(marketSnapshots),
}));

export const ordersRelations = relations(orders, ({ one }) => ({
  market: one(markets, {
    fields: [orders.marketId],
    references: [markets.id],
  }),
  user: one(users, {
    fields: [orders.userId],
    references: [users.id],
  }),
}));

export const tradesRelations = relations(trades, ({ one }) => ({
  market: one(markets, {
    fields: [trades.marketId],
    references: [markets.id],
  }),
  makerOrder: one(orders, {
    fields: [trades.makerOrderId],
    references: [orders.id],
  }),
  takerOrder: one(orders, {
    fields: [trades.takerOrderId],
    references: [orders.id],
  }),
  makerUser: one(users, {
    fields: [trades.makerUserId],
    references: [users.id],
  }),
  takerUser: one(users, {
    fields: [trades.takerUserId],
    references: [users.id],
  }),
}));

export const positionsRelations = relations(positions, ({ one, many }) => ({
  user: one(users, {
    fields: [positions.userId],
    references: [users.id],
  }),
  market: one(markets, {
    fields: [positions.marketId],
    references: [markets.id],
  }),
  settlements: many(settlements),
}));

export const settlementsRelations = relations(settlements, ({ one }) => ({
  position: one(positions, {
    fields: [settlements.positionId],
    references: [positions.id],
  }),
  user: one(users, {
    fields: [settlements.userId],
    references: [users.id],
  }),
  market: one(markets, {
    fields: [settlements.marketId],
    references: [markets.id],
  }),
}));

export const balanceLedgerRelations = relations(balanceLedger, ({ one }) => ({
  user: one(users, {
    fields: [balanceLedger.userId],
    references: [users.id],
  }),
}));

export const marketSnapshotsRelations = relations(marketSnapshots, ({ one }) => ({
  market: one(markets, {
    fields: [marketSnapshots.marketId],
    references: [markets.id],
  }),
}));

// Type exports for use in application
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Market = typeof markets.$inferSelect;
export type NewMarket = typeof markets.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
export type Settlement = typeof settlements.$inferSelect;
export type NewSettlement = typeof settlements.$inferInsert;
export type BalanceLedgerEntry = typeof balanceLedger.$inferSelect;
export type NewBalanceLedgerEntry = typeof balanceLedger.$inferInsert;
export type MarketSnapshot = typeof marketSnapshots.$inferSelect;
export type NewMarketSnapshot = typeof marketSnapshots.$inferInsert;





