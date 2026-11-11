import crypto from 'crypto';
import Decimal from 'decimal.js';
import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { walletService } from './wallet.js';
import { createLogger } from './logger.js';

const logger = createLogger('BinanceService');

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type BinanceErrorClassification =
  | 'DNS_FAILURE'
  | 'NETWORK_FAILURE'
  | 'TLS_FAILURE'
  | 'TIMEOUT'
  | 'HTTP_REJECTION'
  | 'MALFORMED_JSON'
  | 'AUTH_REJECTION'
  | 'API_PERMISSION_REJECTION'
  | 'INVALID_SIGNATURE'
  | 'TIMESTAMP_RECVWINDOW_REJECTION'
  | 'RATE_LIMIT'
  | 'ELIGIBILITY_RESTRICTED'
  | 'ZERO_RECORDS_FOUND'
  | 'WRONG_AMOUNT'
  | 'WRONG_CURRENCY'
  | 'WRONG_DIRECTION'
  | 'WRONG_RECEIVER'
  | 'DUPLICATE_TRANSACTION'
  | 'AMBIGUOUS_TRANSACTION'
  | 'EXACT_VALID_MATCH';

export interface BinanceTransactionRecord {
  transactionId: string;
  transactionTime: number;
  orderType: string;
  amount: string;
  currency: string;
  payerInfo?: {
    name?: string;
    binanceId?: string;
  };
  receiverInfo?: {
    name?: string;
    binanceId?: string;
  };
}

export interface BinanceVerificationResult {
  verified: boolean;
  classification: BinanceErrorClassification;
  message: string;
  transaction?: BinanceTransactionRecord;
  sanitizedDetails?: Record<string, unknown>;
}

export interface BinanceInvoice {
  id: string;
  userId: string;
  amount: string;
  currency: string;
  receiverRef: string;
  status: 'PENDING' | 'VERIFIED' | 'EXPIRED' | 'REJECTED';
  expiresAt: string;
  createdAt: string;
  transactionId?: string;
}

export class BinanceService {
  private baseUrl: string;
  private apiKey?: string;
  private apiSecret?: string;
  private receiverId?: string;
  private recvWindowMs: number;
  private requestTimeoutMs: number;
  private readOnlyLiveVerified: boolean = false;
  private isLiveProductionVerified: boolean = false;

  constructor() {
    this.baseUrl = config.binance.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.binance.apiKey;
    this.apiSecret = config.binance.apiSecret;
    this.receiverId = config.binance.receiverId;
    this.recvWindowMs = config.binance.recvWindowMs;
    this.requestTimeoutMs = config.binance.requestTimeoutMs;
  }

  /**
   * Evaluates the comprehensive 6-point safety gate for Binance automatic credit.
   * BINANCE_PAY_ENABLED=true alone must NEVER enable automatic wallet credit.
   * Requires ALL:
   * 1. Binance enabled in config (config.binance.enabled === true)
   * 2. API key + secret configured
   * 3. Receiver ID configured
   * 4. Payment method CONFIGURED + active + enabled in PostgreSQL
   * 5. Successful authorized READ_ONLY_LIVE_VERIFIED state
   * 6. No financial safety block (RECOVERY_MODE === false)
   */
  public async getReadinessState(): Promise<{
    binanceEnabled: boolean;
    credentialsConfigured: boolean;
    receiverConfigured: boolean;
    paymentMethodConfiguredAndEnabled: boolean;
    readOnlyLiveVerified: boolean;
    financialSafetyBlock: boolean;
    automaticCreditEnabled: boolean;
    reason: string;
  }> {
    const binanceEnabled = Boolean(config.binance.enabled);
    const credentialsConfigured = Boolean(this.apiKey && this.apiSecret);
    const receiverConfigured = Boolean(this.receiverId);

    const pm = await db.queryRow<any>(
      "SELECT is_enabled FROM payment_methods WHERE code = 'BINANCE_USDT'"
    );
    const paymentMethodConfiguredAndEnabled = Boolean(pm && pm.is_enabled);
    const readOnlyLiveVerified = this.readOnlyLiveVerified && this.isLiveProductionVerified;
    const financialSafetyBlock = Boolean(config.safety.recoveryMode);

    let reason = 'Readiness criteria satisfied';
    if (!binanceEnabled) {
      reason = 'BINANCE_PAY_ENABLED is false';
    } else if (!credentialsConfigured) {
      reason = 'BINANCE_API_KEY or BINANCE_API_SECRET not configured';
    } else if (!receiverConfigured) {
      reason = 'BINANCE_RECEIVER_ID not configured';
    } else if (!paymentMethodConfiguredAndEnabled) {
      reason = 'BINANCE_USDT payment method not enabled in database';
    } else if (!readOnlyLiveVerified) {
      reason = 'READ_ONLY_LIVE_VERIFIED is false (live read-only probe not performed or unverified)';
    } else if (financialSafetyBlock) {
      reason = 'Financial safety block active (RECOVERY_MODE is true)';
    }

    const automaticCreditEnabled =
      binanceEnabled &&
      credentialsConfigured &&
      receiverConfigured &&
      paymentMethodConfiguredAndEnabled &&
      readOnlyLiveVerified &&
      !financialSafetyBlock;

    return {
      binanceEnabled,
      credentialsConfigured,
      receiverConfigured,
      paymentMethodConfiguredAndEnabled,
      readOnlyLiveVerified,
      financialSafetyBlock,
      automaticCreditEnabled,
      reason,
    };
  }

  /**
   * Generates HMAC-SHA256 signature for Binance API
   */
  private generateSignature(queryString: string): string {
    if (!this.apiSecret) {
      throw new Error('BINANCE_API_SECRET is not configured');
    }
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  /**
   * Create a new pending deposit invoice for Binance USDT
   */
  public async createInvoice(userId: string, amount: Decimal | string | number): Promise<BinanceInvoice> {
    const amountDec = new Decimal(amount);
    if (amountDec.lessThan(config.binance.minDepositUsdt) || amountDec.greaterThan(config.binance.maxDepositUsdt)) {
      throw new Error(`Amount must be between ${config.binance.minDepositUsdt} and ${config.binance.maxDepositUsdt} USDT`);
    }

    const invoiceId = `dep_binance_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour expiry
    const amountStr = amountDec.toFixed(4);
    const receiverRef = this.receiverId || 'DEFAULT_RECEIVER_ID';

    await db.query(`
      INSERT INTO deposits (
        id, user_id, payment_method_code, amount, currency, status,
        receiver_ref, expires_at, created_at, updated_at
      ) VALUES ($1, $2, 'BINANCE_USDT', $3, 'USDT', 'PENDING', $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [invoiceId, userId, amountStr, receiverRef, expiresAt]);

    logger.info('Created Binance deposit invoice', {
      depositId: invoiceId,
      userId,
      amount: amountStr,
    });

    return {
      id: invoiceId,
      userId,
      amount: amountStr,
      currency: 'USDT',
      receiverRef,
      status: 'PENDING',
      expiresAt,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Isolated read-only query to GET /sapi/v1/pay/transactions
   * Does NOT mutate any wallet balance or database state.
   */
  public async queryTransactions(params: {
    startTimestamp?: number;
    endTimestamp?: number;
    limit?: number;
  } = {}): Promise<{
    httpStatus: number;
    binanceCode?: string;
    binanceMessage?: string;
    records: BinanceTransactionRecord[];
    raw?: any;
    errorClassification?: BinanceErrorClassification;
    errorMessage?: string;
  }> {
    if (!this.apiKey || !this.apiSecret) {
      return {
        httpStatus: 401,
        records: [],
        errorClassification: 'AUTH_REJECTION',
        errorMessage: 'BINANCE_API_KEY or BINANCE_API_SECRET not configured.',
      };
    }

    const timestamp = Date.now();
    const queryParts: string[] = [
      `timestamp=${timestamp}`,
      `recvWindow=${this.recvWindowMs}`,
    ];

    if (params.startTimestamp) queryParts.push(`startTimestamp=${params.startTimestamp}`);
    if (params.endTimestamp) queryParts.push(`endTimestamp=${params.endTimestamp}`);
    if (params.limit) queryParts.push(`limit=${params.limit}`);

    const queryString = queryParts.join('&');
    const signature = this.generateSignature(queryString);
    const fullQuery = `${queryString}&signature=${signature}`;
    const url = `${this.baseUrl}/sapi/v1/pay/transactions?${fullQuery}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const httpStatus = res.status;
      let data: any;
      try {
        data = await res.json();
      } catch (jsonErr: any) {
        return {
          httpStatus,
          records: [],
          errorClassification: 'MALFORMED_JSON',
          errorMessage: 'Failed to parse Binance JSON response',
        };
      }

      // Check HTTP rejection
      if (httpStatus !== 200) {
        const code = data.code || String(httpStatus);
        const msg = data.msg || 'Binance HTTP error';
        let classification: BinanceErrorClassification = 'HTTP_REJECTION';

        if (httpStatus === 401 || code === -2014 || code === -2015) {
          classification = 'AUTH_REJECTION';
        } else if (httpStatus === 403 || code === -1002 || code === -2016) {
          classification = 'ELIGIBILITY_RESTRICTED';
        } else if (httpStatus === 429) {
          classification = 'RATE_LIMIT';
        } else if (code === -1021) {
          classification = 'TIMESTAMP_RECVWINDOW_REJECTION';
        } else if (code === -1022) {
          classification = 'INVALID_SIGNATURE';
        }

        return {
          httpStatus,
          binanceCode: String(code),
          binanceMessage: msg,
          records: [],
          raw: data,
          errorClassification: classification,
          errorMessage: msg,
        };
      }

      // HTTP 200: check Binance business code
      const binanceCode = data.code;
      const binanceMessage = data.message || data.msg;

      if (binanceCode !== '000000' && binanceCode !== 0) {
        return {
          httpStatus,
          binanceCode: String(binanceCode),
          binanceMessage,
          records: [],
          raw: data,
          errorClassification: 'API_PERMISSION_REJECTION',
          errorMessage: binanceMessage || `Binance code ${binanceCode}`,
        };
      }

      const rawRecords = Array.isArray(data.data) ? data.data : (Array.isArray(data.records) ? data.records : []);
      const records: BinanceTransactionRecord[] = rawRecords.map((r: any) => ({
        transactionId: String(r.transactionId || r.orderId || ''),
        transactionTime: Number(r.transactionTime || r.orderTime || Date.now()),
        orderType: String(r.orderType || 'C2C'),
        amount: new Decimal(r.amount || 0).toFixed(4),
        currency: String(r.currency || 'USDT').toUpperCase(),
        payerInfo: r.payerInfo,
        receiverInfo: r.receiverInfo,
      }));

      return {
        httpStatus,
        binanceCode: String(binanceCode),
        binanceMessage,
        records,
        raw: data,
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return {
          httpStatus: 0,
          records: [],
          errorClassification: 'TIMEOUT',
          errorMessage: 'Binance request timed out',
        };
      }
      return {
        httpStatus: 0,
        records: [],
        errorClassification: 'NETWORK_FAILURE',
        errorMessage: err.message || 'Network error connecting to Binance',
      };
    }
  }

  /**
   * Verify an incoming deposit invoice against Binance transactions.
   */
  public async verifyDeposit(depositId: string, submittedTxId?: string): Promise<BinanceVerificationResult> {
    const deposit = await db.queryRow<any>(
      'SELECT * FROM deposits WHERE id = $1',
      [depositId]
    );

    if (!deposit) {
      return {
        verified: false,
        classification: 'ZERO_RECORDS_FOUND',
        message: 'Deposit invoice not found.',
      };
    }

    if (deposit.status === 'VERIFIED') {
      return {
        verified: true,
        classification: 'EXACT_VALID_MATCH',
        message: 'Deposit has already been verified and credited.',
      };
    }

    if (deposit.status === 'EXPIRED' || (deposit.expires_at && new Date() > new Date(deposit.expires_at))) {
      await db.query("UPDATE deposits SET status = 'EXPIRED' WHERE id = $1", [depositId]);
      return {
        verified: false,
        classification: 'ZERO_RECORDS_FOUND',
        message: 'Deposit invoice has expired. Please create a new invoice.',
      };
    }

    const expectedAmount = new Decimal(deposit.amount);
    const expectedCurrency = deposit.currency || 'USDT';

    // Query Binance for recent transactions
    const invoiceCreatedMs = new Date(deposit.created_at).getTime() - 60000; // allow 1 min buffer
    const result = await this.queryTransactions({ startTimestamp: invoiceCreatedMs });

    // Record attempt for audit trail
    await db.query(`
      INSERT INTO deposit_attempts (id, deposit_id, attempt_number, payload, response, error_classification)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      `att_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      depositId,
      (deposit.attempt_count || 0) + 1,
      JSON.stringify({ submittedTxId }),
      JSON.stringify({ code: result.binanceCode, count: result.records.length }),
      result.errorClassification || 'QUERY_OK',
    ]);
    await db.query('UPDATE deposits SET attempt_count = attempt_count + 1 WHERE id = $1', [depositId]);

    if (result.errorClassification) {
      return {
        verified: false,
        classification: result.errorClassification,
        message: result.errorMessage || 'Binance verification check failed.',
      };
    }

    if (result.records.length === 0) {
      return {
        verified: false,
        classification: 'ZERO_RECORDS_FOUND',
        message: 'No incoming Binance transactions found for this invoice time window.',
      };
    }

    // Filter matching candidates
    let candidates = result.records;

    // Filter by submitted TXID if provided
    if (submittedTxId) {
      candidates = candidates.filter(c => c.transactionId.toLowerCase() === submittedTxId.toLowerCase().trim());
      if (candidates.length === 0) {
        return {
          verified: false,
          classification: 'ZERO_RECORDS_FOUND',
          message: 'The submitted Binance Transaction ID was not found in your recent incoming transactions.',
        };
      }
    }

    // Filter by exact currency USDT
    const currencyMatches = candidates.filter(c => c.currency === expectedCurrency);
    if (currencyMatches.length === 0) {
      return {
        verified: false,
        classification: 'WRONG_CURRENCY',
        message: `Transaction found but currency does not match. Expected ${expectedCurrency}.`,
      };
    }

    // Filter by exact Decimal amount
    const amountMatches = currencyMatches.filter(c => new Decimal(c.amount).equals(expectedAmount));
    if (amountMatches.length === 0) {
      const foundAmounts = currencyMatches.map(c => c.amount).join(', ');
      return {
        verified: false,
        classification: 'WRONG_AMOUNT',
        message: `Amount mismatch. Expected ${expectedAmount.toFixed(4)} USDT, but found incoming transactions of: ${foundAmounts}`,
      };
    }

    // Check for ambiguity (multiple candidate transactions with identical amount)
    if (amountMatches.length > 1 && !submittedTxId) {
      return {
        verified: false,
        classification: 'AMBIGUOUS_TRANSACTION',
        message: 'Multiple matching transactions detected. Please enter your exact Binance Transaction ID to verify.',
      };
    }

    const matchedTx = amountMatches[0];

    // Check if this transaction ID has already been credited in another deposit
    const alreadyUsed = await db.queryRow<any>(
      'SELECT id, user_id FROM deposits WHERE binance_transaction_id = $1 AND id <> $2',
      [matchedTx.transactionId, depositId]
    );
    if (alreadyUsed) {
      return {
        verified: false,
        classification: 'DUPLICATE_TRANSACTION',
        message: 'This Binance Transaction ID has already been credited to an account.',
      };
    }

    // Safety Gate Check: BINANCE_PAY_ENABLED=true alone must NEVER enable automatic wallet credit.
    // Automatic credit requires ALL:
    // 1. Binance enabled in config
    // 2. API key + secret configured
    // 3. Receiver ID configured
    // 4. Payment method CONFIGURED + active + enabled in PostgreSQL
    // 5. Successful authorized READ_ONLY_LIVE_VERIFIED state
    // 6. No financial safety block (e.g. RECOVERY_MODE)
    const readiness = await this.getReadinessState();
    if (!readiness.automaticCreditEnabled) {
      logger.warn('Binance automatic wallet credit blocked by safety gate: readiness criteria not satisfied', {
        depositId,
        readiness,
      });
      return {
        verified: false,
        classification: 'ELIGIBILITY_RESTRICTED',
        message: `Automatic Binance wallet credit is disabled: ${readiness.reason}.`,
      };
    }

    // Atomic credit transaction!
    return await db.withTransaction(async (client) => {
      // 1. Lock deposit row
      const lockedDeposit = await client.queryRow<any>(
        'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
        [depositId]
      );

      if (lockedDeposit.status === 'VERIFIED') {
        return {
          verified: true,
          classification: 'EXACT_VALID_MATCH',
          message: 'Deposit already credited.',
          transaction: matchedTx,
        };
      }

      // 2. Mark deposit as VERIFIED with transaction reference
      await client.query(`
        UPDATE deposits
        SET status = 'VERIFIED',
            binance_transaction_id = $1,
            binance_order_type = $2,
            verified_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `, [matchedTx.transactionId, matchedTx.orderType, depositId]);

      // 3. Insert immutable payment record
      await client.query(`
        INSERT INTO payment_transactions (id, deposit_id, provider, external_ref, amount, currency, raw_data)
        VALUES ($1, $2, 'BINANCE_PAY', $3, $4, $5, $6)
      `, [
        `pt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        depositId,
        matchedTx.transactionId,
        matchedTx.amount,
        matchedTx.currency,
        JSON.stringify(matchedTx),
      ]);

      // 4. Atomic wallet credit via immutable ledger
      const operationRef = `DEP_BINANCE_${matchedTx.transactionId}`;
      await walletService.executeMutation({
        userId: lockedDeposit.user_id,
        amount: expectedAmount,
        operationRef,
        idempotencyKey: depositId,
        entryType: 'DEPOSIT',
        reason: `Binance Pay USDT automatic credit (${matchedTx.transactionId.substring(0, 8)}...)`,
        source: 'BINANCE_USDT',
        actor: 'SYSTEM_VERIFIER',
        metadata: {
          depositId,
          orderType: matchedTx.orderType,
        },
      });

      logger.info('Binance deposit verified and wallet credited atomically', {
        depositId,
        userId: lockedDeposit.user_id,
        amount: expectedAmount.toFixed(4),
      });

      return {
        verified: true,
        classification: 'EXACT_VALID_MATCH',
        message: `Successfully verified and credited ${expectedAmount.toFixed(4)} USDT to your wallet!`,
        transaction: matchedTx,
      };
    });
  }

  /**
   * Run read-only test verification report for admin diagnostics
   */
  public async testReadOnlyVerification(isLiveVerificationCall = false): Promise<{
    status: 'READY' | 'NOT_CONFIGURED' | 'ERROR';
    classification: BinanceErrorClassification;
    message: string;
    details: Record<string, unknown>;
    readOnlyLiveVerified: boolean;
    automaticCreditEnabled: boolean;
  }> {
    if (!config.binance.apiKey || !config.binance.apiSecret) {
      this.readOnlyLiveVerified = false;
      this.isLiveProductionVerified = false;
      return {
        status: 'NOT_CONFIGURED',
        classification: 'AUTH_REJECTION',
        message: 'Binance credentials (BINANCE_API_KEY, BINANCE_API_SECRET) are not configured.',
        details: {
          enabled: config.binance.enabled,
          baseUrl: config.binance.baseUrl,
        },
        readOnlyLiveVerified: false,
        automaticCreditEnabled: false,
      };
    }

    const res = await this.queryTransactions({ limit: 5 });
    if (res.errorClassification) {
      this.readOnlyLiveVerified = false;
      this.isLiveProductionVerified = false;
      return {
        status: 'ERROR',
        classification: res.errorClassification,
        message: res.errorMessage || 'Binance read-only query returned an error.',
        details: {
          httpStatus: res.httpStatus,
          binanceCode: res.binanceCode,
          binanceMessage: res.binanceMessage,
        },
        readOnlyLiveVerified: false,
        automaticCreditEnabled: false,
      };
    }

    if (isLiveVerificationCall && res.httpStatus === 200 && res.binanceCode === '000000') {
      this.readOnlyLiveVerified = true;
      this.isLiveProductionVerified = true;
    }

    const readiness = await this.getReadinessState();

    return {
      status: 'READY',
      classification: 'EXACT_VALID_MATCH',
      message: 'Binance API connected and read-only transaction query returned HTTP 200 OK.',
      details: {
        httpStatus: res.httpStatus,
        binanceCode: res.binanceCode,
        recordsReturned: res.records.length,
        testPaymentDetected: res.records.length > 0,
      },
      readOnlyLiveVerified: this.readOnlyLiveVerified,
      automaticCreditEnabled: readiness.automaticCreditEnabled,
    };
  }
}

export const binanceService = new BinanceService();
