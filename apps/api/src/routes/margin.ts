import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth, getCurrentUserId, getCurrentWallet } from '../lib/auth.js';
import { marginService, leverageCalc } from '../services/margin.service.js';
import { lendingService } from '../services/lending.service.js';
import { marketService } from '../services/market.service.js';
import { orderbookService } from '../services/orderbook.service.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

// Validation schemas
const addMarginSchema = z.object({
  marginAccountId: z.string().uuid(),
  amount: z.number().min(0.01).max(100000), // Min $0.01, Max $100k
});

const marginAccountIdSchema = z.object({
  id: z.string().uuid(),
});

export async function marginRoutes(app: FastifyInstance) {
  // Apply auth middleware to all routes
  app.addHook('preHandler', requireAuth);

  /**
   * GET /margin/config
   * Get leverage configuration
   */
  app.get('/config', async (request: FastifyRequest, reply: FastifyReply) => {
    return {
      enabled: lendingService.isEnabled(),
      maxLeverage: config.leverage.maxLeverage,
      minLeverage: config.leverage.minLeverage,
      maintenanceMarginPct: config.leverage.maintenanceMarginPct * 100, // Return as percentage
      liquidationPenaltyPct: config.leverage.liquidationPenaltyPct * 100,
      minMarginUsd: config.leverage.minMarginUsd,
    };
  });

  /**
   * GET /margin/pool
   * Get lending pool status
   */
  app.get('/pool', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!lendingService.isEnabled()) {
      return reply.code(503).send({
        error: { code: 'LEVERAGE_DISABLED', message: 'Leverage is not enabled' },
      });
    }

    const poolStatus = await lendingService.getPoolStatus();
    const insuranceStatus = await lendingService.getInsuranceStatus();

    return {
      lendingPool: {
        totalDeposited: poolStatus.totalDeposited,
        totalLoaned: poolStatus.totalLoaned,
        available: poolStatus.available,
        utilizationPct: poolStatus.utilizationPct,
      },
      insuranceFund: {
        balance: insuranceStatus.balance,
        totalReceived: insuranceStatus.totalReceived,
        totalPaidOut: insuranceStatus.totalPaidOut,
      },
    };
  });

  /**
   * GET /margin/accounts
   * Get all margin accounts for the authenticated user
   */
  app.get('/accounts', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    if (!lendingService.isEnabled()) {
      return reply.code(503).send({
        error: { code: 'LEVERAGE_DISABLED', message: 'Leverage is not enabled' },
      });
    }

    const accounts = await marginService.getUserMarginAccounts(userId);

    // Get current prices and calculate health for each account
    const accountsWithHealth = await Promise.all(
      accounts.map(async (account) => {
        // Get current market price
        let currentPrice = 0.5;
        try {
          const snapshot = await orderbookService.getSnapshot(account.marketId, 'YES');
          if (snapshot.bids.length > 0 && snapshot.asks.length > 0) {
            currentPrice = (snapshot.bids[0].price + snapshot.asks[0].price) / 2;
          } else if (account.market?.yesPrice) {
            currentPrice = parseFloat(account.market.yesPrice);
          }
        } catch {
          // Use stored price
          if (account.market?.yesPrice) {
            currentPrice = parseFloat(account.market.yesPrice);
          }
        }

        const health = await marginService.getAccountHealth(account.id, currentPrice);

        return {
          id: account.id,
          positionId: account.positionId,
          marketId: account.marketId,
          market: account.market
            ? {
                pubkey: account.market.pubkey,
                asset: account.market.asset,
                timeframe: account.market.timeframe,
              }
            : null,
          side: account.side,
          shares: parseFloat(account.shares),
          entryPrice: parseFloat(account.entryPrice),
          marginDeposited: parseFloat(account.marginDeposited),
          loanAmount: parseFloat(account.loanAmount),
          leverage: parseFloat(account.leverage),
          liquidationPrice: parseFloat(account.liquidationPrice),
          currentPrice,
          status: account.status,
          health: {
            equity: health.equity,
            marginRatio: health.marginRatio * 100, // Return as percentage
            distanceToLiq: health.distanceToLiq,
            distanceToLiqPct: health.distanceToLiqPct,
            isAtRisk: health.isAtRisk,
          },
          createdAt: account.createdAt?.getTime(),
        };
      })
    );

    return {
      accounts: accountsWithHealth,
      total: accountsWithHealth.length,
    };
  });

  /**
   * GET /margin/accounts/:id
   * Get a specific margin account
   */
  app.get('/accounts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    const params = marginAccountIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Invalid account ID' },
      });
    }

    const account = await marginService.getById(params.data.id);
    if (!account) {
      return reply.code(404).send({
        error: { code: 'ACCOUNT_NOT_FOUND', message: 'Margin account not found' },
      });
    }

    // Verify ownership
    if (account.userId !== userId) {
      return reply.code(403).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authorized to view this account' },
      });
    }

    // Get current price
    let currentPrice = 0.5;
    try {
      const snapshot = await orderbookService.getSnapshot(account.marketId, 'YES');
      if (snapshot.bids.length > 0 && snapshot.asks.length > 0) {
        currentPrice = (snapshot.bids[0].price + snapshot.asks[0].price) / 2;
      }
    } catch {
      // Default price
    }

    const health = await marginService.getAccountHealth(account.id, currentPrice);

    return {
      id: account.id,
      positionId: account.positionId,
      marketId: account.marketId,
      side: account.side,
      shares: parseFloat(account.shares),
      entryPrice: parseFloat(account.entryPrice),
      marginDeposited: parseFloat(account.marginDeposited),
      loanAmount: parseFloat(account.loanAmount),
      leverage: parseFloat(account.leverage),
      liquidationPrice: parseFloat(account.liquidationPrice),
      currentPrice,
      status: account.status,
      health: {
        equity: health.equity,
        marginRatio: health.marginRatio * 100,
        distanceToLiq: health.distanceToLiq,
        distanceToLiqPct: health.distanceToLiqPct,
        isAtRisk: health.isAtRisk,
      },
      createdAt: account.createdAt?.getTime(),
      updatedAt: account.updatedAt?.getTime(),
    };
  });

  /**
   * POST /margin/add
   * Add margin to an existing leveraged position
   */
  app.post('/add', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    if (!lendingService.isEnabled()) {
      return reply.code(503).send({
        error: { code: 'LEVERAGE_DISABLED', message: 'Leverage is not enabled' },
      });
    }

    const body = addMarginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Invalid request', details: body.error.flatten() },
      });
    }

    const { marginAccountId, amount } = body.data;

    // Verify ownership
    const account = await marginService.getById(marginAccountId);
    if (!account) {
      return reply.code(404).send({
        error: { code: 'ACCOUNT_NOT_FOUND', message: 'Margin account not found' },
      });
    }

    if (account.userId !== userId) {
      return reply.code(403).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authorized to modify this account' },
      });
    }

    if (account.status !== 'OPEN') {
      return reply.code(409).send({
        error: { code: 'ACCOUNT_CLOSED', message: 'Cannot add margin to closed account' },
      });
    }

    try {
      // TODO: Verify user has sufficient USDC balance and transfer on-chain
      // For now, just update the margin account (assumes transfer happened)

      const result = await marginService.addMargin(marginAccountId, amount);

      logger.info(`Added margin to account ${marginAccountId}: $${amount}`);

      return {
        success: true,
        marginAccountId,
        amountAdded: amount,
        newLoanAmount: result.newLoan,
        newLiquidationPrice: result.newLiqPrice,
      };
    } catch (err: any) {
      logger.error(`Failed to add margin: ${err.message}`);
      return reply.code(400).send({
        error: { code: 'ADD_MARGIN_FAILED', message: err.message },
      });
    }
  });

  /**
   * GET /margin/liquidations
   * Get liquidation history for the authenticated user
   */
  app.get('/liquidations', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = getCurrentUserId(request);
    if (!userId) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    const liquidations = await marginService.getUserLiquidations(userId);

    return {
      liquidations: liquidations.map((liq) => ({
        id: liq.id,
        marginAccountId: liq.marginAccountId,
        marketId: liq.marketId,
        triggerPrice: parseFloat(liq.triggerPrice),
        executionPrice: parseFloat(liq.executionPrice),
        sharesLiquidated: parseFloat(liq.sharesLiquidated),
        proceeds: parseFloat(liq.proceeds),
        loanRepaid: parseFloat(liq.loanRepaid),
        penalty: parseFloat(liq.penalty),
        returnedToUser: parseFloat(liq.returnedToUser),
        badDebt: parseFloat(liq.badDebt || '0'),
        txSignature: liq.txSignature,
        createdAt: liq.createdAt?.getTime(),
      })),
      total: liquidations.length,
    };
  });

  /**
   * POST /margin/calculate
   * Calculate leverage parameters before placing an order
   */
  app.post('/calculate', async (request: FastifyRequest, reply: FastifyReply) => {
    const calculateSchema = z.object({
      side: z.enum(['YES', 'NO']),
      price: z.number().min(0.01).max(0.99),
      size: z.number().min(0.001),
      leverage: z.number().min(1).max(config.leverage.maxLeverage),
    });

    const body = calculateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Invalid parameters', details: body.error.flatten() },
      });
    }

    const { side, price, size, leverage } = body.data;
    const totalPosition = price * size;
    const marginRequired = leverageCalc.initialMarginRequired(totalPosition, leverage);
    const loanAmount = leverageCalc.loanAmount(totalPosition, leverage);

    // Calculate liquidation price
    const liquidationPrice =
      side === 'YES'
        ? leverageCalc.liquidationPriceYes(size, price, loanAmount)
        : leverageCalc.liquidationPriceNo(size, price, loanAmount);

    // Check if loan can be made
    const loanCheck = await lendingService.canMakeLoan(loanAmount);

    return {
      side,
      entryPrice: price,
      shares: size,
      leverage,
      totalPosition,
      marginRequired,
      loanAmount,
      liquidationPrice,
      maintenanceMarginPct: config.leverage.maintenanceMarginPct * 100,
      canBorrow: loanCheck.canLoan,
      maxAvailableLoan: loanCheck.maxLoan,
      borrowError: loanCheck.reason,
    };
  });
}

