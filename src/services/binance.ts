import crypto from 'crypto';
import Decimal from 'decimal.js';
import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { walletService } from './wallet.js';
import { createLogger } from './logger.js';

const logger = createLogger('BinanceService');

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type BinanceTerminalState =
  | 'VERIFIED'
  | 'TXID_NOT_FOUND'
  | 'WRONG_AMOUNT'
  | 'WRONG_CURRENCY'
  | 'WRONG_RECEIVER'
  | 'OUTSIDE_INVOICE_WINDOW'
  | 'DUPLICATE_TRANSACTION'
  | 'EXPIRED_INVOICE'
  | 'BINANCE_API_ERROR'
  | 'BINANCE_API_TIMEOUT';

export type BinanceErrorClassification =
  | BinanceTerminalState
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
  | 'WRONG_DIRECTION'
  | 'AMBIGUOUS_TRANSACTION'
  | 'EXACT_VALID_MATCH';

export type IdentifierMatchField =
  | 'MATCHED_TRANSACTION_ID'
  | 'MATCHED_ORDER_ID'
  | 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE';

export interface BinanceTransactionRecord {
  transactionId: string;
  orderId?: string;
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

export type FetchLike = typeof fetch;

export function maskIdentifier(id?: string | null): string {
  if (!id) return '';
  const clean = String(id).trim();
  if (clean.length <= 6) return '***';
  return `${clean.substring(0, 3)}...${clean.substring(clean.length - 3)}`;
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
  private fetchOverride: FetchLike | null = null;

  constructor() {
    this.baseUrl = config.binance.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.binance.apiKey;
    this.apiSecret = config.binance.apiSecret;
    this.receiverId = config.binance.receiverId ? config.binance.receiverId.trim() : undefined;
    this.recvWindowMs = config.binance.recvWindowMs;
    this.requestTimeoutMs = config.binance.requestTimeoutMs;
  }

  public setFetchOverride(fn: FetchLike | null): void {
    this.fetchOverride = fn;
  }

  public resetTestState(): void {
    this.fetchOverride = null;
    this.readOnlyLiveVerified = false;
    this.isLiveProductionVerified = false;
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
    const credentialsConfigured = Boolean((config.binance.apiKey || this.apiKey) && (config.binance.apiSecret || this.apiSecret));
    const receiverConfigured = Boolean(this.getReceiverId());

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
    const secret = config.binance.apiSecret || this.apiSecret;
    if (!secret) {
      throw new Error('BINANCE_API_SECRET is not configured');
    }
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
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

  private classifyNetworkError(err: any): {
    classification: BinanceErrorClassification;
    message: string;
  } {
    const name = String(err?.name || '');
    const code = String(err?.code || err?.cause?.code || '').toUpperCase();
    const msg = String(err?.message || 'Network error connecting to Binance');
    const lowerMsg = msg.toLowerCase();

    if (
      name === 'AbortError' ||
      code === 'ABORT_ERR' ||
      code === 'ETIMEDOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT' ||
      lowerMsg.includes('timed out') ||
      lowerMsg.includes('abort')
    ) {
      return { classification: 'TIMEOUT', message: 'Binance request timed out' };
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || lowerMsg.includes('enotfound') || lowerMsg.includes('getaddrinfo')) {
      return { classification: 'DNS_FAILURE', message: 'DNS resolution failed while contacting Binance API' };
    }
    if (
      code.startsWith('CERT_') ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      code.startsWith('ERR_TLS') ||
      lowerMsg.includes('certificate') ||
      lowerMsg.includes('tls')
    ) {
      return { classification: 'TLS_FAILURE', message: 'TLS handshake failed while contacting Binance API' };
    }
    return {
      classification: 'NETWORK_FAILURE',
      message: msg,
    };
  }

  /**
   * Isolated read-only query to GET /sapi/v1/pay/transactions
   * Does NOT mutate any wallet balance or database state.
   */
  public async queryTransactions(params: {
    startTime?: number;
    endTime?: number;
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
    durationMs: number;
  }> {
    const startedAt = Date.now();
    const apiKey = config.binance.apiKey || this.apiKey;
    const apiSecret = config.binance.apiSecret || this.apiSecret;
    if (!apiKey || !apiSecret) {
      return {
        httpStatus: 401,
        records: [],
        errorClassification: 'AUTH_REJECTION',
        errorMessage: 'BINANCE_API_KEY or BINANCE_API_SECRET not configured.',
        durationMs: Date.now() - startedAt,
      };
    }

    const timestamp = Date.now();
    const recvWindow = Math.max(1000, Math.min(60000, Number(this.recvWindowMs) || 5000));
    const effectiveStart = params.startTime ?? params.startTimestamp;
    const effectiveEnd = params.endTime ?? params.endTimestamp;

    const queryParts: string[] = [
      `timestamp=${timestamp}`,
      `recvWindow=${recvWindow}`,
    ];

    if (effectiveStart) queryParts.push(`startTime=${effectiveStart}`);
    if (effectiveEnd) queryParts.push(`endTime=${effectiveEnd}`);
    if (params.limit) queryParts.push(`limit=${Math.max(1, Math.min(100, params.limit))}`);

    const queryString = queryParts.join('&');
    const signature = this.generateSignature(queryString);
    const fullQuery = `${queryString}&signature=${signature}`;
    const baseUrl = (config.binance.baseUrl || this.baseUrl).replace(/\/+$/, '');
    const url = `${baseUrl}/sapi/v1/pay/transactions?${fullQuery}`;

    const timeoutMs = Math.max(1000, Number(config.binance.requestTimeoutMs || this.requestTimeoutMs) || 10000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const fetchImpl = this.fetchOverride || fetch;

    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      const httpStatus = res.status;
      let rawBodyText = '';
      try {
        rawBodyText = await res.text();
      } catch (readErr: any) {
        const net = this.classifyNetworkError(readErr);
        return {
          httpStatus,
          records: [],
          errorClassification: net.classification,
          errorMessage: net.message,
          durationMs: Date.now() - startedAt,
        };
      }

      let data: any;
      try {
        data = rawBodyText ? JSON.parse(rawBodyText) : null;
        if (!data || typeof data !== 'object') {
          throw new Error('Empty or non-object JSON payload');
        }
      } catch {
        return {
          httpStatus,
          records: [],
          errorClassification: 'MALFORMED_JSON',
          errorMessage: `Failed to parse Binance JSON response (HTTP ${httpStatus})`,
          durationMs: Date.now() - startedAt,
        };
      }

      // Check HTTP rejection
      if (httpStatus !== 200) {
        const rawCode = data.code ?? httpStatus;
        const numericCode = Number(rawCode);
        const msg = String(data.msg || data.message || `Binance HTTP error ${httpStatus}`);
        let classification: BinanceErrorClassification = 'HTTP_REJECTION';

        if (httpStatus === 401 || numericCode === -2014 || numericCode === -2015) {
          classification = 'AUTH_REJECTION';
        } else if (httpStatus === 403 || numericCode === -1002 || numericCode === -2016) {
          classification = 'ELIGIBILITY_RESTRICTED';
        } else if (httpStatus === 429 || httpStatus === 418) {
          classification = 'RATE_LIMIT';
        } else if (numericCode === -1021) {
          classification = 'TIMESTAMP_RECVWINDOW_REJECTION';
        } else if (numericCode === -1022) {
          classification = 'INVALID_SIGNATURE';
        }

        return {
          httpStatus,
          binanceCode: String(rawCode),
          binanceMessage: msg,
          records: [],
          raw: data,
          errorClassification: classification,
          errorMessage: msg,
          durationMs: Date.now() - startedAt,
        };
      }

      // HTTP 200: check Binance business code
      const binanceCode = data.code;
      const binanceMessage = data.message || data.msg;

      if (binanceCode !== '000000' && binanceCode !== 0) {
        return {
          httpStatus,
          binanceCode: String(binanceCode ?? 'UNKNOWN'),
          binanceMessage: binanceMessage ? String(binanceMessage) : undefined,
          records: [],
          raw: data,
          errorClassification: 'API_PERMISSION_REJECTION',
          errorMessage: binanceMessage ? String(binanceMessage) : `Binance code ${binanceCode}`,
          durationMs: Date.now() - startedAt,
        };
      }

      const rawRecords = Array.isArray(data.data) ? data.data : (Array.isArray(data.records) ? data.records : []);
      const records: BinanceTransactionRecord[] = rawRecords.map((r: any) => ({
        transactionId: r?.transactionId ? String(r.transactionId).trim() : '',
        orderId: r?.orderId ? String(r.orderId).trim() : undefined,
        transactionTime: Number(r?.transactionTime || r?.orderTime || Date.now()),
        orderType: String(r?.orderType || 'C2C'),
        amount: new Decimal(r?.amount || 0).toFixed(4),
        currency: String(r?.currency || 'USDT').toUpperCase(),
        payerInfo: r?.payerInfo,
        receiverInfo: r?.receiverInfo,
      }));

      return {
        httpStatus,
        binanceCode: String(binanceCode),
        binanceMessage: binanceMessage ? String(binanceMessage) : undefined,
        records,
        raw: data,
        durationMs: Date.now() - startedAt,
      };
    } catch (err: any) {
      const net = this.classifyNetworkError(err);
      return {
        httpStatus: 0,
        records: [],
        errorClassification: net.classification,
        errorMessage: net.message,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async runWithOverallTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const res = await Promise.race([
        promise.then(value => ({ timedOut: false as const, value })),
        new Promise<{ timedOut: true }>(resolve => {
          timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        }),
      ]);
      return res;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private isTimeoutClassification(c?: BinanceErrorClassification): boolean {
    return c === 'TIMEOUT' || c === 'BINANCE_API_TIMEOUT';
  }

  /**
   * Verify an incoming deposit invoice against Binance transactions with full sanitized stage timings
   * and guaranteed terminal classification. Never credits wallet unless ALL strict conditions pass.
   */
  public async verifyDeposit(
    depositId: string,
    submittedTxId?: string,
    customerId?: string
  ): Promise<BinanceVerificationResult> {
    const overallStart = Date.now();
    const maskedSubmittedTxId = maskIdentifier(submittedTxId);

    logger.info('Binance verification stage: txid_received', {
      depositId,
      maskedSubmittedTxId: maskedSubmittedTxId || '(none)',
      hasCustomerId: Boolean(customerId),
    });

    try {
      const configuredTimeout = Number(config.binance.requestTimeoutMs || this.requestTimeoutMs) || 10000;
      const overallBudgetMs = Math.max(2500, configuredTimeout + 3000);
      const bounded = await this.runWithOverallTimeout(
        this.verifyDepositInternal(depositId, submittedTxId, customerId, overallStart, maskedSubmittedTxId),
        overallBudgetMs
      );

      if (bounded.timedOut) {
        const totalDurationMs = Date.now() - overallStart;
        logger.error('Binance verification stage: overall_timeout', {
          depositId,
          maskedSubmittedTxId,
          totalDurationMs,
        });
        return {
          verified: false,
          classification: 'BINANCE_API_TIMEOUT',
          message: 'Verification with Binance timed out. Zero balance was credited. Your invoice remains pending — please tap Retry Verification.',
          sanitizedDetails: {
            upstreamClassification: 'OVERALL_TIMEOUT',
            totalDurationMs,
            retryable: true,
          },
        };
      }

      return bounded.value;
    } catch (err: any) {
      const totalDurationMs = Date.now() - overallStart;
      logger.error('Binance verification stage: unexpected_exception', {
        depositId,
        maskedSubmittedTxId,
        error: err?.message || 'Unknown verification error',
        totalDurationMs,
      });
      return {
        verified: false,
        classification: 'BINANCE_API_ERROR',
        message: 'A temporary error occurred while verifying with Binance. Zero balance was credited — please tap Retry Verification.',
        sanitizedDetails: {
          upstreamClassification: 'INTERNAL_EXCEPTION',
          totalDurationMs,
          retryable: true,
        },
      };
    }
  }

  private async verifyDepositInternal(
    depositId: string,
    submittedTxId: string | undefined,
    customerId: string | undefined,
    overallStart: number,
    maskedSubmittedTxId: string
  ): Promise<BinanceVerificationResult> {
    if (!depositId) {
      return {
        verified: false,
        classification: 'TXID_NOT_FOUND',
        message: 'Deposit invoice reference is missing or expired. Please start a new deposit.',
        sanitizedDetails: { retryable: false, totalDurationMs: Date.now() - overallStart },
      };
    }

    // Stage: Load deposit
    const loadStart = Date.now();
    const deposit = await db.queryRow<any>('SELECT * FROM deposits WHERE id = $1', [depositId]);
    const depositLoadMs = Date.now() - loadStart;

    logger.info('Binance verification stage: deposit_loaded', {
      depositId,
      found: Boolean(deposit),
      status: deposit?.status,
      depositLoadMs,
    });

    if (!deposit) {
      return {
        verified: false,
        classification: 'TXID_NOT_FOUND',
        message: 'Deposit invoice not found. Please start a new deposit from Add Funds.',
        sanitizedDetails: { depositLoadMs, totalDurationMs: Date.now() - overallStart, retryable: false },
      };
    }

    // Stage: Ownership & status validation
    const valStart = Date.now();
    if (customerId && deposit.user_id !== String(customerId)) {
      return {
        verified: false,
        classification: 'ELIGIBILITY_RESTRICTED',
        message: 'This deposit invoice does not belong to your account.',
        sanitizedDetails: { validationMs: Date.now() - valStart, totalDurationMs: Date.now() - overallStart, retryable: false },
      };
    }

    if (deposit.status === 'VERIFIED') {
      return {
        verified: true,
        classification: 'VERIFIED',
        message: 'Deposit has already been verified and credited.',
        sanitizedDetails: { validationMs: Date.now() - valStart, totalDurationMs: Date.now() - overallStart },
      };
    }

    const now = Date.now();
    const expiresAtMs = deposit.expires_at ? new Date(deposit.expires_at).getTime() : now + 3600000;
    if (deposit.status === 'EXPIRED' || now > expiresAtMs) {
      await db.query("UPDATE deposits SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [depositId]);
      logger.info('Binance verification stage: expired_invoice', {
        depositId,
        validationMs: Date.now() - valStart,
        totalDurationMs: Date.now() - overallStart,
      });
      return {
        verified: false,
        classification: 'EXPIRED_INVOICE',
        message: 'This deposit invoice has expired. Zero credit was applied. Please create a new invoice.',
        sanitizedDetails: { validationMs: Date.now() - valStart, totalDurationMs: Date.now() - overallStart, retryable: false },
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
          classification: 'TXID_NOT_FOUND',
          message: 'The submitted value is not a Binance Transaction ID. Please enter the official Transaction ID found in your Binance Pay history.',
          sanitizedDetails: {
            identifierMatchField: 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE',
            validationMs: Date.now() - valStart,
            totalDurationMs: Date.now() - overallStart,
            retryable: false,
          },
        };
      }
    }

    const validationMs = Date.now() - valStart;

    // 1. Tightly bounded time window based on deposit created_at and expires_at / verification time
    const invoiceCreatedMs = new Date(deposit.created_at).getTime();
    const windowStartMs = invoiceCreatedMs - 60000;
    const windowEndMs = Math.min(now + 60000, expiresAtMs);

    // Stage: Binance API Request
    logger.info('Binance verification stage: binance_request_started', {
      depositId,
      maskedSubmittedTxId,
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
    });

    const result = await this.queryTransactions({
      startTime: windowStartMs,
      endTime: windowEndMs,
    });

    logger.info('Binance verification stage: binance_response_received', {
      depositId,
      httpStatus: result.httpStatus,
      binanceCode: result.binanceCode || null,
      recordsReturned: result.records.length,
      errorClassification: result.errorClassification || 'OK',
      binanceDurationMs: result.durationMs,
    });

    // Record attempt for audit trail (non-fatal)
    try {
      await db.query(`
        INSERT INTO deposit_attempts (id, deposit_id, attempt_number, payload, response, error_classification)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        `att_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        depositId,
        (deposit.attempt_count || 0) + 1,
        JSON.stringify({ maskedSubmittedTxId }),
        JSON.stringify({ httpStatus: result.httpStatus, code: result.binanceCode, count: result.records.length, durationMs: result.durationMs }),
        result.errorClassification || 'QUERY_OK',
      ]);
      await db.query('UPDATE deposits SET attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [depositId]);
    } catch (attErr: any) {
      logger.warn('Failed to persist deposit attempt log (non-fatal)', { depositId, error: attErr?.message });
    }

    if (result.errorClassification) {
      const isTimeout = this.isTimeoutClassification(result.errorClassification);
      const terminalClassification: BinanceTerminalState = isTimeout ? 'BINANCE_API_TIMEOUT' : 'BINANCE_API_ERROR';
      const totalDurationMs = Date.now() - overallStart;
      logger.warn('Binance verification stage: final_result_generated', {
        depositId,
        terminalClassification,
        upstreamClassification: result.errorClassification,
        httpStatus: result.httpStatus,
        binanceCode: result.binanceCode,
        binanceDurationMs: result.durationMs,
        totalDurationMs,
      });
      return {
        verified: false,
        classification: terminalClassification,
        message: isTimeout
          ? 'Binance Pay timed out while checking your transaction. Your invoice is still pending with zero credit applied — please tap Retry Verification.'
          : 'Could not verify with Binance Pay right now due to an API/network response error. Your invoice is still pending with zero credit applied — please tap Retry Verification.',
        sanitizedDetails: {
          upstreamClassification: result.errorClassification,
          httpStatus: result.httpStatus,
          binanceCode: result.binanceCode,
          binanceDurationMs: result.durationMs,
          totalDurationMs,
          retryable: true,
        },
      };
    }

    const fetchedRecords = result.records;

    // 2. Fetch all transaction IDs already attached to verified or consumed deposits
    const consumedRows = await db.query<{ binance_transaction_id: string }>(
      'SELECT DISTINCT binance_transaction_id FROM deposits WHERE binance_transaction_id IS NOT NULL AND status = $1',
      ['VERIFIED']
    );
    const consumedTxIds = new Set(consumedRows.rows.map(r => r.binance_transaction_id.toLowerCase().trim()));

    const getCanonicalTxId = (r: BinanceTransactionRecord): string => (r.transactionId || r.orderId || '').trim();
    const isConsumedRecord = (r: BinanceTransactionRecord): boolean => {
      if (r.transactionId && consumedTxIds.has(r.transactionId.toLowerCase().trim())) return true;
      if (r.orderId && consumedTxIds.has(r.orderId.toLowerCase().trim())) return true;
      return false;
    };

    // Stage: Matching & strict financial validation
    const matchStart = Date.now();
    const inWindowRecords = fetchedRecords.filter(r => {
      const txTime = Number(r.transactionTime);
      return txTime >= windowStartMs && txTime <= windowEndMs;
    });
    const withTxIdRecords = inWindowRecords.filter(r => Boolean(getCanonicalTxId(r)));
    const currencyMatches = withTxIdRecords.filter(r => r.currency.toUpperCase() === expectedCurrency);
    const incomingMatches = currencyMatches.filter(r => {
      const type = (r.orderType || '').toUpperCase();
      return !(type.includes('PAYOUT') || type.includes('WITHDRAW') || type.includes('OUT'));
    });

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
    const amountMatches = receiverMatches.filter(r => {
      try {
        return new Decimal(r.amount).equals(expectedAmount);
      } catch {
        return false;
      }
    });
    const unusedMatches = amountMatches.filter(r => !isConsumedRecord(r));
    unusedMatches.sort((a, b) => Number(a.transactionTime) - Number(b.transactionTime));

    let identifierMatchField: IdentifierMatchField = 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE';
    let eligibleCandidates = unusedMatches;

    const buildDiagnostics = (candidates: BinanceTransactionRecord[], extra: Record<string, unknown> = {}) => ({
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
      httpStatus: result.httpStatus,
      binanceCode: result.binanceCode,
      binanceDurationMs: result.durationMs,
      depositLoadMs,
      validationMs,
      recordsFetched: fetchedRecords.length,
      recordsInWindow: inWindowRecords.length,
      recordsAfterCurrency: currencyMatches.length,
      recordsAfterDirectionReceiver: receiverMatches.length,
      recordsAfterAmount: amountMatches.length,
      recordsAfterAlreadyUsed: unusedMatches.length,
      eligibleCandidatesCount: candidates.length,
      maskedCandidateIds: candidates.map(c => maskIdentifier(getCanonicalTxId(c))),
      identifierMatchField,
      ...extra,
    });

    if (submittedTxId && submittedTxId.trim()) {
      const cleanSub = submittedTxId.trim().toLowerCase();
      const configuredRec = configuredReceiver ? configuredReceiver.toLowerCase() : '';

      // Match ONLY against identifiers ACTUALLY returned by official Binance response
      let rawMatch = fetchedRecords.find(r => r.transactionId && r.transactionId.toLowerCase() === cleanSub);
      if (rawMatch) {
        identifierMatchField = 'MATCHED_TRANSACTION_ID';
      } else {
        rawMatch = fetchedRecords.find(r => r.orderId && r.orderId.toLowerCase() === cleanSub);
        if (rawMatch) {
          identifierMatchField = 'MATCHED_ORDER_ID';
        }
      }

      const matchDurationMs = Date.now() - matchStart;
      logger.info('Binance verification stage: identifier_matching_completed', {
        depositId,
        identifierMatchField,
        matchedRecordFound: Boolean(rawMatch),
        matchDurationMs,
      });

      if (!rawMatch) {
        const totalDurationMs = Date.now() - overallStart;
        return {
          verified: false,
          classification: 'TXID_NOT_FOUND',
          message: 'The submitted Binance Transaction ID was not found in recent incoming payments for this invoice window.',
          sanitizedDetails: buildDiagnostics([], { matchDurationMs, totalDurationMs, retryable: true }),
        };
      }

      const checksStart = Date.now();
      const canonicalId = getCanonicalTxId(rawMatch);
      logger.info('Inspected candidate Binance transaction', {
        depositId,
        identifierMatchField,
        maskedTransactionId: maskIdentifier(canonicalId),
        hasOrderId: Boolean(rawMatch.orderId),
        transactionTime: rawMatch.transactionTime,
        amount: rawMatch.amount,
        currency: rawMatch.currency,
        orderType: rawMatch.orderType,
        receiverMatches: Boolean(configuredRec && rawMatch.receiverInfo?.binanceId && rawMatch.receiverInfo.binanceId.trim().toLowerCase() === configuredRec),
      });

      const txTime = Number(rawMatch.transactionTime);
      if (txTime < windowStartMs || txTime > windowEndMs) {
        return {
          verified: false,
          classification: 'OUTSIDE_INVOICE_WINDOW',
          message: 'This Binance transaction timestamp is outside the invoice validity window.',
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      if (rawMatch.currency.toUpperCase() !== expectedCurrency) {
        return {
          verified: false,
          classification: 'WRONG_CURRENCY',
          message: `Transaction found but currency does not match. Expected ${expectedCurrency}.`,
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      const orderTypeUpper = (rawMatch.orderType || '').toUpperCase();
      if (orderTypeUpper.includes('PAYOUT') || orderTypeUpper.includes('WITHDRAW') || orderTypeUpper.includes('OUT')) {
        return {
          verified: false,
          classification: 'TXID_NOT_FOUND',
          message: 'This transaction is an outgoing transfer and cannot be used to credit your wallet.',
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      if (!new Decimal(rawMatch.amount).equals(expectedAmount)) {
        return {
          verified: false,
          classification: 'WRONG_AMOUNT',
          message: `Transaction amount (${rawMatch.amount} ${rawMatch.currency}) does not match expected invoice amount (${expectedAmount.toFixed(4)} USDT).`,
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      if (configuredRec && rawMatch.receiverInfo?.binanceId && rawMatch.receiverInfo.binanceId.trim().toLowerCase() !== configuredRec) {
        return {
          verified: false,
          classification: 'WRONG_RECEIVER',
          message: 'Transaction receiver does not match the configured Binance receiver ID.',
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      if (isConsumedRecord(rawMatch)) {
        return {
          verified: false,
          classification: 'DUPLICATE_TRANSACTION',
          message: 'This Binance Transaction ID has already been credited to an account.',
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      eligibleCandidates = unusedMatches.filter(
        c => (c.transactionId && c.transactionId.toLowerCase() === cleanSub) || (c.orderId && c.orderId.toLowerCase() === cleanSub)
      );

      logger.info('Binance verification stage: checks_completed', {
        depositId,
        identifierMatchField,
        eligibleCount: eligibleCandidates.length,
        checksDurationMs: Date.now() - checksStart,
      });

      if (eligibleCandidates.length === 0) {
        return {
          verified: false,
          classification: 'TXID_NOT_FOUND',
          message: 'The submitted Binance Transaction ID was not found in your recent matching incoming transactions.',
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: true }),
        };
      }
    }

    const diagnostics = buildDiagnostics(eligibleCandidates, { totalDurationMs: Date.now() - overallStart });

    logger.info('Binance verification matching diagnostics', {
      depositId,
      diagnostics,
    });

    // Evaluation outcomes: 0 candidates
    if (eligibleCandidates.length === 0) {
      if (wrongReceiverMatches.length > 0 && receiverMatches.length === 0) {
        return {
          verified: false,
          classification: 'WRONG_RECEIVER',
          message: 'Transaction receiver ID does not match the configured Binance receiver ID.',
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
        classification: 'TXID_NOT_FOUND',
        message: 'No matching incoming payment detected yet. Please verify your Transaction ID and try again in 10–20 seconds.',
        sanitizedDetails: { ...diagnostics, retryable: true },
      };
    }

    // Multiple unused matching candidates without unambiguous TXID -> zero credit
    if (eligibleCandidates.length > 1) {
      logger.warn('Ambiguous matching transactions detected within invoice window', {
        depositId,
        diagnostics,
      });
      return {
        verified: false,
        classification: 'TXID_NOT_FOUND',
        message: 'Multiple matching transactions were detected in this window. Please enter the exact Transaction ID or contact Support.',
        sanitizedDetails: { ...diagnostics, upstreamClassification: 'AMBIGUOUS_TRANSACTION', retryable: true },
      };
    }

    const matchedTx = eligibleCandidates[0];
    const matchedCanonicalId = getCanonicalTxId(matchedTx);

    if (isConsumedRecord(matchedTx)) {
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

    // Stage: Atomic database credit transaction
    const dbStageStart = Date.now();
    const txResult = await db.withTransaction(async (client) => {
      const lockedDeposit = await client.queryRow<any>(
        'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
        [depositId]
      );

      if (lockedDeposit.status === 'VERIFIED') {
        return {
          verified: true,
          classification: 'VERIFIED' as BinanceErrorClassification,
          message: 'Deposit already credited.',
          transaction: matchedTx,
          sanitizedDetails: diagnostics,
        };
      }

      const checkDouble = await client.queryRow<any>(
        'SELECT id FROM deposits WHERE binance_transaction_id = $1 AND id <> $2 FOR UPDATE',
        [matchedCanonicalId, depositId]
      );
      if (checkDouble) {
        return {
          verified: false,
          classification: 'DUPLICATE_TRANSACTION' as BinanceErrorClassification,
          message: 'This transaction was claimed concurrently by another deposit.',
          sanitizedDetails: diagnostics,
        };
      }

      await client.query(`
        UPDATE deposits
        SET status = 'VERIFIED',
            binance_transaction_id = $1,
            binance_order_type = $2,
            verified_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `, [matchedCanonicalId, matchedTx.orderType, depositId]);

      await client.query(`
        INSERT INTO payment_transactions (id, deposit_id, provider, external_ref, amount, currency, raw_data)
        VALUES ($1, $2, 'BINANCE_PAY', $3, $4, $5, $6)
      `, [
        `pt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        depositId,
        matchedCanonicalId,
        matchedTx.amount,
        matchedTx.currency,
        JSON.stringify({
          transactionId: matchedTx.transactionId || undefined,
          orderId: matchedTx.orderId || undefined,
          transactionTime: matchedTx.transactionTime,
          orderType: matchedTx.orderType,
          amount: matchedTx.amount,
          currency: matchedTx.currency,
        }),
      ]);

      const operationRef = `DEP_BINANCE_${matchedCanonicalId}`;
      await walletService.executeMutation({
        userId: lockedDeposit.user_id,
        amount: expectedAmount,
        operationRef,
        idempotencyKey: depositId,
        entryType: 'DEPOSIT',
        reason: `Binance Pay USDT automatic credit (${matchedCanonicalId.substring(0, 8)}...)`,
        source: 'BINANCE_USDT',
        actor: 'SYSTEM_VERIFIER',
        metadata: {
          depositId,
          orderType: matchedTx.orderType,
        },
      });

      const dbStageMs = Date.now() - dbStageStart;
      const totalDurationMs = Date.now() - overallStart;
      logger.info('Binance verification stage: final_result_generated', {
        depositId,
        userId: lockedDeposit.user_id,
        amount: expectedAmount.toFixed(4),
        classification: 'VERIFIED',
        identifierMatchField,
        dbStageMs,
        totalDurationMs,
      });

      return {
        verified: true,
        classification: 'VERIFIED' as BinanceErrorClassification,
        message: `Successfully verified and credited ${expectedAmount.toFixed(4)} USDT to your wallet!`,
        transaction: matchedTx,
        sanitizedDetails: { ...diagnostics, dbStageMs, totalDurationMs },
      };
    });

    return txResult;
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
          durationMs: res.durationMs,
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
      classification: 'VERIFIED',
      message: 'Binance API connected and read-only transaction query returned HTTP 200 OK.',
      details: {
        httpStatus: res.httpStatus,
        binanceCode: res.binanceCode,
        recordsReturned: res.records.length,
        testPaymentDetected: res.records.length > 0,
        durationMs: res.durationMs,
      },
      readOnlyLiveVerified: this.readOnlyLiveVerified,
      automaticCreditEnabled: readiness.automaticCreditEnabled,
    };
  }
}

export const binanceService = new BinanceService();
