// ── Market Session System ──
// 5-minute rounds aligned to clock boundaries
export const ROUND_DURATION = 5 * 60; // 5 minutes in seconds

export function getCurrentRound() {
  const now = Math.floor(Date.now() / 1000);
  const roundStart = now - (now % ROUND_DURATION);
  const roundEnd = roundStart + ROUND_DURATION;
  return { roundStart, roundEnd, now };
}

export function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${h12}:${m}${ampm}`;
}

// Candle interval in seconds (8s candles = dense candles on screen)
export const CANDLE_INTERVAL = 8;

// Generate realistic BTC candlestick data.
// Creates 30s candles from 5 min before round start up to current time,
// PLUS flat placeholder candles from current time to roundEnd + 2 min.
// Placeholders extend the time axis so the round end boundary is always visible.
export function generateCandlestickData() {
  const { roundStart, roundEnd, now } = getCurrentRound();

  // Use candle-count padding so boundaries land on exact candle times.
  // 8 candles before round start, 12 candles after round end → active ≈ 65-70%
  const PRE_CANDLES = 8;
  const POST_CANDLES = 12;
  const dataStart = roundStart - PRE_CANDLES * CANDLE_INTERVAL;

  // Current candle slot (aligned to CANDLE_INTERVAL)
  const currentSlot = now - (now % CANDLE_INTERVAL);

  // Data extends POST_CANDLES past roundEnd
  const dataEnd = roundEnd + POST_CANDLES * CANDLE_INTERVAL;

  const data: { time: number; open: number; high: number; low: number; close: number }[] = [];
  let basePrice = 96800;
  let lastRealPrice = basePrice;

  const totalBars = Math.floor((dataEnd - dataStart) / CANDLE_INTERVAL) + 1;

  for (let i = 0; i < totalBars; i++) {
    const time = dataStart + i * CANDLE_INTERVAL;
    const isFuture = time > currentSlot;

    if (isFuture) {
      // Placeholder: flat candle at last real price (extends time axis)
      data.push({
        time,
        open: lastRealPrice,
        high: lastRealPrice,
        low: lastRealPrice,
        close: lastRealPrice,
      });
    } else {
      const elapsed = i / Math.max(totalBars, 1);

      let trend: number;
      if (elapsed < 0.15) trend = -0.3;
      else if (elapsed < 0.3) trend = 0.4;
      else if (elapsed < 0.5) trend = 0.7;
      else if (elapsed < 0.65) trend = -0.15;
      else if (elapsed < 0.8) trend = 0.9;
      else trend = 0.5;

      const volatility = 1.2 + Math.random() * 2.5;
      const change = (Math.random() - 0.45) * volatility + trend * 0.2;

      const open = basePrice;
      const close = open + change;
      const high = Math.max(open, close) + Math.random() * volatility * 0.3;
      const low = Math.min(open, close) - Math.random() * volatility * 0.3;

      data.push({
        time,
        open: Math.round(open * 100) / 100,
        high: Math.round(high * 100) / 100,
        low: Math.round(low * 100) / 100,
        close: Math.round(close * 100) / 100,
      });

      basePrice = close;
      lastRealPrice = Math.round(close * 100) / 100;
    }
  }

  // Index of the last real (non-placeholder) candle
  const lastRealIndex = data.findIndex(d => d.time > currentSlot) - 1;

  return { data, lastRealIndex };
}

