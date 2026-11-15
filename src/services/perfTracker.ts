import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from './logger.js';

const logger = createLogger('PerfTracker');

export type PerfBottleneckAxis =
  | 'TELEGRAM_API'
  | 'POSTGRESQL'
  | 'REDIS'
  | 'RENDERING'
  | 'SUPPLIER'
  | 'NONE';

export interface ActivePerfContext {
  callbackName: string;
  startedAtPerf: number;
  dbTimeMs: number;
  dbQueryCount: number;
  redisTimeMs: number;
  redisOpCount: number;
  telegramApiTimeMs: number;
  telegramApiCallCount: number;
  renderTimeMs: number;
  renderDepth: number;
  supplierTimeMs: number;
  supplierCallCount: number;
  discarded: boolean;
}

export interface CallbackPerfRecord {
  callbackName: string;
  responseTimeMs: number;
  telegramApiTimeMs: number;
  telegramApiCallCount: number;
  redisTimeMs: number;
  redisOpCount: number;
  dbTimeMs: number;
  dbQueryCount: number;
  renderTimeMs: number;
  supplierTimeMs: number;
  supplierCallCount: number;
  primaryBottleneck: PerfBottleneckAxis;
  slow300: boolean;
  slow: boolean; // >500ms threshold
  recordedAt: string;
}

function roundMs(val: number): number {
  return Math.round(Math.max(0, val) * 100) / 100;
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
      startedAtPerf: performance.now(),
      dbTimeMs: 0,
      dbQueryCount: 0,
      redisTimeMs: 0,
      redisOpCount: 0,
      telegramApiTimeMs: 0,
      telegramApiCallCount: 0,
      renderTimeMs: 0,
      renderDepth: 0,
      supplierTimeMs: 0,
      supplierCallCount: 0,
      discarded: false,
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

  public discardCurrent(): void {
    const ctx = this.storage.getStore();
    if (ctx) {
      ctx.discarded = true;
    }
  }

  public recordDb(durationMs: number): void {
    const ctx = this.storage.getStore();
    if (!ctx) return;
    ctx.dbTimeMs += Math.max(0, durationMs);
    ctx.dbQueryCount += 1;
  }

  public recordRedis(durationMs: number, ops = 1): void {
    const ctx = this.storage.getStore();
    if (!ctx) return;
    ctx.redisTimeMs += Math.max(0, durationMs);
    ctx.redisOpCount += ops;
  }

  public recordTelegramApi(durationMs: number): void {
    const ctx = this.storage.getStore();
    if (!ctx) return;
    ctx.telegramApiTimeMs += Math.max(0, durationMs);
    ctx.telegramApiCallCount += 1;
  }

  public recordRender(durationMs: number): void {
    const ctx = this.storage.getStore();
    if (!ctx) return;
    ctx.renderTimeMs += Math.max(0, durationMs);
  }

  public measureRender<T>(fn: () => T): T {
    const ctx = this.storage.getStore();
    if (!ctx) return fn();
    if (ctx.renderDepth > 0) {
      return fn();
    }
    ctx.renderDepth += 1;
    const start = performance.now();
    try {
      return fn();
    } finally {
      ctx.renderDepth -= 1;
      ctx.renderTimeMs += Math.max(0, performance.now() - start);
    }
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

  private detectPrimaryBottleneck(ctx: ActivePerfContext): PerfBottleneckAxis {
    const axes: Array<{ axis: PerfBottleneckAxis; ms: number }> = [
      { axis: 'TELEGRAM_API', ms: ctx.telegramApiTimeMs },
      { axis: 'POSTGRESQL', ms: ctx.dbTimeMs },
      { axis: 'REDIS', ms: ctx.redisTimeMs },
      { axis: 'RENDERING', ms: ctx.renderTimeMs },
      { axis: 'SUPPLIER', ms: ctx.supplierTimeMs },
    ];
    axes.sort((a, b) => b.ms - a.ms);
    return axes[0].ms > 0 ? axes[0].axis : 'NONE';
  }

  private finalize(ctx: ActivePerfContext): CallbackPerfRecord {
    const responseTimeMs = roundMs(performance.now() - ctx.startedAtPerf);
    const slow300 = responseTimeMs > this.warnThresholdMs;
    const slow = responseTimeMs > this.slowThresholdMs;
    const rec: CallbackPerfRecord = {
      callbackName: ctx.callbackName,
      responseTimeMs,
      telegramApiTimeMs: roundMs(ctx.telegramApiTimeMs),
      telegramApiCallCount: ctx.telegramApiCallCount,
      redisTimeMs: roundMs(ctx.redisTimeMs),
      redisOpCount: ctx.redisOpCount,
      dbTimeMs: roundMs(ctx.dbTimeMs),
      dbQueryCount: ctx.dbQueryCount,
      renderTimeMs: roundMs(ctx.renderTimeMs),
      supplierTimeMs: roundMs(ctx.supplierTimeMs),
      supplierCallCount: ctx.supplierCallCount,
      primaryBottleneck: this.detectPrimaryBottleneck(ctx),
      slow300,
      slow,
      recordedAt: new Date().toISOString(),
    };

    if (ctx.discarded) {
      return rec;
    }

    this.recentCallbacks.unshift(rec);
    if (this.recentCallbacks.length > 200) {
      this.recentCallbacks.length = 200;
    }

    if (slow300) {
      this.slowCallbacks300.unshift(rec);
      if (this.slowCallbacks300.length > 50) {
        this.slowCallbacks300.length = 50;
      }
    }

    if (slow) {
      this.slowCallbacks.unshift(rec);
      if (this.slowCallbacks.length > 50) {
        this.slowCallbacks.length = 50;
      }
      logger.warn('Slow callback detected (>500ms)', {
        callbackName: rec.callbackName,
        responseTimeMs: rec.responseTimeMs,
        primaryBottleneck: rec.primaryBottleneck,
        telegramApiTimeMs: rec.telegramApiTimeMs,
        telegramApiCallCount: rec.telegramApiCallCount,
        redisTimeMs: rec.redisTimeMs,
        redisOpCount: rec.redisOpCount,
        dbTimeMs: rec.dbTimeMs,
        dbQueryCount: rec.dbQueryCount,
        renderTimeMs: rec.renderTimeMs,
        supplierTimeMs: rec.supplierTimeMs,
      });
    } else if (slow300) {
      logger.warn('Slow callback detected (>300ms)', {
        callbackName: rec.callbackName,
        responseTimeMs: rec.responseTimeMs,
        primaryBottleneck: rec.primaryBottleneck,
        telegramApiTimeMs: rec.telegramApiTimeMs,
        redisTimeMs: rec.redisTimeMs,
        dbTimeMs: rec.dbTimeMs,
        renderTimeMs: rec.renderTimeMs,
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

  /**
   * Return the slowest recorded callbacks sorted by total responseTimeMs descending (unique by callbackName).
   */
  public getSlowestCallbacks(limit = 10): CallbackPerfRecord[] {
    const byName = new Map<string, CallbackPerfRecord>();
    for (const rec of this.recentCallbacks) {
      const existing = byName.get(rec.callbackName);
      if (!existing || rec.responseTimeMs > existing.responseTimeMs) {
        byName.set(rec.callbackName, rec);
      }
    }
    return Array.from(byName.values())
      .sort((a, b) => b.responseTimeMs - a.responseTimeMs)
      .slice(0, limit);
  }

  public resetHistory(): void {
    this.recentCallbacks = [];
    this.slowCallbacks300 = [];
    this.slowCallbacks = [];
  }
}

export const perfTracker = new PerformanceTracker();
