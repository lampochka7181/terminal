import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { Liveline } from '../lib/liveline';
import type { LivelinePoint } from '../lib/liveline';
import { useMarketStore } from '@/stores/marketStore';
import { usePriceStore } from '@/stores/priceStore';
import { useSelectedMarket } from '@/stores/marketStore';
import { getWebSocket } from '@/lib/websocket';
import { api } from '@/lib/api';
import { chartCoordsRef } from '@/lib/chartCoords';
import { timeframeSec, visibleWindowSec } from '@/lib/timeframe';

const LOOKBACK_SEC = 600;
const CANDLE_SEC = 5;
const LL_BUFFER = 0.05;

// Large right padding pushes liveline's live dot to ~57% of visible width,
// matching the pro chart where the current candle sits around 55-60%.
// The remaining right space is the "future zone" where END line + shading appear.
// grid={false} hides liveline's built-in Y-axis; we draw our own at the right edge.
const FUTURE_RIGHT = 420;
const YAXIS_W = 105;
const LL_PAD = { top: 60, right: FUTURE_RIGHT, bottom: 42, left: 18 };

function niceInterval(range: number, target = 10) {
  const rough = range / target;
  if (rough <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const frac = rough / pow;
  return (frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10) * pow;
}

export default function LiteChart() {
  const { selectedAsset } = useMarketStore();
  const currentPrice = usePriceStore(s => s.prices[selectedAsset]);
  const market = useSelectedMarket();
  const strikePrice = market?.strike ?? 0;

  const ROUND_SEC = timeframeSec(market?.timeframe);
  // For 1m, use a tighter visible window so old price extremes scroll out faster
  // and the chart stays centered on the current price area.
  // Pro chart keeps the wider window via visibleWindowSec().
  const WINDOW_SEC = market?.timeframe === '1m' ? 80 : visibleWindowSec(market?.timeframe);
  // Faster lerp for 1m so the Y-range re-centers quickly after big moves
  const LERP_SPEED = market?.timeframe === '1m' ? 0.25 : 0.08;

  const [data, setData] = useState<LivelinePoint[]>([]);
  const dataRef = useRef<LivelinePoint[]>([]);
  const lastTimeRef = useRef(0);
  const outerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const expiryMs = market?.expiry ?? 0;
  const roundEndSec = expiryMs > 0 ? Math.floor(expiryMs / 1000) : 0;
  const roundStartSec = roundEndSec > 0 ? roundEndSec - ROUND_SEC : 0;

  // Hide strike price when market is expired (gap until next market activates)
  const [, forceRender] = useState(0);
  useEffect(() => {
    if (!expiryMs || expiryMs <= Date.now()) return;
    const ms = expiryMs - Date.now();
    const timer = setTimeout(() => forceRender(n => n + 1), ms + 100);
    return () => clearTimeout(timer);
  }, [expiryMs]);
  const isExpired = expiryMs > 0 && Date.now() > expiryMs;
  const effectiveStrike = isExpired ? 0 : strikePrice;

  const value = currentPrice ?? data[data.length - 1]?.value ?? 0;

  // ── Refs for values needed in rAF/callback closures ──
  const dimsRef = useRef(dims);
  dimsRef.current = dims;
  const effectiveStrikeRef = useRef(effectiveStrike);
  effectiveStrikeRef.current = effectiveStrike;
  const valueRef = useRef(value);
  valueRef.current = value;

  // Track container dimensions
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDims({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Live range from Liveline (frame-synced via callback) ──
  const liveRangeRef = useRef<{ min: number; max: number } | null>(null);
  const [liveRange, setLiveRange] = useState<{ min: number; max: number } | null>(null);
  const lastRangeStateUpdate = useRef(0);

  // DOM refs for frame-synced overlay elements
  const strikeLineRef = useRef<HTMLDivElement>(null);
  const strikeBadgeRef = useRef<HTMLDivElement>(null);
  const priceBadgeRef = useRef<HTMLDivElement>(null);

  const handleRangeUpdate = useCallback((range: { min: number; max: number }) => {
    liveRangeRef.current = range;

    // Position strike line + price badge in the SAME frame as Liveline's render
    const d = dimsRef.current;
    const chartH = d.h - LL_PAD.top - LL_PAD.bottom;
    const r = range.max - range.min;
    if (chartH > 0 && r > 0) {
      const toY = (val: number) => LL_PAD.top + (1 - (val - range.min) / r) * chartH;

      // Strike line
      const es = effectiveStrikeRef.current;
      const sl = strikeLineRef.current;
      const sb = strikeBadgeRef.current;
      if (sl && sb) {
        if (es > 0) {
          const sy = toY(es);
          sl.style.display = '';
          sl.style.top = `${sy}px`;
          sb.style.display = '';
          sb.style.top = `${sy}px`;
        } else {
          sl.style.display = 'none';
          sb.style.display = 'none';
        }
      }

      // Price badge
      const v = valueRef.current;
      const pb = priceBadgeRef.current;
      if (pb) {
        if (v > 0) {
          pb.style.display = '';
          pb.style.top = `${toY(v)}px`;
          pb.textContent = v.toLocaleString('en-US', { minimumFractionDigits: 2 });
        } else {
          pb.style.display = 'none';
        }
      }
    }

    // Throttle React state updates (~10fps) for grid lines
    const now = Date.now();
    if (now - lastRangeStateUpdate.current > 100) {
      lastRangeStateUpdate.current = now;
      setLiveRange({ min: range.min, max: range.max });
    }
  }, []);

  // Grid lines (uses throttled liveRange state — acceptable for grid labels)
  const gridLines = useMemo(() => {
    if (!liveRange) return [];
    const range = liveRange.max - liveRange.min;
    const chartH = dims.h - LL_PAD.top - LL_PAD.bottom;
    if (range <= 0 || chartH <= 0) return [];
    const interval = niceInterval(range);
    const result: { val: number; y: number }[] = [];
    const start = Math.ceil(liveRange.min / interval) * interval;
    for (let v = start; v <= liveRange.max; v += interval) {
      result.push({ val: v, y: LL_PAD.top + (1 - (v - liveRange.min) / range) * chartH });
    }
    return result;
  }, [liveRange, dims.h]);

  // Sliding overlay: matches liveline's time mapping in the data area,
  // then projects linearly into the future zone for times beyond the live dot.
  // Updates every 400ms so overlays scroll in sync with the chart line.
  interface OverlayState {
    startPx: number | null;
    endPx: number | null;
    liveDotX: number;
    timeLabels: { x: number; label: string }[];
  }
  const [overlay, setOverlay] = useState<OverlayState>({ startPx: null, endPx: null, liveDotX: 0, timeLabels: [] });

  // Direct DOM refs for overlay elements — positioned in rAF, no React render lag
  const activeAreaRef = useRef<HTMLDivElement>(null);
  const startVertLineRef = useRef<HTMLDivElement>(null);
  const endVertLineRef = useRef<HTMLDivElement>(null);
  const lastLabelUpdate = useRef(0);

  useEffect(() => {
    if (roundStartSec <= 0 || roundEndSec <= 0 || dims.w <= 0) {
      setOverlay(prev => prev.timeLabels.length === 0 ? prev : { ...prev, timeLabels: [] });
      if (activeAreaRef.current) activeAreaRef.current.style.display = 'none';
      if (startVertLineRef.current) startVertLineRef.current.style.display = 'none';
      if (endVertLineRef.current) endVertLineRef.current.style.display = 'none';
      chartCoordsRef.current = null;
      return;
    }
    const update = () => {
      const W = dims.w;
      const H = dims.h;
      const chartW = W - LL_PAD.left - FUTURE_RIGHT;
      if (chartW <= 0) return;

      const now = Date.now() / 1000;
      const rightEdge = now + WINDOW_SEC * LL_BUFFER;
      const leftEdge = rightEdge - WINDOW_SEC;
      const chartRightEdge = LL_PAD.left + chartW;
      const futureZoneRight = W - YAXIS_W;
      const futureW = futureZoneRight - chartRightEdge;

      // How far past rightEdge the round end is; compress that into futureW
      const futureEnd = Math.max(roundEndSec + 60, rightEdge + 1);

      const toX = (t: number) => {
        if (t <= rightEdge) {
          return LL_PAD.left + ((t - leftEdge) / (rightEdge - leftEdge)) * chartW;
        }
        const frac = Math.min((t - rightEdge) / (futureEnd - rightEdge), 1);
        return chartRightEdge + frac * futureW;
      };

      const sx = toX(roundStartSec);
      const ex = toX(roundEndSec);
      const startOk = sx >= LL_PAD.left - 2 && sx <= futureZoneRight;
      const endOk = ex >= LL_PAD.left && ex <= futureZoneRight + 2;

      // GPU-composited positioning via transform — sub-pixel smooth, no layout thrash
      const aa = activeAreaRef.current;
      if (aa) {
        if (startOk && endOk && ex > sx) {
          aa.style.display = '';
          aa.style.transform = `translateX(${sx}px)`;
          aa.style.width = `${ex - sx}px`;
        } else {
          aa.style.display = 'none';
        }
      }
      const sl = startVertLineRef.current;
      if (sl) {
        sl.style.display = startOk ? '' : 'none';
        if (startOk) sl.style.transform = `translateX(${sx}px)`;
      }
      const elEnd = endVertLineRef.current;
      if (elEnd) {
        elEnd.style.display = endOk ? '' : 'none';
        if (endOk) elEnd.style.transform = `translateX(${ex}px)`;
      }

      // Throttle time label React state updates (~2/sec) — labels move slowly
      const nowMs = Date.now();
      if (nowMs - lastLabelUpdate.current > 500) {
        lastLabelUpdate.current = nowMs;
        const MIN_LABEL_GAP = 120;
        const allLabels: { x: number; label: string }[] = [];
        const firstTick = Math.ceil(leftEdge / 60) * 60;
        for (let t = firstTick; t <= futureEnd; t += 60) {
          const x = Math.round(toX(t));
          if (x < LL_PAD.left - 5 || x > futureZoneRight + 5) continue;
          const d = new Date(t * 1000);
          const h = d.getHours();
          const m = d.getMinutes();
          const ampm = h >= 12 ? 'pm' : 'am';
          const h12 = h > 12 ? h - 12 : h || 12;
          allLabels.push({ x, label: `${h12}:${m.toString().padStart(2, '0')}${ampm}` });
        }
        const timeLabels: { x: number; label: string }[] = [];
        for (const lbl of allLabels) {
          if (timeLabels.length === 0 || lbl.x - timeLabels[timeLabels.length - 1].x >= MIN_LABEL_GAP) {
            timeLabels.push(lbl);
          }
        }
        setOverlay(prev => {
          if (prev.timeLabels.length === timeLabels.length &&
              prev.timeLabels.every((t, i) => t.x === timeLabels[i].x && t.label === timeLabels[i].label)) {
            return prev;
          }
          return { ...prev, timeLabels };
        });
      }

      // ── Expose coordinate mapper for TradeBubbles ──
      const lr = liveRangeRef.current;
      const chartH = H - LL_PAD.top - LL_PAD.bottom;
      const contentW = futureZoneRight - LL_PAD.left;
      chartCoordsRef.current = {
        contentArea: { width: contentW > 0 ? contentW : W, height: chartH > 0 ? chartH : H },
        timeToX: (timeSec: number) => {
          const x = toX(timeSec);
          if (x < LL_PAD.left - 20 || x > futureZoneRight + 20) return null;
          return x;
        },
        priceToY: (price: number) => {
          if (!lr || chartH <= 0) return null;
          const range = lr.max - lr.min;
          if (range <= 0) return null;
          const y = LL_PAD.top + (1 - (price - lr.min) / range) * chartH;
          // Bounds check: hide if price scrolled out of view
          if (y < LL_PAD.top - 20 || y > LL_PAD.top + chartH + 20) return null;
          return y;
        },
      };
      // Notify TradeBubbles in same frame — zero lag
      if (chartCoordsRef.onFrame) chartCoordsRef.onFrame();
    };
    let raf: number;
    const loop = () => { update(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); chartCoordsRef.current = null; };
  }, [roundStartSec, roundEndSec, dims.w, dims.h]);

  // Seed with historical candles
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await api.getCandles({
          asset: selectedAsset as any,
          intervalSec: CANDLE_SEC,
          lookbackSec: LOOKBACK_SEC,
        });
        if (cancelled || !result.candles?.length) return;
        const pts: LivelinePoint[] = [];
        const seen = new Set<number>();
        for (const c of result.candles) {
          if (c.close <= 0 || seen.has(c.time)) continue;
          seen.add(c.time);
          pts.push({ time: c.time, value: c.close });
        }
        pts.sort((a, b) => a.time - b.time);
        dataRef.current = pts;
        lastTimeRef.current = pts.length > 0 ? pts[pts.length - 1].time : 0;
        setData([...pts]);
      } catch (e) {
        console.warn('[LiteChart] Failed to fetch candles:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedAsset]);

  // Live WS price updates
  useEffect(() => {
    const ws = getWebSocket();
    const unsub = ws.onMessage((msg: any) => {
      if (msg.channel !== 'prices' && msg.type !== 'price_update') return;
      const d = msg.data;
      if (!d) return;
      let price: number | undefined;
      if (typeof d.price === 'number' && d.price > 0) {
        if (d.asset === selectedAsset || !d.asset) price = d.price;
      } else if (d[selectedAsset]?.price) {
        price = d[selectedAsset].price;
      }
      if (!price || price <= 0) return;
      const now = Math.floor(Date.now() / 1000);
      if (now <= lastTimeRef.current) return;
      lastTimeRef.current = now;
      const pt: LivelinePoint = { time: now, value: price };
      dataRef.current = [...dataRef.current.slice(-1200), pt];
      setData([...dataRef.current]);
    });
    return unsub;
  }, [selectedAsset]);

  const prevValueRef = useRef(value);
  const [priceMomentum, setPriceMomentum] = useState<'up' | 'down' | 'flat'>('flat');

  useEffect(() => {
    if (value <= 0 || prevValueRef.current <= 0) {
      prevValueRef.current = value;
      return;
    }
    if (value > prevValueRef.current) setPriceMomentum('up');
    else if (value < prevValueRef.current) setPriceMomentum('down');
    prevValueRef.current = value;
  }, [value]);

  const isBelowStrike = strikePrice > 0 && value > 0 && value < strikePrice;
  const lineColor = isBelowStrike ? '#f55252' : '#95ff94';
  const priceBadgeColor = priceMomentum === 'up' ? '#22c55e' : priceMomentum === 'down' ? '#f55252' : '#888';

  return (
    <div ref={outerRef} style={{ width: '100%', height: '100%', background: '#1e1e1e', position: 'relative' }}>
      {/* Active area highlight — positioned by ref in rAF for zero jitter */}
      <div ref={activeAreaRef} style={{
        position: 'absolute', left: 0, top: LL_PAD.top, bottom: LL_PAD.bottom,
        background: '#232323', pointerEvents: 'none',
        display: 'none', willChange: 'transform',
      }} />

      {/* Liveline — full width, grid disabled (custom Y-axis drawn at right edge) */}
      <Liveline
        data={data}
        value={value}
        color={lineColor}
        theme="dark"
        grid={false}
        badge={false}
        fill={true}
        pulse={true}
        momentum={true}
        scrub={true}
        cursor="default"
        timeAxis={false}
        dashLineColor={priceBadgeColor}
        window={WINDOW_SEC}
        lerpSpeed={LERP_SPEED}
        referenceLine={effectiveStrike > 0 ? { value: effectiveStrike } : undefined}
        onRangeUpdate={handleRangeUpdate}
        formatValue={(v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
        padding={LL_PAD}
      />

      {/* Custom grid lines + Y-axis labels at the container's right edge */}
      {gridLines.map((g, i) => (
        <div key={i} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <div style={{
            position: 'absolute', left: LL_PAD.left, right: YAXIS_W,
            top: g.y, height: 0,
            borderTop: '1px solid rgba(238,238,238,0.05)', zIndex: 1,
          }} />
          <div style={{
            position: 'absolute', right: 12, top: g.y, transform: 'translateY(-50%)',
            fontSize: 16, color: 'rgba(238,238,238,0.33)', zIndex: 2,
            fontFamily: "'IBM Plex Mono', monospace",
            whiteSpace: 'nowrap',
          }}>
            {g.val.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </div>
        </div>
      ))}

      {/* Strike line — positioned by ref from Liveline's onRangeUpdate (frame-synced) */}
      <div ref={strikeLineRef} style={{
        position: 'absolute', left: LL_PAD.left, right: YAXIS_W,
        height: 0, borderTop: '2px dashed #001eff',
        zIndex: 3, pointerEvents: 'none', display: 'none',
      }} />
      {/* Strike price Y-axis badge — positioned by ref (frame-synced) */}
      <div ref={strikeBadgeRef} style={{
        position: 'absolute', right: 4, transform: 'translateY(-50%)',
        padding: '3px 9px', borderRadius: 5, background: '#001eff',
        fontSize: 16, fontWeight: 600, color: '#fff', zIndex: 8,
        fontFamily: "'IBM Plex Mono', monospace",
        whiteSpace: 'nowrap', pointerEvents: 'none', display: 'none',
      }}>
        {effectiveStrike > 0 ? effectiveStrike.toLocaleString('en-US', { minimumFractionDigits: 2 }) : ''}
      </div>

      {/* Current price Y-axis badge — positioned by ref (frame-synced) */}
      <div ref={priceBadgeRef} style={{
        position: 'absolute', right: 4, transform: 'translateY(-50%)',
        padding: '3px 9px', borderRadius: 5, background: priceBadgeColor,
        fontSize: 16, fontWeight: 600, color: '#fff', zIndex: 8,
        fontFamily: "'IBM Plex Mono', monospace",
        whiteSpace: 'nowrap', pointerEvents: 'none',
        transition: 'background 0.3s ease',
      }}>
        {value > 0 ? value.toLocaleString('en-US', { minimumFractionDigits: 2 }) : ''}
      </div>

      {/* Round START vertical line — positioned by ref */}
      <div ref={startVertLineRef} style={{
        position: 'absolute', left: 0, top: LL_PAD.top, bottom: LL_PAD.bottom,
        width: 0, borderLeft: '1px solid rgba(238,238,238,0.22)',
        zIndex: 6, pointerEvents: 'none',
        display: 'none', willChange: 'transform',
      }} />

      {/* Round END vertical line — positioned by ref */}
      <div ref={endVertLineRef} style={{
        position: 'absolute', left: 0, top: LL_PAD.top, bottom: LL_PAD.bottom,
        width: 0, borderLeft: '1px solid rgba(238,238,238,0.22)',
        zIndex: 6, pointerEvents: 'none',
        display: 'none', willChange: 'transform',
      }} />

      {/* Time labels + vertical grid lines across the full chart width */}
      {overlay.timeLabels.map((tl, i) => (
        <div key={`tl-${i}`} style={{ position: 'absolute', pointerEvents: 'none' }}>
          <div style={{
            position: 'absolute', left: tl.x, top: LL_PAD.top,
            bottom: LL_PAD.bottom, width: 1,
            background: 'rgba(238,238,238,0.05)', zIndex: 2,
          }} />
          <div style={{
            position: 'absolute', left: tl.x, bottom: 12,
            transform: 'translateX(-50%)',
            fontSize: 16, color: 'rgba(238,238,238,0.33)',
            fontFamily: "'IBM Plex Mono', monospace",
            whiteSpace: 'nowrap', zIndex: 3,
          }}>{tl.label}</div>
        </div>
      ))}
    </div>
  );
}
