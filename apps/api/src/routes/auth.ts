import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { randomBytes } from 'crypto';
import { userService } from '../services/user.service.js';
import { sessionService } from '../services/session.service.js';
import { logger } from '../lib/logger.js';

// Validation schemas
const nonceQuerySchema = z.object({
  address: z.string().length(44, 'Invalid Solana address'),
});

const verifyBodySchema = z.object({
  address: z.string().length(44, 'Invalid Solana address'),
  signature: z.string().min(1, 'Signature is required'),
  message: z.string().min(1, 'Message is required'),
});

// SIWS message prefix
const MESSAGE_PREFIX = 'Sign in to Degen Terminal:';

export async function authRoutes(app: FastifyInstance) {
  /**
   * GET /auth/nonce
   * Generates a random nonce for the user to sign (SIWS flow)
   */
  app.get('/nonce', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = nonceQuerySchema.safeParse(request.query);
    
    if (!query.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid address format',
          details: query.error.flatten(),
        },
      });
    }
    
    const { address } = query.data;
    
    // Check if user is banned
    if (await userService.isBanned(address)) {
      return reply.code(403).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Account is suspended',
        },
      });
    }
    
    // Generate nonce
    const nonce = randomBytes(32).toString('hex');
    const message = `${MESSAGE_PREFIX} ${nonce}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    
    // Get or create user, then store nonce
    await userService.getOrCreate(address);
    await userService.setNonce(address, nonce, expiresAt);
    
    logger.debug(`Generated nonce for ${address}`);
    
    return { nonce: message };
  });

  /**
   * POST /auth/verify
   * Verifies the signature and issues a JWT
   */
  app.post('/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = verifyBodySchema.safeParse(request.body);
    
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid request body',
          details: body.error.flatten(),
        },
      });
    }
    
    const { address, signature, message } = body.data;
    
    // Get stored nonce
    const storedNonce = await userService.getNonce(address);
    
    if (!storedNonce) {
      return reply.code(401).send({
        error: {
          code: 'NONCE_EXPIRED',
          message: 'No active login session. Please request a new nonce.',
        },
      });
    }
    
    // Check if nonce expired
    if (new Date() > storedNonce.expiresAt) {
      return reply.code(401).send({
        error: {
          code: 'NONCE_EXPIRED',
          message: 'Login session expired. Please request a new nonce.',
        },
      });
    }
    
    // Verify message matches stored nonce
    const expectedMessage = `${MESSAGE_PREFIX} ${storedNonce.nonce}`;
    if (message !== expectedMessage) {
      return reply.code(401).send({
        error: {
          code: 'INVALID_MESSAGE',
          message: 'Message does not match the expected format.',
        },
      });
    }
    
    // Verify signature
    try {
      const publicKey = bs58.decode(address);
      const signatureBytes = bs58.decode(signature);
      const messageBytes = new TextEncoder().encode(message);
      
      const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey);
      
      if (!isValid) {
        return reply.code(401).send({
          error: {
            code: 'INVALID_SIGNATURE',
            message: 'Signature verification failed.',
          },
        });
      }
    } catch (err) {
      logger.error('Signature verification error:', err);
      return reply.code(401).send({
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Invalid signature format.',
        },
      });
    }
    
    // Get user (should exist since we created during nonce request)
    const user = await userService.findByWallet(address);
    if (!user) {
      return reply.code(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'User not found after verification.',
        },
      });
    }
    
    // Clear nonce (one-time use)
    await userService.clearNonce(address);
    
    // Issue JWT
    const expiresIn = '24h';
    const token = app.jwt.sign(
      { 
        sub: user.id,
        address,
      },
      { expiresIn }
    );
    
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    
    logger.info(`User authenticated: ${address}`);
    
    return { 
      token,
      expiresAt,
    };
  });

  /**
   * POST /auth/refresh
   * Refresh an expiring JWT token
   */
  app.post('/refresh', {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch (err) {
        return reply.code(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token.',
          },
        });
      }
    }],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { sub: userId, address } = request.user as { sub: string; address: string };
    
    // Check if user is still valid and not banned
    const user = await userService.findById(userId);
    if (!user || user.isBanned) {
      return reply.code(403).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Account is suspended or does not exist.',
        },
      });
    }
    
    // Issue new token
    const expiresIn = '24h';
    const token = app.jwt.sign(
      { 
        sub: userId,
        address,
      },
      { expiresIn }
    );
    
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    
    return { 
      token,
      expiresAt,
    };
  });

  /**
   * POST /auth/logout
   * Invalidate current session (client-side should clear the token)
   */
  app.post('/logout', {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch (err) {
        return reply.code(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token.',
          },
        });
      }
    }],
  }, async (request: FastifyRequest) => {
    // For stateless JWT, logout is handled client-side
    // In the future, we could add token blacklisting with Redis
    const { address } = request.user as { address: string };
    logger.info(`User logged out: ${address}`);
    
    return { success: true };
  });

  // ============================================
  // AGENT AUTH ENDPOINTS (programmatic auth for AI agents / bots)
  // ============================================

  const agentNonceSchema = z.object({
    address: z.string().min(32).max(44),
  });

  const agentVerifySchema = z.object({
    address: z.string().min(32).max(44),
    signature: z.string().min(1),
    message: z.string().min(1),
    agentName: z.string().max(100).optional(),
  });

  /**
   * POST /auth/agent
   * Get a nonce for programmatic agent authentication.
   * Same as GET /nonce but accepts POST body (easier for bots).
   */
  app.post('/agent', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = agentNonceSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Invalid address', details: body.error.flatten() },
      });
    }

    const { address } = body.data;

    if (await userService.isBanned(address)) {
      return reply.code(403).send({
        error: { code: 'UNAUTHORIZED', message: 'Account is suspended' },
      });
    }

    const nonce = randomBytes(32).toString('hex');
    const message = `${MESSAGE_PREFIX} ${nonce}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await userService.getOrCreate(address);
    await userService.setNonce(address, nonce, expiresAt);

    logger.debug(`[Agent] Generated nonce for ${address}`);

    return { nonce: message, expiresAt: expiresAt.toISOString() };
  });

  /**
   * POST /auth/agent/verify
   * Verify signature and issue JWT with isAgent flag.
   * Auto-creates user with isAgent=true on first login.
   */
  app.post('/agent/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = agentVerifySchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Invalid request body', details: body.error.flatten() },
      });
    }

    const { address, signature, message, agentName } = body.data;

    // Get stored nonce
    const storedNonce = await userService.getNonce(address);

    if (!storedNonce) {
      return reply.code(401).send({
        error: { code: 'NONCE_EXPIRED', message: 'No active login session. Call POST /auth/agent first.' },
      });
    }

    if (new Date() > storedNonce.expiresAt) {
      return reply.code(401).send({
        error: { code: 'NONCE_EXPIRED', message: 'Login session expired. Call POST /auth/agent again.' },
      });
    }

    const expectedMessage = `${MESSAGE_PREFIX} ${storedNonce.nonce}`;
    if (message !== expectedMessage) {
      return reply.code(401).send({
        error: { code: 'INVALID_MESSAGE', message: 'Message does not match expected format.' },
      });
    }

    // Verify Ed25519 signature
    try {
      const publicKey = bs58.decode(address);
      const signatureBytes = bs58.decode(signature);
      const messageBytes = new TextEncoder().encode(message);

      const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey);

      if (!isValid) {
        return reply.code(401).send({
          error: { code: 'INVALID_SIGNATURE', message: 'Signature verification failed.' },
        });
      }
    } catch (err) {
      logger.error('[Agent] Signature verification error:', err);
      return reply.code(401).send({
        error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature format.' },
      });
    }

    // Get or create user
    let user = await userService.findByWallet(address);
    const isNewAgent = !user;

    if (!user) {
      user = await userService.getOrCreate(address);
    }

    if (!user) {
      return reply.code(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create user.' },
      });
    }

    // Mark user as agent (idempotent)
    if (!user.isAgent) {
      await userService.update(user.id, {
        isAgent: true,
        agentName: agentName || null,
        feeDiscountPct: 25, // Default 25% fee discount for agents
      });
    } else if (agentName && agentName !== user.agentName) {
      await userService.update(user.id, { agentName });
    }

    // Clear nonce
    await userService.clearNonce(address);

    // Issue JWT with isAgent flag
    const token = app.jwt.sign(
      { sub: user.id, address, isAgent: true },
      { expiresIn: '24h' }
    );

    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

    logger.info(`[Agent] Authenticated: ${address} (name: ${agentName || 'unnamed'})`);

    return {
      token,
      expiresAt,
      isNewAgent,
      agent: {
        address,
        name: agentName || user.agentName || null,
        feeDiscountPct: user.feeDiscountPct || 25,
      },
    };
  });

  // ============================================
  // SESSION KEY ENDPOINTS (for one-click trading)
  // ============================================

  const createSessionSchema = z.object({
    sessionPublicKey: z.string().min(32).max(64),
    walletAddress: z.string().length(44),
    expiresAt: z.number().int().positive(),
    signature: z.string().min(1),
    message: z.string().min(1),
  });

  /**
   * POST /auth/session
   * Create a new trading session with an ephemeral session key
   */
  app.post('/session', {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch (err) {
        return reply.code(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token.',
          },
        });
      }
    }],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = createSessionSchema.safeParse(request.body);
    
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid request body',
          details: body.error.flatten(),
        },
      });
    }
    
    const { address: jwtAddress } = request.user as { address: string };
    const { walletAddress } = body.data;
    
    // Verify the session is being created for the authenticated user
    if (jwtAddress !== walletAddress) {
      return reply.code(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'Cannot create session for a different wallet',
        },
      });
    }
    
    const result = await sessionService.createSession(body.data);
    
    if (!result.success) {
      return reply.code(400).send({
        error: {
          code: 'SESSION_ERROR',
          message: result.error,
        },
      });
    }
    
    return { success: true };
  });

  /**
   * DELETE /auth/session/:sessionPublicKey
   * Revoke a trading session
   */
  app.delete('/session/:sessionPublicKey', {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch (err) {
        return reply.code(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token.',
          },
        });
      }
    }],
  }, async (request: FastifyRequest<{ Params: { sessionPublicKey: string } }>, reply: FastifyReply) => {
    const { sessionPublicKey } = request.params;
    const { address } = request.user as { address: string };
    
    // Verify the session belongs to the authenticated user
    const session = sessionService.getSession(sessionPublicKey);
    if (session && session.walletAddress !== address) {
      return reply.code(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'Cannot revoke session for a different wallet',
        },
      });
    }
    
    sessionService.revokeSession(sessionPublicKey);
    
    return { success: true };
  });

  /**
   * GET /auth/session/status
   * Get current session status for the authenticated user
   */
  app.get('/session/status', {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch (err) {
        return reply.code(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token.',
          },
        });
      }
    }],
  }, async (request: FastifyRequest) => {
    const { address } = request.user as { address: string };
    return sessionService.getSessionStatus(address);
  });
}
