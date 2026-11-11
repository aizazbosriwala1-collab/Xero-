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

export class SupplierService {
  private baseUrl: string;
  private apiKey?: string;

  constructor() {
    this.baseUrl = config.supplier.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.supplier.apiKey;
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

  /**
   * Fetch supplier balance (GET /balance)
   */
  public async getBalance(): Promise<{ balanceUsdt: Decimal; currency: string } | null> {
    if (!this.apiKey) {
      logger.warn('AITOOLSHOP_RESELLER_API_KEY not configured, cannot query live balance');
      return null;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${this.baseUrl}/balance`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        logger.error('Supplier balance request failed', { status: res.status });
        return null;
      }

      const data = await res.json();
      const balance = new Decimal(data.balance || data.balance_usdt || data.data?.balance || 0);
      return { balanceUsdt: balance, currency: 'USDT' };
    } catch (err: any) {
      logger.error('Supplier getBalance error', { error: err.message });
      return null;
    }
  }

  /**
   * Fetch live supplier products from GET /products
   */
  public async fetchLiveProducts(): Promise<SupplierRawProduct[]> {
    if (!this.apiKey) {
      logger.info('AITOOLSHOP_RESELLER_API_KEY not set; live catalogue requires authorized reseller key');
      return [];
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(`${this.baseUrl}/products`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        logger.warn('Supplier /products returned non-200 status', { status: res.status });
        return [];
      }

      const data = await res.json();
      const products: SupplierRawProduct[] = Array.isArray(data)
        ? data
        : Array.isArray(data.products)
        ? data.products
        : Array.isArray(data.data)
        ? data.data
        : [];

      logger.info('Successfully fetched live supplier products', { count: products.length });
      return products;
    } catch (err: any) {
      logger.warn('Failed to reach live supplier /products endpoint', { error: err.message });
      return [];
    }
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

      const res = await fetch(`${this.baseUrl}/order`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await res.json();

      if (res.status === 200 || res.status === 201) {
        return {
          success: true,
          status: data.status || 'completed',
          order_ref: data.order_ref || data.id,
          delivered_items: Array.isArray(data.items) ? data.items : (data.content ? [data.content] : []),
          raw: data,
        };
      }

      // Check stable error codes
      const errorCode = data.error_code || (res.status === 401 ? 'INVALID_API_KEY' : (res.status === 402 ? 'INSUFFICIENT_BALANCE' : 'API_ERROR'));
      return {
        success: false,
        status: 'failed',
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
