/**
 * TradeBubbles — Chart overlay showing user trade positions as bubbles
 * and live trade feed animations.
 *
 * Bubble positioning is driven by the chart's own rAF loop via
 * chartCoordsRef.onFrame — same frame, same coordinates, zero jitter.
 *
 * Trade time + asset price are stored in a persistent anchor cache.
 * Anchors update when shares increase (bubble moves to latest trade)
 * and clear when shares go to 0 (re-buy gets a fresh anchor).
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useUserStore } from '@/stores/userStore';
import { useSelectedMarket } from '@/stores/marketStore';
import { usePriceStore } from '@/stores/priceStore';
import { useMarketStore } from '@/stores/marketStore';
import { getWebSocket } from '@/lib/websocket';
import { useAuth } from '@/hooks/useAuth';
import { chartCoordsRef } from '@/lib/chartCoords';

// ─── Types ───────────────────────────────────────────────────────────────────

interface BubbleData {
  outcome: 'yes' | 'no';
  totalDollars: number;
  shares: number;
  entryPrice: number;
  assetPrice: number;
  tradeTime: number;
  marketAddress: string;
}

interface LiveTrade {
  id: string;
  side: 'buy' | 'sell';
  outcome: 'yes' | 'no';
  notional: number;
  x: number;
  startedAt: number;
}

interface TradeBubblesProps {
  mode: 'pro' | 'lite';
}

// ─── Constants ───────────────────────────────────────────────────────────────

const BUBBLE_SIZE = 39;
const BUBBLE_EXPANDED_W = 120;
const BUBBLE_OFFSET_Y = -9;
const LIVE_TRADE_DURATION = 6000;
const LIVE_TRADE_MAX = 20;

// ─── Persistent anchor cache (survives re-renders, keyed by market:outcome) ─

/** Stores the exact time & price where a position was first observed */
const anchorCache = new Map<string, { time: number; price: number }>();

// ─── Component ───────────────────────────────────────────────────────────────

export default function TradeBubbles({ mode }: TradeBubblesProps) {
  const { isAuthenticated } = useAuth();
  const market = useSelectedMarket();
  const { selectedAsset } = useMarketStore();
  const currentPrice = usePriceStore(s => s.prices[selectedAsset]);
  const positions = useUserStore(s => s.positions);

  const [expandedBubble, setExpandedBubble] = useState<'yes' | 'no' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  // DOM refs for direct positioning (no React re-render)
  const yesBubbleRef = useRef<HTMLDivElement>(null);
  const noBubbleRef = useRef<HTMLDivElement>(null);

  const liveTradesRef = useRef<LiveTrade[]>([]);
  // Separate rAF only for canvas live-trades (doesn't need chart sync)
  const canvasRafRef = useRef(0);

  // Track current price in a ref so we can read it without re-computing bubbles
  const currentPriceRef = useRef(currentPrice);
  currentPriceRef.current = currentPrice;

  // Track previous shares/dollars to detect position changes and prevent snap-back
  const prevSharesRef = useRef<Map<string, number>>(new Map());
  const prevDollarsRef = useRef<Map<string, { value: number; ts: number }>>(new Map());

  // Track container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setContainerSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Resize canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = containerSize.w * dpr;
    canvas.height = containerSize.h * dpr;
    canvas.style.width = containerSize.w + 'px';
    canvas.style.height = containerSize.h + 'px';
  }, [containerSize]);

  // ─── Compute bubble data from positions ──────────────────────────────────
  // NO currentPrice dependency — we use the anchorCache for asset price

  const marketAddress = market?.address ?? '';
  const marketExpiry = market?.expiry ?? 0;
  const isExpired = marketExpiry > 0 && Date.now() > marketExpiry;

  const bubbles = useMemo(() => {
    const result: BubbleData[] = [];
    if (!isAuthenticated || !marketAddress || isExpired) return result;

    const marketPositions = positions.filter(p =>
      (p.marketAddress === marketAddress || p.market === marketAddress) &&
      p.status === 'open'
    );

    // Step 1: Aggregate total shares/dollars per outcome across all positions
    const totals = new Map<'yes' | 'no', { shares: number; dollars: number; avgEntry: number }>();

    for (const pos of marketPositions) {
      if (pos.yesShares > 0) {
        const entry = pos.avgEntryYes ?? pos.avgEntryPrice ?? 0.5;
        const existing = totals.get('yes');
        if (existing) {
          const prev = existing.shares;
          existing.dollars += pos.yesShares * entry;
          existing.shares += pos.yesShares;
          existing.avgEntry = (existing.avgEntry * prev + entry * pos.yesShares) / existing.shares;
        } else {
          totals.set('yes', { shares: pos.yesShares, dollars: pos.yesShares * entry, avgEntry: entry });
        }
      }
      if (pos.noShares > 0) {
        const entry = pos.avgEntryNo ?? pos.avgEntryPrice ?? 0.5;
        const existing = totals.get('no');
        if (existing) {
          const prev = existing.shares;
          existing.dollars += pos.noShares * entry;
          existing.shares += pos.noShares;
          existing.avgEntry = (existing.avgEntry * prev + entry * pos.noShares) / existing.shares;
        } else {
          totals.set('no', { shares: pos.noShares, dollars: pos.noShares * entry, avgEntry: entry });
        }
      }
    }

    // Step 2: Update anchors based on share changes, then build bubbles
    const now = Date.now();

    for (const outcome of ['yes', 'no'] as const) {
      const cacheKey = `${marketAddress}:${outcome}`;
      const t = totals.get(outcome);
      const currentShares = t?.shares ?? 0;
      const prevShares = prevSharesRef.current.get(cacheKey) ?? 0;

      if (currentShares === 0) {
        // Position fully closed → clear anchor so re-buy gets a fresh one (fixes issue 2)
        anchorCache.delete(cacheKey);
        prevSharesRef.current.set(cacheKey, 0);
        prevDollarsRef.current.delete(cacheKey);
        continue;
      }

      // Update anchor when:
      // - New position (prevShares=0) or re-buy after sell → fresh anchor
      // - Adding to position (shares increased) → move anchor to latest trade (fixes issue 3)
      // - No cached anchor exists (first render)
      if (prevShares === 0 || currentShares > prevShares || !anchorCache.has(cacheKey)) {
        anchorCache.set(cacheKey, {
          time: Math.floor(now / 1000),
          price: currentPriceRef.current ?? 0,
        });
      }

      prevSharesRef.current.set(cacheKey, currentShares);
      const anchor = anchorCache.get(cacheKey)!;

      // Snap-back prevention (fixes issue 1):
      // When adding to a position, the store may briefly show an intermediate
      // lower dollar value for 1-2 frames. Hold the previous value for 300ms.
      const prevDollar = prevDollarsRef.current.get(cacheKey);
      let displayDollars = t!.dollars;

      if (prevDollar && displayDollars < prevDollar.value && (now - prevDollar.ts) < 300) {
        // Dollar value dipped within 300ms of last update → likely intermediate state
        displayDollars = prevDollar.value;
      } else {
        prevDollarsRef.current.set(cacheKey, { value: displayDollars, ts: now });
      }

      result.push({
        outcome,
        totalDollars: displayDollars,
        shares: currentShares,
        entryPrice: t!.avgEntry,
        assetPrice: anchor.price,
        tradeTime: anchor.time,
        marketAddress,
      });
    }

    return result;
  }, [isAuthenticated, marketAddress, isExpired, positions]);

  // Keep bubbles ref for onFrame access
  const bubblesRef = useRef(bubbles);
  bubblesRef.current = bubbles;
  const containerSizeRef = useRef(containerSize);
  containerSizeRef.current = containerSize;

  // Clear anchor cache and tracking refs when market changes
  useEffect(() => {
    for (const key of anchorCache.keys()) {
      if (!key.startsWith(marketAddress + ':')) {
        anchorCache.delete(key);
      }
    }
    for (const key of prevSharesRef.current.keys()) {
      if (!key.startsWith(marketAddress + ':')) {
        prevSharesRef.current.delete(key);
        prevDollarsRef.current.delete(key);
      }
    }
  }, [marketAddress]);

  // ─── Live trade feed from WebSocket ──────────────────────────────────────

  useEffect(() => {
    const ws = getWebSocket();
    ws.subscribeGlobalTrades();
    const unsub = ws.onMessage((msg: any) => {
      if (msg.channel !== 'trades:global' && msg.type !== 'global_trade') return;
      const d = msg.data;
      if (!d || !d.notional) return;
      if (d.asset && d.asset !== selectedAsset) return;
      const trade: LiveTrade = {
        id: d.id || `lt-${Date.now()}-${Math.random()}`,
        side: d.side || 'buy',
        outcome: d.outcome || 'yes',
        notional: d.notional,
        x: 0.01 + Math.random() * 0.08,
        startedAt: Date.now(),
      };
      const arr = liveTradesRef.current;
      if (arr.length >= LIVE_TRADE_MAX) arr.shift();
      arr.push(trade);
    });
    return () => { unsub(); ws.unsubscribeGlobalTrades(); };
  }, [selectedAsset]);

  // ─── Bubble positioning — called by chart's rAF via onFrame ──────────────

  const positionBubbles = useCallback(() => {
    const mapper = chartCoordsRef.current;
    const bubs = bubblesRef.current;

    for (const bubble of bubs) {
      const isYes = bubble.outcome === 'yes';
      const elBubble = isYes ? yesBubbleRef.current : noBubbleRef.current;

      if (!elBubble) continue;

      let x: number | null = null;
      let y: number | null = null;

      if (mapper) {
        x = mapper.timeToX(bubble.tradeTime);
        y = mapper.priceToY(bubble.assetPrice);
      }

      // Use content area bounds from the mapper (chart area excluding axes/scales).
      // This prevents the bubble from drifting into price scale or time axis areas
      // during drag/zoom when coordinates go out of bounds.
      const contentW = mapper?.contentArea?.width ?? 0;
      const contentH = mapper?.contentArea?.height ?? 0;

      if (x === null || y === null || contentW <= 0 || contentH <= 0) {
        elBubble.style.display = 'none';
        continue;
      }

      const bubbleY = y + BUBBLE_OFFSET_Y;
      const bw = elBubble.offsetWidth || BUBBLE_SIZE;
      const clampedX = Math.max(6, Math.min(x - bw / 2, contentW - bw - 6));
      const clampedY = Math.max(6, Math.min(bubbleY, contentH - BUBBLE_SIZE));

      elBubble.style.display = 'flex';
      elBubble.style.transform = `translate3d(${clampedX}px,${clampedY}px,0)`;
    }

    // Hide bubbles for outcomes with no data
    const hasYes = bubs.some(b => b.outcome === 'yes');
    const hasNo = bubs.some(b => b.outcome === 'no');
    if (!hasYes && yesBubbleRef.current) yesBubbleRef.current.style.display = 'none';
    if (!hasNo && noBubbleRef.current) noBubbleRef.current.style.display = 'none';
  }, []);

  // Register onFrame callback — chart calls this in its own rAF
  useEffect(() => {
    chartCoordsRef.onFrame = positionBubbles;
    return () => { chartCoordsRef.onFrame = null; };
  }, [positionBubbles]);

  // ─── Canvas rAF for live trade feed (independent — doesn't need chart sync) ─

  useEffect(() => {
    let active = true;
    function drawLiveTrades() {
      if (!active) return;
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const dpr = window.devicePixelRatio || 1;
          const w = canvas.width / dpr;
          const h = canvas.height / dpr;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.save();
          ctx.scale(dpr, dpr);

          const now = Date.now();
          const trades = liveTradesRef.current;
          while (trades.length > 0 && now - trades[0].startedAt > LIVE_TRADE_DURATION) trades.shift();

          for (const trade of trades) {
            const elapsed = now - trade.startedAt;
            const progress = Math.min(elapsed / LIVE_TRADE_DURATION, 1);
            const ty = h * (1 - progress * 0.85) - 8;
            const tx = trade.x * (w - 45) + 23;
            let opacity = progress < 0.08 ? progress / 0.08 : progress > 0.75 ? (1 - progress) / 0.25 : 0.65;
            const isBuy = trade.side === 'buy';
            const isYes = trade.outcome === 'yes';
            let r: number, g: number, b: number;
            if (!isBuy) { r = 238; g = 238; b = 238; opacity *= 0.5; }
            else if (isYes) { r = 149; g = 255; b = 148; }
            else { r = 245; g = 82; b = 82; }

            const dollarStr = trade.notional < 1000
              ? `$${trade.notional.toFixed(0)}`
              : `$${(trade.notional / 1000).toFixed(1)}k`;
            const label = (isBuy ? '+' : '-') + dollarStr;

            ctx.globalAlpha = opacity;
            ctx.font = `700 29px 'IBM Plex Mono', monospace`;
            ctx.textAlign = 'left';
            ctx.fillStyle = `rgba(0,0,0,0.5)`;
            ctx.fillText(label, tx + 1, ty + 1);
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillText(label, tx, ty);
          }
          ctx.restore();
        }
      }
      canvasRafRef.current = requestAnimationFrame(drawLiveTrades);
    }
    canvasRafRef.current = requestAnimationFrame(drawLiveTrades);
    return () => { active = false; cancelAnimationFrame(canvasRafRef.current); };
  }, []);

  // ─── Sell handler ────────────────────────────────────────────────────────

  const handleSellClick = useCallback((outcome: 'yes' | 'no') => {
    window.dispatchEvent(new CustomEvent('trade-bubble-sell', {
      detail: { outcome, marketAddress },
    }));
    setExpandedBubble(null);
  }, [marketAddress]);

  useEffect(() => {
    if (!expandedBubble) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-trade-bubble]')) setExpandedBubble(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [expandedBubble]);

  // ─── Render ──────────────────────────────────────────────────────────────

  const yesBubble = bubbles.find(b => b.outcome === 'yes');
  const noBubble = bubbles.find(b => b.outcome === 'no');

  function renderBubbleGroup(
    bubble: BubbleData | undefined,
    bubbleRef: React.RefObject<HTMLDivElement | null>,
  ) {
    if (!bubble) return null;
    const isYes = bubble.outcome === 'yes';
    const isExpanded = expandedBubble === bubble.outcome;
    const color = isYes ? '#95ff94' : '#f55252';
    const bgColor = isYes ? 'rgba(149,255,148,0.15)' : 'rgba(245,82,82,0.15)';
    const borderColor = isYes ? 'rgba(149,255,148,0.4)' : 'rgba(245,82,82,0.4)';
    const label = isYes ? 'Above' : 'Below';
    const dollarStr = `$${bubble.totalDollars < 1000
      ? bubble.totalDollars.toFixed(0)
      : (bubble.totalDollars / 1000).toFixed(1) + 'k'}`;

    return (
      <div
        ref={bubbleRef}
        data-trade-bubble
        onClick={(e) => {
          e.stopPropagation();
          setExpandedBubble(isExpanded ? null : bubble.outcome);
        }}
        style={{
          position: 'absolute',
          left: 0, top: 0,
          width: isExpanded ? BUBBLE_EXPANDED_W : BUBBLE_SIZE,
          height: isExpanded ? 'auto' : BUBBLE_SIZE,
          borderRadius: isExpanded ? 11 : BUBBLE_SIZE / 2,
          background: isYes ? 'rgba(149,255,148,0.08)' : 'rgba(245,82,82,0.08)',
          border: `1px solid ${isYes ? 'rgba(149,255,148,0.25)' : 'rgba(245,82,82,0.25)'}`,
          backdropFilter: 'blur(6px)',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          pointerEvents: 'auto',
          zIndex: 22,
          boxShadow: `0 0 9px ${isYes ? 'rgba(149,255,148,0.06)' : 'rgba(245,82,82,0.06)'}`,
          padding: isExpanded ? '6px 8px' : 0,
          gap: isExpanded ? 5 : 0,
          display: 'none',
          willChange: 'transform',
        }}
      >
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          color,
          lineHeight: 1,
          fontFamily: "'IBM Plex Mono', monospace",
          whiteSpace: 'nowrap',
        }}>
          {dollarStr}
        </span>

        {isExpanded && (
          <button
            onClick={(e) => { e.stopPropagation(); handleSellClick(bubble.outcome); }}
            style={{
              width: '100%',
              padding: '5px 0',
              borderRadius: 6,
              border: 'none',
              background: color,
              color: '#1e1e1e',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
              letterSpacing: 0.5,
            }}
          >
            SELL
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 20,
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 18 }}
      />
      {renderBubbleGroup(yesBubble, yesBubbleRef)}
      {renderBubbleGroup(noBubble, noBubbleRef)}
    </div>
  );
}
