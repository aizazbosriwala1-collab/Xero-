import { db } from '../db/index.js';
import { config } from '../config/env.js';
import { customerHandler } from './handlers/customer.js';
import { adminHandler } from './handlers/admin.js';
import { TelegramUpdate } from './types.js';
import { createLogger } from '../services/logger.js';

const logger = createLogger('TelegramBotRouter');

/**
 * Authoritative registry of all valid Telegram callback_data routes (exact or prefix).
 * Used by automated Button-Route & Orphan-Button audits to ensure zero dead/orphan buttons.
 */
export const REGISTERED_CUSTOMER_CALLBACKS = {
  exact: new Set<string>([
    'noop',
    'm:home',
    'm:prod',
    'm:feat',
    'm:srch',
    'm:wall',
    'w:hist',
    'm:dep',
    'dep_m:binance',
    'dep_m:easypaisa',
    'dep_m:jazzcash',
    'm:ord',
    'm:give',
    'm:ref',
    'm:supp',
    'm:prof',
    'm:lang',
    'm:api',
  ]),
  prefixes: ['nav:', 'catp:', 'feat:', 'srch:', 'cat:', 'p:', 'qty:', 'buy:', 'buyc:', 'det:', 'bin_tx:', 'bin_r:', 'bin_sup:', 'gw_cl:', 'lang:'],
};

export const REGISTERED_ADMIN_CALLBACKS = {
  exact: new Set<string>([
    'adm:main',
    'adm:dash',
    'adm:price',
    'adm:cat',
    'adm:ord',
    'adm:wal',
    'adm:gw',
    'adm:sync',
    'adm:dep',
    'adm:hlth',
    'adm:ui',
    'adm:ui_exp',
    'adm:ui_imp',
    'adm:ui_rst_all',
    'adm:ui_rst_all_c',
    'adm:bin_diag',
    'adm:bin_diag_run',
    'adm:bin_diag_clr',
    'adm:sup_diag',
    'adm:sup_diag_run',
    'adm:sup_diag_ord',
    'adm:sup_diag_clr',
  ]),
  prefixes: [
    'adm:cat_tog:',
    'adm:gw_tog:',
    'adm_app:',
    'adm_rej:',
    'adm:prod:',
    'adm_pr:',
    'adm_set_fm:',
    'adm_reset_pr:',
    'adm:uis:',
    'adm:uie:',
    'adm:uit:',
    'adm:uiem:',
    'adm:uist:',
    'adm:uiv:',
    'adm:uir:',
    'adm:ui_rs:',
  ],
};

/**
 * Authoritative registry of all Telegram slash commands supported by the router.
 */
export const REGISTERED_TEXT_COMMANDS = [
  'start',
  'shop',
  'featured',
  'search',
  'wallet',
  'deposit',
  'orders',
  'giveaways',
  'refer',
  'support',
  'profile',
  'language',
  'api',
  'admin',
] as const;

export const LEGACY_COMMAND_ALIASES = ['products', 'referral', 'menu', 'help'] as const;

export function isRegisteredTextCommand(command: string): boolean {
  const norm = command.replace(/^\//, '').split('@')[0].trim().toLowerCase();
  return (
    (REGISTERED_TEXT_COMMANDS as readonly string[]).includes(norm) ||
    (LEGACY_COMMAND_ALIASES as readonly string[]).includes(norm)
  );
}

export function isRegisteredCallbackRoute(data: string): boolean {
  if (!data) return false;
  if (data.startsWith('adm')) {
    return (
      REGISTERED_ADMIN_CALLBACKS.exact.has(data) ||
      REGISTERED_ADMIN_CALLBACKS.prefixes.some(p => data.startsWith(p))
    );
  }
  return (
    REGISTERED_CUSTOMER_CALLBACKS.exact.has(data) ||
    REGISTERED_CUSTOMER_CALLBACKS.prefixes.some(p => data.startsWith(p))
  );
}

export class TelegramBotRouter {
  private inFlightUpdates = new Set<number>();

  /**
   * Process incoming Telegram update with duplicate update idempotency & sanitized phase timing.
   */
  public async handleUpdate(update: TelegramUpdate, secretHeader?: string): Promise<{ ok: boolean; status: string }> {
    const updateStartedAt = Date.now();

    // 1. Verify Telegram Webhook Secret Token if configured
    if (config.telegram.webhookSecret && secretHeader !== config.telegram.webhookSecret) {
      logger.warn('Unauthorized webhook request: secret token mismatch');
      return { ok: false, status: 'UNAUTHORIZED' };
    }

    if (!update || !update.update_id) {
      return { ok: false, status: 'INVALID_UPDATE' };
    }

    if (this.inFlightUpdates.has(update.update_id)) {
      logger.info('Concurrent duplicate Telegram update ignored', { updateId: update.update_id });
      return { ok: true, status: 'DUPLICATE_IGNORED' };
    }
    this.inFlightUpdates.add(update.update_id);

    try {
      // 2. Duplicate update protection (atomic DB insert + unique PK enforcement)
      const dedupStartedAt = Date.now();
      try {
        await db.query(
          'INSERT INTO telegram_processed_updates (update_id, processed_at) VALUES ($1, CURRENT_TIMESTAMP)',
          [update.update_id]
        );
      } catch (err: any) {
        const msg = String(err?.message || '').toLowerCase();
        if (err?.code === '23505' || msg.includes('duplicate') || msg.includes('unique') || msg.includes('primary')) {
          logger.info('Duplicate Telegram update ignored', { updateId: update.update_id });
          return { ok: true, status: 'DUPLICATE_IGNORED' };
        }
        logger.error('Error recording processed update', { error: err.message, updateId: update.update_id });
      }
      const dedupMs = Date.now() - dedupStartedAt;

      let route = 'unknown';
      let status = 'IGNORED';
      const handlerStartedAt = Date.now();

      // 3. Route Callback Query
      if (update.callback_query) {
        const cb = update.callback_query;
        route = cb.data ? cb.data.split(':').slice(0, 2).join(':') : 'callback:empty';
        try {
          if (cb.data?.startsWith('adm')) {
            await adminHandler.handleCallback(cb);
          } else {
            await customerHandler.handleCallback(cb);
          }
        } catch (err: any) {
          logger.error('Error handling callback query', { error: err.message, route });
        }
        status = 'CALLBACK_PROCESSED';
      } else if (update.message) {
        // 4. Route Message
        const msg = update.message;
        const text = msg.text?.trim() || '';
        const cmdMatch = text.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+(.*))?$/);
        const command = cmdMatch ? cmdMatch[1].toLowerCase() : null;
        const commandArg = cmdMatch?.[2]?.trim();

        try {
          if (command === 'start') {
            route = '/start';
            await customerHandler.handleStart(msg, commandArg);
            status = 'START_PROCESSED';
          } else if (command === 'menu') {
            route = '/menu';
            await customerHandler.handleTextMessage(msg);
            status = 'MENU_PROCESSED';
          } else if (command === 'admin') {
            route = '/admin';
            await adminHandler.handleAdminCommand(msg);
            status = 'ADMIN_PROCESSED';
          } else if (command === 'shop' || command === 'products') {
            route = `/${command}`;
            await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:prod' });
            status = 'PRODUCTS_PROCESSED';
          } else if (command === 'featured') {
            route = '/featured';
            await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:feat' });
            status = 'FEATURED_PROCESSED';
          } else if (command === 'search') {
            route = '/search';
            await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:srch' });
            status = 'SEARCH_PROCESSED';
          } else if (command === 'wallet') {
            route = '/wallet';
            await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:wall' });
            status = 'WALLET_PROCESSED';
          } else if (command === 'deposit') {
            route = '/deposit';
            await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:dep' });
            status = 'DEPOSIT_PROCESSED';
          } else if (command === 'orders') {
            route = '/orders';
            await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:ord' });
            status = 'ORDERS_PROCESSED';
          } else if (command === 'giveaways') {
            route = '/giveaways';
            await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:give' });
            status = 'GIVEAWAYS_PROCESSED';
          } else if (command === 'refer' || command === 'referral') {
            route = `/${command}`;
            await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:ref' });
            status = 'REFERRAL_PROCESSED';
          } else if (command === 'support') {
            route = '/support';
            await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:supp' });
            status = 'SUPPORT_PROCESSED';
          } else if (command === 'profile') {
            route = '/profile';
            await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:prof' });
            status = 'PROFILE_PROCESSED';
          } else if (command === 'language') {
            route = '/language';
            await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:lang' });
            status = 'LANGUAGE_PROCESSED';
          } else if (command === 'api') {
            route = '/api';
            await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:api' });
            status = 'API_PROCESSED';
          } else if (command === 'help') {
            route = '/help';
            await customerHandler.handleStart(msg);
            status = 'HELP_PROCESSED';
          } else if (msg.photo && msg.photo.length > 0) {
            route = 'photo';
            await customerHandler.handlePhoto(msg);
            status = 'PHOTO_PROCESSED';
          } else if (text) {
            route = 'text_or_reply_button';
            await customerHandler.handleTextMessage(msg);
            status = 'TEXT_PROCESSED';
          }
        } catch (err: any) {
          logger.error('Error processing message update', { error: err.message, route });
        }
      }

      const handlerMs = Date.now() - handlerStartedAt;
      const totalMs = Date.now() - updateStartedAt;
      if (status !== 'IGNORED') {
        logger.debug('Telegram update timing', {
          updateId: update.update_id,
          route,
          status,
          dedupMs,
          handlerMs,
          totalMs,
        });
      }

      return { ok: true, status };
    } finally {
      this.inFlightUpdates.delete(update.update_id);
    }
  }
}

export const telegramBotRouter = new TelegramBotRouter();
