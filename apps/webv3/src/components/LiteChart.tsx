import { useEffect, useRef, useState, useMemo } from 'react';
import { Liveline } from '../lib/liveline';
import type { LivelinePoint } from '../lib/liveline';
import { useMarketStore } from '@/stores/marketStore';
import { usePriceStore } from '@/stores/priceStore';
import { useSelectedMarket } from '@/stores/marketStore';
import { getWebSocket } from '@/lib/websocket';
import { api } from '@/lib/api';

const LOOKBACK_SEC = 600;
const ROUND_SEC = 5 * 60;
const CANDLE_SEC = 5;
const WINDOW_SEC = 500;
const LL_BUFFER = 0.05;

// Large right padding pushes liveline's live dot to ~57% of visible width,
// matching the pro chart where the current candle sits around 55-60%.
// The remaining right space is the "future zone" where END line + shading appear.
// grid={false} hides liveline's built-in Y-axis; we draw our own at the right edge.
const FUTURE_RIGHT = 560;
const YAXIS_W = 140;
const LL_PAD = { top: 80, right: FUTURE_RIGHT, bottom: 56, left: 24 };

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

  const [data, setData] = useState<LivelinePoint[]>([]);
  const dataRef = useRef<LivelinePoint[]>([]);
  const lastTimeRef = useRef(0);
  const outerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const expiryMs = market?.expiry ?? 0;
  const roundEndSec = expiryMs > 0 ? Math.floor(expiryMs / 1000) : 0;
  const roundStartSec = roundEndSec > 0 ? roundEndSec - ROUND_SEC : 0;

  const value = currentPrice ?? data[data.length - 1]?.value ?? 0;

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

  // Compute Y-axis range (mirrors liveline's computeRange target for convergence)
  const yRange = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const rightEdge = now + WINDOW_SEC * LL_BUFFER;
    const leftEdge = rightEdge - WINDOW_SEC;
    let min = Infinity, max = -Infinity;
    for (const p of data) {
      if (p.time >= leftEdge - 2 && p.time <= rightEdge) {
        if (p.value < min) min = p.value;
        if (p.value > max) max = p.value;
      }
    }
    if (value > 0) { min = Math.min(min, value); max = Math.max(max, value); }
    if (strikePrice > 0) { min = Math.min(min, strikePrice); max = Math.max(max, strikePrice); }
    if (!isFinite(min) || !isFinite(max)) return null;
    const raw = max - min;
    const minR = raw * 0.1 || 0.4;
    if (raw < minR) { const mid = (min + max) / 2; return { min: mid - minR / 2, max: mid + minR / 2 }; }
    const margin = raw * 0.12;
    return { min: min - margin, max: max + margin };
  }, [data, value, strikePrice]);

  // Grid lines
  const gridLines = useMemo(() => {
    if (!yRange) return [];
    const range = yRange.max - yRange.min;
    const chartH = dims.h - LL_PAD.top - LL_PAD.bottom;
    if (range <= 0 || chartH <= 0) return [];
    const interval = niceInterval(range);
    const result: { val: number; y: number }[] = [];
    const start = Math.ceil(yRange.min / interval) * interval;
    for (let v = start; v <= yRange.max; v += interval) {
      result.push({ val: v, y: LL_PAD.top + (1 - (v - yRange.min) / range) * chartH });
    }
    return result;
  }, [yRange, dims.h]);

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

  useEffect(() => {
    if (roundStartSec <= 0 || roundEndSec <= 0 || dims.w <= 0) {
      setOverlay({ startPx: null, endPx: null, liveDotX: 0, timeLabels: [] });
      return;
    }
    const update = () => {
      const W = dims.w;
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

      // Time labels every 60s across the full visible range, with minimum pixel gap
      const MIN_LABEL_GAP = 160;
      const allLabels: { x: number; label: string }[] = [];
      const firstTick = Math.ceil(leftEdge / 60) * 60;
      for (let t = firstTick; t <= futureEnd; t += 60) {
        const x = toX(t);
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

      setOverlay({
        startPx: startOk ? sx : null,
        endPx: endOk ? ex : null,
        liveDotX: chartRightEdge,
        timeLabels,
      });
    };
    let raf: number;
    const loop = () => { update(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [roundStartSec, roundEndSec, dims.w]);

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

  const startPx = overlay.startPx;
  const endPx = overlay.endPx;

  return (
    <div ref={outerRef} style={{ width: '100%', height: '100%', background: '#1e1e1e', position: 'relative' }}>
      {/* Active area highlight — rendered BEFORE Liveline so canvas paints on top */}
      {startPx !== null && endPx !== null && endPx > startPx && (
        <div style={{
          position: 'absolute', left: startPx, top: LL_PAD.top,
          width: endPx - startPx, bottom: LL_PAD.bottom,
          background: '#232323', pointerEvents: 'none',
        }} />
      )}

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
        scrub={false}
        timeAxis={false}
        dashLineColor={priceBadgeColor}
        window={WINDOW_SEC}
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
            fontSize: 22, color: 'rgba(238,238,238,0.33)', zIndex: 2,
            fontFamily: "'IBM Plex Mono', monospace",
            whiteSpace: 'nowrap',
          }}>
            {g.val.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </div>
        </div>
      ))}

      {/* Strike price — blue horizontal line + Y-axis label (matching pro style) */}
      {strikePrice > 0 && yRange && (() => {
        const range = yRange.max - yRange.min;
        const chartH = dims.h - LL_PAD.top - LL_PAD.bottom;
        if (range <= 0 || chartH <= 0) return null;
        const strikeY = LL_PAD.top + (1 - (strikePrice - yRange.min) / range) * chartH;
        return (
          <>
            {/* Dashed blue horizontal strike line */}
            <div style={{
              position: 'absolute', left: LL_PAD.left, right: YAXIS_W,
              top: strikeY, height: 0,
              borderTop: '2px dashed #001eff', zIndex: 3, pointerEvents: 'none',
            }} />
            {/* Blue Y-axis label for strike price */}
            <div style={{
              position: 'absolute', right: 4, top: strikeY, transform: 'translateY(-50%)',
              padding: '4px 12px', borderRadius: 6, background: '#001eff',
              fontSize: 22, fontWeight: 600, color: '#fff', zIndex: 8,
              fontFamily: "'IBM Plex Mono', monospace",
              whiteSpace: 'nowrap', pointerEvents: 'none',
            }}>
              {strikePrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
          </>
        );
      })()}

      {/* Current price Y-axis label — green when up, red when down */}
      {value > 0 && yRange && (() => {
        const range = yRange.max - yRange.min;
        const chartH = dims.h - LL_PAD.top - LL_PAD.bottom;
        if (range <= 0 || chartH <= 0) return null;
        const priceY = LL_PAD.top + (1 - (value - yRange.min) / range) * chartH;
        return (
          <div style={{
            position: 'absolute', right: 4, top: priceY, transform: 'translateY(-50%)',
            padding: '4px 12px', borderRadius: 6, background: priceBadgeColor,
            fontSize: 22, fontWeight: 600, color: '#fff', zIndex: 8,
            fontFamily: "'IBM Plex Mono', monospace",
            whiteSpace: 'nowrap', pointerEvents: 'none',
            transition: 'background 0.3s ease',
          }}>
            {value.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </div>
        );
      })()}

      {/* Round START vertical line */}
      {startPx !== null && (
        <div style={{
          position: 'absolute', left: startPx, top: LL_PAD.top, bottom: LL_PAD.bottom,
          width: 0, borderLeft: '1px solid rgba(238,238,238,0.22)',
          zIndex: 6, pointerEvents: 'none',
        }} />
      )}

      {/* Round END vertical line */}
      {endPx !== null && (
        <div style={{
          position: 'absolute', left: endPx, top: LL_PAD.top, bottom: LL_PAD.bottom,
          width: 0, borderLeft: '1px solid rgba(238,238,238,0.22)',
          zIndex: 6, pointerEvents: 'none',
        }} />
      )}

      {/* Time labels + vertical grid lines across the full chart width */}
      {overlay.timeLabels.map((tl, i) => (
        <div key={`tl-${i}`} style={{ position: 'absolute', pointerEvents: 'none' }}>
          <div style={{
            position: 'absolute', left: tl.x, top: LL_PAD.top,
            bottom: LL_PAD.bottom, width: 1,
            background: 'rgba(238,238,238,0.05)', zIndex: 2,
          }} />
          <div style={{
            position: 'absolute', left: tl.x, bottom: 16,
            transform: 'translateX(-50%)',
            fontSize: 22, color: 'rgba(238,238,238,0.33)',
            fontFamily: "'IBM Plex Mono', monospace",
            whiteSpace: 'nowrap', zIndex: 3,
          }}>{tl.label}</div>
        </div>
      ))}
    </div>
  );
}
