/**
 * Circuit Breaker & Self-Healing Module
 * 
 * Detects cascade failures and automatically recovers by:
 * 1. Shedding load (returning 503) when pool is exhausted
 * 2. Pausing non-critical operations during recovery
 * 3. Gradually restoring normal operation
 * 
 * States:
 * - CLOSED: Normal operation
 * - OPEN: Circuit tripped, rejecting requests
 * - HALF_OPEN: Testing if system has recovered
 */

import { pool } from '../db/index.js';
import { logger } from './logger.js';
import { config } from '../config.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerConfig {
  // Thresholds to trip the circuit
  poolWaitingThreshold: number;      // Trip if pool.waitingCount exceeds this
  consecutiveFailures: number;        // Trip after N consecutive DB failures
  
  // Recovery settings
  openDurationMs: number;             // How long to stay OPEN before trying HALF_OPEN
  halfOpenRequests: number;           // How many requests to allow in HALF_OPEN
  recoveryThreshold: number;          // Pool waiting must be below this to recover
  
  // Load shedding
  shedLoadThreshold: number;          // Start shedding load at this waiting count
}

const poolMax = Number.isFinite(config.dbPool?.max) ? config.dbPool.max : 30;

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  // Scale thresholds with pool size so small pools don't queue hundreds of requests.
  // With max=30, we start shedding at ~10 waiting and trip around ~20 waiting.
  poolWaitingThreshold: Math.max(20, Math.floor(poolMax * 0.7)),
  consecutiveFailures: 5,             // Trip after 5 consecutive failures
  openDurationMs: 10000,              // Stay open for 10 seconds
  halfOpenRequests: 5,                // Allow 5 test requests in half-open
  recoveryThreshold: Math.max(3, Math.floor(poolMax * 0.1)),   // Recover when waiting is low
  shedLoadThreshold: Math.max(10, Math.floor(poolMax * 0.35)), // Start shedding well before trip
};

class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private config: CircuitBreakerConfig;
  private consecutiveFailures = 0;
  private lastStateChange = Date.now();
  private halfOpenRequestCount = 0;
  private monitorInterval: NodeJS.Timeout | null = null;
  
  // Metrics
  private trippedCount = 0;
  private recoveredCount = 0;
  private shedRequestsCount = 0;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start monitoring the DB pool health
   */
  startMonitoring(intervalMs = 1000): void {
    if (this.monitorInterval) return;
    
    this.monitorInterval = setInterval(() => this.checkHealth(), intervalMs);
    logger.info('[CircuitBreaker] Started health monitoring');
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Check if a request should be allowed through
   * Returns true if allowed, false if should be shed
   */
  shouldAllowRequest(): boolean {
    const waitingCount = (pool as any).waitingCount || 0;
    
    switch (this.state) {
      case 'CLOSED':
        // In normal state, shed load if approaching threshold
        if (waitingCount >= this.config.shedLoadThreshold) {
          this.shedRequestsCount++;
          if (this.shedRequestsCount % 100 === 1) {
            logger.warn(`[CircuitBreaker] Load shedding active (waiting=${waitingCount}, shed=${this.shedRequestsCount})`);
          }
          // Probabilistic shedding - shed more as we approach threshold
          const shedProbability = (waitingCount - this.config.shedLoadThreshold) / 
                                   (this.config.poolWaitingThreshold - this.config.shedLoadThreshold);
          return Math.random() > shedProbability;
        }
        return true;
        
      case 'OPEN':
        // Circuit is open - reject all requests
        return false;
        
      case 'HALF_OPEN':
        // Allow limited requests to test recovery
        if (this.halfOpenRequestCount < this.config.halfOpenRequests) {
          this.halfOpenRequestCount++;
          return true;
        }
        return false;
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    
    if (this.state === 'HALF_OPEN') {
      const waitingCount = (pool as any).waitingCount || 0;
      if (waitingCount < this.config.recoveryThreshold) {
        this.transitionTo('CLOSED');
        this.recoveredCount++;
        logger.info(`[CircuitBreaker] ✅ Recovered! (waiting=${waitingCount})`);
      }
    }
  }

  /**
   * Record a failed request (DB timeout, connection error, etc.)
   */
  recordFailure(): void {
    this.consecutiveFailures++;
    
    if (this.state === 'CLOSED' && this.consecutiveFailures >= this.config.consecutiveFailures) {
      this.trip('consecutive failures');
    } else if (this.state === 'HALF_OPEN') {
      // Failed during recovery test - go back to OPEN
      this.transitionTo('OPEN');
      logger.warn('[CircuitBreaker] Recovery test failed, returning to OPEN state');
    }
  }

  /**
   * Check pool health and trigger state transitions
   */
  private checkHealth(): void {
    const waitingCount = (pool as any).waitingCount || 0;
    const totalCount = (pool as any).totalCount || 0;
    const idleCount = (pool as any).idleCount || 0;
    
    switch (this.state) {
      case 'CLOSED':
        // Check if we should trip the circuit
        if (waitingCount >= this.config.poolWaitingThreshold) {
          this.trip(`pool exhausted (waiting=${waitingCount})`);
        }
        break;
        
      case 'OPEN':
        // Check if we should try recovery
        const elapsed = Date.now() - this.lastStateChange;
        if (elapsed >= this.config.openDurationMs) {
          if (waitingCount < this.config.recoveryThreshold) {
            this.transitionTo('HALF_OPEN');
            logger.info(`[CircuitBreaker] Attempting recovery (waiting=${waitingCount})`);
          } else {
            // Still too much pressure, extend OPEN state
            this.lastStateChange = Date.now();
            logger.warn(`[CircuitBreaker] Recovery delayed, still under pressure (waiting=${waitingCount})`);
          }
        }
        break;
        
      case 'HALF_OPEN':
        // If waiting climbs during half-open, go back to OPEN
        if (waitingCount >= this.config.shedLoadThreshold) {
          this.transitionTo('OPEN');
          logger.warn(`[CircuitBreaker] Load increased during recovery, returning to OPEN`);
        }
        break;
    }
    
    // Periodic status log
    if (this.state !== 'CLOSED' || waitingCount > 10) {
      logger.debug(`[CircuitBreaker] State=${this.state}, Pool: total=${totalCount}, idle=${idleCount}, waiting=${waitingCount}`);
    }
  }

  /**
   * Trip the circuit breaker
   */
  private trip(reason: string): void {
    this.transitionTo('OPEN');
    this.trippedCount++;
    logger.error(`[CircuitBreaker] 🔴 TRIPPED: ${reason} (trip #${this.trippedCount})`);
    
    // Emit event for monitoring/alerting
    this.emitAlert('circuit_tripped', { reason, trippedCount: this.trippedCount });
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();
    
    if (newState === 'HALF_OPEN') {
      this.halfOpenRequestCount = 0;
    }
    
    logger.info(`[CircuitBreaker] State transition: ${oldState} → ${newState}`);
  }

  /**
   * Emit alert for monitoring systems
   */
  private emitAlert(type: string, data: any): void {
    // Log for now, could integrate with Discord/PagerDuty/etc.
    logger.warn(`[CircuitBreaker] ALERT: ${type}`, data);
  }

  /**
   * Get current state and metrics
   */
  getStatus(): {
    state: CircuitState;
    metrics: {
      trippedCount: number;
      recoveredCount: number;
      shedRequestsCount: number;
      consecutiveFailures: number;
      poolWaiting: number;
      poolTotal: number;
      poolIdle: number;
    };
  } {
    return {
      state: this.state,
      metrics: {
        trippedCount: this.trippedCount,
        recoveredCount: this.recoveredCount,
        shedRequestsCount: this.shedRequestsCount,
        consecutiveFailures: this.consecutiveFailures,
        poolWaiting: (pool as any).waitingCount || 0,
        poolTotal: (pool as any).totalCount || 0,
        poolIdle: (pool as any).idleCount || 0,
      },
    };
  }

  /**
   * Force recovery (manual intervention)
   */
  forceRecovery(): void {
    logger.warn('[CircuitBreaker] Manual recovery triggered');
    this.consecutiveFailures = 0;
    this.transitionTo('CLOSED');
    this.shedRequestsCount = 0;
  }

  /**
   * Force trip (for testing or manual intervention)
   */
  forceTrip(reason = 'manual'): void {
    this.trip(reason);
  }
}

// Singleton instance
export const circuitBreaker = new CircuitBreaker();

/**
 * Fastify middleware to enforce circuit breaker
 */
export function circuitBreakerMiddleware(request: any, reply: any, done: () => void): void {
  if (!circuitBreaker.shouldAllowRequest()) {
    const status = circuitBreaker.getStatus();
    
    reply
      .code(503)
      .header('Retry-After', '5')
      .send({
        error: {
          code: 'SERVICE_OVERLOADED',
          message: 'Server is experiencing high load. Please retry in a few seconds.',
          state: status.state,
        },
      });
    return;
  }
  
  done();
}

/**
 * Wrapper for DB operations that records success/failure
 */
export async function withCircuitBreaker<T>(operation: () => Promise<T>): Promise<T> {
  try {
    const result = await operation();
    circuitBreaker.recordSuccess();
    return result;
  } catch (error) {
    const errMsg = (error as Error).message || '';
    
    // Only record as failure if it's a connection/pool issue
    if (
      errMsg.includes('timeout') ||
      errMsg.includes('Connection terminated') ||
      errMsg.includes('ECONNRESET') ||
      errMsg.includes('pool')
    ) {
      circuitBreaker.recordFailure();
    }
    
    throw error;
  }
}

