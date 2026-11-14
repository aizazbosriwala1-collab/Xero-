import Decimal from 'decimal.js';
import { db } from '../db/index.js';
import { redis } from './redis.js';
import { walletService } from './wallet.js';
import { createLogger } from './logger.js';

const logger = createLogger('ManualPaymentService');

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export interface ManualPaymentSubmission {
  userId: string;
  methodCode: 'EASYPAISA' | 'JAZZCASH';
  amount: Decimal | string | number;
  txid: string;
  proofFileId?: string;
}

export interface LocalManualDepositSubmission {
  userId: string;
  methodCode: 'EASYPAISA' | 'JAZZCASH';
  senderPhone: string;
  proofFileId: string;
  ocrText?: string;
  submittedPkrAmount?: string | number;
}

export interface PaymentMethodConfig {
  id: string;
  code: string;
  name: string;
  accountTitle: string;
  accountNumber: string;
  instructions: string;
  minAmount: string;
  maxAmount: string;
  isEnabled: boolean;
  proofRequired: boolean;
  reviewMessage: string;
}

export interface DepositSettings {
  pkrPerUsd: string;
  minPkr: string;
  maxPkr: string;
  allowCustomCredit: boolean;
  autoSuggestCredit: boolean;
}

export interface PendingManualDeposit {
  id: string;
  userId: string;
  username: string | null;
  firstName: string | null;
  methodCode: string;
  amount: string;
  txid: string | null;
  proofFileId: string | null;
  senderPhone: string | null;
  submittedPkrAmount: string | null;
  suggestedUsdAmount: string | null;
  failureReason: string | null;
  createdAt: string;
}

const DEFAULT_DEPOSIT_SETTINGS: DepositSettings = {
  pkrPerUsd: '290',
  minPkr: '30',
  maxPkr: '6000',
  allowCustomCredit: true,
  autoSuggestCredit: true,
};

export class ManualPaymentService {
  private readonly settingsCacheKey = 'deposit:settings';
  private readonly methodsCacheKeyAll = 'pm:list:all';
  private readonly methodsCacheKeyActive = 'pm:list:active';

  private async invalidateMethodCaches(): Promise<void> {
    await Promise.all([
      redis.del(this.methodsCacheKeyAll).catch(() => {}),
      redis.del(this.methodsCacheKeyActive).catch(() => {}),
    ]);
  }

  /**
   * Cached Exchange Rate & Local Deposit Settings (60s TTL in Redis)
   */
  public async getDepositSettings(): Promise<DepositSettings> {
    try {
      const cached = await redis.get(this.settingsCacheKey);
      if (cached) return JSON.parse(cached) as DepositSettings;
    } catch {
      // Cache miss
    }

    const row = await db.queryRow<any>("SELECT value FROM system_settings WHERE key = 'deposit_settings'");
    const val = typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value || {};
    const cfg: DepositSettings = {
      pkrPerUsd: new Decimal(val.pkrPerUsd || DEFAULT_DEPOSIT_SETTINGS.pkrPerUsd).toFixed(0),
      minPkr: new Decimal(val.minPkr || DEFAULT_DEPOSIT_SETTINGS.minPkr).toFixed(0),
      maxPkr: new Decimal(val.maxPkr || DEFAULT_DEPOSIT_SETTINGS.maxPkr).toFixed(0),
      allowCustomCredit: val.allowCustomCredit !== false,
      autoSuggestCredit: val.autoSuggestCredit !== false,
    };

    await redis.set(this.settingsCacheKey, JSON.stringify(cfg), 60).catch(() => {});
    return cfg;
  }

  public async updateDepositSettings(
    patch: Partial<DepositSettings>,
    adminId: string
  ): Promise<DepositSettings> {
    const curr = await this.getDepositSettings();

    const rate = patch.pkrPerUsd !== undefined ? new Decimal(patch.pkrPerUsd) : new Decimal(curr.pkrPerUsd);
    const minPkr = patch.minPkr !== undefined ? new Decimal(patch.minPkr) : new Decimal(curr.minPkr);
    const maxPkr = patch.maxPkr !== undefined ? new Decimal(patch.maxPkr) : new Decimal(curr.maxPkr);

    if (rate.isNaN() || rate.lessThanOrEqualTo(0)) {
      throw new Error('Exchange rate (PKR per 1 USD) must be greater than 0.');
    }
    if (minPkr.isNaN() || minPkr.lessThan(1)) {
      throw new Error('Minimum deposit (PKR) must be at least 1 PKR.');
    }
    if (maxPkr.isNaN() || maxPkr.lessThan(minPkr)) {
      throw new Error('Maximum deposit (PKR) must be greater than or equal to Minimum deposit.');
    }

    const next: DepositSettings = {
      pkrPerUsd: rate.toFixed(0),
      minPkr: minPkr.toFixed(0),
      maxPkr: maxPkr.toFixed(0),
      allowCustomCredit: patch.allowCustomCredit !== undefined ? Boolean(patch.allowCustomCredit) : curr.allowCustomCredit,
      autoSuggestCredit: patch.autoSuggestCredit !== undefined ? Boolean(patch.autoSuggestCredit) : curr.autoSuggestCredit,
    };

    await db.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('deposit_settings', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify(next)]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'UPDATE_DEPOSIT_SETTINGS', 'system_settings', 'deposit_settings', $3)`,
      [`log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, adminId, JSON.stringify(next)]
    );

    await redis.del(this.settingsCacheKey).catch(() => {});
    logger.info('Deposit settings updated', { adminId, next });
    return next;
  }

  /**
   * Normalize Pakistani mobile numbers (e.g. +92 300-1234567 -> 03001234567)
   */
  public normalizeSenderPhone(raw: string): string {
    const cleaned = String(raw || '').replace(/[\s\-().]/g, '').trim();
    if (!cleaned) {
      throw new Error('Please enter your sender phone number (example: 03001234567).');
    }

    let normalized = cleaned;
    if (normalized.startsWith('+92')) {
      normalized = `0${normalized.slice(3)}`;
    } else if (normalized.startsWith('92') && normalized.length >= 12) {
      normalized = `0${normalized.slice(2)}`;
    } else if (normalized.startsWith('3') && normalized.length === 10) {
      normalized = `0${normalized}`;
    }

    if (!/^\d{10,15}$/.test(normalized)) {
      throw new Error('Please send a valid phone number (example: 03001234567).');
    }

    return normalized;
  }

  /**
   * Extract optional PKR amount from receipt caption / OCR text (deterministic, zero external API calls)
   */
  public extractPkrAmountFromText(
    rawText: string | undefined,
    settings?: DepositSettings
  ): { pkrAmount: string; suggestedUsd: string } | null {
    if (!rawText) return null;
    const text = String(rawText).trim();
    if (!text) return null;

    // Match currency patterns like "Rs. 290", "PKR 1,450", "Rs 580.00", "290 PKR"
    const patterns = [
      /(?:pkr|rs\.?|rupees)\s*[:=]?\s*([\d,]+(?:\.\d{1,2})?)/i,
      /([\d,]+(?:\.\d{1,2})?)\s*(?:pkr|rs\.?|rupees)/i,
    ];

    let numStr: string | null = null;
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m && m[1]) {
        numStr = m[1].replace(/,/g, '');
        break;
      }
    }

    if (!numStr) return null;

    try {
      const pkrDec = new Decimal(numStr);
      const minDec = new Decimal(settings?.minPkr || DEFAULT_DEPOSIT_SETTINGS.minPkr);
      const maxDec = new Decimal(settings?.maxPkr || DEFAULT_DEPOSIT_SETTINGS.maxPkr);
      const rateDec = new Decimal(settings?.pkrPerUsd || DEFAULT_DEPOSIT_SETTINGS.pkrPerUsd);

      if (pkrDec.isNaN() || pkrDec.lessThan(minDec) || pkrDec.greaterThan(maxDec.times(10))) {
        return null;
      }

      const usdDec = pkrDec.dividedBy(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      return {
        pkrAmount: pkrDec.toFixed(2),
        suggestedUsd: usdDec.greaterThan(0) ? usdDec.toFixed(2) : '0.01',
      };
    } catch {
      return null;
    }
  }

  /**
   * Calculate suggested USD amount for a given PKR amount using live exchange rate.
   */
  public calculateSuggestedUsd(pkrAmount: string | number | Decimal, ratePerUsd: string | number | Decimal): string {
    const pkr = new Decimal(pkrAmount);
    const rate = new Decimal(ratePerUsd);
    if (pkr.lessThanOrEqualTo(0) || rate.lessThanOrEqualTo(0)) return '0.00';
    return pkr.dividedBy(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }

  /**
   * Get all active payment methods (cached 60s in Redis)
   */
  public async getPaymentMethods(includeDisabled = false): Promise<PaymentMethodConfig[]> {
    const cacheKey = includeDisabled ? this.methodsCacheKeyAll : this.methodsCacheKeyActive;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as PaymentMethodConfig[];
    } catch {
      // Cache miss
    }

    const where = includeDisabled ? '' : 'WHERE is_enabled = TRUE';
    const res = await db.query<any>(`
      SELECT id, code, name, account_title as "accountTitle",
             account_number as "accountNumber", instructions,
             min_amount as "minAmount", max_amount as "maxAmount",
             is_enabled as "isEnabled", proof_required as "proofRequired",
             review_message as "reviewMessage"
      FROM payment_methods
      ${where}
      ORDER BY code ASC
    `);

    await redis.set(cacheKey, JSON.stringify(res.rows), 60).catch(() => {});
    return res.rows;
  }

  /**
   * Get specific payment method by code (reads cached list first)
   */
  public async getMethodByCode(code: string): Promise<PaymentMethodConfig | null> {
    const norm = code.toUpperCase();
    const all = await this.getPaymentMethods(true);
    const hit = all.find(m => m.code.toUpperCase() === norm);
    if (hit) return hit;

    const res = await db.queryRow<any>(`
      SELECT id, code, name, account_title as "accountTitle",
             account_number as "accountNumber", instructions,
             min_amount as "minAmount", max_amount as "maxAmount",
             is_enabled as "isEnabled", proof_required as "proofRequired",
             review_message as "reviewMessage"
      FROM payment_methods
      WHERE code = $1
    `, [norm]);

    return res;
  }

  /**
   * Simplified local-customer manual deposit (Easypaisa / JazzCash):
   * Requires ONLY Screenshot (proofFileId) + Sender Phone Number.
   * No TXID or reference number required.
   */
  public async submitLocalDeposit(
    data: LocalManualDepositSubmission
  ): Promise<{
    depositId: string;
    status: string;
    senderPhone: string;
    submittedPkrAmount: string | null;
    suggestedUsdAmount: string | null;
  }> {
    const method = await this.getMethodByCode(data.methodCode);
    if (!method || !method.isEnabled) {
      throw new Error(`Payment method ${data.methodCode} is currently disabled or unavailable.`);
    }

    if (!data.proofFileId || !data.proofFileId.trim()) {
      throw new Error('Payment screenshot is required.');
    }

    const senderPhone = this.normalizeSenderPhone(data.senderPhone);
    const settings = await this.getDepositSettings();

    let submittedPkrAmount: string | null = null;
    let suggestedUsdAmount: string | null = null;

    if (data.submittedPkrAmount !== undefined && data.submittedPkrAmount !== null && String(data.submittedPkrAmount).trim() !== '') {
      const pkrDec = new Decimal(data.submittedPkrAmount);
      if (pkrDec.greaterThan(0)) {
        submittedPkrAmount = pkrDec.toFixed(2);
        if (settings.autoSuggestCredit) {
          suggestedUsdAmount = this.calculateSuggestedUsd(pkrDec, settings.pkrPerUsd);
        }
      }
    } else if (data.ocrText) {
      const parsed = this.extractPkrAmountFromText(data.ocrText, settings);
      if (parsed) {
        submittedPkrAmount = parsed.pkrAmount;
        if (settings.autoSuggestCredit) {
          suggestedUsdAmount = parsed.suggestedUsd;
        }
      }
    }

    const depositId = `dep_man_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    await db.query(
      `INSERT INTO deposits (
        id, user_id, payment_method_code, amount, currency, status,
        txid, proof_file_id, sender_phone, submitted_pkr_amount, suggested_usd_amount,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'USDT', 'PENDING_REVIEW', NULL, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        depositId,
        data.userId,
        data.methodCode,
        suggestedUsdAmount || '0.0000',
        data.proofFileId.trim(),
        senderPhone,
        submittedPkrAmount,
        suggestedUsdAmount,
      ]
    );

    logger.info('Simplified manual deposit submitted for admin review', {
      depositId,
      userId: data.userId,
      method: data.methodCode,
      senderPhone,
      submittedPkrAmount,
      suggestedUsdAmount,
    });

    return {
      depositId,
      status: 'PENDING_REVIEW',
      senderPhone,
      submittedPkrAmount,
      suggestedUsdAmount,
    };
  }

  /**
   * Legacy manual deposit submission (kept backwards-compatible for existing tests/callers)
   */
  public async submitDeposit(data: ManualPaymentSubmission): Promise<{ depositId: string; status: string; isDuplicateTxid: boolean }> {
    const method = await this.getMethodByCode(data.methodCode);
    if (!method || !method.isEnabled) {
      throw new Error(`Payment method ${data.methodCode} is currently disabled or unavailable.`);
    }

    const amountDec = new Decimal(data.amount);
    const minDec = new Decimal(method.minAmount);
    const maxDec = new Decimal(method.maxAmount);

    if (amountDec.lessThan(minDec) || amountDec.greaterThan(maxDec)) {
      throw new Error(`Deposit amount must be between ${minDec.toFixed(2)} and ${maxDec.toFixed(2)}.`);
    }

    const cleanTxid = data.txid.trim();
    if (!cleanTxid) {
      throw new Error('Transaction ID (TXID) / Reference number is required.');
    }

    const existingTxid = await db.queryRow<any>(
      'SELECT id, status, user_id FROM deposits WHERE txid = $1 AND payment_method_code = $2',
      [cleanTxid, data.methodCode]
    );

    const isDuplicateTxid = Boolean(existingTxid);
    const depositId = `dep_man_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    await db.query(`
      INSERT INTO deposits (
        id, user_id, payment_method_code, amount, currency, status,
        txid, proof_file_id, failure_reason, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'USDT', 'PENDING_REVIEW', $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      depositId,
      data.userId,
      data.methodCode,
      amountDec.toFixed(4),
      cleanTxid,
      data.proofFileId || null,
      isDuplicateTxid ? 'FLAGGED_DUPLICATE_TXID' : null,
    ]);

    logger.info('Manual deposit submitted for review', {
      depositId,
      userId: data.userId,
      method: data.methodCode,
      amount: amountDec.toFixed(4),
      isDuplicateTxid,
    });

    return { depositId, status: 'PENDING_REVIEW', isDuplicateTxid };
  }

  /**
   * Fetch pending manual deposits queue with customer username in a single JOIN (zero N+1 queries)
   */
  public async getPendingDeposits(limit = 10): Promise<{ items: PendingManualDeposit[]; totalPending: number }> {
    const [countRes, rowsRes] = await Promise.all([
      db.queryRow<{ c: string }>("SELECT COUNT(*) as c FROM deposits WHERE status = 'PENDING_REVIEW'"),
      db.query<any>(
        `SELECT d.id, d.user_id as "userId",
                u.username as "username", u.first_name as "firstName",
                d.payment_method_code as "methodCode",
                d.amount, d.txid, d.proof_file_id as "proofFileId",
                d.sender_phone as "senderPhone",
                d.submitted_pkr_amount as "submittedPkrAmount",
                d.suggested_usd_amount as "suggestedUsdAmount",
                d.failure_reason as "failureReason",
                d.created_at as "createdAt"
         FROM deposits d
         LEFT JOIN users u ON d.user_id = u.id
         WHERE d.status = 'PENDING_REVIEW'
         ORDER BY d.created_at ASC
         LIMIT $1`,
        [limit]
      ),
    ]);

    const items: PendingManualDeposit[] = rowsRes.rows.map(r => ({
      id: r.id,
      userId: r.userId,
      username: r.username || null,
      firstName: r.firstName || null,
      methodCode: r.methodCode,
      amount: new Decimal(r.amount || 0).toFixed(2),
      txid: r.txid || null,
      proofFileId: r.proofFileId || null,
      senderPhone: r.senderPhone || null,
      submittedPkrAmount: r.submittedPkrAmount !== null && r.submittedPkrAmount !== undefined
        ? new Decimal(r.submittedPkrAmount).toFixed(0)
        : null,
      suggestedUsdAmount: r.suggestedUsdAmount !== null && r.suggestedUsdAmount !== undefined
        ? new Decimal(r.suggestedUsdAmount).toFixed(2)
        : null,
      failureReason: r.failureReason || null,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : '',
    }));

    return {
      items,
      totalPending: parseInt(countRes?.c || '0', 10),
    };
  }

  /**
   * Admin approves a manual deposit (supports preset / suggested / exact custom USD credit).
   * Atomically credits the user's wallet via immutable ledger & guards against double approval.
   */
  public async approveDeposit(
    depositId: string,
    adminId: string,
    notesOrOptions?: string | { customUsdAmount?: string | number; notes?: string; isCustomInput?: boolean }
  ): Promise<{ success: boolean; amount: string; userId: string }> {
    const opts =
      typeof notesOrOptions === 'string'
        ? { notes: notesOrOptions }
        : notesOrOptions || {};

    if (opts.isCustomInput) {
      const settings = await this.getDepositSettings();
      if (!settings.allowCustomCredit) {
        throw new Error('Custom USD credit is currently disabled in Deposit Settings.');
      }
    }

    return await db.withTransaction(async (client) => {
      // 1. Lock deposit row
      const deposit = await client.queryRow<any>(
        'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
        [depositId]
      );

      if (!deposit) {
        throw new Error(`Deposit ${depositId} not found.`);
      }

      if (deposit.status !== 'PENDING_REVIEW') {
        throw new Error(`Deposit cannot be approved because status is ${deposit.status}.`);
      }

      const creditDec =
        opts.customUsdAmount !== undefined
          ? new Decimal(opts.customUsdAmount)
          : new Decimal(deposit.amount || 0);

      if (creditDec.isNaN() || creditDec.lessThanOrEqualTo(0)) {
        throw new Error('Credit USD amount must be greater than 0.00.');
      }
      if (creditDec.greaterThan(5000)) {
        throw new Error('Credit USD amount exceeds single-approval safety cap (5000.00 USD).');
      }

      const creditStr = creditDec.toFixed(4);

      // 2. Mark deposit as VERIFIED with exact admin-approved USD
      await client.query(
        `UPDATE deposits
         SET status = 'VERIFIED',
             amount = $1,
             approved_usd_amount = $1,
             approved_by = $2,
             verified_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [creditStr, adminId, depositId]
      );

      // 3. Record payment transaction
      await client.query(`
        INSERT INTO payment_transactions (id, deposit_id, provider, external_ref, amount, currency, raw_data)
        VALUES ($1, $2, $3, $4, $5, 'USDT', $6)
      `, [
        `pt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        depositId,
        deposit.payment_method_code,
        deposit.txid || deposit.sender_phone || depositId,
        creditStr,
        JSON.stringify({
          approvedBy: adminId,
          senderPhone: deposit.sender_phone || null,
          submittedPkrAmount: deposit.submitted_pkr_amount || null,
          notes: opts.notes,
        }),
      ]);

      // 4. Atomic wallet credit via immutable ledger
      const operationRef = `DEP_MANUAL_${depositId}`;
      await walletService.executeMutation({
        userId: deposit.user_id,
        amount: creditDec,
        operationRef,
        idempotencyKey: depositId,
        entryType: 'DEPOSIT',
        reason: `Manual ${deposit.payment_method_code} approved by admin (${adminId})`,
        source: deposit.payment_method_code,
        actor: adminId,
        metadata: {
          depositId,
          txid: deposit.txid || null,
          senderPhone: deposit.sender_phone || null,
          approvedUsdAmount: creditStr,
          notes: opts.notes,
        },
        client,
      });

      // 5. Admin audit log
      await client.query(`
        INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
        VALUES ($1, $2, 'APPROVE_MANUAL_DEPOSIT', 'deposit', $3, $4)
      `, [
        `log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        depositId,
        JSON.stringify({
          amount: creditStr,
          txid: deposit.txid || null,
          senderPhone: deposit.sender_phone || null,
          method: deposit.payment_method_code,
        }),
      ]);

      logger.info('Manual deposit approved successfully', {
        depositId,
        adminId,
        amount: creditStr,
      });
      return { success: true, amount: creditStr, userId: deposit.user_id };
    });
  }

  /**
   * Admin rejects a manual deposit.
   */
  public async rejectDeposit(depositId: string, adminId: string, reason: string): Promise<{ userId: string }> {
    return await db.withTransaction(async (client) => {
      const deposit = await client.queryRow<any>(
        'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
        [depositId]
      );

      if (!deposit) {
        throw new Error(`Deposit ${depositId} not found.`);
      }

      if (deposit.status !== 'PENDING_REVIEW') {
        throw new Error(`Deposit cannot be rejected because status is ${deposit.status}.`);
      }

      await client.query(`
        UPDATE deposits
        SET status = 'REJECTED',
            failure_reason = $1,
            approved_by = $2,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `, [reason, adminId, depositId]);

      await client.query(`
        INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
        VALUES ($1, $2, 'REJECT_MANUAL_DEPOSIT', 'deposit', $3, $4)
      `, [
        `log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        depositId,
        JSON.stringify({ reason, senderPhone: deposit.sender_phone || null }),
      ]);

      logger.info('Manual deposit rejected', { depositId, adminId, reason });
      return { userId: deposit.user_id };
    });
  }

  /**
   * Admin updates payment method details (account title, number, instructions, limits, enabled)
   */
  public async updateMethod(code: string, updates: Partial<PaymentMethodConfig>, adminId: string): Promise<void> {
    await db.query(`
      UPDATE payment_methods
      SET account_title = COALESCE($1, account_title),
          account_number = COALESCE($2, account_number),
          instructions = COALESCE($3, instructions),
          min_amount = COALESCE($4, min_amount),
          max_amount = COALESCE($5, max_amount),
          is_enabled = COALESCE($6, is_enabled),
          updated_at = CURRENT_TIMESTAMP
      WHERE code = $7
    `, [
      updates.accountTitle || null,
      updates.accountNumber || null,
      updates.instructions || null,
      updates.minAmount || null,
      updates.maxAmount || null,
      updates.isEnabled !== undefined ? updates.isEnabled : null,
      code.toUpperCase(),
    ]);

    await db.query(`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
      VALUES ($1, $2, 'UPDATE_PAYMENT_METHOD', 'payment_method', $3, $4)
    `, [
      `log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
      adminId,
      code,
      JSON.stringify(updates),
    ]);

    await this.invalidateMethodCaches();
  }
}

export const manualPaymentService = new ManualPaymentService();
