import Decimal from 'decimal.js';
import { db } from '../db/index.js';
import { redis } from './redis.js';
import { referralService } from './referral.js';
import { walletService } from './wallet.js';
import { createLogger } from './logger.js';

const logger = createLogger('GiveawayService');

export type GiveawayRewardType = 'STORE_PRODUCT' | 'CUSTOM_PRODUCT' | 'WALLET_CREDIT';

export interface GiveawayItem {
  id: string;
  title: string;
  description: string;
  rewardType: GiveawayRewardType;
  rewardProductId: string;
  rewardProductName: string;
  rewardLabel: string;
  rewardAmountUsdt: string;
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
  rewardType?: GiveawayRewardType;
  rewardProductId?: string | null;
  rewardLabel?: string | null;
  rewardAmountUsdt?: string | number | null;
  rewardQuantity?: number;
  requiredTotalReferrals?: number;
  requiredQualifiedReferrals?: number;
  startAt?: string | null;
  endAt?: string | null;
  isActive?: boolean;
  isPublic?: boolean;
  claimLimit?: number;
}

export interface GiveawayUpdatePatch {
  title?: string;
  description?: string;
  rewardType?: GiveawayRewardType;
  rewardProductId?: string | null;
  rewardLabel?: string | null;
  rewardAmountUsdt?: string | number | null;
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
    const rewardType: GiveawayRewardType =
      r.rewardType === 'CUSTOM_PRODUCT' || r.rewardType === 'WALLET_CREDIT' || r.rewardType === 'STORE_PRODUCT'
        ? r.rewardType
        : r.rewardProductId
        ? 'STORE_PRODUCT'
        : Number(r.rewardAmountUsdt || 0) > 0
        ? 'WALLET_CREDIT'
        : 'CUSTOM_PRODUCT';

    const rewardAmountUsdt = new Decimal(r.rewardAmountUsdt || 0).toFixed(2);
    const rawLabel = r.rewardLabel || '';
    const displayRewardName =
      rewardType === 'WALLET_CREDIT'
        ? `${rewardAmountUsdt} USDT Wallet Credit`
        : rewardType === 'CUSTOM_PRODUCT'
        ? rawLabel || r.rewardProductName || 'Custom Reward'
        : r.rewardProductName || rawLabel || 'Digital Tool Reward';

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
      rewardType,
      rewardProductId: r.rewardProductId || '',
      rewardProductName: displayRewardName,
      rewardLabel: rawLabel || displayRewardName,
      rewardAmountUsdt,
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
   * Get active, public, currently-running giveaways for customer display (Redis-cached 60s),
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
        SELECT g.id, g.title, g.description,
               g.reward_type as "rewardType",
               g.reward_product_id as "rewardProductId",
               g.reward_label as "rewardLabel",
               g.reward_amount_usdt as "rewardAmountUsdt",
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
      await redis.set(this.activeRawCacheKey, JSON.stringify(rawRows), 60).catch(() => {});
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
      SELECT g.id, g.title, g.description,
             g.reward_type as "rewardType",
             g.reward_product_id as "rewardProductId",
             g.reward_label as "rewardLabel",
             g.reward_amount_usdt as "rewardAmountUsdt",
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
      SELECT g.id, g.title, g.description,
             g.reward_type as "rewardType",
             g.reward_product_id as "rewardProductId",
             g.reward_label as "rewardLabel",
             g.reward_amount_usdt as "rewardAmountUsdt",
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
   * Customer claims a giveaway (supports Store Product, Custom Product, and Wallet Credit rewards).
   */
  public async claimGiveaway(giveawayId: string, userId: string, _customerEmail?: string): Promise<{
    success: boolean;
    message: string;
    claimId?: string;
    rewardType?: GiveawayRewardType;
    creditedUsdt?: string;
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

    const stats = await referralService.getStats(userId, 'XeroKhanBot', { bypassCache: true });
    const reqTotal = Number(giveaway.required_total_referrals || 0);
    const reqQual = Number(giveaway.required_qualified_referrals || 0);

    if (reqTotal > 0 && stats.totalReferred < reqTotal) {
      throw new Error(`You need at least ${reqTotal} referrals (total required). Current: ${stats.totalReferred}.`);
    }
    if (reqQual > 0 && stats.qualifiedCount < reqQual) {
      throw new Error(`You need at least ${reqQual} qualified referrals. Current: ${stats.qualifiedCount}.`);
    }

    const rewardType: GiveawayRewardType =
      giveaway.reward_type === 'CUSTOM_PRODUCT' || giveaway.reward_type === 'WALLET_CREDIT' || giveaway.reward_type === 'STORE_PRODUCT'
        ? giveaway.reward_type
        : giveaway.reward_product_id
        ? 'STORE_PRODUCT'
        : Number(giveaway.reward_amount_usdt || 0) > 0
        ? 'WALLET_CREDIT'
        : 'CUSTOM_PRODUCT';

    const rewardAmountDec = new Decimal(giveaway.reward_amount_usdt || 0);
    const claimId = `claim_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const claimStatus = rewardType === 'WALLET_CREDIT' ? 'FULFILLED' : 'PENDING';

    await db.withTransaction(async (client) => {
      if (rewardType === 'WALLET_CREDIT') {
        if (rewardAmountDec.lessThanOrEqualTo(0)) {
          throw new Error('Giveaway wallet reward amount is misconfigured.');
        }
        await walletService.executeMutation({
          userId,
          amount: rewardAmountDec,
          operationRef: `GW_CLAIM_${giveawayId}_${userId}`,
          idempotencyKey: `GW_CLAIM_${giveawayId}_${userId}`,
          entryType: 'GIVEAWAY_REWARD',
          reason: `Giveaway reward: ${giveaway.title}`,
          source: 'GIVEAWAY_REWARD',
          actor: 'SYSTEM',
          metadata: { giveawayId, claimId, title: giveaway.title },
          client,
        });
      }

      await client.query(`
        INSERT INTO giveaway_claims (id, giveaway_id, user_id, status, claimed_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      `, [claimId, giveawayId, userId, claimStatus]);

      await client.query(`
        UPDATE giveaways
        SET claims_count = claims_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [giveawayId]);
    });

    await this.invalidateCaches();
    logger.info('Giveaway claimed by user', { giveawayId, userId, claimId, rewardType });

    if (rewardType === 'WALLET_CREDIT') {
      const credited = rewardAmountDec.toFixed(2);
      return {
        success: true,
        claimId,
        rewardType,
        creditedUsdt: credited,
        message: `Giveaway claimed! ${credited} USDT has been credited to your wallet.`,
      };
    }

    if (rewardType === 'CUSTOM_PRODUCT') {
      return {
        success: true,
        claimId,
        rewardType,
        message: `Giveaway claimed! Your reward (${giveaway.reward_label || giveaway.title}) has been recorded for delivery.`,
      };
    }

    return {
      success: true,
      claimId,
      rewardType,
      message: 'Giveaway claimed successfully! Our automated system is dispatching your reward.',
    };
  }

  /**
   * Admin creates a fully database-configurable giveaway:
   * - Store Product Reward (synced DB SKU)
   * - Custom Product Reward (arbitrary text label)
   * - Wallet Credit Reward (USDT amount)
   * Zero hardcoded limits on referral thresholds or labels.
   */
  public async createGiveaway(params: GiveawayCreateInput, adminId: string): Promise<string> {
    const title = params.title.trim();
    if (!title) throw new Error('Giveaway name cannot be empty.');

    const rewardType: GiveawayRewardType = params.rewardType
      ? params.rewardType
      : params.rewardProductId
      ? 'STORE_PRODUCT'
      : params.rewardAmountUsdt && Number(params.rewardAmountUsdt) > 0
      ? 'WALLET_CREDIT'
      : params.rewardLabel
      ? 'CUSTOM_PRODUCT'
      : 'STORE_PRODUCT';

    let rewardProductId: string | null = null;
    let rewardLabel = (params.rewardLabel || '').trim();
    let rewardAmountUsdt = new Decimal(params.rewardAmountUsdt || 0);

    if (rewardType === 'STORE_PRODUCT') {
      if (!params.rewardProductId) throw new Error('Store product reward requires selecting a product.');
      const product = await db.queryRow<any>('SELECT id, original_name FROM supplier_products WHERE id = $1', [params.rewardProductId]);
      if (!product) {
        throw new Error(`Reward product ${params.rewardProductId} does not exist in synced catalogue.`);
      }
      rewardProductId = product.id;
      rewardLabel = rewardLabel || product.original_name;
      rewardAmountUsdt = new Decimal(0);
    } else if (rewardType === 'CUSTOM_PRODUCT') {
      if (!rewardLabel) {
        throw new Error('Custom product reward name cannot be empty.');
      }
      rewardProductId = null;
      rewardAmountUsdt = new Decimal(0);
    } else if (rewardType === 'WALLET_CREDIT') {
      if (rewardAmountUsdt.isNaN() || rewardAmountUsdt.lessThanOrEqualTo(0)) {
        throw new Error('Wallet credit reward amount must be greater than 0 USDT.');
      }
      rewardProductId = null;
      rewardLabel = rewardLabel || `${rewardAmountUsdt.toFixed(2)} USDT Wallet Credit`;
    }

    const id = `gw_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const qty = Math.max(1, Number(params.rewardQuantity || 1));
    const reqTotal = Math.max(0, Number(params.requiredTotalReferrals ?? 0));
    const reqQual = Math.max(0, Number(params.requiredQualifiedReferrals ?? 0));
    const claimLimit = Math.max(1, Number(params.claimLimit || 100));
    const isActive = params.isActive !== false;
    const isPublic = params.isPublic !== false;

    await db.query(`
      INSERT INTO giveaways (
        id, title, description, reward_type, reward_product_id, reward_label, reward_amount_usdt, reward_quantity,
        required_total_referrals, required_qualified_referrals,
        start_at, end_at, is_active, is_public, claim_limit,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      id,
      title,
      params.description || '',
      rewardType,
      rewardProductId,
      rewardLabel,
      rewardAmountUsdt.toFixed(4),
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
      JSON.stringify({
        title,
        rewardType,
        rewardProductId,
        rewardLabel,
        rewardAmountUsdt: rewardAmountUsdt.toFixed(4),
        reqTotal,
        reqQual,
        claimLimit,
        isActive,
        isPublic,
      }),
    ]);

    await this.invalidateCaches();
    return id;
  }

  public async updateGiveaway(giveawayId: string, patch: GiveawayUpdatePatch, adminId: string): Promise<GiveawayItem> {
    const existing = await this.getGiveawayById(giveawayId);
    if (!existing) throw new Error(`Giveaway ${giveawayId} not found.`);

    const nextType: GiveawayRewardType = patch.rewardType ?? existing.rewardType;
    let nextProductId: string | null =
      patch.rewardProductId !== undefined ? patch.rewardProductId || null : existing.rewardProductId || null;
    let nextLabel: string =
      patch.rewardLabel !== undefined ? String(patch.rewardLabel || '').trim() : existing.rewardLabel;
    let nextAmount =
      patch.rewardAmountUsdt !== undefined
        ? new Decimal(patch.rewardAmountUsdt || 0)
        : new Decimal(existing.rewardAmountUsdt || 0);

    if (nextType === 'STORE_PRODUCT') {
      if (patch.rewardProductId !== undefined && patch.rewardProductId) {
        const prod = await db.queryRow<any>('SELECT id, original_name FROM supplier_products WHERE id = $1', [patch.rewardProductId]);
        if (!prod) throw new Error(`Reward product ${patch.rewardProductId} not found.`);
        nextLabel = prod.original_name;
      }
      nextAmount = new Decimal(0);
    } else if (nextType === 'CUSTOM_PRODUCT') {
      nextProductId = null;
      nextAmount = new Decimal(0);
      if (patch.rewardLabel !== undefined && !nextLabel) {
        throw new Error('Custom product reward name cannot be empty.');
      }
    } else if (nextType === 'WALLET_CREDIT') {
      nextProductId = null;
      if (patch.rewardAmountUsdt !== undefined) {
        if (nextAmount.isNaN() || nextAmount.lessThanOrEqualTo(0)) {
          throw new Error('Wallet credit reward amount must be greater than 0 USDT.');
        }
        if (patch.rewardLabel === undefined) {
          nextLabel = `${nextAmount.toFixed(2)} USDT Wallet Credit`;
        }
      }
    }

    const next = {
      title: patch.title !== undefined ? patch.title.trim() : existing.title,
      description: patch.description !== undefined ? patch.description : existing.description,
      rewardType: nextType,
      rewardProductId: nextProductId,
      rewardLabel: nextLabel,
      rewardAmountUsdt: nextAmount.toFixed(4),
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
           reward_type = $3,
           reward_product_id = $4,
           reward_label = $5,
           reward_amount_usdt = $6,
           reward_quantity = $7,
           required_total_referrals = $8,
           required_qualified_referrals = $9,
           start_at = $10,
           end_at = $11,
           is_active = $12,
           is_public = $13,
           claim_limit = $14,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $15`,
      [
        next.title,
        next.description,
        next.rewardType,
        next.rewardProductId,
        next.rewardLabel,
        next.rewardAmountUsdt,
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
