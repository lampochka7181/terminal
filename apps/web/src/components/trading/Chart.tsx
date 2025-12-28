'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time, IPriceLine } from 'lightweight-charts';
import { useMarketStore, useSelectedMarket } from '@/stores/marketStore';
import { cn } from '@/lib/utils';
import { getWebSocket } from '@/lib/websocket';
import { api } from '@/lib/api';

function productIdForAsset(asset: string): string {
  // Coinbase Exchange product ids
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

function defaultVisibleBarsForTimeframe(tf: string): number {
  // Tuned for readability: show a "screenful" of candles by default.
  switch (tf) {
    case '5m':
      return 10; // ~50 minutes (very zoomed-in)
    case '1h':
      return 60; // 2.5d
    case '24h':
      return 30; // 30d
    default:
      return 24;
  }
}
export function Chart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const strikeLineRef = useRef<IPriceLine | null>(null);
  const lastCandleRef = useRef<CandlestickData | null>(null);
  const prevCloseRef = useRef<number | null>(null);
  const lastTickAtRef = useRef<number>(0);
  
  const { selectedAsset, selectedTimeframe } = useMarketStore();
  const selectedMarket = useSelectedMarket();
  
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
  // 1-minute candlesticks
  const candleIntervalSec = 60;
  const strikePrice = selectedMarket?.strike;
  const marketAddress = selectedMarket?.address;

  useEffect(() => {
    if (!containerRef.current) return;

    // Create chart
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
      },
      rightPriceScale: {
        borderColor: '#2a2a3a',
        autoScale: true,
        // Add vertical padding so the latest candle isn't pinned to the top/bottom.
        scaleMargins: {
          top: 0.22,
          bottom: 0.18,
        },
      },
    });

    chartRef.current = chart;

    // Add candlestick series
    const candleSeries = chart.addCandlestickSeries({
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
    candleSeriesRef.current = candleSeries;

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
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  // For sub-minute candles we build purely from live ticks (Coinbase REST candles min granularity is 60s).
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    const ac = new AbortController();
    setIsLoading(true);
    setError(null);
    setIsStreaming(false);
    lastCandleRef.current = null;
    prevCloseRef.current = null;
    lastTickAtRef.current = 0;

    (async () => {
      try {
        // For 1m candles, fetch a bit more history (1h for 5m markets, 2h otherwise)
        const lookbackSec = selectedTimeframe === '5m' ? 60 * 60 : 2 * 60 * 60;
        const res = await api.getCandles({
          asset: selectedAsset as any,
          intervalSec: candleIntervalSec,
          lookbackSec,
        });
        if (ac.signal.aborted) return;

        const candles = (res.candles || []).map((c) => ({
          time: c.time as Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })) as CandlestickData[];

        candleSeriesRef.current?.setData(candles);

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

        // Default zoom: show only a handful of candles (user wants ~5-10 visible)
        const chart = chartRef.current;
        if (chart && candles.length > 0) {
          const timeScale = chart.timeScale();
          const visibleBars = 10;
          const lastIdx = candles.length - 1;
          const from = Math.max(0, lastIdx - visibleBars + 1);
          timeScale.applyOptions({
            // Give some room to the right so the latest candle isn't jammed into the corner.
            rightOffset: 10,
            barSpacing: 22,
            minBarSpacing: 4,
          });
          timeScale.setVisibleLogicalRange({ from, to: lastIdx + 1 + 10 });
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
  }, [productId, selectedTimeframe]);

  // Tick-by-tick updates via backend WebSocket (same feed used by the rest of the app).
  // Backend sources these prices from Coinbase and broadcasts `price_update` at ~10Hz max.
  useEffect(() => {
    if (!candleSeriesRef.current) return;
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

      const series = candleSeriesRef.current;
      if (!series) return;

      const last = lastCandleRef.current;
      if (!last || Number(last.time) !== bucket) {
        if (last) prevCloseRef.current = last.close;
        const open = prevCloseRef.current ?? price;
        const next: CandlestickData = {
          time: bucket as Time,
          open,
          high: Math.max(open, price),
          low: Math.min(open, price),
          close: price,
        };
        series.update(next);
        lastCandleRef.current = next;
      } else {
        const updated: CandlestickData = {
          time: last.time,
          open: last.open,
          high: Math.max(last.high, price),
          low: Math.min(last.low, price),
          close: price,
        };
        series.update(updated);
        lastCandleRef.current = updated;
      }

      lastTickAtRef.current = Date.now();
      setIsStreaming(true);
      setCurrentPrice(price);
      if (prevCloseRef.current != null && prevCloseRef.current > 0) {
        setPriceChange(((price - prevCloseRef.current) / prevCloseRef.current) * 100);
      }

      // Keep the chart near real-time with right padding.
      const chart = chartRef.current;
      if (chart) {
        chart.timeScale().scrollToRealTime();
      }
    });

    const unsubscribeDisconnect = ws.onDisconnect(() => setIsStreaming(false));

    return () => {
      unsubscribe();
      unsubscribeDisconnect();
      // IMPORTANT: don't call ws.unsubscribePrices() here; it's global/shared across the app.
    };
  }, [selectedAsset, candleIntervalSec]);

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
      const series = candleSeriesRef.current;
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

  // Strike price line (updates with market selection)
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    if (strikeLineRef.current) {
      candleSeriesRef.current.removePriceLine(strikeLineRef.current);
      strikeLineRef.current = null;
    }

    if (typeof strikePrice !== 'number' || !Number.isFinite(strikePrice)) return;

    strikeLineRef.current = candleSeriesRef.current.createPriceLine({
      price: strikePrice,
      color: '#f5a524',
      lineWidth: 2,
      lineStyle: 2, // dashed
      axisLabelVisible: true,
      title: `Strike ${strikePrice.toFixed(2)}`,
    });
  }, [strikePrice]);

  return (
    <div className="bg-surface rounded-xl border border-border p-4 h-full flex flex-col shadow-2xl">
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
                // Color indicates direction (buy/sell), and text includes yes/no
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
      </div>

      {/* Footer */}
      <div className="mt-4 flex items-center justify-between text-[10px] text-text-muted uppercase tracking-widest font-bold">
        <span className="text-text-muted/50">Source: Coinbase</span>
        {error && <span className="text-short">{error}</span>}
      </div>
    </div>
  );
}
