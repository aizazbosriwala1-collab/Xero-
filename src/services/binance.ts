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
    this.receiverId = config.binance.receiverId ? config.binance.receiverId.trim() : undefined;
    this.recvWindowMs = config.binance.recvWindowMs;
    this.requestTimeoutMs = config.binance.requestTimeoutMs;
  }

  /**
   * Return configured receiving Binance ID (Single Source of Truth)
   */
  public getReceiverId(): string | undefined {
    return this.receiverId || (config.binance.receiverId ? config.binance.receiverId.trim() : undefined);
  }

  /**
   * Validate receiver configuration on startup.
   */
  public validateReceiverConfigAtStartup(): void {
    const receiver = this.getReceiverId();
    if (!receiver) {
      if (config.binance.enabled) {
        logger.warn('BINANCE_RECEIVER_ID is not configured in environment while Binance Pay is enabled');
      } else {
        logger.info('BINANCE_RECEIVER_ID not configured (Binance Pay disabled)');
      }
    } else {
      logger.info('Configured Binance Receiver ID loaded successfully', {
        receiverConfigured: true,
        receiverId: receiver,
      });
    }
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

    const receiverRef = this.getReceiverId() || '';
    if (!receiverRef) {
      logger.warn('Creating Binance deposit invoice without configured BINANCE_RECEIVER_ID');
    }

    const invoiceId = `dep_binance_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour expiry
    const amountStr = amountDec.toFixed(4);

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
      receiverRef,
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
  public async verifyDeposit(
    depositId: string,
    submittedTxId?: string,
    customerId?: string
  ): Promise<BinanceVerificationResult> {
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

    // Verify invoice belongs to this customer if customerId is provided
    if (customerId && deposit.user_id !== String(customerId)) {
      return {
        verified: false,
        classification: 'ELIGIBILITY_RESTRICTED',
        message: 'This deposit invoice does not belong to your account.',
      };
    }

    if (deposit.status === 'VERIFIED') {
      return {
        verified: true,
        classification: 'EXACT_VALID_MATCH',
        message: 'Deposit has already been verified and credited.',
      };
    }

    const now = Date.now();
    const expiresAtMs = deposit.expires_at ? new Date(deposit.expires_at).getTime() : now + 3600000;
    if (deposit.status === 'EXPIRED' || now > expiresAtMs) {
      await db.query("UPDATE deposits SET status = 'EXPIRED' WHERE id = $1", [depositId]);
      return {
        verified: false,
        classification: 'ZERO_RECORDS_FOUND',
        message: 'Deposit invoice has expired. Please create a new invoice.',
      };
    }

    const expectedAmount = new Decimal(deposit.amount);
    const expectedCurrency = (deposit.currency || 'USDT').toUpperCase();

    // Guard against customer submitting invoice ID, receiver ID, or customer ID as transaction ID
    if (submittedTxId && submittedTxId.trim()) {
      const cleanSub = submittedTxId.trim().toLowerCase();
      const configuredRec = this.getReceiverId() ? this.getReceiverId()!.toLowerCase() : '';
      const recRef = deposit.receiver_ref ? String(deposit.receiver_ref).toLowerCase().trim() : '';
      const invId = depositId.toLowerCase();
      const usrId = String(deposit.user_id).toLowerCase();

      if (cleanSub === invId || (configuredRec && cleanSub === configuredRec) || (recRef && cleanSub === recRef) || cleanSub === usrId) {
        return {
          verified: false,
          classification: 'ZERO_RECORDS_FOUND',
          message: 'The submitted value is not a Binance Transaction ID. Please enter the official Transaction ID found in your Binance Pay history.',
        };
      }
    }

    // 1. Tightly bounded time window based on deposit created_at and expires_at / verification time
    // Buffer: 60s before invoice creation (to absorb slight client clock skew)
    const invoiceCreatedMs = new Date(deposit.created_at).getTime();
    const windowStartMs = invoiceCreatedMs - 60000;
    const windowEndMs = Math.min(now + 60000, expiresAtMs);

    // Query Binance Pay Trade History API with bounded time window
    const result = await this.queryTransactions({
      startTimestamp: windowStartMs,
      endTimestamp: windowEndMs,
    });

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

    const fetchedRecords = result.records;

    // Helper to mask sensitive transaction IDs for diagnostics (e.g. 12345678 -> 1234...5678)
    const maskId = (id: string) => {
      if (!id || id.length <= 6) return '***';
      return `${id.substring(0, 3)}...${id.substring(id.length - 3)}`;
    };

    // 2. Fetch all transaction IDs already attached to verified or consumed deposits
    const consumedRows = await db.query<{ binance_transaction_id: string }>(
      'SELECT DISTINCT binance_transaction_id FROM deposits WHERE binance_transaction_id IS NOT NULL AND status = $1',
      ['VERIFIED']
    );
    const consumedTxIds = new Set(consumedRows.rows.map(r => r.binance_transaction_id.toLowerCase().trim()));

    // 3. Step-by-step filtering with sanitized diagnostic counters:
    // Step A: Time window check [windowStartMs, windowEndMs]
    const inWindowRecords = fetchedRecords.filter(r => {
      const txTime = Number(r.transactionTime);
      return txTime >= windowStartMs && txTime <= windowEndMs;
    });

    // Step B: Transaction ID present
    const withTxIdRecords = inWindowRecords.filter(r => Boolean(r.transactionId && r.transactionId.trim()));

    // Step C: Currency filter (strictly USDT)
    const currencyMatches = withTxIdRecords.filter(r => r.currency.toUpperCase() === expectedCurrency);

    // Step D: Direction & Order Type (incoming transfer, e.g. C2C / incoming Pay)
    // Exclude outgoing payment/payout order types
    const incomingMatches = currencyMatches.filter(r => {
      const type = (r.orderType || '').toUpperCase();
      const isOutgoing = type.includes('PAYOUT') || type.includes('WITHDRAW') || type.includes('OUT');
      return !isOutgoing;
    });

    // Step E: Receiver verification against configured BINANCE_RECEIVER_ID
    // If receiverInfo is present and does NOT match BINANCE_RECEIVER_ID: WRONG_RECEIVER -> zero credit
    // If receiver identity is unavailable in an officially supported type, do not invent a match; allow incoming
    const configuredReceiver = this.getReceiverId();
    const wrongReceiverMatches = incomingMatches.filter(r => {
      if (configuredReceiver && r.receiverInfo?.binanceId) {
        return r.receiverInfo.binanceId.trim().toLowerCase() !== configuredReceiver.toLowerCase();
      }
      return false;
    });

    const receiverMatches = incomingMatches.filter(r => {
      if (configuredReceiver && r.receiverInfo?.binanceId) {
        return r.receiverInfo.binanceId.trim().toLowerCase() === configuredReceiver.toLowerCase();
      }
      return true;
    });

    // Step F: Exact Decimal amount match
    const amountMatches = receiverMatches.filter(r => {
      try {
        return new Decimal(r.amount).equals(expectedAmount);
      } catch {
        return false;
      }
    });

    // Step G: EXCLUDE every transaction already attached to a verified/consumed deposit BEFORE ambiguity evaluation
    const unusedMatches = amountMatches.filter(r => !consumedTxIds.has(r.transactionId.toLowerCase().trim()));

    // Sort unused candidates chronologically by transactionTime
    unusedMatches.sort((a, b) => Number(a.transactionTime) - Number(b.transactionTime));

    // Sanitized diagnostics helper (zero secret or payer PII leakage)
    const buildDiagnostics = (candidates: BinanceTransactionRecord[]) => ({
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
      recordsFetched: fetchedRecords.length,
      recordsInWindow: inWindowRecords.length,
      recordsAfterCurrency: currencyMatches.length,
      recordsAfterDirectionReceiver: receiverMatches.length,
      recordsAfterAmount: amountMatches.length,
      recordsAfterAlreadyUsed: unusedMatches.length,
      eligibleCandidatesCount: candidates.length,
      maskedCandidateIds: candidates.map(c => maskId(c.transactionId)),
    });

    // If manual submittedTxId is provided, also validate against official Binance Pay transactionId
    // Never treat invoice ID, Binance receiver ID, Telegram ID, or unrelated numeric reference as transactionId!
    let eligibleCandidates = unusedMatches;
    if (submittedTxId && submittedTxId.trim()) {
      const cleanSub = submittedTxId.trim().toLowerCase();
      const configuredRec = this.getReceiverId() ? this.getReceiverId()!.toLowerCase() : '';
      const invId = depositId.toLowerCase();
      const usrId = String(deposit.user_id).toLowerCase();

      // Guard: customer submitted the invoice ID, receiver ID, or user ID instead of official transactionId
      if (cleanSub === invId || (configuredRec && cleanSub === configuredRec) || cleanSub === usrId) {
        return {
          verified: false,
          classification: 'ZERO_RECORDS_FOUND',
          message: 'The submitted value is not a Binance Transaction ID. Please enter the official Transaction ID found in your Binance Pay history.',
          sanitizedDetails: buildDiagnostics([]),
        };
      }

      eligibleCandidates = unusedMatches.filter(c => c.transactionId.toLowerCase() === cleanSub);
      if (eligibleCandidates.length === 0) {
        return {
          verified: false,
          classification: 'ZERO_RECORDS_FOUND',
          message: 'The submitted Binance Transaction ID was not found in your recent matching incoming transactions.',
          sanitizedDetails: buildDiagnostics([]),
        };
      }
    }

    const diagnostics = buildDiagnostics(eligibleCandidates);

    logger.info('Binance verification matching diagnostics', {
      depositId,
      diagnostics,
    });

    // Evaluation outcomes:
    // 0 candidates -> PAYMENT_NOT_FOUND (classified as ZERO_RECORDS_FOUND or specific mismatch)
    if (eligibleCandidates.length === 0) {
      if (wrongReceiverMatches.length > 0 && receiverMatches.length === 0) {
        return {
          verified: false,
          classification: 'WRONG_RECEIVER',
          message: `Transaction receiver ID does not match the configured Binance receiver ID.`,
          sanitizedDetails: diagnostics,
        };
      }
      if (amountMatches.length > 0 && unusedMatches.length === 0) {
        return {
          verified: false,
          classification: 'DUPLICATE_TRANSACTION',
          message: 'Matching transaction was already processed for a previous deposit.',
          sanitizedDetails: diagnostics,
        };
      }
      if (currencyMatches.length > 0 && amountMatches.length === 0) {
        return {
          verified: false,
          classification: 'WRONG_AMOUNT',
          message: `Payment not found for exact amount ${expectedAmount.toFixed(4)} USDT in this invoice window.`,
          sanitizedDetails: diagnostics,
        };
      }
      return {
        verified: false,
        classification: 'ZERO_RECORDS_FOUND',
        message: 'No matching incoming payment detected yet. Please ensure payment was sent to the correct Binance Pay ID and try again in 10-20 seconds.',
        sanitizedDetails: diagnostics,
      };
    }

    // More than 1 genuinely valid unused candidate -> AMBIGUOUS_TRANSACTION -> zero credit
    if (eligibleCandidates.length > 1) {
      logger.warn('Ambiguous matching transactions detected within invoice window', {
        depositId,
        diagnostics,
      });
      return {
        verified: false,
        classification: 'AMBIGUOUS_TRANSACTION',
        message: 'Multiple matching transactions detected in this time window. For your security, automatic matching was held. Please contact Support.',
        sanitizedDetails: diagnostics,
      };
    }

    // Exactly 1 unused valid candidate -> proceed to safety gate & credit
    const matchedTx = eligibleCandidates[0];

    // Double-check single candidate not in consumedTxIds
    if (consumedTxIds.has(matchedTx.transactionId.toLowerCase().trim())) {
      return {
        verified: false,
        classification: 'DUPLICATE_TRANSACTION',
        message: 'This Binance Transaction ID has already been credited.',
        sanitizedDetails: diagnostics,
      };
    }

    // Safety Gate Check: BINANCE_PAY_ENABLED=true alone must NEVER enable automatic wallet credit.
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
        sanitizedDetails: diagnostics,
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
          sanitizedDetails: diagnostics,
        };
      }

      // Check for concurrent consumption of this transactionId
      const checkDouble = await client.queryRow<any>(
        'SELECT id FROM deposits WHERE binance_transaction_id = $1 AND id <> $2 FOR UPDATE',
        [matchedTx.transactionId, depositId]
      );
      if (checkDouble) {
        return {
          verified: false,
          classification: 'DUPLICATE_TRANSACTION',
          message: 'This transaction was claimed concurrently by another deposit.',
          sanitizedDetails: diagnostics,
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
        JSON.stringify({
          transactionId: matchedTx.transactionId,
          transactionTime: matchedTx.transactionTime,
          orderType: matchedTx.orderType,
          amount: matchedTx.amount,
          currency: matchedTx.currency,
        }),
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
        sanitizedDetails: diagnostics,
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
