import { FastifyRequest, FastifyReply } from 'fastify';
import { userService } from '../services/user.service.js';

// JWT payload type
export interface JwtPayload {
  sub: string;     // User ID
  address: string; // Wallet address
  iat: number;     // Issued at
  exp: number;     // Expires at
}

// Extend FastifyRequest to include user
declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload;
  }
}

/**
 * Auth middleware - verifies JWT and attaches user to request
 * Use this for routes that require authentication
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify();
    
    // Get user from JWT payload
    const { sub: userId, address } = request.user as JwtPayload;
    
    // Optionally verify user still exists and is not banned
    const user = await userService.findById(userId);
    if (!user) {
      return reply.code(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'User not found.',
        },
      });
    }
    
    if (user.isBanned) {
      return reply.code(403).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Account is suspended.',
        },
      });
    }
  } catch (err) {
    return reply.code(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing authentication token.',
      },
    });
  }
}

/**
 * Optional auth middleware - verifies JWT if present but doesn't fail
 * Use this for routes that work with or without auth
 */
export async function optionalAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      await request.jwtVerify();
    }
  } catch (err) {
    // Ignore auth errors for optional auth
  }
}

/**
 * Get current user ID from request
 */
export function getCurrentUserId(request: FastifyRequest): string | null {
  try {
    const { sub } = request.user as JwtPayload;
    return sub;
  } catch {
    return null;
  }
}

/**
 * Get current wallet address from request
 */
export function getCurrentWallet(request: FastifyRequest): string | null {
  try {
    const { address } = request.user as JwtPayload;
    return address;
  } catch {
    return null;
  }
}










