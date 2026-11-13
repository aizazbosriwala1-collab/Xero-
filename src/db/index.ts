import pg from 'pg';
import { newDb, IMemoryDb } from 'pg-mem';
import { config } from '../config/env.js';
import { createLogger } from '../services/logger.js';

const logger = createLogger('Database');

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
  queryRow<T = any>(text: string, params?: any[]): Promise<T | null>;
  release(): void;
}

class DatabaseManager {
  private pool: pg.Pool | null = null;
  private memDb: IMemoryDb | null = null;
  private memAdapter: any = null;
  private isInMemory = false;
  private memTxQueue: Promise<void> = Promise.resolve();

  constructor() {
    if (config.databaseUrl) {
      try {
        this.pool = new pg.Pool({
          connectionString: config.databaseUrl,
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 10000,
          max: 20,
        });
        this.isInMemory = false;
        logger.info('Initialized PostgreSQL connection pool with DATABASE_URL');
      } catch (err: any) {
        logger.warn('Failed to initialize PostgreSQL pool, falling back to in-memory PostgreSQL engine', { error: err.message });
        this.setupInMemory();
      }
    } else {
      logger.info('No DATABASE_URL configured. Initializing in-memory PostgreSQL engine for local development/testing');
      this.setupInMemory();
    }
  }

  private setupInMemory() {
    this.isInMemory = true;
    this.memDb = newDb({ noAstCoverageCheck: true } as any);
    
    // Register pg-mem custom functions or overrides if needed
    this.memDb.public.registerFunction({
      name: 'current_timestamp',
      implementation: () => new Date(),
    });

    const pgAdapter = this.memDb.adapters.createPg();
    this.pool = new pgAdapter.Pool() as unknown as pg.Pool;
  }

  public getIsInMemory(): boolean {
    return this.isInMemory;
  }

  public async query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('Database pool is not initialized');
    }
    const start = Date.now();
    try {
      const res = await this.pool.query(text, params);
      const duration = Date.now() - start;
      if (duration > 1000) {
        logger.warn('Slow query detected', { durationMs: duration, query: text.substring(0, 100) });
      }
      return {
        rows: res.rows || [],
        rowCount: res.rowCount || (res.rows ? res.rows.length : 0),
      };
    } catch (err: any) {
      logger.error('Database query error', { error: err.message, query: text.substring(0, 150) });
      throw err;
    }
  }

  public async queryRow<T = any>(text: string, params?: any[]): Promise<T | null> {
    const res = await this.query<T>(text, params);
    return res.rows[0] || null;
  }

  public async getClient(): Promise<DbClient> {
    if (!this.pool) {
      throw new Error('Database pool is not initialized');
    }
    const client = await this.pool.connect();
    return {
      query: async <T = any>(text: string, params?: any[]) => {
        const res = await client.query(text, params);
        return {
          rows: res.rows || [],
          rowCount: res.rowCount || (res.rows ? res.rows.length : 0),
        };
      },
      queryRow: async <T = any>(text: string, params?: any[]) => {
        const res = await client.query(text, params);
        const rows = res.rows || [];
        return (rows[0] as T) || null;
      },
      release: () => client.release(),
    };
  }

  public async withTransaction<T>(callback: (client: DbClient) => Promise<T>): Promise<T> {
    if (this.isInMemory && this.memDb) {
      const prev = this.memTxQueue;
      let release!: () => void;
      const current = new Promise<void>(resolve => {
        release = resolve;
      });
      this.memTxQueue = prev.then(() => current);
      await prev;

      const client = await this.getClient();
      const memBackup = this.memDb.backup();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr: any) {
          logger.error('Transaction rollback failed', { error: rollbackErr.message });
        }
        memBackup.restore();
        throw err;
      } finally {
        client.release();
        release();
      }
    }

    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr: any) {
        logger.error('Transaction rollback failed', { error: rollbackErr.message });
      }
      throw err;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

export const db = new DatabaseManager();
