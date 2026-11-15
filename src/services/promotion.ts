import { db } from '../db/index.js';
import { redis } from './redis.js';
import { pricingService } from './pricing.js';
import { telegramClient } from '../telegram/client.js';
import { ButtonBuilder } from '../telegram/buttonBuilder.js';
import { createLogger } from './logger.js';

const logger = createLogger('PromotionService');

export interface PromoChannelRecord {
  id: string;
  channelIdentifier: string;
  title: string;
  botIsAdmin: boolean;
  isActive: boolean;
  lastPostedAt: string | null;
  createdAt?: string;
}

export interface AutoPromotionConfig {
  enabled: boolean;
  intervalMinutes: number;
  lastPostedAt: string | null;
  lastProductId: string | null;
}

export interface PromotionPostResult {
  channelId: string;
  channelIdentifier: string;
  ok: boolean;
  messageId?: number;
  error?: string;
}

export interface PromotionBroadcastSummary {
  productId: string;
  productName: string;
  rateUsd: string;
  attempted: number;
  posted: number;
  failed: number;
  results: PromotionPostResult[];
}

export class PromotionService {
  private readonly cfgCacheKey = 'auto_promo:cfg';
  private readonly listCacheKey = 'auto_promo:channels';
  private schedulerTimer: NodeJS.Timeout | null = null;

  private async invalidateCaches(): Promise<void> {
    await Promise.all([
      redis.del(this.cfgCacheKey).catch(() => {}),
      redis.del(this.listCacheKey).catch(() => {}),
    ]);
  }

  public async getConfig(): Promise<AutoPromotionConfig> {
    try {
      const cached = await redis.get(this.cfgCacheKey);
      if (cached) return JSON.parse(cached) as AutoPromotionConfig;
    } catch {
      // Cache miss
    }

    const row = await db.queryRow<any>("SELECT value FROM system_settings WHERE key = 'auto_promotion_config'");
    const val = typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value || {};
    const cfg: AutoPromotionConfig = {
      enabled: Boolean(val.enabled),
      intervalMinutes: Math.max(15, Number(val.intervalMinutes || 180)),
      lastPostedAt: val.lastPostedAt || null,
      lastProductId: val.lastProductId || null,
    };

    await redis.set(this.cfgCacheKey, JSON.stringify(cfg), 60).catch(() => {});
    return cfg;
  }

  public async updateConfig(
    patch: Partial<AutoPromotionConfig>,
    adminId: string
  ): Promise<AutoPromotionConfig> {
    const curr = await this.getConfig();
    const next: AutoPromotionConfig = {
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : curr.enabled,
      intervalMinutes:
        patch.intervalMinutes !== undefined
          ? Math.max(15, Math.min(10080, Number(patch.intervalMinutes)))
          : curr.intervalMinutes,
      lastPostedAt: patch.lastPostedAt !== undefined ? patch.lastPostedAt : curr.lastPostedAt,
      lastProductId: patch.lastProductId !== undefined ? patch.lastProductId : curr.lastProductId,
    };

    await db.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('auto_promotion_config', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify(next)]
    );

    if (adminId !== 'SYSTEM') {
      await db.query(
        `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
         VALUES ($1, $2, 'UPDATE_AUTO_PROMO_CONFIG', 'system_settings', 'auto_promotion_config', $3)`,
        [`aud_prm_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`, adminId, JSON.stringify(next)]
      ).catch(() => {});
    }

    await redis.del(this.cfgCacheKey).catch(() => {});
    return next;
  }

  public async listChannels(activeAndAdminOnly = false): Promise<PromoChannelRecord[]> {
    let all: PromoChannelRecord[] | null = null;
    try {
      const cached = await redis.get(this.listCacheKey);
      if (cached) all = JSON.parse(cached) as PromoChannelRecord[];
    } catch {
      // Cache miss
    }

    if (!all) {
      const res = await db.query<any>(
        `SELECT id, channel_identifier as "channelIdentifier", title,
                bot_is_admin as "botIsAdmin", is_active as "isActive",
                last_posted_at as "lastPostedAt", created_at as "createdAt"
         FROM promo_channels
         ORDER BY created_at ASC`
      );
      all = res.rows.map(r => ({
        id: r.id,
        channelIdentifier: r.channelIdentifier,
        title: r.title,
        botIsAdmin: Boolean(r.botIsAdmin),
        isActive: Boolean(r.isActive),
        lastPostedAt: r.lastPostedAt ? new Date(r.lastPostedAt).toISOString() : null,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
      }));
      await redis.set(this.listCacheKey, JSON.stringify(all), 60).catch(() => {});
    }

    if (activeAndAdminOnly) {
      return all.filter(c => c.isActive && c.botIsAdmin);
    }
    return all;
  }

  /**
   * Check via Telegram Bot API whether the active bot is an admin/creator in the channel.
   */
  public async verifyBotIsChannelAdmin(channelIdentifier: string): Promise<{
    botIsAdmin: boolean;
    title?: string;
    status: string;
  }> {
    const cleanIdent = channelIdentifier.trim();
    const botId = await telegramClient.getActiveBotId();
    if (!botId) {
      return { botIsAdmin: false, status: 'bot_identity_unavailable' };
    }

    const [memberRes, chatRes] = await Promise.all([
      telegramClient.getChatMember(cleanIdent, botId),
      telegramClient.getChat(cleanIdent).catch(() => null),
    ]);

    const title = chatRes?.ok && chatRes?.result?.title ? String(chatRes.result.title).trim() : undefined;
    const status = String(memberRes?.result?.status || memberRes?.description || 'unknown').toLowerCase();
    const botIsAdmin = Boolean(memberRes?.ok && (status === 'administrator' || status === 'creator'));

    return { botIsAdmin, title, status };
  }

  public async addPromoChannel(
    params: { channelIdentifier: string; title?: string },
    adminId: string
  ): Promise<PromoChannelRecord> {
    const cleanIdent = params.channelIdentifier.trim();
    if (!cleanIdent || (!cleanIdent.startsWith('@') && !/^-?\d{5,20}$/.test(cleanIdent))) {
      throw new Error('Channel identifier must be @ChannelUsername or numeric chat ID (e.g. -1001234567890).');
    }

    const check = await this.verifyBotIsChannelAdmin(cleanIdent);
    const title = (params.title?.trim() || check.title || cleanIdent).slice(0, 80);
    const id = `pch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    await db.query(
      `INSERT INTO promo_channels (
        id, channel_identifier, title, bot_is_admin, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (channel_identifier) DO UPDATE SET
        title = EXCLUDED.title,
        bot_is_admin = EXCLUDED.bot_is_admin,
        is_active = TRUE,
        updated_at = CURRENT_TIMESTAMP`,
      [id, cleanIdent, title, check.botIsAdmin]
    );

    const saved = await db.queryRow<any>(
      `SELECT id, channel_identifier as "channelIdentifier", title,
              bot_is_admin as "botIsAdmin", is_active as "isActive",
              last_posted_at as "lastPostedAt"
       FROM promo_channels WHERE channel_identifier = $1`,
      [cleanIdent]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'ADD_PROMO_CHANNEL', 'promo_channels', $3, $4)`,
      [
        `aud_prm_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        saved?.id || id,
        JSON.stringify({ channelIdentifier: cleanIdent, botIsAdmin: check.botIsAdmin, status: check.status }),
      ]
    ).catch(() => {});

    await this.invalidateCaches();
    return {
      id: saved?.id || id,
      channelIdentifier: cleanIdent,
      title: saved?.title || title,
      botIsAdmin: Boolean(saved?.botIsAdmin ?? check.botIsAdmin),
      isActive: Boolean(saved?.isActive ?? true),
      lastPostedAt: saved?.lastPostedAt ? new Date(saved.lastPostedAt).toISOString() : null,
    };
  }

  public async refreshChannelAdminStatus(channelId: string, adminId: string): Promise<PromoChannelRecord> {
    const existing = await db.queryRow<any>('SELECT * FROM promo_channels WHERE id = $1', [channelId]);
    if (!existing) throw new Error(`Promo channel ${channelId} not found.`);

    const check = await this.verifyBotIsChannelAdmin(existing.channel_identifier);
    const nextTitle = (check.title || existing.title).slice(0, 80);

    await db.query(
      `UPDATE promo_channels
       SET bot_is_admin = $1, title = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [check.botIsAdmin, nextTitle, channelId]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'VERIFY_PROMO_CHANNEL_ADMIN', 'promo_channels', $3, $4)`,
      [
        `aud_prm_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        channelId,
        JSON.stringify({ botIsAdmin: check.botIsAdmin, status: check.status }),
      ]
    ).catch(() => {});

    await this.invalidateCaches();
    const list = await this.listChannels(false);
    return list.find(c => c.id === channelId)!;
  }

  public async toggleChannelActive(channelId: string, adminId: string): Promise<PromoChannelRecord> {
    const existing = await db.queryRow<any>('SELECT id, is_active FROM promo_channels WHERE id = $1', [channelId]);
    if (!existing) throw new Error(`Promo channel ${channelId} not found.`);

    const nextActive = !Boolean(existing.is_active);
    await db.query(
      'UPDATE promo_channels SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [nextActive, channelId]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'TOGGLE_PROMO_CHANNEL', 'promo_channels', $3, $4)`,
      [
        `aud_prm_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        channelId,
        JSON.stringify({ isActive: nextActive }),
      ]
    ).catch(() => {});

    await this.invalidateCaches();
    const list = await this.listChannels(false);
    return list.find(c => c.id === channelId)!;
  }

  public async removePromoChannel(channelId: string, adminId: string): Promise<boolean> {
    const existing = await db.queryRow<any>('SELECT * FROM promo_channels WHERE id = $1', [channelId]);
    if (!existing) return false;

    await db.query('DELETE FROM promo_channels WHERE id = $1', [channelId]);
    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'REMOVE_PROMO_CHANNEL', 'promo_channels', $3, $4)`,
      [
        `aud_prm_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        channelId,
        JSON.stringify({ channelIdentifier: existing.channel_identifier }),
      ]
    ).catch(() => {});

    await this.invalidateCaches();
    return true;
  }

  /**
   * Build the clean promo message & 🛍 GET NOW URL button pointing directly to Bot Orders.
   */
  public formatPromotionMessage(
    productName: string,
    rateUsd: string,
    productId: string,
    botUsername?: string
  ): { text: string; replyMarkup?: any } {
    const cleanName = String(productName || 'Digital Tool').trim();
    const cleanRate = String(rateUsd || '0.00').trim();
    const text =
      `🔥 *LIMITED AVAILABILITY*\n\n` +
      `*Product:*\n` +
      `${cleanName}\n\n` +
      `*Rate:*\n` +
      `$${cleanRate}\n\n` +
      `Only few slots available.`;

    const btnUrl = botUsername
      ? `https://t.me/${botUsername}?start=orders_${productId}`
      : undefined;

    const replyMarkup = btnUrl
      ? {
          inline_keyboard: [
            [
              {
                text: '🛍 GET NOW',
                url: btnUrl,
              },
            ],
          ],
        }
      : {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: 'GET NOW',
                fallbackEmoji: '🛍',
                style: 'success',
                callbackData: `p:${productId}:all:1`,
                forceVisible: true,
              }),
            ]),
          ],
        };

    return { text, replyMarkup };
  }

  /**
   * Select a catalog product for promotion (explicit productId, or rotate to next active featured/in-stock product).
   */
  private async selectProductForPromotion(explicitProductId?: string): Promise<{
    id: string;
    name: string;
    sellingPrice: string;
  } | null> {
    if (explicitProductId) {
      const item = await pricingService.getCatalogItemById(explicitProductId);
      if (item) {
        return { id: item.id, name: item.name, sellingPrice: item.sellingPrice };
      }
    }

    const featured = await pricingService.getCatalog({ featuredOnly: true, page: 1, pageSize: 12 });
    const pool = featured.items.length > 0
      ? featured.items
      : (await pricingService.getCatalog({ page: 1, pageSize: 12 })).items;

    if (pool.length === 0) return null;

    const cfg = await this.getConfig();
    if (!cfg.lastProductId) {
      const first = pool[0];
      return { id: first.id, name: first.name, sellingPrice: first.sellingPrice };
    }

    const idx = pool.findIndex(p => p.id === cfg.lastProductId);
    const next = idx >= 0 && idx + 1 < pool.length ? pool[idx + 1] : pool[0];
    return { id: next.id, name: next.name, sellingPrice: next.sellingPrice };
  }

  /**
   * Post promotion automatically to all active channels where the bot is confirmed admin.
   */
  public async postPromotion(params: {
    adminId: string;
    productId?: string;
    channelId?: string;
  }): Promise<PromotionBroadcastSummary> {
    const allChannels = await this.listChannels(true);
    const targetChannels = params.channelId
      ? allChannels.filter(c => c.id === params.channelId)
      : allChannels;

    if (targetChannels.length === 0) {
      throw new Error('No active promotion channels where bot is admin. Add a channel and verify bot admin status first.');
    }

    const product = await this.selectProductForPromotion(params.productId);
    if (!product) {
      throw new Error('No active in-stock products available to promote.');
    }

    const botUsername = await telegramClient.getActiveBotUsername();
    const { text, replyMarkup } = this.formatPromotionMessage(
      product.name,
      product.sellingPrice,
      product.id,
      botUsername
    );

    const results: PromotionPostResult[] = [];
    let posted = 0;
    let failed = 0;

    for (const ch of targetChannels) {
      try {
        const res = await telegramClient.sendMessage(ch.channelIdentifier, text, {
          reply_markup: replyMarkup,
        });
        const ok = Boolean(res?.ok);
        const msgId = res?.result?.message_id ? Number(res.result.message_id) : undefined;

        await db.query(
          `INSERT INTO promotion_posts (
            id, channel_id, product_id, telegram_message_id, status, error_message, created_by, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
          [
            `pp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            ch.id,
            product.id,
            msgId || null,
            ok ? 'POSTED' : 'FAILED',
            ok ? null : String(res?.description || 'Telegram sendMessage failed'),
            params.adminId,
          ]
        );

        if (ok) {
          posted++;
          await db.query(
            'UPDATE promo_channels SET last_posted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [ch.id]
          );
          results.push({ channelId: ch.id, channelIdentifier: ch.channelIdentifier, ok: true, messageId: msgId });
        } else {
          failed++;
          results.push({
            channelId: ch.id,
            channelIdentifier: ch.channelIdentifier,
            ok: false,
            error: String(res?.description || 'Failed'),
          });
        }
      } catch (err: any) {
        failed++;
        results.push({
          channelId: ch.id,
          channelIdentifier: ch.channelIdentifier,
          ok: false,
          error: err?.message || 'Exception sending promotion',
        });
      }
    }

    await this.updateConfig(
      {
        lastPostedAt: new Date().toISOString(),
        lastProductId: product.id,
      },
      'SYSTEM'
    );
    await this.invalidateCaches();

    logger.info('Channel promotion run completed', {
      productId: product.id,
      attempted: targetChannels.length,
      posted,
      failed,
    });

    return {
      productId: product.id,
      productName: product.name,
      rateUsd: product.sellingPrice,
      attempted: targetChannels.length,
      posted,
      failed,
      results,
    };
  }

  public async runAutoPromotionCycle(): Promise<PromotionBroadcastSummary | null> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) return null;

    if (cfg.lastPostedAt) {
      const elapsedMs = Date.now() - new Date(cfg.lastPostedAt).getTime();
      if (elapsedMs < cfg.intervalMinutes * 60_000) {
        return null;
      }
    }

    const channels = await this.listChannels(true);
    if (channels.length === 0) return null;

    return await this.postPromotion({ adminId: 'AUTO_PROMO_SCHEDULER' });
  }

  public startScheduler(pollEveryMs = 60_000): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      void this.runAutoPromotionCycle().catch(err => {
        logger.warn('Auto promotion cycle skipped/failed', { error: err?.message });
      });
    }, Math.max(15_000, pollEveryMs));
    this.schedulerTimer.unref?.();
  }

  public stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }
}

export const promotionService = new PromotionService();
