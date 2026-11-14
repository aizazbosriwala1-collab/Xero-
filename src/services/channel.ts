import { db } from '../db/index.js';
import { redis } from './redis.js';
import { telegramClient } from '../telegram/client.js';
import { createLogger } from './logger.js';

const logger = createLogger('ChannelService');

export interface RequiredChannel {
  id: string;
  channelIdentifier: string;
  title: string;
  inviteUrl: string;
  displayOrder: number;
  isActive: boolean;
  createdAt?: string;
}

export interface ChannelSettingsConfig {
  verificationEnabled: boolean;
  cacheTtlSeconds: number;
}

export interface MembershipCheckDetail {
  channel: RequiredChannel;
  joined: boolean;
  memberStatus: string;
  error?: string;
}

export interface MembershipCheckResult {
  verificationEnabled: boolean;
  allowed: boolean;
  cached: boolean;
  missingChannels: RequiredChannel[];
  details: MembershipCheckDetail[];
}

const VALID_MEMBER_STATUSES = new Set(['creator', 'administrator', 'member', 'restricted']);

export class ChannelService {
  private readonly cfgCacheKey = 'req_channels:cfg';
  private readonly listCacheKey = 'req_channels:list';

  private async invalidateGlobalCache(): Promise<void> {
    await Promise.all([
      redis.del(this.cfgCacheKey).catch(() => {}),
      redis.del(this.listCacheKey).catch(() => {}),
    ]);
  }

  public async invalidateUserCache(userId: string | number): Promise<void> {
    await redis.del(`chan_ok:${String(userId)}`).catch(() => {});
  }

  public async getConfig(): Promise<ChannelSettingsConfig> {
    try {
      const cached = await redis.get(this.cfgCacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        return {
          verificationEnabled: Boolean(parsed.verificationEnabled),
          cacheTtlSeconds: Number(parsed.cacheTtlSeconds || 180),
        };
      }
    } catch {
      // Fallback to DB
    }

    const row = await db.queryRow<any>("SELECT value FROM system_settings WHERE key = 'required_channels_config'");
    const val = typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value || {};
    const cfg: ChannelSettingsConfig = {
      verificationEnabled: Boolean(val.verificationEnabled),
      cacheTtlSeconds: Math.max(30, Number(val.cacheTtlSeconds || 180)),
    };
    await redis.set(this.cfgCacheKey, JSON.stringify(cfg), 60).catch(() => {});
    return cfg;
  }

  public async setVerificationEnabled(enabled: boolean, adminId: string): Promise<ChannelSettingsConfig> {
    const existing = await this.getConfig();
    const next: ChannelSettingsConfig = {
      ...existing,
      verificationEnabled: Boolean(enabled),
    };
    await db.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('required_channels_config', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify(next)]
    );
    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, $3, 'required_channels_config', 'required_channels_config', $4)`,
      [
        `aud_ch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        adminId,
        enabled ? 'ENABLE_CHANNEL_VERIFICATION' : 'DISABLE_CHANNEL_VERIFICATION',
        JSON.stringify(next),
      ]
    );
    await this.invalidateGlobalCache();
    logger.info('Updated required channel verification flag', { enabled, adminId });
    return next;
  }

  public async listChannels(activeOnly = false): Promise<RequiredChannel[]> {
    if (!activeOnly) {
      try {
        const cached = await redis.get(this.listCacheKey);
        if (cached) return JSON.parse(cached) as RequiredChannel[];
      } catch {
        // Fallback to DB
      }
    }

    const res = await db.query<any>(
      `SELECT id, channel_identifier as "channelIdentifier", title, invite_url as "inviteUrl",
              display_order as "displayOrder", is_active as "isActive", created_at as "createdAt"
       FROM required_channels
       ORDER BY display_order ASC, created_at ASC`
    );

    const all: RequiredChannel[] = res.rows.map(r => ({
      id: r.id,
      channelIdentifier: r.channelIdentifier,
      title: r.title,
      inviteUrl: r.inviteUrl,
      displayOrder: Number(r.displayOrder || 0),
      isActive: Boolean(r.isActive),
      createdAt: r.createdAt,
    }));

    if (!activeOnly) {
      await redis.set(this.listCacheKey, JSON.stringify(all), 60).catch(() => {});
      return all;
    }
    return all.filter(c => c.isActive);
  }

  public async addChannel(
    params: {
      channelIdentifier: string;
      title?: string;
      inviteUrl?: string;
    },
    adminId: string
  ): Promise<RequiredChannel> {
    const cleanIdent = params.channelIdentifier.trim();
    if (!cleanIdent || (!cleanIdent.startsWith('@') && !/^-?\d{5,20}$/.test(cleanIdent))) {
      throw new Error('Channel identifier must be a public @username or numeric chat ID (e.g. -1001234567890).');
    }

    let inviteUrl = (params.inviteUrl || '').trim();
    if (!inviteUrl) {
      if (cleanIdent.startsWith('@')) {
        inviteUrl = `https://t.me/${cleanIdent.slice(1)}`;
      } else {
        throw new Error('Private/numeric channel IDs require an https://t.me/... invite link.');
      }
    }
    if (!inviteUrl.startsWith('https://t.me/') && !inviteUrl.startsWith('https://')) {
      throw new Error('Channel invite URL must start with https://');
    }

    const title = (params.title || cleanIdent).trim().slice(0, 64);
    const maxOrderRes = await db.queryRow<{ maxOrder: number | string | null }>(
      'SELECT COALESCE(MAX(display_order), 0) as "maxOrder" FROM required_channels'
    );
    const nextOrder = Number(maxOrderRes?.maxOrder || 0) + 1;
    const id = `ch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    await db.query(
      `INSERT INTO required_channels (
        id, channel_identifier, title, invite_url, display_order, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, cleanIdent, title, inviteUrl, nextOrder]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'ADD_REQUIRED_CHANNEL', 'required_channels', $3, $4)`,
      [
        `aud_ch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        adminId,
        id,
        JSON.stringify({ channelIdentifier: cleanIdent, title, inviteUrl }),
      ]
    );

    await this.invalidateGlobalCache();
    return {
      id,
      channelIdentifier: cleanIdent,
      title,
      inviteUrl,
      displayOrder: nextOrder,
      isActive: true,
    };
  }

  public async removeChannel(channelId: string, adminId: string): Promise<boolean> {
    const existing = await db.queryRow<any>('SELECT * FROM required_channels WHERE id = $1', [channelId]);
    if (!existing) return false;

    await db.query('DELETE FROM required_channels WHERE id = $1', [channelId]);
    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'REMOVE_REQUIRED_CHANNEL', 'required_channels', $3, $4)`,
      [
        `aud_ch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        adminId,
        channelId,
        JSON.stringify({ channelIdentifier: existing.channel_identifier, title: existing.title }),
      ]
    );
    await this.invalidateGlobalCache();
    return true;
  }

  public async moveChannel(channelId: string, direction: 'up' | 'down', adminId: string): Promise<boolean> {
    const channels = await this.listChannels(false);
    const idx = channels.findIndex(c => c.id === channelId);
    if (idx === -1) return false;

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= channels.length) return false;

    const current = channels[idx];
    const swap = channels[targetIdx];

    await db.withTransaction(async (client) => {
      await client.query(
        'UPDATE required_channels SET display_order = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [swap.displayOrder === current.displayOrder ? targetIdx + 1 : swap.displayOrder, current.id]
      );
      await client.query(
        'UPDATE required_channels SET display_order = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [swap.displayOrder === current.displayOrder ? idx + 1 : current.displayOrder, swap.id]
      );
    });

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'REORDER_REQUIRED_CHANNEL', 'required_channels', $3, $4)`,
      [
        `aud_ch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        adminId,
        channelId,
        JSON.stringify({ direction }),
      ]
    );

    await this.invalidateGlobalCache();
    return true;
  }

  /**
   * Verify whether a user has joined all active required channels.
   * Uses short-TTL Redis cache unless forceRefresh=true (e.g. clicking "✅ Verify Membership").
   */
  public async checkUserMembership(
    userId: string | number,
    options?: { forceRefresh?: boolean }
  ): Promise<MembershipCheckResult> {
    const [cfg, channels] = await Promise.all([this.getConfig(), this.listChannels(true)]);

    if (!cfg.verificationEnabled || channels.length === 0) {
      return {
        verificationEnabled: cfg.verificationEnabled,
        allowed: true,
        cached: false,
        missingChannels: [],
        details: [],
      };
    }

    const cacheKey = `chan_ok:${String(userId)}`;
    if (!options?.forceRefresh) {
      const cachedOk = await redis.get(cacheKey).catch(() => null);
      if (cachedOk === '1') {
        return {
          verificationEnabled: true,
          allowed: true,
          cached: true,
          missingChannels: [],
          details: channels.map(ch => ({ channel: ch, joined: true, memberStatus: 'cached_member' })),
        };
      }
    }

    const details = await Promise.all(
      channels.map(async (channel): Promise<MembershipCheckDetail> => {
        try {
          const res = await telegramClient.getChatMember(channel.channelIdentifier, userId);
          if (!res?.ok || !res?.result?.status) {
            return {
              channel,
              joined: false,
              memberStatus: 'check_failed',
              error: res?.description || 'Telegram getChatMember failed',
            };
          }
          const status = String(res.result.status).toLowerCase();
          const isRestrictedMember = status === 'restricted' ? res.result.is_member !== false : true;
          const joined = VALID_MEMBER_STATUSES.has(status) && isRestrictedMember;
          return {
            channel,
            joined,
            memberStatus: status,
          };
        } catch (err: any) {
          return {
            channel,
            joined: false,
            memberStatus: 'error',
            error: err?.message || 'Exception during membership check',
          };
        }
      })
    );

    const missingChannels = details.filter(d => !d.joined).map(d => d.channel);
    const allowed = missingChannels.length === 0;

    if (allowed) {
      await redis.set(cacheKey, '1', cfg.cacheTtlSeconds).catch(() => {});
    } else {
      await redis.del(cacheKey).catch(() => {});
    }

    return {
      verificationEnabled: true,
      allowed,
      cached: false,
      missingChannels,
      details,
    };
  }
}

export const channelService = new ChannelService();
