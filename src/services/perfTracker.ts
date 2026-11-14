import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from './logger.js';

const logger = createLogger('PerfTracker');

export interface ActivePerfContext {
  callbackName: string;
  startedAt: number;
  dbTimeMs: number;
  dbQueryCount: number;
  supplierTimeMs: number;
  supplierCallCount: number;
}

export interface CallbackPerfRecord {
  callbackName: string;
  responseTimeMs: number;
  dbTimeMs: number;
  dbQueryCount: number;
  supplierTimeMs: number;
  supplierCallCount: number;
  slow300: boolean;
  slow: boolean; // >500ms threshold
  recordedAt: string;
}

class PerformanceTracker {
  private storage = new AsyncLocalStorage<ActivePerfContext>();
  private recentCallbacks: CallbackPerfRecord[] = [];
  private slowCallbacks300: CallbackPerfRecord[] = [];
  private slowCallbacks: CallbackPerfRecord[] = [];
  private readonly warnThresholdMs = 300;
  private readonly slowThresholdMs = 500;

  public async run<T>(callbackName: string, fn: () => Promise<T>): Promise<{ result: T; metrics: CallbackPerfRecord }> {
    const ctx: ActivePerfContext = {
      callbackName,
      startedAt: Date.now(),
      dbTimeMs: 0,
      dbQueryCount: 0,
      supplierTimeMs: 0,
      supplierCallCount: 0,
    };

    return await this.storage.run(ctx, async () => {
      try {
        const result = await fn();
        const metrics = this.finalize(ctx);
        return { result, metrics };
      } catch (err) {
        this.finalize(ctx);
        throw err;
      }
    });
  }

  public recordDb(durationMs: number): void {
    const ctx = this.storage.getStore();
    if (!ctx) return;
    ctx.dbTimeMs += Math.max(0, durationMs);
    ctx.dbQueryCount += 1;
  }

  public recordSupplier(durationMs: number): void {
    const ctx = this.storage.getStore();
    if (!ctx) return;
    ctx.supplierTimeMs += Math.max(0, durationMs);
    ctx.supplierCallCount += 1;
  }

  public getCurrentSnapshot(): ActivePerfContext | undefined {
    return this.storage.getStore();
  }

  private finalize(ctx: ActivePerfContext): CallbackPerfRecord {
    const responseTimeMs = Math.max(0, Date.now() - ctx.startedAt);
    const slow300 = responseTimeMs > this.warnThresholdMs;
    const slow = responseTimeMs > this.slowThresholdMs;
    const rec: CallbackPerfRecord = {
      callbackName: ctx.callbackName,
      responseTimeMs,
      dbTimeMs: ctx.dbTimeMs,
      dbQueryCount: ctx.dbQueryCount,
      supplierTimeMs: ctx.supplierTimeMs,
      supplierCallCount: ctx.supplierCallCount,
      slow300,
      slow,
      recordedAt: new Date().toISOString(),
    };

    this.recentCallbacks.unshift(rec);
    if (this.recentCallbacks.length > 50) {
      this.recentCallbacks.length = 50;
    }

    if (slow300) {
      this.slowCallbacks300.unshift(rec);
      if (this.slowCallbacks300.length > 30) {
        this.slowCallbacks300.length = 30;
      }
    }

    if (slow) {
      this.slowCallbacks.unshift(rec);
      if (this.slowCallbacks.length > 30) {
        this.slowCallbacks.length = 30;
      }
      logger.warn('Slow callback detected (>500ms)', {
        callbackName: rec.callbackName,
        responseTimeMs: rec.responseTimeMs,
        dbTimeMs: rec.dbTimeMs,
        dbQueryCount: rec.dbQueryCount,
        supplierTimeMs: rec.supplierTimeMs,
        supplierCallCount: rec.supplierCallCount,
      });
    } else if (slow300) {
      logger.warn('Slow callback detected (>300ms)', {
        callbackName: rec.callbackName,
        responseTimeMs: rec.responseTimeMs,
        dbTimeMs: rec.dbTimeMs,
        dbQueryCount: rec.dbQueryCount,
        supplierTimeMs: rec.supplierTimeMs,
        supplierCallCount: rec.supplierCallCount,
      });
    }

    return rec;
  }

  public getRecentCallbacks(limit = 10): CallbackPerfRecord[] {
    return this.recentCallbacks.slice(0, limit);
  }

  public getSlowCallbacks300(limit = 10): CallbackPerfRecord[] {
    return this.slowCallbacks300.slice(0, limit);
  }

  public getSlowCallbacks(limit = 10): CallbackPerfRecord[] {
    return this.slowCallbacks.slice(0, limit);
  }

  public resetHistory(): void {
    this.recentCallbacks = [];
    this.slowCallbacks300 = [];
    this.slowCallbacks = [];
  }
}

export const perfTracker = new PerformanceTracker();
