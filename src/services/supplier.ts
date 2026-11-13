import Decimal from 'decimal.js';
import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('SupplierService');

export interface SupplierRawProduct {
  id: string | number;
  name: string;
  description?: string;
  price_usdt?: number | string;
  your_cost?: number | string;
  stock?: number;
  stock_quantity?: number;
  is_unlimited?: boolean;
  duration?: string;
  requires_email?: boolean;
  type?: string;
  warranty?: string;
  category?: string;
}

export interface SupplierOrderPayload {
  product_id: string | number;
  quantity: number;
  customer_email?: string;
  idempotency_key: string;
}

export interface SupplierOrderResponse {
  success: boolean;
  order_ref?: string;
  status: 'completed' | 'pending_invite' | 'pending' | 'failed' | 'replayed';
  delivered_items?: string[];
  message?: string;
  error_code?: string;
  raw?: any;
}

export type SupplierOrderLookupStatus =
  | 'completed'
  | 'pending_invite'
  | 'pending'
  | 'failed'
  | 'not_found'
  | 'error';

export interface SupplierOrderLookupRecord {
  order_ref?: string;
  id?: string;
  idempotency_key?: string;
  status: string;
  product_id?: string | number;
  quantity?: number;
  total_cost?: string;
  delivered_items: string[];
  created_at?: string;
  raw?: any;
}

export interface SupplierOrderLookupResult {
  ok: boolean;
  found: boolean;
  httpStatus: number;
  lookupMethod: 'GET_ORDER_BY_REF' | 'GET_ORDERS_BY_KEY' | 'NONE';
  status: SupplierOrderLookupStatus;
  order_ref?: string;
  idempotency_key?: string;
  delivered_items: string[];
  error_code?: string;
  message?: string;
  raw?: any;
}

export interface SupplierListOrdersResult {
  ok: boolean;
  httpStatus: number;
  orders: SupplierOrderLookupRecord[];
  error?: string;
}

export interface SupplierCandidateSummary {
  supplierProductId: string;
  name: string;
  costUsdt: string;
  stock: number;
  isUnlimited: boolean;
  requiresEmail: boolean;
  type: string;
}

export interface SupplierReadOnlyDiagnosticResult {
  mode: 'READ_ONLY';
  purchasingCapability: 'ZERO';
  walletMutation: 'IMPOSSIBLE';
  liveOrderingEnabled: boolean;
  activeBaseUrl: string;
  baseUrlSource: 'ENV_OVERRIDE' | 'CODE_DEFAULT';
  officialDocBaseUrl: string;
  apiKeyConfigured: boolean;
  balanceCheck: {
    ok: boolean;
    httpStatus: number;
    balanceUsdt?: string;
    currency?: string;
    error?: string;
  };
  productsCheck: {
    ok: boolean;
    httpStatus: number;
    totalCount: number;
    activeInStockCount: number;
    cheapestActiveInStock?: SupplierCandidateSummary;
    cheapestInstantInStock?: SupplierCandidateSummary;
    error?: string;
  };
  ordersListCheck: {
    ok: boolean;
    httpStatus: number;
    count: number;
    latestMaskedRef?: string;
    error?: string;
  };
  orderRefCheck: {
    tested: boolean;
    testedRefMasked?: string;
    isSyntheticProbe?: boolean;
    ok: boolean;
    found: boolean;
    httpStatus: number;
    status: SupplierOrderLookupStatus | 'SKIPPED';
    error?: string;
  };
  durationMs: number;
}

export function maskSupplierRef(ref?: string | null): string {
  if (!ref) return 'NONE';
  const clean = String(ref).trim();
  if (!clean) return 'NONE';
  if (clean.length <= 8) return `${clean.slice(0, 2)}***${clean.slice(-2)}`;
  if (clean.length <= 14) return `${clean.slice(0, 4)}***${clean.slice(-3)}`;
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

export class SupplierService {
  private baseUrl: string;
  private apiKey?: string;
  private fetchOverride: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;

  constructor() {
    this.baseUrl = config.supplier.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.supplier.apiKey;
  }

  public setFetchOverride(fn: ((url: string, init?: RequestInit) => Promise<Response>) | null) {
    this.fetchOverride = fn;
  }

  public setTestApiKey(apiKey?: string) {
    this.apiKey = apiKey;
  }

  public setTestBaseUrl(baseUrl?: string) {
    this.baseUrl = (baseUrl || config.supplier.baseUrl).replace(/\/+$/, '');
  }

  public resetTestState() {
    this.fetchOverride = null;
    this.apiKey = config.supplier.apiKey;
    this.baseUrl = config.supplier.baseUrl.replace(/\/+$/, '');
  }

  /**
   * AiToolShop Reseller API v1 official contract documents read-only order lookup endpoints:
   * - GET /orders
   * - GET /order/:ref
   */
  public hasOrderStatusLookup(): boolean {
    return true;
  }

  private async performFetch(url: string, init?: RequestInit): Promise<Response> {
    if (this.fetchOverride) {
      return await this.fetchOverride(url, init);
    }
    return await fetch(url, init);
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private normalizeLookupStatus(rawStatus: unknown, record: any): SupplierOrderLookupStatus {
    const norm = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';

    if (
      record?.success === false ||
      norm === 'failed' ||
      norm === 'rejected' ||
      norm === 'cancelled' ||
      norm === 'canceled' ||
      norm === 'expired' ||
      norm === 'refunded' ||
      (norm === 'error' && Boolean(record?.error_code))
    ) {
      return 'failed';
    }

    if (norm === 'pending_invite' || norm === 'awaiting_invite') {
      return 'pending_invite';
    }

    if (norm === 'pending' || norm === 'processing' || norm === 'queued' || norm === 'in_progress') {
      return 'pending';
    }

    if (norm === 'completed' || norm === 'delivered' || norm === 'fulfilled' || norm === 'replayed') {
      return 'completed';
    }

    if (this.extractDeliveredItems(record).length > 0) {
      return 'completed';
    }

    return 'pending';
  }

  private parseOrderRecord(raw: any): SupplierOrderLookupRecord {
    const deliveredItems = this.extractDeliveredItems(raw);
    const orderRef = raw?.order_ref || raw?.ref || raw?.reference || raw?.id || undefined;
    const idempotencyKey = raw?.idempotency_key || raw?.idempotencyKey || undefined;
    return {
      order_ref: orderRef !== undefined ? String(orderRef) : undefined,
      id: raw?.id !== undefined ? String(raw.id) : undefined,
      idempotency_key: idempotencyKey !== undefined ? String(idempotencyKey) : undefined,
      status: typeof raw?.status === 'string' ? raw.status : '',
      product_id: raw?.product_id,
      quantity: typeof raw?.quantity === 'number' ? raw.quantity : undefined,
      total_cost: raw?.total_cost !== undefined ? String(raw.total_cost) : raw?.amount !== undefined ? String(raw.amount) : undefined,
      delivered_items: deliveredItems,
      created_at: raw?.created_at || raw?.createdAt,
      raw,
    };
  }

  /**
   * Fetch supplier balance (GET /balance)
   */
  public async getBalance(): Promise<{ balanceUsdt: Decimal; currency: string } | null> {
    const detailed = await this.getBalanceDetailed();
    if (!detailed.ok || !detailed.balanceUsdt) {
      return null;
    }
    return {
      balanceUsdt: detailed.balanceUsdt,
      currency: detailed.currency,
    };
  }

  private async getBalanceDetailed(): Promise<{
    ok: boolean;
    httpStatus: number;
    balanceUsdt?: Decimal;
    currency: string;
    error?: string;
  }> {
    if (!this.apiKey) {
      logger.warn('AITOOLSHOP_RESELLER_API_KEY not configured, cannot query live balance');
      return { ok: false, httpStatus: 0, currency: 'USDT', error: 'AITOOLSHOP_RESELLER_API_KEY not configured' };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await this.performFetch(`${this.baseUrl}/balance`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        logger.error('Supplier balance request failed', { status: res.status });
        return { ok: false, httpStatus: res.status, currency: 'USDT', error: `HTTP ${res.status}` };
      }

      const rawText = await res.text();
      let data: any = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }
      if (!data || typeof data !== 'object') {
        return { ok: false, httpStatus: res.status, currency: 'USDT', error: 'MALFORMED_JSON' };
      }

      const rawBal = data.balance ?? data.balance_usdt ?? data.data?.balance ?? data.data?.balance_usdt ?? 0;
      const balance = new Decimal(rawBal);
      return { ok: true, httpStatus: res.status, balanceUsdt: balance, currency: String(data.currency || 'USDT') };
    } catch (err: any) {
      logger.error('Supplier getBalance error', { error: err.message });
      return { ok: false, httpStatus: 0, currency: 'USDT', error: err?.message || 'NETWORK_ERROR' };
    }
  }

  /**
   * Fetch live supplier products from GET /products
   */
  public async fetchLiveProducts(): Promise<SupplierRawProduct[]> {
    const detailed = await this.fetchLiveProductsDetailed();
    return detailed.products;
  }

  private async fetchLiveProductsDetailed(): Promise<{
    ok: boolean;
    httpStatus: number;
    products: SupplierRawProduct[];
    error?: string;
  }> {
    if (!this.apiKey) {
      logger.info('AITOOLSHOP_RESELLER_API_KEY not set; live catalogue requires authorized reseller key');
      return { ok: false, httpStatus: 0, products: [], error: 'AITOOLSHOP_RESELLER_API_KEY not configured' };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await this.performFetch(`${this.baseUrl}/products`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        logger.warn('Supplier /products returned non-200 status', { status: res.status });
        return { ok: false, httpStatus: res.status, products: [], error: `HTTP ${res.status}` };
      }

      const rawText = await res.text();
      let data: any = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }
      if (!data) {
        return { ok: false, httpStatus: res.status, products: [], error: 'MALFORMED_JSON' };
      }

      const products: SupplierRawProduct[] = Array.isArray(data)
        ? data
        : Array.isArray(data.products)
        ? data.products
        : Array.isArray(data.data)
        ? data.data
        : [];

      logger.info('Successfully fetched live supplier products', { count: products.length });
      return { ok: true, httpStatus: res.status, products };
    } catch (err: any) {
      logger.warn('Failed to reach live supplier /products endpoint', { error: err.message });
      return { ok: false, httpStatus: 0, products: [], error: err?.message || 'NETWORK_ERROR' };
    }
  }

  /**
   * Read-only list of reseller orders via GET /orders.
   * Zero purchasing or mutation capability.
   */
  public async listOrdersReadOnly(): Promise<SupplierListOrdersResult> {
    if (!this.apiKey) {
      return { ok: false, httpStatus: 0, orders: [], error: 'AITOOLSHOP_RESELLER_API_KEY not configured' };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await this.performFetch(`${this.baseUrl}/orders`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const rawText = await res.text();
      let data: any = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      if (!res.ok) {
        logger.warn('Supplier GET /orders returned non-200 status', { status: res.status });
        return { ok: false, httpStatus: res.status, orders: [], error: data?.message || `HTTP ${res.status}` };
      }

      if (!data || (typeof data !== 'object' && !Array.isArray(data))) {
        return { ok: false, httpStatus: res.status, orders: [], error: 'MALFORMED_JSON' };
      }

      if (!Array.isArray(data) && data.success === false) {
        return { ok: false, httpStatus: res.status, orders: [], error: data.message || 'SUPPLIER_ERROR' };
      }

      const rawList = Array.isArray(data)
        ? data
        : Array.isArray(data.orders)
        ? data.orders
        : Array.isArray(data.data)
        ? data.data
        : Array.isArray(data.items)
        ? data.items
        : [];

      return {
        ok: true,
        httpStatus: res.status,
        orders: rawList.map((row: any) => this.parseOrderRecord(row)),
      };
    } catch (err: any) {
      logger.warn('Supplier GET /orders request failed', { error: err?.message });
      return { ok: false, httpStatus: 0, orders: [], error: err?.message || 'NETWORK_ERROR' };
    }
  }

  /**
   * Read-only single order lookup via GET /order/:ref.
   * Zero purchasing or mutation capability.
   */
  public async getOrderByRef(ref: string): Promise<SupplierOrderLookupResult> {
    const cleanRef = String(ref || '').trim();
    if (!cleanRef) {
      return {
        ok: false,
        found: false,
        httpStatus: 0,
        lookupMethod: 'NONE',
        status: 'error',
        delivered_items: [],
        error_code: 'EMPTY_REF',
        message: 'Empty supplier order reference',
      };
    }

    if (!this.apiKey) {
      return {
        ok: false,
        found: false,
        httpStatus: 0,
        lookupMethod: 'NONE',
        status: 'error',
        delivered_items: [],
        error_code: 'INVALID_API_KEY',
        message: 'AITOOLSHOP_RESELLER_API_KEY not configured',
      };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await this.performFetch(`${this.baseUrl}/order/${encodeURIComponent(cleanRef)}`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const rawText = await res.text();
      let data: any = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      if (res.status === 404) {
        return {
          ok: true,
          found: false,
          httpStatus: 404,
          lookupMethod: 'GET_ORDER_BY_REF',
          status: 'not_found',
          delivered_items: [],
          error_code: data?.error_code || 'ORDER_NOT_FOUND',
          message: data?.message || 'Order not found at supplier',
          raw: data || undefined,
        };
      }

      if (!res.ok) {
        return {
          ok: false,
          found: false,
          httpStatus: res.status,
          lookupMethod: 'GET_ORDER_BY_REF',
          status: 'error',
          delivered_items: [],
          error_code: data?.error_code || `HTTP_${res.status}`,
          message: data?.message || `Supplier lookup returned HTTP ${res.status}`,
          raw: data || undefined,
        };
      }

      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {
          ok: false,
          found: false,
          httpStatus: res.status,
          lookupMethod: 'GET_ORDER_BY_REF',
          status: 'error',
          delivered_items: [],
          error_code: 'MALFORMED_JSON',
          message: 'Supplier GET /order/:ref returned malformed JSON response',
        };
      }

      // Unwrap `{ order: {...} }` or `{ data: {...} }` response envelopes safely
      const record =
        data.order && typeof data.order === 'object' && !Array.isArray(data.order)
          ? data.order
          : data.data && typeof data.data === 'object' && !Array.isArray(data.data)
          ? data.data
          : data;

      if (data.success === false && !record?.status && String(data.error_code || '').toUpperCase().includes('NOT_FOUND')) {
        return {
          ok: true,
          found: false,
          httpStatus: res.status,
          lookupMethod: 'GET_ORDER_BY_REF',
          status: 'not_found',
          delivered_items: [],
          error_code: data.error_code || 'ORDER_NOT_FOUND',
          message: data.message || 'Order not found at supplier',
          raw: data,
        };
      }

      const parsed = this.parseOrderRecord(record);
      const normalizedStatus = this.normalizeLookupStatus(parsed.status, { ...data, ...record });

      return {
        ok: true,
        found: true,
        httpStatus: res.status,
        lookupMethod: 'GET_ORDER_BY_REF',
        status: normalizedStatus,
        order_ref: parsed.order_ref || cleanRef,
        idempotency_key: parsed.idempotency_key,
        delivered_items: parsed.delivered_items,
        error_code: record.error_code || data.error_code,
        message: record.message || data.message,
        raw: data,
      };
    } catch (err: any) {
      logger.warn('Supplier GET /order/:ref request failed', {
        maskedRef: maskSupplierRef(cleanRef),
        error: err?.message,
      });
      return {
        ok: false,
        found: false,
        httpStatus: 0,
        lookupMethod: 'GET_ORDER_BY_REF',
        status: 'error',
        delivered_items: [],
        error_code: 'NETWORK_ERROR',
        message: err?.message || 'Supplier GET /order/:ref network error/timeout',
      };
    }
  }

  /**
   * Read-only reconciliation lookup combining GET /order/:ref and GET /orders.
   * Searches by permanent supplier_order_ref first, then stored idempotency_key.
   * NEVER triggers POST /order.
   */
  public async lookupOrderReadOnly(params: {
    supplierOrderRef?: string | null;
    idempotencyKey?: string | null;
  }): Promise<SupplierOrderLookupResult> {
    if (!this.apiKey) {
      return {
        ok: false,
        found: false,
        httpStatus: 0,
        lookupMethod: 'NONE',
        status: 'error',
        delivered_items: [],
        error_code: 'INVALID_API_KEY',
        message: 'Supplier reseller API key is not configured.',
      };
    }

    const candidates: string[] = [];
    if (params.supplierOrderRef && params.supplierOrderRef.trim()) {
      candidates.push(params.supplierOrderRef.trim());
    }
    if (params.idempotencyKey && params.idempotencyKey.trim() && !candidates.includes(params.idempotencyKey.trim())) {
      candidates.push(params.idempotencyKey.trim());
    }

    let lastResult: SupplierOrderLookupResult | null = null;
    const triedRefs = new Set<string>();

    // 1. Direct GET /order/:ref lookup(s)
    for (const ref of candidates) {
      triedRefs.add(ref);
      const res = await this.getOrderByRef(ref);
      lastResult = res;
      if (res.ok && res.found) {
        return res;
      }
    }

    // 2. Fallback read-only GET /orders list lookup using permanent idempotency_key or order_ref
    const listRes = await this.listOrdersReadOnly();
    if (listRes.ok) {
      const matched = listRes.orders.find(o => {
        if (params.supplierOrderRef && (o.order_ref === params.supplierOrderRef || o.id === params.supplierOrderRef)) {
          return true;
        }
        if (params.idempotencyKey && (o.idempotency_key === params.idempotencyKey || o.order_ref === params.idempotencyKey)) {
          return true;
        }
        return false;
      });

      if (matched) {
        const matchedRef = matched.order_ref || matched.id;
        // If GET /orders revealed an order_ref we haven't queried directly yet and items aren't included, query GET /order/:ref
        if (matchedRef && !triedRefs.has(matchedRef) && matched.delivered_items.length === 0) {
          const deepRes = await this.getOrderByRef(matchedRef);
          if (deepRes.ok && deepRes.found) {
            return deepRes;
          }
        }

        const normalizedStatus = this.normalizeLookupStatus(matched.status, matched.raw);
        return {
          ok: true,
          found: true,
          httpStatus: listRes.httpStatus,
          lookupMethod: 'GET_ORDERS_BY_KEY',
          status: normalizedStatus,
          order_ref: matchedRef || params.supplierOrderRef || undefined,
          idempotency_key: matched.idempotency_key || params.idempotencyKey || undefined,
          delivered_items: matched.delivered_items,
          error_code: matched.raw?.error_code,
          message: matched.raw?.message,
          raw: matched.raw,
        };
      }

      // List succeeded cleanly and order wasn't in it -> confirmed not_found (or awaiting propagation)
      return {
        ok: true,
        found: false,
        httpStatus: lastResult?.httpStatus || listRes.httpStatus,
        lookupMethod: 'GET_ORDERS_BY_KEY',
        status: 'not_found',
        delivered_items: [],
        message: 'Order reference not found in GET /order/:ref or GET /orders; keeping under review.',
      };
    }

    // Return last GET /order/:ref result if it succeeded cleanly as not_found; else error
    if (lastResult && lastResult.ok) {
      return lastResult;
    }

    return (
      lastResult || {
        ok: false,
        found: false,
        httpStatus: listRes.httpStatus,
        lookupMethod: 'NONE',
        status: 'error',
        delivered_items: [],
        error_code: 'LOOKUP_UNAVAILABLE',
        message: listRes.error || 'Supplier read-only lookup endpoints unreachable',
      }
    );
  }

  /**
   * Strictly READ-ONLY admin diagnostic probing:
   * - Active base URL & source
   * - GET /balance
   * - GET /products (plus cheapest active in-stock & instant-delivery candidate)
   * - GET /orders
   * - GET /order/:ref (either admin-submitted safe ref, latest order ref from GET /orders, or synthetic probe)
   * Zero POST /order capability, zero wallet mutation, masked refs only.
   */
  public async runReadOnlyDiagnostic(submittedOrderRef?: string): Promise<SupplierReadOnlyDiagnosticResult> {
    const startedAt = Date.now();

    const [balRes, prodRes, ordersRes] = await Promise.all([
      this.getBalanceDetailed(),
      this.fetchLiveProductsDetailed(),
      this.listOrdersReadOnly(),
    ]);

    // Identify cheapest active in-stock candidate and cheapest instant (requires_email=false) candidate
    let cheapestActiveInStock: SupplierCandidateSummary | undefined;
    let cheapestInstantInStock: SupplierCandidateSummary | undefined;
    let activeInStockCount = 0;

    if (prodRes.ok) {
      const candidates: Array<{ costDec: Decimal; summary: SupplierCandidateSummary }> = [];
      for (const raw of prodRes.products) {
        const stock = raw.stock !== undefined ? Number(raw.stock) : raw.stock_quantity !== undefined ? Number(raw.stock_quantity) : 0;
        const isUnlimited = Boolean(raw.is_unlimited || stock > 1000);
        const isAvailable = isUnlimited || stock > 0;
        if (!isAvailable) continue;

        activeInStockCount++;
        const rawCost = raw.your_cost !== undefined ? raw.your_cost : raw.price_usdt !== undefined ? raw.price_usdt : 0;
        let costDec: Decimal;
        try {
          costDec = new Decimal(rawCost);
        } catch {
          continue;
        }
        if (costDec.isNaN() || costDec.lessThanOrEqualTo(0)) continue;

        candidates.push({
          costDec,
          summary: {
            supplierProductId: String(raw.id),
            name: String(raw.name || 'Unnamed').trim().slice(0, 60),
            costUsdt: costDec.toFixed(4),
            stock: Number.isFinite(stock) ? stock : 0,
            isUnlimited,
            requiresEmail: Boolean(raw.requires_email),
            type: String(raw.type || 'account'),
          },
        });
      }

      candidates.sort((a, b) => a.costDec.comparedTo(b.costDec));
      cheapestActiveInStock = candidates[0]?.summary;
      cheapestInstantInStock = candidates.find(c => !c.summary.requiresEmail)?.summary;
    }

    // Decide safe GET /order/:ref probe target (zero writes/purchases!)
    const explicitRef = submittedOrderRef?.trim();
    const firstListRef = ordersRes.orders[0]?.order_ref || ordersRes.orders[0]?.id;
    const probeRef = explicitRef || firstListRef || '__diag_nonexistent_probe__';
    const isSyntheticProbe = !explicitRef && !firstListRef;

    let orderRefCheck: SupplierReadOnlyDiagnosticResult['orderRefCheck'];
    if (!this.apiKey) {
      orderRefCheck = {
        tested: false,
        ok: false,
        found: false,
        httpStatus: 0,
        status: 'SKIPPED',
        error: 'AITOOLSHOP_RESELLER_API_KEY not configured',
      };
    } else {
      const refRes = await this.getOrderByRef(probeRef);
      orderRefCheck = {
        tested: true,
        testedRefMasked: isSyntheticProbe ? 'SYNTHETIC_404_PROBE' : maskSupplierRef(probeRef),
        isSyntheticProbe,
        ok: refRes.ok,
        found: refRes.found,
        httpStatus: refRes.httpStatus,
        status: refRes.status,
        error: refRes.ok ? undefined : refRes.message || refRes.error_code,
      };
    }

    return {
      mode: 'READ_ONLY',
      purchasingCapability: 'ZERO',
      walletMutation: 'IMPOSSIBLE',
      liveOrderingEnabled: config.safety.liveOrderingEnabled,
      activeBaseUrl: this.baseUrl,
      baseUrlSource: config.supplier.baseUrlSource,
      officialDocBaseUrl: config.supplier.officialDocBaseUrl,
      apiKeyConfigured: Boolean(this.apiKey),
      balanceCheck: {
        ok: balRes.ok,
        httpStatus: balRes.httpStatus,
        balanceUsdt: balRes.balanceUsdt?.toFixed(4),
        currency: balRes.currency,
        error: balRes.error,
      },
      productsCheck: {
        ok: prodRes.ok,
        httpStatus: prodRes.httpStatus,
        totalCount: prodRes.products.length,
        activeInStockCount,
        cheapestActiveInStock,
        cheapestInstantInStock,
        error: prodRes.error,
      },
      ordersListCheck: {
        ok: ordersRes.ok,
        httpStatus: ordersRes.httpStatus,
        count: ordersRes.orders.length,
        latestMaskedRef: ordersRes.orders[0]?.order_ref ? maskSupplierRef(ordersRes.orders[0].order_ref) : undefined,
        error: ordersRes.error,
      },
      orderRefCheck,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Synchronize supplier catalogue into PostgreSQL mirror.
   * Ensures:
   * 1. All products imported & updated idempotently
   * 2. Stock, cost, and availability updated
   * 3. Local retail prices, category assignments, and display overrides PRESERVED
   * 4. Missing products marked unavailable instead of deleted
   */
  public async syncCatalogue(): Promise<{ importedCount: number; updatedCount: number; totalCount: number }> {
    logger.info('Starting catalogue synchronization with AiToolShop Reseller API...');
    const rawProducts = await this.fetchLiveProducts();

    let importedCount = 0;
    let updatedCount = 0;
    const syncedSupplierIds = new Set<string>();

    for (const raw of rawProducts) {
      const supplierProductId = String(raw.id);
      syncedSupplierIds.add(supplierProductId);

      const originalName = String(raw.name || 'Unnamed Product').trim();
      const originalDescription = raw.description || '';
      const costNum = raw.your_cost !== undefined ? raw.your_cost : (raw.price_usdt !== undefined ? raw.price_usdt : 0.50);
      const latestCost = new Decimal(costNum).toFixed(4);
      const stock = raw.stock !== undefined ? raw.stock : (raw.stock_quantity !== undefined ? raw.stock_quantity : 0);
      const isUnlimited = Boolean(raw.is_unlimited || stock > 1000);
      const requiresEmail = Boolean(raw.requires_email);
      const supplierType = raw.type || 'account';
      const duration = raw.duration || '1 Month';
      const warrantySummary = raw.warranty || 'Full duration replacement warranty';
      const isAvailable = isUnlimited || stock > 0;

      // Upsert supplier_product
      const existing = await db.queryRow<any>(
        'SELECT id, latest_cost, latest_stock FROM supplier_products WHERE supplier_product_id = $1',
        [supplierProductId]
      );

      let localDbId: string;

      if (!existing) {
        localDbId = `sp_${supplierProductId}`;
        await db.query(`
          INSERT INTO supplier_products (
            id, supplier, supplier_product_id, original_name, original_description,
            latest_cost, latest_stock, is_unlimited, requires_email, supplier_type,
            is_available, duration, warranty_summary, raw_payload, last_synced_at, created_at, updated_at
          ) VALUES ($1, 'aitoolshop', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
          localDbId,
          supplierProductId,
          originalName,
          originalDescription,
          latestCost,
          stock,
          isUnlimited,
          requiresEmail,
          supplierType,
          isAvailable,
          duration,
          warrantySummary,
          JSON.stringify(raw),
        ]);

        // Auto-assign category based on name/keywords
        const categoryId = this.detectCategory(originalName, originalDescription);

        // Create default override preserving admin controls
        await db.query(`
          INSERT INTO product_overrides (
            product_id, category_id, fixed_markup, is_hidden, is_featured, created_at, updated_at
          ) VALUES ($1, $2, '0.1000', false, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (product_id) DO NOTHING
        `, [localDbId, categoryId]);

        importedCount++;
      } else {
        localDbId = existing.id;
        await db.query(`
          UPDATE supplier_products
          SET original_name = $1,
              original_description = $2,
              latest_cost = $3,
              latest_stock = $4,
              is_unlimited = $5,
              requires_email = $6,
              supplier_type = $7,
              is_available = $8,
              duration = $9,
              warranty_summary = $10,
              raw_payload = $11,
              last_synced_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $12
        `, [
          originalName,
          originalDescription,
          latestCost,
          stock,
          isUnlimited,
          requiresEmail,
          supplierType,
          isAvailable,
          duration,
          warrantySummary,
          JSON.stringify(raw),
          localDbId,
        ]);
        updatedCount++;
      }
    }

    // Mark products absent from the supplier response as unavailable instead of deleting history!
    if (syncedSupplierIds.size > 0) {
      await db.query(`
        UPDATE supplier_products
        SET is_available = false, updated_at = CURRENT_TIMESTAMP
        WHERE supplier = 'aitoolshop' AND supplier_product_id NOT IN (${Array.from(syncedSupplierIds).map((_, i) => `$${i + 1}`).join(',')})
      `, Array.from(syncedSupplierIds));
    }

    const totalCountRes = await db.queryRow<{ count: string }>('SELECT COUNT(*) as count FROM supplier_products');
    const totalCount = parseInt(totalCountRes?.count || '0', 10);

    logger.info('Catalogue sync finished', { importedCount, updatedCount, totalCount });
    return { importedCount, updatedCount, totalCount };
  }

  /**
   * Helper to detect category based on keywords
   */
  private detectCategory(name: string, desc: string): string {
    const text = `${name} ${desc}`.toLowerCase();
    if (/chatgpt|gpt|claude|gemini|midjourney|openai|ai |anthropic|perplexity|elevenlabs/i.test(text)) {
      return 'cat_ai-tools';
    }
    if (/netflix|spotify|youtube|disney|prime|hulu|crunchyroll|apple tv|deezer/i.test(text)) {
      return 'cat_streaming';
    }
    if (/github|copilot|cursor|jetbrains|vps|digitalocean|aws|domain|cloudflare/i.test(text)) {
      return 'cat_developer';
    }
    if (/canva|adobe|figma|freepik|envato|notion|grammarly|office|windows/i.test(text)) {
      return 'cat_design';
    }
    if (/vpn|nord|express|surfshark|ipvanish|cyberghost|proton/i.test(text)) {
      return 'cat_vpn-security';
    }
    return 'cat_ai-tools'; // Default fallback
  }

  /**
   * Extract normalized delivered item strings from supplier payload.
   */
  private extractDeliveredItems(data: any): string[] {
    const rawList = Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.delivered_items)
      ? data.delivered_items
      : data?.content !== undefined && data?.content !== null
      ? [data.content]
      : [];

    return rawList
      .map((item: any) => (typeof item === 'string' ? item : JSON.stringify(item)))
      .filter((s: string) => s.trim().length > 0);
  }

  /**
   * Dispatch real supplier order with strict idempotency and safety flag check.
   */
  public async placeOrder(payload: SupplierOrderPayload): Promise<SupplierOrderResponse> {
    // CRITICAL SAFETY CHECK: LIVE_ORDERING_ENABLED=false MUST block real POST /order
    if (!config.safety.liveOrderingEnabled) {
      logger.warn('Supplier POST /order blocked by LIVE_ORDERING_ENABLED=false safety flag', {
        productId: payload.product_id,
        idempotencyKey: payload.idempotency_key,
      });

      return {
        success: false,
        status: 'failed',
        error_code: 'LIVE_ORDERING_DISABLED',
        message: 'Live supplier ordering is disabled in current environment safety mode (LIVE_ORDERING_ENABLED=false).',
      };
    }

    if (!this.apiKey) {
      return {
        success: false,
        status: 'failed',
        error_code: 'INVALID_API_KEY',
        message: 'Supplier reseller API key is not configured.',
      };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const headers = {
        ...this.getHeaders(),
        'Idempotency-Key': payload.idempotency_key,
      };

      const res = await this.performFetch(`${this.baseUrl}/order`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const rawText = await res.text();
      let data: any = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        logger.error('Supplier /order returned malformed or non-JSON response', {
          httpStatus: res.status,
          idempotencyKey: payload.idempotency_key,
        });
        return {
          success: false,
          status: 'failed',
          error_code: 'UNCERTAIN_MALFORMED_RESPONSE',
          message: `Supplier returned non-JSON or malformed response (HTTP ${res.status}). Requires reconciliation before refunding.`,
        };
      }

      const rawStatus = typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';
      const orderRef = data.order_ref || data.id || undefined;
      const deliveredItems = this.extractDeliveredItems(data);

      if (res.status === 200 || res.status === 201) {
        // Guard against "fake 200" error envelopes or explicit failure flags inside HTTP 200
        if (data.success === false || rawStatus === 'failed' || rawStatus === 'rejected' || Boolean(data.error_code)) {
          return {
            success: false,
            status: 'failed',
            order_ref: orderRef,
            error_code: data.error_code || 'SUPPLIER_REJECTED',
            message: data.message || 'Supplier rejected order inside 200 envelope',
            raw: data,
          };
        }

        if (rawStatus === 'completed' || rawStatus === 'pending_invite' || rawStatus === 'pending' || rawStatus === 'replayed') {
          return {
            success: true,
            status: rawStatus as SupplierOrderResponse['status'],
            order_ref: orderRef,
            delivered_items: deliveredItems,
            raw: data,
          };
        }

        // Unrecognized or missing status in HTTP 200/201 -> require evidence, never blindly assume 'completed'
        if (deliveredItems.length > 0 || orderRef) {
          return {
            success: true,
            status: deliveredItems.length > 0 ? 'completed' : 'pending_invite',
            order_ref: orderRef,
            delivered_items: deliveredItems,
            raw: data,
          };
        }

        return {
          success: false,
          status: 'failed',
          error_code: 'UNCERTAIN_MALFORMED_RESPONSE',
          message: 'Supplier returned 200 without recognized status, order reference, or delivery payload.',
        };
      }

      // Ambiguous transport/server status codes (408, 429, 5xx) without an explicit deterministic business rejection
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        const hasDeterministicRejection =
          typeof data.error_code === 'string' &&
          ['OUT_OF_STOCK', 'INSUFFICIENT_BALANCE', 'INVALID_API_KEY', 'PRODUCT_UNAVAILABLE', 'INVALID_EMAIL'].includes(
            data.error_code.toUpperCase()
          );
        if (!hasDeterministicRejection) {
          return {
            success: false,
            status: 'failed',
            order_ref: orderRef,
            error_code: `UNCERTAIN_HTTP_${res.status}`,
            message: data.message || `Supplier returned ambiguous HTTP ${res.status}. Requires reconciliation before refunding.`,
          };
        }
      }

      // Check stable deterministic error codes
      const errorCode =
        data.error_code ||
        (res.status === 401 ? 'INVALID_API_KEY' : res.status === 402 ? 'INSUFFICIENT_BALANCE' : 'API_ERROR');
      return {
        success: false,
        status: 'failed',
        order_ref: orderRef,
        error_code: errorCode,
        message: data.message || 'Supplier order rejected',
        raw: data,
      };
    } catch (err: any) {
      logger.error('Supplier order request error / timeout', { error: err.message, idempotencyKey: payload.idempotency_key });
      return {
        success: false,
        status: 'failed',
        error_code: 'UNCERTAIN_TIMEOUT',
        message: 'Order request timed out or network error. Requires reconciliation before refunding.',
      };
    }
  }
}

export const supplierService = new SupplierService();
