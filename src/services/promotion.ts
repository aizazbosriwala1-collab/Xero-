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
  canPostMessages: boolean;
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

export interface PromotionChannelDiagnostic {
  id: string;
  channelIdentifier: string;
  title: string;
  isActive: boolean;
  botIsAdmin: boolean;
  canPostMessages: boolean;
  eligible: boolean;
  issue?: string;
}

export interface PromotionReadinessReport {
  enabled: boolean;
  status: 'READY' | 'NOT_READY' | 'PAUSED';
  channelsCount: number;
  activeChannelsCount: number;
  verifiedChannelsCount: number;
  productsCount: number;
  intervalMinutes: number;
  intervalLabel: string;
  lastPostedAt: string | null;
  nextPromotionAt: string | null;
  nextPromotionLabel: string;
  issues: string[];
  channelDiagnostics: PromotionChannelDiagnostic[];
  schedulerRunning: boolean;
}

export interface TestPromotionResult {
  ok: boolean;
  channelUsed?: {
    id: string;
    channelIdentifier: string;
    title: string;
  };
  productUsed?: {
    id: string;
    name: string;
    rateUsd: string;
  };
  telegramMessageId?: number;
  failureHeadline?: string;
  diagnostics: string[];
}

export class PromotionService {
  private readonly cfgCacheKey = 'auto_promo:cfg';
  private readonly listCacheKey = 'auto_promo:channels';
  private schedulerTimer: NodeJS.Timeout | null = null;
  private cycleInFlight = false;

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
                bot_is_admin as "botIsAdmin",
                can_post_messages as "canPostMessages",
                is_active as "isActive",
                last_posted_at as "lastPostedAt", created_at as "createdAt"
         FROM promo_channels
         ORDER BY created_at ASC`
      );
      all = res.rows.map(r => ({
        id: r.id,
        channelIdentifier: r.channelIdentifier,
        title: r.title,
        botIsAdmin: Boolean(r.botIsAdmin),
        canPostMessages: Boolean(r.canPostMessages),
        isActive: Boolean(r.isActive),
        lastPostedAt: r.lastPostedAt ? new Date(r.lastPostedAt).toISOString() : null,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
      }));
      await redis.set(this.listCacheKey, JSON.stringify(all), 60).catch(() => {});
    }

    if (activeAndAdminOnly) {
      return all.filter(c => c.isActive && c.botIsAdmin && c.canPostMessages);
    }
    return all;
  }

  /**
   * Check via Telegram Bot API whether the active bot is an admin/creator in the channel
   * AND holds permission to post messages (can_post_messages).
   */
  public async verifyBotIsChannelAdmin(channelIdentifier: string): Promise<{
    botIsAdmin: boolean;
    canPostMessages: boolean;
    title?: string;
    status: string;
    reason?: string;
  }> {
    const cleanIdent = channelIdentifier.trim();
    const botId = await telegramClient.getActiveBotId();
    if (!botId) {
      return {
        botIsAdmin: false,
        canPostMessages: false,
        status: 'bot_identity_unavailable',
        reason: 'Bot token unavailable or getMe() failed',
      };
    }

    const [memberRes, chatRes] = await Promise.all([
      telegramClient.getChatMember(cleanIdent, botId).catch((err: any) => ({
        ok: false,
        description: err?.message || 'getChatMember_failed',
      })),
      telegramClient.getChat(cleanIdent).catch(() => null),
    ]);

    const title = chatRes?.ok && chatRes?.result?.title ? String(chatRes.result.title).trim() : undefined;
    const status = String(memberRes?.result?.status || memberRes?.description || 'unknown').toLowerCase();

    if (!memberRes?.ok) {
      return {
        botIsAdmin: false,
        canPostMessages: false,
        title,
        status,
        reason: String(memberRes?.description || 'Unable to inspect bot membership in channel'),
      };
    }

    if (status === 'creator') {
      return { botIsAdmin: true, canPostMessages: true, title, status };
    }

    if (status === 'administrator') {
      const canPostMessages = memberRes?.result?.can_post_messages !== false;
      return {
        botIsAdmin: true,
        canPostMessages,
        title,
        status,
        ...(canPostMessages ? {} : { reason: 'Missing Post Messages permission (can_post_messages = false)' }),
      };
    }

    return {
      botIsAdmin: false,
      canPostMessages: false,
      title,
      status,
      reason: `Bot status in channel is "${status}" (must be Administrator)`,
    };
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
        id, channel_identifier, title, bot_is_admin, can_post_messages, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (channel_identifier) DO UPDATE SET
        title = EXCLUDED.title,
        bot_is_admin = EXCLUDED.bot_is_admin,
        can_post_messages = EXCLUDED.can_post_messages,
        is_active = TRUE,
        updated_at = CURRENT_TIMESTAMP`,
      [id, cleanIdent, title, check.botIsAdmin, check.canPostMessages]
    );

    const saved = await db.queryRow<any>(
      `SELECT id, channel_identifier as "channelIdentifier", title,
              bot_is_admin as "botIsAdmin", can_post_messages as "canPostMessages",
              is_active as "isActive", last_posted_at as "lastPostedAt"
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
        JSON.stringify({
          channelIdentifier: cleanIdent,
          botIsAdmin: check.botIsAdmin,
          canPostMessages: check.canPostMessages,
          status: check.status,
        }),
      ]
    ).catch(() => {});

    await this.invalidateCaches();
    return {
      id: saved?.id || id,
      channelIdentifier: cleanIdent,
      title: saved?.title || title,
      botIsAdmin: Boolean(saved?.botIsAdmin ?? check.botIsAdmin),
      canPostMessages: Boolean(saved?.canPostMessages ?? check.canPostMessages),
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
       SET bot_is_admin = $1, can_post_messages = $2, title = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [check.botIsAdmin, check.canPostMessages, nextTitle, channelId]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'VERIFY_PROMO_CHANNEL_ADMIN', 'promo_channels', $3, $4)`,
      [
        `aud_prm_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        channelId,
        JSON.stringify({
          botIsAdmin: check.botIsAdmin,
          canPostMessages: check.canPostMessages,
          status: check.status,
        }),
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

    if (posted > 0) {
      await this.updateConfig(
        {
          lastPostedAt: new Date().toISOString(),
          lastProductId: product.id,
        },
        'SYSTEM'
      );
    }
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

  public formatIntervalLabel(intervalMinutes: number): string {
    if (intervalMinutes >= 60 && intervalMinutes % 60 === 0) {
      const hours = intervalMinutes / 60;
      return hours === 1 ? '1 Hour' : `${hours} Hours`;
    }
    return `${intervalMinutes} Minutes`;
  }

  /**
   * Perform full live readiness check across channels, bot admin rights,
   * can_post_messages permission, active catalog products, and scheduler state.
   */
  public async getReadinessReport(options?: { refreshChannelChecks?: boolean }): Promise<PromotionReadinessReport> {
    const [cfg, rawChannels, catalog] = await Promise.all([
      this.getConfig(),
      this.listChannels(false),
      pricingService.getCatalog({ page: 1, pageSize: 1 }),
    ]);

    const channels = [...rawChannels];
    if (options?.refreshChannelChecks && channels.length > 0) {
      await Promise.all(
        channels.map(async (ch) => {
          const check = await this.verifyBotIsChannelAdmin(ch.channelIdentifier);
          const nextTitle = (check.title || ch.title).slice(0, 80);
          ch.botIsAdmin = check.botIsAdmin;
          ch.canPostMessages = check.canPostMessages;
          ch.title = nextTitle;
          await db.query(
            `UPDATE promo_channels
             SET bot_is_admin = $1, can_post_messages = $2, title = $3, updated_at = CURRENT_TIMESTAMP
             WHERE id = $4`,
            [check.botIsAdmin, check.canPostMessages, nextTitle, ch.id]
          ).catch(() => {});
        })
      );
      await this.invalidateCaches();
    }

    const activeChannels = channels.filter(c => c.isActive);
    const verifiedChannels = activeChannels.filter(c => c.botIsAdmin && c.canPostMessages);
    const productsCount = catalog.total;

    const channelDiagnostics: PromotionChannelDiagnostic[] = channels.map(ch => {
      let issue: string | undefined;
      if (!ch.isActive) {
        issue = 'Paused by admin';
      } else if (!ch.botIsAdmin) {
        issue = 'Bot lacks Administrator rights';
      } else if (!ch.canPostMessages) {
        issue = 'Missing Post Messages permission';
      }
      return {
        id: ch.id,
        channelIdentifier: ch.channelIdentifier,
        title: ch.title,
        isActive: ch.isActive,
        botIsAdmin: ch.botIsAdmin,
        canPostMessages: ch.canPostMessages,
        eligible: ch.isActive && ch.botIsAdmin && ch.canPostMessages,
        issue,
      };
    });

    const issues: string[] = [];
    if (channels.length === 0) {
      issues.push('❌ No Channels Added');
    } else if (activeChannels.length === 0) {
      issues.push('❌ All Channels Paused');
    } else {
      const noAdmin = activeChannels.filter(c => !c.botIsAdmin);
      const noPost = activeChannels.filter(c => c.botIsAdmin && !c.canPostMessages);
      if (noAdmin.length > 0) {
        issues.push(`❌ Bot Not Admin in ${noAdmin.map(c => c.channelIdentifier).join(', ')}`);
      }
      if (noPost.length > 0) {
        issues.push(`❌ Missing Post Messages Permission (${noPost.map(c => c.channelIdentifier).join(', ')})`);
      }
    }

    if (productsCount === 0) {
      issues.push('❌ No Products Found');
    }

    const status: PromotionReadinessReport['status'] =
      issues.length > 0 ? 'NOT_READY' : cfg.enabled ? 'READY' : 'PAUSED';

    let nextPromotionAt: string | null = null;
    let nextPromotionLabel = 'Paused';
    if (cfg.enabled) {
      if (issues.length > 0) {
        nextPromotionLabel = 'Blocked (Fix requirements below)';
      } else if (!cfg.lastPostedAt) {
        nextPromotionAt = new Date(Date.now() + 60_000).toISOString();
        nextPromotionLabel = 'Within 60s';
      } else {
        const nextMs = new Date(cfg.lastPostedAt).getTime() + cfg.intervalMinutes * 60_000;
        if (nextMs <= Date.now()) {
          nextPromotionAt = new Date(Date.now() + 60_000).toISOString();
          nextPromotionLabel = 'Within 60s';
        } else {
          const nextDate = new Date(nextMs);
          nextPromotionAt = nextDate.toISOString();
          nextPromotionLabel = nextDate.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: 'UTC',
          }) + ' UTC';
        }
      }
    }

    return {
      enabled: cfg.enabled,
      status,
      channelsCount: channels.length,
      activeChannelsCount: activeChannels.length,
      verifiedChannelsCount: verifiedChannels.length,
      productsCount,
      intervalMinutes: cfg.intervalMinutes,
      intervalLabel: this.formatIntervalLabel(cfg.intervalMinutes),
      lastPostedAt: cfg.lastPostedAt,
      nextPromotionAt,
      nextPromotionLabel,
      issues,
      channelDiagnostics,
      schedulerRunning: Boolean(this.schedulerTimer),
    };
  }

  /**
   * One-click Test Promotion: verifies permissions live, sends immediately to the
   * first eligible channel without altering scheduled cooldown timestamps, and returns full diagnostics.
   */
  public async sendTestPromotion(adminId: string): Promise<TestPromotionResult> {
    const report = await this.getReadinessReport({ refreshChannelChecks: true });

    if (report.channelsCount === 0) {
      return {
        ok: false,
        failureHeadline: '❌ No Channels Added',
        diagnostics: ['Add at least one channel under Auto Promo first, and promote the bot to Admin with Post Messages enabled.'],
      };
    }

    if (report.activeChannelsCount === 0) {
      return {
        ok: false,
        failureHeadline: '❌ All Channels Paused',
        diagnostics: ['Enable at least one channel in the Auto Promo channel list.'],
      };
    }

    const target = report.channelDiagnostics.find(c => c.eligible);
    if (!target) {
      const channelReasons = report.channelDiagnostics.map(
        c => `• ${c.channelIdentifier}: ${c.issue || 'Not eligible'}`
      );
      return {
        ok: false,
        failureHeadline: report.issues[0] || '❌ Missing Post Messages Permission',
        diagnostics: channelReasons,
      };
    }

    const product = await this.selectProductForPromotion();
    if (!product) {
      return {
        ok: false,
        channelUsed: {
          id: target.id,
          channelIdentifier: target.channelIdentifier,
          title: target.title,
        },
        failureHeadline: '❌ No Products Found',
        diagnostics: [
          `Target Channel: ${target.title} (${target.channelIdentifier})`,
          'Active in-stock catalog count is 0. Sync supplier products or ensure stock > 0.',
        ],
      };
    }

    const botUsername = await telegramClient.getActiveBotUsername();
    const { text, replyMarkup } = this.formatPromotionMessage(
      product.name,
      product.sellingPrice,
      product.id,
      botUsername
    );

    const res = await telegramClient
      .sendMessage(target.channelIdentifier, text, { reply_markup: replyMarkup })
      .catch((err: any) => ({ ok: false, description: err?.message || 'Telegram request failed' }));

    const ok = Boolean(res?.ok);
    const msgId = res?.result?.message_id ? Number(res.result.message_id) : undefined;
    const errText = ok ? null : String(res?.description || 'Telegram sendMessage failed');

    await db.query(
      `INSERT INTO promotion_posts (
        id, channel_id, product_id, telegram_message_id, status, error_message, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
      [
        `pp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        target.id,
        product.id,
        msgId || null,
        ok ? 'POSTED' : 'FAILED',
        errText,
        adminId,
      ]
    ).catch(() => {});

    if (ok) {
      return {
        ok: true,
        channelUsed: {
          id: target.id,
          channelIdentifier: target.channelIdentifier,
          title: target.title,
        },
        productUsed: {
          id: product.id,
          name: product.name,
          rateUsd: product.sellingPrice,
        },
        telegramMessageId: msgId,
        diagnostics: [
          `Channel Verified: Admin ✅ + Post Messages ✅`,
          `Message ID: #${msgId || 'sent'}`,
          `Deep Link: ${botUsername ? `t.me/${botUsername}?start=orders_${product.id}` : 'Callback fallback'}`,
        ],
      };
    }

    return {
      ok: false,
      channelUsed: {
        id: target.id,
        channelIdentifier: target.channelIdentifier,
        title: target.title,
      },
      productUsed: {
        id: product.id,
        name: product.name,
        rateUsd: product.sellingPrice,
      },
      failureHeadline: '❌ Failed to Send Test Promotion',
      diagnostics: [
        `Target Channel: ${target.title} (${target.channelIdentifier})`,
        `Telegram Error: ${res?.error_code ? `[${res.error_code}] ` : ''}${errText}`,
      ],
    };
  }

  public async runAutoPromotionCycle(): Promise<PromotionBroadcastSummary | null> {
    if (this.cycleInFlight) {
      return null;
    }
    this.cycleInFlight = true;
    try {
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
    } finally {
      this.cycleInFlight = false;
    }
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
