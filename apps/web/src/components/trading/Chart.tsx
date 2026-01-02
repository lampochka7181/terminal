'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time, IPriceLine } from 'lightweight-charts';
import { useMarketStore, useSelectedMarket } from '@/stores/marketStore';
import { useChartSettingsStore, CANDLE_INTERVALS, ColorScheme } from '@/stores/chartSettingsStore';
import { cn } from '@/lib/utils';
import { getWebSocket } from '@/lib/websocket';
import { api } from '@/lib/api';
import { 
  Settings2, 
  CandlestickChart, 
  LineChart, 
  AreaChart,
  Grid3X3,
  Crosshair,
  Target,
  RotateCcw,
  Maximize2
} from 'lucide-react';

function productIdForAsset(asset: string): string {
  switch (asset) {
    case 'BTC':
      return 'BTC-USD';
    case 'ETH':
      return 'ETH-USD';
    case 'SOL':
      return 'SOL-USD';
    default:
      return 'BTC-USD';
  }
}

function getVisibleBarsForInterval(interval: number): number {
  // More candles for faster intervals
  if (interval <= 10) return 30;
  if (interval <= 30) return 25;
  return 20;
}
export function Chart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | ISeriesApi<'Area'> | null>(null);
  const strikeLineRef = useRef<IPriceLine | null>(null);
  const lastCandleRef = useRef<CandlestickData | null>(null);
  const prevCloseRef = useRef<number | null>(null);
  const lastTickAtRef = useRef<number>(0);
  const userInteractingRef = useRef<boolean>(false);
  const interactionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [chartReady, setChartReady] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  
  const { selectedAsset, selectedTimeframe } = useMarketStore();
  const selectedMarket = useSelectedMarket();
  
  // Chart settings from store
  const {
    chartType,
    candleInterval,
    showGrid,
    showCrosshair,
    showStrikeLine,
    colorScheme,
    upColor,
    downColor,
    autoScale,
    setChartType,
    setCandleInterval,
    setColorScheme,
    toggleGrid,
    toggleCrosshair,
    toggleStrikeLine,
    toggleAutoScale,
    resetToDefaults,
  } = useChartSettingsStore();
  
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [priceChange, setPriceChange] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [moneyToasts, setMoneyToasts] = useState<Array<{
    id: string;
    text: string;
    positive: boolean;
    x: number;
    y: number;
  }>>([]);

  const productId = useMemo(() => productIdForAsset(selectedAsset), [selectedAsset]);
  // Use candle interval from settings
  const candleIntervalSec = candleInterval;
  const visibleBars = useMemo(() => getVisibleBarsForInterval(candleInterval), [candleInterval]);
  const strikePrice = selectedMarket?.strike;
  const marketAddress = selectedMarket?.address;
  
  // Track user interaction to prevent auto-scroll hijacking
  const handleUserInteraction = useCallback(() => {
    userInteractingRef.current = true;
    // Clear any existing timeout
    if (interactionTimeoutRef.current) {
      clearTimeout(interactionTimeoutRef.current);
    }
    // Reset after 10 seconds of no interaction - user can scroll back manually
    interactionTimeoutRef.current = setTimeout(() => {
      userInteractingRef.current = false;
    }, 10000);
  }, []);

  // Create chart - only recreate when chart TYPE changes (not display options)
  useEffect(() => {
    if (!containerRef.current) return;

    // Create chart with base settings
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#0B0B0E' },
        textColor: '#8888aa',
      },
      grid: {
        vertLines: { color: '#1a1a25' },
        horzLines: { color: '#1a1a25' },
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: '#00ff88',
          width: 1,
          style: 2,
          labelBackgroundColor: '#00ff88',
        },
        horzLine: {
          color: '#00ff88',
          width: 1,
          style: 2,
          labelBackgroundColor: '#00ff88',
        },
      },
      timeScale: {
        borderColor: '#2a2a3a',
        timeVisible: true,
        secondsVisible: true,
        minBarSpacing: 1,
        lockVisibleTimeRangeOnResize: false,
        rightBarStaysOnScroll: false,
      },
      rightPriceScale: {
        borderColor: '#2a2a3a',
        autoScale: true,
        scaleMargins: {
          top: 0.2,
          bottom: 0.2,
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
        axisDoubleClickReset: true,
      },
    });

    chartRef.current = chart;

    // Track user interactions to prevent auto-scroll hijacking
    const container = containerRef.current;
    container.addEventListener('mousedown', handleUserInteraction);
    container.addEventListener('wheel', handleUserInteraction);
    container.addEventListener('touchstart', handleUserInteraction);

    // Add series based on chart type
    let series: ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | ISeriesApi<'Area'>;
    
    if (chartType === 'candlestick') {
      series = chart.addCandlestickSeries({
        upColor: '#00ff88',
        downColor: '#ff3366',
        borderUpColor: '#00ff88',
        borderDownColor: '#ff3366',
        wickUpColor: '#00ff88',
        wickDownColor: '#ff3366',
        priceScaleId: 'right',
        priceFormat: {
          type: 'price',
          precision: 2,
          minMove: 0.01,
        },
      });
    } else if (chartType === 'line') {
      series = chart.addLineSeries({
        color: '#00ff88',
        lineWidth: 2,
        priceScaleId: 'right',
        priceFormat: {
          type: 'price',
          precision: 2,
          minMove: 0.01,
        },
      });
    } else {
      series = chart.addAreaSeries({
        topColor: '#00ff8840',
        bottomColor: '#00ff8805',
        lineColor: '#00ff88',
        lineWidth: 2,
        priceScaleId: 'right',
        priceFormat: {
          type: 'price',
          precision: 2,
          minMove: 0.01,
        },
      });
    }
    
    seriesRef.current = series;
    setChartReady(true);

    // Handle resize
    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    return () => {
      setChartReady(false);
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('mousedown', handleUserInteraction);
      container.removeEventListener('wheel', handleUserInteraction);
      container.removeEventListener('touchstart', handleUserInteraction);
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
      }
      chart.remove();
    };
  }, [handleUserInteraction, chartType]);

  // Apply display options dynamically WITHOUT recreating the chart
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    // Update grid
    chart.applyOptions({
      grid: {
        vertLines: { color: showGrid ? '#1a1a25' : 'transparent' },
        horzLines: { color: showGrid ? '#1a1a25' : 'transparent' },
      },
    });

    // Update crosshair
    chart.applyOptions({
      crosshair: showCrosshair ? {
        mode: 1,
        vertLine: {
          color: upColor,
          width: 1,
          style: 2,
          labelBackgroundColor: upColor,
          visible: true,
        },
        horzLine: {
          color: upColor,
          width: 1,
          style: 2,
          labelBackgroundColor: upColor,
          visible: true,
        },
      } : {
        mode: 0,
        vertLine: { visible: false },
        horzLine: { visible: false },
      },
    });

    // Update price scale
    chart.applyOptions({
      rightPriceScale: {
        autoScale: autoScale,
      },
    });

    // Update series colors
    if (chartType === 'candlestick') {
      (series as ISeriesApi<'Candlestick'>).applyOptions({
        upColor,
        downColor,
        borderUpColor: upColor,
        borderDownColor: downColor,
        wickUpColor: upColor,
        wickDownColor: downColor,
      });
    } else if (chartType === 'line') {
      (series as ISeriesApi<'Line'>).applyOptions({
        color: upColor,
      });
    } else {
      (series as ISeriesApi<'Area'>).applyOptions({
        topColor: `${upColor}40`,
        bottomColor: `${upColor}05`,
        lineColor: upColor,
      });
    }
  }, [showGrid, showCrosshair, upColor, downColor, autoScale, chartType]);

  // Load candle data - for sub-minute intervals, we build from live ticks after initial load
  useEffect(() => {
    if (!chartReady || !seriesRef.current) return;
    const ac = new AbortController();
    setIsLoading(true);
    setError(null);
    setIsStreaming(false);
    lastCandleRef.current = null;
    prevCloseRef.current = null;
    lastTickAtRef.current = 0;
    userInteractingRef.current = false; // Reset on timeframe change

    (async () => {
      try {
        // Fetch enough history to fill the visible area + buffer
        // For faster candles, we need more seconds of history
        const candlesNeeded = visibleBars * 2; // Extra buffer
        const lookbackSec = Math.max(candlesNeeded * candleIntervalSec, 60 * 60); // At least 1 hour
        
        console.log(`[Chart] Fetching candles: asset=${selectedAsset}, interval=${candleIntervalSec}s, lookback=${lookbackSec}s`);
        
        let res = await api.getCandles({
          asset: selectedAsset as any,
          intervalSec: candleIntervalSec,
          lookbackSec,
        });
        if (ac.signal.aborted) return;

        // If we got no candles with small interval, try falling back to 60s
        if ((!res.candles || res.candles.length === 0) && candleIntervalSec < 60) {
          console.log(`[Chart] No candles at ${candleIntervalSec}s interval, falling back to 60s`);
          res = await api.getCandles({
            asset: selectedAsset as any,
            intervalSec: 60,
            lookbackSec: 60 * 60, // 1 hour
          });
        }
        if (ac.signal.aborted) return;

        const candles = (res.candles || []).map((c) => ({
          time: c.time as Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })) as CandlestickData[];
        
        console.log(`[Chart] Loaded ${candles.length} candles`);

        // Set data based on chart type
        if (chartType === 'candlestick') {
          (seriesRef.current as ISeriesApi<'Candlestick'>)?.setData(candles);
        } else {
          // For line/area, convert to simple price data
          const lineData = candles.map(c => ({ time: c.time, value: c.close }));
          (seriesRef.current as ISeriesApi<'Line'> | ISeriesApi<'Area'>)?.setData(lineData);
        }

        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        if (last) {
          setCurrentPrice(last.close);
          lastCandleRef.current = last;
          if (prev && prev.close > 0) {
            prevCloseRef.current = prev.close;
            setPriceChange(((last.close - prev.close) / prev.close) * 100);
          } else {
            prevCloseRef.current = null;
            setPriceChange(0);
          }
        } else {
          setCurrentPrice(0);
          setPriceChange(0);
        }

        // Set initial view with dynamic visible bars
        const chart = chartRef.current;
        if (chart && candles.length > 0) {
          const timeScale = chart.timeScale();
          const lastIdx = candles.length - 1;
          const from = Math.max(0, lastIdx - visibleBars + 1);
          
          // Apply time scale options - tighter spacing for faster candles
          const barSpacing = selectedTimeframe === '5m' ? 12 : selectedTimeframe === '1h' ? 15 : 18;
          timeScale.applyOptions({
            rightOffset: 5, // Less padding on right
            barSpacing,
            minBarSpacing: 1, // Allow very tight zoom
          });
          timeScale.setVisibleLogicalRange({ from, to: lastIdx + 5 });
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        console.error('[Chart] Failed to load candles:', e);
        setError(e?.message || 'Failed to load chart');
      } finally {
        setIsLoading(false);
      }
    })();

    return () => ac.abort();
  }, [chartReady, productId, selectedAsset, selectedTimeframe, candleIntervalSec, visibleBars, chartType]);

  // Tick-by-tick updates via backend WebSocket (same feed used by the rest of the app).
  // Backend sources these prices from Coinbase and broadcasts `price_update` at ~10Hz max.
  useEffect(() => {
    if (!seriesRef.current) return;
    const ws = getWebSocket();
    // Ensure connection exists (idempotent)
    ws.connect().catch(() => {});
    ws.subscribePrices(['BTC', 'ETH', 'SOL']);

    const unsubscribe = ws.onMessage((message) => {
      if (message.channel !== 'prices') return;
      const data: any = message.data;
      if (!data) return;

      // Snapshot format: { BTC: { price, timestamp }, ... }
      if (!data.asset) return;

      if (data.asset !== selectedAsset) return;

      const price = Number(data.price);
      const ts = Number(data.timestamp) || Date.now();
      if (!Number.isFinite(price)) return;

      const epochSec = Math.floor(ts / 1000);
      const bucket = Math.floor(epochSec / candleIntervalSec) * candleIntervalSec;

      const series = seriesRef.current;
      if (!series) return;

      const last = lastCandleRef.current;
      const isNewCandle = !last || Number(last.time) !== bucket;
      
      if (isNewCandle) {
        if (last) prevCloseRef.current = last.close;
        const open = prevCloseRef.current ?? price;
        const next: CandlestickData = {
          time: bucket as Time,
          open,
          high: Math.max(open, price),
          low: Math.min(open, price),
          close: price,
        };
        
        // Update based on chart type
        if (chartType === 'candlestick') {
          (series as ISeriesApi<'Candlestick'>).update(next);
        } else {
          (series as ISeriesApi<'Line'> | ISeriesApi<'Area'>).update({ time: next.time, value: next.close });
        }
        lastCandleRef.current = next;
      } else {
        const updated: CandlestickData = {
          time: last.time,
          open: last.open,
          high: Math.max(last.high, price),
          low: Math.min(last.low, price),
          close: price,
        };
        
        // Update based on chart type
        if (chartType === 'candlestick') {
          (series as ISeriesApi<'Candlestick'>).update(updated);
        } else {
          (series as ISeriesApi<'Line'> | ISeriesApi<'Area'>).update({ time: updated.time, value: updated.close });
        }
        lastCandleRef.current = updated;
      }

      lastTickAtRef.current = Date.now();
      setIsStreaming(true);
      setCurrentPrice(price);
      if (prevCloseRef.current != null && prevCloseRef.current > 0) {
        setPriceChange(((price - prevCloseRef.current) / prevCloseRef.current) * 100);
      }

      // ONLY auto-scroll if user is NOT interacting with the chart
      // This prevents the annoying "snap back" when exploring history
      const chart = chartRef.current;
      if (chart && !userInteractingRef.current) {
        chart.timeScale().scrollToRealTime();
      }
    });

    const unsubscribeDisconnect = ws.onDisconnect(() => setIsStreaming(false));

    return () => {
      unsubscribe();
      unsubscribeDisconnect();
      // IMPORTANT: don't call ws.unsubscribePrices() here; it's global/shared across the app.
    };
  }, [selectedAsset, candleIntervalSec, chartType]);

  // If we haven't received a tick in a bit, show "not streaming"
  useEffect(() => {
    const timer = setInterval(() => {
      if (!lastTickAtRef.current) return;
      if (Date.now() - lastTickAtRef.current > 5000) {
        setIsStreaming(false);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Animate fills (user buys/sells YES/NO) as a short pulse overlay on the chart.
  useEffect(() => {
    const ws = getWebSocket();
    ws.connect().catch(() => {});

    // Subscribe to public trades for this market so we can animate *everyone's* executions.
    if (marketAddress) {
      ws.subscribeTrades(marketAddress);
    }

    const unsub = ws.onMessage((message: any) => {
      if (message?.channel !== 'trades') return;
      if (marketAddress && message?.market && message.market !== marketAddress) return;
      const data = message?.data;
      if (!data) return;

      const chart = chartRef.current;
      const series = seriesRef.current;
      const lastCandle = lastCandleRef.current;
      if (!chart || !series || !lastCandle) return;

      const side = String((data as any).side);
      const outcome = String((data as any).outcome || '').toLowerCase(); // 'yes' | 'no'
      const filledSize = Number((data as any).filledSize ?? (data as any).size);
      const price = Number((data as any).price);
      const takerWallet = String((data as any).takerWallet || '');
      const x = chart.timeScale().timeToCoordinate(lastCandle.time);
      // IMPORTANT: trades are contract prices (~0.01-0.99) but the chart is BTC/USD.
      // Anchor animations to the latest candle's BTC price so they appear in the visible middle area.
      const yRaw = series.priceToCoordinate(lastCandle.close);

      if (x != null && yRaw != null && Number.isFinite(filledSize) && filledSize > 0 && Number.isFinite(price) && price > 0) {
        const isBuy = side === 'buy' || side === 'BID' || side === 'bid';
        // Per request: +$... for buys, -$... for sells
        const positive = isBuy;
        const dollars = filledSize * price;
        const walletPrefix = takerWallet ? takerWallet.slice(0, 4) : '????';
        const direction = outcome === 'yes' ? 'above' : outcome === 'no' ? 'below' : 'unknown';
        const sign = isBuy ? '+' : '-';
        const text = `${walletPrefix} ${sign} $${dollars.toFixed(0)} ${direction} strike`;
        const toastId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        
        // Clamp toast to stay within the chart area
        const bounds = overlayRef.current?.getBoundingClientRect();
        const pad = 24;
        const cx = bounds ? Math.max(pad, Math.min(bounds.width - pad, x)) : x;
        // Keep it roughly around the middle band so it doesn't hug bottom/top.
        const minBand = bounds ? bounds.height * 0.25 : pad;
        const maxBand = bounds ? bounds.height * 0.75 : 99999;
        const cyUnclamped = bounds ? Math.max(pad, Math.min(bounds.height - pad, yRaw)) : yRaw;
        const cy = bounds ? Math.max(minBand, Math.min(maxBand, cyUnclamped)) : cyUnclamped;

        setMoneyToasts((prev) => [...prev, { id: toastId, text, positive, x: cx, y: cy }]);
        window.setTimeout(() => {
          setMoneyToasts((prev) => prev.filter((t) => t.id !== toastId));
        }, 2200);
      }
    });

    return () => {
      unsub();
      if (marketAddress) {
        ws.unsubscribeTrades(marketAddress);
      }
    };
  }, [marketAddress]);

  // Strike price line (updates with market selection or chart type change)
  useEffect(() => {
    if (!seriesRef.current || !chartReady) return;

    // Clean up old strike line if it exists
    if (strikeLineRef.current) {
      try {
        seriesRef.current.removePriceLine(strikeLineRef.current);
      } catch {
        // Series might have changed, ignore error
      }
      strikeLineRef.current = null;
    }

    if (!showStrikeLine || typeof strikePrice !== 'number' || !Number.isFinite(strikePrice)) return;

    strikeLineRef.current = seriesRef.current.createPriceLine({
      price: strikePrice,
      color: '#f5a524',
      lineWidth: 2,
      lineStyle: 2, // dashed
      axisLabelVisible: true,
      title: `Strike ${strikePrice.toFixed(2)}`,
    });
  }, [strikePrice, showStrikeLine, chartReady, chartType]);

  // Reset view handler
  const handleResetView = useCallback(() => {
    const chart = chartRef.current;
    if (chart) {
      chart.timeScale().resetTimeScale();
      chart.timeScale().scrollToRealTime();
    }
  }, []);

  // Fit content handler
  const handleFitContent = useCallback(() => {
    const chart = chartRef.current;
    if (chart) {
      chart.timeScale().fitContent();
    }
  }, []);

  return (
    <div className="bg-surface rounded-xl border border-border p-4 h-full flex flex-col shadow-2xl">
      {/* Chart Toolbar */}
      <div className="flex items-center justify-between mb-3 pb-3 border-b border-border/50">
        {/* Left: Chart Type & Interval */}
        <div className="flex items-center gap-2">
          {/* Chart Type Selector */}
          <div className="flex items-center bg-surface-light rounded-lg p-0.5">
            <button
              onClick={() => setChartType('candlestick')}
              className={cn(
                'p-1.5 rounded-md transition-all',
                chartType === 'candlestick' ? 'bg-accent text-background' : 'text-text-muted hover:text-text-primary'
              )}
              title="Candlestick"
            >
              <CandlestickChart className="w-4 h-4" />
            </button>
            <button
              onClick={() => setChartType('line')}
              className={cn(
                'p-1.5 rounded-md transition-all',
                chartType === 'line' ? 'bg-accent text-background' : 'text-text-muted hover:text-text-primary'
              )}
              title="Line"
            >
              <LineChart className="w-4 h-4" />
            </button>
            <button
              onClick={() => setChartType('area')}
              className={cn(
                'p-1.5 rounded-md transition-all',
                chartType === 'area' ? 'bg-accent text-background' : 'text-text-muted hover:text-text-primary'
              )}
              title="Area"
            >
              <AreaChart className="w-4 h-4" />
            </button>
          </div>

          {/* Candle Interval Selector */}
          <div className="flex items-center bg-surface-light rounded-lg p-0.5">
            {CANDLE_INTERVALS.map((interval) => (
              <button
                key={interval.value}
                onClick={() => setCandleInterval(interval.value)}
                className={cn(
                  'px-2 py-1 text-xs font-bold rounded-md transition-all',
                  candleInterval === interval.value 
                    ? 'bg-accent text-background' 
                    : 'text-text-muted hover:text-text-primary'
                )}
              >
                {interval.label}
              </button>
            ))}
          </div>
        </div>

        {/* Right: Display Options & Settings */}
        <div className="flex items-center gap-2">
          {/* Quick Toggle Buttons */}
          <div className="flex items-center bg-surface-light rounded-lg p-0.5">
            <button
              onClick={toggleGrid}
              className={cn(
                'p-1.5 rounded-md transition-all',
                showGrid ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary'
              )}
              title="Toggle Grid"
            >
              <Grid3X3 className="w-4 h-4" />
            </button>
            <button
              onClick={toggleCrosshair}
              className={cn(
                'p-1.5 rounded-md transition-all',
                showCrosshair ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary'
              )}
              title="Toggle Crosshair"
            >
              <Crosshair className="w-4 h-4" />
            </button>
            <button
              onClick={toggleStrikeLine}
              className={cn(
                'p-1.5 rounded-md transition-all',
                showStrikeLine ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary'
              )}
              title="Toggle Strike Line"
            >
              <Target className="w-4 h-4" />
            </button>
          </div>

          {/* View Controls */}
          <div className="flex items-center bg-surface-light rounded-lg p-0.5">
            <button
              onClick={handleFitContent}
              className="p-1.5 rounded-md text-text-muted hover:text-text-primary transition-all"
              title="Fit Content"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleResetView}
              className="p-1.5 rounded-md text-text-muted hover:text-text-primary transition-all"
              title="Reset View"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>

          {/* Settings Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={cn(
                'p-1.5 rounded-lg transition-all',
                showSettings ? 'bg-accent text-background' : 'bg-surface-light text-text-muted hover:text-text-primary'
              )}
              title="Chart Settings"
            >
              <Settings2 className="w-4 h-4" />
            </button>

            {/* Settings Dropdown Panel */}
            {showSettings && (
              <div className="absolute right-0 top-full mt-2 w-64 bg-surface border border-border rounded-xl shadow-xl z-50 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-sm">Chart Settings</h4>
                  <button
                    onClick={() => setShowSettings(false)}
                    className="text-text-muted hover:text-text-primary"
                  >
                    ×
                  </button>
                </div>

                {/* Color Scheme */}
                <div>
                  <label className="text-xs text-text-muted mb-2 block">Color Scheme</label>
                  <div className="flex gap-2">
                    {(['classic', 'monochrome', 'colorblind'] as ColorScheme[]).map((scheme) => (
                      <button
                        key={scheme}
                        onClick={() => setColorScheme(scheme)}
                        className={cn(
                          'flex-1 px-2 py-1.5 text-xs rounded-lg capitalize transition-all',
                          colorScheme === scheme
                            ? 'bg-accent text-background'
                            : 'bg-surface-light text-text-muted hover:text-text-primary'
                        )}
                      >
                        {scheme}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Auto Scale Toggle */}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-text-primary">Auto Scale</span>
                  <button
                    onClick={toggleAutoScale}
                    className={cn(
                      'relative w-10 h-5 rounded-full transition-colors',
                      autoScale ? 'bg-accent' : 'bg-surface-light'
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 w-4 h-4 rounded-full bg-background transition-transform',
                        autoScale ? 'left-5' : 'left-0.5'
                      )}
                    />
                  </button>
                </div>

                {/* Reset Button */}
                <button
                  onClick={() => {
                    resetToDefaults();
                    setShowSettings(false);
                  }}
                  className="w-full px-3 py-2 text-xs font-bold bg-surface-light hover:bg-short/20 text-text-muted hover:text-short rounded-lg transition-all"
                >
                  Reset to Defaults
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Chart Container */}
      <div className="relative flex-1 min-h-0 rounded-lg overflow-hidden">
        <div
          ref={containerRef}
          className="absolute inset-0"
        />
        <div ref={overlayRef} className="absolute inset-0 pointer-events-none z-10">
          {/* Toasts near the execution / latest candle */}
          {moneyToasts.map((t, idx) => (
            <div
              key={t.id}
              className={cn(
                'absolute px-3 py-2 rounded-lg text-base font-black bg-black/60 border transition-all duration-700 ease-out animate-fade-up',
                t.positive ? 'text-long border-long/40' : 'text-short border-short/40'
              )}
              style={{
                left: t.x,
                top: t.y - idx * 26,
                transform: 'translate(-50%, -50%)',
              }}
            >
              {t.text}
            </div>
          ))}
        </div>

        {/* Loading Overlay */}
        {isLoading && (
          <div className="absolute inset-0 bg-surface/80 flex items-center justify-center z-20">
            <div className="text-text-muted text-sm">Loading chart...</div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between text-[10px] text-text-muted uppercase tracking-widest font-bold">
        <div className="flex items-center gap-3">
          <span className="text-text-muted/50">Source: Coinbase</span>
          <span className={cn(
            'flex items-center gap-1',
            isStreaming ? 'text-long' : 'text-text-muted/50'
          )}>
            <span className={cn(
              'w-1.5 h-1.5 rounded-full',
              isStreaming ? 'bg-long animate-pulse' : 'bg-text-muted/30'
            )} />
            {isStreaming ? 'LIVE' : 'CONNECTING'}
          </span>
        </div>
        {error && <span className="text-short">{error}</span>}
      </div>
    </div>
  );
}
