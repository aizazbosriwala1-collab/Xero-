import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';
import { config, getSanitizedConfig } from '../config/env.js';
import { telegramBotRouter } from '../telegram/bot.js';
import { pricingService } from '../services/pricing.js';
import { supplierService } from '../services/supplier.js';
import { manualPaymentService } from '../services/manualPayment.js';
import { binanceService } from '../services/binance.js';
import { walletService } from '../services/wallet.js';
import { giveawayService } from '../services/giveaway.js';
import { createLogger } from '../services/logger.js';

const logger = createLogger('ApiRoutes');
export const apiRouter = Router();

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

// Telegram Browser Simulator endpoint (for testing customer & admin bot in UI)
apiRouter.post('/api/telegram/simulate', async (req: Request, res: Response) => {
  try {
    const update = req.body;
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
apiRouter.post('/api/admin/price', async (req: Request, res: Response) => {
  try {
    const { productId, type, value, adminId } = req.body;
    const admin = adminId || 'ADMIN_API';

    if (type === 'fixed_price') {
      await pricingService.setFixedRetailPrice(productId, value, admin);
    } else if (type === 'fixed_markup') {
      await pricingService.setFixedMarkup(productId, value, admin);
    } else if (type === 'reset') {
      await pricingService.resetPricing(productId, admin);
    } else {
      res.status(400).json({ error: 'Invalid pricing update type' });
      return;
    }

    const updated = await pricingService.calculatePrice(productId);
    res.json({ success: true, updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Trigger Supplier Sync
apiRouter.post('/api/admin/sync', async (_req: Request, res: Response) => {
  try {
    const result = await supplierService.syncCatalogue();
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Review Manual Deposits
apiRouter.get('/api/admin/deposits', async (_req: Request, res: Response) => {
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
apiRouter.post('/api/admin/deposits/:id/approve', async (req: Request, res: Response) => {
  try {
    const { adminId, notes } = req.body;
    const result = await manualPaymentService.approveDeposit(req.params.id, adminId || 'ADMIN_API', notes);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Reject Deposit
apiRouter.post('/api/admin/deposits/:id/reject', async (req: Request, res: Response) => {
  try {
    const { adminId, reason } = req.body;
    await manualPaymentService.rejectDeposit(req.params.id, adminId || 'ADMIN_API', reason || 'Rejected by admin');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Binance: Run Read-only Diagnostics
apiRouter.get('/api/binance/diagnostics', async (_req: Request, res: Response) => {
  try {
    const diagnostics = await binanceService.testReadOnlyVerification();
    res.json(diagnostics);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Wallet & Ledger history
apiRouter.get('/api/wallet/:userId', async (req: Request, res: Response) => {
  try {
    const wallet = await walletService.getBalance(req.params.userId);
    const history = await walletService.getHistory(req.params.userId, 20);
    const reconciliation = await walletService.reconcile(req.params.userId);
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
