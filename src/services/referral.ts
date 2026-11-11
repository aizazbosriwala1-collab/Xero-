import Decimal from 'decimal.js';
import { db } from '../db/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('ReferralService');

export interface ReferralStats {
  referralCode: string;
  referralLink: string;
  totalReferred: number;
  qualifiedCount: number;
  pendingCount: number;
}

export class ReferralService {
  /**
   * Register a new referral relationship when a new user joins with ?start=ref_<referrerTelegramId>
   */
  public async registerReferral(referrerTelegramId: string | number, referredTelegramId: string | number): Promise<boolean> {
    const referrerId = String(referrerTelegramId);
    const referredId = String(referredTelegramId);

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

    // 3. Register referral relationship (unique constraint prevents multiple referrers for one user)
    try {
      const referralId = `ref_${referrerId}_${referredId}`;
      await db.query(`
        INSERT INTO referrals (id, referrer_id, referred_id, status, created_at, updated_at)
        VALUES ($1, $2, $3, 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (referred_id) DO NOTHING
      `, [referralId, referrerId, referredId]);

      logger.info('Registered referral relationship', { referrerId, referredId });
      return true;
    } catch (err: any) {
      logger.warn('Referral registration failed', { error: err.message });
      return false;
    }
  }

  /**
   * Check and qualify a referral when a user makes a successful purchase.
   * A referral qualifies only once, backed by unique referral_qualifications table.
   */
  public async processOrderQualification(referredUserId: string, orderId: string, orderTotal: Decimal): Promise<void> {
    const settingsRow = await db.queryRow<any>("SELECT value FROM system_settings WHERE key = 'referral_rules'");
    const settings = settingsRow?.value || {};
    const minOrderUsdt = new Decimal(settings.minQualifyingOrderUsdt || '0.50');

    if (orderTotal.lessThan(minOrderUsdt)) {
      logger.info('Order total does not meet referral qualification threshold', { orderTotal: orderTotal.toFixed(2), minOrderUsdt: minOrderUsdt.toFixed(2) });
      return;
    }

    // Find pending referral
    const referral = await db.queryRow<any>(
      "SELECT id, referrer_id, status FROM referrals WHERE referred_id = $1 AND status = 'PENDING'",
      [referredUserId]
    );

    if (!referral) {
      return; // No pending referral for this user
    }

    try {
      await db.withTransaction(async (client) => {
        // Mark referral as QUALIFIED
        await client.query("UPDATE referrals SET status = 'QUALIFIED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [referral.id]);

        // Insert qualification record linking to this specific qualifying order (unique constraints prevent replay)
        await client.query(`
          INSERT INTO referral_qualifications (id, referral_id, qualifying_order_id, qualified_at)
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        `, [`rq_${Date.now()}`, referral.id, orderId]);

        logger.info('Referral successfully qualified by order', {
          referralId: referral.id,
          referrerId: referral.referrer_id,
          referredUserId,
          orderId,
        });
      });
    } catch (err: any) {
      logger.warn('Failed to qualify referral (possibly already qualified)', { error: err.message, referralId: referral.id });
    }
  }

  /**
   * Get customer referral stats
   */
  public async getStats(userId: string, botUsername: string = 'XeroKhanBot'): Promise<ReferralStats> {
    const totalRes = await db.queryRow<{ count: string }>(
      'SELECT COUNT(*) as count FROM referrals WHERE referrer_id = $1',
      [userId]
    );
    const qualifiedRes = await db.queryRow<{ count: string }>(
      "SELECT COUNT(*) as count FROM referrals WHERE referrer_id = $1 AND status = 'QUALIFIED'",
      [userId]
    );
    const pendingRes = await db.queryRow<{ count: string }>(
      "SELECT COUNT(*) as count FROM referrals WHERE referrer_id = $1 AND status = 'PENDING'",
      [userId]
    );

    const totalReferred = parseInt(totalRes?.count || '0', 10);
    const qualifiedCount = parseInt(qualifiedRes?.count || '0', 10);
    const pendingCount = parseInt(pendingRes?.count || '0', 10);

    const referralLink = `https://t.me/${botUsername}?start=ref_${userId}`;

    return {
      referralCode: userId,
      referralLink,
      totalReferred,
      qualifiedCount,
      pendingCount,
    };
  }
}

export const referralService = new ReferralService();
