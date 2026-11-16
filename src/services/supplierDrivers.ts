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
  purchase(ctx: DriverContext, payload: SupplierOrderPayload): Promise<SupplierOrderResponse>;
  orderRecovery(
    ctx: DriverContext,
    params: { supplierOrderRef?: string | null; idempotencyKey?: string | null }
  ): Promise<SupplierOrderLookupResult>;
  diagnostics(ctx: DriverContext): Promise<DriverDiagnosticsResult>;
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
 * Standard Reseller HTTP Scaffold Driver for Upcoming Ecosystem Candidates
 * (VenteBot, NyStore, Cuppon'sHub, ZFour, or future APIs).
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
    ctx: DriverContext,
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
          detail: 'Health / Balance / Catalog / Price / Stock / Purchase / Recovery / Diagnostics ready',
        },
      ],
    };
  }
}

export class SupplierDriverRegistry {
  private drivers = new Map<string, ISupplierDriver>();

  constructor() {
    this.register(new AiToolShopDriver());
    this.register(new ScaffoldSupplierDriver('ventebot', 'VenteBot'));
    this.register(new ScaffoldSupplierDriver('nystore', 'NyStore'));
    this.register(new ScaffoldSupplierDriver('cupponshub', "Cuppon'sHub"));
    this.register(new ScaffoldSupplierDriver('zfour', 'ZFour'));
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
