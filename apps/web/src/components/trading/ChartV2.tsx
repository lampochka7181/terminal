'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { 
  createChart, 
  IChartApi, 
  ISeriesApi, 
  CandlestickData, 
  Time, 
  IPriceLine,
  CrosshairMode,
  LineStyle,
} from 'lightweight-charts';
import { useMarketStore, useSelectedMarket } from '@/stores/marketStore';
import { useUserStore } from '@/stores/userStore';
import { useOrderbookStore } from '@/stores/orderbookStore';
import { cn } from '@/lib/utils';
import { getWebSocket } from '@/lib/websocket';
import { api } from '@/lib/api';
import { TrendingUp, MousePointer, Trash2 } from 'lucide-react';

// =============================================================================
// TYPES
// =============================================================================

interface TradeAnimation {
  id: string;
  walletPrefix: string;
  amount: number;
  outcome: 'yes' | 'no';
  side: 'buy' | 'sell';
  timestamp: number;
}

export interface UserPosition {
  id: string;
  outcome: 'yes' | 'no';
  shares: number;
  avgEntry: number;
  entryTime: number; // Unix timestamp in ms when trade happened
  entryBtcPrice: number; // BTC price when trade happened (for chart positioning)
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  costBasis: number; // Total $ invested
  currentValue: number; // Current $ value
}

interface ChartV2Props {
  onPositionClick?: (position: UserPosition) => void;
  strikePrice?: number;
  centerOnStrike?: boolean;
}

interface VerticalLinePosition {
  startX: number | null;
  expiryX: number | null;
}

interface TimeRange {
  from: number;
  to: number;
}

type DrawingTool = 'select' | 'trendline';

interface TrendLine {
  id: string;
  // Store as pixel percentages relative to chart for better persistence
  startX: number; // 0-1 percentage
  startY: number; // 0-1 percentage
  endX: number;
  endY: number;
  color: string;
}

// =============================================================================
// DRAWING TOOLBAR COMPONENT
// =============================================================================

function DrawingToolbar({
  activeTool,
  onToolChange,
  onClearAll,
  hasDrawings,
  priceScaleLocked,
  onResetView,
}: {
  activeTool: DrawingTool;
  onToolChange: (tool: DrawingTool) => void;
  onClearAll: () => void;
  hasDrawings: boolean;
  priceScaleLocked?: boolean;
  onResetView?: () => void;
}) {
  return (
    <div className="absolute top-14 left-3 flex flex-col gap-1 z-40 bg-background/90 backdrop-blur-sm rounded-lg p-1.5 border border-border shadow-lg">
      <button
        onClick={() => onToolChange('select')}
        className={cn(
          'p-2 rounded-md transition-colors',
          activeTool === 'select' 
            ? 'bg-long text-background' 
            : 'text-text-muted hover:text-text-primary hover:bg-surface-light'
        )}
        title="Select (Esc)"
      >
        <MousePointer className="w-4 h-4" />
      </button>
      <button
        onClick={() => onToolChange('trendline')}
        className={cn(
          'p-2 rounded-md transition-colors',
          activeTool === 'trendline' 
            ? 'bg-long text-background' 
            : 'text-text-muted hover:text-text-primary hover:bg-surface-light'
        )}
        title="Draw Line (L)"
      >
        <TrendingUp className="w-4 h-4" />
      </button>
      {/* Reset View button - shown when price scale is manually adjusted */}
      {priceScaleLocked && onResetView && (
        <>
          <div className="h-px bg-border my-0.5" />
          <button
            onClick={onResetView}
            className="p-2 rounded-md text-warning hover:bg-warning/20 transition-colors"
            title="Reset View (R)"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </>
      )}
      {hasDrawings && (
        <>
          <div className="h-px bg-border my-0.5" />
          <button
            onClick={onClearAll}
            className="p-2 rounded-md text-text-muted hover:text-short hover:bg-short/20 transition-colors"
            title="Clear All"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </>
      )}
    </div>
  );
}

// =============================================================================
// DRAWING CANVAS COMPONENT (Simplified - pixel-based)
// =============================================================================

function DrawingCanvas({
  activeTool,
  drawings,
  setDrawings,
  onToolChange,
}: {
  activeTool: DrawingTool;
  drawings: TrendLine[];
  setDrawings: React.Dispatch<React.SetStateAction<TrendLine[]>>;
  onToolChange: (tool: DrawingTool) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [currentPoint, setCurrentPoint] = useState<{ x: number; y: number } | null>(null);

  // Get normalized coordinates (0-1) from pixel position
  const getNormalizedCoords = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }, []);

  // Get pixel coordinates from normalized (0-1)
  const getPixelCoords = useCallback((normX: number, normY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    
    return { 
      x: normX * canvas.width, 
      y: normY * canvas.height 
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (activeTool !== 'trendline') return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const coords = getNormalizedCoords(e.clientX, e.clientY);
    if (!coords) return;

    setIsDrawing(true);
    setStartPoint(coords);
    setCurrentPoint(coords);
  }, [activeTool, getNormalizedCoords]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDrawing) return;
    
    const coords = getNormalizedCoords(e.clientX, e.clientY);
    if (coords) {
      setCurrentPoint(coords);
    }
  }, [isDrawing, getNormalizedCoords]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!isDrawing || !startPoint) return;
    
    const endCoords = getNormalizedCoords(e.clientX, e.clientY);
    if (!endCoords) {
      setIsDrawing(false);
      setStartPoint(null);
      setCurrentPoint(null);
      return;
    }

    // Only save if line has some length
    const dx = endCoords.x - startPoint.x;
    const dy = endCoords.y - startPoint.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    
    if (length > 0.01) { // Minimum 1% of canvas
      const newLine: TrendLine = {
        id: `line-${Date.now()}`,
        startX: startPoint.x,
        startY: startPoint.y,
        endX: endCoords.x,
        endY: endCoords.y,
        color: '#00d4ff',
      };
      setDrawings(prev => [...prev, newLine]);
    }
    
    setIsDrawing(false);
    setStartPoint(null);
    setCurrentPoint(null);
    onToolChange('select');
  }, [isDrawing, startPoint, getNormalizedCoords, setDrawings, onToolChange]);

  // Redraw canvas
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw saved lines
    drawings.forEach(line => {
      const start = getPixelCoords(line.startX, line.startY);
      const end = getPixelCoords(line.endX, line.endY);
      
      if (start && end) {
        // Line
        ctx.beginPath();
        ctx.strokeStyle = line.color;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        
        // Endpoints
        ctx.beginPath();
        ctx.fillStyle = line.color;
        ctx.arc(start.x, start.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(end.x, end.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    
    // Draw line being created
    if (isDrawing && startPoint && currentPoint) {
      const start = getPixelCoords(startPoint.x, startPoint.y);
      const end = getPixelCoords(currentPoint.x, currentPoint.y);
      
      if (start && end) {
        ctx.beginPath();
        ctx.strokeStyle = '#00a3ff';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.setLineDash([6, 4]);
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Start point
        ctx.beginPath();
        ctx.fillStyle = '#00a3ff';
        ctx.arc(start.x, start.y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [drawings, isDrawing, startPoint, currentPoint, getPixelCoords]);

  // Setup canvas size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const updateSize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      
      const rect = parent.getBoundingClientRect();
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
        redraw();
      }
    };
    
    updateSize();
    window.addEventListener('resize', updateSize);
    
    // Also redraw periodically to catch any size changes
    const interval = setInterval(updateSize, 500);
    
    return () => {
      window.removeEventListener('resize', updateSize);
      clearInterval(interval);
    };
  }, [redraw]);

  // Redraw when drawings change
  useEffect(() => {
    redraw();
  }, [redraw]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsDrawing(false);
        setStartPoint(null);
        setCurrentPoint(null);
        onToolChange('select');
      }
      if (e.key === 'l' || e.key === 'L') onToolChange('trendline');
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onToolChange]);

  return (
    <canvas
      ref={canvasRef}
      className={cn(
        "absolute inset-0",
        activeTool === 'trendline' ? 'cursor-crosshair z-[25]' : 'pointer-events-none z-[5]'
      )}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => {
        if (isDrawing) {
          setIsDrawing(false);
          setStartPoint(null);
          setCurrentPoint(null);
        }
      }}
    />
  );
}

// =============================================================================
// TRADE ANIMATION COMPONENT
// =============================================================================

function TradeAnimationItem({ trade, onComplete, startY }: { trade: TradeAnimation; onComplete: () => void; startY: number }) {
  const [currentY, setCurrentY] = useState(startY);
  const [opacity, setOpacity] = useState(0);

  useEffect(() => {
    // Fade in
    const fadeInTimer = setTimeout(() => setOpacity(1), 10);
    
    // Float upward animation - 5x faster
    const floatInterval = setInterval(() => {
      setCurrentY(prev => prev - 8); // Move up by 8px every frame
    }, 16); // ~60fps
    
    // Start fade out after 1.5 seconds (faster since moving faster)
    const fadeOutTimer = setTimeout(() => setOpacity(0), 1500);
    
    // Remove after fade out
    const removeTimer = setTimeout(onComplete, 1800);
    
    return () => {
      clearTimeout(fadeInTimer);
      clearInterval(floatInterval);
      clearTimeout(fadeOutTimer);
      clearTimeout(removeTimer);
    };
  }, [onComplete]);

  const isYes = trade.outcome === 'yes';

  return (
    <div
      className="absolute left-0 flex items-center gap-1.5 transition-opacity duration-200"
      style={{
        top: `${currentY}px`,
        opacity,
      }}
    >
      <span className="text-text-muted text-xs font-mono">{trade.walletPrefix}</span>
      <span className={cn(
        'text-xs font-bold',
        isYes ? 'text-long' : 'text-short'
      )}>
        +${trade.amount.toFixed(0)}
      </span>
      <span className={cn(
        'text-[10px] font-medium',
        isYes ? 'text-long/70' : 'text-short/70'
      )}>
        {isYes ? 'ABOVE' : 'BELOW'}
      </span>
    </div>
  );
}

function TradeAnimations({ marketAddress }: { marketAddress: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [trades, setTrades] = useState<TradeAnimation[]>([]);

  useEffect(() => {
    if (!marketAddress) return;
    
    const ws = getWebSocket();
    ws.connect().catch(() => {});
    ws.subscribeTrades(marketAddress);

    const unsubscribe = ws.onMessage((message: any) => {
      if (message?.channel !== 'trades') return;
      if (message?.market && message.market !== marketAddress) return;
      
      const data = message?.data;
      if (!data) return;

      const takerWallet = String(data.takerWallet || data.wallet || '');
      const walletPrefix = takerWallet ? takerWallet.slice(0, 4) : '????';
      const side = String(data.side || '').toLowerCase();
      const outcome = String(data.outcome || '').toLowerCase() as 'yes' | 'no';
      const size = Number(data.filledSize ?? data.size ?? 0);
      const price = Number(data.price ?? 0);
      const amount = size * price;

      if (amount <= 0) return;

      const newTrade: TradeAnimation = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        walletPrefix,
        amount,
        outcome: outcome === 'no' ? 'no' : 'yes',
        side: side === 'ask' || side === 'sell' ? 'sell' : 'buy',
        timestamp: Date.now(),
      };

      setTrades(prev => [newTrade, ...prev].slice(0, 15));
    });

    return () => {
      unsubscribe();
      ws.unsubscribeTrades(marketAddress);
    };
  }, [marketAddress]);

  const removeTrade = useCallback((id: string) => {
    setTrades(prev => prev.filter(t => t.id !== id));
  }, []);

  // Get container height for spawn position
  const containerHeight = containerRef.current?.clientHeight ?? 400;
  const spawnY = containerHeight - 50; // Start near bottom

  return (
    <div ref={containerRef} className="absolute left-3 top-12 bottom-12 w-48 overflow-hidden pointer-events-none z-20">
      {trades.map((trade) => (
        <TradeAnimationItem 
          key={trade.id} 
          trade={trade}
          startY={spawnY}
          onComplete={() => removeTrade(trade.id)} 
        />
      ))}
    </div>
  );
}

// =============================================================================
// POSITION MARKERS COMPONENT - Positioned at trade time/price on chart
// =============================================================================

function PositionMarkers({ 
  positions, 
  chart,
  series,
  candles,
  chartReady,
  marketExpired,
  chartHeight,
  onPositionClick,
}: { 
  positions: UserPosition[];
  chart: IChartApi | null;
  series: ISeriesApi<'Candlestick'> | null;
  candles: CandleData[];
  chartReady: boolean;
  marketExpired: boolean;
  chartHeight: number;
  onPositionClick?: (position: UserPosition) => void;
}) {
  const [updateTrigger, setUpdateTrigger] = useState(0);
  const isMountedRef = useRef(false);

  // Subscribe to chart time scale changes for smooth updates
  useEffect(() => {
    if (!chart || !chartReady) return;

    // Mark as mounted after first effect run
    isMountedRef.current = true;

    const timeScale = chart.timeScale();
    
    // Handler for visible range changes (pan/zoom)
    // Use setTimeout to defer updates and avoid setState during render
    const handler = () => {
      if (isMountedRef.current) {
        // Use requestAnimationFrame to batch updates and avoid render-phase setState
        requestAnimationFrame(() => {
          setUpdateTrigger(t => t + 1);
        });
      }
    };
    
    // Subscribe to visible range changes
    timeScale.subscribeVisibleLogicalRangeChange(handler);

    return () => {
      isMountedRef.current = false;
      // Use the proper unsubscribe method
      timeScale.unsubscribeVisibleLogicalRangeChange(handler);
    };
  }, [chart, chartReady]);

  // Calculate coordinates for each position
  const coords = useMemo(() => {
    if (!chart || !series || !chartReady || positions.length === 0 || candles.length === 0) {
      return new Map<string, { x: number; y: number; visible: boolean }>();
    }

    const timeScale = chart.timeScale();
    const newCoords = new Map<string, { x: number; y: number; visible: boolean }>();

    positions.forEach((position) => {
      // Get entry time in seconds
      let entryTimeSec = position.entryTime;
      if (entryTimeSec > 1000000000000) {
        entryTimeSec = Math.floor(entryTimeSec / 1000);
      }

      // Find the closest candle to the entry time
      let closestCandle = candles[candles.length - 1];
      let minDiff = Infinity;
      
      for (const candle of candles) {
        const diff = Math.abs(candle.time - entryTimeSec);
        if (diff < minDiff) {
          minDiff = diff;
          closestCandle = candle;
        }
      }

      // If entry time is invalid (0 or way off), use recent candle
      const lastCandleTime = candles[candles.length - 1]?.time ?? 0;
      const firstCandleTime = candles[0]?.time ?? 0;
      const isValidTime = entryTimeSec >= firstCandleTime - 60 && entryTimeSec <= lastCandleTime + 60;
      
      if (!isValidTime) {
        const recentIndex = Math.max(0, candles.length - 5);
        closestCandle = candles[recentIndex];
      }

      // Get X coordinate from candle time
      const x = timeScale.timeToCoordinate(closestCandle.time as Time);
      if (x === null) return;

      // Get Y coordinate from BTC price at entry
      const btcPrice = position.entryBtcPrice > 0 ? position.entryBtcPrice : closestCandle.close;
      
      // Convert BTC price to pixel coordinate first
      const baseY = series.priceToCoordinate(btcPrice);
      if (baseY === null) return;
      
      // Offset in pixels: ABOVE positions go up (negative), BELOW go down (positive)
      // Keep bubbles close to the chart action but not blocking candles
      const isYes = position.outcome === 'yes';
      const pixelOffset = isYes ? -45 : 45; // Fixed pixel offset from the entry price
      
      // Clamp Y to stay within visible chart area (leave margin for bubble height)
      const margin = 35; // Bubble half-height approx
      const clampedY = Math.max(margin, Math.min(chartHeight - margin - 50, baseY + pixelOffset));
      
      newCoords.set(position.id, { x, y: clampedY, visible: true });
    });

    return newCoords;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series, positions, chartReady, candles, updateTrigger, chartHeight]);

  // Don't show bubbles if market expired or no positions
  if (positions.length === 0 || marketExpired || !chartReady) return null;

  return (
    <>
      {positions.map((position) => {
        const coord = coords.get(position.id);
        if (!coord || !coord.visible) return null;

        const isProfit = position.pnl >= 0;
        const isYes = position.outcome === 'yes';
        
        return (
          <button
            key={position.id}
            onClick={() => onPositionClick?.(position)}
            className={cn(
              'absolute min-w-[60px] px-2.5 py-1.5 rounded-xl border-2 flex flex-col items-center justify-center font-mono font-bold cursor-pointer shadow-lg pointer-events-auto z-30 hover:scale-110 hover:shadow-xl',
              isProfit 
                ? 'bg-long/95 border-long text-black hover:bg-long' 
                : 'bg-short/95 border-short text-white hover:bg-short'
            )}
            style={{
              left: coord.x,
              top: coord.y,
              transform: 'translate(-50%, -50%)',
              willChange: 'left, top',
            }}
            title={`${isYes ? 'ABOVE' : 'BELOW'} | ${position.shares} contracts @ $${position.avgEntry.toFixed(2)}`}
          >
            <span className="text-[9px] font-black opacity-70 tracking-wide">
              {isYes ? 'ABOVE' : 'BELOW'}
            </span>
            <span className="text-sm font-black leading-tight">
              {isProfit ? '+' : '-'}${Math.abs(position.pnl).toFixed(2)}
            </span>
          </button>
        );
      })}
    </>
  );
}

// =============================================================================
// VERTICAL TIME LINES COMPONENT (anchored to chart coordinates)
// =============================================================================

function VerticalTimeLines({
  positions,
  marketStart,
  marketExpiry,
  secondsToExpiry,
  isFlashing,
}: {
  positions: VerticalLinePosition;
  marketStart: number | null;
  marketExpiry: number | null;
  secondsToExpiry: number | null;
  isFlashing: boolean;
}) {
  const { startX, expiryX } = positions;

  return (
    <>
      {/* Market Start Line */}
      {startX !== null && (
        <div
          className="absolute top-0 bottom-8 w-[2px] z-10 pointer-events-none"
          style={{ 
            left: `${startX}px`,
            background: 'linear-gradient(to bottom, #00a3ff 0%, #00a3ff 80%, transparent 100%)',
          }}
        >
          {/* Label */}
          <div className="absolute -top-0 left-1/2 -translate-x-1/2 whitespace-nowrap">
            <div className="bg-[#00a3ff] text-black text-[10px] font-bold px-2 py-0.5 rounded-b-md shadow-lg">
              MARKET START
            </div>
          </div>
        </div>
      )}

      {/* Market Expiry Line */}
      {expiryX !== null && (
        <div
          className={cn(
            "absolute top-0 bottom-8 w-[2px] z-10 pointer-events-none transition-colors",
            isFlashing ? "animate-pulse" : ""
          )}
          style={{ 
            left: `${expiryX}px`,
            background: isFlashing 
              ? 'linear-gradient(to bottom, #ff3d71 0%, #ff3d71 80%, transparent 100%)'
              : 'linear-gradient(to bottom, #ff3d71 0%, #ff3d71 80%, transparent 100%)',
          }}
        >
          {/* Label */}
          <div className="absolute -top-0 left-1/2 -translate-x-1/2 whitespace-nowrap">
            <div className={cn(
              "text-white text-[10px] font-bold px-2 py-0.5 rounded-b-md shadow-lg",
              isFlashing ? "bg-short animate-pulse" : "bg-short"
            )}>
              {secondsToExpiry !== null && secondsToExpiry > 0 
                ? `EXPIRY ${secondsToExpiry <= 60 ? `${secondsToExpiry}s` : `${Math.floor(secondsToExpiry / 60)}m ${secondsToExpiry % 60}s`}`
                : 'EXPIRY'}
            </div>
          </div>
        </div>
      )}

    </>
  );
}

// =============================================================================
// TIME SCALE NAVIGATOR (X-Axis Scrollbar)
// =============================================================================

function TimeScaleNavigator({
  chart,
  dataRange,
}: {
  chart: IChartApi | null;
  dataRange: TimeRange | null;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragType, setDragType] = useState<'pan' | 'left' | 'right' | null>(null);
  const [visibleRange, setVisibleRange] = useState<{ left: number; width: number }>({ left: 0, width: 100 });
  const dragStartRef = useRef<{ x: number; left: number; width: number } | null>(null);

  // Update visible range when chart changes
  useEffect(() => {
    if (!chart || !dataRange) return;

    const updateVisibleRange = () => {
      const timeScale = chart.timeScale();
      const visible = timeScale.getVisibleRange();
      if (!visible) return;

      const totalRange = dataRange.to - dataRange.from;
      if (totalRange <= 0) return;

      const visibleFrom = Number(visible.from);
      const visibleTo = Number(visible.to);

      const left = ((visibleFrom - dataRange.from) / totalRange) * 100;
      const width = ((visibleTo - visibleFrom) / totalRange) * 100;

      setVisibleRange({
        left: Math.max(0, Math.min(100, left)),
        width: Math.max(5, Math.min(100 - Math.max(0, left), width)),
      });
    };

    const timeScale = chart.timeScale();
    timeScale.subscribeVisibleTimeRangeChange(updateVisibleRange);
    updateVisibleRange();

    return () => {
      try {
        timeScale.unsubscribeVisibleTimeRangeChange(updateVisibleRange);
      } catch {}
    };
  }, [chart, dataRange]);

  const handleMouseDown = useCallback((e: React.MouseEvent, type: 'pan' | 'left' | 'right') => {
    e.preventDefault();
    setIsDragging(true);
    setDragType(type);
    dragStartRef.current = { x: e.clientX, left: visibleRange.left, width: visibleRange.width };
  }, [visibleRange]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !dragStartRef.current || !trackRef.current || !chart || !dataRange) return;

    const trackRect = trackRef.current.getBoundingClientRect();
    const deltaX = e.clientX - dragStartRef.current.x;
    const deltaPercent = (deltaX / trackRect.width) * 100;
    const totalRange = dataRange.to - dataRange.from;

    let newLeft = dragStartRef.current.left;
    let newWidth = dragStartRef.current.width;

    if (dragType === 'pan') {
      newLeft = Math.max(0, Math.min(100 - newWidth, dragStartRef.current.left + deltaPercent));
    } else if (dragType === 'left') {
      const maxDelta = dragStartRef.current.width - 5;
      const clampedDelta = Math.max(-dragStartRef.current.left, Math.min(maxDelta, deltaPercent));
      newLeft = dragStartRef.current.left + clampedDelta;
      newWidth = dragStartRef.current.width - clampedDelta;
    } else if (dragType === 'right') {
      const maxWidth = 100 - dragStartRef.current.left;
      newWidth = Math.max(5, Math.min(maxWidth, dragStartRef.current.width + deltaPercent));
    }

    // Apply to chart
    const newFrom = dataRange.from + (newLeft / 100) * totalRange;
    const newTo = dataRange.from + ((newLeft + newWidth) / 100) * totalRange;

    chart.timeScale().setVisibleRange({
      from: newFrom as Time,
      to: newTo as Time,
    });
  }, [isDragging, dragType, chart, dataRange]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragType(null);
    dragStartRef.current = null;
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    if (!trackRef.current || !chart || !dataRange) return;
    
    const trackRect = trackRef.current.getBoundingClientRect();
    const clickPercent = ((e.clientX - trackRect.left) / trackRect.width) * 100;
    const totalRange = dataRange.to - dataRange.from;
    
    // Center the visible range on the click position
    const newLeft = Math.max(0, Math.min(100 - visibleRange.width, clickPercent - visibleRange.width / 2));
    const newFrom = dataRange.from + (newLeft / 100) * totalRange;
    const newTo = dataRange.from + ((newLeft + visibleRange.width) / 100) * totalRange;

    chart.timeScale().setVisibleRange({
      from: newFrom as Time,
      to: newTo as Time,
    });
  }, [chart, dataRange, visibleRange.width]);

  return (
    <div className="h-8 px-4 flex items-center bg-black/50 border-t border-border">
      <div 
        ref={trackRef}
        className="relative w-full h-3 bg-border/30 rounded-full cursor-pointer"
        onClick={dataRange ? handleTrackClick : undefined}
      >
        {/* Track background pattern */}
        <div className="absolute inset-0 rounded-full overflow-hidden">
          <div className="w-full h-full" style={{
            background: 'repeating-linear-gradient(90deg, transparent, transparent 10%, rgba(255,255,255,0.02) 10%, rgba(255,255,255,0.02) 20%)'
          }} />
        </div>
        
        {dataRange ? (
          /* Visible range thumb */
          <div
            className={cn(
              "absolute top-0 h-full rounded-full transition-colors cursor-grab active:cursor-grabbing",
              isDragging ? "bg-long" : "bg-long/70 hover:bg-long"
            )}
            style={{
              left: `${visibleRange.left}%`,
              width: `${Math.max(visibleRange.width, 5)}%`,
              boxShadow: '0 0 8px rgba(0, 255, 163, 0.3)',
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
              handleMouseDown(e, 'pan');
            }}
          >
            {/* Left resize handle */}
            <div
              className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-long border-2 border-background rounded-full cursor-ew-resize hover:scale-125 transition-transform shadow-lg"
              onMouseDown={(e) => {
                e.stopPropagation();
                handleMouseDown(e, 'left');
              }}
            />
            {/* Right resize handle */}
            <div
              className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-4 h-4 bg-long border-2 border-background rounded-full cursor-ew-resize hover:scale-125 transition-transform shadow-lg"
              onMouseDown={(e) => {
                e.stopPropagation();
                handleMouseDown(e, 'right');
              }}
            />
          </div>
        ) : (
          /* Loading placeholder */
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] text-text-muted">Loading timeline...</span>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// MAIN CHART V2 COMPONENT
// =============================================================================

export function ChartV2({ onPositionClick, strikePrice: propStrikePrice, centerOnStrike = false }: ChartV2Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const strikeLineRef = useRef<IPriceLine | null>(null);
  const lastCandleRef = useRef<CandlestickData | null>(null);
  const prevCloseRef = useRef<number | null>(null);
  const hasUserAdjustedView = useRef(false);
  const isFirstLoad = useRef(true);
  
  const [now, setNow] = useState(Date.now());
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [linePositions, setLinePositions] = useState<VerticalLinePosition>({
    startX: null,
    expiryX: null,
  });
  const [dataRange, setDataRange] = useState<TimeRange | null>(null);
  const [activeTool, setActiveTool] = useState<DrawingTool>('select');
  const [drawings, setDrawings] = useState<TrendLine[]>([]);
  const [chartReady, setChartReady] = useState(false);
  const [chartCandles, setChartCandles] = useState<CandleData[]>([]);
  const [chartHeight, setChartHeight] = useState(600);
  
  const { selectedAsset, selectedTimeframe } = useMarketStore();
  const selectedMarket = useSelectedMarket();
  const positions = useUserStore((state) => state.positions);
  
  // Candle interval - 15 seconds for fast updates
  const candleIntervalSec = 15;

  // Calculate timing
  const marketExpiry = selectedMarket?.expiry ?? null;
  const marketStart = useMemo(() => {
    if (!marketExpiry || !selectedMarket?.timeframe) return null;
    const durations: Record<string, number> = {
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
    };
    const duration = durations[selectedMarket.timeframe] || 5 * 60 * 1000;
    return marketExpiry - duration;
  }, [marketExpiry, selectedMarket?.timeframe]);

  const secondsToExpiry = useMemo(() => {
    if (!marketExpiry) return null;
    return Math.max(0, Math.floor((marketExpiry - now) / 1000));
  }, [marketExpiry, now]);

  const isFlashing = secondsToExpiry !== null && secondsToExpiry <= 7 && secondsToExpiry > 0;
  // Use prop strike price if provided, otherwise use from selected market
  const strikePrice = propStrikePrice ?? selectedMarket?.strike ?? null;
  const marketAddress = selectedMarket?.address ?? null;

  // Update time every second
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Clear drawings and reset view tracking when asset changes
  useEffect(() => {
    setDrawings([]);
    setActiveTool('select');
    isFirstLoad.current = true;
    hasUserAdjustedView.current = false;
  }, [selectedAsset]);

  // ==========================================================================
  // FUNCTION TO UPDATE VERTICAL LINE POSITIONS
  // ==========================================================================
  const updateLinePositions = useCallback(() => {
    if (!chartRef.current || !containerRef.current) return;
    
    const timeScale = chartRef.current.timeScale();
    const chartWidth = containerRef.current.clientWidth;
    
    // Get the visible logical range to calculate pixels per second
    const visibleRange = timeScale.getVisibleLogicalRange();
    const visibleTimeRange = timeScale.getVisibleRange();
    
    let startX: number | null = null;
    let expiryX: number | null = null;
    
    // Helper function to get coordinate, with extrapolation for times outside data range
    const getTimeCoordinate = (timestampMs: number): number | null => {
      const timeSec = Math.floor(timestampMs / 1000);
      
      // First try the native method
      const coord = timeScale.timeToCoordinate(timeSec as Time);
      if (coord !== null) {
        return coord;
      }
      
      // If native method returns null, extrapolate based on visible range
      if (visibleTimeRange && visibleRange) {
        const rangeStartTime = Number(visibleTimeRange.from);
        const rangeEndTime = Number(visibleTimeRange.to);
        const timeSpan = rangeEndTime - rangeStartTime;
        
        if (timeSpan > 0) {
          // Get coordinates for the visible range edges
          const startCoord = timeScale.timeToCoordinate(visibleTimeRange.from);
          const endCoord = timeScale.timeToCoordinate(visibleTimeRange.to);
          
          if (startCoord !== null && endCoord !== null) {
            const pixelsPerSecond = (endCoord - startCoord) / timeSpan;
            
            // Extrapolate from the end of visible range
            const extrapolatedX = endCoord + (timeSec - rangeEndTime) * pixelsPerSecond;
            
            // Only return if within reasonable chart bounds (allow some overflow for visibility)
            if (extrapolatedX >= -50 && extrapolatedX <= chartWidth + 50) {
              return extrapolatedX;
            }
          }
        }
      }
      
      return null;
    };
    
    if (marketStart) {
      startX = getTimeCoordinate(marketStart);
    }
    
    if (marketExpiry) {
      expiryX = getTimeCoordinate(marketExpiry);
    }
    
    setLinePositions({ startX, expiryX });
  }, [marketStart, marketExpiry]);

  // ==========================================================================
  // CREATE CHART
  // ==========================================================================
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#060a10' },
        textColor: '#8b9eb3',
      },
      grid: {
        vertLines: { color: '#141d28' },
        horzLines: { color: '#141d28' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          visible: false,
          labelVisible: false,
        },
        horzLine: {
          visible: false,
          labelVisible: false,
        },
      },
      timeScale: {
        borderColor: '#1c2a3a',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 50,
        barSpacing: 8,
      },
      rightPriceScale: {
        borderColor: '#1c2a3a',
        autoScale: true,
        scaleMargins: { top: 0.1, bottom: 0.1 },
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

    const series = chart.addCandlestickSeries({
      upColor: '#00ff88',
      downColor: '#ff4757',
      borderUpColor: '#00ff88',
      borderDownColor: '#ff4757',
      wickUpColor: '#00ff88',
      wickDownColor: '#ff4757',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    chartRef.current = chart;
    seriesRef.current = series;
    setChartReady(true);

    // Track user interactions with the chart
    let interactionTimeout: NodeJS.Timeout | null = null;
    const markUserInteraction = () => {
      // Use a small delay to avoid marking initial programmatic changes
      if (interactionTimeout) clearTimeout(interactionTimeout);
      interactionTimeout = setTimeout(() => {
        hasUserAdjustedView.current = true;
      }, 100);
    };

    // Subscribe to time scale changes to update vertical lines
    const timeScale = chart.timeScale();
    timeScale.subscribeVisibleTimeRangeChange(() => {
      updateLinePositions();
      // Mark as user-adjusted after initial load
      if (!isFirstLoad.current) {
        markUserInteraction();
      }
    });

    // Also update on logical range change (zoom)
    timeScale.subscribeVisibleLogicalRangeChange(() => {
      updateLinePositions();
    });

    // Handle resize
    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
        setChartHeight(containerRef.current.clientHeight);
        updateLinePositions();
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      setChartReady(false);
    };
  }, [updateLinePositions]);

  // ==========================================================================
  // UPDATE LINES WHEN MARKET TIMES CHANGE OR TIME TICKS
  // ==========================================================================
  useEffect(() => {
    updateLinePositions();
  }, [updateLinePositions, now]);

  // ==========================================================================
  // LOAD INITIAL CANDLE DATA
  // ==========================================================================
  useEffect(() => {
    if (!seriesRef.current) return;
    
    const ac = new AbortController();
    setIsLoading(true);
    lastCandleRef.current = null;
    prevCloseRef.current = null;

    (async () => {
      try {
        const lookbackSec = 2 * 60 * 60; // 2 hours of history
        
        let res = await api.getCandles({
          asset: selectedAsset as any,
          intervalSec: candleIntervalSec,
          lookbackSec,
        });
        
        if (ac.signal.aborted) return;

        // Fallback to 60s candles if no data
        if ((!res.candles || res.candles.length === 0) && candleIntervalSec < 60) {
          res = await api.getCandles({
            asset: selectedAsset as any,
            intervalSec: 60,
            lookbackSec: 60 * 60,
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

        seriesRef.current?.setData(candles);
        
        // Store candles for position markers
        setChartCandles(candles.map(c => ({
          time: Number(c.time),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })));

        const first = candles[0];
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        
        if (last) {
          lastCandleRef.current = last;
          if (prev) prevCloseRef.current = prev.close;
        }

        // Set data range for navigator (extend into future for expiry)
        if (first && last) {
          const fromTime = Number(first.time);
          // Extend to include future market expiry or add 10% buffer
          const toTime = marketExpiry 
            ? Math.max(Number(last.time), Math.floor(marketExpiry / 1000)) + 60
            : Number(last.time) + (Number(last.time) - fromTime) * 0.1;
          setDataRange({ from: fromTime, to: toTime });
        }

        // Set visible range - only on first load or if user hasn't adjusted
        if (chartRef.current && candles.length > 0 && isFirstLoad.current) {
          const timeScale = chartRef.current.timeScale();
          
          // Show last 30 minutes of data
          const lastTime = Number(last.time);
          const thirtyMinutes = 30 * 60;
          
          timeScale.setVisibleRange({
            from: (lastTime - thirtyMinutes) as Time,
            to: lastTime as Time,
          });
          
          // Scroll right to create empty space on the right (positive = adds bars to the right)
          setTimeout(() => {
            timeScale.scrollToPosition(20, false);
          }, 50);
          
          isFirstLoad.current = false;
        }
        
        // Update line positions after data loads
        setTimeout(updateLinePositions, 50);
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        console.error('[ChartV2] Failed to load candles:', e);
      } finally {
        setIsLoading(false);
      }
    })();

    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAsset, selectedTimeframe, candleIntervalSec, updateLinePositions, marketExpiry, marketStart]);

  // ==========================================================================
  // WEBSOCKET PRICE UPDATES (using existing price feed)
  // ==========================================================================
  useEffect(() => {
    if (!seriesRef.current) return;
    
    const ws = getWebSocket();
    ws.connect().catch(() => {});
    ws.subscribePrices(['BTC', 'ETH', 'SOL']);

    const unsubscribe = ws.onMessage((message) => {
      if (message.channel !== 'prices') return;
      const data: any = message.data;
      if (!data || data.asset !== selectedAsset) return;

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

      setIsStreaming(true);
      // Update line positions as new candles come in
      updateLinePositions();
    });

    const unsubscribeDisconnect = ws.onDisconnect(() => setIsStreaming(false));

    return () => {
      unsubscribe();
      unsubscribeDisconnect();
    };
  }, [selectedAsset, candleIntervalSec, updateLinePositions]);

  // ==========================================================================
  // PRICE SCALE MANUAL ADJUSTMENT - Allow user to adjust Y-axis freely
  // ==========================================================================
  const [priceScaleLocked, setPriceScaleLocked] = useState(false);
  
  // Detect when user manually adjusts price scale (scroll or drag on price axis)
  useEffect(() => {
    if (!chartRef.current || !chartReady) return;
    
    const chart = chartRef.current;
    const chartElement = containerRef.current;
    if (!chartElement) return;
    
    let isDragging = false;
    const priceScaleWidth = 70; // Approximate width of price scale
    
    const isOnPriceScale = (e: MouseEvent | WheelEvent) => {
      const rect = chartElement.getBoundingClientRect();
      return e.clientX > rect.right - priceScaleWidth;
    };
    
    // When user scrolls on the price scale area (right side), lock the scale
    const handleWheel = (e: WheelEvent) => {
      if (isOnPriceScale(e)) {
        setPriceScaleLocked(true);
      }
    };
    
    // When user starts dragging on the price scale
    const handleMouseDown = (e: MouseEvent) => {
      if (isOnPriceScale(e)) {
        isDragging = true;
      }
    };
    
    // When user drags on the price scale, lock it
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        setPriceScaleLocked(true);
      }
    };
    
    const handleMouseUp = () => {
      isDragging = false;
    };
    
    chartElement.addEventListener('wheel', handleWheel);
    chartElement.addEventListener('mousedown', handleMouseDown);
    chartElement.addEventListener('mousemove', handleMouseMove);
    chartElement.addEventListener('mouseup', handleMouseUp);
    chartElement.addEventListener('mouseleave', handleMouseUp);
    
    return () => {
      chartElement.removeEventListener('wheel', handleWheel);
      chartElement.removeEventListener('mousedown', handleMouseDown);
      chartElement.removeEventListener('mousemove', handleMouseMove);
      chartElement.removeEventListener('mouseup', handleMouseUp);
      chartElement.removeEventListener('mouseleave', handleMouseUp);
    };
  }, [chartReady]);
  
  // Function to reset price scale to auto
  const resetPriceScale = useCallback(() => {
    if (!chartRef.current) return;
    const priceScale = chartRef.current.priceScale('right');
    priceScale.applyOptions({
      autoScale: true,
      scaleMargins: { top: 0.1, bottom: 0.1 },
    });
    setPriceScaleLocked(false);
  }, []);
  
  // Keyboard shortcut 'R' to reset view
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'r' || e.key === 'R') && priceScaleLocked) {
        resetPriceScale();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [priceScaleLocked, resetPriceScale]);

  // ==========================================================================
  // CENTER CHART ON STRIKE PRICE - Keep strike FIXED in middle (when not locked)
  // ==========================================================================
  useEffect(() => {
    // Skip if user has manually adjusted the price scale
    if (priceScaleLocked) return;
    if (!chartRef.current || !seriesRef.current || !strikePrice || strikePrice <= 0 || !centerOnStrike || !chartReady) return;
    
    const chart = chartRef.current;
    const series = seriesRef.current;
    const priceScale = chart.priceScale('right');
    
    // Function to update price range keeping strike in the middle
    const updatePriceRange = () => {
      // Don't update if user locked the scale
      if (priceScaleLocked) return;
      
      const lastCandle = lastCandleRef.current;
      if (!lastCandle) return;
      
      const currentPrice = lastCandle.close;
      
      // Calculate the distance from current price to strike
      const distanceFromStrike = Math.abs(currentPrice - strikePrice);
      
      // Add buffer (30% extra) to ensure price action is visible
      const range = Math.max(distanceFromStrike * 1.5, strikePrice * 0.005);
      
      // Set symmetric range around strike price
      const minPrice = strikePrice - range;
      const maxPrice = strikePrice + range;
      
      try {
        series.applyOptions({
          autoscaleInfoProvider: () => ({
            priceRange: {
              minValue: minPrice,
              maxValue: maxPrice,
            },
          }),
        });
        
        priceScale.applyOptions({
          autoScale: true,
          scaleMargins: { top: 0, bottom: 0 },
        });
      } catch (e) {
        console.warn('Failed to center on strike:', e);
      }
    };
    
    // Run initially
    updatePriceRange();
    
    // Update on interval to keep centered as price moves
    const interval = setInterval(updatePriceRange, 500);
    
    return () => {
      clearInterval(interval);
    };
  }, [strikePrice, centerOnStrike, chartReady, priceScaleLocked]);

  // ==========================================================================
  // STRIKE PRICE LINE (horizontal, stays fixed at price level)
  // ==========================================================================
  useEffect(() => {
    if (!seriesRef.current) return;

    // Remove old strike line
    if (strikeLineRef.current) {
      try {
        seriesRef.current.removePriceLine(strikeLineRef.current);
      } catch {}
      strikeLineRef.current = null;
    }

    if (!strikePrice || strikePrice <= 0) return;

    // Create strike price line - this stays fixed at the price level
    strikeLineRef.current = seriesRef.current.createPriceLine({
      price: strikePrice,
      color: '#ffb800',
      lineWidth: 3,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: `★ STRIKE $${strikePrice.toLocaleString()}`,
    });
  }, [strikePrice]);

  // ==========================================================================
  // USER POSITIONS - Use orderbook prices for real-time tick-by-tick updates
  // ==========================================================================
  // Get real-time prices from orderbook store (updates on every tick)
  const yesBestBid = useOrderbookStore(state => state.yes.bestBid);
  const yesBestAsk = useOrderbookStore(state => state.yes.bestAsk);
  
  // Use SAME price logic as desktop-view.tsx for consistency with Positions modal
  // yesPrice = best ask (what you pay to buy YES)
  // noPrice = 1 - best bid (what you pay to buy NO)
  const yesPrice = (yesBestAsk && yesBestAsk > 0.01 && yesBestAsk < 0.99) 
    ? yesBestAsk 
    : (selectedMarket?.yesPrice ?? 0.5);
  const noPrice = (yesBestBid && yesBestBid > 0.01 && yesBestBid < 0.99)
    ? 1 - yesBestBid
    : (selectedMarket?.noPrice ?? 0.5);
  
  // Helper to find BTC price at a given timestamp from candles
  const getBtcPriceAtTime = useCallback((timestamp: number): number => {
    if (chartCandles.length === 0) return 0;
    
    // Convert to seconds if needed
    let timeSec = timestamp;
    if (timeSec > 1000000000000) {
      timeSec = Math.floor(timeSec / 1000);
    }
    
    // Find closest candle
    let closest = chartCandles[chartCandles.length - 1];
    let minDiff = Infinity;
    
    for (const candle of chartCandles) {
      const diff = Math.abs(candle.time - timeSec);
      if (diff < minDiff) {
        minDiff = diff;
        closest = candle;
      }
    }
    
    return closest?.close ?? 0;
  }, [chartCandles]);
  
  const userPositions = useMemo(() => {
    if (!marketAddress || !positions) return [];
    
    return positions
      .filter(p => p.marketAddress === marketAddress && (p.yesShares > 0 || p.noShares > 0))
      .flatMap(p => {
        const result: UserPosition[] = [];
        const entryTime = p.createdAt ?? 0;
        const entryBtcPrice = getBtcPriceAtTime(entryTime);
        
        if (p.yesShares > 0) {
          const avgEntry = p.avgEntryPrice ?? 0.5;
          const costBasis = avgEntry * p.yesShares;
          const currentValue = yesPrice * p.yesShares;
          const pnl = currentValue - costBasis;
          const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
          
          result.push({
            id: `${p.marketAddress}-yes`,
            outcome: 'yes',
            shares: p.yesShares,
            avgEntry,
            entryTime,
            entryBtcPrice,
            currentPrice: yesPrice,
            pnl,
            pnlPercent,
            costBasis,
            currentValue,
          });
        }
        
        if (p.noShares > 0) {
          const avgEntry = p.avgEntryPrice ?? 0.5;
          const costBasis = avgEntry * p.noShares;
          const currentValue = noPrice * p.noShares;
          const pnl = currentValue - costBasis;
          const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
          
          result.push({
            id: `${p.marketAddress}-no`,
            outcome: 'no',
            shares: p.noShares,
            avgEntry,
            entryTime,
            entryBtcPrice,
            currentPrice: noPrice,
            pnl,
            pnlPercent,
            costBasis,
            currentValue,
          });
        }
        
        return result;
      });
  }, [positions, marketAddress, yesPrice, noPrice, selectedMarket?.yesPrice, selectedMarket?.noPrice, getBtcPriceAtTime]);

  return (
    <div 
      className={cn(
        "relative w-full h-full bg-surface rounded-xl border border-border overflow-hidden transition-all duration-150 flex flex-col isolate",
        isFlashing && "ring-4 ring-short animate-expiry-glow"
      )}
      style={{ contain: 'paint' }}
    >
      {/* Chart Area */}
      <div className="relative flex-1 min-h-0">
        {/* Chart Container */}
        <div ref={containerRef} className="absolute inset-0" />

        {/* Drawing Canvas (overlay for user drawings) */}
        <DrawingCanvas
          activeTool={activeTool}
          drawings={drawings}
          setDrawings={setDrawings}
          onToolChange={setActiveTool}
        />

        {/* VERTICAL TIME LINES (anchored to chart coordinates) */}
        <VerticalTimeLines
          positions={linePositions}
          marketStart={marketStart}
          marketExpiry={marketExpiry}
          secondsToExpiry={secondsToExpiry}
          isFlashing={isFlashing}
        />

        {/* Drawing Toolbar */}
        <DrawingToolbar
          activeTool={activeTool}
          onToolChange={setActiveTool}
          onClearAll={() => setDrawings([])}
          hasDrawings={drawings.length > 0}
          priceScaleLocked={priceScaleLocked}
          onResetView={resetPriceScale}
        />

        {/* RED FLASH OVERLAY */}
        {isFlashing && (
          <div className="absolute inset-0 pointer-events-none z-30 animate-urgent-flash" />
        )}

        {/* Trade Animations (Left Side) */}
        <TradeAnimations marketAddress={marketAddress} />

        {/* Position Markers - shows $ amount bubbles for open positions */}
        <PositionMarkers
          positions={userPositions}
          chart={chartRef.current}
          series={seriesRef.current}
          candles={chartCandles}
          chartReady={chartReady}
          marketExpired={secondsToExpiry !== null && secondsToExpiry <= 0}
          chartHeight={chartHeight}
          onPositionClick={onPositionClick}
        />

        {/* Expiry Countdown Badge (when close to expiry) */}
        {isFlashing && secondsToExpiry !== null && secondsToExpiry > 0 && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-40 pointer-events-none">
            <div className="bg-short text-white text-4xl font-black font-mono px-6 py-4 rounded-2xl animate-pulse shadow-2xl shadow-short/50 border-2 border-white/20">
              {secondsToExpiry}
            </div>
          </div>
        )}

        {/* Loading Overlay */}
        {isLoading && (
          <div className="absolute inset-0 bg-surface/80 flex items-center justify-center z-20">
            <div className="text-text-muted text-sm">Loading chart...</div>
          </div>
        )}

        {/* Live Indicator */}
        <div className="absolute bottom-3 left-3 flex items-center gap-2 text-[10px] text-text-muted uppercase tracking-widest font-bold z-20">
          <span className="text-text-muted/50">Coinbase</span>
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
      </div>

      {/* X-Axis Time Scale Navigator */}
      <TimeScaleNavigator chart={chartRef.current} dataRange={dataRange} />
    </div>
  );
}
