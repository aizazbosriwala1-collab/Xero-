import Decimal from 'decimal.js';
import { db } from '../db/index.js';
import { redis } from './redis.js';
import { pricingService } from './pricing.js';
import { createLogger } from './logger.js';
import { SupplierRawProduct } from './supplier.js';

const logger = createLogger('SupplierEcosystem');

export type SupplierApiStatus = 'Healthy' | 'Warning' | 'Failed' | 'Offline';

export interface SupplierDashboardSummary {
  id: string;
  name: string;
  driverKey: string;
  baseUrl: string;
  priority: number;
  isEnabled: boolean;
  routingEnabled: boolean;
  orderingEnabled: boolean;
  syncEnabled: boolean;
  online: boolean;
  balanceUsdt: string | null;
  lowBalanceThreshold: string;
  isLowBalance: boolean;
  productsCount: number;
  ordersToday: number;
  failuresToday: number;
  successRatePct: string;
  avgResponseMs: number;
  avgResponseLabel: string;
  lastSyncAt: string | null;
  lastHealthCheckAt: string | null;
  apiStatus: SupplierApiStatus;
  lastError: string | null;
}

export interface ProductMappingSlot {
  slotRank: 1 | 2 | 3 | 4;
  slotLabel: string;
  supplierId: string;
  supplierName: string;
  supplierEnabled: boolean;
  supplierProductId: string;
  mirrorName?: string;
  mirrorCostUsdt?: string;
  mirrorStock?: number;
  isUnlimited?: boolean;
}

export interface MasterProductMappingView {
  productId: string;
  canonicalName: string;
  isAvailable: boolean;
  slots: ProductMappingSlot[];
  fulfillableByAnyEnabledSupplier: boolean;
}

export interface FulfillmentChainResolution {
  productId: string;
  productExists: boolean;
  explicitMappingCount: number;
  allTargets: Array<{
    slotRank: number;
    supplierId: string;
    supplierName: string;
    supplierProductId: string;
    baseUrl: string;
    driverKey: string;
    isEnabled: boolean;
    routingEnabled: boolean;
    orderingEnabled: boolean;
  }>;
  eligibleTargets: Array<{
    slotRank: number;
    supplierId: string;
    supplierName: string;
    supplierProductId: string;
    baseUrl: string;
    driverKey: string;
  }>;
  hasActiveSupplier: boolean;
  blockedByDisabledSupplier: boolean;
}

export class SupplierEcosystemService {
  private readonly availCachePrefix = 'sup_eco:avail:';

  private slotLabelForRank(rank: number): string {
    if (rank === 1) return 'Primary';
    if (rank === 2) return 'Backup 1';
    if (rank === 3) return 'Backup 2';
    return 'Backup 3';
  }

  public async invalidateAvailabilityCache(): Promise<void> {
    await redis.del(`${this.availCachePrefix}map`).catch(() => {});
    await pricingService.invalidateCatalogCaches().catch(() => {});
  }

  /**
   * Ensure canonical Master Product row and default Slot 1 mapping exist without overwriting admin overrides.
   */
  public async ensureMasterProductAndPrimaryMapping(params: {
    productId: string;
    canonicalName: string;
    description?: string;
    categoryId?: string;
    supplierId: string;
    supplierProductId: string;
  }): Promise<void> {
    await db.query(
      `INSERT INTO master_products (id, canonical_name, description, category_id, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET
         canonical_name = COALESCE(master_products.canonical_name, EXCLUDED.canonical_name),
         updated_at = CURRENT_TIMESTAMP`,
      [params.productId, params.canonicalName, params.description || '', params.categoryId || null]
    );

    const existingPrimary = await db.queryRow<any>(
      `SELECT id FROM product_supplier_mappings WHERE master_product_id = $1 AND slot_rank = 1`,
      [params.productId]
    );

    if (!existingPrimary) {
      await db.query(
        `INSERT INTO product_supplier_mappings (
          id, master_product_id, slot_rank, supplier_id, supplier_product_id, is_active, created_at, updated_at
        ) VALUES ($1, $2, 1, $3, $4, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (master_product_id, slot_rank) DO NOTHING`,
        [
          `pmap_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          params.productId,
          params.supplierId,
          params.supplierProductId,
        ]
      );
    }
  }

  /**
   * Mirror normalized supplier catalog items into supplier_catalog_mirror for any pluggable supplier.
   */
  public async mirrorSupplierProducts(
    supplierId: string,
    rawProducts: SupplierRawProduct[]
  ): Promise<{ mirroredCount: number }> {
    const syncedRemoteIds: string[] = [];

    for (const raw of rawProducts) {
      const remoteId = String(raw.id);
      syncedRemoteIds.push(remoteId);
      const name = String(raw.name || 'Unnamed Product').trim();
      const desc = String(raw.description || '');
      const costRaw = raw.your_cost !== undefined ? raw.your_cost : raw.price_usdt !== undefined ? raw.price_usdt : 0;
      const costStr = new Decimal(costRaw || 0).toFixed(4);
      const stock = raw.stock !== undefined ? Number(raw.stock) : raw.stock_quantity !== undefined ? Number(raw.stock_quantity) : 0;
      const isUnlimited = Boolean(raw.is_unlimited || stock > 1000);
      const requiresEmail = Boolean(raw.requires_email);
      const supplierType = String(raw.type || 'account');
      const duration = String(raw.duration || '1 Month');
      const warranty = String(raw.warranty || 'Full duration replacement warranty');
      const isAvailable = isUnlimited || stock > 0;
      const mirrorId = `mir_${supplierId}_${remoteId}`.slice(0, 64);

      await db.query(
        `INSERT INTO supplier_catalog_mirror (
          id, supplier_id, supplier_product_id, name, description, cost_usdt, stock,
          is_unlimited, requires_email, supplier_type, duration, warranty_summary, is_available,
          raw_payload, last_synced_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (supplier_id, supplier_product_id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          cost_usdt = EXCLUDED.cost_usdt,
          stock = EXCLUDED.stock,
          is_unlimited = EXCLUDED.is_unlimited,
          requires_email = EXCLUDED.requires_email,
          supplier_type = EXCLUDED.supplier_type,
          duration = EXCLUDED.duration,
          warranty_summary = EXCLUDED.warranty_summary,
          is_available = EXCLUDED.is_available,
          raw_payload = EXCLUDED.raw_payload,
          last_synced_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP`,
        [
          mirrorId,
          supplierId,
          remoteId,
          name,
          desc,
          costStr,
          Number.isFinite(stock) ? stock : 0,
          isUnlimited,
          requiresEmail,
          supplierType,
          duration,
          warranty,
          isAvailable,
          JSON.stringify(raw),
        ]
      );
    }

    if (syncedRemoteIds.length > 0) {
      await db.query(
        `UPDATE supplier_catalog_mirror
         SET is_available = FALSE, updated_at = CURRENT_TIMESTAMP
         WHERE supplier_id = $1
           AND supplier_product_id NOT IN (${syncedRemoteIds.map((_, i) => `$${i + 2}`).join(',')})`,
        [supplierId, ...syncedRemoteIds]
      ).catch(() => {});
    }

    return { mirroredCount: rawProducts.length };
  }

  /**
   * Persist API/order execution metric and update supplier health status badge.
   */
  public async recordHealthLog(params: {
    supplierId: string;
    operation:
      | 'PURCHASE'
      | 'HEALTH_CHECK'
      | 'BALANCE_CHECK'
      | 'CATALOG_SYNC'
      | 'PRICE_SYNC'
      | 'ORDER_RECOVERY'
      | 'DIAGNOSTICS'
      | 'STOCK_CHECK';
    success: boolean;
    latencyMs: number;
    errorCode?: string;
    errorMessage?: string;
    localOrderId?: string;
  }): Promise<void> {
    const id = `shl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const latency = Math.max(0, Math.round(params.latencyMs));

    await db.query(
      `INSERT INTO supplier_health_logs (
        id, supplier_id, operation, success, latency_ms, error_code, error_message, local_order_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
      [
        id,
        params.supplierId,
        params.operation,
        params.success,
        latency,
        params.errorCode || null,
        params.errorMessage ? params.errorMessage.slice(0, 500) : null,
        params.localOrderId || null,
      ]
    ).catch(() => {});

    const apiStatus: SupplierApiStatus = params.success
      ? latency > 4000
        ? 'Warning'
        : 'Healthy'
      : 'Failed';

    await db.query(
      `UPDATE suppliers
       SET api_status = $1,
           last_latency_ms = $2,
           last_health_check_at = CURRENT_TIMESTAMP,
           last_error = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [apiStatus, latency, params.success ? null : params.errorMessage || params.errorCode || 'FAILED', params.supplierId]
    ).catch(() => {});

    await Promise.all([
      redis.del(`supplier_ctrl:${params.supplierId}`).catch(() => {}),
      redis.del('supplier_ctrl:list').catch(() => {}),
    ]);
  }

  public async setLowBalanceThreshold(
    supplierId: string,
    thresholdUsdt: string | number,
    adminId: string
  ): Promise<void> {
    const dec = new Decimal(thresholdUsdt);
    if (dec.isNaN() || dec.lessThan(0)) {
      throw new Error('Threshold must be a non-negative USDT value.');
    }

    await db.query(
      `UPDATE suppliers SET low_balance_threshold = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [dec.toFixed(4), supplierId]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'SUPPLIER_THRESHOLD_UPDATED', 'suppliers', $3, $4)`,
      [
        `aud_sup_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        adminId,
        supplierId,
        JSON.stringify({ lowBalanceThreshold: dec.toFixed(4) }),
      ]
    ).catch(() => {});

    await Promise.all([
      redis.del(`supplier_ctrl:${supplierId}`).catch(() => {}),
      redis.del('supplier_ctrl:list').catch(() => {}),
    ]);
  }

  /**
   * Assign or update a canonical Master Product's Primary (1) / Backup 1-3 (2-4) supplier mapping.
   */
  public async assignMappingSlot(
    params: {
      masterProductId: string;
      slotRank: 1 | 2 | 3 | 4;
      supplierId: string;
      supplierProductId: string;
    },
    adminId: string
  ): Promise<void> {
    if (![1, 2, 3, 4].includes(params.slotRank)) {
      throw new Error('Slot rank must be 1 (Primary), 2 (Backup 1), 3 (Backup 2), or 4 (Backup 3).');
    }

    const spRow = await db.queryRow<any>('SELECT * FROM supplier_products WHERE id = $1', [params.masterProductId]);
    const canonicalName = spRow?.original_name || params.masterProductId;

    await db.query(
      `INSERT INTO master_products (id, canonical_name, description, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO NOTHING`,
      [params.masterProductId, canonicalName, spRow?.original_description || '']
    );

    const mirrorRow = await db.queryRow<{ id: string }>(
      `SELECT id FROM supplier_catalog_mirror WHERE supplier_id = $1 AND supplier_product_id = $2`,
      [params.supplierId, params.supplierProductId]
    );

    await db.query(
      `INSERT INTO product_supplier_mappings (
        id, master_product_id, slot_rank, supplier_id, supplier_product_id, mirror_item_id, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (master_product_id, slot_rank) DO UPDATE SET
        supplier_id = EXCLUDED.supplier_id,
        supplier_product_id = EXCLUDED.supplier_product_id,
        mirror_item_id = EXCLUDED.mirror_item_id,
        is_active = TRUE,
        updated_at = CURRENT_TIMESTAMP`,
      [
        `pmap_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        params.masterProductId,
        params.slotRank,
        params.supplierId,
        params.supplierProductId,
        mirrorRow?.id || null,
      ]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'UPSERT_PRODUCT_SUPPLIER_MAP', 'product_supplier_mappings', $3, $4)`,
      [
        `aud_map_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        adminId,
        params.masterProductId,
        JSON.stringify(params),
      ]
    ).catch(() => {});

    await this.invalidateAvailabilityCache();
    logger.info('Product supplier mapping updated', { ...params, adminId });
  }

  public async clearMappingSlot(
    masterProductId: string,
    slotRank: 1 | 2 | 3 | 4,
    adminId: string
  ): Promise<void> {
    await db.query(
      `DELETE FROM product_supplier_mappings WHERE master_product_id = $1 AND slot_rank = $2`,
      [masterProductId, slotRank]
    );
    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'CLEAR_PRODUCT_SUPPLIER_MAP', 'product_supplier_mappings', $3, $4)`,
      [
        `aud_map_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        adminId,
        masterProductId,
        JSON.stringify({ slotRank }),
      ]
    ).catch(() => {});
    await this.invalidateAvailabilityCache();
  }

  /**
   * Resolve complete ordered fulfillment chain for a canonical product:
   * - Uses explicit Primary / Backup 1..3 slots from product_supplier_mappings when present
   * - Falls back cleanly to legacy supplier_products.supplier + supplier_product_id when no explicit slots exist
   * - Reports whether ANY active enabled supplier can fulfill the product
   */
  public async getFulfillmentChain(productId: string): Promise<FulfillmentChainResolution> {
    const [spRow, mapRes, supRes] = await Promise.all([
      db.queryRow<any>('SELECT id, supplier, supplier_product_id FROM supplier_products WHERE id = $1', [productId]),
      db.query<any>(
        `SELECT slot_rank, supplier_id, supplier_product_id
         FROM product_supplier_mappings
         WHERE master_product_id = $1 AND is_active = TRUE
         ORDER BY slot_rank ASC`,
        [productId]
      ),
      db.query<any>('SELECT * FROM suppliers ORDER BY priority ASC, created_at ASC'),
    ]);

    if (!spRow) {
      return {
        productId,
        productExists: false,
        explicitMappingCount: 0,
        allTargets: [],
        eligibleTargets: [],
        hasActiveSupplier: false,
        blockedByDisabledSupplier: false,
      };
    }

    const supById = new Map<string, any>();
    for (const s of supRes.rows) {
      supById.set(s.id, s);
    }

    const explicitRows = mapRes.rows;
    const rawTargets =
      explicitRows.length > 0
        ? explicitRows.map(r => ({
            slotRank: Number(r.slot_rank),
            supplierId: String(r.supplier_id),
            supplierProductId: String(r.supplier_product_id),
          }))
        : [
            {
              slotRank: 1,
              supplierId: String(spRow.supplier || 'aitoolshop'),
              supplierProductId: String(spRow.supplier_product_id),
            },
          ];

    const allTargets = rawTargets.map(t => {
      const sup = supById.get(t.supplierId);
      const isEnabled = sup ? sup.is_enabled !== false : t.supplierId === 'aitoolshop';
      const routingEnabled = sup ? sup.routing_enabled !== false : true;
      const orderingEnabled = sup ? sup.ordering_enabled !== false : true;
      return {
        slotRank: t.slotRank,
        supplierId: t.supplierId,
        supplierName: sup?.name || t.supplierId,
        supplierProductId: t.supplierProductId,
        baseUrl: sup?.base_url || '',
        driverKey: sup?.driver_key || t.supplierId,
        isEnabled,
        routingEnabled,
        orderingEnabled,
      };
    });

    const eligibleTargets = allTargets
      .filter(t => t.isEnabled && t.routingEnabled && t.orderingEnabled)
      .map(t => ({
        slotRank: t.slotRank,
        supplierId: t.supplierId,
        supplierName: t.supplierName,
        supplierProductId: t.supplierProductId,
        baseUrl: t.baseUrl,
        driverKey: t.driverKey,
      }));

    // If product has no explicit multi-supplier slots and its default supplier was disabled,
    // check whether another priority failover supplier is active in the system ONLY if multiple enabled suppliers exist
    // Wait: if product specifically depends on that disabled supplier (explicit slots all disabled OR default supplier disabled and no active failover candidates),
    // mark blockedByDisabledSupplier = true cleanly!
    const hasActiveSupplier = eligibleTargets.length > 0;
    const blockedByDisabledSupplier = !hasActiveSupplier && allTargets.length > 0;

    return {
      productId,
      productExists: true,
      explicitMappingCount: explicitRows.length,
      allTargets,
      eligibleTargets,
      hasActiveSupplier,
      blockedByDisabledSupplier,
    };
  }

  /**
   * Batch set of product IDs currently fulfillable by at least one enabled supplier (for customer catalog filtering).
   * Redis-cached 30s and invalidated immediately on supplier toggle or product mapping change.
   */
  public async getDisabledExclusiveProductIds(): Promise<Set<string>> {
    const cacheKey = `${this.availCachePrefix}map`;
    try {
      const cached = await redis.getHot(cacheKey, 3000);
      if (cached) return new Set(JSON.parse(cached) as string[]);
    } catch {
      // Cache miss
    }

    const [supRes, spRes, mapRes] = await Promise.all([
      db.query<any>('SELECT id, is_enabled, routing_enabled, ordering_enabled FROM suppliers'),
      db.query<any>('SELECT id, supplier FROM supplier_products WHERE is_available = TRUE'),
      db.query<any>('SELECT master_product_id, supplier_id FROM product_supplier_mappings WHERE is_active = TRUE'),
    ]);

    const activeSupplierIds = new Set<string>();
    const knownSupplierIds = new Set<string>();
    for (const s of supRes.rows) {
      knownSupplierIds.add(s.id);
      if (s.is_enabled !== false && s.routing_enabled !== false && s.ordering_enabled !== false) {
        activeSupplierIds.add(s.id);
      }
    }

    const mappingsByProduct = new Map<string, string[]>();
    for (const m of mapRes.rows) {
      const list = mappingsByProduct.get(m.master_product_id) || [];
      list.push(m.supplier_id);
      mappingsByProduct.set(m.master_product_id, list);
    }

    const blockedIds: string[] = [];
    for (const p of spRes.rows) {
      const mapped = mappingsByProduct.get(p.id);
      if (mapped && mapped.length > 0) {
        const anyActive = mapped.some(sid => activeSupplierIds.has(sid));
        if (!anyActive) blockedIds.push(p.id);
      } else {
        const defSup = p.supplier || 'aitoolshop';
        if (knownSupplierIds.has(defSup) && !activeSupplierIds.has(defSup)) {
          blockedIds.push(p.id);
        }
      }
    }

    await redis.set(cacheKey, JSON.stringify(blockedIds), 30).catch(() => {});
    return new Set(blockedIds);
  }

  public async getProductMappings(productId: string): Promise<MasterProductMappingView | null> {
    const [spRow, mpRow, mapRes, supRes, mirrorRes] = await Promise.all([
      db.queryRow<any>('SELECT * FROM supplier_products WHERE id = $1', [productId]),
      db.queryRow<any>('SELECT * FROM master_products WHERE id = $1', [productId]),
      db.query<any>(
        `SELECT * FROM product_supplier_mappings WHERE master_product_id = $1 AND is_active = TRUE ORDER BY slot_rank ASC`,
        [productId]
      ),
      db.query<any>('SELECT * FROM suppliers'),
      db.query<any>('SELECT * FROM supplier_catalog_mirror'),
    ]);

    if (!spRow) return null;

    const supById = new Map<string, any>(supRes.rows.map(r => [r.id, r]));
    const mirrorByKey = new Map<string, any>(
      mirrorRes.rows.map(r => [`${r.supplier_id}::${r.supplier_product_id}`, r])
    );

    let effectiveRows = mapRes.rows;
    if (effectiveRows.length === 0) {
      effectiveRows = [
        {
          slot_rank: 1,
          supplier_id: spRow.supplier || 'aitoolshop',
          supplier_product_id: spRow.supplier_product_id,
        },
      ];
    }

    const slots: ProductMappingSlot[] = effectiveRows.map(r => {
      const rank = Number(r.slot_rank) as 1 | 2 | 3 | 4;
      const sup = supById.get(r.supplier_id);
      const mir = mirrorByKey.get(`${r.supplier_id}::${r.supplier_product_id}`);
      const supEnabled = sup
        ? sup.is_enabled !== false && sup.routing_enabled !== false && sup.ordering_enabled !== false
        : r.supplier_id === 'aitoolshop';

      return {
        slotRank: rank,
        slotLabel: this.slotLabelForRank(rank),
        supplierId: r.supplier_id,
        supplierName: sup?.name || r.supplier_id,
        supplierEnabled: supEnabled,
        supplierProductId: r.supplier_product_id,
        mirrorName: mir?.name || (r.supplier_id === (spRow.supplier || 'aitoolshop') ? spRow.original_name : undefined),
        mirrorCostUsdt: mir?.cost_usdt !== undefined ? new Decimal(mir.cost_usdt).toFixed(2) : undefined,
        mirrorStock: mir?.stock !== undefined ? Number(mir.stock) : undefined,
        isUnlimited: mir?.is_unlimited !== undefined ? Boolean(mir.is_unlimited) : undefined,
      };
    });

    return {
      productId: spRow.id,
      canonicalName: mpRow?.canonical_name || spRow.original_name,
      isAvailable: Boolean(spRow.is_available),
      slots,
      fulfillableByAnyEnabledSupplier: slots.some(s => s.supplierEnabled),
    };
  }

  public async listMasterProductsWithMappings(
    page = 1,
    pageSize = 6
  ): Promise<{ items: MasterProductMappingView[]; total: number }> {
    const offset = (Math.max(1, page) - 1) * pageSize;
    const [countRow, spRes, mapRes, supRes] = await Promise.all([
      db.queryRow<{ c: string }>('SELECT COUNT(*) as c FROM supplier_products'),
      db.query<any>(
        `SELECT sp.id, sp.supplier, sp.supplier_product_id, sp.original_name, sp.is_available, po.display_name_override
         FROM supplier_products sp
         LEFT JOIN product_overrides po ON sp.id = po.product_id
         ORDER BY po.is_featured DESC NULLS LAST, sp.original_name ASC
         LIMIT $1 OFFSET $2`,
        [pageSize, offset]
      ),
      db.query<any>('SELECT * FROM product_supplier_mappings WHERE is_active = TRUE ORDER BY slot_rank ASC'),
      db.query<any>('SELECT id, name, is_enabled, routing_enabled, ordering_enabled FROM suppliers'),
    ]);

    const supById = new Map<string, any>(supRes.rows.map(r => [r.id, r]));
    const mapsByProd = new Map<string, any[]>();
    for (const m of mapRes.rows) {
      const list = mapsByProd.get(m.master_product_id) || [];
      list.push(m);
      mapsByProd.set(m.master_product_id, list);
    }

    const items: MasterProductMappingView[] = spRes.rows.map(sp => {
      const explicit = mapsByProd.get(sp.id) || [];
      const effective =
        explicit.length > 0
          ? explicit
          : [{ slot_rank: 1, supplier_id: sp.supplier || 'aitoolshop', supplier_product_id: sp.supplier_product_id }];

      const slots: ProductMappingSlot[] = effective.map(r => {
        const rank = Number(r.slot_rank) as 1 | 2 | 3 | 4;
        const sup = supById.get(r.supplier_id);
        const supEnabled = sup
          ? sup.is_enabled !== false && sup.routing_enabled !== false && sup.ordering_enabled !== false
          : true;
        return {
          slotRank: rank,
          slotLabel: this.slotLabelForRank(rank),
          supplierId: r.supplier_id,
          supplierName: sup?.name || r.supplier_id,
          supplierEnabled: supEnabled,
          supplierProductId: r.supplier_product_id,
        };
      });

      return {
        productId: sp.id,
        canonicalName: sp.display_name_override || sp.original_name,
        isAvailable: Boolean(sp.is_available),
        slots,
        fulfillableByAnyEnabledSupplier: slots.some(s => s.supplierEnabled),
      };
    });

    return {
      items,
      total: parseInt(countRow?.c || '0', 10),
    };
  }

  public async getSupplierDashboardSummaries(): Promise<SupplierDashboardSummary[]> {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const [supRes, mirrorRes, legacyCountRes, logsRes] = await Promise.all([
      db.query<any>('SELECT * FROM suppliers ORDER BY priority ASC, created_at ASC'),
      db.query<{ supplier_id: string; cnt: string }>(
        'SELECT supplier_id, COUNT(*) as cnt FROM supplier_catalog_mirror GROUP BY supplier_id'
      ),
      db.query<{ supplier: string; cnt: string }>(
        'SELECT supplier, COUNT(*) as cnt FROM supplier_products GROUP BY supplier'
      ),
      db.query<any>(
        `SELECT supplier_id, operation, success, latency_ms, created_at
         FROM supplier_health_logs
         WHERE created_at >= $1`,
        [todayStart]
      ),
    ]);

    const mirrorCounts = new Map<string, number>();
    for (const r of mirrorRes.rows) {
      mirrorCounts.set(r.supplier_id, parseInt(r.cnt || '0', 10));
    }
    const legacyCounts = new Map<string, number>();
    for (const r of legacyCountRes.rows) {
      legacyCounts.set(r.supplier || 'aitoolshop', parseInt(r.cnt || '0', 10));
    }

    const metricsBySup = new Map<
      string,
      { ordersToday: number; failuresToday: number; totalOps: number; okOps: number; latencySum: number }
    >();
    for (const log of logsRes.rows) {
      const curr = metricsBySup.get(log.supplier_id) || {
        ordersToday: 0,
        failuresToday: 0,
        totalOps: 0,
        okOps: 0,
        latencySum: 0,
      };
      curr.totalOps++;
      if (log.success) curr.okOps++;
      curr.latencySum += Number(log.latency_ms || 0);
      if (log.operation === 'PURCHASE') {
        curr.ordersToday++;
        if (!log.success) curr.failuresToday++;
      } else if (!log.success) {
        curr.failuresToday++;
      }
      metricsBySup.set(log.supplier_id, curr);
    }

    return supRes.rows.map(r => {
      const m = metricsBySup.get(r.id) || {
        ordersToday: 0,
        failuresToday: 0,
        totalOps: 0,
        okOps: 0,
        latencySum: 0,
      };
      const isEnabled = r.is_enabled !== false;
      const balStr =
        r.last_balance_usdt !== null && r.last_balance_usdt !== undefined
          ? new Decimal(r.last_balance_usdt).toFixed(2)
          : null;
      const thresholdStr =
        r.low_balance_threshold !== null && r.low_balance_threshold !== undefined
          ? new Decimal(r.low_balance_threshold).toFixed(2)
          : '20.00';
      const isLowBalance = balStr !== null && new Decimal(balStr).lessThan(new Decimal(thresholdStr));

      const mirCount = mirrorCounts.get(r.id) ?? 0;
      const legCount = legacyCounts.get(r.id) ?? 0;
      const productsCount = Math.max(mirCount, legCount);

      const successRateNum =
        m.totalOps > 0 ? (m.okOps / m.totalOps) * 100 : isEnabled ? 100 : 0;
      const avgMs =
        m.totalOps > 0
          ? Math.round(m.latencySum / m.totalOps)
          : Number(r.last_latency_ms || 0);
      const avgLabel = avgMs >= 1000 ? `${(avgMs / 1000).toFixed(1)}s` : `${avgMs}ms`;

      const rawApiStatus = String(r.api_status || (isEnabled ? 'Healthy' : 'Offline'));
      const apiStatus: SupplierApiStatus = !isEnabled
        ? 'Offline'
        : rawApiStatus === 'Failed' || rawApiStatus === 'Warning' || rawApiStatus === 'Offline'
          ? (rawApiStatus as SupplierApiStatus)
          : 'Healthy';

      return {
        id: r.id,
        name: r.name,
        driverKey: r.driver_key || r.id,
        baseUrl: r.base_url || '',
        priority: Number(r.priority ?? 100),
        isEnabled,
        routingEnabled: r.routing_enabled !== false,
        orderingEnabled: r.ordering_enabled !== false,
        syncEnabled: r.sync_enabled !== false,
        online: isEnabled && apiStatus !== 'Failed' && apiStatus !== 'Offline',
        balanceUsdt: balStr,
        lowBalanceThreshold: thresholdStr,
        isLowBalance,
        productsCount,
        ordersToday: m.ordersToday,
        failuresToday: m.failuresToday,
        successRatePct: successRateNum.toFixed(1),
        avgResponseMs: avgMs,
        avgResponseLabel: avgLabel,
        lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
        lastHealthCheckAt: r.last_health_check_at ? new Date(r.last_health_check_at).toISOString() : null,
        apiStatus,
        lastError: r.last_error || null,
      };
    });
  }
}

export const supplierEcosystemService = new SupplierEcosystemService();
