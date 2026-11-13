import Decimal from 'decimal.js';
import { db } from '../db/index.js';
import { redis } from './redis.js';
import { createLogger } from './logger.js';

const logger = createLogger('PricingService');

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export interface ResolvedPrice {
  supplierCost: Decimal;
  customerUnitPrice: Decimal;
  markup: Decimal;
  ruleApplied: 'FIXED_RETAIL' | 'PRODUCT_FIXED_MARKUP' | 'PRODUCT_PERCENT_MARKUP' | 'CATEGORY_RULE' | 'GLOBAL_DEFAULT' | 'COST_FLOOR';
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
  supplierCost: string; // USDT
  sellingPrice: string; // USDT
  markup: string;
  pricingRule: string;
  stock: number;
  isUnlimited: boolean;
  requiresEmail: boolean;
  supplierType: string;
  duration: string;
  warrantySummary: string;
  isAvailable: boolean;
  isFeatured: boolean;
  isHidden: boolean;
}

export class PricingService {
  /**
   * Calculate effective retail price following strict 5-tier precedence.
   */
  public async calculatePrice(productId: string): Promise<ResolvedPrice> {
    const cacheKey = `price:${productId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return {
          supplierCost: new Decimal(parsed.supplierCost),
          customerUnitPrice: new Decimal(parsed.customerUnitPrice),
          markup: new Decimal(parsed.markup),
          ruleApplied: parsed.ruleApplied,
        };
      } catch {
        // Cache miss
      }
    }

    const row = await db.queryRow<any>(`
      SELECT sp.id, sp.latest_cost as "latestCost",
             po.fixed_retail_price as "fixedRetailPrice",
             po.fixed_markup as "fixedMarkup",
             po.percent_markup as "percentMarkup",
             po.category_id as "categoryId"
      FROM supplier_products sp
      LEFT JOIN product_overrides po ON sp.id = po.product_id
      WHERE sp.id = $1
    `, [productId]);

    if (!row) {
      throw new Error(`Product not found: ${productId}`);
    }

    const cost = new Decimal(row.latestCost || '0.0000');
    let finalPrice: Decimal;
    let ruleApplied: ResolvedPrice['ruleApplied'];

    // 1. Per-product fixed retail price
    if (row.fixedRetailPrice !== null && row.fixedRetailPrice !== undefined) {
      const fixedPrice = new Decimal(row.fixedRetailPrice);
      if (fixedPrice.greaterThan(0)) {
        finalPrice = fixedPrice;
        ruleApplied = 'FIXED_RETAIL';
      } else {
        finalPrice = cost;
        ruleApplied = 'COST_FLOOR';
      }
    }
    // 2. Per-product markup rule (fixed or percentage)
    else if (row.fixedMarkup !== null && row.fixedMarkup !== undefined) {
      finalPrice = cost.plus(new Decimal(row.fixedMarkup));
      ruleApplied = 'PRODUCT_FIXED_MARKUP';
    }
    else if (row.percentMarkup !== null && row.percentMarkup !== undefined) {
      const pct = new Decimal(row.percentMarkup);
      finalPrice = cost.times(new Decimal(1).plus(pct));
      ruleApplied = 'PRODUCT_PERCENT_MARKUP';
    }
    // 3. Category pricing rule (if category has rule)
    else {
      // 4. Global default pricing rule
      const settingsRow = await db.queryRow<any>("SELECT value FROM system_settings WHERE key = 'pricing_global_rules'");
      const settings = settingsRow?.value || {};
      const defaultPct = new Decimal(settings.defaultPercentMarkup || '0.15');
      const defaultFixed = new Decimal(settings.defaultFixedMarkup || '0.05');

      const markupFromPct = cost.times(defaultPct);
      const effectiveMarkup = Decimal.max(markupFromPct, defaultFixed);
      finalPrice = cost.plus(effectiveMarkup);
      ruleApplied = 'GLOBAL_DEFAULT';
    }

    // 5. Safe fallback: Never sell below supplier cost unless privileged override
    if (finalPrice.lessThan(cost)) {
      finalPrice = cost;
      ruleApplied = 'COST_FLOOR';
    }

    // Decimal round to 2 or 4 decimal places
    finalPrice = finalPrice.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const markup = finalPrice.minus(cost).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

    const result: ResolvedPrice = {
      supplierCost: cost,
      customerUnitPrice: finalPrice,
      markup,
      ruleApplied,
    };

    // Cache price for 60 seconds (invalidated immediately when admin edits)
    await redis.set(cacheKey, JSON.stringify({
      supplierCost: cost.toFixed(4),
      customerUnitPrice: finalPrice.toFixed(2),
      markup: markup.toFixed(4),
      ruleApplied,
    }), 60);

    return result;
  }

  /**
   * Set per-product fixed retail price.
   */
  public async setFixedRetailPrice(productId: string, price: Decimal | number | string, adminId: string): Promise<void> {
    const priceDec = new Decimal(price);
    await db.query(`
      INSERT INTO product_overrides (product_id, fixed_retail_price, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (product_id) DO UPDATE SET
        fixed_retail_price = $2,
        fixed_markup = NULL,
        percent_markup = NULL,
        updated_at = CURRENT_TIMESTAMP
    `, [productId, priceDec.toFixed(4)]);

    // Log admin audit
    await db.query(`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
      VALUES ($1, $2, 'SET_FIXED_PRICE', 'product', $3, $4)
    `, [`log_${Date.now()}`, adminId, productId, JSON.stringify({ price: priceDec.toFixed(4) })]);

    await redis.del(`price:${productId}`);
    logger.info('Admin updated fixed retail price', { productId, price: priceDec.toFixed(4), adminId });
  }

  /**
   * Set per-product fixed markup (e.g. 0.02 USDT).
   */
  public async setFixedMarkup(productId: string, markup: Decimal | number | string, adminId: string): Promise<void> {
    const markupDec = new Decimal(markup);
    await db.query(`
      INSERT INTO product_overrides (product_id, fixed_markup, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (product_id) DO UPDATE SET
        fixed_markup = $2,
        fixed_retail_price = NULL,
        percent_markup = NULL,
        updated_at = CURRENT_TIMESTAMP
    `, [productId, markupDec.toFixed(4)]);

    await db.query(`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
      VALUES ($1, $2, 'SET_FIXED_MARKUP', 'product', $3, $4)
    `, [`log_${Date.now()}`, adminId, productId, JSON.stringify({ markup: markupDec.toFixed(4) })]);

    await redis.del(`price:${productId}`);
    logger.info('Admin updated fixed markup', { productId, markup: markupDec.toFixed(4), adminId });
  }

  /**
   * Reset product pricing to global default rule.
   */
  public async resetPricing(productId: string, adminId: string): Promise<void> {
    await db.query(`
      UPDATE product_overrides
      SET fixed_retail_price = NULL,
          fixed_markup = NULL,
          percent_markup = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE product_id = $1
    `, [productId]);

    await db.query(`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
      VALUES ($1, $2, 'RESET_PRICING', 'product', $3, '{}')
    `, [`log_${Date.now()}`, adminId, productId]);

    await redis.del(`price:${productId}`);
    logger.info('Admin reset product pricing to default', { productId, adminId });
  }

  /**
   * Fetch a single product with resolved retail pricing (avoids scanning the full catalogue on product clicks).
   */
  public async getCatalogItemById(productId: string): Promise<ProductCatalogItem | null> {
    const row = await db.queryRow<any>(
      `SELECT sp.id, sp.supplier_product_id as "supplierProductId",
              sp.original_name as "originalName",
              sp.original_description as "originalDescription",
              sp.latest_cost as "latestCost",
              sp.latest_stock as "latestStock",
              sp.is_unlimited as "isUnlimited",
              sp.requires_email as "requiresEmail",
              sp.supplier_type as "supplierType",
              sp.duration, sp.warranty_summary as "warrantySummary",
              sp.is_available as "isAvailable",
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
    );
    if (!row) return null;

    const priceCalc = await this.calculatePrice(row.id);
    return {
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
      stock: row.latestStock || 0,
      isUnlimited: Boolean(row.isUnlimited),
      requiresEmail: Boolean(row.requiresEmail),
      supplierType: row.supplierType || 'account',
      duration: row.duration || '1 Month',
      warrantySummary: row.warrantySummary || 'Full duration warranty',
      isAvailable: Boolean(row.isAvailable),
      isFeatured: Boolean(row.isFeatured),
      isHidden: Boolean(row.isHidden),
    };
  }

  /**
   * Get all active catalogue products for customer view (respecting filters, categories, search).
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

    let whereClause = 'WHERE 1=1';
    const queryParams: any[] = [];
    let paramIndex = 1;

    if (!params.includeHidden) {
      whereClause += ` AND (po.is_hidden IS NULL OR po.is_hidden = FALSE)`;
      // Hide zero stock by default unless unlimited
      whereClause += ` AND (sp.is_unlimited = TRUE OR sp.latest_stock > 0)`;
      whereClause += ` AND sp.is_available = TRUE`;
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

    // Count query
    const countSql = `
      SELECT COUNT(*) as count
      FROM supplier_products sp
      LEFT JOIN product_overrides po ON sp.id = po.product_id
      ${whereClause}
    `;
    const countRes = await db.queryRow<{ count: string }>(countSql, queryParams);
    const total = parseInt(countRes?.count || '0', 10);

    // Items query
    const itemsSql = `
      SELECT sp.id, sp.supplier_product_id as "supplierProductId",
             sp.original_name as "originalName",
             sp.original_description as "originalDescription",
             sp.latest_cost as "latestCost",
             sp.latest_stock as "latestStock",
             sp.is_unlimited as "isUnlimited",
             sp.requires_email as "requiresEmail",
             sp.supplier_type as "supplierType",
             sp.duration, sp.warranty_summary as "warrantySummary",
             sp.is_available as "isAvailable",
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
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    queryParams.push(pageSize, offset);

    const rowsRes = await db.query<any>(itemsSql, queryParams);
    const items: ProductCatalogItem[] = [];

    for (const r of rowsRes.rows) {
      const priceCalc = await this.calculatePrice(r.id);
      items.push({
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
        stock: r.latestStock || 0,
        isUnlimited: Boolean(r.isUnlimited),
        requiresEmail: Boolean(r.requiresEmail),
        supplierType: r.supplierType || 'account',
        duration: r.duration || '1 Month',
        warrantySummary: r.warrantySummary || 'Full duration warranty',
        isAvailable: Boolean(r.isAvailable),
        isFeatured: Boolean(r.isFeatured),
        isHidden: Boolean(r.isHidden),
      });
    }

    return { items, total };
  }
}

export const pricingService = new PricingService();
