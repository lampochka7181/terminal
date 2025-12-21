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
function generateStrikeLine(strike: number, data: CandlestickData[]): LineData[] {
  return data.map(candle => ({
    time: candle.time,
    value: strike,
  }));
}

export function Chart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const strikeLineRef = useRef<ISeriesApi<'Line'> | null>(null);
  
  const { selectedAsset, selectedTimeframe } = useMarketStore();
  const { prices } = usePriceStore();
  
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [priceChange, setPriceChange] = useState<number>(0);
  const [strike, setStrike] = useState<number>(0);

  // Base prices for mock data
  const basePrices: Record<string, number> = {
    BTC: 95000,
    ETH: 3200,
    SOL: 140,
  };

  useEffect(() => {
    if (!containerRef.current) return;

    // Create chart
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#12121a' },
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
    });
    candleSeriesRef.current = candleSeries;

    // Add strike price line
    const strikeLine = chart.addLineSeries({
      color: '#ffaa00',
      lineWidth: 2,
      lineStyle: 2, // Dashed
      crosshairMarkerVisible: false,
      priceLineVisible: false,
    });
    strikeLineRef.current = strikeLine;

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
    if (!candleSeriesRef.current || !strikeLineRef.current) return;

    const basePrice = basePrices[selectedAsset] || 95000;
    const mockData = generateMockData(basePrice);
    const strikePrice = basePrice; // Strike is typically ATM
    
    candleSeriesRef.current.setData(mockData);
    strikeLineRef.current.setData(generateStrikeLine(strikePrice, mockData));
    
    // Set current price from last candle
    const lastCandle = mockData[mockData.length - 1];
    setCurrentPrice(lastCandle.close);
    setPriceChange(((lastCandle.close - lastCandle.open) / lastCandle.open) * 100);
    setStrike(strikePrice);

    // Fit content
    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  }, [selectedAsset, selectedTimeframe]);

  // Simulate real-time updates
  useEffect(() => {
    const interval = setInterval(() => {
      if (!candleSeriesRef.current) return;

      const basePrice = prices[selectedAsset] || basePrices[selectedAsset];
      const volatility = basePrice * 0.0001;
      const change = (Math.random() - 0.5) * volatility * 2;
      const newPrice = basePrice + change;

      // Update last candle
      const now = Math.floor(Date.now() / 1000) as Time;
      candleSeriesRef.current.update({
        time: now,
        open: basePrice,
        high: Math.max(basePrice, newPrice),
        low: Math.min(basePrice, newPrice),
        close: newPrice,
      });

      setCurrentPrice(newPrice);
      setPriceChange(change / basePrice * 100);
    }, 1000);

    return () => clearInterval(interval);
  }, [selectedAsset, prices]);

  const isAboveStrike = currentPrice > strike;

  return (
    <div className="bg-surface rounded-lg border border-border p-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold">{selectedAsset}/USD</h2>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xl text-text-primary" suppressHydrationWarning>
              ${currentPrice.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
            </span>
            <span className={cn(
              'text-sm font-mono',
              priceChange >= 0 ? 'text-long' : 'text-short'
            )} suppressHydrationWarning>
              {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(3)}%
            </span>
          </div>
        </div>
        
        <div className="flex items-center gap-6 text-sm">
          <div>
            <span className="text-text-muted">Strike: </span>
            <span className="font-mono text-warning" suppressHydrationWarning>
              ${strike.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-text-muted">Status: </span>
            <span className={cn(
              'px-2 py-0.5 rounded text-xs font-medium',
              isAboveStrike 
                ? 'bg-long/20 text-long' 
                : 'bg-short/20 text-short'
            )}>
              {isAboveStrike ? 'ABOVE' : 'BELOW'} STRIKE
            </span>
          </div>
        </div>
      </div>

      {/* Chart Container */}
      <div 
        ref={containerRef} 
        className="flex-1 min-h-0"
      />

      {/* Legend */}
      <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
        <div className="flex items-center gap-1">
          <div className="w-3 h-0.5 bg-warning" />
          <span>Strike Price</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-long rounded-sm" />
          <span>Bullish</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-short rounded-sm" />
          <span>Bearish</span>
        </div>
      </div>
    </div>
  );
}
