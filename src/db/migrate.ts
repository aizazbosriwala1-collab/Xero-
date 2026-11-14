import fs from 'fs';
import path from 'path';
import { db } from './index.js';
import { createLogger } from '../services/logger.js';
import { seedInitialData } from './seed.js';
import { uiConfigService } from '../services/uiConfig.js';
import { preloadCommonMenus } from '../telegram/keyboards.js';

const logger = createLogger('Migrations');
const MIGRATION_LOCK_ID = 987654321;

const MIGRATIONS: Array<{ version: number; name: string; filename: string }> = [
  { version: 1, name: '001_initial_schema', filename: '001_initial_schema.sql' },
  { version: 2, name: '002_ui_customization', filename: '002_ui_customization.sql' },
  { version: 3, name: '003_binance_order_id', filename: '003_binance_order_id.sql' },
  { version: 4, name: '004_public_release_polish', filename: '004_public_release_polish.sql' },
  { version: 5, name: '005_payment_ux_and_perf', filename: '005_payment_ux_and_perf.sql' },
];

function readMigrationSql(filename: string): string {
  const candidates = [
    path.resolve(process.cwd(), 'src/db/migrations', filename),
    path.join(path.dirname(new URL(import.meta.url).pathname), 'migrations', filename),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf8');
    }
  }
  throw new Error(`Migration file ${filename} not found`);
}

export async function runMigrations(): Promise<void> {
  logger.info('Starting database migration checks with advisory lock protection...');

  const client = await db.getClient();
  let lockAcquired = false;

  try {
    if (!db.getIsInMemory()) {
      try {
        const lockRes = await client.queryRow<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) as locked',
          [MIGRATION_LOCK_ID]
        );
        lockAcquired = Boolean(lockRes?.locked);
        if (!lockAcquired) {
          logger.warn('Could not acquire PostgreSQL migration advisory lock; another migration may be running.');
          return;
        }
      } catch (lockErr: any) {
        logger.warn('Advisory lock check skipped or unsupported', { error: lockErr.message });
      }
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP DEFAULT now()
      );
    `);

    const applied = await client.query<{ version: number }>('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(applied.rows.map(r => r.version));

    for (const mig of MIGRATIONS) {
      if (!appliedVersions.has(mig.version)) {
        logger.info(`Applying migration ${mig.filename}...`);

        if (mig.version === 3) {
          try {
            const dupCheck = await client.queryRow<{ dup_count: string }>(
              `SELECT COUNT(*)::text AS dup_count
               FROM (
                 SELECT binance_order_id
                 FROM deposits
                 WHERE binance_order_id IS NOT NULL
                 GROUP BY binance_order_id
                 HAVING COUNT(*) > 1
               ) dups`
            );
            if (Number(dupCheck?.dup_count || 0) > 0) {
              throw new Error('Duplicate binance_order_id values detected prior to unique index creation');
            }
          } catch (preflightErr: any) {
            if (preflightErr?.message?.includes('Duplicate binance_order_id')) {
              throw preflightErr;
            }
            // Expected when column binance_order_id does not yet exist before ALTER TABLE
          }
        }

        const sqlContent = readMigrationSql(mig.filename);

        const statements = sqlContent
          .split(';')
          .map(s => s.trim())
          .filter(s => s.length > 0 && !s.split('\n').every(line => line.trim() === '' || line.trim().startsWith('--')));

        for (const statement of statements) {
          try {
            await client.query(statement);
          } catch (err: any) {
            if (!err.message?.includes('already exists')) {
              logger.error('Error executing migration statement', {
                error: err.message,
                statement: statement.substring(0, 100),
              });
              throw err;
            }
          }
        }

        await client.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, now())',
          [mig.version, mig.name]
        );
        logger.info(`Migration ${mig.filename} applied successfully`);
      } else {
        logger.info(`Migration ${mig.name} is already applied`);
      }
    }

    // Seed baseline data, UI customization defaults & prewarm menu cache
    await seedInitialData();
    await uiConfigService.seedDefaults();
    preloadCommonMenus();

    logger.info('Database migrations and baseline configuration completed successfully');
  } finally {
    if (lockAcquired && !db.getIsInMemory()) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      } catch (unlockErr: any) {
        logger.error('Failed to release advisory lock', { error: unlockErr.message });
      }
    }
    client.release();
  }
}

/**
 * Fast check for server startup: confirms latest schema version is present.
 */
export async function verifySchemaVersion(): Promise<boolean> {
  try {
    const latestVersion = MIGRATIONS[MIGRATIONS.length - 1].version;
    const res = await db.queryRow<{ version: number }>(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [latestVersion]
    );
    return Boolean(res?.version);
  } catch {
    return false;
  }
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  runMigrations()
    .then(() => {
      logger.info('Migration CLI completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Migration CLI failed', { error: err.message });
      process.exit(1);
    });
}
