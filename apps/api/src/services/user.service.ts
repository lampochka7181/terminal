import { eq } from 'drizzle-orm';
import { db, users, type User, type NewUser } from '../db/index.js';
import { logger } from '../lib/logger.js';

export class UserService {
  /**
   * Find user by wallet address
   */
  async findByWallet(walletAddress: string): Promise<User | null> {
    const result = await db
      .select()
      .from(users)
      .where(eq(users.walletAddress, walletAddress))
      .limit(1);
    
    return result[0] || null;
  }

  /**
   * Find user by ID
   */
  async findById(id: string): Promise<User | null> {
    const result = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    
    return result[0] || null;
  }

  /**
   * Create a new user
   */
  async create(walletAddress: string): Promise<User> {
    const [user] = await db
      .insert(users)
      .values({ walletAddress })
      .returning();
    
    logger.info(`Created new user: ${walletAddress}`);
    return user;
  }

  /**
   * Get or create user by wallet address
   */
  async getOrCreate(walletAddress: string): Promise<User> {
    const existing = await this.findByWallet(walletAddress);
    if (existing) {
      return existing;
    }
    return this.create(walletAddress);
  }

  /**
   * Update user's nonce for authentication
   */
  async setNonce(walletAddress: string, nonce: string, expiresAt: Date): Promise<void> {
    await db
      .update(users)
      .set({ 
        nonce, 
        nonceExpiresAt: expiresAt 
      })
      .where(eq(users.walletAddress, walletAddress));
  }

  /**
   * Clear user's nonce after successful auth
   */
  async clearNonce(walletAddress: string): Promise<void> {
    await db
      .update(users)
      .set({ 
        nonce: null, 
        nonceExpiresAt: null,
        lastLoginAt: new Date(),
      })
      .where(eq(users.walletAddress, walletAddress));
  }

  /**
   * Get user's nonce for verification
   */
  async getNonce(walletAddress: string): Promise<{ nonce: string; expiresAt: Date } | null> {
    const user = await this.findByWallet(walletAddress);
    if (!user || !user.nonce || !user.nonceExpiresAt) {
      return null;
    }
    return {
      nonce: user.nonce,
      expiresAt: user.nonceExpiresAt,
    };
  }

  /**
   * Check if user is banned
   */
  async isBanned(walletAddress: string): Promise<boolean> {
    const user = await this.findByWallet(walletAddress);
    return user?.isBanned ?? false;
  }

  /**
   * Update user stats after a trade
   */
  async updateTradeStats(userId: string, volume: number): Promise<void> {
    const user = await this.findById(userId);
    if (!user) return;

    const newVolume = parseFloat(user.totalVolume || '0') + volume;
    const newTrades = (user.totalTrades || 0) + 1;

    // Calculate fee tier based on volume
    let feeTier = 0;
    if (newVolume >= 1000000) feeTier = 2;
    else if (newVolume >= 100000) feeTier = 1;

    await db
      .update(users)
      .set({ 
        totalVolume: newVolume.toString(),
        totalTrades: newTrades,
        feeTier,
      })
      .where(eq(users.id, userId));
  }
}

export const userService = new UserService();







