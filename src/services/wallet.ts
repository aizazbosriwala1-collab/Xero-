import Decimal from 'decimal.js';
import { db, DbClient } from '../db/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('WalletService');

// Precision configuration for Decimal
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export interface Wallet {
  id: string;
  userId: string;
  currency: string;
  balance: string; // Stored as Decimal string e.g. "12.5000"
  lockedBalance: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  walletId: string;
  userId: string;
  operationRef: string;
  idempotencyKey?: string;
  amount: string; // Positive for credits, negative for debits
  balanceAfter: string;
  entryType: 'DEPOSIT' | 'PURCHASE_DEBIT' | 'PURCHASE_HOLD' | 'HOLD_RELEASE' | 'REFUND' | 'GIVEAWAY_REWARD' | 'REFERRAL_REWARD' | 'ADMIN_ADJUSTMENT';
  reason: string;
  source: string;
  actor: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface WalletOperationParams {
  userId: string;
  amount: Decimal | string | number;
  operationRef: string;
  idempotencyKey?: string;
  entryType: LedgerEntry['entryType'];
  reason: string;
  source: string;
  actor: string;
  metadata?: Record<string, unknown>;
  client?: DbClient;
}

export class WalletService {
  private userMutexes = new Map<string, Promise<void>>();

  private async withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.userMutexes.get(userId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.userMutexes.set(userId, prev.then(() => current));

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.userMutexes.get(userId) === current) {
        this.userMutexes.delete(userId);
      }
    }
  }

  /**
   * Ensure user exists and has a wallet.
   */
  public async getOrCreateWallet(userId: string, client?: DbClient): Promise<Wallet> {
    const executor = client || db;
    const existing = await executor.queryRow<any>(
      'SELECT id, user_id as "userId", currency, balance, locked_balance as "lockedBalance", created_at as "createdAt", updated_at as "updatedAt" FROM wallets WHERE user_id = $1',
      [userId]
    );

    if (existing) {
      return {
        id: existing.id,
        userId: existing.userId,
        currency: existing.currency,
        balance: new Decimal(existing.balance).toFixed(4),
        lockedBalance: new Decimal(existing.lockedBalance).toFixed(4),
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
      };
    }

    const walletId = `w_${userId}`;
    const insertRes = await executor.queryRow<any>(
      `INSERT INTO wallets (id, user_id, currency, balance, locked_balance, created_at, updated_at)
       VALUES ($1, $2, 'USDT', 0.0000, 0.0000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
       RETURNING id, user_id as "userId", currency, balance, locked_balance as "lockedBalance", created_at as "createdAt", updated_at as "updatedAt"`,
      [walletId, userId]
    );

    return {
      id: insertRes.id,
      userId: insertRes.userId,
      currency: insertRes.currency,
      balance: new Decimal(insertRes.balance).toFixed(4),
      lockedBalance: new Decimal(insertRes.lockedBalance).toFixed(4),
      createdAt: insertRes.createdAt,
      updatedAt: insertRes.updatedAt,
    };
  }

  /**
   * Get user wallet balance.
   */
  public async getBalance(userId: string): Promise<{ balance: Decimal; locked: Decimal; available: Decimal }> {
    const wallet = await this.getOrCreateWallet(userId);
    const balance = new Decimal(wallet.balance);
    const locked = new Decimal(wallet.lockedBalance);
    const available = Decimal.max(0, balance.minus(locked));
    return { balance, locked, available };
  }

  /**
   * Execute an atomic mutation on the wallet with strict append-only ledger logging.
   * Locked row via SELECT ... FOR UPDATE ensures race condition safety.
   */
  public async executeMutation(params: WalletOperationParams): Promise<{ wallet: Wallet; ledger: LedgerEntry }> {
    const amountDec = new Decimal(params.amount);
    if (amountDec.isNaN()) {
      throw new Error(`Invalid amount for wallet mutation: ${params.amount}`);
    }

    const runWithClient = async (client: DbClient) => {
        // 1. Idempotency Check: Verify if this operation_ref already exists in ledger
        const existingLedger = await client.queryRow<any>(
          'SELECT * FROM ledger_entries WHERE operation_ref = $1',
          [params.operationRef]
        );

        if (existingLedger) {
          logger.info('Duplicate operationRef detected. Returning existing ledger record (Idempotent)', {
            operationRef: params.operationRef,
          });
          const wallet = await this.getOrCreateWallet(params.userId, client);
          return {
            wallet,
            ledger: {
              id: existingLedger.id,
              walletId: existingLedger.wallet_id,
              userId: existingLedger.user_id,
              operationRef: existingLedger.operation_ref,
              idempotencyKey: existingLedger.idempotency_key,
              amount: new Decimal(existingLedger.amount).toFixed(4),
              balanceAfter: new Decimal(existingLedger.balance_after).toFixed(4),
              entryType: existingLedger.entry_type,
              reason: existingLedger.reason,
              source: existingLedger.source,
              actor: existingLedger.actor,
              metadata: existingLedger.metadata,
              createdAt: existingLedger.created_at,
            },
          };
        }

        // 2. Lock wallet row for update
        await this.getOrCreateWallet(params.userId, client);
        const lockedWallet = await client.queryRow<any>(
          'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
          [params.userId]
        );

        const currentBalance = new Decimal(lockedWallet.balance);
        const newBalance = currentBalance.plus(amountDec);

        // Debits cannot drop below 0
        if (newBalance.isNegative()) {
          throw new Error(`Insufficient wallet funds. Current: ${currentBalance.toFixed(4)} USDT, Requested: ${amountDec.abs().toFixed(4)} USDT`);
        }

        const balanceAfterStr = newBalance.toFixed(4);
        const amountStr = amountDec.toFixed(4);
        const ledgerId = `led_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        // 3. Insert immutable ledger entry
        await client.query(
          `INSERT INTO ledger_entries (
            id, wallet_id, user_id, operation_ref, idempotency_key, amount,
            balance_after, entry_type, reason, source, actor, metadata, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)`,
          [
            ledgerId,
            lockedWallet.id,
            params.userId,
            params.operationRef,
            params.idempotencyKey || null,
            amountStr,
            balanceAfterStr,
            params.entryType,
            params.reason,
            params.source,
            params.actor,
            JSON.stringify(params.metadata || {}),
          ]
        );

        // 4. Update authoritative wallet balance
        const updatedWalletRes = await client.queryRow<any>(
          `UPDATE wallets
           SET balance = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2
           RETURNING id, user_id as "userId", currency, balance, locked_balance as "lockedBalance", created_at as "createdAt", updated_at as "updatedAt"`,
          [balanceAfterStr, lockedWallet.id]
        );

        const updatedWallet: Wallet = {
          id: updatedWalletRes.id,
          userId: updatedWalletRes.userId,
          currency: updatedWalletRes.currency,
          balance: new Decimal(updatedWalletRes.balance).toFixed(4),
          lockedBalance: new Decimal(updatedWalletRes.lockedBalance).toFixed(4),
          createdAt: updatedWalletRes.createdAt,
          updatedAt: updatedWalletRes.updatedAt,
        };

        const ledgerRecord: LedgerEntry = {
          id: ledgerId,
          walletId: lockedWallet.id,
          userId: params.userId,
          operationRef: params.operationRef,
          idempotencyKey: params.idempotencyKey,
          amount: amountStr,
          balanceAfter: balanceAfterStr,
          entryType: params.entryType,
          reason: params.reason,
          source: params.source,
          actor: params.actor,
          metadata: params.metadata,
          createdAt: new Date().toISOString(),
        };

        logger.info('Wallet mutation completed successfully', {
          userId: params.userId,
          entryType: params.entryType,
          amount: amountStr,
          balanceAfter: balanceAfterStr,
          operationRef: params.operationRef,
        });

        return { wallet: updatedWallet, ledger: ledgerRecord };
    };

    return await this.withUserLock(params.userId, async () => {
      if (params.client) {
        return await runWithClient(params.client);
      }
      return await db.withTransaction(runWithClient);
    });
  }

  /**
   * Reconcile wallet balance against the sum of all immutable ledger entries.
   */
  public async reconcile(userId: string): Promise<{ isBalanced: boolean; walletBalance: Decimal; ledgerSum: Decimal }> {
    const wallet = await this.getOrCreateWallet(userId);
    const ledgerSumRes = await db.queryRow<{ sum: string | null }>(
      'SELECT COALESCE(SUM(amount), 0) as sum FROM ledger_entries WHERE user_id = $1',
      [userId]
    );

    const walletBalance = new Decimal(wallet.balance);
    const ledgerSum = new Decimal(ledgerSumRes?.sum || 0);
    const isBalanced = walletBalance.equals(ledgerSum);

    if (!isBalanced) {
      logger.error('Wallet ledger discrepancy detected!', {
        userId,
        walletBalance: walletBalance.toFixed(4),
        ledgerSum: ledgerSum.toFixed(4),
      });
    }

    return { isBalanced, walletBalance, ledgerSum };
  }

  /**
   * List recent ledger entries for user or admin.
   */
  public async getHistory(userId: string, limit = 20): Promise<LedgerEntry[]> {
    const res = await db.query<any>(
      `SELECT id, wallet_id as "walletId", user_id as "userId", operation_ref as "operationRef",
              idempotency_key as "idempotencyKey", amount, balance_after as "balanceAfter",
              entry_type as "entryType", reason, source, actor, metadata, created_at as "createdAt"
       FROM ledger_entries
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    return res.rows.map(r => ({
      ...r,
      amount: new Decimal(r.amount).toFixed(4),
      balanceAfter: new Decimal(r.balanceAfter).toFixed(4),
    }));
  }
}

export const walletService = new WalletService();
