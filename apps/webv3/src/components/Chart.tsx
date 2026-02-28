import { useEffect, useRef, useCallback } from 'react';
import { createChart, CandlestickSeries, LineSeries, ColorType } from 'lightweight-charts';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { useSelectedMarket } from '@/stores/marketStore';
import { useMarketStore } from '@/stores/marketStore';
import { api, type Candle } from '@/lib/api';
import { getWebSocket } from '@/lib/websocket';
import { useChartToolbarStore } from './ChartToolbar';
import { chartCoordsRef } from '@/lib/chartCoords';

const PRICE_SCALE_WIDTH = 120;
const TIME_SCALE_HEIGHT = 40;
const TOOLBAR_CLEARANCE = 0;
const CANDLE_SEC = 5;
const VISIBLE_WINDOW = 500; // seconds — matches Lite chart's WINDOW_SEC
const ROUND_SEC = 5 * 60;
const RIGHT_PAD_BARS = 8; // bars of padding past latest candle

function formatLocalTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h > 12 ? h - 12 : h || 12;
  return `${h12}:${m.toString().padStart(2, '0')}${ampm}`;
}

interface ChartProps {
  mode?: 'pro' | 'lite';
}

export default function Chart({ mode = 'pro' }: ChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const overlayClipRef = useRef<HTMLDivElement>(null);

  const activeHighlightRef = useRef<HTMLDivElement>(null);
  const leftLineRef = useRef<HTMLDivElement>(null);
  const rightLineRef = useRef<HTMLDivElement>(null);
  const priceLineRef = useRef<HTMLDivElement>(null);

  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null>(null);
  const lastCandleRef = useRef<{ time: number; close: number } | null>(null);
  const strikeLineRef = useRef<any>(null);

  const market = useSelectedMarket();
  const { selectedAsset } = useMarketStore();
  const strikePrice = market?.strike ?? 0;
  const marketExpiry = market?.expiry ?? 0;

  const strikePriceRef = useRef(strikePrice);
  const marketExpiryRef = useRef(marketExpiry);
  const selectedAssetRef = useRef(selectedAsset);
  strikePriceRef.current = strikePrice;
  marketExpiryRef.current = marketExpiry;
  selectedAssetRef.current = selectedAsset;

  const roundTimesRef = useRef({ roundStart: 0, roundEnd: 0 });
  const tickSizeRef = useRef(useChartToolbarStore.getState().tickSize);
  const initExpiryRef = useRef(0);

  const rafRef = useRef(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  const updateOverlays = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const { roundStart, roundEnd } = roundTimesRef.current;
    if (!roundStart || !roundEnd) return;

    const ts = chart.timeScale();
    const clipWidth = overlayClipRef.current?.clientWidth ?? 0;
    if (clipWidth <= 0) return;

    // Map round times to pixel positions via timeToCoordinate
    const startPx = ts.timeToCoordinate(roundStart as any);
    const endPx = ts.timeToCoordinate(roundEnd as any);

    if (startPx === null || endPx === null) return;

    // Active area highlight
    if (activeHighlightRef.current) {
      if (startPx < clipWidth && endPx > 0) {
        const left = Math.max(0, startPx);
        const right = Math.min(clipWidth, endPx);
        activeHighlightRef.current.style.display = 'block';
        activeHighlightRef.current.style.left = `${left}px`;
        activeHighlightRef.current.style.width = `${right - left}px`;
      } else {
        activeHighlightRef.current.style.display = 'none';
      }
    }

    // Left boundary line (START)
    if (leftLineRef.current) {
      if (startPx > 0 && startPx < clipWidth) {
        leftLineRef.current.style.display = 'block';
        leftLineRef.current.style.left = `${startPx}px`;
      } else {
        leftLineRef.current.style.display = 'none';
      }
    }

    // Right boundary line (END)
    if (rightLineRef.current) {
      if (endPx > 0 && endPx < clipWidth) {
        rightLineRef.current.style.display = 'block';
        rightLineRef.current.style.left = `${endPx}px`;
      } else {
        rightLineRef.current.style.display = 'none';
      }
    }

    // Current price line — from last candle to right edge only
    const el = priceLineRef.current;
    const s = seriesRef.current;
    const lc = lastCandleRef.current;
    if (el && s && lc) {
      const y = (s as any).priceToCoordinate(lc.close);
      const x = ts.timeToCoordinate(lc.time as any);
      if (y !== null && x !== null && clipWidth > 0 && x < clipWidth) {
        el.style.display = 'block';
        el.style.top = `${y}px`;
        el.style.left = `${Math.max(0, x)}px`;
        el.style.width = `${clipWidth - Math.max(0, x)}px`;
      } else {
        el.style.display = 'none';
      }
    } else if (el) {
      el.style.display = 'none';
    }
  }, []);

  useEffect(() => {
    if (!chartContainerRef.current) return;
    const container = chartContainerRef.current;
    let cancelled = false;

    function bootstrap() {
      if (cancelled) return;
      if (container.clientWidth === 0 || container.clientHeight === 0) {
        requestAnimationFrame(bootstrap);
        return;
      }
      setup();
    }

    function setup() {
    if (cancelled) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#1e1e1e' },
        textColor: 'rgba(238,238,238,0.33)',
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 18,
      },
      grid: {
        vertLines: { color: 'rgba(238,238,238,0.05)' },
        horzLines: { color: 'rgba(238,238,238,0.05)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(238,238,238,0.33)', width: 1, style: 3 },
        horzLine: { color: 'rgba(238,238,238,0.33)', width: 1, style: 3 },
      },
      rightPriceScale: {
        borderColor: 'rgba(238,238,238,0.11)',
        textColor: 'rgba(238,238,238,0.33)',
        scaleMargins: { top: 0.06, bottom: 0.06 },
      },
      timeScale: {
        borderColor: 'rgba(238,238,238,0.11)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        fixLeftEdge: false,
        fixRightEdge: false,
        tickMarkFormatter: (time: any) => formatLocalTime(time as number),
      },
      localization: {
        timeFormatter: (time: any) => formatLocalTime(time as number),
      },
      handleScale: { mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
    });
    chartRef.current = chart;

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#76cb6c',
      downColor: '#f55252',
      borderDownColor: '#f55252',
      borderUpColor: '#76cb6c',
      wickDownColor: '#f55252',
      wickUpColor: '#76cb6c',
      lastValueVisible: false,
      priceLineVisible: false,
    });

    // Invisible helper series to extend the time axis for overlay positioning.
    const helperSeries = chart.addSeries(LineSeries, {
      color: 'rgba(0,0,0,0)',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      pointMarkersVisible: false,
      priceScaleId: '_helper',
    });
    chart.priceScale('_helper').applyOptions({ visible: false });

    seriesRef.current = series as any;

    let currentPriceLine: any = null;
    let strikeLine: any = null;

    // Anchored visible range — set once on init, re-applied on market activation.
    let anchoredRange: { from: number; to: number } | null = null;

    // Track user interaction — pause auto-scrolling when user scrolls/zooms.
    // Auto-resets after 10s of inactivity so the chart resumes following price.
    let userInteracted = false;
    let interactTimer: ReturnType<typeof setTimeout> | null = null;
    const markInteracted = () => {
      userInteracted = true;
      if (interactTimer) clearTimeout(interactTimer);
      interactTimer = setTimeout(() => { userInteracted = false; }, 10_000);
    };
    container.addEventListener('mousedown', markInteracted);
    container.addEventListener('wheel', markInteracted);

    // Mutable candle array — only real data (API + WS), no padding
    const candles: { time: number; open: number; high: number; low: number; close: number }[] = [];

    function pushToChart() {
      series.setData(candles as any);
    }

    function extendTimeAxis(price: number) {
      const { roundStart, roundEnd } = roundTimesRef.current;
      if (!roundStart || !roundEnd || price <= 0) return;
      const padAfter = Math.round((VISIBLE_WINDOW - ROUND_SEC) * 0.25);
      const padBefore = VISIBLE_WINDOW - ROUND_SEC - padAfter;
      const from = roundStart - padBefore;
      const to = roundEnd + padAfter;
      const timeSet = new Set<number>();
      const pts: { time: any; value: number }[] = [];
      for (let t = from; t <= to; t += CANDLE_SEC) {
        timeSet.add(t);
        pts.push({ time: t as any, value: price });
      }
      // Ensure exact roundStart and roundEnd are in the helper series
      if (!timeSet.has(roundStart)) pts.push({ time: roundStart as any, value: price });
      if (!timeSet.has(roundEnd)) pts.push({ time: roundEnd as any, value: price });
      pts.sort((a, b) => (a.time as number) - (b.time as number));
      helperSeries.setData(pts as any);
    }

    function updateCurrentPrice(price: number) {
      if (currentPriceLine) {
        currentPriceLine.applyOptions({ price });
      }
    }

    function computeRoundTimes() {
      const exp = marketExpiryRef.current;
      if (exp > 0) {
        const expSec = Math.floor(exp / 1000);
        roundTimesRef.current = { roundStart: expSec - ROUND_SEC, roundEnd: expSec };
      } else {
        const now = Math.floor(Date.now() / 1000);
        const rs = now - (now % ROUND_SEC);
        roundTimesRef.current = { roundStart: rs, roundEnd: rs + ROUND_SEC };
      }
    }

    async function init() {
      // 1) Fetch historical candles
      try {
        const result = await api.getCandles({
          asset: selectedAssetRef.current as any,
          intervalSec: CANDLE_SEC,
          lookbackSec: 600,
        });

        if (cancelled) return;

        if (result.candles && result.candles.length > 0) {
          // Validate & deduplicate
          const seen = new Set<number>();
          for (const c of result.candles) {
            if (c.open <= 0 || c.close <= 0 || c.high <= 0 || c.low <= 0) continue;
            if (seen.has(c.time)) continue;
            seen.add(c.time);
            candles.push({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
          }
          candles.sort((a, b) => a.time - b.time);

          for (let i = candles.length - 1; i > 0; i--) {
            if (candles[i].time === candles[i - 1].time) {
              candles.splice(i, 1);
            }
          }

          console.log(`[Chart] Loaded ${candles.length} candles, range: ${candles[0]?.close} - ${candles[candles.length - 1]?.close}`);
        }
      } catch (e) {
        console.warn('[Chart] Failed to fetch candles:', e);
      }

      if (cancelled) return;

      // 2) Compute round times and extend the time axis via invisible helper
      computeRoundTimes();
      const lastClose0 = candles.length > 0 ? candles[candles.length - 1].close : 0;
      if (lastClose0 > 0) extendTimeAxis(lastClose0);

      pushToChart();

      // 4) Price lines
      const lastClose = candles.length > 0 ? candles[candles.length - 1].close : 0;
      const effectiveStrike = strikePriceRef.current > 0 ? strikePriceRef.current : lastClose;

      if (effectiveStrike > 0 && !strikeLine) {
        strikeLine = series.createPriceLine({
          price: effectiveStrike,
          color: '#001eff', lineWidth: 2, lineStyle: 2,
          axisLabelVisible: true, title: '',
          axisLabelColor: '#001eff', axisLabelTextColor: '#eeeeee',
        });
        strikeLineRef.current = strikeLine;
      } else if (strikeLine && effectiveStrike > 0) {
        strikeLine.applyOptions({ price: effectiveStrike });
      }

      if (lastClose > 0 && !currentPriceLine) {
        currentPriceLine = series.createPriceLine({
          price: lastClose,
          color: '#ca5858', lineWidth: 2, lineStyle: 2,
          lineVisible: false,
          axisLabelVisible: true, title: '',
          axisLabelColor: '#ca5858', axisLabelTextColor: '#eeeeee',
        });
      } else if (currentPriceLine && lastClose > 0) {
        currentPriceLine.applyOptions({ price: lastClose });
      }
      if (lastClose > 0 && candles.length > 0) {
        lastCandleRef.current = { time: candles[candles.length - 1].time, close: lastClose };
      }

      // 5) Set visible range matching Lite chart's VISIBLE_WINDOW (500s)
      const { roundStart: rs0, roundEnd: re0 } = roundTimesRef.current;
      if (rs0 && re0) {
        const padAfter = Math.round((VISIBLE_WINDOW - ROUND_SEC) * 0.25);
        const padBefore = VISIBLE_WINDOW - ROUND_SEC - padAfter;
        anchoredRange = { from: rs0 - padBefore, to: re0 + padAfter };
        chart.timeScale().setVisibleRange({
          from: anchoredRange.from as any,
          to: anchoredRange.to as any,
        });
        initExpiryRef.current = marketExpiryRef.current;
      } else {
        chart.timeScale().fitContent();
      }
      chart.timeScale().subscribeVisibleTimeRangeChange(updateOverlays);
      chart.timeScale().subscribeVisibleLogicalRangeChange(updateOverlays);

      // Continuously sync overlays via rAF so Y-axis (price scale) drags are tracked instantly
      function rafLoop() {
        if (cancelled) return;
        updateOverlays();
        // Expose coordinate mapper for TradeBubbles
        const clipW = overlayClipRef.current?.clientWidth ?? 0;
        const clipH = overlayClipRef.current?.clientHeight ?? 0;
        chartCoordsRef.current = {
          timeToX: (timeSec: number) => {
            const x = chart.timeScale().timeToCoordinate(timeSec as any);
            if (x !== null) return x;
            const vr = chart.timeScale().getVisibleRange();
            if (!vr || clipW <= 0) return null;
            const from = vr.from as number;
            const to = vr.to as number;
            if (to <= from) return null;
            const frac = (timeSec - from) / (to - from);
            if (frac < -0.05 || frac > 1.05) return null;
            return frac * clipW;
          },
          priceToY: (price: number) => {
            const s = seriesRef.current;
            if (!s) return null;
            const y = (s as any).priceToCoordinate(price);
            if (y !== null) return y;
            const vpr = (s as any).priceScale?.()?.getVisiblePriceRange?.();
            if (!vpr || clipH <= 0) return null;
            const pMin = vpr.minValue as number;
            const pMax = vpr.maxValue as number;
            if (pMax <= pMin) return null;
            return clipH * (1 - (price - pMin) / (pMax - pMin));
          },
        };
        // Notify TradeBubbles in same frame — zero lag
        if (chartCoordsRef.onFrame) chartCoordsRef.onFrame();
        rafRef.current = requestAnimationFrame(rafLoop);
      }
      rafRef.current = requestAnimationFrame(rafLoop);

      // Overlay positioning needs the layout to be fully computed; retry several times
      for (const delay of [100, 300, 600, 1200]) {
        setTimeout(updateOverlays, delay);
      }
    }

    init();

    // 5) Live WebSocket price updates
    const ws = getWebSocket();
    const wsUnsub = ws.onMessage((msg) => {
      if (cancelled) return;
      const m = msg as any;

      // Handle price updates
      if (m.channel === 'prices' || m.type === 'price_update') {
        const d = m.data;
        if (!d) return;

        // Extract price for the selected asset
        let price: number | undefined;
        const asset = selectedAssetRef.current;
        if (typeof d.price === 'number' && d.price > 0) {
          if (d.asset === asset || !d.asset) price = d.price;
        } else if (d[asset]?.price) {
          price = d[asset].price;
        }

        if (!price || price <= 0) return;

        const now = Math.floor(Date.now() / 1000);
        const bucket = now - (now % CANDLE_SEC);

        let updatedCandle: typeof candles[0] | null = null;
        let isNewBar = false;
        if (candles.length > 0) {
          const last = candles[candles.length - 1];
          if (last.time === bucket) {
            last.close = price;
            last.high = Math.max(last.high, price);
            last.low = Math.min(last.low, price);
            updatedCandle = last;
          } else if (bucket > last.time) {
            const nc = { time: bucket, open: price, high: price, low: price, close: price };
            candles.push(nc);
            if (candles.length > 300) candles.splice(0, candles.length - 300);
            updatedCandle = nc;
            isNewBar = true;
          }
        } else {
          const nc = { time: bucket, open: price, high: price, low: price, close: price };
          candles.push(nc);
          updatedCandle = nc;
          isNewBar = true;
        }

        updateCurrentPrice(price);
        const lastC = candles[candles.length - 1];
        if (lastC) lastCandleRef.current = { time: lastC.time, close: lastC.close };

        if (!currentPriceLine && price > 0) {
          currentPriceLine = series.createPriceLine({
            price,
            color: '#ca5858', lineWidth: 2, lineStyle: 2,
            lineVisible: false,
            axisLabelVisible: true, title: '',
            axisLabelColor: '#ca5858', axisLabelTextColor: '#eeeeee',
          });
        }
        if (!strikeLine && strikePriceRef.current > 0) {
          strikeLine = series.createPriceLine({
            price: strikePriceRef.current,
            color: '#001eff', lineWidth: 2, lineStyle: 2,
            axisLabelVisible: true, title: '',
            axisLabelColor: '#001eff', axisLabelTextColor: '#eeeeee',
          });
        }

        if (updatedCandle) {
          series.update(updatedCandle as any);
        }

        // Auto-scroll: keep the latest candle visible using a constant-duration
        // window (VISIBLE_WINDOW) that matches the Lite chart's zoom level.
        // During the initial phase the range equals the init framing exactly;
        // once candles pass roundEnd the view starts scrolling left smoothly.
        if (isNewBar && !userInteracted && candles.length > 0) {
          const latestTime = candles[candles.length - 1].time;
          const { roundStart: rs, roundEnd: re } = roundTimesRef.current;
          const rightPad = CANDLE_SEC * RIGHT_PAD_BARS;
          const padAfter = Math.round((VISIBLE_WINDOW - ROUND_SEC) * 0.25);
          const rightEdge = Math.max(re + padAfter, latestTime + rightPad);
          const leftEdge = rightEdge - VISIBLE_WINDOW;

          // Extend helper series so overlays (roundStart / roundEnd) stay anchored
          const lastP = candles[candles.length - 1].close;
          if (lastP > 0) {
            const helperFrom = Math.min(rs, leftEdge);
            const helperTo = rightEdge;
            const hPts: { time: any; value: number }[] = [];
            const hSet = new Set<number>();
            for (let t = helperFrom; t <= helperTo; t += CANDLE_SEC) {
              hSet.add(t); hPts.push({ time: t as any, value: lastP });
            }
            if (!hSet.has(rs)) hPts.push({ time: rs as any, value: lastP });
            if (!hSet.has(re)) hPts.push({ time: re as any, value: lastP });
            hPts.sort((a, b) => (a.time as number) - (b.time as number));
            helperSeries.setData(hPts as any);
          }

          try {
            chart.timeScale().setVisibleRange({ from: leftEdge as any, to: rightEdge as any });
          } catch { /* chart not ready */ }
        }
        updateOverlays();
      }

      // Handle market resolution/activation → recalc round times and snap back to default
      if (m.channel === 'market' && (m.event === 'resolved' || m.type === 'market_activated' || m.type === 'market_resolved')) {
        // On market resolved: immediately remove strike line (gap until next market activates)
        if (m.event === 'resolved' || m.type === 'market_resolved') {
          if (strikeLine && series) {
            try { series.removePriceLine(strikeLine); } catch { /* already removed */ }
            strikeLine = null;
            strikeLineRef.current = null;
          }
        }
        setTimeout(() => {
          computeRoundTimes();
          userInteracted = false;
          const { roundStart: rs, roundEnd: re } = roundTimesRef.current;
          if (rs && re) {
            const padA = Math.round((VISIBLE_WINDOW - ROUND_SEC) * 0.25);
            const padB = VISIBLE_WINDOW - ROUND_SEC - padA;
            anchoredRange = { from: rs - padB, to: re + padA };
            const lastP = candles.length > 0 ? candles[candles.length - 1].close : 0;
            if (lastP > 0) extendTimeAxis(lastP);
            chart.timeScale().setVisibleRange({
              from: anchoredRange.from as any,
              to: anchoredRange.to as any,
            });
          }
          updateOverlays();
        }, 500);
      }
    });

    // 6) Resize — chart auto-sizes itself; just sync overlays
    const handleResize = () => {
      setTimeout(updateOverlays, 50);
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    cleanupRef.current = () => {
      cancelled = true;
      wsUnsub();
      resizeObserver.disconnect();
      container.removeEventListener('mousedown', markInteracted);
      container.removeEventListener('wheel', markInteracted);
      if (interactTimer) clearTimeout(interactTimer);
      cancelAnimationFrame(rafRef.current);
      chartCoordsRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      lastCandleRef.current = null;
    };
    } // end setup()

    bootstrap();

    return () => {
      cancelled = true;
      if (cleanupRef.current) cleanupRef.current();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (strikePrice > 0 && strikeLineRef.current) {
      strikeLineRef.current.applyOptions({ price: strikePrice });
    } else if (strikePrice === 0 && strikeLineRef.current && seriesRef.current) {
      // Market expired or no active market — remove strike line
      try { seriesRef.current.removePriceLine(strikeLineRef.current); } catch { /* already removed */ }
      strikeLineRef.current = null;
    }
  }, [strikePrice]);

  // When market expiry changes (new round), recalculate round times and re-anchor the view.
  // Skip the initial load — init() already handles the first framing.
  useEffect(() => {
    if (!marketExpiry || !chartRef.current || !seriesRef.current) return;

    // If init() already framed this exact expiry (or hasn't framed yet), skip.
    // This prevents the effect from overriding init()'s framing when the
    // market store loads 1-2s after mount.
    if (initExpiryRef.current === 0 || marketExpiry === initExpiryRef.current) {
      roundTimesRef.current = {
        roundStart: Math.floor(marketExpiry / 1000) - 5 * 60,
        roundEnd: Math.floor(marketExpiry / 1000),
      };
      return;
    }

    const expSec = Math.floor(marketExpiry / 1000);
    roundTimesRef.current = { roundStart: expSec - ROUND_SEC, roundEnd: expSec };

    const padA = Math.round((VISIBLE_WINDOW - ROUND_SEC) * 0.25);
    const padB = VISIBLE_WINDOW - ROUND_SEC - padA;
    const from = roundTimesRef.current.roundStart - padB;
    const to = roundTimesRef.current.roundEnd + padA;

    try {
      chartRef.current.timeScale().setVisibleRange({ from: from as any, to: to as any });
      initExpiryRef.current = marketExpiry;
    } catch {
      // Chart series not yet populated — init() will set the range once data loads
    }
  }, [marketExpiry]);

  const tickSize = useChartToolbarStore((s) => s.tickSize);
  tickSizeRef.current = tickSize;
  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.timeScale().applyOptions({ barSpacing: tickSize });
    }
  }, [tickSize]);

  const drawingMode = useChartToolbarStore((s) => s.drawingMode);
  const clearDrawings = useChartToolbarStore((s) => s.clearDrawings);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);

  interface AnchoredLine { t1: number; p1: number; t2: number; p2: number }
  const anchoredLinesRef = useRef<AnchoredLine[]>([]);
  const drawStartRef = useRef<{ t: number; p: number; px: number; py: number } | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions({
      handleScroll: { mouseWheel: !drawingMode, pressedMouseMove: !drawingMode },
    });
  }, [drawingMode]);

  // Convert pixel position to chart time/price
  const pxToChart = useCallback((x: number, y: number) => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return null;
    const t = chart.timeScale().coordinateToTime(x);
    const p = series.coordinateToPrice(y);
    if (t === null || p === null) return null;
    return { t: t as number, p };
  }, []);

  // Convert chart time/price to pixel position
  const chartToPx = useCallback((t: number, p: number) => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return null;
    const x = chart.timeScale().timeToCoordinate(t as any);
    const y = series.priceToCoordinate(p);
    if (x === null || y === null) return null;
    return { x, y };
  }, []);

  const redrawLines = useCallback((tempPx?: { x1: number; y1: number; x2: number; y2: number } | null) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(238,238,238,0.7)';
    ctx.lineWidth = 2 * dpr;
    ctx.lineCap = 'round';
    for (const line of anchoredLinesRef.current) {
      const from = chartToPx(line.t1, line.p1);
      const to = chartToPx(line.t2, line.p2);
      if (!from || !to) continue;
      ctx.beginPath();
      ctx.moveTo(from.x * dpr, from.y * dpr);
      ctx.lineTo(to.x * dpr, to.y * dpr);
      ctx.stroke();
    }
    if (tempPx) {
      ctx.strokeStyle = 'rgba(238,238,238,0.5)';
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(tempPx.x1 * dpr, tempPx.y1 * dpr);
      ctx.lineTo(tempPx.x2 * dpr, tempPx.y2 * dpr);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [chartToPx]);

  // Resize canvas to match overlay
  useEffect(() => {
    const overlay = overlayClipRef.current;
    const canvas = drawCanvasRef.current;
    if (!overlay || !canvas) return;
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = overlay!.clientWidth * dpr;
      canvas!.height = overlay!.clientHeight * dpr;
      canvas!.style.width = overlay!.clientWidth + 'px';
      canvas!.style.height = overlay!.clientHeight + 'px';
      redrawLines();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(overlay);
    return () => ro.disconnect();
  }, [redrawLines]);

  // Continuously repaint lines so they track chart scroll, zoom, and Y-axis drags
  const drawRafRef = useRef<number>(0);
  useEffect(() => {
    let active = true;
    function loop() {
      if (!active) return;
      if (anchoredLinesRef.current.length > 0) redrawLines();
      drawRafRef.current = requestAnimationFrame(loop);
    }
    drawRafRef.current = requestAnimationFrame(loop);
    return () => { active = false; cancelAnimationFrame(drawRafRef.current); };
  }, [redrawLines]);

  // Clear all drawings when clearDrawings counter changes
  const lastClearRef = useRef(clearDrawings);
  useEffect(() => {
    if (clearDrawings !== lastClearRef.current) {
      lastClearRef.current = clearDrawings;
      anchoredLinesRef.current = [];
      redrawLines();
    }
  }, [clearDrawings, redrawLines]);

  // Mouse event handlers for drawing
  useEffect(() => {
    const canvas = drawCanvasRef.current;
    if (!canvas || !drawingMode) return;

    function getPos(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function onDown(e: MouseEvent) {
      if (e.button !== 0) return;
      const pos = getPos(e);
      const coord = pxToChart(pos.x, pos.y);
      if (!coord) return;
      drawStartRef.current = { t: coord.t, p: coord.p, px: pos.x, py: pos.y };
    }

    function onMove(e: MouseEvent) {
      if (!drawStartRef.current) return;
      const pos = getPos(e);
      redrawLines({ x1: drawStartRef.current.px, y1: drawStartRef.current.py, x2: pos.x, y2: pos.y });
    }

    function onUp(e: MouseEvent) {
      if (!drawStartRef.current) return;
      const pos = getPos(e);
      const dx = pos.x - drawStartRef.current.px;
      const dy = pos.y - drawStartRef.current.py;
      if (Math.sqrt(dx * dx + dy * dy) > 5) {
        const coord = pxToChart(pos.x, pos.y);
        if (coord) {
          anchoredLinesRef.current.push({
            t1: drawStartRef.current.t, p1: drawStartRef.current.p,
            t2: coord.t, p2: coord.p,
          });
        }
      }
      drawStartRef.current = null;
      redrawLines();
    }

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drawingMode, redrawLines, pxToChart]);

  const overlayBase: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    pointerEvents: 'none',
    display: 'none',
  };

  return (
    <div ref={wrapperRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      <div ref={chartContainerRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: TOOLBAR_CLEARANCE }} />
      <div
        ref={overlayClipRef}
        style={{
          position: 'absolute', top: 0, left: 0,
          right: PRICE_SCALE_WIDTH, bottom: TIME_SCALE_HEIGHT,
          overflow: 'hidden', pointerEvents: 'none',
        }}
      >
        <div ref={activeHighlightRef} style={{ ...overlayBase, background: 'rgba(255,255,255,0.025)', zIndex: 1 }} />
        <div ref={leftLineRef} style={{ ...overlayBase, width: 1, background: 'rgba(238,238,238,0.22)', zIndex: 4 }} />
        <div ref={rightLineRef} style={{ ...overlayBase, width: 1, background: 'rgba(238,238,238,0.22)', zIndex: 4 }} />
        <div ref={priceLineRef} style={{
          position: 'absolute', height: 0,
          borderTop: '2px dashed #ca5858',
          pointerEvents: 'none', display: 'none', zIndex: 3,
        }} />
        <canvas
          ref={drawCanvasRef}
          style={{
            position: 'absolute', top: 0, left: 0,
            width: '100%', height: '100%',
            pointerEvents: drawingMode ? 'auto' : 'none',
            cursor: drawingMode ? 'crosshair' : 'default',
            zIndex: 5,
          }}
        />
      </div>
    </div>
  );
}
