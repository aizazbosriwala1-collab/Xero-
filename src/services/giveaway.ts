import { db } from '../db/index.js';
import { referralService } from './referral.js';
import { orderService } from './order.js';
import { createLogger } from './logger.js';

const logger = createLogger('GiveawayService');

export interface GiveawayItem {
  id: string;
  title: string;
  description: string;
  rewardProductId: string;
  rewardProductName: string;
  rewardQuantity: number;
  requiredQualifiedReferrals: number;
  isActive: boolean;
  claimLimit: number;
  claimsCount: number;
  userProgress?: {
    currentQualified: number;
    required: number;
    isEligible: boolean;
    hasClaimed: boolean;
    claimStatus?: 'PENDING' | 'FULFILLED' | 'REJECTED';
  };
}

export class GiveawayService {
  /**
   * Get active giveaways for customer display, annotated with user progress.
   */
  public async getActiveGiveaways(userId?: string): Promise<GiveawayItem[]> {
    const res = await db.query<any>(`
      SELECT g.id, g.title, g.description, g.reward_product_id as "rewardProductId",
             sp.original_name as "rewardProductName",
             g.reward_quantity as "rewardQuantity",
             g.required_qualified_referrals as "requiredQualifiedReferrals",
             g.is_active as "isActive", g.claim_limit as "claimLimit",
             g.claims_count as "claimsCount"
      FROM giveaways g
      LEFT JOIN supplier_products sp ON g.reward_product_id = sp.id
      WHERE g.is_active = TRUE
      ORDER BY g.created_at DESC
    `);

    let userQualifiedCount = 0;
    if (userId) {
      const stats = await referralService.getStats(userId);
      userQualifiedCount = stats.qualifiedCount;
    }

    const items: GiveawayItem[] = [];
    for (const r of res.rows) {
      let userProgress = undefined;
      if (userId) {
        const claim = await db.queryRow<any>(
          'SELECT status FROM giveaway_claims WHERE giveaway_id = $1 AND user_id = $2',
          [r.id, userId]
        );
        const hasClaimed = Boolean(claim);
        const isEligible = userQualifiedCount >= r.requiredQualifiedReferrals;
        userProgress = {
          currentQualified: userQualifiedCount,
          required: r.requiredQualifiedReferrals,
          isEligible,
          hasClaimed,
          claimStatus: claim?.status,
        };
      }

      items.push({
        id: r.id,
        title: r.title,
        description: r.description || '',
        rewardProductId: r.rewardProductId,
        rewardProductName: r.rewardProductName || 'Digital Tool Reward',
        rewardQuantity: r.rewardQuantity || 1,
        requiredQualifiedReferrals: r.requiredQualifiedReferrals,
        isActive: Boolean(r.isActive),
        claimLimit: r.claimLimit,
        claimsCount: r.claimsCount || 0,
        userProgress,
      });
    }

    return items;
  }

  /**
   * Customer claims a giveaway
   */
  public async claimGiveaway(giveawayId: string, userId: string, customerEmail?: string): Promise<{
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

    if (giveaway.claims_count >= giveaway.claimLimit) {
      throw new Error('The maximum claim limit for this giveaway has been reached.');
    }

    // Check existing claim
    const existingClaim = await db.queryRow<any>(
      'SELECT * FROM giveaway_claims WHERE giveaway_id = $1 AND user_id = $2',
      [giveawayId, userId]
    );
    if (existingClaim) {
      throw new Error('You have already claimed this giveaway reward.');
    }

    // Verify qualification
    const stats = await referralService.getStats(userId);
    if (stats.qualifiedCount < giveaway.required_qualified_referrals) {
      throw new Error(`You need at least ${giveaway.required_qualified_referrals} qualified referrals. Current: ${stats.qualifiedCount}.`);
    }

    const claimId = `claim_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    await db.withTransaction(async (client) => {
      // Record claim
      await client.query(`
        INSERT INTO giveaway_claims (id, giveaway_id, user_id, status, claimed_at)
        VALUES ($1, $2, $3, 'PENDING', CURRENT_TIMESTAMP)
      `, [claimId, giveawayId, userId]);

      // Increment claim count
      await client.query(`
        UPDATE giveaways
        SET claims_count = claims_count + 1
        WHERE id = $1
      `, [giveawayId]);
    });

    logger.info('Giveaway claimed by user', { giveawayId, userId, claimId });

    return {
      success: true,
      claimId,
      message: 'Giveaway claimed successfully! Our automated system is dispatching your reward.',
    };
  }

  /**
   * Admin creates a dynamic giveaway
   */
  public async createGiveaway(params: {
    title: string;
    description: string;
    rewardProductId: string;
    rewardQuantity: number;
    requiredQualifiedReferrals: number;
    claimLimit?: number;
  }, adminId: string): Promise<string> {
    const id = `gw_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    await db.query(`
      INSERT INTO giveaways (
        id, title, description, reward_product_id, reward_quantity,
        required_qualified_referrals, is_active, claim_limit, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      id,
      params.title,
      params.description,
      params.rewardProductId,
      params.rewardQuantity || 1,
      params.requiredQualifiedReferrals,
      params.claimLimit || 100,
    ]);

    await db.query(`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
      VALUES ($1, $2, 'CREATE_GIVEAWAY', 'giveaway', $3, $4)
    `, [`log_${Date.now()}`, adminId, id, JSON.stringify(params)]);

    return id;
  }
}

export const giveawayService = new GiveawayService();
