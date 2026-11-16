import Decimal from 'decimal.js';
import { db } from '../db/index.js';
import { redis } from './redis.js';
import { menuCache } from '../telegram/menuCache.js';
import { createLogger } from './logger.js';
import { supplierEcosystemService } from './supplierEcosystem.js';

const logger = createLogger('PricingService');

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type GlobalMarkupType = 'FIXED' | 'PERCENT' | 'AUTO';
export type SupplierPricingMode = 'FIXED' | 'PERCENT';

export interface GlobalPricingSettings {
  markupType?: GlobalMarkupType;
  defaultPercentMarkup?: string;
  defaultFixedMarkup?: string;
  minMarkupFloor?: string;
}

export interface SupplierPricingOverride {
  supplierId: string;
  supplierName: string;
  isEnabled: boolean;
  pricingMode: SupplierPricingMode | null;
  pricingMarkupValue: string | null;
}

export interface ResolvedPrice {
  supplierCost: Decimal;
  customerUnitPrice: Decimal;
  markup: Decimal;
  ruleApplied:
    | 'FIXED_RETAIL'
    | 'PRODUCT_FIXED_MARKUP'
    | 'PRODUCT_PERCENT_MARKUP'
    | 'SUPPLIER_FIXED_MARKUP'
    | 'SUPPLIER_PERCENT_MARKUP'
    | 'CATEGORY_RULE'
    | 'GLOBAL_DEFAULT'
    | 'COST_FLOOR';
  effectiveSupplierId?: string;
}

export interface ProductCatalogItem {
  id: string;
  supplierProductId: string;
  name: string;
  description: string;
  category: {
    id: string;
    slug: string;
    name: string;
  };
  supplierCost: string; // USDT (Admin-only, never sent to customers)
  sellingPrice: string; // USDT
  markup: string;
  pricingRule: string;
  effectiveSupplierId?: string;
  stock: number;
  isUnlimited: boolean;
  requiresEmail: boolean;
  supplierType: string;
  duration: string;
  warrantySummary: string;
  isAvailable: boolean;
  isFeatured: boolean;
  isHidden: boolean;
  hasActiveSupplier?: boolean;
}

export interface ProfitAnalyticsProductMetric {
  productId: string;
  name: string;
  ordersCount: number;
  unitsSold: number;
  revenue: string;
  profit: string;
}

export interface ProfitAnalyticsSupplierMetric {
  supplierId: string;
  supplierName: string;
  ordersCount: number;
  revenue: string;
  profit: string;
}

export interface ProfitAnalyticsReport {
  todayRevenue: string;
  todayProfit: string;
  todayOrders: number;
  monthlyRevenue: string;
  monthlyProfit: string;
  monthlyOrders: number;
  allTimeRevenue: string;
  allTimeProfit: string;
  allTimeOrders: number;
  topProduct: ProfitAnalyticsProductMetric | null;
  topSupplier: ProfitAnalyticsSupplierMetric | null;
  mostProfitableProduct: ProfitAnalyticsProductMetric | null;
}

export class PricingService {
  private readonly globalRuleCacheKey = 'pricing:global_rule';
  private readonly supplierOverridesCacheKey = 'pricing:sup_overrides';
  private readonly prodSupplierMapCacheKey = 'pricing:prod_sup_map';
  private readonly categoryCountsCacheKey = 'cat_counts';
  private readonly catalogVersionKey = 'catalog:ver';

  /**
   * Authoritative 3-Layer Pricing Hierarchy (plus Cost Floor protection):
   *   1. Product Override (FIXED_RETAIL > PRODUCT_FIXED_MARKUP > PRODUCT_PERCENT_MARKUP)
   *   2. Supplier Override (SUPPLIER_FIXED_MARKUP | SUPPLIER_PERCENT_MARKUP)
   *   3. Global Pricing (FIXED | PERCENT | AUTO max floor -> GLOBAL_DEFAULT)
   *   4. Cost Floor (Never sell below supplier cost)
   *   5. Round half-up to 2 decimal places
   */
  private resolvePriceSync(
    latestCost: string | number | null | undefined,
    fixedRetailPrice: string | number | null | undefined,
    fixedMarkup: string | number | null | undefined,
    percentMarkup: string | number | null | undefined,
    supplierOverride: SupplierPricingOverride | null | undefined,
    globalSettings: GlobalPricingSettings,
    effectiveSupplierId?: string
  ): ResolvedPrice {
    const cost = new Decimal(latestCost || '0.0000');
    let finalPrice: Decimal;
    let ruleApplied: ResolvedPrice['ruleApplied'];

    if (fixedRetailPrice !== null && fixedRetailPrice !== undefined) {
      const fixedPrice = new Decimal(fixedRetailPrice);
      if (fixedPrice.greaterThan(0)) {
        finalPrice = fixedPrice;
        ruleApplied = 'FIXED_RETAIL';
      } else {
        finalPrice = cost;
        ruleApplied = 'COST_FLOOR';
      }
    } else if (fixedMarkup !== null && fixedMarkup !== undefined) {
      finalPrice = cost.plus(new Decimal(fixedMarkup));
      ruleApplied = 'PRODUCT_FIXED_MARKUP';
    } else if (percentMarkup !== null && percentMarkup !== undefined) {
      const pct = new Decimal(percentMarkup);
      finalPrice = cost.times(new Decimal(1).plus(pct));
      ruleApplied = 'PRODUCT_PERCENT_MARKUP';
    } else if (
      supplierOverride &&
      supplierOverride.pricingMode &&
      supplierOverride.pricingMarkupValue !== null &&
      supplierOverride.pricingMarkupValue !== undefined
    ) {
      const supVal = new Decimal(supplierOverride.pricingMarkupValue);
      if (supplierOverride.pricingMode === 'FIXED') {
        finalPrice = cost.plus(supVal);
        ruleApplied = 'SUPPLIER_FIXED_MARKUP';
      } else {
        finalPrice = cost.times(new Decimal(1).plus(supVal));
        ruleApplied = 'SUPPLIER_PERCENT_MARKUP';
      }
    } else {
      const mode: GlobalMarkupType = globalSettings.markupType || 'AUTO';
      const defaultPct = new Decimal(globalSettings.defaultPercentMarkup || '0.15');
      const defaultFixed = new Decimal(globalSettings.defaultFixedMarkup || '0.05');

      if (mode === 'FIXED') {
        finalPrice = cost.plus(defaultFixed);
      } else if (mode === 'PERCENT') {
        finalPrice = cost.times(new Decimal(1).plus(defaultPct));
      } else {
        const markupFromPct = cost.times(defaultPct);
        const effectiveMarkup = Decimal.max(markupFromPct, defaultFixed);
        finalPrice = cost.plus(effectiveMarkup);
      }
      ruleApplied = 'GLOBAL_DEFAULT';
    }

    if (finalPrice.lessThan(cost)) {
      finalPrice = cost;
      ruleApplied = 'COST_FLOOR';
    }

    finalPrice = finalPrice.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const markup = finalPrice.minus(cost).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

    return {
      supplierCost: cost,
      customerUnitPrice: finalPrice,
      markup,
      ruleApplied,
      effectiveSupplierId,
    };
  }

  private async getCatalogVersion(): Promise<string> {
    try {
      const v = await redis.getHot(this.catalogVersionKey, 4000);
      if (v) return v;
      const init = String(Date.now());
      await redis.set(this.catalogVersionKey, init, 3600);
      return init;
    } catch {
      return '1';
    }
  }

  public async getGlobalPricingSettings(): Promise<GlobalPricingSettings> {
    try {
      const cached = await redis.getHot(this.globalRuleCacheKey, 4000);
      if (cached) return JSON.parse(cached);
    } catch {
      // Cache miss
    }

    const settingsRow = await db.queryRow<any>("SELECT value FROM system_settings WHERE key = 'pricing_global_rules'");
    const val = typeof settingsRow?.value === 'string' ? JSON.parse(settingsRow.value) : settingsRow?.value || {};
    await redis.set(this.globalRuleCacheKey, JSON.stringify(val), 60).catch(() => {});
    return val;
  }

  public async setGlobalPricingRule(
    patch: Partial<GlobalPricingSettings>,
    adminId: string
  ): Promise<GlobalPricingSettings> {
    const curr = await this.getGlobalPricingSettings();
    const next: GlobalPricingSettings = { ...curr };

    if (patch.markupType && ['FIXED', 'PERCENT', 'AUTO'].includes(patch.markupType)) {
      next.markupType = patch.markupType;
    }
    if (patch.defaultFixedMarkup !== undefined) {
      const d = new Decimal(patch.defaultFixedMarkup);
      if (d.isNaN() || d.lessThan(0)) throw new Error('Fixed markup must be >= 0 USDT.');
      next.defaultFixedMarkup = d.toFixed(4);
    }
    if (patch.defaultPercentMarkup !== undefined) {
      const d = new Decimal(patch.defaultPercentMarkup);
      if (d.isNaN() || d.lessThan(0) || d.greaterThan(5)) {
        throw new Error('Percentage markup must be between 0% and 500%.');
      }
      next.defaultPercentMarkup = d.toFixed(4);
    }
    if (patch.minMarkupFloor !== undefined) {
      const d = new Decimal(patch.minMarkupFloor);
      if (d.isNaN() || d.lessThan(0)) throw new Error('Minimum floor must be >= 0 USDT.');
      next.minMarkupFloor = d.toFixed(4);
    }

    await db.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('pricing_global_rules', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify(next)]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'UPDATE_GLOBAL_PRICING', 'system_settings', 'pricing_global_rules', $3)`,
      [`log_glp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`, adminId, JSON.stringify(next)]
    );

    await this.invalidateCatalogCaches();
    logger.info('Admin updated global pricing rules', { adminId, next });
    return next;
  }

  public async listSupplierPricingOverrides(): Promise<SupplierPricingOverride[]> {
    try {
      const cached = await redis.getHot(this.supplierOverridesCacheKey, 4000);
      if (cached) return JSON.parse(cached) as SupplierPricingOverride[];
    } catch {
      // Cache miss
    }

    const res = await db.query<any>(
      `SELECT id as "supplierId", name as "supplierName", is_enabled as "isEnabled",
              pricing_mode as "pricingMode", pricing_markup_value as "pricingMarkupValue"
       FROM suppliers
       ORDER BY priority ASC, id ASC`
    );

    const list: SupplierPricingOverride[] = res.rows.map(r => ({
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      isEnabled: Boolean(r.isEnabled),
      pricingMode: r.pricingMode === 'FIXED' || r.pricingMode === 'PERCENT' ? r.pricingMode : null,
      pricingMarkupValue: r.pricingMarkupValue !== null && r.pricingMarkupValue !== undefined ? String(r.pricingMarkupValue) : null,
    }));

    await redis.set(this.supplierOverridesCacheKey, JSON.stringify(list), 60).catch(() => {});
    return list;
  }

  private async getSupplierOverridesById(): Promise<Map<string, SupplierPricingOverride>> {
    const list = await this.listSupplierPricingOverrides();
    return new Map(list.map(item => [item.supplierId, item]));
  }

  public async setSupplierPricingOverride(
    supplierId: string,
    mode: SupplierPricingMode,
    value: Decimal | number | string,
    adminId: string
  ): Promise<void> {
    const existing = await db.queryRow<{ id: string }>('SELECT id FROM suppliers WHERE id = $1', [supplierId]);
    if (!existing) throw new Error(`Supplier not found: ${supplierId}`);

    const valDec = new Decimal(value);
    if (valDec.isNaN() || valDec.lessThan(0)) {
      throw new Error('Supplier markup must be a non-negative number.');
    }
    if (mode === 'PERCENT' && valDec.greaterThan(5)) {
      throw new Error('Supplier percentage markup must not exceed 500%.');
    }

    await db.query(
      `UPDATE suppliers
       SET pricing_mode = $2,
           pricing_markup_value = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [supplierId, mode, valDec.toFixed(4)]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'SET_SUPPLIER_PRICING', 'supplier', $3, $4)`,
      [
        `log_sp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        adminId,
        supplierId,
        JSON.stringify({ mode, value: valDec.toFixed(4) }),
      ]
    );

    await this.invalidateCatalogCaches();
    logger.info('Admin updated supplier pricing override', { supplierId, mode, value: valDec.toFixed(4), adminId });
  }

  public async clearSupplierPricingOverride(supplierId: string, adminId: string): Promise<void> {
    await db.query(
      `UPDATE suppliers
       SET pricing_mode = NULL,
           pricing_markup_value = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [supplierId]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'CLEAR_SUPPLIER_PRICING', 'supplier', $3, '{}')`,
      [`log_sp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`, adminId, supplierId]
    );

    await this.invalidateCatalogCaches();
    logger.info('Admin cleared supplier pricing override (now inherits Global)', { supplierId, adminId });
  }

  private async getProductEffectiveSupplierMap(): Promise<Record<string, string>> {
    try {
      const cached = await redis.getHot(this.prodSupplierMapCacheKey, 4000);
      if (cached) return JSON.parse(cached) as Record<string, string>;
    } catch {
      // Cache miss
    }

    const res = await db.query<{
      productId: string;
      supplierId: string;
      slotRank: number;
      supplierEnabled: boolean | null;
    }>(
      `SELECT psm.master_product_id as "productId",
              psm.supplier_id as "supplierId",
              psm.slot_rank as "slotRank",
              s.is_enabled as "supplierEnabled"
       FROM product_supplier_mappings psm
       LEFT JOIN suppliers s ON psm.supplier_id = s.id
       WHERE psm.is_active = TRUE
       ORDER BY psm.master_product_id ASC, psm.slot_rank ASC`
    );

    const grouped = new Map<string, Array<{ supplierId: string; enabled: boolean }>>();
    for (const r of res.rows) {
      if (!grouped.has(r.productId)) grouped.set(r.productId, []);
      grouped.get(r.productId)!.push({
        supplierId: r.supplierId,
        enabled: r.supplierEnabled !== false,
      });
    }

    const map: Record<string, string> = {};
    for (const [prodId, slots] of grouped.entries()) {
      const firstEnabled = slots.find(s => s.enabled);
      map[prodId] = firstEnabled ? firstEnabled.supplierId : slots[0].supplierId;
    }

    await redis.set(this.prodSupplierMapCacheKey, JSON.stringify(map), 60).catch(() => {});
    return map;
  }

  public async invalidateCategoryCache(): Promise<void> {
    menuCache.invalidateAll();
    await Promise.all([
      redis.del('cat:list:vis').catch(() => {}),
      redis.del('cat:list:all').catch(() => {}),
      redis.del(this.categoryCountsCacheKey).catch(() => {}),
    ]);
  }

  public async invalidateCatalogCaches(productId?: string): Promise<void> {
    menuCache.invalidateAll();
    const nextVer = String(Date.now());
    await Promise.all([
      productId ? redis.del(`price:${productId}`).catch(() => {}) : Promise.resolve(),
      redis.del(this.globalRuleCacheKey).catch(() => {}),
      redis.del(this.supplierOverridesCacheKey).catch(() => {}),
      redis.del(this.prodSupplierMapCacheKey).catch(() => {}),
      redis.del(this.categoryCountsCacheKey).catch(() => {}),
      redis.del('cat:list:vis').catch(() => {}),
      redis.del('cat:list:all').catch(() => {}),
      redis.set(this.catalogVersionKey, nextVer, 3600).catch(() => {}),
    ]);
  }

  /**
   * Cached product categories list (60s TTL in Redis)
   */
  public async getCategories(visibleOnly = true): Promise<Array<{ id: string; slug: string; name: string; isVisible: boolean }>> {
    const cacheKey = visibleOnly ? 'cat:list:vis' : 'cat:list:all';
    try {
      const cached = await redis.getHot(cacheKey, 4000);
      if (cached) return JSON.parse(cached);
    } catch {
      // Cache miss
    }

    const where = visibleOnly ? 'WHERE is_visible = TRUE' : '';
    const res = await db.query<any>(
      `SELECT id, slug, name, is_visible as "isVisible" FROM product_categories ${where} ORDER BY display_order ASC`
    );
    const list = res.rows.map(r => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      isVisible: Boolean(r.isVisible),
    }));
    await redis.set(cacheKey, JSON.stringify(list), 60).catch(() => {});
    return list;
  }

  /**
   * Single-query category & total active product counts (cached 60s in Redis).
   */
  public async getCategoryProductCounts(): Promise<{ counts: Record<string, number>; totalActive: number }> {
    try {
      const cached = await redis.getHot(this.categoryCountsCacheKey, 4000);
      if (cached) return JSON.parse(cached);
    } catch {
      // Cache miss
    }

    const res = await db.query<{ categoryId: string; cnt: string }>(`
      SELECT COALESCE(po.category_id, 'cat_ai-tools') as "categoryId",
             COUNT(*) as cnt
      FROM supplier_products sp
      LEFT JOIN product_overrides po ON sp.id = po.product_id
      WHERE (po.is_hidden IS NULL OR po.is_hidden = FALSE)
        AND (sp.is_unlimited = TRUE OR sp.latest_stock > 0)
        AND sp.is_available = TRUE
      GROUP BY COALESCE(po.category_id, 'cat_ai-tools')
    `);

    const counts: Record<string, number> = {};
    let totalActive = 0;
    for (const r of res.rows) {
      const n = parseInt(r.cnt || '0', 10);
      counts[r.categoryId] = n;
      totalActive += n;
    }

    const payload = { counts, totalActive };
    await redis.set(this.categoryCountsCacheKey, JSON.stringify(payload), 60).catch(() => {});
    return payload;
  }

  /**
   * Calculate effective retail price following strict 3-layer pricing hierarchy + cost floor.
   */
  public async calculatePrice(productId: string): Promise<ResolvedPrice> {
    const ver = await this.getCatalogVersion();
    const cacheKey = `price:${productId}:v${ver}`;
    const cached = await redis.getHot(cacheKey, 4000);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return {
          supplierCost: new Decimal(parsed.supplierCost),
          customerUnitPrice: new Decimal(parsed.customerUnitPrice),
          markup: new Decimal(parsed.markup),
          ruleApplied: parsed.ruleApplied,
          effectiveSupplierId: parsed.effectiveSupplierId,
        };
      } catch {
        // Cache miss
      }
    }

    const [row, globalSettings, supOverridesMap, prodSupMap] = await Promise.all([
      db.queryRow<any>(
        `SELECT sp.id, sp.supplier, sp.latest_cost as "latestCost",
                po.fixed_retail_price as "fixedRetailPrice",
                po.fixed_markup as "fixedMarkup",
                po.percent_markup as "percentMarkup",
                po.category_id as "categoryId"
         FROM supplier_products sp
         LEFT JOIN product_overrides po ON sp.id = po.product_id
         WHERE sp.id = $1`,
        [productId]
      ),
      this.getGlobalPricingSettings(),
      this.getSupplierOverridesById(),
      this.getProductEffectiveSupplierMap(),
    ]);

    if (!row) {
      throw new Error(`Product not found: ${productId}`);
    }

    const effectiveSupplierId = prodSupMap[productId] || row.supplier || 'aitoolshop';
    const supOverride = supOverridesMap.get(effectiveSupplierId) || null;
    const result = this.resolvePriceSync(
      row.latestCost,
      row.fixedRetailPrice,
      row.fixedMarkup,
      row.percentMarkup,
      supOverride,
      globalSettings,
      effectiveSupplierId
    );

    await redis.set(
      cacheKey,
      JSON.stringify({
        supplierCost: result.supplierCost.toFixed(4),
        customerUnitPrice: result.customerUnitPrice.toFixed(2),
        markup: result.markup.toFixed(4),
        ruleApplied: result.ruleApplied,
        effectiveSupplierId,
      }),
      60
    ).catch(() => {});

    return result;
  }

  /**
   * Set per-product fixed retail price.
   */
  public async setFixedRetailPrice(productId: string, price: Decimal | number | string, adminId: string): Promise<void> {
    const priceDec = new Decimal(price);
    await db.query(
      `INSERT INTO product_overrides (product_id, fixed_retail_price, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (product_id) DO UPDATE SET
         fixed_retail_price = $2,
         fixed_markup = NULL,
         percent_markup = NULL,
         updated_at = CURRENT_TIMESTAMP`,
      [productId, priceDec.toFixed(4)]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'SET_FIXED_PRICE', 'product', $3, $4)`,
      [`log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, adminId, productId, JSON.stringify({ price: priceDec.toFixed(4) })]
    );

    await this.invalidateCatalogCaches(productId);
    logger.info('Admin updated fixed retail price', { productId, price: priceDec.toFixed(4), adminId });
  }

  /**
   * Set per-product fixed markup (e.g. 0.05 USDT).
   */
  public async setFixedMarkup(productId: string, markup: Decimal | number | string, adminId: string): Promise<void> {
    const markupDec = new Decimal(markup);
    await db.query(
      `INSERT INTO product_overrides (product_id, fixed_markup, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (product_id) DO UPDATE SET
         fixed_markup = $2,
         fixed_retail_price = NULL,
         percent_markup = NULL,
         updated_at = CURRENT_TIMESTAMP`,
      [productId, markupDec.toFixed(4)]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'SET_FIXED_MARKUP', 'product', $3, $4)`,
      [`log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, adminId, productId, JSON.stringify({ markup: markupDec.toFixed(4) })]
    );

    await this.invalidateCatalogCaches(productId);
    logger.info('Admin updated fixed markup', { productId, markup: markupDec.toFixed(4), adminId });
  }

  /**
   * Set per-product percentage markup as decimal fraction (e.g. '0.20' for +20%).
   */
  public async setPercentMarkup(productId: string, percentFraction: Decimal | number | string, adminId: string): Promise<void> {
    const pctDec = new Decimal(percentFraction);
    if (pctDec.isNaN() || pctDec.lessThan(0) || pctDec.greaterThan(5)) {
      throw new Error('Percentage markup must be between 0% and 500%.');
    }

    await db.query(
      `INSERT INTO product_overrides (product_id, percent_markup, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (product_id) DO UPDATE SET
         percent_markup = $2,
         fixed_retail_price = NULL,
         fixed_markup = NULL,
         updated_at = CURRENT_TIMESTAMP`,
      [productId, pctDec.toFixed(4)]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'SET_PERCENT_MARKUP', 'product', $3, $4)`,
      [`log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, adminId, productId, JSON.stringify({ percentMarkup: pctDec.toFixed(4) })]
    );

    await this.invalidateCatalogCaches(productId);
    logger.info('Admin updated percentage markup', { productId, percentMarkup: pctDec.toFixed(4), adminId });
  }

  /**
   * Reset product pricing override (falls back to Supplier Override -> Global Pricing).
   */
  public async resetPricing(productId: string, adminId: string): Promise<void> {
    await db.query(
      `UPDATE product_overrides
       SET fixed_retail_price = NULL,
           fixed_markup = NULL,
           percent_markup = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE product_id = $1`,
      [productId]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'RESET_PRICING', 'product', $3, '{}')`,
      [`log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, adminId, productId]
    );

    await this.invalidateCatalogCaches(productId);
    logger.info('Admin reset product pricing override', { productId, adminId });
  }

  /**
   * Fetch a single product with resolved retail pricing (Redis-cached 60s by catalog version).
   */
  public async getCatalogItemById(productId: string): Promise<ProductCatalogItem | null> {
    const ver = await this.getCatalogVersion();
    const itemCacheKey = `catalog:item:v${ver}:${productId}`;
    try {
      const cached = await redis.getHot(itemCacheKey, 4000);
      if (cached) return JSON.parse(cached) as ProductCatalogItem;
    } catch {
      // Cache miss
    }

    const [row, globalSettings, supOverridesMap, prodSupMap, blockedIds] = await Promise.all([
      db.queryRow<any>(
        `SELECT sp.id, sp.supplier, sp.supplier_product_id as "supplierProductId",
                sp.original_name as "originalName",
                sp.original_description as "originalDescription",
                sp.latest_cost as "latestCost",
                sp.latest_stock as "latestStock",
                sp.is_unlimited as "isUnlimited",
                sp.requires_email as "requiresEmail",
                sp.supplier_type as "supplierType",
                sp.duration, sp.warranty_summary as "warrantySummary",
                sp.is_available as "isAvailable",
                po.fixed_retail_price as "fixedRetailPrice",
                po.fixed_markup as "fixedMarkup",
                po.percent_markup as "percentMarkup",
                po.display_name_override as "displayNameOverride",
                po.description_override as "descriptionOverride",
                po.is_hidden as "isHidden",
                po.is_featured as "isFeatured",
                pc.id as "catId", pc.slug as "catSlug", pc.name as "catName"
         FROM supplier_products sp
         LEFT JOIN product_overrides po ON sp.id = po.product_id
         LEFT JOIN product_categories pc ON po.category_id = pc.id
         WHERE sp.id = $1`,
        [productId]
      ),
      this.getGlobalPricingSettings(),
      this.getSupplierOverridesById(),
      this.getProductEffectiveSupplierMap(),
      supplierEcosystemService.getDisabledExclusiveProductIds().catch(() => new Set<string>()),
    ]);
    if (!row) return null;

    const effectiveSupplierId = prodSupMap[row.id] || row.supplier || 'aitoolshop';
    const supOverride = supOverridesMap.get(effectiveSupplierId) || null;
    const priceCalc = this.resolvePriceSync(
      row.latestCost,
      row.fixedRetailPrice,
      row.fixedMarkup,
      row.percentMarkup,
      supOverride,
      globalSettings,
      effectiveSupplierId
    );

    const item: ProductCatalogItem = {
      id: row.id,
      supplierProductId: row.supplierProductId,
      name: row.displayNameOverride || row.originalName,
      description: row.descriptionOverride || row.originalDescription || '',
      category: {
        id: row.catId || 'cat_ai-tools',
        slug: row.catSlug || 'ai-tools',
        name: row.catName || 'AI Tools',
      },
      supplierCost: priceCalc.supplierCost.toFixed(4),
      sellingPrice: priceCalc.customerUnitPrice.toFixed(2),
      markup: priceCalc.markup.toFixed(4),
      pricingRule: priceCalc.ruleApplied,
      effectiveSupplierId,
      stock: row.latestStock || 0,
      isUnlimited: Boolean(row.isUnlimited),
      requiresEmail: Boolean(row.requiresEmail),
      supplierType: row.supplierType || 'account',
      duration: row.duration || '1 Month',
      warrantySummary: row.warrantySummary || 'Full duration warranty',
      isAvailable: Boolean(row.isAvailable),
      isFeatured: Boolean(row.isFeatured),
      isHidden: Boolean(row.isHidden),
      hasActiveSupplier: !blockedIds.has(row.id),
    };
    await redis.set(itemCacheKey, JSON.stringify(item), 60).catch(() => {});
    return item;
  }

  /**
   * Fetch ordered active product IDs for a category or 'all' (Redis-cached 60s by catalog version).
   */
  public async getOrderedCatalogIds(catId = 'all'): Promise<string[]> {
    const ver = await this.getCatalogVersion();
    const key = `catalog:ids:v${ver}:${catId || 'all'}`;
    try {
      const cached = await redis.getHot(key, 4000);
      if (cached) return JSON.parse(cached) as string[];
    } catch {
      // Cache miss
    }

    const isAll = !catId || catId === 'all';
    let whereClause = `WHERE (po.is_hidden IS NULL OR po.is_hidden = FALSE)
      AND (sp.is_unlimited = TRUE OR sp.latest_stock > 0)
      AND sp.is_available = TRUE`;
    const queryParams: any[] = [];
    if (!isAll) {
      whereClause += ` AND po.category_id = $1`;
      queryParams.push(catId);
    }

    const [res, blockedIds] = await Promise.all([
      db.query<{ id: string }>(
        `SELECT sp.id
         FROM supplier_products sp
         LEFT JOIN product_overrides po ON sp.id = po.product_id
         ${whereClause}
         ORDER BY po.is_featured DESC NULLS LAST, sp.original_name ASC`,
        queryParams
      ),
      supplierEcosystemService.getDisabledExclusiveProductIds().catch(() => new Set<string>()),
    ]);
    const ids = res.rows.map(r => r.id).filter(id => !blockedIds.has(id));
    await redis.set(key, JSON.stringify(ids), 60).catch(() => {});
    return ids;
  }

  /**
   * Get all active catalogue products for customer view (Redis-cached for category & featured pages).
   */
  public async getCatalog(params: {
    categoryId?: string;
    search?: string;
    featuredOnly?: boolean;
    includeHidden?: boolean;
    page?: number;
    pageSize?: number;
  } = {}): Promise<{ items: ProductCatalogItem[]; total: number }> {
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(250, Math.max(1, params.pageSize || 10));
    const offset = (page - 1) * pageSize;

    const cacheable = !params.search;
    let catalogCacheKey = '';
    if (cacheable) {
      const ver = await this.getCatalogVersion();
      catalogCacheKey = `catalog:p:v${ver}:${params.categoryId || 'all'}:${Boolean(params.featuredOnly)}:${Boolean(params.includeHidden)}:${page}:${pageSize}`;
      try {
        const cached = await redis.getHot(catalogCacheKey, 4000);
        if (cached) return JSON.parse(cached) as { items: ProductCatalogItem[]; total: number };
      } catch {
        // Cache miss
      }
    }

    let whereClause = 'WHERE 1=1';
    const queryParams: any[] = [];
    let paramIndex = 1;
    let blockedIds = new Set<string>();

    if (!params.includeHidden) {
      whereClause += ` AND (po.is_hidden IS NULL OR po.is_hidden = FALSE)`;
      whereClause += ` AND (sp.is_unlimited = TRUE OR sp.latest_stock > 0)`;
      whereClause += ` AND sp.is_available = TRUE`;
      blockedIds = await supplierEcosystemService.getDisabledExclusiveProductIds().catch(() => new Set<string>());
    }

    if (params.categoryId) {
      whereClause += ` AND po.category_id = $${paramIndex++}`;
      queryParams.push(params.categoryId);
    }

    if (params.featuredOnly) {
      whereClause += ` AND po.is_featured = TRUE`;
    }

    if (params.search) {
      whereClause += ` AND (
        sp.original_name ILIKE $${paramIndex} OR
        po.display_name_override ILIKE $${paramIndex} OR
        sp.original_description ILIKE $${paramIndex}
      )`;
      queryParams.push(`%${params.search}%`);
      paramIndex++;
    }

    const baseItemsSelect = `
      SELECT sp.id, sp.supplier, sp.supplier_product_id as "supplierProductId",
             sp.original_name as "originalName",
             sp.original_description as "originalDescription",
             sp.latest_cost as "latestCost",
             sp.latest_stock as "latestStock",
             sp.is_unlimited as "isUnlimited",
             sp.requires_email as "requiresEmail",
             sp.supplier_type as "supplierType",
             sp.duration, sp.warranty_summary as "warrantySummary",
             sp.is_available as "isAvailable",
             po.fixed_retail_price as "fixedRetailPrice",
             po.fixed_markup as "fixedMarkup",
             po.percent_markup as "percentMarkup",
             po.display_name_override as "displayNameOverride",
             po.description_override as "descriptionOverride",
             po.is_hidden as "isHidden",
             po.is_featured as "isFeatured",
             pc.id as "catId", pc.slug as "catSlug", pc.name as "catName"
      FROM supplier_products sp
      LEFT JOIN product_overrides po ON sp.id = po.product_id
      LEFT JOIN product_categories pc ON po.category_id = pc.id
      ${whereClause}
      ORDER BY po.is_featured DESC NULLS LAST, sp.original_name ASC
    `;

    let total = 0;
    let rawRows: any[] = [];
    let globalSettings: GlobalPricingSettings;
    let supOverridesMap: Map<string, SupplierPricingOverride>;
    let prodSupMap: Record<string, string>;

    if (blockedIds.size === 0) {
      const countParams = [...queryParams];
      const itemParams = [...queryParams, pageSize, offset];

      const countSql = `
        SELECT COUNT(*) as count
        FROM supplier_products sp
        LEFT JOIN product_overrides po ON sp.id = po.product_id
        ${whereClause}
      `;
      const itemsSql = `${baseItemsSelect} LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;

      const [countRes, rowsRes, settings, supMap, pSupMap] = await Promise.all([
        db.queryRow<{ count: string }>(countSql, countParams),
        db.query<any>(itemsSql, itemParams),
        this.getGlobalPricingSettings(),
        this.getSupplierOverridesById(),
        this.getProductEffectiveSupplierMap(),
      ]);
      total = parseInt(countRes?.count || '0', 10);
      rawRows = rowsRes.rows;
      globalSettings = settings;
      supOverridesMap = supMap;
      prodSupMap = pSupMap;
    } else {
      const [rowsRes, settings, supMap, pSupMap] = await Promise.all([
        db.query<any>(baseItemsSelect, queryParams),
        this.getGlobalPricingSettings(),
        this.getSupplierOverridesById(),
        this.getProductEffectiveSupplierMap(),
      ]);
      const filtered = rowsRes.rows.filter(r => !blockedIds.has(r.id));
      total = filtered.length;
      rawRows = filtered.slice(offset, offset + pageSize);
      globalSettings = settings;
      supOverridesMap = supMap;
      prodSupMap = pSupMap;
    }

    const items: ProductCatalogItem[] = rawRows.map(r => {
      const effectiveSupplierId = prodSupMap[r.id] || r.supplier || 'aitoolshop';
      const supOverride = supOverridesMap.get(effectiveSupplierId) || null;
      const priceCalc = this.resolvePriceSync(
        r.latestCost,
        r.fixedRetailPrice,
        r.fixedMarkup,
        r.percentMarkup,
        supOverride,
        globalSettings,
        effectiveSupplierId
      );
      return {
        id: r.id,
        supplierProductId: r.supplierProductId,
        name: r.displayNameOverride || r.originalName,
        description: r.descriptionOverride || r.originalDescription || '',
        category: {
          id: r.catId || 'cat_ai-tools',
          slug: r.catSlug || 'ai-tools',
          name: r.catName || 'AI Tools',
        },
        supplierCost: priceCalc.supplierCost.toFixed(4),
        sellingPrice: priceCalc.customerUnitPrice.toFixed(2),
        markup: priceCalc.markup.toFixed(4),
        pricingRule: priceCalc.ruleApplied,
        effectiveSupplierId,
        stock: r.latestStock || 0,
        isUnlimited: Boolean(r.isUnlimited),
        requiresEmail: Boolean(r.requiresEmail),
        supplierType: r.supplierType || 'account',
        duration: r.duration || '1 Month',
        warrantySummary: r.warrantySummary || 'Full duration warranty',
        isAvailable: Boolean(r.isAvailable),
        isFeatured: Boolean(r.isFeatured),
        isHidden: Boolean(r.isHidden),
        hasActiveSupplier: !blockedIds.has(r.id),
      };
    });

    const payload = { items, total };
    if (cacheable && catalogCacheKey) {
      await redis.set(catalogCacheKey, JSON.stringify(payload), 60).catch(() => {});
    }
    return payload;
  }

  /**
   * Compute Admin-only Profit & Revenue Analytics across fulfilled customer orders.
   * Excludes FAILED, REFUNDED, CANCELLED, and UNCERTAIN orders.
   */
  public async getProfitAnalytics(): Promise<ProfitAnalyticsReport> {
    const [ordersRes, suppliersRes] = await Promise.all([
      db.query<{
        id: string;
        productId: string;
        quantity: number;
        totalPrice: string;
        supplierCost: string;
        createdAt: string;
        defaultSupplier: string | null;
        originalName: string | null;
        displayName: string | null;
        fulfilledSupplierId: string | null;
      }>(
        `SELECT lo.id,
                lo.product_id as "productId",
                lo.quantity,
                lo.total_price as "totalPrice",
                lo.supplier_cost as "supplierCost",
                lo.created_at as "createdAt",
                sp.supplier as "defaultSupplier",
                sp.original_name as "originalName",
                po.display_name_override as "displayName",
                so.fulfilled_supplier_id as "fulfilledSupplierId"
         FROM local_orders lo
         LEFT JOIN supplier_products sp ON lo.product_id = sp.id
         LEFT JOIN product_overrides po ON lo.product_id = po.product_id
         LEFT JOIN supplier_orders so ON lo.id = so.local_order_id
         WHERE lo.status IN ('COMPLETED', 'PENDING_INVITE')`
      ),
      db.query<{ id: string; name: string }>('SELECT id, name FROM suppliers'),
    ]);

    const supplierNames = new Map<string, string>(suppliersRes.rows.map(s => [s.id, s.name]));

    const now = new Date();
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

    let todayRevenue = new Decimal(0);
    let todayProfit = new Decimal(0);
    let todayOrders = 0;

    let monthlyRevenue = new Decimal(0);
    let monthlyProfit = new Decimal(0);
    let monthlyOrders = 0;

    let allTimeRevenue = new Decimal(0);
    let allTimeProfit = new Decimal(0);
    let allTimeOrders = 0;

    const productAgg = new Map<
      string,
      { productId: string; name: string; ordersCount: number; unitsSold: number; revenue: Decimal; profit: Decimal }
    >();
    const supplierAgg = new Map<
      string,
      { supplierId: string; supplierName: string; ordersCount: number; revenue: Decimal; profit: Decimal }
    >();

    for (const row of ordersRes.rows) {
      const rev = new Decimal(row.totalPrice || '0');
      const cost = new Decimal(row.supplierCost || '0');
      const profit = rev.minus(cost);
      const qty = Math.max(1, Number(row.quantity || 1));
      const ts = row.createdAt ? new Date(row.createdAt).getTime() : now.getTime();

      allTimeRevenue = allTimeRevenue.plus(rev);
      allTimeProfit = allTimeProfit.plus(profit);
      allTimeOrders++;

      if (!Number.isNaN(ts) && ts >= monthStart) {
        monthlyRevenue = monthlyRevenue.plus(rev);
        monthlyProfit = monthlyProfit.plus(profit);
        monthlyOrders++;
      }

      if (!Number.isNaN(ts) && ts >= todayStart) {
        todayRevenue = todayRevenue.plus(rev);
        todayProfit = todayProfit.plus(profit);
        todayOrders++;
      }

      const prodName = String(row.displayName || row.originalName || row.productId);
      const pEntry = productAgg.get(row.productId) || {
        productId: row.productId,
        name: prodName,
        ordersCount: 0,
        unitsSold: 0,
        revenue: new Decimal(0),
        profit: new Decimal(0),
      };
      pEntry.ordersCount += 1;
      pEntry.unitsSold += qty;
      pEntry.revenue = pEntry.revenue.plus(rev);
      pEntry.profit = pEntry.profit.plus(profit);
      productAgg.set(row.productId, pEntry);

      const supId = String(row.fulfilledSupplierId || row.defaultSupplier || 'aitoolshop');
      const supName = supplierNames.get(supId) || supId;
      const sEntry = supplierAgg.get(supId) || {
        supplierId: supId,
        supplierName: supName,
        ordersCount: 0,
        revenue: new Decimal(0),
        profit: new Decimal(0),
      };
      sEntry.ordersCount += 1;
      sEntry.revenue = sEntry.revenue.plus(rev);
      sEntry.profit = sEntry.profit.plus(profit);
      supplierAgg.set(supId, sEntry);
    }

    const productsList = Array.from(productAgg.values());
    const topProductRaw =
      productsList.length > 0
        ? [...productsList].sort((a, b) => {
            if (b.ordersCount !== a.ordersCount) return b.ordersCount - a.ordersCount;
            return b.revenue.minus(a.revenue).toNumber();
          })[0]
        : null;

    const mostProfitableRaw =
      productsList.length > 0
        ? [...productsList].sort((a, b) => b.profit.minus(a.profit).toNumber())[0]
        : null;

    const suppliersList = Array.from(supplierAgg.values());
    const topSupplierRaw =
      suppliersList.length > 0
        ? [...suppliersList].sort((a, b) => {
            if (b.ordersCount !== a.ordersCount) return b.ordersCount - a.ordersCount;
            return b.revenue.minus(a.revenue).toNumber();
          })[0]
        : null;

    return {
      todayRevenue: todayRevenue.toFixed(2),
      todayProfit: todayProfit.toFixed(2),
      todayOrders,
      monthlyRevenue: monthlyRevenue.toFixed(2),
      monthlyProfit: monthlyProfit.toFixed(2),
      monthlyOrders,
      allTimeRevenue: allTimeRevenue.toFixed(2),
      allTimeProfit: allTimeProfit.toFixed(2),
      allTimeOrders,
      topProduct: topProductRaw
        ? {
            productId: topProductRaw.productId,
            name: topProductRaw.name,
            ordersCount: topProductRaw.ordersCount,
            unitsSold: topProductRaw.unitsSold,
            revenue: topProductRaw.revenue.toFixed(2),
            profit: topProductRaw.profit.toFixed(2),
          }
        : null,
      topSupplier: topSupplierRaw
        ? {
            supplierId: topSupplierRaw.supplierId,
            supplierName: topSupplierRaw.supplierName,
            ordersCount: topSupplierRaw.ordersCount,
            revenue: topSupplierRaw.revenue.toFixed(2),
            profit: topSupplierRaw.profit.toFixed(2),
          }
        : null,
      mostProfitableProduct: mostProfitableRaw
        ? {
            productId: mostProfitableRaw.productId,
            name: mostProfitableRaw.name,
            ordersCount: mostProfitableRaw.ordersCount,
            unitsSold: mostProfitableRaw.unitsSold,
            revenue: mostProfitableRaw.revenue.toFixed(2),
            profit: mostProfitableRaw.profit.toFixed(2),
          }
        : null,
    };
  }
}

export const pricingService = new PricingService();
