import Redis from 'ioredis';
import { config } from '../config/env.js';
import { createLogger } from './logger.js';

const logger = createLogger('Redis');

export class RedisService {
  private client: Redis | null = null;
  private memoryCache: Map<string, { value: string; expiresAt?: number }> = new Map();
  private isConnected = false;

  constructor() {
    if (config.redisUrl) {
      try {
        this.client = new Redis(config.redisUrl, {
          connectTimeout: 3000,
          maxRetriesPerRequest: 1,
          retryStrategy: (times) => {
            if (times > 3) {
              logger.warn('Redis reconnection limit exceeded. Operating in fallback memory mode');
              return null; // Stop retrying
            }
            return Math.min(times * 100, 2000);
          },
        });

        this.client.on('connect', () => {
          this.isConnected = true;
          logger.info('Connected to Redis server');
        });

        this.client.on('error', (err) => {
          this.isConnected = false;
          logger.warn('Redis connection warning, using in-memory store for cache/FSM', { error: err.message });
        });
      } catch (err: any) {
        logger.warn('Failed to initialize Redis client, using in-memory store', { error: err.message });
        this.client = null;
      }
    } else {
      logger.info('No REDIS_URL provided. Using memory store for temporary FSM state and caching');
    }
  }

  public async get(key: string): Promise<string | null> {
    if (this.isConnected && this.client) {
      try {
        return await this.client.get(key);
      } catch (err) {
        // Fall back to memory
      }
    }

    const item = this.memoryCache.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.memoryCache.delete(key);
      return null;
    }
    return item.value;
  }

  public async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.isConnected && this.client) {
      try {
        if (ttlSeconds) {
          await this.client.set(key, value, 'EX', ttlSeconds);
        } else {
          await this.client.set(key, value);
        }
        return;
      } catch (err) {
        // Fall back to memory
      }
    }

    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.memoryCache.set(key, { value, expiresAt });
  }

  public async del(key: string): Promise<void> {
    if (this.isConnected && this.client) {
      try {
        await this.client.del(key);
        return;
      } catch (err) {
        // Fall back to memory
      }
    }
    this.memoryCache.delete(key);
  }

  public async getFsmState<T = any>(userId: string | number): Promise<T | null> {
    const raw = await this.get(`fsm:${userId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  public async setFsmState(userId: string | number, state: any, ttlSeconds = 3600): Promise<void> {
    await this.set(`fsm:${userId}`, JSON.stringify(state), ttlSeconds);
  }

  public async clearFsmState(userId: string | number): Promise<void> {
    await this.del(`fsm:${userId}`);
  }

  public async checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }> {
    const rateKey = `ratelimit:${key}`;
    const raw = await this.get(rateKey);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= limit) {
      return { allowed: false, remaining: 0 };
    }
    await this.set(rateKey, (count + 1).toString(), windowSeconds);
    return { allowed: true, remaining: limit - (count + 1) };
  }

  public async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
    this.memoryCache.clear();
  }
}

export const redis = new RedisService();
