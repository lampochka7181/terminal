'use client';

import { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, LineData, Time } from 'lightweight-charts';
import { useMarketStore } from '@/stores/marketStore';
import { usePriceStore } from '@/stores/priceStore';
import { cn } from '@/lib/utils';

// Generate mock candlestick data
function generateMockData(basePrice: number, numCandles: number = 100): CandlestickData[] {
  const data: CandlestickData[] = [];
  let currentPrice = basePrice;
  const now = Math.floor(Date.now() / 1000);
  const interval = 60; // 1 minute candles
  
  for (let i = numCandles; i >= 0; i--) {
    const time = (now - i * interval) as Time;
    const volatility = basePrice * 0.001; // 0.1% volatility per candle
    
    const open = currentPrice;
    const change = (Math.random() - 0.5) * volatility * 2;
    const close = open + change;
    const high = Math.max(open, close) + Math.random() * volatility;
    const low = Math.min(open, close) - Math.random() * volatility;
    
    data.push({ time, open, high, low, close });
    currentPrice = close;
  }
  
  return data;
}

// Generate strike line data
export function Chart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  
  const { selectedAsset, selectedTimeframe } = useMarketStore();
  const { prices } = usePriceStore();
  
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [priceChange, setPriceChange] = useState<number>(0);

  // Initial prices if real prices aren't loaded yet
  const basePrices: Record<string, number> = {
    BTC: 88700,
    ETH: 2200,
    SOL: 180,
  };

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
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: '#2a2a3a',
        autoScale: true,
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

  // Update data when asset changes
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // Use current price if available, otherwise fallback to base
    const startPrice = prices[selectedAsset] || basePrices[selectedAsset] || 88000;
    const mockData = generateMockData(startPrice);
    
    candleSeriesRef.current.setData(mockData);
    
    // Set current price from last candle
    const lastCandle = mockData[mockData.length - 1];
    setCurrentPrice(lastCandle.close);
    setPriceChange(((lastCandle.close - lastCandle.open) / lastCandle.open) * 100);

    // Fit content
    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  }, [selectedAsset, selectedTimeframe]);

  // Simulate real-time updates
  useEffect(() => {
    const interval = setInterval(() => {
      if (!candleSeriesRef.current) return;

      const livePrice = prices[selectedAsset];
      if (!livePrice) return;

      const volatility = livePrice * 0.0001;
      const change = (Math.random() - 0.5) * volatility * 2;
      const newPrice = livePrice + change;

      // Update last candle
      const now = Math.floor(Date.now() / 1000) as Time;
      candleSeriesRef.current.update({
        time: now,
        open: livePrice,
        high: Math.max(livePrice, newPrice),
        low: Math.min(livePrice, newPrice),
        close: newPrice,
      });

      setCurrentPrice(newPrice);
      setPriceChange(change / livePrice * 100);
    }, 1000);

    return () => clearInterval(interval);
  }, [selectedAsset, prices]);

  return (
    <div className="bg-surface rounded-xl border border-border p-4 h-full flex flex-col shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-6">
          <div className="flex flex-col">
            <h2 className="text-xl font-bold terminal-text">{selectedAsset}/USD</h2>
            <span className="text-[10px] text-text-muted uppercase tracking-widest font-bold">Real-time TradingView</span>
          </div>
          <div className="h-10 w-px bg-border/50" />
          <div className="flex flex-col">
            <div className="flex items-center gap-3">
              <span className="font-mono text-2xl font-black text-text-primary tracking-tighter" suppressHydrationWarning>
                ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <div className={cn(
                'px-2 py-0.5 rounded text-[10px] font-black flex items-center gap-1',
                priceChange >= 0 ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
              )} suppressHydrationWarning>
                {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(3)}%
              </div>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-light rounded-lg border border-border/50">
            <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Live</span>
          </div>
        </div>
      </div>

      {/* Chart Container */}
      <div 
        ref={containerRef} 
        className="flex-1 min-h-0 rounded-lg overflow-hidden"
      />

      {/* Legend */}
      <div className="flex items-center gap-6 mt-4 text-[10px] text-text-muted uppercase tracking-widest font-bold">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 bg-long rounded-sm shadow-[0_0_8px_rgba(0,255,136,0.4)]" />
          <span>Bullish</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 bg-short rounded-sm shadow-[0_0_8px_rgba(255,51,102,0.4)]" />
          <span>Bearish</span>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <span className="text-text-muted/50">Source: Binance</span>
        </div>
      </div>
    </div>
  );
}
