import Decimal from 'decimal.js';
import { db } from '../db/index.js';
import { pricingService } from './pricing.js';
import { walletService } from './wallet.js';
import { supplierService } from './supplier.js';
import { referralService } from './referral.js';
import { encryptionService } from './encryption.js';
import { createLogger } from './logger.js';

const logger = createLogger('OrderService');

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export interface CheckoutRequest {
  userId: string;
  productId: string;
  quantity: number;
  customerEmail?: string;
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
  /**
   * Complete checkout flow:
   * 1. Revalidate product, stock, and supplier cost
   * 2. Snapshot customer retail price and calculate total charge
   * 3. Validate email if product requires email
   * 4. Check wallet funds
   * 5. Atomically debit wallet via immutable ledger
   * 6. Create local order record with unique idempotency key
   * 7. Dispatch to supplier POST /order
   * 8. Process supplier response (COMPLETED -> deliver items, PENDING_INVITE -> pending delivery, FAILED -> refund)
   */
  public async checkout(request: CheckoutRequest): Promise<{
    success: boolean;
    orderId: string;
    status: OrderDetails['status'];
    message: string;
    deliveredItems: string[];
    totalCharged: string;
  }> {
    const qty = Math.max(1, Math.floor(request.quantity));

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

    // 3. Snapshot price
    const priceSnapshot = await pricingService.calculatePrice(product.id);
    const unitPrice = priceSnapshot.customerUnitPrice;
    const supplierUnitCost = priceSnapshot.supplierCost;
    const totalCharge = unitPrice.times(qty);
    const totalCost = supplierUnitCost.times(qty);

    // 4. Check wallet balance
    const { available } = await walletService.getBalance(request.userId);
    if (available.lessThan(totalCharge)) {
      throw new Error(`Insufficient wallet balance. Total: ${totalCharge.toFixed(2)} USDT, Available: ${available.toFixed(2)} USDT. Please Add Funds first.`);
    }

    const orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const idempotencyKey = `SUPPLIER_ORD_${orderId}`;

    // 5. Atomic Debit & Local Order Creation
    await db.withTransaction(async (client) => {
      // Create local order in PENDING status
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

      // Debit wallet with immutable ledger entry
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
      });
    });

    // 6. Call Supplier Reseller API
    const supplierRes = await supplierService.placeOrder({
      product_id: product.supplier_product_id,
      quantity: qty,
      customer_email: request.customerEmail,
      idempotency_key: idempotencyKey,
    });

    // 7. Handle Supplier Outcome
    if (supplierRes.status === 'completed') {
      const delivered = supplierRes.delivered_items || [];
      await db.withTransaction(async (client) => {
        await client.query("UPDATE local_orders SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [orderId]);
        await client.query(`
          INSERT INTO supplier_orders (id, local_order_id, supplier_order_ref, idempotency_key, supplier_status, response_payload)
          VALUES ($1, $2, $3, $4, 'COMPLETED', $5)
        `, [`so_${Date.now()}`, orderId, supplierRes.order_ref || null, idempotencyKey, JSON.stringify(supplierRes.raw || {})]);

        // Insert authenticated encrypted delivered items
        for (const item of delivered) {
          const encryptedContent = encryptionService.encrypt(item);
          await client.query(`
            INSERT INTO delivered_items (id, local_order_id, user_id, content, item_type)
            VALUES ($1, $2, $3, $4, 'credentials')
          `, [`del_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`, orderId, request.userId, encryptedContent]);
        }
      });

      // Check referral qualification trigger
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

    if (supplierRes.status === 'pending_invite' || supplierRes.status === 'pending') {
      await db.withTransaction(async (client) => {
        await client.query("UPDATE local_orders SET status = 'PENDING_INVITE', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [orderId]);
        await client.query(`
          INSERT INTO supplier_orders (id, local_order_id, supplier_order_ref, idempotency_key, supplier_status, response_payload)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [`so_${Date.now()}`, orderId, supplierRes.order_ref || null, idempotencyKey, supplierRes.status, JSON.stringify(supplierRes.raw || {})]);
      });

      // Still counts towards referral qualification if approved
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

    // If order definitely failed without charging at supplier: refund customer wallet
    if (supplierRes.status === 'failed' && supplierRes.error_code !== 'UNCERTAIN_TIMEOUT') {
      await db.withTransaction(async (client) => {
        await client.query("UPDATE local_orders SET status = 'FAILED', error_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [
          supplierRes.message,
          orderId,
        ]);

        // Atomic refund via immutable ledger
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

    // Uncertain outcome: mark UNCERTAIN, do NOT issue duplicate order or premature refund
    await db.query("UPDATE local_orders SET status = 'UNCERTAIN', error_message = $1 WHERE id = $2", [supplierRes.message, orderId]);
    return {
      success: false,
      orderId,
      status: 'UNCERTAIN',
      message: 'Supplier order request is undergoing automated reconciliation. Please check My Orders shortly.',
      deliveredItems: [],
      totalCharged: totalCharge.toFixed(2),
    };
  }

  /**
   * Retry an unfulfilled or timeout order using the ONE stored persistent idempotency key.
   * Never generates a new idempotency key.
   * Row locking protects against concurrent workers.
   */
  public async retryOrder(orderId: string): Promise<{
    success: boolean;
    orderId: string;
    idempotencyKey: string;
    status: OrderDetails['status'];
    message: string;
    deliveredItems: string[];
  }> {
    return await db.withTransaction(async (client) => {
      // 1. Lock order row to ensure exclusive retry handling among concurrent workers
      const localOrder = await client.queryRow<any>(
        'SELECT * FROM local_orders WHERE id = $1 FOR UPDATE',
        [orderId]
      );

      if (!localOrder) {
        throw new Error(`Order ${orderId} not found`);
      }

      // Re-use the EXACT persistent idempotency key stored in PostgreSQL
      const idempotencyKey = localOrder.idempotency_key;

      // If already completed by another worker/process, return existing delivered items safely
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
          status: 'COMPLETED',
          message: 'Order already completed by concurrent worker.',
          deliveredItems: delivered,
        };
      }

      // Fetch supplier product details
      const product = await client.queryRow<any>(
        'SELECT * FROM supplier_products WHERE id = $1',
        [localOrder.product_id]
      );

      if (!product) {
        throw new Error(`Product ${localOrder.product_id} not found`);
      }

      // Call supplier with the EXACT SAME persistent idempotency key
      const supplierRes = await supplierService.placeOrder({
        product_id: product.supplier_product_id,
        quantity: localOrder.quantity,
        customer_email: localOrder.customer_email,
        idempotency_key: idempotencyKey, // Guaranteed same key
      });

      if (supplierRes.status === 'completed') {
        const delivered = supplierRes.delivered_items || [];
        await client.query("UPDATE local_orders SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [orderId]);
        await client.query(`
          INSERT INTO supplier_orders (id, local_order_id, supplier_order_ref, idempotency_key, supplier_status, response_payload)
          VALUES ($1, $2, $3, $4, 'COMPLETED', $5)
          ON CONFLICT (local_order_id) DO UPDATE SET supplier_status = 'COMPLETED', response_payload = $5, updated_at = CURRENT_TIMESTAMP
        `, [`so_${Date.now()}`, orderId, supplierRes.order_ref || null, idempotencyKey, JSON.stringify(supplierRes.raw || {})]);

        for (const item of delivered) {
          const encryptedContent = encryptionService.encrypt(item);
          await client.query(`
            INSERT INTO delivered_items (id, local_order_id, user_id, content, item_type)
            VALUES ($1, $2, $3, $4, 'credentials')
          `, [`del_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`, orderId, localOrder.user_id, encryptedContent]);
        }

        return {
          success: true,
          orderId,
          idempotencyKey,
          status: 'COMPLETED',
          message: 'Order retry completed successfully.',
          deliveredItems: delivered,
        };
      }

      if (supplierRes.status === 'pending_invite' || supplierRes.status === 'pending') {
        await client.query("UPDATE local_orders SET status = 'PENDING_INVITE', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [orderId]);
        return {
          success: true,
          orderId,
          idempotencyKey,
          status: 'PENDING_INVITE',
          message: 'Order retry pending invite.',
          deliveredItems: [],
        };
      }

      // If supplier definitely failed, refund
      if (supplierRes.status === 'failed' && supplierRes.error_code !== 'UNCERTAIN_TIMEOUT') {
        await client.query("UPDATE local_orders SET status = 'FAILED', error_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [
          supplierRes.message,
          orderId,
        ]);
        await walletService.executeMutation({
          userId: localOrder.user_id,
          amount: new Decimal(localOrder.total_price),
          operationRef: `REFUND_${orderId}`,
          idempotencyKey: `REFUND_${orderId}`,
          entryType: 'REFUND',
          reason: `Automatic refund on order retry: ${supplierRes.message}`,
          source: 'SUPPLIER_RETRY_REJECTION',
          actor: 'SYSTEM',
          metadata: { orderId, errorCode: supplierRes.error_code },
        });

        return {
          success: false,
          orderId,
          idempotencyKey,
          status: 'FAILED',
          message: `Order retry failed: ${supplierRes.message}`,
          deliveredItems: [],
        };
      }

      // Still uncertain
      return {
        success: false,
        orderId,
        idempotencyKey,
        status: 'UNCERTAIN',
        message: 'Order remains uncertain.',
        deliveredItems: [],
      };
    });
  }

  /**
   * Reconcile an order marked UNCERTAIN using its persistent idempotency key.
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
