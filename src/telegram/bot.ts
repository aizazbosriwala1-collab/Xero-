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
  ]),
  prefixes: ['nav:', 'catp:', 'feat:', 'srch:', 'cat:', 'p:', 'qty:', 'buy:', 'buyc:', 'det:', 'bin_tx:', 'gw_cl:', 'lang:'],
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
  /**
   * Process incoming Telegram update with duplicate update idempotency.
   */
  public async handleUpdate(update: TelegramUpdate, secretHeader?: string): Promise<{ ok: boolean; status: string }> {
    // 1. Verify Telegram Webhook Secret Token if configured
    if (config.telegram.webhookSecret && secretHeader !== config.telegram.webhookSecret) {
      logger.warn('Unauthorized webhook request: secret token mismatch');
      return { ok: false, status: 'UNAUTHORIZED' };
    }

    if (!update || !update.update_id) {
      return { ok: false, status: 'INVALID_UPDATE' };
    }

    // 2. Duplicate update protection (idempotency)
    try {
      const existing = await db.queryRow<any>(
        'SELECT update_id FROM telegram_processed_updates WHERE update_id = $1',
        [update.update_id]
      );

      if (existing) {
        logger.info('Duplicate Telegram update ignored', { updateId: update.update_id });
        return { ok: true, status: 'DUPLICATE_IGNORED' };
      }

      await db.query(
        'INSERT INTO telegram_processed_updates (update_id, processed_at) VALUES ($1, CURRENT_TIMESTAMP)',
        [update.update_id]
      );
    } catch (err: any) {
      logger.error('Error recording processed update', { error: err.message, updateId: update.update_id });
    }

    // 3. Route Callback Query
    if (update.callback_query) {
      const cb = update.callback_query;
      try {
        if (cb.data?.startsWith('adm')) {
          await adminHandler.handleCallback(cb);
        } else {
          await customerHandler.handleCallback(cb);
        }
      } catch (err: any) {
        logger.error('Error handling callback query', { error: err.message, data: cb.data });
      }
      return { ok: true, status: 'CALLBACK_PROCESSED' };
    }

    // 4. Route Message
    if (update.message) {
      const msg = update.message;
      const text = msg.text?.trim() || '';

      try {
        if (text.startsWith('/start')) {
          const parts = text.split(' ');
          const refCode = parts[1];
          await customerHandler.handleStart(msg, refCode);
          return { ok: true, status: 'START_PROCESSED' };
        }

        if (text === '/menu') {
          await customerHandler.handleTextMessage(msg);
          return { ok: true, status: 'MENU_PROCESSED' };
        }

        if (text === '/admin') {
          await adminHandler.handleAdminCommand(msg);
          return { ok: true, status: 'ADMIN_PROCESSED' };
        }

        if (text === '/products') {
          await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:prod' });
          return { ok: true, status: 'PRODUCTS_PROCESSED' };
        }

        if (text === '/featured') {
          await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:feat' });
          return { ok: true, status: 'FEATURED_PROCESSED' };
        }

        if (text === '/search') {
          await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:srch' });
          return { ok: true, status: 'SEARCH_PROCESSED' };
        }

        if (text === '/wallet') {
          await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:wall' });
          return { ok: true, status: 'WALLET_PROCESSED' };
        }

        if (text === '/deposit') {
          await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:dep' });
          return { ok: true, status: 'DEPOSIT_PROCESSED' };
        }

        if (text === '/orders') {
          await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:ord' });
          return { ok: true, status: 'ORDERS_PROCESSED' };
        }

        if (text === '/giveaways') {
          await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:give' });
          return { ok: true, status: 'GIVEAWAYS_PROCESSED' };
        }

        if (text === '/referral') {
          await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:ref' });
          return { ok: true, status: 'REFERRAL_PROCESSED' };
        }

        if (text === '/support') {
          await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:supp' });
          return { ok: true, status: 'SUPPORT_PROCESSED' };
        }

        if (text === '/profile') {
          await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:prof' });
          return { ok: true, status: 'PROFILE_PROCESSED' };
        }

        if (text === '/language') {
          await customerHandler.handleCallback({ id: '0', from: msg.from!, message: msg, data: 'm:lang' });
          return { ok: true, status: 'LANGUAGE_PROCESSED' };
        }

        if (text === '/help') {
          await customerHandler.handleStart(msg);
          return { ok: true, status: 'HELP_PROCESSED' };
        }

        if (msg.photo && msg.photo.length > 0) {
          await customerHandler.handlePhoto(msg);
          return { ok: true, status: 'PHOTO_PROCESSED' };
        }

        if (text) {
          await customerHandler.handleTextMessage(msg);
          return { ok: true, status: 'TEXT_PROCESSED' };
        }
      } catch (err: any) {
        logger.error('Error processing message update', { error: err.message, text });
      }
    }

    return { ok: true, status: 'IGNORED' };
  }
}

export const telegramBotRouter = new TelegramBotRouter();
