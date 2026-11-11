import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, getSanitizedConfig } from './src/config/env.js';
import { createLogger } from './src/services/logger.js';
import { runMigrations, verifySchemaVersion } from './src/db/migrate.js';
import { db } from './src/db/index.js';
import { redis } from './src/services/redis.js';
import { apiRouter } from './src/api/routes.js';
import { telegramClient } from './src/telegram/client.js';
import { supplierService } from './src/services/supplier.js';
import { encryptionService } from './src/services/encryption.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('Server');

async function startServer() {
  logger.info('====================================================');
  logger.info('Starting XERO KHAN — Standalone Telegram Commerce Bot');
  logger.info('Tagline: Digital Tools. Instant Access.');
  logger.info('====================================================');

  // Validate encryption key at startup
  encryptionService.validateKeyAtStartup();
  logger.info('Delivered credentials encryption key verified (AES-256-GCM v1)');

  const sanitized = getSanitizedConfig();
  logger.info('Runtime configuration loaded safely', { config: sanitized });

  // 1. Initialize Express App
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // 2. Verify Schema or Run Idempotent Migrations if not yet applied
  try {
    const isMigrated = await verifySchemaVersion();
    if (!isMigrated) {
      logger.info('Schema not detected, running initial migrations & baseline seeds...');
      await runMigrations();
    } else {
      logger.info('Database schema verified from pre-deploy migration');
    }
  } catch (err: any) {
    logger.error('Database migration/verification error', { error: err.message });
  }

  // 3. Mount API Routes & Health endpoints
  app.use(apiRouter);

  // 4. Vite middleware (development) or Static files (production)
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      logger.info('Mounted Vite development server middleware');
    } catch (viteErr: any) {
      logger.warn('Could not mount Vite middleware, serving fallback static', { error: viteErr.message });
    }
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // 5. Bind HTTP Server to PORT first! (Prevents blocking server readiness)
  const server = http.createServer(app);
  const port = config.port;

  await new Promise<void>((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      logger.info(`XERO KHAN Server successfully bound to port ${port}`);
      logger.info(`Health check live at http://0.0.0.0:${port}/health`);
      logger.info(`Ready check live at http://0.0.0.0:${port}/ready`);
      resolve();
    });
  });

  // 6. Register Telegram Webhook (non-blocking, bounded timeout)
  if (config.telegram.webhookUrl && config.telegram.botToken) {
    logger.info('Registering Telegram Webhook with bounded timeout...', { url: config.telegram.webhookUrl });
    telegramClient.setWebhook(config.telegram.webhookUrl, config.telegram.webhookSecret)
      .then((res) => {
        if (res.ok) {
          logger.info('Telegram webhook successfully registered', { description: res.description });
        } else {
          logger.warn('Telegram webhook setup returned warning', { description: res.description });
        }
      })
      .catch((err) => {
        logger.warn('Non-blocking Telegram webhook registration error', { error: err.message });
      });
  } else {
    logger.info('Telegram webhook URL not configured. Operating in simulation / webhook-ready mode');
  }

  // 7. Non-blocking initial catalogue sync in background
  setTimeout(() => {
    supplierService.syncCatalogue()
      .then((syncRes) => {
        logger.info('Initial background catalogue synchronization finished', { total: syncRes.totalCount });
      })
      .catch((err) => {
        logger.warn('Initial catalogue sync error (reseller API or network unavailable)', { error: err.message });
      });
  }, 1000);

  // 8. Graceful Shutdown handlers
  const handleShutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);
    server.close(async () => {
      logger.info('HTTP server closed');
      try {
        await db.close();
        await redis.close();
        logger.info('Database & Redis pools released cleanly');
      } catch (err: any) {
        logger.error('Error during database cleanup', { error: err.message });
      }
      process.exit(0);
    });

    // Force close after 10s if stuck
    setTimeout(() => {
      logger.error('Graceful shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

startServer().catch((err) => {
  logger.error('Fatal error during server startup', { error: err.message, stack: err.stack });
  process.exit(1);
});
