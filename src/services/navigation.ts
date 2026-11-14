import crypto from 'crypto';
import { db } from '../db/index.js';
import { redis } from './redis.js';
import { createLogger } from './logger.js';

const logger = createLogger('NavigationService');

export interface NavigationState {
  userId: string;
  activeMessageId?: number;
  screen: string;
  categoryId?: string;
  productId?: string;
  page: number;
  searchQuery?: string;
  quantity: number;
  filters: Record<string, any>;
  stateToken: string;
  expiresAt?: string;
}

export class NavigationService {
  private readonly defaultTtlMs = 24 * 60 * 60 * 1000; // 24 hours
  private localActionLocks = new Map<string, number>();

  public generateToken(): string {
    return crypto.randomBytes(4).toString('hex');
  }

  public async getState(userId: string): Promise<NavigationState | null> {
    const cached = await redis.get(`nav:${userId}`);
    if (cached) {
      try {
        return JSON.parse(cached) as NavigationState;
      } catch {
        // Fallback to DB
      }
    }

    try {
      const row = await db.queryRow<any>(
        `SELECT user_id as "userId", active_message_id as "activeMessageId",
                screen, category_id as "categoryId", product_id as "productId",
                page, search_query as "searchQuery", quantity,
                filters_json as "filters", state_token as "stateToken",
                expires_at as "expiresAt"
         FROM ui_navigation_states
         WHERE user_id = $1`,
        [userId]
      );
      if (!row) return null;

      const state: NavigationState = {
        userId: row.userId,
        activeMessageId: row.activeMessageId ? Number(row.activeMessageId) : undefined,
        screen: row.screen || 'home',
        categoryId: row.categoryId || undefined,
        productId: row.productId || undefined,
        page: Number(row.page || 1),
        searchQuery: row.searchQuery || undefined,
        quantity: Number(row.quantity || 1),
        filters: typeof row.filters === 'string' ? JSON.parse(row.filters) : row.filters || {},
        stateToken: row.stateToken,
        expiresAt: row.expiresAt,
      };
      await redis.set(`nav:${userId}`, JSON.stringify(state), 3600);
      return state;
    } catch (err: any) {
      logger.warn('Could not load navigation state', { userId, error: err.message });
      return null;
    }
  }

  public async saveState(
    userId: string,
    patch: Partial<Omit<NavigationState, 'userId' | 'stateToken'>> & { rotateToken?: boolean }
  ): Promise<NavigationState> {
    const existing = await this.getState(userId);
    const stateToken = patch.rotateToken || !existing?.stateToken ? this.generateToken() : existing.stateToken;
    const expiresAt = new Date(Date.now() + this.defaultTtlMs).toISOString();

    const next: NavigationState = {
      userId,
      activeMessageId: patch.activeMessageId ?? existing?.activeMessageId,
      screen: patch.screen ?? existing?.screen ?? 'home',
      categoryId: patch.categoryId !== undefined ? patch.categoryId : existing?.categoryId,
      productId: patch.productId !== undefined ? patch.productId : existing?.productId,
      page: patch.page ?? existing?.page ?? 1,
      searchQuery: patch.searchQuery !== undefined ? patch.searchQuery : existing?.searchQuery,
      quantity: patch.quantity ?? existing?.quantity ?? 1,
      filters: patch.filters ?? existing?.filters ?? {},
      stateToken,
      expiresAt,
    };

    const filtersStr = JSON.stringify(next.filters);
    const existingFiltersStr = existing ? JSON.stringify(existing.filters || {}) : '';
    const changed =
      !existing ||
      patch.rotateToken ||
      existing.activeMessageId !== next.activeMessageId ||
      existing.screen !== next.screen ||
      existing.categoryId !== next.categoryId ||
      existing.productId !== next.productId ||
      existing.page !== next.page ||
      existing.searchQuery !== next.searchQuery ||
      existing.quantity !== next.quantity ||
      existingFiltersStr !== filtersStr;

    if (changed) {
      try {
        await db.query(
          `INSERT INTO ui_navigation_states (
            user_id, active_message_id, screen, category_id, product_id,
            page, search_query, quantity, filters_json, state_token, expires_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id) DO UPDATE SET
            active_message_id = EXCLUDED.active_message_id,
            screen = EXCLUDED.screen,
            category_id = EXCLUDED.category_id,
            product_id = EXCLUDED.product_id,
            page = EXCLUDED.page,
            search_query = EXCLUDED.search_query,
            quantity = EXCLUDED.quantity,
            filters_json = EXCLUDED.filters_json,
            state_token = EXCLUDED.state_token,
            expires_at = EXCLUDED.expires_at,
            updated_at = CURRENT_TIMESTAMP`,
          [
            next.userId,
            next.activeMessageId ?? null,
            next.screen,
            next.categoryId ?? null,
            next.productId ?? null,
            next.page,
            next.searchQuery ?? null,
            next.quantity,
            filtersStr,
            next.stateToken,
            next.expiresAt,
          ]
        );
      } catch (err: any) {
        logger.warn('DB navigation state persistence skipped', { userId, error: err.message });
      }
    }

    await redis.set(`nav:${userId}`, JSON.stringify(next), 3600);
    return next;
  }

  /**
   * Validate a short navigation token for state-sensitive callbacks (returns false if stale/expired).
   */
  public async validateToken(userId: string, token: string): Promise<{ valid: boolean; state: NavigationState | null }> {
    const state = await this.getState(userId);
    if (!state) return { valid: false, state: null };
    if (state.expiresAt && new Date(state.expiresAt).getTime() < Date.now()) {
      return { valid: false, state };
    }
    if (state.stateToken !== token) {
      return { valid: false, state };
    }
    return { valid: true, state };
  }

  /**
   * Prevent double-tap / duplicate callback processing for sensitive actions atomically.
   */
  public async acquireActionLock(userId: string, actionKey: string, ttlSeconds = 2): Promise<boolean> {
    const lockKey = `actlock:${userId}:${actionKey}`;
    const now = Date.now();
    const localExp = this.localActionLocks.get(lockKey);
    if (localExp && localExp > now) {
      return false;
    }

    const expiresAt = now + ttlSeconds * 1000;
    this.localActionLocks.set(lockKey, expiresAt);

    const acquired = await redis.setIfNotExists(lockKey, String(now), ttlSeconds);
    if (!acquired) {
      return false;
    }

    if (this.localActionLocks.size > 500) {
      for (const [k, exp] of this.localActionLocks.entries()) {
        if (exp <= now) this.localActionLocks.delete(k);
      }
    }
    return true;
  }
}

export const navigationService = new NavigationService();
