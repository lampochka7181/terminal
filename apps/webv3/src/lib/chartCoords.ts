/**
 * Shared chart coordinate mapper — written by chart components,
 * read by TradeBubbles overlay.
 *
 * The chart's rAF loop updates `current` AND calls `onFrame` so that
 * TradeBubbles positions in the exact same animation frame — zero lag.
 */

export interface ChartCoordMapper {
  /** Map epoch seconds → x pixel (relative to chart container). Returns null if off-screen. */
  timeToX: (timeSec: number) => number | null;
  /** Map asset price → y pixel (relative to chart container). Returns null if off-screen. */
  priceToY: (price: number) => number | null;
}

/** Mutable ref — updated by active chart component on every frame */
export const chartCoordsRef: {
  current: ChartCoordMapper | null;
  /** Called by chart's rAF after writing `current`. TradeBubbles sets this. */
  onFrame: (() => void) | null;
} = { current: null, onFrame: null };
