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
  | 'ALREADY_VERIFIED'
  | 'TXID_NOT_FOUND'
  | 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE'
  | 'PAYMENT_BEFORE_INVOICE'
  | 'OUTSIDE_INVOICE_WINDOW'
  | 'WRONG_AMOUNT'
  | 'WRONG_CURRENCY'
  | 'WRONG_RECEIVER'
  | 'NOT_INCOMING'
  | 'DUPLICATE_TRANSACTION'
  | 'EXPIRED_INVOICE'
  | 'ELIGIBILITY_RESTRICTED'
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
  | 'ZERO_RECORDS_FOUND'
  | 'WRONG_DIRECTION'
  | 'AMBIGUOUS_TRANSACTION'
  | 'EXACT_VALID_MATCH';

export type IdentifierMatchField =
  | 'MATCHED_ORDER_ID'
  | 'MATCHED_TRANSACTION_ID'
  | 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE';

export interface BinanceTransactionRecord {
  transactionId: string;
  orderId?: string | null;
  orderNo?: string | null;
  counterpartyId?: string | null;
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

export const BINANCE_DIAGNOSTIC_FIXED_WINDOW = {
  startTime: 1794581745000, // 2026-11-13T14:55:45.000Z
  endTime: 1794582945000,   // 2026-11-13T15:15:45.000Z
  limit: 100,
  targetAmount: '0.2',
  targetCurrency: 'USDT',
} as const;

export type BinanceDiagnosticConclusion =
  | 'MATCHED_TRANSACTION_ID'
  | 'MATCHED_ORDER_ID'
  | 'MATCHED_ORDER_NO'
  | 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE'
  | 'PAYMENT_RECORD_FOUND_BUT_NO_COMPARABLE_IDENTIFIER'
  | 'NO_RELEVANT_0_2_USDT_RECORD'
  | 'BINANCE_API_REJECTED'
  | 'BINANCE_API_TIMEOUT';

export interface BinanceDiagnosticCandidate {
  transactionTime: number;
  amount: string;
  currency: string;
  orderType: string;
  direction: 'INCOMING' | 'OUTGOING' | 'UNKNOWN';
  receiverMatch: 'YES' | 'NO' | 'UNKNOWN';
  transactionIdPresent: 'YES' | 'NO';
  maskedTransactionId: string;
  orderIdPresent: 'YES' | 'NO';
  maskedOrderId?: string;
  orderNoPresent: 'YES' | 'NO';
  maskedOrderNo?: string;
  presentIdentifierKeys: string[];
}

export interface BinanceReadOnlyDiagnosticResult {
  mode: 'READ_ONLY';
  walletMutation: 'IMPOSSIBLE';
  windowStartMs: number;
  windowEndMs: number;
  windowStartIso: string;
  windowEndIso: string;
  httpStatus: number;
  binanceCode: string | null;
  binanceMessage: string | null;
  recordsReturned: number;
  relevantRecordsCount: number;
  candidates: BinanceDiagnosticCandidate[];
  identifierConclusion: BinanceDiagnosticConclusion;
  durationMs: number;
  success: boolean;
  errorClassification?: string;
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
      const records: BinanceTransactionRecord[] = rawRecords.map((r: any) => {
        const rawTxId =
          r?.transactionId !== undefined && r?.transactionId !== null && String(r.transactionId).trim() !== ''
            ? String(r.transactionId).trim()
            : '';
        const rawOrderId =
          r?.orderId !== undefined && r?.orderId !== null && String(r.orderId).trim() !== ''
            ? String(r.orderId).trim()
            : undefined;
        const rawOrderNo =
          r?.orderNo !== undefined && r?.orderNo !== null && String(r.orderNo).trim() !== ''
            ? String(r.orderNo).trim()
            : undefined;
        const rawCounterpartyId =
          r?.counterpartyId !== undefined && r?.counterpartyId !== null && String(r.counterpartyId).trim() !== ''
            ? String(r.counterpartyId).trim()
            : undefined;
        const parsedTime =
          r?.transactionTime !== undefined && r?.transactionTime !== null
            ? Number(r.transactionTime)
            : r?.orderTime !== undefined && r?.orderTime !== null
              ? Number(r.orderTime)
              : NaN;

        let formattedAmount = '0.0000';
        try {
          formattedAmount = new Decimal(r?.amount ?? 0).toFixed(4);
        } catch {
          formattedAmount = '0.0000';
        }

        return {
          transactionId: rawTxId,
          ...(rawOrderId !== undefined ? { orderId: rawOrderId } : {}),
          ...(rawOrderNo !== undefined ? { orderNo: rawOrderNo } : {}),
          ...(rawCounterpartyId !== undefined ? { counterpartyId: rawCounterpartyId } : {}),
          transactionTime: parsedTime,
          orderType: String(r?.orderType || 'C2C'),
          amount: formattedAmount,
          currency: String(r?.currency || 'USDT').toUpperCase(),
          payerInfo: r?.payerInfo,
          receiverInfo: r?.receiverInfo,
        };
      });

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

  private isOutgoingOrderType(orderType?: string | null, amount?: string | null): boolean {
    const typeUpper = String(orderType || '').trim().toUpperCase();
    if (
      typeUpper.includes('PAYOUT') ||
      typeUpper.includes('WITHDRAW') ||
      typeUpper.includes('OUT') ||
      typeUpper.includes('SEND') ||
      typeUpper.includes('SPEND')
    ) {
      return true;
    }
    if (amount !== undefined && amount !== null) {
      try {
        if (new Decimal(amount).isNegative()) {
          return true;
        }
      } catch {
        // Ignore parse error here; handled by amount equality check
      }
    }
    return false;
  }

  /**
   * Read-only helper invoked strictly on misses in the invoice credit window to distinguish
   * pre-invoice payments (PAYMENT_BEFORE_INVOICE) from unknown references (TXID_NOT_FOUND).
   * Structurally incapable of crediting a wallet or altering deposits.
   */
  private async detectPreInvoicePaymentReadOnly(params: {
    submittedId: string;
    invoiceCreatedMs: number;
    windowStartMs: number;
  }): Promise<'PAYMENT_BEFORE_INVOICE' | 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE' | null> {
    const lookbackMs = 6 * 60 * 60 * 1000; // Bounded 6h pre-invoice window (never 90-day scan)
    const searchStartMs = Math.max(0, params.invoiceCreatedMs - lookbackMs);
    const searchEndMs = Math.max(searchStartMs, params.windowStartMs - 1);

    try {
      const priorRes = await this.queryTransactions({
        startTime: searchStartMs,
        endTime: searchEndMs,
        limit: 100,
      });

      if (priorRes.errorClassification || priorRes.records.length === 0) {
        return null;
      }

      const sub = params.submittedId;
      const ordMatch = priorRes.records.find(r => r.orderId !== undefined && r.orderId !== null && r.orderId.trim() === sub);
      const txMatch = ordMatch || priorRes.records.find(r => r.transactionId && r.transactionId.trim() === sub);

      if (txMatch) {
        const txTime = Number(txMatch.transactionTime);
        if (Number.isFinite(txTime) && txTime < params.windowStartMs) {
          return 'PAYMENT_BEFORE_INVOICE';
        }
        return null;
      }

      const nonProofMatch = priorRes.records.find(
        r =>
          (r.counterpartyId !== undefined && r.counterpartyId !== null && r.counterpartyId.trim() === sub) ||
          (r.payerInfo?.binanceId !== undefined && r.payerInfo.binanceId !== null && String(r.payerInfo.binanceId).trim() === sub) ||
          (r.orderNo !== undefined && r.orderNo !== null && r.orderNo.trim() === sub)
      );
      if (nonProofMatch) {
        return 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE';
      }

      return null;
    } catch {
      return null;
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
        classification: 'ALREADY_VERIFIED',
        message: 'This deposit invoice has already been verified and credited to your wallet.',
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

    if (deposit.status !== 'PENDING') {
      return {
        verified: false,
        classification: 'ELIGIBILITY_RESTRICTED',
        message: 'This deposit invoice is no longer pending verification.',
        sanitizedDetails: { validationMs: Date.now() - valStart, totalDurationMs: Date.now() - overallStart, retryable: false },
      };
    }

    const expectedAmount = new Decimal(deposit.amount);
    const expectedCurrency = (deposit.currency || 'USDT').toUpperCase();
    const hasSubmittedRef = submittedTxId !== undefined;
    const normalizedSubmitted = hasSubmittedRef ? String(submittedTxId).trim() : '';

    // Strict identifier hygiene check when customer submits an Order ID / reference
    if (hasSubmittedRef) {
      if (
        !normalizedSubmitted ||
        normalizedSubmitted.length < 3 ||
        normalizedSubmitted.length > 128 ||
        /[\s\x00-\x1F\x7F]/.test(normalizedSubmitted)
      ) {
        return {
          verified: false,
          classification: 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE',
          message:
            'Please submit a valid Binance Order ID from Binance App → Pay → History → Payment Details.',
          sanitizedDetails: {
            identifierMatchField: 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE',
            validationMs: Date.now() - valStart,
            totalDurationMs: Date.now() - overallStart,
            retryable: false,
          },
        };
      }

      const configuredRec = this.getReceiverId() ? this.getReceiverId()!.trim() : '';
      const recRef = deposit.receiver_ref ? String(deposit.receiver_ref).trim() : '';
      const invId = depositId.trim();
      const usrId = String(deposit.user_id).trim();

      if (
        normalizedSubmitted === invId ||
        (configuredRec && normalizedSubmitted === configuredRec) ||
        (recRef && normalizedSubmitted === recRef) ||
        normalizedSubmitted === usrId
      ) {
        return {
          verified: false,
          classification: 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE',
          message:
            'The submitted value is not a valid Binance Order ID. Do not submit the invoice ID, receiver Binance ID, or your Telegram user ID.',
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

    // Tightly bounded time window based on invoice.created_at - configuredClockTolerance
    const toleranceSec = Math.max(0, Math.min(300, Number(config.binance.paymentClockToleranceSeconds ?? 60)));
    const toleranceMs = toleranceSec * 1000;
    const invoiceCreatedMs = new Date(deposit.created_at).getTime();
    const windowStartMs = invoiceCreatedMs - toleranceMs;
    const windowEndMs = Math.min(now, expiresAtMs) + toleranceMs;

    // Stage: Binance API Request
    logger.info('Binance verification stage: binance_request_started', {
      depositId,
      maskedSubmittedTxId,
      clockToleranceSeconds: toleranceSec,
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
    });

    const result = await this.queryTransactions({
      startTime: windowStartMs,
      endTime: windowEndMs,
      limit: 100,
    });

    logger.info('Binance verification stage: binance_response_received', {
      depositId,
      httpStatus: result.httpStatus,
      binanceCode: result.binanceCode || null,
      recordsReturned: result.records.length,
      errorClassification: result.errorClassification || 'OK',
      binanceDurationMs: result.durationMs,
    });

    // Record attempt for audit trail (non-fatal, masked reference only)
    try {
      await db.query(
        `
        INSERT INTO deposit_attempts (id, deposit_id, attempt_number, payload, response, error_classification)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
        [
          `att_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          depositId,
          (deposit.attempt_count || 0) + 1,
          JSON.stringify({ maskedSubmittedTxId }),
          JSON.stringify({ httpStatus: result.httpStatus, code: result.binanceCode, count: result.records.length, durationMs: result.durationMs }),
          result.errorClassification || 'QUERY_OK',
        ]
      );
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
          ? 'Binance Pay timed out while checking your Order ID. Your invoice is still pending with zero credit applied — please tap Retry Verification.'
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

    // Fetch all transactionIds AND orderIds already attached to verified deposits (replay guard)
    const consumedRows = await db.query<{ binance_transaction_id: string | null; binance_order_id: string | null }>(
      `SELECT binance_transaction_id, binance_order_id
       FROM deposits
       WHERE status = $1
         AND (binance_transaction_id IS NOT NULL OR binance_order_id IS NOT NULL)`,
      ['VERIFIED']
    );
    const consumedIds = new Set<string>();
    for (const row of consumedRows.rows) {
      if (row.binance_transaction_id) consumedIds.add(String(row.binance_transaction_id).trim());
      if (row.binance_order_id) consumedIds.add(String(row.binance_order_id).trim());
    }

    const getCanonicalTxId = (r: BinanceTransactionRecord): string => (r.transactionId || r.orderId || '').trim();
    const isConsumedRecord = (r: BinanceTransactionRecord): boolean => {
      if (r.transactionId && consumedIds.has(r.transactionId.trim())) return true;
      if (r.orderId && consumedIds.has(r.orderId.trim())) return true;
      return false;
    };

    // Stage: Matching & strict financial validation
    const matchStart = Date.now();
    const configuredReceiver = this.getReceiverId();
    const configuredRecTrimmed = configuredReceiver ? configuredReceiver.trim() : '';

    let identifierMatchField: IdentifierMatchField = 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE';

    const buildDiagnostics = (candidates: BinanceTransactionRecord[], extra: Record<string, unknown> = {}) => ({
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
      clockToleranceSeconds: toleranceSec,
      httpStatus: result.httpStatus,
      binanceCode: result.binanceCode,
      binanceDurationMs: result.durationMs,
      depositLoadMs,
      validationMs,
      recordsFetched: fetchedRecords.length,
      eligibleCandidatesCount: candidates.length,
      maskedCandidateIds: candidates.map(c => maskIdentifier(getCanonicalTxId(c))),
      identifierMatchField,
      ...extra,
    });

    let matchedTx: BinanceTransactionRecord | undefined;

    if (hasSubmittedRef) {
      // Exact string matching priority:
      // 1. Official Binance orderId -> MATCHED_ORDER_ID
      // 2. Official Binance transactionId (compatibility fallback) -> MATCHED_TRANSACTION_ID
      let rawMatch = fetchedRecords.find(
        r => r.orderId !== undefined && r.orderId !== null && r.orderId.trim() === normalizedSubmitted
      );
      if (rawMatch) {
        identifierMatchField = 'MATCHED_ORDER_ID';
      } else {
        rawMatch = fetchedRecords.find(r => r.transactionId && r.transactionId.trim() === normalizedSubmitted);
        if (rawMatch) {
          identifierMatchField = 'MATCHED_TRANSACTION_ID';
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
        // Reject counterpartyId, payerInfo.binanceId, or unrelated orderNo explicitly
        const nonProofMatch = fetchedRecords.find(
          r =>
            (r.counterpartyId !== undefined && r.counterpartyId !== null && r.counterpartyId.trim() === normalizedSubmitted) ||
            (r.payerInfo?.binanceId !== undefined &&
              r.payerInfo.binanceId !== null &&
              String(r.payerInfo.binanceId).trim() === normalizedSubmitted) ||
            (r.orderNo !== undefined && r.orderNo !== null && r.orderNo.trim() === normalizedSubmitted)
        );
        if (nonProofMatch) {
          const totalDurationMs = Date.now() - overallStart;
          return {
            verified: false,
            classification: 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE',
            message:
              'The submitted ID does not match a verifiable Binance Pay Order ID. Please open Payment Details in Binance Pay History and submit the official Order ID.',
            sanitizedDetails: buildDiagnostics([], { matchDurationMs, totalDurationMs, retryable: false }),
          };
        }

        // Bounded non-credit check for pre-invoice payments
        const preInvoiceClass = await this.detectPreInvoicePaymentReadOnly({
          submittedId: normalizedSubmitted,
          invoiceCreatedMs,
          windowStartMs,
        });

        if (preInvoiceClass === 'PAYMENT_BEFORE_INVOICE') {
          const totalDurationMs = Date.now() - overallStart;
          return {
            verified: false,
            classification: 'PAYMENT_BEFORE_INVOICE',
            message:
              'This payment was completed before this invoice was created, so it cannot be used for this invoice. Please create a current invoice before making a payment.',
            sanitizedDetails: buildDiagnostics([], { matchDurationMs, totalDurationMs, retryable: false }),
          };
        }

        if (preInvoiceClass === 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE') {
          const totalDurationMs = Date.now() - overallStart;
          return {
            verified: false,
            classification: 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE',
            message:
              'The submitted ID is not a verifiable Binance Pay Order ID. Please open Payment Details in Binance Pay History and submit the official Order ID.',
            sanitizedDetails: buildDiagnostics([], { matchDurationMs, totalDurationMs, retryable: false }),
          };
        }

        const totalDurationMs = Date.now() - overallStart;
        return {
          verified: false,
          classification: 'TXID_NOT_FOUND',
          message: 'The submitted Binance Order ID was not found in incoming payments for this invoice window.',
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
        receiverMatches: Boolean(
          configuredRecTrimmed &&
            rawMatch.receiverInfo?.binanceId &&
            rawMatch.receiverInfo.binanceId.trim().toLowerCase() === configuredRecTrimmed.toLowerCase()
        ),
      });

      // Exact Validation Precedence Order:
      // 1. Duplicate/replay protection
      if (isConsumedRecord(rawMatch)) {
        return {
          verified: false,
          classification: 'DUPLICATE_TRANSACTION',
          message: 'This Binance payment has already been verified and credited to an account.',
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      // (2 & 3: Invoice ownership/status and invoice expiry already validated before Binance query)

      // 4. Payment timestamp window (PAYMENT_BEFORE_INVOICE vs OUTSIDE_INVOICE_WINDOW)
      const txTime = Number(rawMatch.transactionTime);
      if (!Number.isFinite(txTime)) {
        return {
          verified: false,
          classification: 'OUTSIDE_INVOICE_WINDOW',
          message: 'This Binance transaction timestamp could not be verified within the invoice window.',
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }
      if (txTime < windowStartMs) {
        return {
          verified: false,
          classification: 'PAYMENT_BEFORE_INVOICE',
          message:
            'This payment was completed before this invoice was created, so it cannot be used for this invoice. Please create a current invoice before making a payment.',
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }
      if (txTime > windowEndMs) {
        return {
          verified: false,
          classification: 'OUTSIDE_INVOICE_WINDOW',
          message: 'This Binance transaction timestamp is outside the invoice validity window.',
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      // 5. Currency
      if ((rawMatch.currency || '').toUpperCase() !== expectedCurrency) {
        return {
          verified: false,
          classification: 'WRONG_CURRENCY',
          message: `Transaction found but currency does not match. Expected ${expectedCurrency}.`,
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      // 6. Amount
      let parsedAmount: Decimal;
      try {
        parsedAmount = new Decimal(rawMatch.amount);
      } catch {
        parsedAmount = new Decimal(0);
      }
      if (!parsedAmount.equals(expectedAmount)) {
        return {
          verified: false,
          classification: 'WRONG_AMOUNT',
          message: `Transaction amount (${rawMatch.amount} ${rawMatch.currency}) does not match expected invoice amount (${expectedAmount.toFixed(4)} USDT).`,
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      // 7. Incoming direction
      if (this.isOutgoingOrderType(rawMatch.orderType, rawMatch.amount)) {
        return {
          verified: false,
          classification: 'NOT_INCOMING',
          message: 'This transaction is an outgoing transfer and cannot be used to credit your wallet.',
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      // 8. Receiver
      if (
        configuredRecTrimmed &&
        rawMatch.receiverInfo?.binanceId &&
        rawMatch.receiverInfo.binanceId.trim().toLowerCase() !== configuredRecTrimmed.toLowerCase()
      ) {
        return {
          verified: false,
          classification: 'WRONG_RECEIVER',
          message: 'Transaction receiver does not match the configured Binance receiver ID.',
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      if (!canonicalId) {
        return {
          verified: false,
          classification: 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE',
          message: 'Transaction record returned by Binance had no comparable payment identifier.',
          sanitizedDetails: buildDiagnostics([], { checksDurationMs: Date.now() - checksStart, totalDurationMs: Date.now() - overallStart, retryable: false }),
        };
      }

      matchedTx = rawMatch;
      logger.info('Binance verification stage: checks_completed', {
        depositId,
        identifierMatchField,
        eligibleCount: 1,
        checksDurationMs: Date.now() - checksStart,
      });
    } else {
      // Unspecified TXID internal compatibility scan
      const inWindowRecords = fetchedRecords.filter(r => {
        const txTime = Number(r.transactionTime);
        return Number.isFinite(txTime) && txTime >= windowStartMs && txTime <= windowEndMs;
      });
      const withTxIdRecords = inWindowRecords.filter(r => Boolean(getCanonicalTxId(r)));
      const currencyMatches = withTxIdRecords.filter(r => r.currency.toUpperCase() === expectedCurrency);
      const incomingMatches = currencyMatches.filter(r => !this.isOutgoingOrderType(r.orderType, r.amount));
      const wrongReceiverMatches = incomingMatches.filter(r => {
        if (configuredRecTrimmed && r.receiverInfo?.binanceId) {
          return r.receiverInfo.binanceId.trim().toLowerCase() !== configuredRecTrimmed.toLowerCase();
        }
        return false;
      });
      const receiverMatches = incomingMatches.filter(r => {
        if (configuredRecTrimmed && r.receiverInfo?.binanceId) {
          return r.receiverInfo.binanceId.trim().toLowerCase() === configuredRecTrimmed.toLowerCase();
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

      const diagnostics = buildDiagnostics(unusedMatches, { totalDurationMs: Date.now() - overallStart });

      if (unusedMatches.length === 0) {
        if (wrongReceiverMatches.length > 0 && receiverMatches.length === 0) {
          return {
            verified: false,
            classification: 'WRONG_RECEIVER',
            message: 'Transaction receiver ID does not match the configured Binance receiver ID.',
            sanitizedDetails: diagnostics,
          };
        }
        if (amountMatches.length > 0) {
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
          message: 'No matching incoming payment detected yet. Please submit your Binance Order ID.',
          sanitizedDetails: { ...diagnostics, retryable: true },
        };
      }

      if (unusedMatches.length > 1) {
        return {
          verified: false,
          classification: 'TXID_NOT_FOUND',
          message: 'Multiple matching transactions were detected in this window. Please enter your exact Binance Order ID.',
          sanitizedDetails: { ...diagnostics, upstreamClassification: 'AMBIGUOUS_TRANSACTION', retryable: true },
        };
      }

      matchedTx = unusedMatches[0];
      identifierMatchField = matchedTx.orderId ? 'MATCHED_ORDER_ID' : 'MATCHED_TRANSACTION_ID';
    }

    const diagnostics = buildDiagnostics([matchedTx], { totalDurationMs: Date.now() - overallStart });
    const matchedCanonicalId = getCanonicalTxId(matchedTx);
    const matchedOrderId = matchedTx.orderId ? matchedTx.orderId.trim() : null;

    // 9. Financial Readiness Safety Gate: BINANCE_PAY_ENABLED=true alone must NEVER enable automatic wallet credit.
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

    // 10. Atomic database credit transaction
    const dbStageStart = Date.now();
    const txResult = await db.withTransaction(async (client) => {
      const lockedDeposit = await client.queryRow<any>(
        'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
        [depositId]
      );

      if (!lockedDeposit) {
        return {
          verified: false,
          classification: 'TXID_NOT_FOUND' as BinanceErrorClassification,
          message: 'Deposit invoice not found.',
          sanitizedDetails: diagnostics,
        };
      }

      if (customerId && lockedDeposit.user_id !== String(customerId)) {
        return {
          verified: false,
          classification: 'ELIGIBILITY_RESTRICTED' as BinanceErrorClassification,
          message: 'This deposit invoice does not belong to your account.',
          sanitizedDetails: diagnostics,
        };
      }

      if (lockedDeposit.status === 'VERIFIED') {
        return {
          verified: true,
          classification: 'ALREADY_VERIFIED' as BinanceErrorClassification,
          message: 'This deposit invoice has already been verified and credited to your wallet.',
          transaction: matchedTx,
          sanitizedDetails: diagnostics,
        };
      }

      const lockedExpiresMs = lockedDeposit.expires_at ? new Date(lockedDeposit.expires_at).getTime() : Date.now() + 3600000;
      if (lockedDeposit.status === 'EXPIRED' || Date.now() > lockedExpiresMs) {
        return {
          verified: false,
          classification: 'EXPIRED_INVOICE' as BinanceErrorClassification,
          message: 'This deposit invoice has expired.',
          sanitizedDetails: diagnostics,
        };
      }

      if (lockedDeposit.status !== 'PENDING') {
        return {
          verified: false,
          classification: 'ELIGIBILITY_RESTRICTED' as BinanceErrorClassification,
          message: 'This deposit invoice is not eligible for verification.',
          sanitizedDetails: diagnostics,
        };
      }

      const idsToCheck = Array.from(new Set([matchedCanonicalId, matchedOrderId].filter((v): v is string => Boolean(v))));
      if (idsToCheck.length > 0) {
        const placeholders = idsToCheck.map((_, idx) => `$${idx + 2}`).join(', ');
        const checkDouble = await client.queryRow<any>(
          `SELECT id FROM deposits
           WHERE id <> $1
             AND (binance_transaction_id IN (${placeholders}) OR binance_order_id IN (${placeholders}))
           FOR UPDATE`,
          [depositId, ...idsToCheck]
        );
        if (checkDouble) {
          return {
            verified: false,
            classification: 'DUPLICATE_TRANSACTION' as BinanceErrorClassification,
            message: 'This Binance payment was already claimed by another deposit.',
            sanitizedDetails: diagnostics,
          };
        }
      }

      await client.query(
        `
        UPDATE deposits
        SET status = 'VERIFIED',
            binance_transaction_id = $1,
            binance_order_id = $2,
            binance_match_type = $3,
            binance_order_type = $4,
            txid = $5,
            verified_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $6
      `,
        [
          matchedCanonicalId,
          matchedOrderId,
          identifierMatchField,
          matchedTx.orderType,
          maskIdentifier(matchedOrderId || matchedCanonicalId),
          depositId,
        ]
      );

      const sanitizedProofId = maskIdentifier(matchedOrderId || matchedCanonicalId);
      const txRefHash = crypto.createHash('sha256').update(matchedCanonicalId).digest('hex').slice(0, 16);

      await client.query(
        `
        INSERT INTO payment_transactions (id, deposit_id, provider, external_ref, amount, currency, raw_data)
        VALUES ($1, $2, 'BINANCE_PAY', $3, $4, $5, $6)
      `,
        [
          `pt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          depositId,
          `BIN_REF_${txRefHash}`,
          matchedTx.amount,
          matchedTx.currency,
          JSON.stringify({
            maskedTransactionId: matchedTx.transactionId ? maskIdentifier(matchedTx.transactionId) : undefined,
            maskedOrderId: matchedOrderId ? maskIdentifier(matchedOrderId) : undefined,
            matchType: identifierMatchField,
            transactionTime: matchedTx.transactionTime,
            orderType: matchedTx.orderType,
            amount: matchedTx.amount,
            currency: matchedTx.currency,
          }),
        ]
      );

      const operationRef = `DEP_BINANCE_${txRefHash}`;
      await walletService.executeMutation({
        userId: lockedDeposit.user_id,
        amount: expectedAmount,
        operationRef,
        idempotencyKey: depositId,
        entryType: 'DEPOSIT',
        reason: `Binance Pay USDT automatic credit (${sanitizedProofId})`,
        source: 'BINANCE_USDT',
        actor: 'SYSTEM_VERIFIER',
        metadata: {
          depositId,
          orderType: matchedTx.orderType,
          matchType: identifierMatchField,
        },
        client,
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

  private sanitizeDiagnosticMessage(msg?: string | null): string | null {
    if (!msg) return null;
    return String(msg)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[<>`*_\[\\]/g, '')
      .trim()
      .slice(0, 120);
  }

  /**
   * TEMPORARY ADMIN-ONLY STRICTLY READ-ONLY BINANCE HISTORY DIAGNOSTIC
   *
   * Structurally isolated from wallet credits, ledger entries, deposits, orders, or any DB mutations.
   * Calls ONLY official signed GET /sapi/v1/pay/transactions and returns sanitized fields only.
   */
  public async inspectPayHistoryReadOnly(
    startTime: number,
    endTime: number,
    submittedReference?: string
  ): Promise<BinanceReadOnlyDiagnosticResult> {
    const startedAt = Date.now();
    const safeStart = Number(startTime);
    const safeEnd = Number(endTime);
    const windowStartIso = Number.isFinite(safeStart) ? new Date(safeStart).toISOString() : '';
    const windowEndIso = Number.isFinite(safeEnd) ? new Date(safeEnd).toISOString() : '';
    const normalizedRef = typeof submittedReference === 'string' ? submittedReference.trim() : '';

    try {
      const apiRes = await this.queryTransactions({
        startTime: safeStart,
        endTime: safeEnd,
        limit: BINANCE_DIAGNOSTIC_FIXED_WINDOW.limit,
      });

      if (apiRes.errorClassification) {
        const isTimeout = this.isTimeoutClassification(apiRes.errorClassification);
        const conclusion: BinanceDiagnosticConclusion = isTimeout ? 'BINANCE_API_TIMEOUT' : 'BINANCE_API_REJECTED';
        return {
          mode: 'READ_ONLY',
          walletMutation: 'IMPOSSIBLE',
          windowStartMs: safeStart,
          windowEndMs: safeEnd,
          windowStartIso,
          windowEndIso,
          httpStatus: apiRes.httpStatus,
          binanceCode: apiRes.binanceCode ? String(apiRes.binanceCode) : null,
          binanceMessage: this.sanitizeDiagnosticMessage(apiRes.binanceMessage || apiRes.errorMessage),
          recordsReturned: 0,
          relevantRecordsCount: 0,
          candidates: [],
          identifierConclusion: conclusion,
          durationMs: Date.now() - startedAt,
          success: false,
          errorClassification: apiRes.errorClassification,
        };
      }

      const rawList: any[] = Array.isArray(apiRes.raw?.data)
        ? apiRes.raw.data
        : Array.isArray(apiRes.raw?.records)
          ? apiRes.raw.records
          : [];

      const targetAmount = new Decimal(BINANCE_DIAGNOSTIC_FIXED_WINDOW.targetAmount);
      const targetCurrency = BINANCE_DIAGNOSTIC_FIXED_WINDOW.targetCurrency;
      const configuredReceiver = (this.getReceiverId() || '').trim().toLowerCase();

      const candidates: BinanceDiagnosticCandidate[] = [];
      let matchedConclusion: BinanceDiagnosticConclusion | null = null;
      let anyComparablePresent = false;

      for (const rawItem of rawList) {
        if (!rawItem || typeof rawItem !== 'object') continue;

        const txTime = Number(rawItem.transactionTime ?? rawItem.orderTime ?? NaN);
        if (!Number.isFinite(txTime) || txTime < safeStart || txTime > safeEnd) continue;

        const currency = String(rawItem.currency || '').trim().toUpperCase();
        if (currency !== targetCurrency) continue;

        let amountDec: Decimal;
        try {
          amountDec = new Decimal(rawItem.amount ?? 'NaN');
        } catch {
          continue;
        }
        if (amountDec.isNaN() || !amountDec.equals(targetAmount)) continue;

        const orderType = String(rawItem.orderType || '').trim();
        const otUpper = orderType.toUpperCase();
        const direction: 'INCOMING' | 'OUTGOING' | 'UNKNOWN' =
          otUpper.includes('PAYOUT') || otUpper.includes('WITHDRAW') || otUpper.includes('OUT')
            ? 'OUTGOING'
            : otUpper
              ? 'INCOMING'
              : 'UNKNOWN';

        if (direction === 'OUTGOING') continue;

        const recBinanceIdRaw = rawItem.receiverInfo?.binanceId;
        const recBinanceId =
          recBinanceIdRaw !== undefined && recBinanceIdRaw !== null ? String(recBinanceIdRaw).trim().toLowerCase() : '';
        const receiverMatch: 'YES' | 'NO' | 'UNKNOWN' =
          configuredReceiver && recBinanceId ? (recBinanceId === configuredReceiver ? 'YES' : 'NO') : 'UNKNOWN';

        if (receiverMatch === 'NO') continue;

        const rawTxId =
          rawItem.transactionId !== undefined && rawItem.transactionId !== null
            ? String(rawItem.transactionId).trim()
            : '';
        const rawOrdId =
          rawItem.orderId !== undefined && rawItem.orderId !== null
            ? String(rawItem.orderId).trim()
            : '';
        const rawOrdNo =
          rawItem.orderNo !== undefined && rawItem.orderNo !== null
            ? String(rawItem.orderNo).trim()
            : '';

        const presentIdentifierKeys = Object.keys(rawItem).filter((k) => {
          if (k === 'payerId' || k === 'receiverId' || k === 'userId' || k === 'uid') return false;
          if (!/^[a-zA-Z0-9_]{1,40}$/.test(k)) return false;
          if (!(k.endsWith('Id') || k === 'orderNo')) return false;
          const val = rawItem[k];
          return val !== undefined && val !== null && String(val).trim() !== '';
        });

        const txPresent = rawTxId.length > 0;
        const ordIdPresent = rawOrdId.length > 0;
        const ordNoPresent = rawOrdNo.length > 0;

        if (txPresent || ordIdPresent || ordNoPresent) {
          anyComparablePresent = true;
        }

        if (normalizedRef && !matchedConclusion) {
          const normLower = normalizedRef.toLowerCase();
          if (txPresent && rawTxId.toLowerCase() === normLower) {
            matchedConclusion = 'MATCHED_TRANSACTION_ID';
          } else if (ordIdPresent && rawOrdId.toLowerCase() === normLower) {
            matchedConclusion = 'MATCHED_ORDER_ID';
          } else if (ordNoPresent && rawOrdNo.toLowerCase() === normLower) {
            matchedConclusion = 'MATCHED_ORDER_NO';
          }
        }

        candidates.push({
          transactionTime: txTime,
          amount: amountDec.toFixed(),
          currency,
          orderType: orderType || 'UNKNOWN',
          direction,
          receiverMatch,
          transactionIdPresent: txPresent ? 'YES' : 'NO',
          maskedTransactionId: txPresent ? maskIdentifier(rawTxId) : 'NONE',
          orderIdPresent: ordIdPresent ? 'YES' : 'NO',
          ...(ordIdPresent ? { maskedOrderId: maskIdentifier(rawOrdId) } : {}),
          orderNoPresent: ordNoPresent ? 'YES' : 'NO',
          ...(ordNoPresent ? { maskedOrderNo: maskIdentifier(rawOrdNo) } : {}),
          presentIdentifierKeys,
        });
      }

      let identifierConclusion: BinanceDiagnosticConclusion;
      if (candidates.length === 0) {
        identifierConclusion = 'NO_RELEVANT_0_2_USDT_RECORD';
      } else if (matchedConclusion) {
        identifierConclusion = matchedConclusion;
      } else if (!anyComparablePresent) {
        identifierConclusion = 'PAYMENT_RECORD_FOUND_BUT_NO_COMPARABLE_IDENTIFIER';
      } else {
        identifierConclusion = 'CUSTOMER_REFERENCE_NOT_API_MATCHABLE';
      }

      return {
        mode: 'READ_ONLY',
        walletMutation: 'IMPOSSIBLE',
        windowStartMs: safeStart,
        windowEndMs: safeEnd,
        windowStartIso,
        windowEndIso,
        httpStatus: apiRes.httpStatus,
        binanceCode: apiRes.binanceCode ? String(apiRes.binanceCode) : null,
        binanceMessage: this.sanitizeDiagnosticMessage(apiRes.binanceMessage || 'success'),
        recordsReturned: rawList.length,
        relevantRecordsCount: candidates.length,
        candidates,
        identifierConclusion,
        durationMs: Date.now() - startedAt,
        success: true,
      };
    } catch (err: any) {
      return {
        mode: 'READ_ONLY',
        walletMutation: 'IMPOSSIBLE',
        windowStartMs: safeStart,
        windowEndMs: safeEnd,
        windowStartIso,
        windowEndIso,
        httpStatus: 0,
        binanceCode: null,
        binanceMessage: this.sanitizeDiagnosticMessage(err?.message || 'Unexpected diagnostic error'),
        recordsReturned: 0,
        relevantRecordsCount: 0,
        candidates: [],
        identifierConclusion: 'BINANCE_API_REJECTED',
        durationMs: Date.now() - startedAt,
        success: false,
        errorClassification: 'DIAGNOSTIC_EXCEPTION',
      };
    }
  }
}

export const binanceService = new BinanceService();
