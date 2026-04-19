/**
 * Token-bucket rate limiter.
 * Refills at `ratePerSec` tokens/sec, max burst = ratePerSec.
 * `acquire()` resolves when a token is available.
 */
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms
  private lastRefill: number;

  constructor(ratePerSec: number) {
    this.maxTokens = ratePerSec;
    this.tokens = ratePerSec;
    this.refillRate = ratePerSec / 1000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait until a token is available
    const deficit = 1 - this.tokens;
    const waitMs = Math.ceil(deficit / this.refillRate);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens -= 1;
  }
}
