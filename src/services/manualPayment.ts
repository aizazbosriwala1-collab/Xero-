import Decimal from 'decimal.js';
import { db } from '../db/index.js';
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

export class ManualPaymentService {
  /**
   * Get all active payment methods
   */
  public async getPaymentMethods(includeDisabled = false): Promise<PaymentMethodConfig[]> {
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

    return res.rows;
  }

  /**
   * Get specific payment method by code
   */
  public async getMethodByCode(code: string): Promise<PaymentMethodConfig | null> {
    const res = await db.queryRow<any>(`
      SELECT id, code, name, account_title as "accountTitle",
             account_number as "accountNumber", instructions,
             min_amount as "minAmount", max_amount as "maxAmount",
             is_enabled as "isEnabled", proof_required as "proofRequired",
             review_message as "reviewMessage"
      FROM payment_methods
      WHERE code = $1
    `, [code.toUpperCase()]);

    return res;
  }

  /**
   * Submit a new manual deposit for admin review
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

    // Check if this TXID has already been submitted
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
   * Admin approves a manual deposit, crediting the user's wallet atomically.
   * Safe against double-click/race conditions.
   */
  public async approveDeposit(depositId: string, adminId: string, notes?: string): Promise<{ success: boolean; amount: string; userId: string }> {
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

      const amountDec = new Decimal(deposit.amount);

      // 2. Mark deposit as VERIFIED
      await client.query(`
        UPDATE deposits
        SET status = 'VERIFIED',
            verified_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [depositId]);

      // 3. Record payment transaction
      await client.query(`
        INSERT INTO payment_transactions (id, deposit_id, provider, external_ref, amount, currency, raw_data)
        VALUES ($1, $2, $3, $4, $5, 'USDT', $6)
      `, [
        `pt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        depositId,
        deposit.payment_method_code,
        deposit.txid,
        deposit.amount,
        JSON.stringify({ approvedBy: adminId, notes }),
      ]);

      // 4. Atomic wallet credit via immutable ledger
      const operationRef = `DEP_MANUAL_${depositId}`;
      await walletService.executeMutation({
        userId: deposit.user_id,
        amount: amountDec,
        operationRef,
        idempotencyKey: depositId,
        entryType: 'DEPOSIT',
        reason: `Manual ${deposit.payment_method_code} approved by admin (${adminId})`,
        source: deposit.payment_method_code,
        actor: adminId,
        metadata: {
          depositId,
          txid: deposit.txid,
          notes,
        },
        client,
      });

      // 5. Admin audit log
      await client.query(`
        INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
        VALUES ($1, $2, 'APPROVE_MANUAL_DEPOSIT', 'deposit', $3, $4)
      `, [
        `log_${Date.now()}`,
        adminId,
        depositId,
        JSON.stringify({ amount: deposit.amount, txid: deposit.txid, method: deposit.payment_method_code }),
      ]);

      logger.info('Manual deposit approved successfully', { depositId, adminId, amount: deposit.amount });
      return { success: true, amount: deposit.amount, userId: deposit.user_id };
    });
  }

  /**
   * Admin rejects a manual deposit.
   */
  public async rejectDeposit(depositId: string, adminId: string, reason: string): Promise<void> {
    await db.withTransaction(async (client) => {
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
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [reason, depositId]);

      await client.query(`
        INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
        VALUES ($1, $2, 'REJECT_MANUAL_DEPOSIT', 'deposit', $3, $4)
      `, [
        `log_${Date.now()}`,
        adminId,
        depositId,
        JSON.stringify({ reason }),
      ]);

      logger.info('Manual deposit rejected', { depositId, adminId, reason });
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
      `log_${Date.now()}`,
      adminId,
      code,
      JSON.stringify(updates),
    ]);
  }
}

export const manualPaymentService = new ManualPaymentService();
