import { db } from '../db/index.js';
import { redis } from './redis.js';
import { createLogger } from './logger.js';

const logger = createLogger('SettingsService');

export interface MaintenanceConfig {
  enabled: boolean;
  message: string;
}

export interface BannerImagesConfig {
  welcomeBannerUrl: string;
  shopBannerUrl: string;
  supportBannerUrl: string;
}

const DEFAULT_MAINTENANCE: MaintenanceConfig = {
  enabled: false,
  message:
    '⚠️ *MAINTENANCE IN PROGRESS*\n\nXERO KHAN is undergoing a brief scheduled upgrade. Please check back in a few minutes.',
};

const DEFAULT_BANNERS: BannerImagesConfig = {
  welcomeBannerUrl: '',
  shopBannerUrl: '',
  supportBannerUrl: '',
};

export class SettingsService {
  private readonly maintCacheKey = 'sys:maintenance_config';
  private readonly bannerCacheKey = 'sys:banner_images';

  public async getMaintenanceConfig(): Promise<MaintenanceConfig> {
    try {
      const cached = await redis.get(this.maintCacheKey);
      if (cached) return JSON.parse(cached) as MaintenanceConfig;
    } catch {
      // Cache miss
    }

    const row = await db.queryRow<any>("SELECT value FROM system_settings WHERE key = 'maintenance_config'");
    const val = typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value || {};
    const cfg: MaintenanceConfig = {
      enabled: Boolean(val.enabled),
      message: String(val.message || DEFAULT_MAINTENANCE.message),
    };
    await redis.set(this.maintCacheKey, JSON.stringify(cfg), 60).catch(() => {});
    return cfg;
  }

  public async updateMaintenanceConfig(
    patch: Partial<MaintenanceConfig>,
    adminId: string
  ): Promise<MaintenanceConfig> {
    const curr = await this.getMaintenanceConfig();
    const next: MaintenanceConfig = {
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : curr.enabled,
      message: patch.message !== undefined ? String(patch.message).trim() || DEFAULT_MAINTENANCE.message : curr.message,
    };

    await db.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('maintenance_config', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify(next)]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'UPDATE_MAINTENANCE_CONFIG', 'system_settings', 'maintenance_config', $3)`,
      [`aud_set_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`, adminId, JSON.stringify(next)]
    );

    await redis.del(this.maintCacheKey).catch(() => {});
    logger.info('Maintenance configuration updated', { enabled: next.enabled, adminId });
    return next;
  }

  public async getBannerImages(): Promise<BannerImagesConfig> {
    try {
      const cached = await redis.get(this.bannerCacheKey);
      if (cached) return JSON.parse(cached) as BannerImagesConfig;
    } catch {
      // Cache miss
    }

    const row = await db.queryRow<any>("SELECT value FROM system_settings WHERE key = 'banner_images'");
    const val = typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value || {};
    const cfg: BannerImagesConfig = {
      welcomeBannerUrl: String(val.welcomeBannerUrl || '').trim(),
      shopBannerUrl: String(val.shopBannerUrl || '').trim(),
      supportBannerUrl: String(val.supportBannerUrl || '').trim(),
    };
    await redis.set(this.bannerCacheKey, JSON.stringify(cfg), 60).catch(() => {});
    return cfg;
  }

  public validateBannerValue(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.toLowerCase() === 'clear' || trimmed.toLowerCase() === 'none') {
      return '';
    }
    if (trimmed.startsWith('https://')) {
      return trimmed;
    }
    if (/^[A-Za-z0-9_-]{12,200}$/.test(trimmed)) {
      // Valid Telegram photo file_id
      return trimmed;
    }
    throw new Error('Banner must be an https:// image URL, a Telegram photo, or "clear".');
  }

  public async updateBannerImages(
    patch: Partial<BannerImagesConfig>,
    adminId: string
  ): Promise<BannerImagesConfig> {
    const curr = await this.getBannerImages();
    const next: BannerImagesConfig = {
      welcomeBannerUrl:
        patch.welcomeBannerUrl !== undefined
          ? this.validateBannerValue(patch.welcomeBannerUrl)
          : curr.welcomeBannerUrl,
      shopBannerUrl:
        patch.shopBannerUrl !== undefined
          ? this.validateBannerValue(patch.shopBannerUrl)
          : curr.shopBannerUrl,
      supportBannerUrl:
        patch.supportBannerUrl !== undefined
          ? this.validateBannerValue(patch.supportBannerUrl)
          : curr.supportBannerUrl,
    };

    await db.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('banner_images', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify(next)]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'UPDATE_BANNER_IMAGES', 'system_settings', 'banner_images', $3)`,
      [`aud_ban_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`, adminId, JSON.stringify(next)]
    );

    await redis.del(this.bannerCacheKey).catch(() => {});
    logger.info('Banner images updated', { adminId });
    return next;
  }
}

export const settingsService = new SettingsService();
