import Decimal from 'decimal.js';
import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { pricingService } from './pricing.js';
import { walletService } from './wallet.js';
import { supplierService } from './supplier.js';
import { referralService } from './referral.js';
import { encryptionService } from './encryption.js';
import { createLogger } from './logger.js';

const logger = createLogger('OrderService');

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

const SENSITIVE_SUPPLIER_FIELDS = new Set([
  'items',
  'delivered_items',
  'content',
  'credentials',
  'password',
  'pass',
  'token',
  'secret',
  'key',
  'license',
  'license_key',
  'pin',
  'code',
  'account',
  'accounts',
]);

function redactSupplierValue(val: unknown, depth = 0): unknown {
  if (depth > 5 || val === null || val === undefined) return val;
  if (Array.isArray(val)) {
    return val.map(item => redactSupplierValue(item, depth + 1));
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (SENSITIVE_SUPPLIER_FIELDS.has(k.toLowerCase())) {
        out[k] = Array.isArray(v) ? `[REDACTED_ARRAY:${v.length}]` : '[REDACTED]';
      } else {
        out[k] = redactSupplierValue(v, depth + 1);
      }
    }
    return out;
  }
  return val;
}

function sanitizeSupplierPayload(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '{}';
  try {
    return JSON.stringify(redactSupplierValue(raw));
  } catch {
    return '{}';
  }
}

export interface CheckoutRequest {
  userId: string;
  productId: string;
  quantity: number;
  customerEmail?: string;
  idempotencyKey?: string;
  expectedUnitPrice?: string | number;
}

export interface OrderDetails {
  id: string;
  userId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  totalPrice: string;
  supplierCost: string;
  customerEmail?: string;
  status: 'PENDING' | 'COMPLETED' | 'PENDING_INVITE' | 'FAILED' | 'UNCERTAIN' | 'REFUNDED';
  deliveredItems: string[];
  createdAt: string;
}

export class OrderService {
  private inFlightCheckouts = new Map<string, Promise<any>>();

  private async serializeCheckout<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inFlightCheckouts.get(lockKey) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    this.inFlightCheckouts.set(lockKey, prev.then(() => current));

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.inFlightCheckouts.get(lockKey) === current) {
        this.inFlightCheckouts.delete(lockKey);
      }
    }
  }

  private async decryptOrderItems(orderId: string): Promise<string[]> {
    const itemsRes = await db.query<{ content: string }>(
      'SELECT content FROM delivered_items WHERE local_order_id = $1',
      [orderId]
    );
    return itemsRes.rows.map(i => {
      try {
        return encryptionService.decrypt(i.content);
      } catch {
        return '[ENCRYPTED_DATA]';
      }
    });
  }

  private formatExistingOrderOutcome(existing: any, deliveredItems: string[]): {
    success: boolean;
    orderId: string;
    status: OrderDetails['status'];
    message: string;
    deliveredItems: string[];
    totalCharged: string;
  } {
    const status = existing.status as OrderDetails['status'];
    const totalStr = new Decimal(existing.total_price || 0).toFixed(2);
    if (status === 'COMPLETED') {
      return {
        success: true,
        orderId: existing.id,
        status,
        message: 'Order already completed (idempotent confirmation).',
        deliveredItems,
        totalCharged: totalStr,
      };
    }
    if (status === 'PENDING_INVITE') {
      return {
        success: true,
        orderId: existing.id,
        status,
        message: 'Order already placed with supplier and awaiting invite/activation delivery.',
        deliveredItems: [],
        totalCharged: totalStr,
      };
    }
    if (status === 'UNCERTAIN' || status === 'PENDING') {
      return {
        success: false,
        orderId: existing.id,
        status: 'UNCERTAIN',
        message: 'This purchase attempt is already awaiting reconciliation. Please check My Orders shortly.',
        deliveredItems: [],
        totalCharged: totalStr,
      };
    }
    return {
      success: false,
      orderId: existing.id,
      status,
      message: existing.error_message || 'This purchase attempt already terminated without fulfillment.',
      deliveredItems: [],
      totalCharged: '0.00',
    };
  }

  /**
   * Complete checkout flow:
   * 1. Check idempotency key if supplied (under in-process lock)
   * 2. Revalidate product, stock, email, and stale displayed price
   * 3. Enforce LIVE_ORDERING_ENABLED safety gate BEFORE any wallet/order DB mutation
   * 4. Check wallet available funds (balance - locked)
   * 5. Atomically debit wallet via immutable ledger & create local order with persistent idempotency key
   * 6. Dispatch to supplier POST /order
   * 7. Process supplier response (COMPLETED w/ evidence -> encrypt & deliver, PENDING_INVITE -> pending, UNCERTAIN -> hold, definite FAILED -> atomic refund)
   */
  public async checkout(request: CheckoutRequest): Promise<{
    success: boolean;
    orderId: string;
    status: OrderDetails['status'];
    message: string;
    deliveredItems: string[];
    totalCharged: string;
  }> {
    const lockKey = request.idempotencyKey
      ? `idem:${request.userId}:${request.idempotencyKey}`
      : `user:${request.userId}:${request.productId}`;

    return await this.serializeCheckout(lockKey, async () => this.executeCheckout(request));
  }

  private async executeCheckout(request: CheckoutRequest): Promise<{
    success: boolean;
    orderId: string;
    status: OrderDetails['status'];
    message: string;
    deliveredItems: string[];
    totalCharged: string;
  }> {
    const qty = Math.max(1, Math.floor(request.quantity));

    // 0. If caller supplied a persistent idempotency key, return existing order instead of double-charging
    if (request.idempotencyKey) {
      const existingByKey = await db.queryRow<any>(
        'SELECT * FROM local_orders WHERE idempotency_key = $1',
        [request.idempotencyKey]
      );
      if (existingByKey) {
        if (existingByKey.user_id !== request.userId) {
          throw new Error('Access denied: Idempotency key belongs to another customer.');
        }
        const items = existingByKey.status === 'COMPLETED' ? await this.decryptOrderItems(existingByKey.id) : [];
        return this.formatExistingOrderOutcome(existingByKey, items);
      }
    }

    // 1. Revalidate product in local DB
    const product = await db.queryRow<any>(
      'SELECT * FROM supplier_products WHERE id = $1',
      [request.productId]
    );

    if (!product || !product.is_available) {
      throw new Error('This product is currently unavailable or out of stock.');
    }

    if (!product.is_unlimited && product.latest_stock < qty) {
      throw new Error(`Insufficient stock. Only ${product.latest_stock} available.`);
    }

    // 2. Validate email if required
    if (product.requires_email) {
      if (!request.customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.customerEmail)) {
        throw new Error('A valid email address is required for this product delivery/invite.');
      }
    }

    // 3. Snapshot price & detect stale confirmation price before any debit
    const priceSnapshot = await pricingService.calculatePrice(product.id);
    const unitPrice = priceSnapshot.customerUnitPrice;
    if (request.expectedUnitPrice !== undefined && request.expectedUnitPrice !== null && request.expectedUnitPrice !== '') {
      const expectedDec = new Decimal(request.expectedUnitPrice);
      if (!unitPrice.equals(expectedDec)) {
        throw new Error(
          `Product price has updated from ${expectedDec.toFixed(2)} USDT to ${unitPrice.toFixed(2)} USDT. Please review the updated price and confirm again.`
        );
      }
    }

    // 4. Safety Gate BEFORE any wallet debit, ledger row, or local_orders insert
    if (!config.safety.liveOrderingEnabled) {
      logger.warn('Checkout blocked by LIVE_ORDERING_ENABLED=false before any wallet or order mutation', {
        userId: request.userId,
        productId: product.id,
        quantity: qty,
      });
      return {
        success: false,
        orderId: '',
        status: 'FAILED',
        message: 'Live supplier ordering is currently disabled in safety mode (LIVE_ORDERING_ENABLED=false). No wallet funds were debited and no order was placed.',
        deliveredItems: [],
        totalCharged: '0.00',
      };
    }

    const supplierUnitCost = priceSnapshot.supplierCost;
    const totalCharge = unitPrice.times(qty);
    const totalCost = supplierUnitCost.times(qty);

    // 5. Check wallet available funds (balance - locked)
    const { available } = await walletService.getBalance(request.userId);
    if (available.lessThan(totalCharge)) {
      throw new Error(`Insufficient wallet balance. Total: ${totalCharge.toFixed(2)} USDT, Available: ${available.toFixed(2)} USDT. Please Add Funds first.`);
    }

    const orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const idempotencyKey = request.idempotencyKey || `SUPPLIER_ORD_${orderId}`;

    // 6. Atomic Debit & Local Order Creation
    await db.withTransaction(async (client) => {
      await client.query(`
        INSERT INTO local_orders (
          id, user_id, idempotency_key, product_id, quantity,
          unit_price, total_price, supplier_cost, customer_email,
          status, delivery_type, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        orderId,
        request.userId,
        idempotencyKey,
        product.id,
        qty,
        unitPrice.toFixed(4),
        totalCharge.toFixed(4),
        totalCost.toFixed(4),
        request.customerEmail || null,
        product.supplier_type,
      ]);

      await walletService.executeMutation({
        userId: request.userId,
        amount: totalCharge.negated(),
        operationRef: `PURCHASE_${orderId}`,
        idempotencyKey,
        entryType: 'PURCHASE_DEBIT',
        reason: `Purchase: ${qty}x ${product.original_name}`,
        source: 'CHECKOUT',
        actor: request.userId,
        metadata: {
          orderId,
          productId: product.id,
          unitPrice: unitPrice.toFixed(2),
          quantity: qty,
        },
        client,
      });
    });

    // 7. Call Supplier Reseller API
    const supplierRes = await supplierService.placeOrder({
      product_id: product.supplier_product_id,
      quantity: qty,
      customer_email: request.customerEmail,
      idempotency_key: idempotencyKey,
    });

    const delivered = supplierRes.delivered_items || [];
    const sanitizedRawPayload = sanitizeSupplierPayload(supplierRes.raw);

    // 8. Handle Supplier Outcome
    const isCompletedStatus =
      supplierRes.status === 'completed' || (supplierRes.status === 'replayed' && delivered.length > 0);

    if (isCompletedStatus) {
      // Never mark non-email instant delivery orders COMPLETED without actual delivered items
      const missingDeliveryEvidence =
        (!product.requires_email && delivered.length === 0) ||
        (delivered.length === 0 && !supplierRes.order_ref);

      if (missingDeliveryEvidence) {
        const msg = 'Supplier returned completion status without delivery payload; marked UNCERTAIN for reconciliation.';
        await db.withTransaction(async (client) => {
          await client.query(
            "UPDATE local_orders SET status = 'UNCERTAIN', error_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
            [msg, orderId]
          );
          await client.query(`
            INSERT INTO supplier_orders (id, local_order_id, supplier_order_ref, idempotency_key, supplier_status, response_payload)
            VALUES ($1, $2, $3, $4, 'UNCERTAIN_MISSING_DELIVERY', $5)
          `, [`so_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, orderId, supplierRes.order_ref || null, idempotencyKey, sanitizedRawPayload]);
        });
        return {
          success: false,
          orderId,
          status: 'UNCERTAIN',
          message: 'Supplier did not include delivery credentials. Marked for reconciliation without premature refund.',
          deliveredItems: [],
          totalCharged: totalCharge.toFixed(2),
        };
      }

      await db.withTransaction(async (client) => {
        await client.query("UPDATE local_orders SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [orderId]);
        await client.query(`
          INSERT INTO supplier_orders (id, local_order_id, supplier_order_ref, idempotency_key, supplier_status, response_payload)
          VALUES ($1, $2, $3, $4, 'COMPLETED', $5)
        `, [`so_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, orderId, supplierRes.order_ref || null, idempotencyKey, sanitizedRawPayload]);

        for (const item of delivered) {
          const encryptedContent = encryptionService.encrypt(item);
          await client.query(`
            INSERT INTO delivered_items (id, local_order_id, user_id, content, item_type)
            VALUES ($1, $2, $3, $4, 'credentials')
          `, [`del_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`, orderId, request.userId, encryptedContent]);
        }
      });

      await referralService.processOrderQualification(request.userId, orderId, totalCharge);

      return {
        success: true,
        orderId,
        status: 'COMPLETED',
        message: 'Your order has been completed and delivered instantly!',
        deliveredItems: delivered,
        totalCharged: totalCharge.toFixed(2),
      };
    }

    const isPendingInviteStatus =
      supplierRes.status === 'pending_invite' ||
      supplierRes.status === 'pending' ||
      (supplierRes.status === 'replayed' && delivered.length === 0 && Boolean(supplierRes.order_ref));

    if (isPendingInviteStatus) {
      await db.withTransaction(async (client) => {
        await client.query("UPDATE local_orders SET status = 'PENDING_INVITE', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [orderId]);
        await client.query(`
          INSERT INTO supplier_orders (id, local_order_id, supplier_order_ref, idempotency_key, supplier_status, response_payload)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [`so_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, orderId, supplierRes.order_ref || null, idempotencyKey, supplierRes.status, sanitizedRawPayload]);
      });

      await referralService.processOrderQualification(request.userId, orderId, totalCharge);

      return {
        success: true,
        orderId,
        status: 'PENDING_INVITE',
        message: 'Order placed with supplier! Your access/invite is being processed and will be delivered shortly.',
        deliveredItems: [],
        totalCharged: totalCharge.toFixed(2),
      };
    }

    // Only refund automatically when supplier definitely rejected without ambiguous/timeout uncertainty
    const isUncertainFailure = Boolean(supplierRes.error_code && supplierRes.error_code.startsWith('UNCERTAIN'));
    if (supplierRes.status === 'failed' && !isUncertainFailure) {
      await db.withTransaction(async (client) => {
        await client.query("UPDATE local_orders SET status = 'FAILED', error_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [
          supplierRes.message,
          orderId,
        ]);

        await walletService.executeMutation({
          userId: request.userId,
          amount: totalCharge,
          operationRef: `REFUND_${orderId}`,
          idempotencyKey: `REFUND_${orderId}`,
          entryType: 'REFUND',
          reason: `Automatic refund: supplier order rejected (${supplierRes.error_code})`,
          source: 'SUPPLIER_REJECTION',
          actor: 'SYSTEM',
          metadata: { orderId, errorCode: supplierRes.error_code },
          client,
        });
      });

      return {
        success: false,
        orderId,
        status: 'FAILED',
        message: `Order could not be fulfilled (${supplierRes.message}). Your wallet has been refunded ${totalCharge.toFixed(2)} USDT automatically.`,
        deliveredItems: [],
        totalCharged: '0.00',
      };
    }

    // Uncertain outcome: mark UNCERTAIN, record supplier_order_ref if returned, do NOT issue duplicate order or premature refund
    await db.withTransaction(async (client) => {
      await client.query(
        "UPDATE local_orders SET status = 'UNCERTAIN', error_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
        [supplierRes.message || 'Ambiguous supplier outcome', orderId]
      );
      if (supplierRes.order_ref) {
        await client.query(
          `INSERT INTO supplier_orders (id, local_order_id, supplier_order_ref, idempotency_key, supplier_status, response_payload)
           VALUES ($1, $2, $3, $4, 'UNCERTAIN', $5)
           ON CONFLICT (local_order_id) DO UPDATE
           SET supplier_order_ref = COALESCE(supplier_orders.supplier_order_ref, EXCLUDED.supplier_order_ref),
               supplier_status = 'UNCERTAIN',
               response_payload = EXCLUDED.response_payload,
               updated_at = CURRENT_TIMESTAMP`,
          [`so_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, orderId, supplierRes.order_ref, idempotencyKey, sanitizedRawPayload]
        );
      }
    });
    return {
      success: false,
      orderId,
      status: 'UNCERTAIN',
      message: 'Supplier order outcome is uncertain and requires reconciliation. No duplicate order was sent and no premature refund was issued.',
      deliveredItems: [],
      totalCharged: totalCharge.toFixed(2),
    };
  }

  /**
   * Read-only reconciliation for UNCERTAIN / in-progress orders using stored
   * supplier_order_ref and idempotency_key via GET /order/:ref and GET /orders.
   *
   * Safety guarantees:
   * - NEVER blindly repeats POST /order after a timeout or ambiguous response.
   * - Terminal COMPLETED returns decrypted items with zero extra debit.
   * - Terminal FAILED / REFUNDED blocks retry & refund replay.
   * - Confirmed supplier completion encrypts delivery items (AES-256-GCM v1),
   *   records supplier result, and completes local order without debiting wallet again.
   * - Confirmed deterministic supplier failure triggers the audited refund path once.
   * - Not found, still pending, or lookup error keeps order under review without
   *   reordering and without premature refund.
   */
  public async retryOrder(orderId: string): Promise<{
    success: boolean;
    orderId: string;
    idempotencyKey: string;
    status: OrderDetails['status'];
    message: string;
    deliveredItems: string[];
  }> {
    return await this.serializeCheckout(`reconcile:${orderId}`, async () => {
      const precheck = await db.queryRow<any>('SELECT * FROM local_orders WHERE id = $1', [orderId]);
      if (!precheck) {
        throw new Error(`Order ${orderId} not found`);
      }

      const preSupplierOrder = await db.queryRow<any>(
        'SELECT supplier_order_ref, idempotency_key FROM supplier_orders WHERE local_order_id = $1',
        [orderId]
      );
      const idempotencyKey: string = preSupplierOrder?.idempotency_key || precheck.idempotency_key;
      const supplierOrderRef: string | null = preSupplierOrder?.supplier_order_ref || null;

      if (precheck.status === 'COMPLETED') {
        const delivered = await this.decryptOrderItems(orderId);
        return {
          success: true,
          orderId,
          idempotencyKey,
          status: 'COMPLETED',
          message: 'Order already completed.',
          deliveredItems: delivered,
        };
      }

      // Never allow retrying/refunding a terminal FAILED or REFUNDED order
      if (precheck.status === 'FAILED' || precheck.status === 'REFUNDED') {
        return {
          success: false,
          orderId,
          idempotencyKey,
          status: precheck.status,
          message: 'Cannot retry an order that already failed or was refunded.',
          deliveredItems: [],
        };
      }

      if (!supplierService.hasOrderStatusLookup()) {
        logger.warn('Blocked blind POST /order retry because supplier has no documented order-status lookup endpoint', {
          orderId,
          status: precheck.status,
          idempotencyKey,
        });
        return {
          success: false,
          orderId,
          idempotencyKey,
          status: 'UNCERTAIN',
          message: 'Supplier order-status lookup endpoint is unavailable; blind POST /order retry blocked to prevent duplicate fulfillment.',
          deliveredItems: [],
        };
      }

      const product = await db.queryRow<any>(
        'SELECT * FROM supplier_products WHERE id = $1',
        [precheck.product_id]
      );

      // Read-only supplier reconciliation (GET /order/:ref then GET /orders) — NEVER POST /order
      const lookup = await supplierService.lookupOrderReadOnly({
        supplierOrderRef,
        idempotencyKey,
      });

      const sanitizedRawPayload = sanitizeSupplierPayload(lookup.raw);
      let qualificationPending = false;
      let qualificationUserId = '';
      let qualificationAmount = new Decimal(0);

      const outcome = await db.withTransaction(async (client) => {
        const localOrder = await client.queryRow<any>(
          'SELECT * FROM local_orders WHERE id = $1 FOR UPDATE',
          [orderId]
        );
        if (!localOrder) {
          throw new Error(`Order ${orderId} not found`);
        }

        if (localOrder.status === 'COMPLETED') {
          const items = await client.query<{ content: string }>(
            'SELECT content FROM delivered_items WHERE local_order_id = $1',
            [orderId]
          );
          const delivered = items.rows.map(i => {
            try {
              return encryptionService.decrypt(i.content);
            } catch {
              return '[ENCRYPTED_DATA]';
            }
          });
          return {
            success: true,
            orderId,
            idempotencyKey,
            status: 'COMPLETED' as const,
            message: 'Order already completed.',
            deliveredItems: delivered,
          };
        }

        if (localOrder.status === 'FAILED' || localOrder.status === 'REFUNDED') {
          return {
            success: false,
            orderId,
            idempotencyKey,
            status: localOrder.status as OrderDetails['status'],
            message: 'Cannot retry an order that already failed or was refunded.',
            deliveredItems: [],
          };
        }

        const resolvedRef = lookup.order_ref || supplierOrderRef || null;

        // 1) Confirmed completion via read-only lookup
        if (lookup.status === 'completed') {
          const delivered = lookup.delivered_items || [];
          const requiresEmail = Boolean(product?.requires_email);
          const missingDeliveryEvidence =
            (!requiresEmail && delivered.length === 0) ||
            (delivered.length === 0 && !resolvedRef);

          if (missingDeliveryEvidence) {
            const msg = 'Supplier lookup reported completed status without delivery credentials; kept under review.';
            await client.query(
              "UPDATE local_orders SET status = 'UNCERTAIN', error_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
              [msg, orderId]
            );
            await client.query(
              `INSERT INTO supplier_orders (id, local_order_id, supplier_order_ref, idempotency_key, supplier_status, response_payload)
               VALUES ($1, $2, $3, $4, 'UNCERTAIN_MISSING_DELIVERY', $5)
               ON CONFLICT (local_order_id) DO UPDATE
               SET supplier_order_ref = COALESCE(EXCLUDED.supplier_order_ref, supplier_orders.supplier_order_ref),
                   supplier_status = 'UNCERTAIN_MISSING_DELIVERY',
                   response_payload = EXCLUDED.response_payload,
                   updated_at = CURRENT_TIMESTAMP`,
              [`so_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, orderId, resolvedRef, idempotencyKey, sanitizedRawPayload]
            );
            return {
              success: false,
              orderId,
              idempotencyKey,
              status: 'UNCERTAIN' as const,
              message: msg,
              deliveredItems: [],
            };
          }

          await client.query(
            "UPDATE local_orders SET status = 'COMPLETED', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
            [orderId]
          );
          await client.query(
            `INSERT INTO supplier_orders (id, local_order_id, supplier_order_ref, idempotency_key, supplier_status, response_payload)
             VALUES ($1, $2, $3, $4, 'COMPLETED', $5)
             ON CONFLICT (local_order_id) DO UPDATE
             SET supplier_order_ref = COALESCE(EXCLUDED.supplier_order_ref, supplier_orders.supplier_order_ref),
                 supplier_status = 'COMPLETED',
                 response_payload = EXCLUDED.response_payload,
                 updated_at = CURRENT_TIMESTAMP`,
            [`so_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, orderId, resolvedRef, idempotencyKey, sanitizedRawPayload]
          );

          const existingDelivered = await client.query<{ content: string }>(
            'SELECT content FROM delivered_items WHERE local_order_id = $1',
            [orderId]
          );

          let finalDelivered: string[] = [];
          if (existingDelivered.rows.length === 0) {
            for (const item of delivered) {
              const encryptedContent = encryptionService.encrypt(item);
              await client.query(
                `INSERT INTO delivered_items (id, local_order_id, user_id, content, item_type)
                 VALUES ($1, $2, $3, $4, 'credentials')`,
                [`del_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`, orderId, localOrder.user_id, encryptedContent]
              );
            }
            finalDelivered = delivered;
          } else {
            finalDelivered = existingDelivered.rows.map(i => {
              try {
                return encryptionService.decrypt(i.content);
              } catch {
                return '[ENCRYPTED_DATA]';
              }
            });
          }

          qualificationPending = true;
          qualificationUserId = localOrder.user_id;
          qualificationAmount = new Decimal(localOrder.total_price || 0);

          return {
            success: true,
            orderId,
            idempotencyKey,
            status: 'COMPLETED' as const,
            message: 'Order verified via read-only supplier lookup and completed without duplicate wallet debit.',
            deliveredItems: finalDelivered,
          };
        }

        // 2) Confirmed deterministic failure via read-only lookup -> refund ONCE
        if (lookup.status === 'failed') {
          const failureReason =
            lookup.message ||
            `Supplier confirmed deterministic failure (${lookup.error_code || 'FAILED'}) via ${lookup.lookupMethod}`;

          await client.query(
            "UPDATE local_orders SET status = 'FAILED', error_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
            [failureReason, orderId]
          );
          await client.query(
            `INSERT INTO supplier_orders (id, local_order_id, supplier_order_ref, idempotency_key, supplier_status, response_payload)
             VALUES ($1, $2, $3, $4, 'FAILED', $5)
             ON CONFLICT (local_order_id) DO UPDATE
             SET supplier_order_ref = COALESCE(EXCLUDED.supplier_order_ref, supplier_orders.supplier_order_ref),
                 supplier_status = 'FAILED',
                 response_payload = EXCLUDED.response_payload,
                 updated_at = CURRENT_TIMESTAMP`,
            [`so_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, orderId, resolvedRef, idempotencyKey, sanitizedRawPayload]
          );

          await walletService.executeMutation({
            userId: localOrder.user_id,
            amount: new Decimal(localOrder.total_price || 0),
            operationRef: `REFUND_${orderId}`,
            idempotencyKey: `REFUND_${orderId}`,
            entryType: 'REFUND',
            reason: `Reconciled refund: supplier confirmed order failure (${lookup.error_code || 'SUPPLIER_FAILED'})`,
            source: 'SUPPLIER_RECONCILIATION',
            actor: 'SYSTEM',
            metadata: {
              orderId,
              lookupMethod: lookup.lookupMethod,
              supplierOrderRef: resolvedRef,
              errorCode: lookup.error_code || 'SUPPLIER_FAILED',
            },
            client,
          });

          return {
            success: false,
            orderId,
            idempotencyKey,
            status: 'FAILED' as const,
            message: `Supplier confirmed failure (${failureReason}). Wallet refunded once.`,
            deliveredItems: [],
          };
        }

        // 3) Pending invite confirmed by supplier
        if (lookup.status === 'pending_invite') {
          await client.query(
            "UPDATE local_orders SET status = 'PENDING_INVITE', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
            [orderId]
          );
          await client.query(
            `INSERT INTO supplier_orders (id, local_order_id, supplier_order_ref, idempotency_key, supplier_status, response_payload)
             VALUES ($1, $2, $3, $4, 'pending_invite', $5)
             ON CONFLICT (local_order_id) DO UPDATE
             SET supplier_order_ref = COALESCE(EXCLUDED.supplier_order_ref, supplier_orders.supplier_order_ref),
                 supplier_status = 'pending_invite',
                 response_payload = EXCLUDED.response_payload,
                 updated_at = CURRENT_TIMESTAMP`,
            [`so_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, orderId, resolvedRef, idempotencyKey, sanitizedRawPayload]
          );
          return {
            success: true,
            orderId,
            idempotencyKey,
            status: 'PENDING_INVITE' as const,
            message: 'Order is awaiting supplier invite delivery.',
            deliveredItems: [],
          };
        }

        // 4) Not found, still pending, or transient lookup error -> keep under review (NO reorder, NO refund)
        if (resolvedRef) {
          await client.query(
            `INSERT INTO supplier_orders (id, local_order_id, supplier_order_ref, idempotency_key, supplier_status, response_payload)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (local_order_id) DO UPDATE
             SET supplier_order_ref = COALESCE(EXCLUDED.supplier_order_ref, supplier_orders.supplier_order_ref),
                 supplier_status = EXCLUDED.supplier_status,
                 response_payload = CASE WHEN EXCLUDED.response_payload = '{}' THEN supplier_orders.response_payload ELSE EXCLUDED.response_payload END,
                 updated_at = CURRENT_TIMESTAMP`,
            [
              `so_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
              orderId,
              resolvedRef,
              idempotencyKey,
              lookup.status.toUpperCase(),
              sanitizedRawPayload,
            ]
          );
        }

        if (localOrder.status === 'PENDING_INVITE') {
          return {
            success: true,
            orderId,
            idempotencyKey,
            status: 'PENDING_INVITE' as const,
            message: 'Order is awaiting supplier invite delivery.',
            deliveredItems: [],
          };
        }

        const reviewNote =
          lookup.status === 'not_found'
            ? 'Order not found at supplier during read-only lookup; kept UNCERTAIN under review without reorder or refund.'
            : lookup.status === 'pending'
            ? 'Supplier still reports order as pending; kept UNCERTAIN under review without reorder or refund.'
            : lookup.message || 'Read-only supplier lookup inconclusive; kept UNCERTAIN under review.';

        await client.query(
          "UPDATE local_orders SET status = 'UNCERTAIN', error_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
          [reviewNote, orderId]
        );

        return {
          success: false,
          orderId,
          idempotencyKey,
          status: 'UNCERTAIN' as const,
          message: reviewNote,
          deliveredItems: [],
        };
      });

      if (qualificationPending && qualificationUserId) {
        await referralService.processOrderQualification(qualificationUserId, orderId, qualificationAmount);
      }

      return outcome;
    });
  }

  /**
   * Reconcile an order marked UNCERTAIN using read-only GET /order/:ref & GET /orders
   * with its stored supplier_order_ref / idempotency_key.
   */
  public async reconcileUncertainOrder(orderId: string): Promise<{
    orderId: string;
    idempotencyKey: string;
    status: OrderDetails['status'];
  }> {
    const res = await this.retryOrder(orderId);
    return {
      orderId: res.orderId,
      idempotencyKey: res.idempotencyKey,
      status: res.status,
    };
  }

  /**
   * Retrieve delivered credentials for an order with strict authorization check.
   * Only the owning customer or authorized administrator can access.
   */
  public async getOrderCredentials(
    orderId: string,
    requesterUserId: string,
    isAdmin = false
  ): Promise<string[]> {
    const order = await db.queryRow<any>(
      'SELECT user_id FROM local_orders WHERE id = $1',
      [orderId]
    );

    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (order.user_id !== requesterUserId && !isAdmin) {
      throw new Error('Access denied: Only the owning customer or authorized administrator can view delivered credentials.');
    }

    const itemsRes = await db.query<{ content: string }>(
      'SELECT content FROM delivered_items WHERE local_order_id = $1',
      [orderId]
    );

    return itemsRes.rows.map(i => {
      try {
        return encryptionService.decrypt(i.content);
      } catch {
        return '[ENCRYPTED_DATA]';
      }
    });
  }

  /**
   * Get customer order history with authorization filtering
   */
  public async getCustomerOrders(
    userId: string,
    limitOrRequester: number | string = 10,
    isAdmin = false,
    limit = 10
  ): Promise<OrderDetails[]> {
    let effectiveLimit = limit;
    let requesterUserId = userId;

    if (typeof limitOrRequester === 'number') {
      effectiveLimit = limitOrRequester;
    } else if (typeof limitOrRequester === 'string') {
      requesterUserId = limitOrRequester;
    }

    if (requesterUserId && requesterUserId !== userId && !isAdmin) {
      throw new Error('Access denied: You can only view your own order history.');
    }

    const res = await db.query<any>(`
      SELECT lo.id, lo.user_id as "userId", lo.product_id as "productId",
             sp.original_name as "productName", lo.quantity,
             lo.unit_price as "unitPrice", lo.total_price as "totalPrice",
             lo.supplier_cost as "supplierCost", lo.customer_email as "customerEmail",
             lo.status, lo.created_at as "createdAt"
      FROM local_orders lo
      JOIN supplier_products sp ON lo.product_id = sp.id
      WHERE lo.user_id = $1
      ORDER BY lo.created_at DESC
      LIMIT $2
    `, [userId, effectiveLimit]);

    const orders: OrderDetails[] = [];
    for (const r of res.rows) {
      const itemsRes = await db.query<{ content: string }>(
        'SELECT content FROM delivered_items WHERE local_order_id = $1 AND user_id = $2',
        [r.id, userId]
      );
      orders.push({
        id: r.id,
        userId: r.userId,
        productId: r.productId,
        productName: r.productName,
        quantity: r.quantity,
        unitPrice: new Decimal(r.unitPrice).toFixed(2),
        totalPrice: new Decimal(r.totalPrice).toFixed(2),
        supplierCost: new Decimal(r.supplierCost).toFixed(4),
        customerEmail: r.customerEmail,
        status: r.status,
        deliveredItems: itemsRes.rows.map(i => {
          try {
            return encryptionService.decrypt(i.content);
          } catch {
            return '[ENCRYPTED_DATA]';
          }
        }),
        createdAt: r.createdAt,
      });
    }

    return orders;
  }
}

export const orderService = new OrderService();
