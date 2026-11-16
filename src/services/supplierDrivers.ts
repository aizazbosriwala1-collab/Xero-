import crypto from 'crypto';
import Decimal from 'decimal.js';
import {
  SupplierRawProduct,
  SupplierOrderPayload,
  SupplierOrderResponse,
  SupplierOrderLookupResult,
  SupplierReadOnlyDiagnosticResult,
} from './supplier.js';

export interface DriverContext {
  supplierId: string;
  supplierName: string;
  baseUrl: string;
  apiKey?: string;
  webhookSecret?: string;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Delegate bridge for primary live driver */
  delegates?: {
    getBalanceDetailed: () => Promise<{
      ok: boolean;
      httpStatus: number;
      balanceUsdt?: Decimal;
      currency: string;
      error?: string;
    }>;
    fetchLiveProductsDetailed: () => Promise<{
      ok: boolean;
      httpStatus: number;
      products: SupplierRawProduct[];
      error?: string;
    }>;
    placeOrderDirect: (payload: SupplierOrderPayload, endpointBase: string) => Promise<SupplierOrderResponse>;
    lookupOrderReadOnly: (params: {
      supplierOrderRef?: string | null;
      idempotencyKey?: string | null;
    }) => Promise<SupplierOrderLookupResult>;
    runReadOnlyDiagnostic: (submittedOrderRef?: string) => Promise<SupplierReadOnlyDiagnosticResult>;
  };
}

export interface DriverHealthResult {
  ok: boolean;
  apiStatus: 'Healthy' | 'Warning' | 'Failed' | 'Offline';
  latencyMs: number;
  message: string;
  integrated: boolean;
}

export interface DriverBalanceResult {
  ok: boolean;
  balanceUsdt?: string;
  currency: string;
  latencyMs: number;
  error?: string;
  integrated: boolean;
}

export interface DriverCatalogResult {
  ok: boolean;
  products: SupplierRawProduct[];
  latencyMs: number;
  error?: string;
  integrated: boolean;
}

export interface DriverPriceSyncResult {
  ok: boolean;
  updatedItems: Array<{ supplierProductId: string; costUsdt: string }>;
  latencyMs: number;
  error?: string;
  integrated: boolean;
}

export interface DriverStockCheckResult {
  ok: boolean;
  inStock: boolean;
  stock: number;
  isUnlimited: boolean;
  latencyMs: number;
  error?: string;
  integrated: boolean;
}

export interface DriverQuoteResult {
  ok: boolean;
  supplierProductId: string;
  quantity: number;
  unitCostUsdt?: string;
  totalCostUsdt?: string;
  currency: string;
  inStock: boolean;
  availableStock?: number;
  isUnlimited?: boolean;
  latencyMs: number;
  source: 'LIVE_QUOTE_API' | 'LIVE_CATALOG' | 'UNAVAILABLE';
  error?: string;
  integrated: boolean;
}

export interface DriverDiagnosticsResult {
  ok: boolean;
  driverKey: string;
  supplierId: string;
  integrated: boolean;
  apiStatus: 'Healthy' | 'Warning' | 'Failed' | 'Offline';
  latencyMs: number;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  rawReadOnlyDiag?: SupplierReadOnlyDiagnosticResult;
}

/**
 * Unified Pluggable Supplier Driver Interface.
 * All current and future suppliers (Main Supplier, VenteBot, NyStore, Cuppon'sHub, ZFour, etc.)
 * expose the same operational contract to Master Xero.
 */
export interface ISupplierDriver {
  readonly driverKey: string;
  readonly displayName: string;
  readonly isLiveImplemented: boolean;

  healthCheck(ctx: DriverContext): Promise<DriverHealthResult>;
  balanceCheck(ctx: DriverContext): Promise<DriverBalanceResult>;
  catalogSync(ctx: DriverContext): Promise<DriverCatalogResult>;
  priceSync(ctx: DriverContext): Promise<DriverPriceSyncResult>;
  stockCheck(ctx: DriverContext, supplierProductId: string): Promise<DriverStockCheckResult>;
  quote(ctx: DriverContext, params: { supplierProductId: string | number; quantity: number }): Promise<DriverQuoteResult>;
  purchase(ctx: DriverContext, payload: SupplierOrderPayload): Promise<SupplierOrderResponse>;
  orderRecovery(
    ctx: DriverContext,
    params: { supplierOrderRef?: string | null; idempotencyKey?: string | null }
  ): Promise<SupplierOrderLookupResult>;
  diagnostics(ctx: DriverContext): Promise<DriverDiagnosticsResult>;
}

const DELIVERED_STATUS_SET = new Set([
  'completed',
  'complete',
  'delivered',
  'fulfilled',
  'done',
  'success',
  'ok',
  'processed',
  'ready',
  'replayed',
]);

const PENDING_INVITE_SET = new Set(['pending_invite', 'awaiting_invite']);
const IN_PROGRESS_SET = new Set(['pending', 'processing', 'queued', 'in_progress']);
const FAILED_STATUS_SET = new Set([
  'failed',
  'failed_no_charge',
  'rejected',
  'cancelled',
  'canceled',
  'expired',
  'refunded',
]);

function hasNonBenignErrorCode(errorCode: unknown): boolean {
  if (errorCode === undefined || errorCode === null) return false;
  const norm = String(errorCode).trim().toLowerCase();
  return norm.length > 0 && norm !== 'none' && norm !== 'null' && norm !== 'ok' && norm !== '0';
}

function unwrapEnvelope(data: any): any {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const nested =
    (data.order && typeof data.order === 'object' && !Array.isArray(data.order) && data.order) ||
    (data.data && typeof data.data === 'object' && !Array.isArray(data.data) && data.data) ||
    (data.result && typeof data.result === 'object' && !Array.isArray(data.result) && data.result);
  if (!nested) return data;
  return { ...data, ...nested };
}

function normalizeDeliveryArray(val: unknown): string[] {
  if (val === undefined || val === null) return [];
  if (Array.isArray(val)) {
    return val
      .map((item: any) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          return Object.keys(item).length > 0 ? JSON.stringify(item) : '';
        }
        if (typeof item === 'number' || typeof item === 'boolean') return String(item);
        return '';
      })
      .filter((s: string) => s.trim().length > 0);
  }
  if (typeof val === 'string') return val.trim().length > 0 ? [val] : [];
  if (typeof val === 'object') {
    return Object.keys(val as Record<string, unknown>).length > 0 ? [JSON.stringify(val)] : [];
  }
  if (typeof val === 'number' || typeof val === 'boolean') return [String(val)];
  return [];
}

function extractDriverDeliveredItems(data: any): string[] {
  if (!data || typeof data !== 'object') return [];
  const containers: any[] = [];
  const seen = new Set<any>();
  const push = (obj: any) => {
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && !seen.has(obj)) {
      seen.add(obj);
      containers.push(obj);
    }
  };
  push(unwrapEnvelope(data));
  push(data);
  push(data.order);
  push(data.data);
  push(data.result);
  push(data.delivery);

  const keys = [
    'delivered_items',
    'deliveredItems',
    'items',
    'credentials',
    'accounts',
    'account',
    'account_details',
    'delivered',
    'delivery_content',
    'deliveryContent',
    'license_keys',
    'licenseKeys',
    'license_key',
    'licenseKey',
    'licenses',
    'license',
    'keys',
    'codes',
    'pins',
    'secrets',
    'secret',
    'credential',
    'content',
    'access',
    'invite_link',
    'inviteLink',
  ];

  for (const c of containers) {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(c, k)) {
        const extracted = normalizeDeliveryArray(c[k]);
        if (extracted.length > 0) return extracted;
      }
    }
    for (const directKey of ['delivery', 'result']) {
      const val = c[directKey];
      if (typeof val === 'string' || Array.isArray(val)) {
        const extracted = normalizeDeliveryArray(val);
        if (extracted.length > 0) return extracted;
      }
    }
  }
  return [];
}

function extractDriverOrderRef(record: any, fallback?: any): string | undefined {
  const candidate =
    record?.order_ref ??
    record?.ref ??
    record?.reference ??
    record?.order_id ??
    record?.orderId ??
    record?.order_no ??
    record?.orderNo ??
    record?.id ??
    fallback?.order_ref ??
    fallback?.ref ??
    fallback?.reference ??
    fallback?.order_id ??
    fallback?.orderId ??
    fallback?.id;
  if (candidate === undefined || candidate === null) return undefined;
  const trimmed = String(candidate).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function extractDriverProofFiles(data: any): string[] {
  if (!data || typeof data !== 'object') return [];
  const containers: any[] = [];
  const seen = new Set<any>();
  const push = (obj: any) => {
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && !seen.has(obj)) {
      seen.add(obj);
      containers.push(obj);
    }
  };
  push(unwrapEnvelope(data));
  push(data);
  push(data.order);
  push(data.data);
  push(data.result);
  push(data.delivery);

  const proofKeys = [
    'proof_files',
    'proofFiles',
    'proof_urls',
    'proofUrls',
    'proof_url',
    'proofUrl',
    'proofs',
    'proof',
    'receipt_url',
    'receiptUrl',
    'evidence_urls',
    'evidenceUrls',
    'evidence_url',
    'evidenceUrl',
    'attachments',
    'files',
  ];

  const collected: string[] = [];
  const dedup = new Set<string>();
  const addEntry = (raw: string) => {
    const clean = raw.trim();
    if (clean && !dedup.has(clean)) {
      dedup.add(clean);
      collected.push(clean);
    }
  };

  const formatItem = (item: any) => {
    if (!item) return;
    if (typeof item === 'string') {
      addEntry(item);
      return;
    }
    if (typeof item === 'object') {
      const url = item.url ?? item.file_url ?? item.fileUrl ?? item.link ?? item.download_url ?? item.downloadUrl ?? item.path;
      const name = item.name ?? item.filename ?? item.file_name ?? item.title;
      const fileId = item.file_id ?? item.fileId ?? item.id;
      if (typeof url === 'string' && url.trim()) {
        addEntry(name ? `${String(name).trim()}: ${url.trim()}` : url.trim());
      } else if (typeof fileId === 'string' && fileId.trim()) {
        addEntry(name ? `${String(name).trim()} (${fileId.trim()})` : fileId.trim());
      } else if (Object.keys(item).length > 0) {
        addEntry(JSON.stringify(item));
      }
    }
  };

  for (const c of containers) {
    for (const k of proofKeys) {
      if (Object.prototype.hasOwnProperty.call(c, k)) {
        const val = c[k];
        if (Array.isArray(val)) {
          val.forEach(formatItem);
        } else {
          formatItem(val);
        }
      }
    }
  }
  return collected;
}

export function mergeProofFilesIntoDeliveredItems(deliveredItems: string[], proofFiles: string[]): string[] {
  if (!proofFiles || proofFiles.length === 0) return deliveredItems;
  const result = [...deliveredItems];
  const existing = new Set(result.map(s => s.trim()));
  for (const pf of proofFiles) {
    const label = pf.toLowerCase().startsWith('proof:') ? pf : `Proof: ${pf}`;
    if (!existing.has(label) && !existing.has(pf)) {
      existing.add(label);
      result.push(label);
    }
  }
  return result;
}

/**
 * Live Authoritative Driver: AiToolShop Reseller v1 (Main Supplier)
 */
export class AiToolShopDriver implements ISupplierDriver {
  public readonly driverKey = 'aitoolshop';
  public readonly displayName = 'Main Supplier (AiToolShop v1)';
  public readonly isLiveImplemented = true;

  public async healthCheck(ctx: DriverContext): Promise<DriverHealthResult> {
    const started = Date.now();
    if (!ctx.delegates) {
      return {
        ok: false,
        apiStatus: 'Failed',
        latencyMs: Date.now() - started,
        message: 'Driver delegates unavailable',
        integrated: true,
      };
    }
    const bal = await ctx.delegates.getBalanceDetailed();
    const latencyMs = Date.now() - started;
    if (bal.ok) {
      return {
        ok: true,
        apiStatus: latencyMs > 3000 ? 'Warning' : 'Healthy',
        latencyMs,
        message: `Connected (${bal.balanceUsdt?.toFixed(2) || '0.00'} ${bal.currency})`,
        integrated: true,
      };
    }
    return {
      ok: false,
      apiStatus: bal.error?.includes('not configured') ? 'Warning' : 'Failed',
      latencyMs,
      message: bal.error || `HTTP ${bal.httpStatus}`,
      integrated: true,
    };
  }

  public async balanceCheck(ctx: DriverContext): Promise<DriverBalanceResult> {
    const started = Date.now();
    if (!ctx.delegates) {
      return { ok: false, currency: 'USDT', latencyMs: 0, error: 'Driver delegates unavailable', integrated: true };
    }
    const bal = await ctx.delegates.getBalanceDetailed();
    return {
      ok: bal.ok,
      balanceUsdt: bal.balanceUsdt?.toFixed(4),
      currency: bal.currency,
      latencyMs: Date.now() - started,
      error: bal.error,
      integrated: true,
    };
  }

  public async catalogSync(ctx: DriverContext): Promise<DriverCatalogResult> {
    const started = Date.now();
    if (!ctx.delegates) {
      return { ok: false, products: [], latencyMs: 0, error: 'Driver delegates unavailable', integrated: true };
    }
    const res = await ctx.delegates.fetchLiveProductsDetailed();
    return {
      ok: res.ok,
      products: res.products,
      latencyMs: Date.now() - started,
      error: res.error,
      integrated: true,
    };
  }

  public async priceSync(ctx: DriverContext): Promise<DriverPriceSyncResult> {
    const started = Date.now();
    const cat = await this.catalogSync(ctx);
    return {
      ok: cat.ok,
      updatedItems: cat.products.map(p => ({
        supplierProductId: String(p.id),
        costUsdt: new Decimal(p.your_cost ?? p.price_usdt ?? 0).toFixed(4),
      })),
      latencyMs: Date.now() - started,
      error: cat.error,
      integrated: true,
    };
  }

  public async stockCheck(ctx: DriverContext, supplierProductId: string): Promise<DriverStockCheckResult> {
    const started = Date.now();
    const cat = await this.catalogSync(ctx);
    if (!cat.ok) {
      return {
        ok: false,
        inStock: false,
        stock: 0,
        isUnlimited: false,
        latencyMs: Date.now() - started,
        error: cat.error,
        integrated: true,
      };
    }
    const found = cat.products.find(p => String(p.id) === String(supplierProductId));
    if (!found) {
      return {
        ok: true,
        inStock: false,
        stock: 0,
        isUnlimited: false,
        latencyMs: Date.now() - started,
        error: 'Product not listed in supplier response',
        integrated: true,
      };
    }
    const stock = Number(found.stock ?? found.stock_quantity ?? 0);
    const isUnlimited = Boolean(found.is_unlimited || stock > 1000);
    return {
      ok: true,
      inStock: isUnlimited || stock > 0,
      stock: Number.isFinite(stock) ? stock : 0,
      isUnlimited,
      latencyMs: Date.now() - started,
      integrated: true,
    };
  }

  public async quote(
    ctx: DriverContext,
    params: { supplierProductId: string | number; quantity: number }
  ): Promise<DriverQuoteResult> {
    const started = Date.now();
    const qty = Math.max(1, Math.floor(params.quantity || 1));
    const pid = String(params.supplierProductId);
    const cat = await this.catalogSync(ctx);
    if (!cat.ok) {
      return {
        ok: false,
        supplierProductId: pid,
        quantity: qty,
        currency: 'USDT',
        inStock: false,
        latencyMs: Date.now() - started,
        source: 'UNAVAILABLE',
        error: cat.error,
        integrated: true,
      };
    }
    const found = cat.products.find(p => String(p.id) === pid);
    if (!found) {
      return {
        ok: false,
        supplierProductId: pid,
        quantity: qty,
        currency: 'USDT',
        inStock: false,
        latencyMs: Date.now() - started,
        source: 'LIVE_CATALOG',
        error: 'Product not listed in supplier catalog',
        integrated: true,
      };
    }
    const unitCost = new Decimal(found.your_cost ?? found.price_usdt ?? 0);
    const stock = Number(found.stock ?? found.stock_quantity ?? 0);
    const isUnlimited = Boolean(found.is_unlimited || stock > 1000);
    const inStock = isUnlimited || stock >= qty;
    return {
      ok: true,
      supplierProductId: pid,
      quantity: qty,
      unitCostUsdt: unitCost.toFixed(4),
      totalCostUsdt: unitCost.times(qty).toFixed(4),
      currency: 'USDT',
      inStock,
      availableStock: Number.isFinite(stock) ? stock : 0,
      isUnlimited,
      latencyMs: Date.now() - started,
      source: 'LIVE_CATALOG',
      integrated: true,
    };
  }

  public async purchase(ctx: DriverContext, payload: SupplierOrderPayload): Promise<SupplierOrderResponse> {
    if (!ctx.delegates) {
      return {
        success: false,
        status: 'failed',
        error_code: 'SUPPLIER_UNAVAILABLE',
        message: 'Driver delegates unavailable',
      };
    }
    return await ctx.delegates.placeOrderDirect(payload, ctx.baseUrl);
  }

  public async orderRecovery(
    ctx: DriverContext,
    params: { supplierOrderRef?: string | null; idempotencyKey?: string | null }
  ): Promise<SupplierOrderLookupResult> {
    if (!ctx.delegates) {
      return {
        ok: false,
        found: false,
        httpStatus: 0,
        lookupMethod: 'NONE',
        status: 'error',
        delivered_items: [],
        error_code: 'DRIVER_UNAVAILABLE',
      };
    }
    return await ctx.delegates.lookupOrderReadOnly(params);
  }

  public async diagnostics(ctx: DriverContext): Promise<DriverDiagnosticsResult> {
    const started = Date.now();
    if (!ctx.delegates) {
      return {
        ok: false,
        driverKey: this.driverKey,
        supplierId: ctx.supplierId,
        integrated: true,
        apiStatus: 'Failed',
        latencyMs: 0,
        checks: [{ name: 'Driver Context', ok: false, detail: 'Missing driver delegates' }],
      };
    }
    const diag = await ctx.delegates.runReadOnlyDiagnostic();
    const ok = diag.balanceCheck.ok && diag.productsCheck.ok;
    return {
      ok,
      driverKey: this.driverKey,
      supplierId: ctx.supplierId,
      integrated: true,
      apiStatus: ok ? 'Healthy' : 'Failed',
      latencyMs: Date.now() - started,
      checks: [
        {
          name: 'Balance API',
          ok: diag.balanceCheck.ok,
          detail: diag.balanceCheck.ok
            ? `${diag.balanceCheck.balanceUsdt} ${diag.balanceCheck.currency}`
            : diag.balanceCheck.error || `HTTP ${diag.balanceCheck.httpStatus}`,
        },
        {
          name: 'Catalog Mirror API',
          ok: diag.productsCheck.ok,
          detail: diag.productsCheck.ok
            ? `${diag.productsCheck.activeInStockCount}/${diag.productsCheck.totalCount} active in-stock`
            : diag.productsCheck.error || `HTTP ${diag.productsCheck.httpStatus}`,
        },
        {
          name: 'Order Recovery Lookup',
          ok: diag.ordersListCheck.ok,
          detail: diag.ordersListCheck.ok
            ? `${diag.ordersListCheck.count} recent orders readable`
            : diag.ordersListCheck.error || `HTTP ${diag.ordersListCheck.httpStatus}`,
        },
      ],
      rawReadOnlyDiag: diag,
    };
  }
}

/**
 * Shared Base Driver for External Reseller APIs (VenteBot, NyStore, Cuppon'sHub, ZFour).
 * Provides strict Bearer auth, idempotency headers, GET /balance, GET /products,
 * GET /quote (with live catalog fallback), POST /order, GET /orders/lookup recovery,
 * and extensible hooks for supplier-specific capabilities (proof files, webhooks, inventory, tracking).
 */
export abstract class BaseExternalResellerDriver implements ISupplierDriver {
  public abstract readonly driverKey: string;
  public abstract readonly displayName: string;
  protected abstract readonly envPrefix: string;
  public readonly isLiveImplemented = true;

  protected isPlaceholderEndpoint(baseUrl: string): boolean {
    const clean = String(baseUrl || '').trim().toLowerCase();
    return !clean || clean.includes('.example') || clean.includes('.invalid');
  }

  protected hasCredentialsAndEndpoint(ctx: DriverContext): { ready: boolean; reason?: string } {
    if (this.isPlaceholderEndpoint(ctx.baseUrl) && !ctx.fetchFn) {
      return { ready: false, reason: `${this.displayName} API endpoint (${this.envPrefix}_BASE_URL) not configured yet.` };
    }
    if (this.isPlaceholderEndpoint(ctx.baseUrl) && !ctx.apiKey) {
      return {
        ready: false,
        reason: `${this.displayName} endpoint/credentials (${this.envPrefix}_BASE_URL / ${this.envPrefix}_API_KEY) not configured yet.`,
      };
    }
    if (!ctx.apiKey && !ctx.fetchFn) {
      return { ready: false, reason: `${this.envPrefix}_API_KEY not configured.` };
    }
    return { ready: true };
  }

  protected buildHeaders(ctx: DriverContext, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(extra || {}),
    };
    if (ctx.apiKey) {
      headers['Authorization'] = `Bearer ${ctx.apiKey}`;
    }
    return headers;
  }

  protected async doFetch(
    ctx: DriverContext,
    path: string,
    init: RequestInit,
    timeoutMs = 10000
  ): Promise<Response> {
    const fetchImpl = ctx.fetchFn || fetch;
    const base = ctx.baseUrl.replace(/\/+$/, '');
    const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        ...init,
        signal: init.signal || controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  protected normalizeRawProduct(p: any): SupplierRawProduct {
    const id = p?.id ?? p?.product_id ?? p?.sku ?? p?.code ?? '';
    const name = String(p?.name ?? p?.title ?? p?.product_name ?? 'Unnamed Product').trim();
    const description = String(p?.description ?? p?.details ?? '');
    const cost =
      p?.your_cost ??
      p?.reseller_price ??
      p?.wholesale_price ??
      p?.cost_usdt ??
      p?.cost ??
      p?.price_usdt ??
      p?.price ??
      0;
    const price = p?.price_usdt ?? p?.price ?? cost ?? 0;
    const stockRaw = p?.stock ?? p?.stock_quantity ?? p?.available_stock ?? p?.available_quantity ?? p?.qty ?? 0;
    const stock = Number.isFinite(Number(stockRaw)) ? Number(stockRaw) : 0;
    const isUnlimited = Boolean(p?.is_unlimited ?? p?.unlimited ?? stock > 1000);
    const requiresEmail = Boolean(p?.requires_email ?? p?.email_required);
    const type = String(p?.type ?? p?.delivery_type ?? (requiresEmail ? 'invite' : 'account'));
    const duration = String(p?.duration ?? p?.validity ?? '1 Month');
    const warranty = String(p?.warranty ?? p?.warranty_summary ?? 'Full duration replacement warranty');

    return {
      id,
      name,
      description,
      your_cost: cost,
      price_usdt: price,
      stock,
      stock_quantity: stock,
      is_unlimited: isUnlimited,
      requires_email: requiresEmail,
      type,
      duration,
      warranty,
      category: p?.category ?? p?.category_name,
    };
  }

  protected enhancePurchaseResponse(res: SupplierOrderResponse, _data: any): SupplierOrderResponse {
    return res;
  }

  protected enhanceLookupResult(res: SupplierOrderLookupResult, _data: any): SupplierOrderLookupResult {
    return res;
  }

  protected async fallbackOrderRecovery(
    _ctx: DriverContext,
    _params: { supplierOrderRef?: string | null; idempotencyKey?: string | null }
  ): Promise<SupplierOrderLookupResult | null> {
    return null;
  }

  protected async getExtraDiagnosticChecks(
    _ctx: DriverContext,
    _firstProduct?: SupplierRawProduct
  ): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
    return [];
  }

  protected getRecoveryCheckTitle(): string {
    return 'Order Recovery (GET /orders/lookup)';
  }

  public async healthCheck(ctx: DriverContext): Promise<DriverHealthResult> {
    const started = Date.now();
    const readiness = this.hasCredentialsAndEndpoint(ctx);
    if (!readiness.ready) {
      return {
        ok: false,
        apiStatus: 'Offline',
        latencyMs: Date.now() - started,
        message: readiness.reason || `${this.displayName} credentials not configured`,
        integrated: true,
      };
    }

    const bal = await this.balanceCheck(ctx);
    const latencyMs = Date.now() - started;
    if (bal.ok) {
      return {
        ok: true,
        apiStatus: latencyMs > 3000 ? 'Warning' : 'Healthy',
        latencyMs,
        message: `Connected (${bal.balanceUsdt || '0.00'} ${bal.currency})`,
        integrated: true,
      };
    }

    return {
      ok: false,
      apiStatus: bal.error?.includes('not configured') ? 'Warning' : 'Failed',
      latencyMs,
      message: bal.error || `${this.displayName} unreachable`,
      integrated: true,
    };
  }

  public async balanceCheck(ctx: DriverContext): Promise<DriverBalanceResult> {
    const started = Date.now();
    const readiness = this.hasCredentialsAndEndpoint(ctx);
    if (!readiness.ready) {
      return {
        ok: false,
        currency: 'USDT',
        latencyMs: Date.now() - started,
        error: readiness.reason,
        integrated: true,
      };
    }

    try {
      const res = await this.doFetch(
        ctx,
        '/balance',
        { method: 'GET', headers: this.buildHeaders(ctx) },
        8000
      );
      const rawText = await res.text();
      let data: any = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      if (!res.ok) {
        return {
          ok: false,
          currency: 'USDT',
          latencyMs: Date.now() - started,
          error: data?.message || `HTTP ${res.status}`,
          integrated: true,
        };
      }
      if (!data || typeof data !== 'object' || data.success === false) {
        return {
          ok: false,
          currency: 'USDT',
          latencyMs: Date.now() - started,
          error: data?.message || 'MALFORMED_JSON',
          integrated: true,
        };
      }

      const unwrapped = unwrapEnvelope(data);
      const rawBal =
        unwrapped.balance ??
        unwrapped.balance_usdt ??
        unwrapped.available_balance ??
        unwrapped.available ??
        data.balance ??
        data.balance_usdt ??
        0;
      const balance = new Decimal(rawBal || 0);
      return {
        ok: true,
        balanceUsdt: balance.toFixed(4),
        currency: String(unwrapped.currency || data.currency || 'USDT'),
        latencyMs: Date.now() - started,
        integrated: true,
      };
    } catch (err: any) {
      return {
        ok: false,
        currency: 'USDT',
        latencyMs: Date.now() - started,
        error: err?.message || 'NETWORK_ERROR',
        integrated: true,
      };
    }
  }

  public async catalogSync(ctx: DriverContext): Promise<DriverCatalogResult> {
    const started = Date.now();
    const readiness = this.hasCredentialsAndEndpoint(ctx);
    if (!readiness.ready) {
      return {
        ok: false,
        products: [],
        latencyMs: Date.now() - started,
        error: readiness.reason,
        integrated: true,
      };
    }

    try {
      const res = await this.doFetch(
        ctx,
        '/products',
        { method: 'GET', headers: this.buildHeaders(ctx) },
        12000
      );
      const rawText = await res.text();
      let data: any = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      if (!res.ok) {
        return {
          ok: false,
          products: [],
          latencyMs: Date.now() - started,
          error: data?.message || `HTTP ${res.status}`,
          integrated: true,
        };
      }
      if (!data) {
        return {
          ok: false,
          products: [],
          latencyMs: Date.now() - started,
          error: 'MALFORMED_JSON',
          integrated: true,
        };
      }

      const rawArr: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data.products)
          ? data.products
          : Array.isArray(data.data)
            ? data.data
            : Array.isArray(data.items)
              ? data.items
              : [];

      const products = rawArr
        .map(p => this.normalizeRawProduct(p))
        .filter(p => String(p.id || '').trim().length > 0);

      return {
        ok: true,
        products,
        latencyMs: Date.now() - started,
        integrated: true,
      };
    } catch (err: any) {
      return {
        ok: false,
        products: [],
        latencyMs: Date.now() - started,
        error: err?.message || 'NETWORK_ERROR',
        integrated: true,
      };
    }
  }

  public async priceSync(ctx: DriverContext): Promise<DriverPriceSyncResult> {
    const started = Date.now();
    const cat = await this.catalogSync(ctx);
    return {
      ok: cat.ok,
      updatedItems: cat.products.map(p => ({
        supplierProductId: String(p.id),
        costUsdt: new Decimal(p.your_cost ?? p.price_usdt ?? 0).toFixed(4),
      })),
      latencyMs: Date.now() - started,
      error: cat.error,
      integrated: true,
    };
  }

  public async stockCheck(ctx: DriverContext, supplierProductId: string): Promise<DriverStockCheckResult> {
    const started = Date.now();
    const q = await this.quote(ctx, { supplierProductId, quantity: 1 });
    return {
      ok: q.ok,
      inStock: q.inStock,
      stock: q.availableStock ?? (q.inStock ? 1 : 0),
      isUnlimited: Boolean(q.isUnlimited),
      latencyMs: Date.now() - started,
      error: q.error,
      integrated: true,
    };
  }

  public async quote(
    ctx: DriverContext,
    params: { supplierProductId: string | number; quantity: number }
  ): Promise<DriverQuoteResult> {
    const started = Date.now();
    const pid = String(params.supplierProductId);
    const qty = Math.max(1, Math.floor(params.quantity || 1));
    const readiness = this.hasCredentialsAndEndpoint(ctx);
    if (!readiness.ready) {
      return {
        ok: false,
        supplierProductId: pid,
        quantity: qty,
        currency: 'USDT',
        inStock: false,
        latencyMs: Date.now() - started,
        source: 'UNAVAILABLE',
        error: readiness.reason,
        integrated: true,
      };
    }

    try {
      const res = await this.doFetch(
        ctx,
        `/quote?product_id=${encodeURIComponent(pid)}&quantity=${qty}`,
        { method: 'GET', headers: this.buildHeaders(ctx) },
        8000
      );

      if (res.ok) {
        const rawText = await res.text();
        let data: any = null;
        try {
          data = rawText ? JSON.parse(rawText) : null;
        } catch {
          data = null;
        }
        if (data && typeof data === 'object' && data.success !== false) {
          const rec = unwrapEnvelope(data);
          const unitRaw = rec.unit_cost ?? rec.unit_price ?? rec.your_cost ?? rec.price_usdt ?? rec.price;
          const totalRaw = rec.total_cost ?? rec.total_price ?? rec.total;
          const unitDec = unitRaw !== undefined
            ? new Decimal(unitRaw)
            : totalRaw !== undefined
              ? new Decimal(totalRaw).div(qty)
              : new Decimal(0);
          const totalDec = totalRaw !== undefined ? new Decimal(totalRaw) : unitDec.times(qty);
          const stockNum = rec.available_stock ?? rec.stock ?? rec.stock_quantity;
          const parsedStock = stockNum !== undefined ? Number(stockNum) : undefined;
          const isUnlimited = Boolean(rec.is_unlimited || (parsedStock !== undefined && parsedStock > 1000));
          const inStock =
            rec.in_stock !== undefined
              ? Boolean(rec.in_stock)
              : rec.available !== undefined
                ? Boolean(rec.available)
                : isUnlimited || parsedStock === undefined || parsedStock >= qty;

          return {
            ok: true,
            supplierProductId: pid,
            quantity: qty,
            unitCostUsdt: unitDec.toFixed(4),
            totalCostUsdt: totalDec.toFixed(4),
            currency: String(rec.currency || 'USDT'),
            inStock,
            availableStock: parsedStock !== undefined && Number.isFinite(parsedStock) ? parsedStock : undefined,
            isUnlimited,
            latencyMs: Date.now() - started,
            source: 'LIVE_QUOTE_API',
            integrated: true,
          };
        }
      } else if (res.status !== 404 && res.status !== 405 && res.status !== 501) {
        return {
          ok: false,
          supplierProductId: pid,
          quantity: qty,
          currency: 'USDT',
          inStock: false,
          latencyMs: Date.now() - started,
          source: 'UNAVAILABLE',
          error: `HTTP ${res.status}`,
          integrated: true,
        };
      }
    } catch {
      // Fallback cleanly to catalogSync if /quote endpoint is unsupported or unavailable
    }

    const cat = await this.catalogSync(ctx);
    if (!cat.ok) {
      return {
        ok: false,
        supplierProductId: pid,
        quantity: qty,
        currency: 'USDT',
        inStock: false,
        latencyMs: Date.now() - started,
        source: 'UNAVAILABLE',
        error: cat.error,
        integrated: true,
      };
    }

    const found = cat.products.find(p => String(p.id) === pid);
    if (!found) {
      return {
        ok: false,
        supplierProductId: pid,
        quantity: qty,
        currency: 'USDT',
        inStock: false,
        latencyMs: Date.now() - started,
        source: 'LIVE_CATALOG',
        error: `Product not listed in ${this.displayName} catalog`,
        integrated: true,
      };
    }

    const unitCost = new Decimal(found.your_cost ?? found.price_usdt ?? 0);
    const stock = Number(found.stock ?? found.stock_quantity ?? 0);
    const isUnlimited = Boolean(found.is_unlimited || stock > 1000);
    return {
      ok: true,
      supplierProductId: pid,
      quantity: qty,
      unitCostUsdt: unitCost.toFixed(4),
      totalCostUsdt: unitCost.times(qty).toFixed(4),
      currency: 'USDT',
      inStock: isUnlimited || stock >= qty,
      availableStock: Number.isFinite(stock) ? stock : 0,
      isUnlimited,
      latencyMs: Date.now() - started,
      source: 'LIVE_CATALOG',
      integrated: true,
    };
  }

  public async purchase(ctx: DriverContext, payload: SupplierOrderPayload): Promise<SupplierOrderResponse> {
    const readiness = this.hasCredentialsAndEndpoint(ctx);
    if (!readiness.ready) {
      return {
        success: false,
        status: 'failed',
        error_code: !ctx.apiKey ? 'INVALID_API_KEY' : 'SUPPLIER_UNAVAILABLE',
        message: readiness.reason || `${this.displayName} credentials not configured`,
      };
    }

    try {
      const res = await this.doFetch(
        ctx,
        '/order',
        {
          method: 'POST',
          headers: this.buildHeaders(ctx, { 'Idempotency-Key': payload.idempotency_key }),
          body: JSON.stringify(payload),
        },
        15000
      );

      const rawText = await res.text();
      let data: any = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {
          success: false,
          status: 'failed',
          error_code: 'UNCERTAIN_MALFORMED_RESPONSE',
          message: `${this.displayName} returned non-JSON or malformed response (HTTP ${res.status}). Requires reconciliation before refunding.`,
        };
      }

      const record = unwrapEnvelope(data);
      const rawStatus = typeof record?.status === 'string'
        ? record.status.trim().toLowerCase()
        : typeof data.status === 'string'
          ? data.status.trim().toLowerCase()
          : '';
      const orderRef = extractDriverOrderRef(record, data);
      const deliveredItems = extractDriverDeliveredItems(data);

      if (res.status === 200 || res.status === 201) {
        if (rawStatus === 'uncertain') {
          return this.enhancePurchaseResponse(
            {
              success: false,
              status: 'failed',
              order_ref: orderRef,
              error_code: 'UNCERTAIN_SUPPLIER_STATUS',
              message: record?.message || data.message || `${this.displayName} returned uncertain order outcome; queued for lookup recovery.`,
              raw: data,
            },
            data
          );
        }

        const explicitFailure =
          data.success === false ||
          record?.success === false ||
          FAILED_STATUS_SET.has(rawStatus) ||
          (rawStatus === 'error' && hasNonBenignErrorCode(record?.error_code ?? data.error_code)) ||
          hasNonBenignErrorCode(record?.error_code ?? data.error_code);

        if (explicitFailure) {
          const defaultErr = rawStatus === 'failed_no_charge' ? 'FAILED_NO_CHARGE' : 'SUPPLIER_REJECTED';
          return this.enhancePurchaseResponse(
            {
              success: false,
              status: 'failed',
              order_ref: orderRef,
              error_code: record?.error_code || data.error_code || defaultErr,
              message: record?.message || data.message || `${this.displayName} rejected order`,
              raw: data,
            },
            data
          );
        }

        if (rawStatus === 'replayed') {
          return this.enhancePurchaseResponse(
            {
              success: true,
              status: 'replayed',
              order_ref: orderRef,
              delivered_items: deliveredItems,
              raw: data,
            },
            data
          );
        }

        if (DELIVERED_STATUS_SET.has(rawStatus)) {
          return this.enhancePurchaseResponse(
            {
              success: true,
              status: 'completed',
              order_ref: orderRef,
              delivered_items: deliveredItems,
              raw: data,
            },
            data
          );
        }

        if (PENDING_INVITE_SET.has(rawStatus)) {
          return this.enhancePurchaseResponse(
            {
              success: true,
              status: 'pending_invite',
              order_ref: orderRef,
              delivered_items: deliveredItems,
              raw: data,
            },
            data
          );
        }

        if (IN_PROGRESS_SET.has(rawStatus)) {
          return this.enhancePurchaseResponse(
            {
              success: true,
              status: 'pending',
              order_ref: orderRef,
              delivered_items: deliveredItems,
              raw: data,
            },
            data
          );
        }

        if (deliveredItems.length > 0 || orderRef) {
          return this.enhancePurchaseResponse(
            {
              success: true,
              status: deliveredItems.length > 0 ? 'completed' : 'pending_invite',
              order_ref: orderRef,
              delivered_items: deliveredItems,
              raw: data,
            },
            data
          );
        }

        const enrichedEmpty = this.enhancePurchaseResponse(
          {
            success: false,
            status: 'failed',
            error_code: 'UNCERTAIN_MALFORMED_RESPONSE',
            message: `${this.displayName} returned 200 without recognized status, order reference, or delivery payload.`,
            raw: data,
          },
          data
        );
        return enrichedEmpty;
      }

      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        const errCode = String(record?.error_code || data.error_code || '').toUpperCase();
        const isDeterministic = [
          'OUT_OF_STOCK',
          'INSUFFICIENT_BALANCE',
          'INVALID_API_KEY',
          'PRODUCT_UNAVAILABLE',
          'INVALID_EMAIL',
          'FAILED_NO_CHARGE',
        ].includes(errCode);
        if (!isDeterministic) {
          return {
            success: false,
            status: 'failed',
            order_ref: orderRef,
            error_code: `UNCERTAIN_HTTP_${res.status}`,
            message:
              record?.message ||
              data.message ||
              `${this.displayName} returned ambiguous HTTP ${res.status}. Requires reconciliation before refunding.`,
            raw: data,
          };
        }
      }

      const errorCode =
        record?.error_code ||
        data.error_code ||
        (res.status === 401 ? 'INVALID_API_KEY' : res.status === 402 ? 'INSUFFICIENT_BALANCE' : 'API_ERROR');
      return {
        success: false,
        status: 'failed',
        order_ref: orderRef,
        error_code: errorCode,
        message: record?.message || data.message || `${this.displayName} order rejected`,
        raw: data,
      };
    } catch (err: any) {
      return {
        success: false,
        status: 'failed',
        error_code: 'UNCERTAIN_TIMEOUT',
        message:
          err?.message || `${this.displayName} purchase timed out or network error. Requires reconciliation before refunding.`,
      };
    }
  }

  protected parseLookupJsonPayload(
    data: any,
    httpStatus: number,
    lookupMethod: SupplierOrderLookupResult['lookupMethod'],
    params: { supplierOrderRef?: string | null; idempotencyKey?: string | null }
  ): SupplierOrderLookupResult {
    const record = unwrapEnvelope(data);
    const rawStatusRaw =
      record?.status ?? record?.tracking_status ?? record?.fulfillment_status ?? data.status ?? data.tracking_status;
    const rawStatus = typeof rawStatusRaw === 'string' ? rawStatusRaw.trim().toLowerCase() : '';
    const orderRef = extractDriverOrderRef(record, data) || params.supplierOrderRef || undefined;
    const idempotencyKey = record?.idempotency_key || data?.idempotency_key || params.idempotencyKey || undefined;
    const deliveredItems = extractDriverDeliveredItems(data);

    if (data.found === false || record?.found === false || rawStatus === 'not_found') {
      return this.enhanceLookupResult(
        {
          ok: true,
          found: false,
          httpStatus,
          lookupMethod,
          status: 'not_found',
          delivered_items: [],
          error_code: record?.error_code || data.error_code || 'ORDER_NOT_FOUND',
          message: record?.message || data.message || `Order not found at ${this.displayName}`,
          raw: data,
        },
        data
      );
    }

    if (rawStatus === 'uncertain') {
      return this.enhanceLookupResult(
        {
          ok: true,
          found: true,
          httpStatus,
          lookupMethod,
          status: 'error',
          order_ref: orderRef,
          idempotency_key: idempotencyKey,
          delivered_items: [],
          error_code: 'UNCERTAIN',
          message:
            record?.message ||
            data.message ||
            `${this.displayName} reported status=uncertain; keep UNCERTAIN under review without reorder or refund.`,
          raw: data,
        },
        data
      );
    }

    if (
      rawStatus === 'failed_no_charge' ||
      FAILED_STATUS_SET.has(rawStatus) ||
      data.success === false ||
      record?.success === false ||
      (rawStatus === 'error' && hasNonBenignErrorCode(record?.error_code ?? data.error_code))
    ) {
      const errCode =
        record?.error_code ||
        data.error_code ||
        (rawStatus === 'failed_no_charge' ? 'FAILED_NO_CHARGE' : 'SUPPLIER_FAILED');
      return this.enhanceLookupResult(
        {
          ok: true,
          found: true,
          httpStatus,
          lookupMethod,
          status: 'failed',
          order_ref: orderRef,
          idempotency_key: idempotencyKey,
          delivered_items: [],
          error_code: errCode,
          message:
            record?.message ||
            data.message ||
            (rawStatus === 'failed_no_charge'
              ? `${this.displayName} confirmed failed_no_charge via lookup`
              : `${this.displayName} confirmed order failure`),
          raw: data,
        },
        data
      );
    }

    if (IN_PROGRESS_SET.has(rawStatus) || rawStatus === 'tracked') {
      return this.enhanceLookupResult(
        {
          ok: true,
          found: true,
          httpStatus,
          lookupMethod,
          status: 'pending',
          order_ref: orderRef,
          idempotency_key: idempotencyKey,
          delivered_items: [],
          error_code: 'IN_PROGRESS',
          message: record?.message || data.message || `${this.displayName} order is still in_progress; awaiting completion.`,
          raw: data,
        },
        data
      );
    }

    if (PENDING_INVITE_SET.has(rawStatus)) {
      return this.enhanceLookupResult(
        {
          ok: true,
          found: true,
          httpStatus,
          lookupMethod,
          status: 'pending_invite',
          order_ref: orderRef,
          idempotency_key: idempotencyKey,
          delivered_items: deliveredItems,
          message: record?.message || data.message || 'Order awaiting invite delivery',
          raw: data,
        },
        data
      );
    }

    if (DELIVERED_STATUS_SET.has(rawStatus) || deliveredItems.length > 0) {
      return this.enhanceLookupResult(
        {
          ok: true,
          found: true,
          httpStatus,
          lookupMethod,
          status: 'completed',
          order_ref: orderRef,
          idempotency_key: idempotencyKey,
          delivered_items: deliveredItems,
          message: record?.message || data.message || `${this.displayName} confirmed completed order`,
          raw: data,
        },
        data
      );
    }

    const enriched = this.enhanceLookupResult(
      {
        ok: true,
        found: true,
        httpStatus,
        lookupMethod,
        status: 'error',
        order_ref: orderRef,
        idempotency_key: idempotencyKey,
        delivered_items: [],
        error_code: 'UNCERTAIN_UNRECOGNIZED_STATUS',
        message: `Unrecognized ${this.displayName} lookup status (${rawStatus || 'empty'}); kept UNCERTAIN under review.`,
        raw: data,
      },
      data
    );
    return enriched;
  }

  public async orderRecovery(
    ctx: DriverContext,
    params: { supplierOrderRef?: string | null; idempotencyKey?: string | null }
  ): Promise<SupplierOrderLookupResult> {
    const readiness = this.hasCredentialsAndEndpoint(ctx);
    if (!readiness.ready) {
      return {
        ok: false,
        found: false,
        httpStatus: 0,
        lookupMethod: 'NONE',
        status: 'error',
        delivered_items: [],
        error_code: !ctx.apiKey ? 'INVALID_API_KEY' : 'NOT_INTEGRATED',
        message: readiness.reason,
      };
    }

    const qs = new URLSearchParams();
    if (params.supplierOrderRef && params.supplierOrderRef.trim()) {
      qs.set('order_ref', params.supplierOrderRef.trim());
    }
    if (params.idempotencyKey && params.idempotencyKey.trim()) {
      qs.set('idempotency_key', params.idempotencyKey.trim());
    }
    if (!qs.toString()) {
      return {
        ok: false,
        found: false,
        httpStatus: 0,
        lookupMethod: 'NONE',
        status: 'error',
        delivered_items: [],
        error_code: 'EMPTY_LOOKUP_KEY',
        message: `No order_ref or idempotency_key supplied for ${this.displayName} recovery lookup.`,
      };
    }

    try {
      const res = await this.doFetch(
        ctx,
        `/orders/lookup?${qs.toString()}`,
        { method: 'GET', headers: this.buildHeaders(ctx) },
        10000
      );

      const rawText = await res.text();
      let data: any = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      if (res.status === 404 || res.status === 405 || res.status === 501) {
        const fb = await this.fallbackOrderRecovery(ctx, params);
        if (fb) return fb;
      }

      if (res.status === 404) {
        return {
          ok: true,
          found: false,
          httpStatus: 404,
          lookupMethod: 'GET_ORDERS_LOOKUP',
          status: 'not_found',
          delivered_items: [],
          error_code: data?.error_code || 'ORDER_NOT_FOUND',
          message: data?.message || `Order not found at ${this.displayName}`,
          raw: data || undefined,
        };
      }

      if (!res.ok) {
        return {
          ok: false,
          found: false,
          httpStatus: res.status,
          lookupMethod: 'GET_ORDERS_LOOKUP',
          status: 'error',
          delivered_items: [],
          error_code: data?.error_code || `HTTP_${res.status}`,
          message: data?.message || `${this.displayName} GET /orders/lookup returned HTTP ${res.status}`,
          raw: data || undefined,
        };
      }

      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {
          ok: false,
          found: false,
          httpStatus: res.status,
          lookupMethod: 'GET_ORDERS_LOOKUP',
          status: 'error',
          delivered_items: [],
          error_code: 'MALFORMED_JSON',
          message: `${this.displayName} GET /orders/lookup returned malformed JSON response.`,
        };
      }

      return this.parseLookupJsonPayload(data, res.status, 'GET_ORDERS_LOOKUP', params);
    } catch (err: any) {
      return {
        ok: false,
        found: false,
        httpStatus: 0,
        lookupMethod: 'GET_ORDERS_LOOKUP',
        status: 'error',
        delivered_items: [],
        error_code: 'NETWORK_ERROR',
        message: err?.message || `${this.displayName} GET /orders/lookup network error/timeout`,
      };
    }
  }

  public async diagnostics(ctx: DriverContext): Promise<DriverDiagnosticsResult> {
    const started = Date.now();
    const readiness = this.hasCredentialsAndEndpoint(ctx);
    if (!readiness.ready) {
      return {
        ok: false,
        driverKey: this.driverKey,
        supplierId: ctx.supplierId,
        integrated: true,
        apiStatus: 'Offline',
        latencyMs: Date.now() - started,
        checks: [
          {
            name: 'Integration Readiness',
            ok: false,
            detail: readiness.reason || `${this.displayName} credentials not bound`,
          },
          {
            name: 'Driver Contract Methods',
            ok: true,
            detail: 'Health / Balance / Catalog / Quote / Purchase / Recovery / Diagnostics loaded',
          },
        ],
      };
    }

    const [bal, cat, recoveryProbe] = await Promise.all([
      this.balanceCheck(ctx),
      this.catalogSync(ctx),
      this.orderRecovery(ctx, { idempotencyKey: '__diag_nonexistent_probe__' }),
    ]);

    const firstProd = cat.products[0];
    let quoteCheck: { ok: boolean; detail: string };
    if (firstProd) {
      const q = await this.quote(ctx, { supplierProductId: firstProd.id, quantity: 1 });
      quoteCheck = {
        ok: q.ok,
        detail: q.ok
          ? `${firstProd.name.slice(0, 28)}: ${q.unitCostUsdt} ${q.currency} (${q.source})`
          : q.error || 'Quote unavailable',
      };
    } else {
      quoteCheck = {
        ok: cat.ok,
        detail: cat.ok ? 'No remote items to quote (0 catalog items)' : cat.error || 'Catalog required for quote',
      };
    }

    const extraChecks = await this.getExtraDiagnosticChecks(ctx, firstProd);
    const recoveryOk = recoveryProbe.ok;
    const extraOk = extraChecks.every(c => c.ok);
    const allCoreOk = bal.ok && cat.ok;
    const latencyMs = Date.now() - started;

    return {
      ok: allCoreOk && quoteCheck.ok && recoveryOk && extraOk,
      driverKey: this.driverKey,
      supplierId: ctx.supplierId,
      integrated: true,
      apiStatus: allCoreOk ? (recoveryOk && extraOk && latencyMs <= 4000 ? 'Healthy' : 'Warning') : 'Failed',
      latencyMs,
      checks: [
        {
          name: 'Integration Readiness',
          ok: true,
          detail: `Live ${this.displayName} driver bound (${ctx.baseUrl})`,
        },
        {
          name: 'Balance API',
          ok: bal.ok,
          detail: bal.ok ? `${bal.balanceUsdt} ${bal.currency}` : bal.error || 'Failed',
        },
        {
          name: 'Catalog Sync API',
          ok: cat.ok,
          detail: cat.ok ? `${cat.products.length} products readable` : cat.error || 'Failed',
        },
        {
          name: 'Quote Engine Check',
          ok: quoteCheck.ok,
          detail: quoteCheck.detail,
        },
        {
          name: this.getRecoveryCheckTitle(),
          ok: recoveryOk,
          detail: recoveryOk
            ? `Read-only lookup reachable (HTTP ${recoveryProbe.httpStatus}, status=${recoveryProbe.status})`
            : recoveryProbe.message || `HTTP ${recoveryProbe.httpStatus}`,
        },
        ...extraChecks,
      ],
    };
  }
}

/**
 * Live External Supplier Driver: VenteBot
 */
export class VenteBotDriver extends BaseExternalResellerDriver {
  public readonly driverKey = 'ventebot';
  public readonly displayName = 'VenteBot';
  protected readonly envPrefix = 'VENTEBOT';
}

/**
 * Live External Supplier Driver: NyStore
 * Supports: Balance Check, Catalog Sync, Quote, Purchase,
 * Inbound Webhook Support (HMAC-SHA256 / secret verification + reconciliation),
 * Proof Files normalization into encrypted delivery evidence, Order Recovery, Health & Diagnostics.
 */
export class NyStoreDriver extends BaseExternalResellerDriver {
  public readonly driverKey = 'nystore';
  public readonly displayName = 'NyStore';
  protected readonly envPrefix = 'NYSTORE';

  public static verifyWebhookSignature(params: {
    rawBody: string;
    signatureHeader?: string;
    secretHeader?: string;
    expectedSecret?: string;
  }): boolean {
    const secret = String(params.expectedSecret || '').trim();
    if (!secret) return false;

    const directHeader = String(params.secretHeader || '').trim();
    if (directHeader) {
      const a = Buffer.from(directHeader, 'utf8');
      const b = Buffer.from(secret, 'utf8');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return true;
      }
    }

    const sigRaw = String(params.signatureHeader || '').trim();
    if (!sigRaw) return false;

    const sigHex = sigRaw.toLowerCase().startsWith('sha256=') ? sigRaw.slice(7).trim() : sigRaw;
    const expectedHex = crypto.createHmac('sha256', secret).update(params.rawBody, 'utf8').digest('hex');

    const sigBuf = Buffer.from(sigHex.toLowerCase(), 'utf8');
    const expBuf = Buffer.from(expectedHex.toLowerCase(), 'utf8');
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  }

  public static parseWebhookPayload(payload: any): {
    status: 'completed' | 'failed' | 'pending_invite' | 'pending' | 'uncertain';
    orderRef?: string;
    idempotencyKey?: string;
    deliveredItems: string[];
    proofFiles: string[];
    errorCode?: string;
    message?: string;
  } {
    const rec = unwrapEnvelope(payload || {});
    const eventStr = String(rec?.event ?? payload?.event ?? '').trim().toLowerCase();
    const rawStatusRaw = rec?.status ?? payload?.status ?? eventStr;
    const rawStatus = typeof rawStatusRaw === 'string'
      ? rawStatusRaw.replace(/^order\./, '').trim().toLowerCase()
      : '';

    const orderRef = extractDriverOrderRef(rec, payload);
    const idempotencyKey =
      rec?.idempotency_key || rec?.idempotencyKey || payload?.idempotency_key || payload?.idempotencyKey;
    const proofFiles = extractDriverProofFiles(payload);
    const rawItems = extractDriverDeliveredItems(payload);
    const deliveredItems = mergeProofFilesIntoDeliveredItems(rawItems, proofFiles);

    if (
      rawStatus === 'failed_no_charge' ||
      FAILED_STATUS_SET.has(rawStatus) ||
      payload?.success === false ||
      rec?.success === false
    ) {
      return {
        status: 'failed',
        orderRef,
        idempotencyKey,
        deliveredItems: [],
        proofFiles,
        errorCode: rec?.error_code || payload?.error_code || (rawStatus === 'failed_no_charge' ? 'FAILED_NO_CHARGE' : 'WEBHOOK_FAILED'),
        message: rec?.message || payload?.message || 'NyStore webhook confirmed order failure',
      };
    }

    if (PENDING_INVITE_SET.has(rawStatus)) {
      return {
        status: 'pending_invite',
        orderRef,
        idempotencyKey,
        deliveredItems,
        proofFiles,
        message: rec?.message || payload?.message,
      };
    }

    if (IN_PROGRESS_SET.has(rawStatus)) {
      return {
        status: 'pending',
        orderRef,
        idempotencyKey,
        deliveredItems: [],
        proofFiles,
        message: rec?.message || payload?.message,
      };
    }

    if (DELIVERED_STATUS_SET.has(rawStatus) || deliveredItems.length > 0) {
      return {
        status: 'completed',
        orderRef,
        idempotencyKey,
        deliveredItems,
        proofFiles,
        message: rec?.message || payload?.message || 'NyStore webhook confirmed order completion',
      };
    }

    return {
      status: 'uncertain',
      orderRef,
      idempotencyKey,
      deliveredItems: [],
      proofFiles,
      errorCode: rec?.error_code || payload?.error_code || 'UNCERTAIN_WEBHOOK_STATUS',
      message: rec?.message || payload?.message || 'Unrecognized webhook event status',
    };
  }

  protected override enhancePurchaseResponse(res: SupplierOrderResponse, data: any): SupplierOrderResponse {
    const proofFiles = extractDriverProofFiles(data);
    if (proofFiles.length === 0) return res;
    const mergedItems = mergeProofFilesIntoDeliveredItems(res.delivered_items || [], proofFiles);
    if (!res.success && res.error_code === 'UNCERTAIN_MALFORMED_RESPONSE' && mergedItems.length > 0) {
      return {
        success: true,
        status: 'completed',
        order_ref: res.order_ref,
        delivered_items: mergedItems,
        proof_files: proofFiles,
        raw: data,
      };
    }
    return {
      ...res,
      delivered_items: mergedItems,
      proof_files: proofFiles,
    };
  }

  protected override enhanceLookupResult(res: SupplierOrderLookupResult, data: any): SupplierOrderLookupResult {
    const proofFiles = extractDriverProofFiles(data);
    if (proofFiles.length === 0) return res;
    const mergedItems = mergeProofFilesIntoDeliveredItems(res.delivered_items || [], proofFiles);
    return {
      ...res,
      delivered_items: mergedItems,
      proof_files: proofFiles,
    };
  }

  protected override async fallbackOrderRecovery(
    ctx: DriverContext,
    params: { supplierOrderRef?: string | null; idempotencyKey?: string | null }
  ): Promise<SupplierOrderLookupResult | null> {
    if (!params.supplierOrderRef || !params.supplierOrderRef.trim()) return null;
    try {
      const refRes = await this.doFetch(
        ctx,
        `/order/${encodeURIComponent(params.supplierOrderRef.trim())}`,
        { method: 'GET', headers: this.buildHeaders(ctx) },
        10000
      );
      if (refRes.status === 404) return null;
      const data = await refRes.json().catch(() => null);
      if (!refRes.ok || !data || typeof data !== 'object') return null;
      return this.parseLookupJsonPayload(data, refRes.status, 'GET_ORDER_BY_REF', params);
    } catch {
      return null;
    }
  }

  protected override async getExtraDiagnosticChecks(ctx: DriverContext) {
    return [
      {
        name: 'Webhook Endpoint Support',
        ok: true,
        detail: ctx.webhookSecret
          ? 'POST /api/webhooks/nystore active (NYSTORE_WEBHOOK_SECRET configured)'
          : 'POST /api/webhooks/nystore route active (NYSTORE_WEBHOOK_SECRET unset)',
      },
      {
        name: 'Proof Files Normalization',
        ok: true,
        detail: 'Proof URLs & attachments normalized into AES-256-GCM encrypted delivery',
      },
    ];
  }
}

/**
 * Live External Supplier Driver: Cuppon'sHub
 * Supports: Balance, Products (Catalog Sync), Live Inventory (stockCheck),
 * Quote, Purchase, Order Recovery, Health & Diagnostics.
 */
export class CupponsHubDriver extends BaseExternalResellerDriver {
  public readonly driverKey = 'cupponshub';
  public readonly displayName = "Cuppon'sHub";
  protected readonly envPrefix = 'CUPPONSHUB';

  public override async stockCheck(ctx: DriverContext, supplierProductId: string): Promise<DriverStockCheckResult> {
    const started = Date.now();
    const readiness = this.hasCredentialsAndEndpoint(ctx);
    if (!readiness.ready) {
      return {
        ok: false,
        inStock: false,
        stock: 0,
        isUnlimited: false,
        latencyMs: Date.now() - started,
        error: readiness.reason,
        integrated: true,
      };
    }

    const pid = String(supplierProductId);
    const probePaths = [
      `/inventory/${encodeURIComponent(pid)}`,
      `/inventory?product_id=${encodeURIComponent(pid)}`,
    ];

    for (const path of probePaths) {
      try {
        const res = await this.doFetch(ctx, path, { method: 'GET', headers: this.buildHeaders(ctx) }, 8000);
        if (res.ok) {
          const raw = await res.json().catch(() => null);
          if (raw && typeof raw === 'object' && raw.success !== false) {
            const rec = Array.isArray(raw.items)
              ? raw.items.find((x: any) => String(x?.product_id ?? x?.id ?? '') === pid) || raw
              : Array.isArray(raw.inventory)
                ? raw.inventory.find((x: any) => String(x?.product_id ?? x?.id ?? '') === pid) || raw
                : unwrapEnvelope(raw);
            const rawStock =
              rec.available_stock ?? rec.available_quantity ?? rec.stock ?? rec.stock_quantity ?? rec.quantity ?? 0;
            const stock = Number.isFinite(Number(rawStock)) ? Number(rawStock) : 0;
            const isUnlimited = Boolean(rec.is_unlimited || rec.unlimited || stock > 1000);
            const inStock =
              rec.in_stock !== undefined ? Boolean(rec.in_stock) : isUnlimited || stock > 0;
            return {
              ok: true,
              inStock,
              stock,
              isUnlimited,
              latencyMs: Date.now() - started,
              integrated: true,
            };
          }
        }
        if (res.status !== 404 && res.status !== 405 && res.status !== 501) {
          return {
            ok: false,
            inStock: false,
            stock: 0,
            isUnlimited: false,
            latencyMs: Date.now() - started,
            error: `HTTP ${res.status}`,
            integrated: true,
          };
        }
      } catch {
        // Fallback smoothly to next inventory path or quote/catalog
      }
    }

    return await super.stockCheck(ctx, supplierProductId);
  }

  protected override async fallbackOrderRecovery(
    ctx: DriverContext,
    params: { supplierOrderRef?: string | null; idempotencyKey?: string | null }
  ): Promise<SupplierOrderLookupResult | null> {
    if (!params.supplierOrderRef || !params.supplierOrderRef.trim()) return null;
    try {
      const refRes = await this.doFetch(
        ctx,
        `/order/${encodeURIComponent(params.supplierOrderRef.trim())}`,
        { method: 'GET', headers: this.buildHeaders(ctx) },
        10000
      );
      if (refRes.status === 404) return null;
      const data = await refRes.json().catch(() => null);
      if (!refRes.ok || !data || typeof data !== 'object') return null;
      return this.parseLookupJsonPayload(data, refRes.status, 'GET_ORDER_BY_REF', params);
    } catch {
      return null;
    }
  }

  protected override async getExtraDiagnosticChecks(
    ctx: DriverContext,
    firstProduct?: SupplierRawProduct
  ) {
    if (!firstProduct) {
      return [{ name: 'Inventory API Check', ok: true, detail: 'No sample SKU in catalog to probe inventory' }];
    }
    const inv = await this.stockCheck(ctx, String(firstProduct.id));
    return [
      {
        name: 'Inventory API Check',
        ok: inv.ok,
        detail: inv.ok
          ? `${firstProduct.name.slice(0, 24)}: stock=${inv.isUnlimited ? 'unlimited' : inv.stock} (inStock=${inv.inStock})`
          : inv.error || 'Inventory check failed',
      },
    ];
  }
}

/**
 * Live External Supplier Driver: ZFour
 * Supports: Balance, Products (Catalog Sync), Quote, Order (Purchase),
 * Order Tracking (Recovery across GET /orders/lookup, /orders/:ref/track, /order/:ref), Health & Diagnostics.
 */
export class ZFourDriver extends BaseExternalResellerDriver {
  public readonly driverKey = 'zfour';
  public readonly displayName = 'ZFour';
  protected readonly envPrefix = 'ZFOUR';

  protected override getRecoveryCheckTitle(): string {
    return 'Order Tracking (GET /orders/lookup & /track)';
  }

  protected override async fallbackOrderRecovery(
    ctx: DriverContext,
    params: { supplierOrderRef?: string | null; idempotencyKey?: string | null }
  ): Promise<SupplierOrderLookupResult | null> {
    const cleanRef = params.supplierOrderRef?.trim();
    if (!cleanRef) return null;

    for (const path of [
      `/orders/${encodeURIComponent(cleanRef)}/track`,
      `/order/${encodeURIComponent(cleanRef)}`,
    ]) {
      try {
        const res = await this.doFetch(
          ctx,
          path,
          { method: 'GET', headers: this.buildHeaders(ctx) },
          10000
        );
        if (res.status === 404 || res.status === 405 || res.status === 501) continue;
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || typeof data !== 'object') continue;
        return this.parseLookupJsonPayload(data, res.status, 'GET_ORDER_BY_REF', params);
      } catch {
        // try next fallback endpoint
      }
    }
    return null;
  }
}

/**
 * Standard Reseller HTTP Scaffold Driver for Upcoming Ecosystem Candidates
 * (NyStore, Cuppon'sHub, ZFour, or future APIs).
 * Safely reports scaffold status unless a live endpoint + fetchOverride/credentials are bound.
 */
export class ScaffoldSupplierDriver implements ISupplierDriver {
  public readonly isLiveImplemented = false;

  constructor(
    public readonly driverKey: string,
    public readonly displayName: string
  ) {}

  private isPlaceholderEndpoint(baseUrl: string): boolean {
    return !baseUrl || baseUrl.includes('.example') || baseUrl.includes('.invalid');
  }

  public async healthCheck(ctx: DriverContext): Promise<DriverHealthResult> {
    if (this.isPlaceholderEndpoint(ctx.baseUrl) && !ctx.fetchFn) {
      return {
        ok: false,
        apiStatus: 'Offline',
        latencyMs: 0,
        message: `${this.displayName} driver scaffold ready (API credentials not bound yet).`,
        integrated: false,
      };
    }

    const bal = await this.balanceCheck(ctx);
    return {
      ok: bal.ok,
      apiStatus: bal.ok ? 'Healthy' : 'Warning',
      latencyMs: bal.latencyMs,
      message: bal.ok ? `Connected (${bal.balanceUsdt} ${bal.currency})` : bal.error || 'Unreachable',
      integrated: bal.integrated,
    };
  }

  public async balanceCheck(ctx: DriverContext): Promise<DriverBalanceResult> {
    const started = Date.now();
    if (this.isPlaceholderEndpoint(ctx.baseUrl) && !ctx.fetchFn) {
      return {
        ok: false,
        currency: 'USDT',
        latencyMs: 0,
        error: `${this.displayName} API not integrated yet (scaffold mode).`,
        integrated: false,
      };
    }

    try {
      const fetchImpl = ctx.fetchFn || fetch;
      const res = await fetchImpl(`${ctx.baseUrl.replace(/\/+$/, '')}/balance`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
        },
      });
      const json: any = await res.json().catch(() => null);
      if (!res.ok || !json) {
        return {
          ok: false,
          currency: 'USDT',
          latencyMs: Date.now() - started,
          error: `HTTP ${res.status}`,
          integrated: true,
        };
      }
      const rawBal = json.balance ?? json.balance_usdt ?? json.data?.balance ?? 0;
      return {
        ok: true,
        balanceUsdt: new Decimal(rawBal).toFixed(4),
        currency: String(json.currency || 'USDT'),
        latencyMs: Date.now() - started,
        integrated: true,
      };
    } catch (err: any) {
      return {
        ok: false,
        currency: 'USDT',
        latencyMs: Date.now() - started,
        error: err?.message || 'NETWORK_ERROR',
        integrated: true,
      };
    }
  }

  public async catalogSync(ctx: DriverContext): Promise<DriverCatalogResult> {
    const started = Date.now();
    if (this.isPlaceholderEndpoint(ctx.baseUrl) && !ctx.fetchFn) {
      return {
        ok: false,
        products: [],
        latencyMs: 0,
        error: `${this.displayName} catalog sync awaiting live API integration.`,
        integrated: false,
      };
    }

    try {
      const fetchImpl = ctx.fetchFn || fetch;
      const res = await fetchImpl(`${ctx.baseUrl.replace(/\/+$/, '')}/products`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
        },
      });
      const json: any = await res.json().catch(() => null);
      const products: SupplierRawProduct[] = Array.isArray(json)
        ? json
        : Array.isArray(json?.products)
          ? json.products
          : Array.isArray(json?.data)
            ? json.data
            : [];
      return {
        ok: res.ok && Array.isArray(products),
        products,
        latencyMs: Date.now() - started,
        error: res.ok ? undefined : `HTTP ${res.status}`,
        integrated: true,
      };
    } catch (err: any) {
      return {
        ok: false,
        products: [],
        latencyMs: Date.now() - started,
        error: err?.message || 'NETWORK_ERROR',
        integrated: true,
      };
    }
  }

  public async priceSync(ctx: DriverContext): Promise<DriverPriceSyncResult> {
    const started = Date.now();
    const cat = await this.catalogSync(ctx);
    return {
      ok: cat.ok,
      updatedItems: cat.products.map(p => ({
        supplierProductId: String(p.id),
        costUsdt: new Decimal(p.your_cost ?? p.price_usdt ?? 0).toFixed(4),
      })),
      latencyMs: Date.now() - started,
      error: cat.error,
      integrated: cat.integrated,
    };
  }

  public async stockCheck(ctx: DriverContext, supplierProductId: string): Promise<DriverStockCheckResult> {
    const started = Date.now();
    const cat = await this.catalogSync(ctx);
    if (!cat.ok) {
      return {
        ok: false,
        inStock: false,
        stock: 0,
        isUnlimited: false,
        latencyMs: Date.now() - started,
        error: cat.error,
        integrated: cat.integrated,
      };
    }
    const found = cat.products.find(p => String(p.id) === String(supplierProductId));
    const stock = Number(found?.stock ?? found?.stock_quantity ?? 0);
    const isUnlimited = Boolean(found?.is_unlimited || stock > 1000);
    return {
      ok: true,
      inStock: Boolean(found && (isUnlimited || stock > 0)),
      stock: Number.isFinite(stock) ? stock : 0,
      isUnlimited,
      latencyMs: Date.now() - started,
      integrated: cat.integrated,
    };
  }

  public async quote(
    ctx: DriverContext,
    params: { supplierProductId: string | number; quantity: number }
  ): Promise<DriverQuoteResult> {
    const started = Date.now();
    const qty = Math.max(1, Math.floor(params.quantity || 1));
    const pid = String(params.supplierProductId);
    const cat = await this.catalogSync(ctx);
    if (!cat.ok) {
      return {
        ok: false,
        supplierProductId: pid,
        quantity: qty,
        currency: 'USDT',
        inStock: false,
        latencyMs: Date.now() - started,
        source: 'UNAVAILABLE',
        error: cat.error,
        integrated: cat.integrated,
      };
    }
    const found = cat.products.find(p => String(p.id) === pid);
    if (!found) {
      return {
        ok: false,
        supplierProductId: pid,
        quantity: qty,
        currency: 'USDT',
        inStock: false,
        latencyMs: Date.now() - started,
        source: 'LIVE_CATALOG',
        error: 'Product not listed in supplier catalog',
        integrated: cat.integrated,
      };
    }
    const unit = new Decimal(found.your_cost ?? found.price_usdt ?? 0);
    const stock = Number(found.stock ?? found.stock_quantity ?? 0);
    const isUnlimited = Boolean(found.is_unlimited || stock > 1000);
    return {
      ok: true,
      supplierProductId: pid,
      quantity: qty,
      unitCostUsdt: unit.toFixed(4),
      totalCostUsdt: unit.times(qty).toFixed(4),
      currency: 'USDT',
      inStock: isUnlimited || stock >= qty,
      availableStock: Number.isFinite(stock) ? stock : 0,
      isUnlimited,
      latencyMs: Date.now() - started,
      source: 'LIVE_CATALOG',
      integrated: cat.integrated,
    };
  }

  public async purchase(ctx: DriverContext, payload: SupplierOrderPayload): Promise<SupplierOrderResponse> {
    if (ctx.delegates && (!this.isPlaceholderEndpoint(ctx.baseUrl) || ctx.fetchFn)) {
      return await ctx.delegates.placeOrderDirect(payload, ctx.baseUrl);
    }
    return {
      success: false,
      status: 'failed',
      error_code: 'SUPPLIER_UNAVAILABLE',
      message: `${this.displayName} API driver is in scaffold mode (not yet integrated).`,
    };
  }

  public async orderRecovery(
    _ctx: DriverContext,
    _params: { supplierOrderRef?: string | null; idempotencyKey?: string | null }
  ): Promise<SupplierOrderLookupResult> {
    return {
      ok: false,
      found: false,
      httpStatus: 0,
      lookupMethod: 'NONE',
      status: 'error',
      delivered_items: [],
      error_code: 'NOT_INTEGRATED',
      message: `${this.displayName} order recovery awaiting live API binding.`,
    };
  }

  public async diagnostics(ctx: DriverContext): Promise<DriverDiagnosticsResult> {
    const health = await this.healthCheck(ctx);
    return {
      ok: health.ok,
      driverKey: this.driverKey,
      supplierId: ctx.supplierId,
      integrated: health.integrated,
      apiStatus: health.apiStatus,
      latencyMs: health.latencyMs,
      checks: [
        {
          name: 'Driver Registration',
          ok: true,
          detail: `${this.displayName} (${this.driverKey}) loaded`,
        },
        {
          name: 'Integration Readiness',
          ok: health.integrated && health.ok,
          detail: health.message,
        },
        {
          name: 'Driver Contract Methods',
          ok: true,
          detail: 'Health / Balance / Catalog / Quote / Price / Stock / Purchase / Recovery / Diagnostics ready',
        },
      ],
    };
  }
}

export class SupplierDriverRegistry {
  private drivers = new Map<string, ISupplierDriver>();

  constructor() {
    this.register(new AiToolShopDriver());
    this.register(new VenteBotDriver());
    this.register(new NyStoreDriver());
    this.register(new CupponsHubDriver());
    this.register(new ZFourDriver());
  }

  public register(driver: ISupplierDriver): void {
    this.drivers.set(driver.driverKey.toLowerCase(), driver);
  }

  public getDriver(driverKey?: string | null): ISupplierDriver {
    const clean = String(driverKey || 'aitoolshop').trim().toLowerCase();
    const existing = this.drivers.get(clean);
    if (existing) return existing;
    return new ScaffoldSupplierDriver(clean, driverKey || clean);
  }

  public listDriverKeys(): string[] {
    return Array.from(this.drivers.keys());
  }
}

export const supplierDriverRegistry = new SupplierDriverRegistry();
