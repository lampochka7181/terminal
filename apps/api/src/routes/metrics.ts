import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getMetricsText, getMetricsJson, wsMetrics, redisMetrics, dbMetrics, solanaMetrics } from '../metrics/index.js';
import { logger } from '../lib/logger.js';

/**
 * Metrics Route
 *
 * Exposes Prometheus-compatible metrics endpoint for monitoring.
 *
 * GET /metrics - Prometheus text format
 * GET /metrics/json - JSON format (for debugging)
 * GET /metrics/summary - Human-readable summary
 */

export async function metricsRoutes(fastify: FastifyInstance) {
  // Prometheus text format (default)
  fastify.get('/metrics', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const metrics = await getMetricsText();
      reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      return metrics;
    } catch (err) {
      logger.error('Error getting metrics:', err);
      reply.status(500).send('Error collecting metrics');
    }
  });

  // JSON format (for debugging/dashboards)
  fastify.get('/metrics/json', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const metrics = await getMetricsJson();
      return metrics;
    } catch (err) {
      logger.error('Error getting metrics JSON:', err);
      reply.status(500).send({ error: 'Error collecting metrics' });
    }
  });

  // Human-readable summary
  fastify.get('/metrics/summary', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const summary = {
        timestamp: new Date().toISOString(),
        websocket: {
          connectedClients: await getGaugeValue(wsMetrics.connectedClients),
        },
        solana: {
          queueDepth: {
            settlement: await getGaugeValue(solanaMetrics.queueDepth, { queue_type: 'settlement' }),
            matching: await getGaugeValue(solanaMetrics.queueDepth, { queue_type: 'matching' }),
          },
        },
        database: {
          poolTotalConnections: await getGaugeValue(dbMetrics.poolTotalConnections),
          poolIdleConnections: await getGaugeValue(dbMetrics.poolIdleConnections),
          poolWaitingClients: await getGaugeValue(dbMetrics.poolWaitingClients),
        },
      };
      return summary;
    } catch (err) {
      logger.error('Error getting metrics summary:', err);
      reply.status(500).send({ error: 'Error collecting metrics' });
    }
  });
}

// Helper to get gauge value
async function getGaugeValue(gauge: any, labels?: Record<string, string>): Promise<number> {
  try {
    const metric = await gauge.get();
    if (labels) {
      const value = metric.values.find((v: any) =>
        Object.entries(labels).every(([k, v]) => v.labels[k] === v)
      );
      return value?.value ?? 0;
    }
    return metric.values[0]?.value ?? 0;
  } catch {
    return 0;
  }
}
