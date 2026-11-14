import { db } from '../db/index.js';
import { redis } from './redis.js';
import { telegramClient } from '../telegram/client.js';
import { ButtonBuilder } from '../telegram/buttonBuilder.js';
import { TelegramInlineKeyboardButton, TelegramInlineKeyboardMarkup } from '../telegram/types.js';
import { createLogger } from './logger.js';

const logger = createLogger('AnnouncementService');

export type AnnouncementMediaType = 'TEXT' | 'PHOTO' | 'BANNER';
export type AnnouncementStatus = 'DRAFT' | 'SENDING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

export interface AnnouncementButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface AnnouncementRecord {
  id: string;
  title: string;
  messageText: string;
  mediaType: AnnouncementMediaType;
  mediaFileId: string | null;
  buttons: AnnouncementButton[];
  status: AnnouncementStatus;
  totalUsers: number;
  deliveredCount: number;
  failedCount: number;
  blockedCount: number;
  createdBy: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BroadcastStartOptions {
  batchSize?: number;
  batchDelayMs?: number;
  maxRetryWaitMs?: number;
}

export class AnnouncementService {
  private readonly listCacheKey = 'ann:list';
  private activeWorkers = new Map<string, Promise<void>>();
  private cancelledIds = new Set<string>();

  private metaCacheKey(id: string): string {
    return `ann:meta:${id}`;
  }

  private async invalidateCache(id?: string): Promise<void> {
    await Promise.all([
      redis.del(this.listCacheKey).catch(() => {}),
      id ? redis.del(this.metaCacheKey(id)).catch(() => {}) : Promise.resolve(),
    ]);
  }

  private mapRow(r: any): AnnouncementRecord {
    const rawBtns = typeof r.buttonsJson === 'string' ? JSON.parse(r.buttonsJson) : r.buttonsJson || [];
    return {
      id: r.id,
      title: r.title,
      messageText: r.messageText,
      mediaType: (r.mediaType || 'TEXT') as AnnouncementMediaType,
      mediaFileId: r.mediaFileId || null,
      buttons: Array.isArray(rawBtns) ? rawBtns : [],
      status: (r.status || 'DRAFT') as AnnouncementStatus,
      totalUsers: Number(r.totalUsers || 0),
      deliveredCount: Number(r.deliveredCount || 0),
      failedCount: Number(r.failedCount || 0),
      blockedCount: Number(r.blockedCount || 0),
      createdBy: r.createdBy,
      startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
      completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  }

  public parseButtonsInput(raw: string): AnnouncementButton[] {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.toLowerCase() === 'clear' || trimmed.toLowerCase() === 'none') {
      return [];
    }

    const lines = trimmed
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);

    const parsed: AnnouncementButton[] = [];
    for (const line of lines.slice(0, 6)) {
      const sepIdx = line.indexOf('|');
      if (sepIdx === -1) {
        throw new Error('Each button line must use format: Label | https://example.com (or callback_data)');
      }
      const text = line.slice(0, sepIdx).trim();
      const target = line.slice(sepIdx + 1).trim();
      if (!text || !target) {
        throw new Error('Button label and URL/callback cannot be empty.');
      }
      if (target.startsWith('https://') || target.startsWith('http://')) {
        parsed.push({ text: text.slice(0, 48), url: target });
      } else {
        if (Buffer.byteLength(target, 'utf8') > 64) {
          throw new Error(`Callback route "${target}" exceeds 64 bytes.`);
        }
        parsed.push({ text: text.slice(0, 48), callback_data: target });
      }
    }
    return parsed;
  }

  public buildReplyMarkup(buttons: AnnouncementButton[]): TelegramInlineKeyboardMarkup | undefined {
    if (!buttons || buttons.length === 0) return undefined;
    const built = buttons
      .map((b): TelegramInlineKeyboardButton | null => {
        if (!b.text) return null;
        if (b.url) {
          return { text: b.text.slice(0, 48), url: b.url };
        }
        if (b.callback_data) {
          return ButtonBuilder.buildButton({
            text: b.text.slice(0, 48),
            style: 'primary',
            callbackData: b.callback_data,
            forceVisible: true,
          });
        }
        return null;
      })
      .filter((b): b is TelegramInlineKeyboardButton => Boolean(b));

    if (built.length === 0) return undefined;
    return {
      inline_keyboard: ButtonBuilder.buildGrid(built, 2),
    };
  }

  public async createAnnouncement(
    params: {
      title: string;
      messageText: string;
      mediaType?: AnnouncementMediaType;
      mediaFileId?: string | null;
      buttons?: AnnouncementButton[];
    },
    adminId: string
  ): Promise<AnnouncementRecord> {
    const title = params.title.trim();
    const messageText = params.messageText.trim();
    if (!title) throw new Error('Announcement title cannot be empty.');
    if (!messageText) throw new Error('Announcement message text cannot be empty.');

    const mediaType: AnnouncementMediaType = params.mediaType || (params.mediaFileId ? 'PHOTO' : 'TEXT');
    const mediaFileId = params.mediaFileId ? params.mediaFileId.trim() : null;
    if ((mediaType === 'PHOTO' || mediaType === 'BANNER') && !mediaFileId) {
      throw new Error(`${mediaType} announcement requires a valid photo URL or Telegram file_id.`);
    }

    const id = `ann_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const buttons = params.buttons || [];

    await db.query(
      `INSERT INTO announcements (
        id, title, message_text, media_type, media_file_id, buttons_json,
        status, total_users, delivered_count, failed_count, blocked_count,
        created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'DRAFT', 0, 0, 0, 0, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, title, messageText, mediaType, mediaFileId, JSON.stringify(buttons), adminId]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'CREATE_ANNOUNCEMENT', 'announcements', $3, $4)`,
      [
        `aud_ann_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        id,
        JSON.stringify({ title, mediaType, buttonsCount: buttons.length }),
      ]
    ).catch(() => {});

    await this.invalidateCache(id);
    return (await this.getAnnouncementById(id))!;
  }

  public async updateAnnouncement(
    id: string,
    patch: Partial<{
      title: string;
      messageText: string;
      mediaType: AnnouncementMediaType;
      mediaFileId: string | null;
      buttons: AnnouncementButton[];
    }>,
    adminId: string
  ): Promise<AnnouncementRecord> {
    const existing = await this.getAnnouncementById(id);
    if (!existing) throw new Error(`Announcement ${id} not found.`);
    if (existing.status === 'SENDING') {
      throw new Error('Cannot edit an announcement while broadcast is running.');
    }

    const nextTitle = patch.title !== undefined ? patch.title.trim() : existing.title;
    const nextText = patch.messageText !== undefined ? patch.messageText.trim() : existing.messageText;
    const nextMediaType = patch.mediaType !== undefined ? patch.mediaType : existing.mediaType;
    const nextMediaFileId = patch.mediaFileId !== undefined ? patch.mediaFileId : existing.mediaFileId;
    const nextButtons = patch.buttons !== undefined ? patch.buttons : existing.buttons;

    if (!nextTitle) throw new Error('Announcement title cannot be empty.');
    if (!nextText) throw new Error('Announcement message text cannot be empty.');

    await db.query(
      `UPDATE announcements
       SET title = $1,
           message_text = $2,
           media_type = $3,
           media_file_id = $4,
           buttons_json = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [nextTitle, nextText, nextMediaType, nextMediaFileId, JSON.stringify(nextButtons), id]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'UPDATE_ANNOUNCEMENT', 'announcements', $3, $4)`,
      [
        `aud_ann_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        id,
        JSON.stringify({ title: nextTitle, mediaType: nextMediaType }),
      ]
    ).catch(() => {});

    await this.invalidateCache(id);
    return (await this.getAnnouncementById(id))!;
  }

  public async getAnnouncementById(id: string): Promise<AnnouncementRecord | null> {
    const key = this.metaCacheKey(id);
    try {
      const cached = await redis.get(key);
      if (cached) return JSON.parse(cached) as AnnouncementRecord;
    } catch {
      // Cache miss
    }

    const r = await db.queryRow<any>(
      `SELECT id, title, message_text as "messageText", media_type as "mediaType",
              media_file_id as "mediaFileId", buttons_json as "buttonsJson",
              status, total_users as "totalUsers", delivered_count as "deliveredCount",
              failed_count as "failedCount", blocked_count as "blockedCount",
              created_by as "createdBy", started_at as "startedAt",
              completed_at as "completedAt", created_at as "createdAt", updated_at as "updatedAt"
       FROM announcements
       WHERE id = $1`,
      [id]
    );
    if (!r) return null;
    const mapped = this.mapRow(r);
    await redis.set(key, JSON.stringify(mapped), 60).catch(() => {});
    return mapped;
  }

  public async listAnnouncements(limit = 20): Promise<AnnouncementRecord[]> {
    if (limit === 20) {
      try {
        const cached = await redis.get(this.listCacheKey);
        if (cached) return JSON.parse(cached) as AnnouncementRecord[];
      } catch {
        // Cache miss
      }
    }

    const res = await db.query<any>(
      `SELECT id, title, message_text as "messageText", media_type as "mediaType",
              media_file_id as "mediaFileId", buttons_json as "buttonsJson",
              status, total_users as "totalUsers", delivered_count as "deliveredCount",
              failed_count as "failedCount", blocked_count as "blockedCount",
              created_by as "createdBy", started_at as "startedAt",
              completed_at as "completedAt", created_at as "createdAt", updated_at as "updatedAt"
       FROM announcements
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    const list = res.rows.map(r => this.mapRow(r));
    if (limit === 20) {
      await redis.set(this.listCacheKey, JSON.stringify(list), 60).catch(() => {});
    }
    return list;
  }

  private async deliverToChat(
    ann: Pick<AnnouncementRecord, 'messageText' | 'mediaType' | 'mediaFileId' | 'buttons'>,
    chatId: number | string
  ): Promise<any> {
    const replyMarkup = this.buildReplyMarkup(ann.buttons);
    if ((ann.mediaType === 'PHOTO' || ann.mediaType === 'BANNER') && ann.mediaFileId) {
      return await telegramClient.sendPhoto(chatId, ann.mediaFileId, ann.messageText, {
        reply_markup: replyMarkup,
      });
    }
    return await telegramClient.sendMessage(chatId, ann.messageText, {
      reply_markup: replyMarkup,
    });
  }

  public async sendPreview(
    ann: Pick<AnnouncementRecord, 'messageText' | 'mediaType' | 'mediaFileId' | 'buttons'>,
    adminChatId: number | string
  ): Promise<any> {
    return await this.deliverToChat(ann, adminChatId);
  }

  private isBlockedTelegramError(res: any): boolean {
    const code = Number(res?.error_code || 0);
    const desc = String(res?.description || '').toLowerCase();
    return (
      code === 403 ||
      desc.includes('blocked') ||
      desc.includes('deactivated') ||
      desc.includes('chat not found') ||
      desc.includes('bot was kicked')
    );
  }

  /**
   * Non-blocking background broadcast launcher.
   * Immediately updates DB status to SENDING and schedules asynchronous chunked delivery via setImmediate.
   */
  public async startBroadcast(
    announcementId: string,
    adminId: string,
    options: BroadcastStartOptions = {}
  ): Promise<{ announcement: AnnouncementRecord; started: boolean }> {
    const ann = await this.getAnnouncementById(announcementId);
    if (!ann) throw new Error(`Announcement ${announcementId} not found.`);
    if (ann.status === 'SENDING' || this.activeWorkers.has(announcementId)) {
      throw new Error('This announcement broadcast is already in progress.');
    }

    const usersRes = await db.query<{ id: string }>('SELECT id FROM users ORDER BY created_at ASC');
    const userIds = usersRes.rows.map(r => String(r.id));

    this.cancelledIds.delete(announcementId);

    await db.query(
      `UPDATE announcements
       SET status = 'SENDING',
           total_users = $1,
           delivered_count = 0,
           failed_count = 0,
           blocked_count = 0,
           started_at = CURRENT_TIMESTAMP,
           completed_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [userIds.length, announcementId]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'START_ANNOUNCEMENT_BROADCAST', 'announcements', $3, $4)`,
      [
        `aud_ann_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        announcementId,
        JSON.stringify({ totalUsers: userIds.length }),
      ]
    ).catch(() => {});

    await this.invalidateCache(announcementId);
    const updated = (await this.getAnnouncementById(announcementId))!;

    const workerPromise = new Promise<void>((resolve) => {
      setImmediate(async () => {
        try {
          await this.runBroadcastLoop(updated, userIds, options);
        } catch (err: any) {
          logger.error('Broadcast background loop failed', { announcementId, error: err?.message });
        } finally {
          this.activeWorkers.delete(announcementId);
          resolve();
        }
      });
    });

    this.activeWorkers.set(announcementId, workerPromise);
    return { announcement: updated, started: true };
  }

  private async runBroadcastLoop(
    ann: AnnouncementRecord,
    userIds: string[],
    options: BroadcastStartOptions
  ): Promise<void> {
    const batchSize = Math.max(1, options.batchSize ?? 20);
    const batchDelayMs = Math.max(0, options.batchDelayMs ?? 35);
    const maxRetryWaitMs = Math.max(5, options.maxRetryWaitMs ?? 3000);

    let delivered = 0;
    let failed = 0;
    let blocked = 0;
    let wasCancelled = false;

    for (let i = 0; i < userIds.length; i += batchSize) {
      if (this.cancelledIds.has(ann.id)) {
        wasCancelled = true;
        break;
      }

      const freshStatus = await db.queryRow<{ status: string }>(
        'SELECT status FROM announcements WHERE id = $1',
        [ann.id]
      );
      if (freshStatus?.status === 'CANCELLED') {
        wasCancelled = true;
        break;
      }

      const batch = userIds.slice(i, i + batchSize);
      for (const uid of batch) {
        if (this.cancelledIds.has(ann.id)) {
          wasCancelled = true;
          break;
        }

        try {
          let res = await this.deliverToChat(ann, uid);

          // Rate limit protection (429 retry_after backoff)
          if (!res?.ok && (Number(res?.error_code) === 429 || res?.parameters?.retry_after)) {
            const retrySec = Number(res?.parameters?.retry_after || 1);
            const waitMs = Math.min(Math.max(10, retrySec * 1000), maxRetryWaitMs);
            await new Promise(r => setTimeout(r, waitMs));
            res = await this.deliverToChat(ann, uid);
          }

          if (res?.ok) {
            delivered += 1;
          } else if (this.isBlockedTelegramError(res)) {
            blocked += 1;
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        }
      }

      await db.query(
        `UPDATE announcements
         SET delivered_count = $1,
             failed_count = $2,
             blocked_count = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [delivered, failed, blocked, ann.id]
      );
      await this.invalidateCache(ann.id);

      if (wasCancelled) break;

      // Cooperative yield so customer Shop / Wallet / Orders never freeze
      await new Promise<void>(r => {
        if (batchDelayMs > 0) setTimeout(r, batchDelayMs);
        else setImmediate(r);
      });
    }

    const finalStatus: AnnouncementStatus = wasCancelled || this.cancelledIds.has(ann.id) ? 'CANCELLED' : 'COMPLETED';
    await db.query(
      `UPDATE announcements
       SET status = $1,
           delivered_count = $2,
           failed_count = $3,
           blocked_count = $4,
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [finalStatus, delivered, failed, blocked, ann.id]
    );
    await this.invalidateCache(ann.id);
    logger.info('Announcement broadcast finished', {
      announcementId: ann.id,
      status: finalStatus,
      totalUsers: userIds.length,
      delivered,
      failed,
      blocked,
    });
  }

  public async cancelBroadcast(announcementId: string, adminId: string): Promise<AnnouncementRecord | null> {
    const existing = await this.getAnnouncementById(announcementId);
    if (!existing) return null;

    this.cancelledIds.add(announcementId);
    await db.query(
      `UPDATE announcements
       SET status = 'CANCELLED',
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status IN ('DRAFT', 'SENDING')`,
      [announcementId]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'CANCEL_ANNOUNCEMENT_BROADCAST', 'announcements', $3, $4)`,
      [
        `aud_ann_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        adminId,
        announcementId,
        JSON.stringify({ previousStatus: existing.status }),
      ]
    ).catch(() => {});

    await this.invalidateCache(announcementId);
    return await this.getAnnouncementById(announcementId);
  }

  public async waitForBroadcast(announcementId: string, timeoutMs = 10000): Promise<void> {
    const worker = this.activeWorkers.get(announcementId);
    if (!worker) return;
    await Promise.race([
      worker,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Broadcast wait timeout')), timeoutMs)),
    ]);
  }
}

export const announcementService = new AnnouncementService();
