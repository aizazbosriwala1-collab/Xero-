import Decimal from 'decimal.js';
import { db } from '../db/index.js';
import { redis } from './redis.js';
import { walletService } from './wallet.js';
import { createLogger } from './logger.js';

const logger = createLogger('ReferralService');

export interface ReferralStats {
  referralCode: string;
  referralLink: string;
  totalReferred: number;
  qualifiedCount: number;
  pendingCount: number;
}

export interface ReferralRewardTier {
  id: string;
  title: string;
  description: string;
  requiredQualifiedReferrals: number;
  rewardType: 'WALLET_USDT' | 'PRODUCT';
  rewardProductId: string | null;
  rewardProductName: string | null;
  rewardAmount: string;
  rewardQuantity: number;
  isActive: boolean;
  userClaimed?: boolean;
  userEligible?: boolean;
}

export interface ReferralSettings {
  minQualifyingOrderUsdt: string;
  rewardPercentage: string;
  rewardsEnabled: boolean;
}

export class ReferralService {
  private readonly settingsCacheKey = 'sys:referral_rules';
  private readonly tiersCacheActiveKey = 'ref:tiers:active';
  private readonly tiersCacheAllKey = 'ref:tiers:all';

  private statsCacheKey(userId: string): string {
    return `ref:stats:${userId}`;
  }

  public async invalidateStatsCache(userId: string): Promise<void> {
    await redis.del(this.statsCacheKey(String(userId))).catch(() => {});
  }

  /**
   * Register a new referral relationship when a new user joins with ?start=ref_<referrerTelegramId>.
   * Enforces: no self-referral, no circular referral, no duplicate referral, no rejoin abuse.
   * Rule preserved: Referral join increments Total Referrals once; Qualified Referrals increments ONLY after COMPLETED purchase.
   */
  public async registerReferral(referrerTelegramId: string | number, referredTelegramId: string | number): Promise<boolean> {
    const referrerId = String(referrerTelegramId).trim();
    const referredId = String(referredTelegramId).trim();

    if (!referrerId || !referredId) {
      return false;
    }

    // 1. Prevent self-referral
    if (referrerId === referredId) {
      logger.warn('Self-referral rejected', { referrerId, referredId });
      return false;
    }

    // 2. Prevent circular referral (if referred user was already the referrer of the first user)
    const circular = await db.queryRow<any>(
      'SELECT id FROM referrals WHERE referrer_id = $1 AND referred_id = $2',
      [referredId, referrerId]
    );
    if (circular) {
      logger.warn('Circular referral rejected', { referrerId, referredId });
      return false;
    }

    // 3. Prevent duplicate referral counting (same Telegram account must NEVER count twice)
    const alreadyReferred = await db.queryRow<any>(
      'SELECT id, referrer_id FROM referrals WHERE referred_id = $1',
      [referredId]
    );
    if (alreadyReferred) {
      logger.info('Duplicate referral attempt ignored (user already referred)', { referrerId, referredId });
      return false;
    }

    // 4. Prevent rejoin abuse (existing user with prior activity/history re-clicking a referral link)
    const [priorOrder, priorDeposit, existingUser] = await Promise.all([
      db.queryRow<any>('SELECT id FROM local_orders WHERE user_id = $1 LIMIT 1', [referredId]),
      db.queryRow<any>('SELECT id FROM deposits WHERE user_id = $1 LIMIT 1', [referredId]),
      db.queryRow<{ created_at: string | Date }>('SELECT created_at FROM users WHERE id = $1', [referredId]),
    ]);
    if (priorOrder || priorDeposit) {
      logger.warn('Rejoin referral abuse rejected (existing account activity)', { referrerId, referredId });
      return false;
    }
    if (existingUser?.created_at) {
      const ageMs = Date.now() - new Date(existingUser.created_at).getTime();
      if (ageMs > 120_000) {
        logger.warn('Rejoin referral abuse rejected (existing pre-established user)', { referrerId, referredId });
        return false;
      }
    }

    // 5. Register referral relationship atomically with UNIQUE(referred_id) guard
    try {
      const referralId = `ref_${referrerId}_${referredId}`;
      const res = await db.query<{ id: string }>(
        `INSERT INTO referrals (id, referrer_id, referred_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (referred_id) DO NOTHING
         RETURNING id`,
        [referralId, referrerId, referredId]
      );

      if (res.rows.length === 0) {
        return false;
      }

      await this.invalidateStatsCache(referrerId);
      logger.info('Registered referral relationship', { referrerId, referredId });
      return true;
    } catch (err: any) {
      logger.warn('Referral registration failed', { error: err.message });
      return false;
    }
  }

  /**
   * Check and qualify a referral when a user makes a successful COMPLETED purchase.
   * A referral qualifies only once, backed by unique referral_qualifications table.
   */
  public async processOrderQualification(referredUserId: string, orderId: string, orderTotal: Decimal): Promise<void> {
    const settings = await this.getSettings();
    const minOrderUsdt = new Decimal(settings.minQualifyingOrderUsdt || '0.50');

    if (orderTotal.lessThan(minOrderUsdt)) {
      logger.info('Order total does not meet referral qualification threshold', {
        orderTotal: orderTotal.toFixed(2),
        minOrderUsdt: minOrderUsdt.toFixed(2),
      });
      return;
    }

    // Only completed orders qualify
    const order = await db.queryRow<any>('SELECT status FROM local_orders WHERE id = $1', [orderId]);
    if (order && order.status !== 'COMPLETED' && order.status !== 'PENDING_INVITE') {
      logger.info('Order did not reach COMPLETED status; referral remains PENDING', { orderId, status: order.status });
      return;
    }

    // Find pending referral
    const referral = await db.queryRow<any>(
      "SELECT id, referrer_id, status FROM referrals WHERE referred_id = $1 AND status = 'PENDING'",
      [referredUserId]
    );

    if (!referral) {
      return;
    }

    try {
      await db.withTransaction(async (client) => {
        await client.query("UPDATE referrals SET status = 'QUALIFIED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [referral.id]);

        await client.query(`
          INSERT INTO referral_qualifications (id, referral_id, qualifying_order_id, qualified_at)
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        `, [`rq_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, referral.id, orderId]);

        logger.info('Referral successfully qualified by completed order', {
          referralId: referral.id,
          referrerId: referral.referrer_id,
          referredUserId,
          orderId,
        });
      });

      await this.invalidateStatsCache(referral.referrer_id);
    } catch (err: any) {
      logger.warn('Failed to qualify referral (possibly already qualified)', { error: err.message, referralId: referral.id });
    }
  }

  /**
   * Get customer referral stats in a single aggregated SQL query, Redis-cached 60s and invalidated on joins/purchases.
   */
  public async getStats(
    userId: string,
    botUsername: string = 'XeroKhanBot',
    options?: { bypassCache?: boolean }
  ): Promise<ReferralStats> {
    const cacheKey = this.statsCacheKey(userId);
    if (!options?.bypassCache) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as { totalReferred: number; qualifiedCount: number; pendingCount: number };
          return {
            referralCode: userId,
            referralLink: `https://t.me/${botUsername}?start=ref_${userId}`,
            totalReferred: parsed.totalReferred,
            qualifiedCount: parsed.qualifiedCount,
            pendingCount: parsed.pendingCount,
          };
        }
      } catch {
        // Cache miss
      }
    }

    const agg = await db.queryRow<{
      total: string;
      qualified: string;
      pending: string;
    }>(
      `SELECT COUNT(*) as total,
              COALESCE(SUM(CASE WHEN status = 'QUALIFIED' THEN 1 ELSE 0 END), 0) as qualified,
              COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0) as pending
       FROM referrals
       WHERE referrer_id = $1`,
      [userId]
    );

    const totalReferred = parseInt(agg?.total || '0', 10);
    const qualifiedCount = parseInt(agg?.qualified || '0', 10);
    const pendingCount = parseInt(agg?.pending || '0', 10);

    await redis.set(cacheKey, JSON.stringify({ totalReferred, qualifiedCount, pendingCount }), 60).catch(() => {});

    return {
      referralCode: userId,
      referralLink: `https://t.me/${botUsername}?start=ref_${userId}`,
      totalReferred,
      qualifiedCount,
      pendingCount,
    };
  }

  private async invalidateCaches(): Promise<void> {
    await Promise.all([
      redis.del(this.settingsCacheKey).catch(() => {}),
      redis.del(this.tiersCacheActiveKey).catch(() => {}),
      redis.del(this.tiersCacheAllKey).catch(() => {}),
    ]);
  }

  public async getSettings(): Promise<ReferralSettings> {
    try {
      const cached = await redis.get(this.settingsCacheKey);
      if (cached) return JSON.parse(cached) as ReferralSettings;
    } catch {
      // Cache miss
    }

    const row = await db.queryRow<any>("SELECT value FROM system_settings WHERE key = 'referral_rules'");
    const val = typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value || {};
    const cfg: ReferralSettings = {
      minQualifyingOrderUsdt: String(val.minQualifyingOrderUsdt || '1.00'),
      rewardPercentage: String(val.rewardPercentage || '0.05'),
      rewardsEnabled: val.rewardsEnabled !== false,
    };
    await redis.set(this.settingsCacheKey, JSON.stringify(cfg), 60).catch(() => {});
    return cfg;
  }

  public async updateSettings(patch: Partial<ReferralSettings>, adminId: string): Promise<ReferralSettings> {
    const curr = await this.getSettings();
    const next: ReferralSettings = {
      minQualifyingOrderUsdt:
        patch.minQualifyingOrderUsdt !== undefined
          ? new Decimal(patch.minQualifyingOrderUsdt).toFixed(2)
          : curr.minQualifyingOrderUsdt,
      rewardPercentage:
        patch.rewardPercentage !== undefined
          ? new Decimal(patch.rewardPercentage).toFixed(4)
          : curr.rewardPercentage,
      rewardsEnabled: patch.rewardsEnabled !== undefined ? Boolean(patch.rewardsEnabled) : curr.rewardsEnabled,
    };

    await db.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('referral_rules', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify(next)]
    );
    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'UPDATE_REFERRAL_SETTINGS', 'system_settings', 'referral_rules', $3)`,
      [`log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, adminId, JSON.stringify(next)]
    );
    await this.invalidateCaches();
    return next;
  }

  // =========================================================================
  // ADMIN-CONFIGURABLE REFERRAL REWARD TIERS (Zero Hardcoded Milestones)
  // =========================================================================

  public async listRewardTiers(options?: {
    activeOnly?: boolean;
    userId?: string;
    knownQualifiedCount?: number;
  }): Promise<ReferralRewardTier[]> {
    const activeOnly = Boolean(options?.activeOnly);
    const cacheKey = activeOnly ? this.tiersCacheActiveKey : this.tiersCacheAllKey;
    let rawRows: any[] | null = null;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) rawRows = JSON.parse(cached);
    } catch {
      // Cache miss
    }

    if (!rawRows) {
      const whereClause = activeOnly ? 'WHERE rt.is_active = TRUE' : '';
      const res = await db.query<any>(`
        SELECT rt.id, rt.title, rt.description,
               rt.required_qualified_referrals as "requiredQualifiedReferrals",
               rt.reward_type as "rewardType",
               rt.reward_product_id as "rewardProductId",
               COALESCE(po.display_name_override, sp.original_name) as "rewardProductName",
               rt.reward_amount as "rewardAmount",
               rt.reward_quantity as "rewardQuantity",
               rt.is_active as "isActive"
        FROM referral_reward_tiers rt
        LEFT JOIN supplier_products sp ON rt.reward_product_id = sp.id
        LEFT JOIN product_overrides po ON rt.reward_product_id = po.product_id
        ${whereClause}
        ORDER BY rt.required_qualified_referrals ASC, rt.created_at ASC
      `);
      rawRows = res.rows;
      await redis.set(cacheKey, JSON.stringify(rawRows), 60).catch(() => {});
    }

    let qualifiedCount = options?.knownQualifiedCount ?? 0;
    const claimedSet = new Set<string>();
    if (options?.userId) {
      const [stats, claims] = await Promise.all([
        options.knownQualifiedCount !== undefined ? Promise.resolve(null) : this.getStats(options.userId),
        db.query<{ tier_id: string }>('SELECT tier_id FROM referral_reward_claims WHERE user_id = $1', [options.userId]),
      ]);
      if (stats) qualifiedCount = stats.qualifiedCount;
      for (const c of claims.rows) claimedSet.add(c.tier_id);
    }

    return rawRows.map(r => {
      const req = Number(r.requiredQualifiedReferrals || 0);
      const userClaimed = options?.userId ? claimedSet.has(r.id) : undefined;
      const userEligible = options?.userId ? qualifiedCount >= req && !userClaimed : undefined;
      return {
        id: r.id,
        title: r.title,
        description: r.description || '',
        requiredQualifiedReferrals: req,
        rewardType: (r.rewardType || 'WALLET_USDT') as 'WALLET_USDT' | 'PRODUCT',
        rewardProductId: r.rewardProductId || null,
        rewardProductName: r.rewardProductName || null,
        rewardAmount: new Decimal(r.rewardAmount || 0).toFixed(2),
        rewardQuantity: Number(r.rewardQuantity || 1),
        isActive: Boolean(r.isActive),
        userClaimed,
        userEligible,
      };
    });
  }

  public async getRewardTierById(tierId: string): Promise<ReferralRewardTier | null> {
    const all = await this.listRewardTiers({ activeOnly: false });
    return all.find(t => t.id === tierId) || null;
  }

  public async createRewardTier(
    params: {
      title: string;
      description?: string;
      requiredQualifiedReferrals: number;
      rewardType: 'WALLET_USDT' | 'PRODUCT';
      rewardAmount?: string | number;
      rewardProductId?: string | null;
      rewardQuantity?: number;
      isActive?: boolean;
    },
    adminId: string
  ): Promise<string> {
    const title = params.title.trim();
    if (!title) throw new Error('Tier title is required.');
    const reqQual = Math.max(1, Number(params.requiredQualifiedReferrals || 1));

    if (params.rewardType === 'WALLET_USDT') {
      const amt = new Decimal(params.rewardAmount || 0);
      if (amt.lessThanOrEqualTo(0)) {
        throw new Error('Wallet USDT reward amount must be greater than 0.');
      }
    } else if (params.rewardType === 'PRODUCT') {
      if (!params.rewardProductId) throw new Error('Product reward requires a product ID.');
      const prod = await db.queryRow<any>('SELECT id FROM supplier_products WHERE id = $1', [params.rewardProductId]);
      if (!prod) throw new Error(`Product ${params.rewardProductId} not found.`);
    }

    const id = `rft_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    await db.query(
      `INSERT INTO referral_reward_tiers (
        id, title, description, required_qualified_referrals,
        reward_type, reward_product_id, reward_amount, reward_quantity,
        is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        id,
        title,
        params.description || '',
        reqQual,
        params.rewardType,
        params.rewardProductId || null,
        params.rewardType === 'WALLET_USDT' ? new Decimal(params.rewardAmount || 0).toFixed(4) : '0.0000',
        Math.max(1, Number(params.rewardQuantity || 1)),
        params.isActive !== false,
      ]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'CREATE_REFERRAL_TIER', 'referral_reward_tiers', $3, $4)`,
      [`log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, adminId, id, JSON.stringify(params)]
    );

    await this.invalidateCaches();
    return id;
  }

  public async updateRewardTier(
    tierId: string,
    patch: Partial<{
      title: string;
      description: string;
      requiredQualifiedReferrals: number;
      rewardType: 'WALLET_USDT' | 'PRODUCT';
      rewardAmount: string | number;
      rewardProductId: string | null;
      rewardQuantity: number;
      isActive: boolean;
    }>,
    adminId: string
  ): Promise<ReferralRewardTier> {
    const existing = await this.getRewardTierById(tierId);
    if (!existing) throw new Error(`Referral reward tier ${tierId} not found.`);

    const nextType = patch.rewardType ?? existing.rewardType;
    const nextTitle = patch.title !== undefined ? patch.title.trim() : existing.title;
    const nextDesc = patch.description !== undefined ? patch.description : existing.description;
    const nextReq = patch.requiredQualifiedReferrals !== undefined
      ? Math.max(1, Number(patch.requiredQualifiedReferrals))
      : existing.requiredQualifiedReferrals;
    const nextAmt = patch.rewardAmount !== undefined
      ? new Decimal(patch.rewardAmount).toFixed(4)
      : new Decimal(existing.rewardAmount).toFixed(4);
    const nextProdId = patch.rewardProductId !== undefined ? patch.rewardProductId : existing.rewardProductId;
    const nextQty = patch.rewardQuantity !== undefined ? Math.max(1, Number(patch.rewardQuantity)) : existing.rewardQuantity;
    const nextActive = patch.isActive !== undefined ? Boolean(patch.isActive) : existing.isActive;

    await db.query(
      `UPDATE referral_reward_tiers
       SET title = $1,
           description = $2,
           required_qualified_referrals = $3,
           reward_type = $4,
           reward_product_id = $5,
           reward_amount = $6,
           reward_quantity = $7,
           is_active = $8,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9`,
      [nextTitle, nextDesc, nextReq, nextType, nextProdId, nextAmt, nextQty, nextActive, tierId]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'UPDATE_REFERRAL_TIER', 'referral_reward_tiers', $3, $4)`,
      [`log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, adminId, tierId, JSON.stringify(patch)]
    );

    await this.invalidateCaches();
    return (await this.getRewardTierById(tierId))!;
  }

  public async deleteRewardTier(tierId: string, adminId: string): Promise<boolean> {
    const existing = await this.getRewardTierById(tierId);
    if (!existing) return false;

    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM referral_reward_claims WHERE tier_id = $1', [tierId]);
      await client.query('DELETE FROM referral_reward_tiers WHERE id = $1', [tierId]);
    });

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'DELETE_REFERRAL_TIER', 'referral_reward_tiers', $3, $4)`,
      [
        `log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        tierId,
        JSON.stringify({ title: existing.title }),
      ]
    );
    await this.invalidateCaches();
    return true;
  }

  /**
   * Customer claims an eligible configured referral milestone reward.
   * Strictly checks qualified referrals (NOT pending joins) and enforces unique (tier_id, user_id).
   */
  public async claimRewardTier(tierId: string, userId: string): Promise<{
    success: boolean;
    message: string;
    rewardType: 'WALLET_USDT' | 'PRODUCT';
    creditedUsdt?: string;
  }> {
    const settings = await this.getSettings();
    if (!settings.rewardsEnabled) {
      throw new Error('Referral milestone rewards are temporarily paused by administrator.');
    }

    const tier = await this.getRewardTierById(tierId);
    if (!tier || !tier.isActive) {
      throw new Error('This referral reward tier is inactive or no longer exists.');
    }

    const stats = await this.getStats(userId, 'XeroKhanBot', { bypassCache: true });
    if (stats.qualifiedCount < tier.requiredQualifiedReferrals) {
      throw new Error(
        `You need ${tier.requiredQualifiedReferrals} qualified referrals to unlock "${tier.title}". Current qualified: ${stats.qualifiedCount}.`
      );
    }

    const existing = await db.queryRow<any>(
      'SELECT id FROM referral_reward_claims WHERE tier_id = $1 AND user_id = $2',
      [tierId, userId]
    );
    if (existing) {
      throw new Error('You have already claimed this referral reward tier.');
    }

    const claimId = `rfc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    await db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO referral_reward_claims (id, tier_id, user_id, status, reward_details, claimed_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [
          claimId,
          tierId,
          userId,
          tier.rewardType === 'WALLET_USDT' ? 'CREDITED' : 'PENDING_FULFILLMENT',
          JSON.stringify({
            title: tier.title,
            rewardType: tier.rewardType,
            rewardAmount: tier.rewardAmount,
            rewardProductId: tier.rewardProductId,
            rewardQuantity: tier.rewardQuantity,
          }),
        ]
      );

      if (tier.rewardType === 'WALLET_USDT' && new Decimal(tier.rewardAmount).greaterThan(0)) {
        await walletService.executeMutation({
          userId,
          amount: new Decimal(tier.rewardAmount),
          operationRef: `REF_TIER_${tierId}_${userId}`,
          idempotencyKey: `REF_TIER_${tierId}_${userId}`,
          entryType: 'REFERRAL_REWARD',
          reason: `Referral milestone reward: ${tier.title}`,
          source: 'REFERRAL_REWARD_TIER',
          actor: 'SYSTEM',
          metadata: { tierId, claimId, qualifiedCount: stats.qualifiedCount },
          client,
        });
      }
    });

    logger.info('Referral reward tier claimed', { tierId, userId, rewardType: tier.rewardType });

    if (tier.rewardType === 'WALLET_USDT') {
      return {
        success: true,
        rewardType: 'WALLET_USDT',
        creditedUsdt: tier.rewardAmount,
        message: `Reward claimed! ${tier.rewardAmount} USDT has been credited to your wallet.`,
      };
    }

    return {
      success: true,
      rewardType: 'PRODUCT',
      message: `Reward "${tier.title}" (${tier.rewardProductName || 'Product'} x${tier.rewardQuantity}) claimed! Dispatch is queued for fulfillment.`,
    };
  }
}

export const referralService = new ReferralService();
