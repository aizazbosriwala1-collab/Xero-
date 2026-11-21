import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db/index.js';
import { config, getSanitizedConfig } from '../config/env.js';
import { telegramBotRouter } from '../telegram/bot.js';
import { pricingService } from '../services/pricing.js';
import { supplierService } from '../services/supplier.js';
import { NyStoreDriver } from '../services/supplierDrivers.js';
import { orderService } from '../services/order.js';
import { manualPaymentService } from '../services/manualPayment.js';
import { binanceService } from '../services/binance.js';
import { walletService } from '../services/wallet.js';
import { giveawayService } from '../services/giveaway.js';
import { createLogger } from '../services/logger.js';

const logger = createLogger('ApiRoutes');
export const apiRouter = Router();

function timingSafeEqualSecret(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

function extractAdminToken(req: Request): string {
  const headerSecret = typeof req.headers['x-admin-api-secret'] === 'string'
    ? req.headers['x-admin-api-secret'].trim()
    : '';
  if (headerSecret) return headerSecret;

  const authHeader = typeof req.headers.authorization === 'string'
    ? req.headers.authorization.trim()
    : '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

export function requireAdminApiAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredSecret = config.adminApiSecret;
  const isProd = (process.env.NODE_ENV || config.nodeEnv) === 'production';

  if (!configuredSecret) {
    if (isProd) {
      res.status(503).json({
        error: 'Admin API routes are disabled in production until ADMIN_API_SECRET is configured.',
      });
      return;
    }
    next();
    return;
  }

  const provided = extractAdminToken(req);
  if (!provided || !timingSafeEqualSecret(provided, configuredSecret)) {
    res.status(401).json({ error: 'Unauthorized: valid admin authorization is required.' });
    return;
  }

  next();
}

// Health check for Railway and orchestrators
apiRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness check
apiRouter.get('/ready', async (_req: Request, res: Response) => {
  try {
    await db.query('SELECT 1');
    res.status(200).json({ ready: true, database: 'connected' });
  } catch (err: any) {
    res.status(503).json({ ready: false, database: 'error', error: err.message });
  }
});

// System Diagnostics & Info
apiRouter.get('/api/health', async (_req: Request, res: Response) => {
  try {
    const dbOk = await db.query('SELECT 1').then(() => true).catch(() => false);
    const binanceTest = await binanceService.testReadOnlyVerification();
    const configSanitized = getSanitizedConfig();

    res.json({
      status: dbOk ? 'healthy' : 'degraded',
      database: dbOk ? 'connected' : 'disconnected',
      isInMemoryDb: db.getIsInMemory(),
      config: configSanitized,
      binanceStatus: binanceTest,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Telegram Official Webhook Endpoint
apiRouter.post('/api/telegram/webhook', async (req: Request, res: Response) => {
  const secretHeader = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
  try {
    const result = await telegramBotRouter.handleUpdate(req.body, secretHeader);
    if (!result.ok && result.status === 'UNAUTHORIZED') {
      res.status(401).json({ error: 'Unauthorized secret token' });
      return;
    }
    res.status(200).json({ ok: true, status: result.status });
  } catch (err: any) {
    logger.error('Webhook error', { error: err.message });
    // Always return 200 to Telegram to prevent retry storms on bad payloads
    res.status(200).json({ ok: true, error: err.message });
  }
});

/**
 * Shared NyStore webhook verification & reconciliation handler.
 */
export async function handleNyStoreWebhookHttp(params: {
  rawBody: string;
  body: any;
  signatureHeader?: string;
  secretHeader?: string;
}): Promise<{ statusCode: number; payload: Record<string, any> }> {
  const expectedSecret = supplierService.getSupplierWebhookSecret('nystore') || config.suppliers.nystore.webhookSecret;
  const authorized = NyStoreDriver.verifyWebhookSignature({
    rawBody: params.rawBody,
    signatureHeader: params.signatureHeader,
    secretHeader: params.secretHeader,
    expectedSecret,
  });

  if (!authorized) {
    return {
      statusCode: 401,
      payload: { ok: false, error: 'Unauthorized NyStore webhook signature' },
    };
  }

  const outcome = await orderService.processSupplierWebhook({
    supplierId: 'nystore',
    payload: params.body,
  });

  return {
    statusCode: 200,
    payload: outcome,
  };
}

// NyStore Supplier Webhook Endpoint
apiRouter.post('/api/webhooks/nystore', async (req: Request, res: Response) => {
  try {
    const rawBody = typeof (req as any).rawBody === 'string' ? (req as any).rawBody : JSON.stringify(req.body || {});
    const signatureHeader =
      (req.headers['x-nystore-signature'] as string | undefined) ||
      (req.headers['x-signature'] as string | undefined) ||
      (req.headers['x-webhook-signature'] as string | undefined) ||
      (req.headers['x-hub-signature-256'] as string | undefined);
    const secretHeader =
      (req.headers['x-webhook-secret'] as string | undefined) ||
      (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7).trim()
        : undefined);

    const out = await handleNyStoreWebhookHttp({
      rawBody,
      body: req.body,
      signatureHeader,
      secretHeader,
    });
    res.status(out.statusCode).json(out.payload);
  } catch (err: any) {
    logger.error('NyStore webhook processing error', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Telegram Browser Simulator endpoint (development/authorized admin only)
apiRouter.post('/api/telegram/simulate', requireAdminApiAuth, async (req: Request, res: Response) => {
  const isProd = (process.env.NODE_ENV || config.nodeEnv) === 'production';
  if (isProd) {
    res.status(403).json({ success: false, error: 'Telegram simulator endpoint is disabled in production.' });
    return;
  }
  try {
    const update = req.body;
    if (!update || typeof update !== 'object') {
      res.status(400).json({ success: false, error: 'Invalid Telegram update payload.' });
      return;
    }
    const result = await telegramBotRouter.handleUpdate(update);
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Public / Customer Catalog
apiRouter.get('/api/catalog', async (req: Request, res: Response) => {
  try {
    const { categoryId, search, featuredOnly } = req.query;
    const catalog = await pricingService.getCatalog({
      categoryId: categoryId as string,
      search: search as string,
      featuredOnly: featuredOnly === 'true',
      includeHidden: false,
    });
    res.json(catalog);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Categories
apiRouter.get('/api/categories', async (_req: Request, res: Response) => {
  try {
    const categories = await db.query('SELECT * FROM product_categories ORDER BY display_order ASC');
    res.json(categories.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Set Product Pricing
apiRouter.post('/api/admin/price', requireAdminApiAuth, async (req: Request, res: Response) => {
  try {
    const { productId, type, value, adminId } = req.body || {};
    if (typeof productId !== 'string' || !productId.trim()) {
      res.status(400).json({ error: 'productId is required.' });
      return;
    }
    const cleanProductId = productId.trim();
    const admin = typeof adminId === 'string' && adminId.trim() ? adminId.trim() : 'ADMIN_API';

    if (type === 'fixed_price') {
      await pricingService.setFixedRetailPrice(cleanProductId, value, admin);
    } else if (type === 'fixed_markup') {
      await pricingService.setFixedMarkup(cleanProductId, value, admin);
    } else if (type === 'percent_markup') {
      await pricingService.setPercentMarkup(cleanProductId, value, admin);
    } else if (type === 'reset') {
      await pricingService.resetPricing(cleanProductId, admin);
    } else {
      res.status(400).json({ error: 'Invalid pricing update type' });
      return;
    }

    const updated = await pricingService.calculatePrice(cleanProductId);
    res.json({ success: true, updated });
  } catch (err: any) {
    const msg = String(err?.message || 'Pricing update failed');
    const isValidation = /invalid|positive|non-negative|between|not found/i.test(msg);
    res.status(isValidation ? 400 : 500).json({ error: msg });
  }
});

// Admin: Trigger Supplier Sync
apiRouter.post('/api/admin/sync', requireAdminApiAuth, async (_req: Request, res: Response) => {
  try {
    const result = await supplierService.syncCatalogue();
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Review Manual Deposits
apiRouter.get('/api/admin/deposits', requireAdminApiAuth, async (_req: Request, res: Response) => {
  try {
    const deposits = await db.query(`
      SELECT d.*, u.username, u.first_name
      FROM deposits d
      LEFT JOIN users u ON d.user_id = u.id
      ORDER BY d.created_at DESC
      LIMIT 50
    `);
    res.json(deposits.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Approve Deposit
apiRouter.post('/api/admin/deposits/:id/approve', requireAdminApiAuth, async (req: Request, res: Response) => {
  try {
    const depositId = String(req.params.id || '').trim();
    if (!depositId) {
      res.status(400).json({ error: 'Deposit ID is required.' });
      return;
    }
    const { adminId, notes } = req.body || {};
    const admin = typeof adminId === 'string' && adminId.trim() ? adminId.trim() : 'ADMIN_API';
    const result = await manualPaymentService.approveDeposit(depositId, admin, notes);
    res.json(result);
  } catch (err: any) {
    const msg = String(err?.message || 'Deposit approval failed');
    const isClientErr = /not found|cannot be approved|must be greater|exceeds|disabled|invalid/i.test(msg);
    res.status(isClientErr ? 400 : 500).json({ error: msg });
  }
});

// Admin: Reject Deposit
apiRouter.post('/api/admin/deposits/:id/reject', requireAdminApiAuth, async (req: Request, res: Response) => {
  try {
    const depositId = String(req.params.id || '').trim();
    if (!depositId) {
      res.status(400).json({ error: 'Deposit ID is required.' });
      return;
    }
    const { adminId, reason } = req.body || {};
    const admin = typeof adminId === 'string' && adminId.trim() ? adminId.trim() : 'ADMIN_API';
    await manualPaymentService.rejectDeposit(depositId, admin, typeof reason === 'string' && reason.trim() ? reason.trim() : 'Rejected by admin');
    res.json({ success: true });
  } catch (err: any) {
    const msg = String(err?.message || 'Deposit rejection failed');
    const isClientErr = /not found|cannot be rejected|only pending/i.test(msg);
    res.status(isClientErr ? 400 : 500).json({ error: msg });
  }
});

// Binance: Run Read-only Diagnostics
apiRouter.get('/api/binance/diagnostics', requireAdminApiAuth, async (_req: Request, res: Response) => {
  try {
    const diagnostics = await binanceService.testReadOnlyVerification();
    res.json(diagnostics);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Wallet & Ledger history
apiRouter.get('/api/wallet/:userId', requireAdminApiAuth, async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId || userId.length > 64) {
      res.status(400).json({ error: 'Valid userId is required.' });
      return;
    }
    const wallet = await walletService.getBalance(userId);
    const history = await walletService.getHistory(userId, 20);
    const reconciliation = await walletService.reconcile(userId);
    res.json({ wallet, history, reconciliation });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Giveaways
apiRouter.get('/api/giveaways', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string | undefined;
    const giveaways = await giveawayService.getActiveGiveaways(userId);
    res.json(giveaways);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
