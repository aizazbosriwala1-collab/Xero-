import fs from 'fs';
import path from 'path';
import { db } from './index.js';
import { createLogger } from '../services/logger.js';
import { seedInitialData } from './seed.js';

const logger = createLogger('Migrations');
const MIGRATION_LOCK_ID = 987654321;

export async function runMigrations(): Promise<void> {
  logger.info('Starting database migration checks with advisory lock protection...');

  const client = await db.getClient();
  let lockAcquired = false;

  try {
    // Acquire PostgreSQL advisory lock to ensure only one migration runs at a time
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

    // Ensure migration tracker table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP DEFAULT now()
      );
    `);

    // Migration 1: Initial schema
    const applied = await client.query<{ version: number }>('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(applied.rows.map(r => r.version));

    if (!appliedVersions.has(1)) {
      logger.info('Applying migration 001_initial_schema.sql...');
      
      const sqlPath = path.resolve(process.cwd(), 'src/db/migrations/001_initial_schema.sql');
      let sqlContent = '';
      if (fs.existsSync(sqlPath)) {
        sqlContent = fs.readFileSync(sqlPath, 'utf8');
      } else {
        const fallbackPath = path.join(__dirname, 'migrations/001_initial_schema.sql');
        if (fs.existsSync(fallbackPath)) {
          sqlContent = fs.readFileSync(fallbackPath, 'utf8');
        }
      }

      if (!sqlContent) {
        throw new Error('Migration file 001_initial_schema.sql not found');
      }

      const statements = sqlContent
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      for (const statement of statements) {
        try {
          await client.query(statement);
        } catch (err: any) {
          if (!err.message?.includes('already exists')) {
            logger.error('Error executing migration statement', { error: err.message, statement: statement.substring(0, 100) });
            throw err;
          }
        }
      }

      await client.query(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, now())',
        [1, '001_initial_schema']
      );
      logger.info('Migration 001_initial_schema.sql applied successfully');
    } else {
      logger.info('Migration 001_initial_schema is already applied');
    }

    // Seed baseline data safely (payment methods, default categories, default settings)
    await seedInitialData();

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
 * Fast check for server startup: confirms schema is present without running DDL.
 */
export async function verifySchemaVersion(): Promise<boolean> {
  try {
    const res = await db.queryRow<{ version: number }>('SELECT version FROM schema_migrations WHERE version = 1');
    return Boolean(res?.version);
  } catch {
    return false;
  }
}

// Standalone CLI execution
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
