// ── Timeframe utilities ──

/** Convert a timeframe string to its duration in seconds */
export function timeframeSec(tf?: string): number {
  switch (tf) {
    case '1m': return 60;
    case '5m': return 5 * 60;
    case '15m': return 15 * 60;
    case '1h': return 60 * 60;
    case '4h': return 4 * 60 * 60;
    case '24h': return 24 * 60 * 60;
    default: return 5 * 60;
  }
}

/** Visible window (seconds) for a given timeframe — controls chart zoom */
export function visibleWindowSec(tf?: string): number {
  switch (tf) {
    case '1m': return 120;   // 2 minutes visible for a 1-minute round
    case '5m': return 500;   // existing 500s for 5-minute rounds
    case '15m': return 1500;
    case '1h': return 5400;
    default: return 500;
  }
}

/** Get the current round boundaries for a given timeframe */
export function getCurrentRound(tf?: string) {
  const duration = timeframeSec(tf);
  const now = Math.floor(Date.now() / 1000);
  const roundStart = now - (now % duration);
  const roundEnd = roundStart + duration;
  return { roundStart, roundEnd, now };
}

/** Format unix timestamp to 12-hour time string (e.g. "12:05pm") */
export function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${h12}:${m}${ampm}`;
}
