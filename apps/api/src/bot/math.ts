/**
 * Pure math functions for the probability-based market maker.
 *
 * Core formula: P(YES) = Φ(d₂)
 *   d₂ = ln(S/K) / (σ√T)
 *
 * Where:
 *   S = current asset price
 *   K = strike price
 *   σ = annualized volatility (estimated via EWMA)
 *   T = time to expiry in years
 *   Φ = standard normal cumulative distribution function
 */

/**
 * Standard normal CDF (Φ) — Abramowitz & Stegun approximation.
 * Maximum error: 7.5e-8.
 *
 * @param x  Standard normal variate
 * @returns  P(Z ≤ x) where Z ~ N(0,1)
 */
export function normalCDF(x: number): number {
  if (x > 8) return 1;
  if (x < -8) return 0;

  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);

  const t = 1 / (1 + 0.2316419 * z);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;

  const poly =
    0.319381530 * t -
    0.356563782 * t2 +
    1.781477937 * t3 -
    1.821255978 * t4 +
    1.330274429 * t5;

  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * poly;

  return sign === 1 ? cdf : 1 - cdf;
}

/**
 * Black-Scholes d₂ for a binary outcome.
 *
 * d₂ = ln(S/K) / (σ√T)
 *
 * Drift μ is omitted (negligible over 5-minute windows).
 *
 * @param spot    Current asset price (S)
 * @param strike  Strike price (K)
 * @param sigma   Annualized volatility
 * @param tYears  Time to expiry in years
 * @returns       d₂ value (input to Φ for probability)
 */
export function d2(spot: number, strike: number, sigma: number, tYears: number): number {
  if (tYears <= 0 || sigma <= 0 || strike <= 0 || spot <= 0) {
    // At expiry or invalid inputs: return large positive/negative
    return spot >= strike ? 8 : -8;
  }

  return Math.log(spot / strike) / (sigma * Math.sqrt(tYears));
}

/**
 * Fair value of YES token = P(price > strike at expiry).
 *
 * @param spot    Current asset price
 * @param strike  Strike price
 * @param sigma   Annualized volatility
 * @param tYears  Time to expiry in years
 * @returns       Probability in [0, 1]
 */
export function fairValue(spot: number, strike: number, sigma: number, tYears: number): number {
  return normalCDF(d2(spot, strike, sigma, tYears));
}

/**
 * EWMA variance update.
 *
 *   σ²_new = λ × σ²_old + (1 - λ) × r²
 *
 * @param prevVariance  Previous EWMA variance
 * @param logReturn     Log return: ln(P_new / P_old)
 * @param lambda        Decay factor (0.94 = RiskMetrics standard)
 * @returns             Updated variance
 */
export function ewmaVarianceUpdate(
  prevVariance: number,
  logReturn: number,
  lambda: number,
): number {
  return lambda * prevVariance + (1 - lambda) * logReturn * logReturn;
}

/**
 * Convert per-tick EWMA variance to annualized volatility.
 *
 *   σ_annual = √(variance × ticksPerYear)
 *   ticksPerYear = msPerYear / tickIntervalMs
 *
 * @param ewmaVariance    Per-tick EWMA variance
 * @param tickIntervalMs  Average time between ticks in milliseconds
 * @returns               Annualized volatility (σ)
 */
export function annualizeVol(ewmaVariance: number, tickIntervalMs: number): number {
  if (tickIntervalMs <= 0 || ewmaVariance <= 0) return 0;

  const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;
  const ticksPerYear = MS_PER_YEAR / tickIntervalMs;

  return Math.sqrt(ewmaVariance * ticksPerYear);
}

/**
 * Seed EWMA variance from a target annualized volatility.
 * Used on first tick when no history exists.
 *
 * @param targetVol       Desired annualized volatility (e.g., 0.50)
 * @param tickIntervalMs  Expected average tick interval in ms
 * @returns               Per-tick variance that yields targetVol when annualized
 */
export function seedVariance(targetVol: number, tickIntervalMs: number): number {
  if (tickIntervalMs <= 0) return 0;

  const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;
  const ticksPerYear = MS_PER_YEAR / tickIntervalMs;

  return (targetVol * targetVol) / ticksPerYear;
}

/**
 * Clamp a value to [min, max].
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Round to 2 decimal places (cents).
 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
