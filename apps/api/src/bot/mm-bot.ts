/**
 * Probability-Based Market Maker
 *
 * Quotes YES outcome on a single orderbook model.
 * Fair value = Φ(d₂) — Black-Scholes probability that price ends above strike.
 * Volatility estimated via EWMA on real-time price returns.
 * Inventory skew keeps the bot delta neutral over time.
 *
 * Every order has notional ≥ $1 (price × size).
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { mmLogger } from '../lib/logger.js';
import { priceFeedService } from '../services/price-feed.service.js';
import { marketService } from '../services/market.service.js';
import { orderService } from '../services/order.service.js';
import { matchingService } from '../services/matching.service.js';
import { userService } from '../services/user.service.js';
import { positionService } from '../services/position.service.js';
import { getMarketPda } from '../lib/anchor-client.js';
import { broadcastOrderbookUpdate } from '../lib/broadcasts.js';
import { orderbookService } from '../services/orderbook.service.js';
import { fairValue, ewmaVarianceUpdate, annualizeVol, seedVariance, clamp, round2 } from './math.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const ORDER_MESSAGE_PREFIX = 'DEGEN_ORDER_V1:';

interface MMConfig {
  // Quoting
  baseSpread: number;
  minSpread: number;
  levels: number;
  levelSpacing: number;
  sizeDecay: number;

  // Sizing
  baseSize: number;
  minNotional: number;

  // Inventory
  maxPosition: number;
  skewFactor: number;

  // Volatility
  ewmaLambda: number;
  defaultVol: number;
  volFloor: number;
  volCeiling: number;

  // Timing
  tickMs: number;
  closeBeforeExpiryMs: number;
  assets: string[];

  // Certainty gate — suppress winning-side quotes when outcome is near-certain
  certaintyThreshold: number;
  certaintyTimeScaling: boolean;
}

function loadConfig(): MMConfig {
  return {
    baseSpread:        parseFloat(process.env.MM_BASE_SPREAD || '0.04'),
    minSpread:         parseFloat(process.env.MM_MIN_SPREAD || '0.02'),
    levels:            parseInt(process.env.MM_LEVELS || '3', 10),
    levelSpacing:      parseFloat(process.env.MM_LEVEL_SPACING || '0.01'),
    sizeDecay:         parseFloat(process.env.MM_SIZE_DECAY || '0.7'),

    baseSize:          parseInt(process.env.MM_BASE_SIZE || '50', 10),
    minNotional:       parseFloat(process.env.MM_MIN_NOTIONAL || '1.0'),

    maxPosition:       parseInt(process.env.MM_MAX_POSITION || '5000', 10),
    skewFactor:        parseFloat(process.env.MM_SKEW_FACTOR || '0.02'),

    ewmaLambda:        parseFloat(process.env.MM_EWMA_LAMBDA || '0.94'),
    defaultVol:        parseFloat(process.env.MM_DEFAULT_VOLATILITY || '0.50'),
    volFloor:          parseFloat(process.env.MM_VOL_FLOOR || '0.20'),
    volCeiling:        parseFloat(process.env.MM_VOL_CEILING || '1.50'),

    tickMs:            parseInt(process.env.MM_TICK_MS || '500', 10),
    closeBeforeExpiryMs: parseInt(process.env.MM_CLOSE_BEFORE_EXPIRY_MS || '5000', 10),
    assets:            (process.env.MM_ASSETS || 'BTC').split(',').map(s => s.trim()).filter(Boolean),

    certaintyThreshold:   parseFloat(process.env.MM_CERTAINTY_THRESHOLD || '0.95'),
    certaintyTimeScaling: (process.env.MM_CERTAINTY_TIME_SCALING || 'true') === 'true',
  };
}

// ============================================================================
// TYPES
// ============================================================================

interface OrderInfo {
  id: string;
  side: 'BID' | 'ASK';
  price: number;
  size: number;
}

interface MarketState {
  id: string;
  pubkey: string;
  asset: string;
  timeframe: string;
  strike: number;
  expiryAt: number;
  createdAt: number;

  orders: Map<string, OrderInfo>;
  yesShares: number;
  noShares: number;

  lastFairValue: number;
  lastSpread: number;
  lastSkew: number;
  lastPrice: number;
}

interface Quote {
  price: number;
  size: number;
}

interface PriceTick {
  price: number;
  time: number;
}

// ============================================================================
// MARKET MAKER BOT
// ============================================================================

class MarketMakerBot {
  private cfg: MMConfig;
  private running = false;
  private initialized = false;
  private markets = new Map<string, MarketState>();
  private keypair: Keypair | null = null;
  private walletAddress: string | null = null;
  private userId: string | null = null;
  private tickInterval: NodeJS.Timeout | null = null;

  // Market sync cache
  private syncCacheTime = 0;
  private readonly syncCacheTTL = config.perfTestMode ? 10_000 : 5_000;

  // EWMA volatility per asset
  private ewmaVar = new Map<string, number>();
  private lastTick = new Map<string, PriceTick>();
  private avgTickMs = 500; // Running average tick interval (seeds annualize)

  constructor(overrides: Partial<MMConfig> = {}) {
    this.cfg = { ...loadConfig(), ...overrides };
    this.initKeypair();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ──────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    mmLogger.info('[MM] Starting...');

    if (!await this.initUser()) {
      mmLogger.error('[MM] Failed to initialize user');
      return;
    }

    this.running = true;
    await this.syncMarkets();

    this.tickInterval = setInterval(async () => {
      if (!this.running) return;
      try { await this.tick(); } catch (err) {
        mmLogger.error(`[MM] Tick error: ${err}`);
      }
    }, this.cfg.tickMs);

    this.logConfig();
    mmLogger.info('[MM] Started');
  }

  async stop(): Promise<void> {
    mmLogger.info('[MM] Stopping...');
    this.running = false;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    for (const id of this.markets.keys()) {
      await this.cancelAllOrders(id);
    }
    this.markets.clear();

    mmLogger.info('[MM] Stopped');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MAIN TICK
  // ──────────────────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    await this.syncMarkets();

    for (const [marketId, state] of this.markets) {
      try {
        await this.updateMarket(marketId, state);
      } catch (err) {
        mmLogger.error(`[MM] Update failed ${state.asset}-${state.timeframe}: ${err}`);
      }
    }
  }

  private async updateMarket(marketId: string, state: MarketState): Promise<void> {
    const now = Date.now();
    const timeToExpiry = state.expiryAt - now;

    // Stop quoting near expiry
    if (timeToExpiry < this.cfg.closeBeforeExpiryMs) {
      if (state.orders.size > 0) {
        await this.cancelAllOrders(marketId);
        await this.broadcastBook(state);
      }
      return;
    }

    // Get current price
    const priceData = await priceFeedService.getPrice(state.asset);
    if (!priceData) return;
    const spot = priceData.price;
    state.lastPrice = spot;

    // Update EWMA volatility
    this.updateVol(state.asset, spot, now);

    // Compute fair value
    const tSec = timeToExpiry / 1000;
    const tYears = tSec / (365.25 * 24 * 3600);
    const sigma = this.getVol(state.asset);
    const fv = clamp(fairValue(spot, state.strike, sigma, tYears), 0.01, 0.99);

    // Compute spread and inventory skew
    const marketDuration = state.expiryAt - state.createdAt;
    const timeRemainingPct = Math.max(0, timeToExpiry / marketDuration);
    const spread = this.computeSpread(fv, sigma, timeRemainingPct);
    const skew = this.computeSkew(state.yesShares, state.noShares);

    // Store for status endpoint
    state.lastFairValue = fv;
    state.lastSpread = spread;
    state.lastSkew = skew;

    // Generate and place quotes
    const quotes = this.generateQuotes(fv, spread, skew, state, timeRemainingPct);
    await this.updateOrders(marketId, quotes);
    await this.broadcastBook(state);

    // Update market prices in DB (throttled — only when meaningful change)
    if (Math.abs(fv - 0.5) > 0.001 || state.orders.size > 0) {
      marketService.updatePrices(marketId, fv, 1 - fv).catch(() => {});
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // EWMA VOLATILITY
  // ──────────────────────────────────────────────────────────────────────────

  private updateVol(asset: string, price: number, now: number): void {
    const prev = this.lastTick.get(asset);
    this.lastTick.set(asset, { price, time: now });

    if (!prev) return; // First tick — nothing to compare

    const dt = now - prev.time;
    if (dt <= 0 || dt > 10_000) return; // Skip gaps > 10s

    const logReturn = Math.log(price / prev.price);
    const prevVar = this.ewmaVar.get(asset) ?? seedVariance(this.cfg.defaultVol, this.avgTickMs);

    this.ewmaVar.set(asset, ewmaVarianceUpdate(prevVar, logReturn, this.cfg.ewmaLambda));

    // Update average tick interval (exponential moving average)
    this.avgTickMs = 0.95 * this.avgTickMs + 0.05 * dt;
  }

  private getVol(asset: string): number {
    const v = this.ewmaVar.get(asset);
    if (!v || v <= 0) return this.cfg.defaultVol;

    const sigma = annualizeVol(v, this.avgTickMs);
    return clamp(sigma, this.cfg.volFloor, this.cfg.volCeiling);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SPREAD & SKEW
  // ──────────────────────────────────────────────────────────────────────────

  private computeSpread(fv: number, sigma: number, timeRemainingPct: number): number {
    // Base spread scales with vol relative to default
    const volSpread = this.cfg.baseSpread * (sigma / this.cfg.defaultVol);

    // Tighter near expiry (less uncertainty)
    const timeMul = 0.5 + 0.5 * timeRemainingPct; // [0.5, 1.0]

    // Wider near boundaries (thin liquidity, extreme prices)
    // fv=0.50 → 1.0, fv=0.05 → 2.62, fv=0.01 → 2.96
    const boundaryMul = 1.0 + 2.0 * (1 - 4 * fv * (1 - fv));

    return Math.max(this.cfg.minSpread, volSpread * timeMul * boundaryMul);
  }

  private computeSkew(yesShares: number, noShares: number): number {
    const net = yesShares - noShares;
    // Long YES → positive skew → lower bid/ask → sell more YES
    return clamp((net / this.cfg.maxPosition) * this.cfg.skewFactor, -0.10, 0.10);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // QUOTE GENERATION
  // ──────────────────────────────────────────────────────────────────────────

  private generateQuotes(
    fv: number,
    spread: number,
    skew: number,
    state: MarketState,
    timeRemainingPct: number,
  ): { bids: Quote[]; asks: Quote[] } {
    const bids: Quote[] = [];
    const asks: Quote[] = [];

    // Certainty gate: suppress the winning side when outcome is near-certain.
    // Threshold tightens as expiry approaches (second half of round only).
    const threshold = this.cfg.certaintyTimeScaling && timeRemainingPct < 0.5
      ? this.cfg.certaintyThreshold - 0.05 * (1 - timeRemainingPct * 2)
      : this.cfg.certaintyThreshold;

    const suppressAsks = fv >= threshold;      // YES near-certain → don't sell YES
    const suppressBids = fv <= 1 - threshold;  // NO near-certain  → don't buy YES

    for (let lvl = 0; lvl < this.cfg.levels; lvl++) {
      const offset = lvl * this.cfg.levelSpacing;
      const sizeMul = Math.pow(this.cfg.sizeDecay, lvl); // 1.0, 0.7, 0.49 …

      let bidPrice = round2(fv - spread / 2 - offset - skew);
      let askPrice = round2(fv + spread / 2 + offset - skew);

      bidPrice = clamp(bidPrice, 0.01, 0.99);
      askPrice = clamp(askPrice, 0.01, 0.99);

      // Enforce minimum spread on level 0
      if (lvl === 0 && askPrice - bidPrice < this.cfg.minSpread) {
        bidPrice = Math.max(0.01, Math.floor((fv - this.cfg.minSpread / 2 - skew) * 100) / 100);
        askPrice = Math.min(0.99, Math.ceil((fv + this.cfg.minSpread / 2 - skew) * 100) / 100);
      }

      // Skip if bid ≥ ask (can happen at extremes)
      if (bidPrice >= askPrice) continue;

      // Size with $1 minimum notional enforcement
      const rawSize = Math.round(this.cfg.baseSize * sizeMul);
      const bidSize = Math.max(rawSize, Math.ceil(this.cfg.minNotional / bidPrice));
      const askSize = Math.max(rawSize, Math.ceil(this.cfg.minNotional / askPrice));

      // Respect position limits; skip side if suppressed by certainty gate
      if (!suppressBids && state.yesShares + bidSize <= this.cfg.maxPosition) {
        bids.push({ price: bidPrice, size: bidSize });
      }
      if (!suppressAsks && state.noShares + askSize <= this.cfg.maxPosition) {
        asks.push({ price: askPrice, size: askSize });
      }
    }

    return { bids, asks };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ORDER MANAGEMENT
  // ──────────────────────────────────────────────────────────────────────────

  private async updateOrders(
    marketId: string,
    quotes: { bids: Quote[]; asks: Quote[] },
  ): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state) return;

    // 1. Capture old orders
    const oldIds = new Set(state.orders.keys());

    // 2. Place NEW orders first (prevents empty-book flash)
    for (const bid of quotes.bids) {
      await this.placeOrder(marketId, 'BID', bid.price, bid.size);
    }
    for (const ask of quotes.asks) {
      await this.placeOrder(marketId, 'ASK', ask.price, ask.size);
    }

    // 3. Cancel old orders
    await this.cancelOrdersById(marketId, oldIds);
  }

  private async placeOrder(
    marketId: string,
    side: 'BID' | 'ASK',
    price: number,
    size: number,
  ): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state || !this.userId || !this.keypair || !this.initialized) return;

    if (price < 0.01 || price > 0.99) return;
    if (price * size < this.cfg.minNotional) return;

    try {
      const expiryTs = Math.floor(state.expiryAt / 1000);
      const onChainMarketPda = getMarketPda(state.asset, state.timeframe, expiryTs);

      const clientOrderId = Date.now() + Math.floor(Math.random() * 1000);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const orderExpiryTs = Math.floor(expiresAt.getTime() / 1000);

      const binaryMessage = buildOrderMessage(
        onChainMarketPda, side, 'YES', price, size, orderExpiryTs, clientOrderId,
      );
      const signature = bs58.encode(nacl.sign.detached(binaryMessage, this.keypair.secretKey));
      const binaryMessageBase64 = Buffer.from(binaryMessage).toString('base64');

      // Persist order in DB (skip in perf mode)
      const order = config.disableMmOrderPersistence
        ? ({ id: randomUUID() } as any)
        : await orderService.create({
            clientOrderId,
            marketId,
            userId: this.userId,
            side,
            outcome: 'YES',
            orderType: 'LIMIT',
            price: price.toString(),
            size: size.toString(),
            signature,
            encodedInstruction: null,
            isMmOrder: true,
            expiresAt,
          });

      const orderbookOrder = {
        id: order.id,
        marketId,
        userId: this.userId,
        side,
        outcome: 'YES' as const,
        price,
        size,
        remainingSize: size,
        createdAt: Date.now(),
        clientOrderId,
        expiresAt: expiresAt.getTime(),
        signature,
        binaryMessage: binaryMessageBase64,
      };

      // Add to orderbook
      if (config.perfTestMode) {
        await orderbookService.addOrder(orderbookOrder);
        state.orders.set(order.id, { id: order.id, side, price, size });
      } else {
        const result = await matchingService.processOrder(orderbookOrder);
        if (result.addedToBook) {
          state.orders.set(order.id, { id: order.id, side, price, size });
        }
        // Track fills
        for (const fill of result.fills) {
          this.onFill(marketId, side, fill.size);
        }
      }
    } catch (err) {
      mmLogger.debug(`[MM] Order failed: ${(err as Error).message}`);
    }
  }

  private async cancelAllOrders(marketId: string): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state) return;
    await this.cancelOrdersById(marketId, new Set(state.orders.keys()));
  }

  private async cancelOrdersById(marketId: string, ids: Set<string>): Promise<void> {
    const state = this.markets.get(marketId);
    if (!state || ids.size === 0) return;

    const toRemove: OrderInfo[] = [];
    for (const id of ids) {
      const o = state.orders.get(id);
      if (o) {
        toRemove.push(o);
        state.orders.delete(id);
      }
    }

    // Remove from Redis orderbook
    if (this.userId) {
      for (const o of toRemove) {
        try {
          await orderbookService.removeOrder({
            id: o.id,
            marketId,
            userId: this.userId,
            side: o.side,
            outcome: 'YES',
            price: o.price,
            size: o.size,
            remainingSize: o.size,
            createdAt: Date.now(),
          });
        } catch {}
      }
    }

    // Batch cancel in DB
    if (!config.disableMmOrderPersistence && toRemove.length > 0) {
      try {
        await orderService.cancelBatch(toRemove.map(o => o.id), 'MM_CANCEL');
      } catch {}
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POSITION TRACKING
  // ──────────────────────────────────────────────────────────────────────────

  private onFill(marketId: string, side: 'BID' | 'ASK', size: number): void {
    const state = this.markets.get(marketId);
    if (!state) return;

    if (side === 'BID') {
      state.yesShares += size; // Bought YES
    } else {
      state.noShares += size; // Sold YES = bought NO
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MARKET SYNC
  // ──────────────────────────────────────────────────────────────────────────

  private async syncMarkets(): Promise<void> {
    const now = Date.now();
    if (now - this.syncCacheTime < this.syncCacheTTL) return;
    this.syncCacheTime = now;

    const all = await marketService.getMarkets({ status: 'OPEN' });
    const active = all.filter(m =>
      parseFloat(m.strikePrice) > 0 &&
      (this.cfg.assets.length === 0 || this.cfg.assets.includes(m.asset)),
    );

    // Add new markets
    for (const m of active) {
      if (this.markets.has(m.id)) continue;

      let yesPos = 0, noPos = 0;
      if (this.userId) {
        try {
          const pos = await positionService.getPosition(this.userId, m.id);
          if (pos) {
            yesPos = parseFloat(pos.yesShares || '0');
            noPos = parseFloat(pos.noShares || '0');
          }
        } catch {}
      }

      this.markets.set(m.id, {
        id: m.id,
        pubkey: m.pubkey,
        asset: m.asset,
        timeframe: m.timeframe,
        strike: parseFloat(m.strikePrice),
        expiryAt: m.expiryAt.getTime(),
        createdAt: m.createdAt.getTime(),
        orders: new Map(),
        yesShares: yesPos,
        noShares: noPos,
        lastFairValue: 0.50,
        lastSpread: this.cfg.baseSpread,
        lastSkew: 0,
        lastPrice: 0,
      });

      mmLogger.info(
        `[MM] Tracking ${m.asset}-${m.timeframe} strike=$${parseFloat(m.strikePrice).toFixed(2)} ` +
        `pos=(YES=${yesPos}, NO=${noPos})`,
      );
    }

    // Remove stale markets
    for (const [id, state] of this.markets) {
      if (!active.find(m => m.id === id)) {
        await this.cancelAllOrders(id);
        this.markets.delete(id);
        mmLogger.info(`[MM] Stopped tracking ${state.asset}-${state.timeframe}`);
      }
    }
  }

  async forceMarketSync(): Promise<void> {
    this.syncCacheTime = 0;
    await this.syncMarkets();
    await this.tick();
    mmLogger.info(`[MM] Forced sync complete. Active markets: ${this.markets.size}`);
  }

  /**
   * Instantly notify the MM bot that a market was just activated.
   * Called directly from the market activator — bypasses the 5s sync cache entirely.
   * The bot adds the market and places initial quotes within the same call (~50ms).
   */
  async notifyMarketActivated(data: {
    id: string;
    pubkey: string;
    asset: string;
    timeframe: string;
    strikePrice: number;
    expiryAt: number;
  }): Promise<void> {
    if (!this.running || !this.initialized) return;

    // Check asset filter
    if (this.cfg.assets.length > 0 && !this.cfg.assets.includes(data.asset)) return;

    // Already tracking this market
    if (this.markets.has(data.id)) return;

    // Add the market instantly — no DB query needed (activator has all the data)
    this.markets.set(data.id, {
      id: data.id,
      pubkey: data.pubkey,
      asset: data.asset,
      timeframe: data.timeframe,
      strike: data.strikePrice,
      expiryAt: data.expiryAt,
      createdAt: Date.now(),
      orders: new Map(),
      yesShares: 0,
      noShares: 0,
      lastFairValue: 0.50,
      lastSpread: this.cfg.baseSpread,
      lastSkew: 0,
      lastPrice: 0,
    });

    mmLogger.info(
      `[MM] Instant activation: ${data.asset}-${data.timeframe} strike=$${data.strikePrice.toFixed(2)}`,
    );

    // Immediately place initial quotes for this market
    const state = this.markets.get(data.id);
    if (state) {
      try {
        await this.updateMarket(data.id, state);
      } catch (err) {
        mmLogger.error(`[MM] Initial quote failed for ${data.asset}-${data.timeframe}: ${err}`);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // BROADCAST
  // ──────────────────────────────────────────────────────────────────────────

  private async broadcastBook(state: MarketState): Promise<void> {
    try {
      const snapshot = await orderbookService.getCompositeSnapshot(state.id);
      broadcastOrderbookUpdate(
        state.pubkey,
        snapshot.bids.map(l => [l.price, l.size] as [number, number]),
        snapshot.asks.map(l => [l.price, l.size] as [number, number]),
        snapshot.sequenceId,
        'YES',
      );
    } catch {}
  }

  // ──────────────────────────────────────────────────────────────────────────
  // INIT HELPERS
  // ──────────────────────────────────────────────────────────────────────────

  private initKeypair(): void {
    const key = process.env.MM_PRIVATE_KEY || process.env.MM_WALLET_PRIVATE_KEY;
    if (key) {
      try {
        const secret = bs58.decode(key);
        this.keypair = Keypair.fromSecretKey(secret);
        this.walletAddress = this.keypair.publicKey.toBase58();
        mmLogger.info(`[MM] Wallet: ${this.walletAddress}`);
        return;
      } catch {
        mmLogger.warn('[MM] Invalid MM_PRIVATE_KEY, using ephemeral wallet');
      }
    } else {
      mmLogger.warn('[MM] No MM_PRIVATE_KEY set, using ephemeral wallet');
    }
    this.keypair = Keypair.generate();
    this.walletAddress = this.keypair.publicKey.toBase58();
  }

  private async initUser(): Promise<boolean> {
    if (!this.walletAddress) return false;
    try {
      const user = await userService.getOrCreate(this.walletAddress);
      this.userId = user.id;
      this.initialized = true;
      mmLogger.info(`[MM] User initialized: ${this.userId}`);
      return true;
    } catch (err) {
      mmLogger.error(`[MM] User init failed: ${err}`);
      return false;
    }
  }

  private logConfig(): void {
    mmLogger.info('=== MM Bot Configuration ===');
    mmLogger.info(`Spread: base=${this.cfg.baseSpread}, min=${this.cfg.minSpread}`);
    mmLogger.info(`Size: base=${this.cfg.baseSize}, levels=${this.cfg.levels}, decay=${this.cfg.sizeDecay}`);
    mmLogger.info(`Inventory: maxPos=${this.cfg.maxPosition}, skewFactor=${this.cfg.skewFactor}`);
    mmLogger.info(`Volatility: default=${this.cfg.defaultVol}, ewmaλ=${this.cfg.ewmaLambda}, floor=${this.cfg.volFloor}, ceiling=${this.cfg.volCeiling}`);
    mmLogger.info(`Timing: tick=${this.cfg.tickMs}ms, closeBeforeExpiry=${this.cfg.closeBeforeExpiryMs}ms`);
    mmLogger.info(`Assets: ${this.cfg.assets.join(', ')}`);
    mmLogger.info(`Min notional: $${this.cfg.minNotional}`);
    mmLogger.info('============================');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PUBLIC API (consumed by index.ts, broadcasts.ts, matching.service.ts)
  // ──────────────────────────────────────────────────────────────────────────

  getUserId(): string | null {
    return this.userId;
  }

  getWalletAddress(): string | null {
    return this.walletAddress;
  }

  getStatus() {
    const now = Date.now();

    const marketDetails = Array.from(this.markets.values()).map(state => {
      const timeToExpiry = state.expiryAt - now;
      const marketDuration = state.expiryAt - state.createdAt;
      const timeRemainingPct = Math.max(0, timeToExpiry / marketDuration);

      return {
        id: state.id,
        asset: state.asset,
        timeframe: state.timeframe,
        strike: state.strike,
        currentPrice: state.lastPrice,
        fairValueYes: state.lastFairValue,
        fairValueNo: 1 - state.lastFairValue,
        spread: state.lastSpread,
        skew: state.lastSkew,
        yesPosition: state.yesShares,
        noPosition: state.noShares,
        imbalance: state.yesShares - state.noShares,
        orderCount: state.orders.size,
        secondsToExpiry: Math.round(timeToExpiry / 1000),
        timeRemainingPct: Math.round(timeRemainingPct * 100),
        sigma: this.getVol(state.asset),
      };
    });

    const totalImbalance = marketDetails.reduce((sum, m) => sum + Math.abs(m.imbalance), 0);

    return {
      version: 'v3-probability',
      running: this.running,
      initialized: this.initialized,
      markets: this.markets.size,
      totalOrders: marketDetails.reduce((sum, m) => sum + m.orderCount, 0),
      totalImbalance,
      wallet: this.walletAddress,
      userId: this.userId,
      config: {
        baseSpread: this.cfg.baseSpread,
        minSpread: this.cfg.minSpread,
        baseSize: this.cfg.baseSize,
        levels: this.cfg.levels,
        maxPosition: this.cfg.maxPosition,
        skewFactor: this.cfg.skewFactor,
        defaultVol: this.cfg.defaultVol,
        ewmaLambda: this.cfg.ewmaLambda,
        tickMs: this.cfg.tickMs,
        minNotional: this.cfg.minNotional,
      },
      marketDetails,
    };
  }

  async getQuoteInfo(marketId: string) {
    const state = this.markets.get(marketId);
    if (!state) return null;

    const now = Date.now();
    const timeToExpiry = state.expiryAt - now;
    const sigma = this.getVol(state.asset);

    return {
      marketId,
      asset: state.asset,
      timeframe: state.timeframe,
      strike: state.strike,
      currentPrice: state.lastPrice,
      fairValue: state.lastFairValue,
      spread: state.lastSpread,
      skew: state.lastSkew,
      sigma,
      ewmaVariance: this.ewmaVar.get(state.asset) ?? 0,
      avgTickMs: this.avgTickMs,
      secondsToExpiry: Math.round(timeToExpiry / 1000),
      yesShares: state.yesShares,
      noShares: state.noShares,
      orderCount: state.orders.size,
      orders: Array.from(state.orders.values()),
    };
  }
}

// ============================================================================
// ORDER MESSAGE BUILDING (reused from v2 — required for on-chain settlement)
// ============================================================================

function buildOrderMessage(
  marketPubkey: PublicKey,
  side: 'BID' | 'ASK',
  outcome: 'YES' | 'NO',
  price: number,
  size: number,
  expiryTs: number,
  clientOrderId: number,
): Uint8Array {
  const prefixBytes = new TextEncoder().encode(ORDER_MESSAGE_PREFIX);
  const buffer = new ArrayBuffer(81);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let offset = 0;

  bytes.set(prefixBytes, offset);
  offset += prefixBytes.length;

  bytes.set(marketPubkey.toBytes(), offset);
  offset += 32;

  view.setUint8(offset, side === 'BID' ? 0 : 1);
  offset += 1;

  view.setUint8(offset, outcome === 'YES' ? 0 : 1);
  offset += 1;

  const priceU64 = BigInt(Math.floor(price * 1_000_000));
  view.setBigUint64(offset, priceU64, true);
  offset += 8;

  view.setBigUint64(offset, BigInt(Math.floor(size)), true);
  offset += 8;

  view.setBigInt64(offset, BigInt(expiryTs), true);
  offset += 8;

  view.setBigUint64(offset, BigInt(clientOrderId), true);

  return bytes;
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const mmBotV2 = new MarketMakerBot();
export { MarketMakerBot };
