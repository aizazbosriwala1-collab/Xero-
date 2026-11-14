import { db } from '../db/index.js';
import { redis } from './redis.js';
import { referralService } from './referral.js';
import { createLogger } from './logger.js';

const logger = createLogger('GiveawayService');

export interface GiveawayItem {
  id: string;
  title: string;
  description: string;
  rewardProductId: string;
  rewardProductName: string;
  rewardQuantity: number;
  requiredTotalReferrals: number;
  requiredQualifiedReferrals: number;
  startAt: string | null;
  endAt: string | null;
  isActive: boolean;
  isPublic: boolean;
  claimLimit: number;
  claimsCount: number;
  createdAt?: string;
  updatedAt?: string;
  userProgress?: {
    currentTotal: number;
    requiredTotal: number;
    currentQualified: number;
    required: number;
    isEligible: boolean;
    hasClaimed: boolean;
    claimStatus?: 'PENDING' | 'FULFILLED' | 'REJECTED';
  };
}

export interface GiveawayCreateInput {
  title: string;
  description?: string;
  rewardProductId: string;
  rewardQuantity?: number;
  requiredTotalReferrals?: number;
  requiredQualifiedReferrals: number;
  startAt?: string | null;
  endAt?: string | null;
  isActive?: boolean;
  isPublic?: boolean;
  claimLimit?: number;
}

export interface GiveawayUpdatePatch {
  title?: string;
  description?: string;
  rewardProductId?: string;
  rewardQuantity?: number;
  requiredTotalReferrals?: number;
  requiredQualifiedReferrals?: number;
  startAt?: string | null;
  endAt?: string | null;
  isActive?: boolean;
  isPublic?: boolean;
  claimLimit?: number;
}

export class GiveawayService {
  private mapRow(r: any, userStats?: { totalReferred: number; qualifiedCount: number }, claimStatus?: any): GiveawayItem {
    const reqTotal = Number(r.requiredTotalReferrals || 0);
    const reqQual = Number(r.requiredQualifiedReferrals || 0);
    let userProgress: GiveawayItem['userProgress'] = undefined;

    if (userStats) {
      const hasClaimed = Boolean(claimStatus);
      const isEligible =
        userStats.qualifiedCount >= reqQual &&
        userStats.totalReferred >= reqTotal;
      userProgress = {
        currentTotal: userStats.totalReferred,
        requiredTotal: reqTotal,
        currentQualified: userStats.qualifiedCount,
        required: reqQual,
        isEligible,
        hasClaimed,
        claimStatus,
      };
    }

    return {
      id: r.id,
      title: r.title,
      description: r.description || '',
      rewardProductId: r.rewardProductId || '',
      rewardProductName: r.rewardProductName || r.rewardLabel || 'Digital Tool Reward',
      rewardQuantity: Number(r.rewardQuantity || 1),
      requiredTotalReferrals: reqTotal,
      requiredQualifiedReferrals: reqQual,
      startAt: r.startAt ? new Date(r.startAt).toISOString() : null,
      endAt: r.endAt ? new Date(r.endAt).toISOString() : null,
      isActive: Boolean(r.isActive),
      isPublic: r.isPublic !== false,
      claimLimit: Number(r.claimLimit || 100),
      claimsCount: Number(r.claimsCount || 0),
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : undefined,
      userProgress,
    };
  }

  private readonly activeRawCacheKey = 'gw:active_raw';
  private readonly cfgCacheKey = 'sys:giveaway_cfg';

  private async invalidateCaches(): Promise<void> {
    await Promise.all([
      redis.del(this.activeRawCacheKey).catch(() => {}),
      redis.del(this.cfgCacheKey).catch(() => {}),
    ]);
  }

  /**
   * Get active, public, currently-running giveaways for customer display (Redis-cached 45s),
   * annotated with user progress using a single batched claims query (no N+1).
   */
  public async getActiveGiveaways(userId?: string): Promise<GiveawayItem[]> {
    const now = Date.now();
    let rawRows: any[] | null = null;
    try {
      const cached = await redis.get(this.activeRawCacheKey);
      if (cached) rawRows = JSON.parse(cached);
    } catch {
      // Cache miss
    }

    if (!rawRows) {
      const res = await db.query<any>(`
        SELECT g.id, g.title, g.description, g.reward_product_id as "rewardProductId",
               g.reward_label as "rewardLabel",
               COALESCE(po.display_name_override, sp.original_name) as "rewardProductName",
               g.reward_quantity as "rewardQuantity",
               g.required_total_referrals as "requiredTotalReferrals",
               g.required_qualified_referrals as "requiredQualifiedReferrals",
               g.start_at as "startAt",
               g.end_at as "endAt",
               g.is_active as "isActive",
               g.is_public as "isPublic",
               g.claim_limit as "claimLimit",
               g.claims_count as "claimsCount",
               g.created_at as "createdAt",
               g.updated_at as "updatedAt"
        FROM giveaways g
        LEFT JOIN supplier_products sp ON g.reward_product_id = sp.id
        LEFT JOIN product_overrides po ON g.reward_product_id = po.product_id
        WHERE g.is_active = TRUE
          AND (g.is_public IS NULL OR g.is_public = TRUE)
        ORDER BY g.created_at DESC
      `);
      rawRows = res.rows;
      await redis.set(this.activeRawCacheKey, JSON.stringify(rawRows), 45).catch(() => {});
    }

    const liveRows = rawRows.filter(r => {
      if (r.startAt && new Date(r.startAt).getTime() > now) return false;
      if (r.endAt && new Date(r.endAt).getTime() <= now) return false;
      return true;
    });

    let userStats: { totalReferred: number; qualifiedCount: number } | undefined;
    const claimMap = new Map<string, 'PENDING' | 'FULFILLED' | 'REJECTED'>();

    if (userId) {
      const [stats, claimsRes] = await Promise.all([
        referralService.getStats(userId),
        db.query<{ giveaway_id: string; status: 'PENDING' | 'FULFILLED' | 'REJECTED' }>(
          'SELECT giveaway_id, status FROM giveaway_claims WHERE user_id = $1',
          [userId]
        ),
      ]);
      userStats = { totalReferred: stats.totalReferred, qualifiedCount: stats.qualifiedCount };
      for (const c of claimsRes.rows) {
        claimMap.set(c.giveaway_id, c.status);
      }
    }

    return liveRows.map(r => this.mapRow(r, userStats, claimMap.get(r.id)));
  }

  /**
   * List giveaways for Admin Control Center split cleanly by status ('active' | 'finished' | 'all').
   */
  public async listAdminGiveaways(filter: 'active' | 'finished' | 'all' = 'all'): Promise<GiveawayItem[]> {
    const res = await db.query<any>(`
      SELECT g.id, g.title, g.description, g.reward_product_id as "rewardProductId",
             g.reward_label as "rewardLabel",
             COALESCE(po.display_name_override, sp.original_name) as "rewardProductName",
             g.reward_quantity as "rewardQuantity",
             g.required_total_referrals as "requiredTotalReferrals",
             g.required_qualified_referrals as "requiredQualifiedReferrals",
             g.start_at as "startAt",
             g.end_at as "endAt",
             g.is_active as "isActive",
             g.is_public as "isPublic",
             g.claim_limit as "claimLimit",
             g.claims_count as "claimsCount",
             g.created_at as "createdAt",
             g.updated_at as "updatedAt"
      FROM giveaways g
      LEFT JOIN supplier_products sp ON g.reward_product_id = sp.id
      LEFT JOIN product_overrides po ON g.reward_product_id = po.product_id
      ORDER BY g.created_at DESC
    `);

    const now = Date.now();
    const mapped = res.rows.map(r => this.mapRow(r));
    if (filter === 'all') return mapped;

    return mapped.filter(g => {
      const isExpired = Boolean(g.endAt && new Date(g.endAt).getTime() <= now);
      const isFull = g.claimsCount >= g.claimLimit;
      const isFinished = !g.isActive || isExpired || isFull;
      return filter === 'finished' ? isFinished : !isFinished;
    });
  }

  public async getGiveawayById(giveawayId: string): Promise<GiveawayItem | null> {
    const r = await db.queryRow<any>(`
      SELECT g.id, g.title, g.description, g.reward_product_id as "rewardProductId",
             g.reward_label as "rewardLabel",
             COALESCE(po.display_name_override, sp.original_name) as "rewardProductName",
             g.reward_quantity as "rewardQuantity",
             g.required_total_referrals as "requiredTotalReferrals",
             g.required_qualified_referrals as "requiredQualifiedReferrals",
             g.start_at as "startAt",
             g.end_at as "endAt",
             g.is_active as "isActive",
             g.is_public as "isPublic",
             g.claim_limit as "claimLimit",
             g.claims_count as "claimsCount",
             g.created_at as "createdAt",
             g.updated_at as "updatedAt"
      FROM giveaways g
      LEFT JOIN supplier_products sp ON g.reward_product_id = sp.id
      LEFT JOIN product_overrides po ON g.reward_product_id = po.product_id
      WHERE g.id = $1
    `, [giveawayId]);
    return r ? this.mapRow(r) : null;
  }

  /**
   * Customer claims a giveaway
   */
  public async claimGiveaway(giveawayId: string, userId: string, _customerEmail?: string): Promise<{
    success: boolean;
    message: string;
    claimId?: string;
  }> {
    const giveaway = await db.queryRow<any>(
      'SELECT * FROM giveaways WHERE id = $1 AND is_active = TRUE',
      [giveawayId]
    );

    if (!giveaway) {
      throw new Error('This giveaway is not active or could not be found.');
    }

    if (giveaway.is_public === false) {
      throw new Error('This giveaway is currently private.');
    }

    const now = Date.now();
    if (giveaway.start_at && new Date(giveaway.start_at).getTime() > now) {
      throw new Error('This giveaway has not started yet.');
    }
    if (giveaway.end_at && new Date(giveaway.end_at).getTime() <= now) {
      throw new Error('This giveaway has already ended.');
    }

    const claimLimit = Number(giveaway.claim_limit || 100);
    const claimsCount = Number(giveaway.claims_count || 0);
    if (claimsCount >= claimLimit) {
      throw new Error('The maximum claim limit for this giveaway has been reached.');
    }

    const existingClaim = await db.queryRow<any>(
      'SELECT * FROM giveaway_claims WHERE giveaway_id = $1 AND user_id = $2',
      [giveawayId, userId]
    );
    if (existingClaim) {
      throw new Error('You have already claimed this giveaway reward.');
    }

    const stats = await referralService.getStats(userId);
    const reqTotal = Number(giveaway.required_total_referrals || 0);
    const reqQual = Number(giveaway.required_qualified_referrals || 0);

    if (stats.totalReferred < reqTotal) {
      throw new Error(`You need at least ${reqTotal} referrals. Current: ${stats.totalReferred}.`);
    }
    if (stats.qualifiedCount < reqQual) {
      throw new Error(`You need at least ${reqQual} qualified referrals. Current: ${stats.qualifiedCount}.`);
    }

    const claimId = `claim_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    await db.withTransaction(async (client) => {
      await client.query(`
        INSERT INTO giveaway_claims (id, giveaway_id, user_id, status, claimed_at)
        VALUES ($1, $2, $3, 'PENDING', CURRENT_TIMESTAMP)
      `, [claimId, giveawayId, userId]);

      await client.query(`
        UPDATE giveaways
        SET claims_count = claims_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [giveawayId]);
    });

    await this.invalidateCaches();
    logger.info('Giveaway claimed by user', { giveawayId, userId, claimId });

    return {
      success: true,
      claimId,
      message: 'Giveaway claimed successfully! Our automated system is dispatching your reward.',
    };
  }

  /**
   * Admin creates a fully database-configurable giveaway (no hardcoded products).
   */
  public async createGiveaway(params: GiveawayCreateInput, adminId: string): Promise<string> {
    const title = params.title.trim();
    if (!title) throw new Error('Giveaway name cannot be empty.');
    if (!params.rewardProductId) throw new Error('Reward product must be selected.');

    const product = await db.queryRow<any>('SELECT id, original_name FROM supplier_products WHERE id = $1', [params.rewardProductId]);
    if (!product) {
      throw new Error(`Reward product ${params.rewardProductId} does not exist in synced catalogue.`);
    }

    const id = `gw_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const qty = Math.max(1, Number(params.rewardQuantity || 1));
    const reqTotal = Math.max(0, Number(params.requiredTotalReferrals || 0));
    const reqQual = Math.max(0, Number(params.requiredQualifiedReferrals ?? 5));
    const claimLimit = Math.max(1, Number(params.claimLimit || 100));
    const isActive = params.isActive !== false;
    const isPublic = params.isPublic !== false;

    await db.query(`
      INSERT INTO giveaways (
        id, title, description, reward_product_id, reward_label, reward_quantity,
        required_total_referrals, required_qualified_referrals,
        start_at, end_at, is_active, is_public, claim_limit,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      id,
      title,
      params.description || '',
      params.rewardProductId,
      product.original_name,
      qty,
      reqTotal,
      reqQual,
      params.startAt ? new Date(params.startAt) : null,
      params.endAt ? new Date(params.endAt) : null,
      isActive,
      isPublic,
      claimLimit,
    ]);

    await db.query(`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
      VALUES ($1, $2, 'CREATE_GIVEAWAY', 'giveaway', $3, $4)
    `, [
      `log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
      adminId,
      id,
      JSON.stringify({ title, rewardProductId: params.rewardProductId, reqTotal, reqQual, claimLimit, isActive, isPublic }),
    ]);

    await this.invalidateCaches();
    return id;
  }

  public async updateGiveaway(giveawayId: string, patch: GiveawayUpdatePatch, adminId: string): Promise<GiveawayItem> {
    const existing = await this.getGiveawayById(giveawayId);
    if (!existing) throw new Error(`Giveaway ${giveawayId} not found.`);

    let rewardLabel: string | undefined;
    if (patch.rewardProductId !== undefined) {
      const prod = await db.queryRow<any>('SELECT id, original_name FROM supplier_products WHERE id = $1', [patch.rewardProductId]);
      if (!prod) throw new Error(`Reward product ${patch.rewardProductId} not found.`);
      rewardLabel = prod.original_name;
    }

    const next = {
      title: patch.title !== undefined ? patch.title.trim() : existing.title,
      description: patch.description !== undefined ? patch.description : existing.description,
      rewardProductId: patch.rewardProductId !== undefined ? patch.rewardProductId : existing.rewardProductId,
      rewardQuantity: patch.rewardQuantity !== undefined ? Math.max(1, Number(patch.rewardQuantity)) : existing.rewardQuantity,
      requiredTotalReferrals: patch.requiredTotalReferrals !== undefined ? Math.max(0, Number(patch.requiredTotalReferrals)) : existing.requiredTotalReferrals,
      requiredQualifiedReferrals: patch.requiredQualifiedReferrals !== undefined ? Math.max(0, Number(patch.requiredQualifiedReferrals)) : existing.requiredQualifiedReferrals,
      startAt: patch.startAt !== undefined ? (patch.startAt ? new Date(patch.startAt) : null) : (existing.startAt ? new Date(existing.startAt) : null),
      endAt: patch.endAt !== undefined ? (patch.endAt ? new Date(patch.endAt) : null) : (existing.endAt ? new Date(existing.endAt) : null),
      isActive: patch.isActive !== undefined ? Boolean(patch.isActive) : existing.isActive,
      isPublic: patch.isPublic !== undefined ? Boolean(patch.isPublic) : existing.isPublic,
      claimLimit: patch.claimLimit !== undefined ? Math.max(1, Number(patch.claimLimit)) : existing.claimLimit,
    };

    await db.query(
      `UPDATE giveaways
       SET title = $1,
           description = $2,
           reward_product_id = $3,
           reward_label = COALESCE($4, reward_label),
           reward_quantity = $5,
           required_total_referrals = $6,
           required_qualified_referrals = $7,
           start_at = $8,
           end_at = $9,
           is_active = $10,
           is_public = $11,
           claim_limit = $12,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $13`,
      [
        next.title,
        next.description,
        next.rewardProductId,
        rewardLabel || null,
        next.rewardQuantity,
        next.requiredTotalReferrals,
        next.requiredQualifiedReferrals,
        next.startAt,
        next.endAt,
        next.isActive,
        next.isPublic,
        next.claimLimit,
        giveawayId,
      ]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'UPDATE_GIVEAWAY', 'giveaway', $3, $4)`,
      [`log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, adminId, giveawayId, JSON.stringify(patch)]
    );

    await this.invalidateCaches();
    return (await this.getGiveawayById(giveawayId))!;
  }

  public async setGiveawayActive(giveawayId: string, isActive: boolean, adminId: string): Promise<GiveawayItem> {
    return await this.updateGiveaway(giveawayId, { isActive }, adminId);
  }

  public async deleteGiveaway(giveawayId: string, adminId: string): Promise<boolean> {
    const existing = await this.getGiveawayById(giveawayId);
    if (!existing) return false;

    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM giveaway_claims WHERE giveaway_id = $1', [giveawayId]);
      await client.query('DELETE FROM giveaways WHERE id = $1', [giveawayId]);
    });

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'DELETE_GIVEAWAY', 'giveaway', $3, $4)`,
      [
        `log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        giveawayId,
        JSON.stringify({ title: existing.title }),
      ]
    );

    await this.invalidateCaches();
    return true;
  }

  public async getSettings(): Promise<{ enabled: boolean; defaultClaimLimit: number; notifyAdminOnClaim: boolean }> {
    try {
      const cached = await redis.get(this.cfgCacheKey);
      if (cached) return JSON.parse(cached);
    } catch {
      // Cache miss
    }

    const row = await db.queryRow<any>("SELECT value FROM system_settings WHERE key = 'giveaway_config'");
    const val = typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value || {};
    const cfg = {
      enabled: val.enabled !== false,
      defaultClaimLimit: Number(val.defaultClaimLimit || 100),
      notifyAdminOnClaim: val.notifyAdminOnClaim !== false,
    };
    await redis.set(this.cfgCacheKey, JSON.stringify(cfg), 60).catch(() => {});
    return cfg;
  }

  public async updateSettings(
    patch: Partial<{ enabled: boolean; defaultClaimLimit: number; notifyAdminOnClaim: boolean }>,
    adminId: string
  ) {
    const curr = await this.getSettings();
    const next = {
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : curr.enabled,
      defaultClaimLimit: patch.defaultClaimLimit !== undefined ? Math.max(1, Number(patch.defaultClaimLimit)) : curr.defaultClaimLimit,
      notifyAdminOnClaim: patch.notifyAdminOnClaim !== undefined ? Boolean(patch.notifyAdminOnClaim) : curr.notifyAdminOnClaim,
    };
    await db.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('giveaway_config', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify(next)]
    );
    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'UPDATE_GIVEAWAY_SETTINGS', 'system_settings', 'giveaway_config', $3)`,
      [`log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, adminId, JSON.stringify(next)]
    );
    await this.invalidateCaches();
    return next;
  }
}

export const giveawayService = new GiveawayService();
