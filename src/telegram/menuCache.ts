import { TelegramInlineKeyboardMarkup } from './types.js';

/**
 * In-memory prebuilt keyboard cache to eliminate repeated menu reconstruction overhead.
 * Cleared automatically when UI customization, categories, or catalogue caches change.
 */
class MenuCache {
  private store = new Map<string, { markup: TelegramInlineKeyboardMarkup; expiresAt: number }>();
  private readonly defaultTtlMs = 45_000;

  public get(key: string): TelegramInlineKeyboardMarkup | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.markup;
  }

  public set(key: string, markup: TelegramInlineKeyboardMarkup, ttlMs = this.defaultTtlMs): TelegramInlineKeyboardMarkup {
    this.store.set(key, {
      markup,
      expiresAt: Date.now() + ttlMs,
    });
    return markup;
  }

  public invalidateAll(): void {
    this.store.clear();
  }

  public invalidatePrefix(prefix: string): void {
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) {
        this.store.delete(k);
      }
    }
  }

  public size(): number {
    return this.store.size;
  }
}

export const menuCache = new MenuCache();
