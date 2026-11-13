import { config } from '../config/env.js';
import {
  TelegramBotCommand,
  TelegramBotCommandScope,
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
  TelegramReplyKeyboardButton,
  TelegramReplyKeyboardMarkup,
} from './types.js';
import { FALLBACK_TEXT_SYMBOL } from './buttonBuilder.js';
import { uiConfigService } from '../services/uiConfig.js';
import { createLogger } from '../services/logger.js';

const logger = createLogger('TelegramClient');

export interface SendMessageOptions {
  parse_mode?: 'Markdown' | 'HTML';
  reply_markup?: TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup;
  disable_web_page_preview?: boolean;
  disable_notification?: boolean;
}

export type TelegramTransport = (method: string, body: Record<string, any>) => Promise<any>;

export class TelegramClient {
  private token?: string;
  private baseUrl: string;
  private transportOverride: TelegramTransport | null = null;
  private rejectedEmojiIds: Map<string, number> = new Map();
  private styleUnsupportedUntil = 0;
  private readonly capabilityCacheTtlMs = 10 * 60 * 1000;

  constructor() {
    this.token = config.telegram.botToken;
    this.baseUrl = 'https://api.telegram.org';
  }

  public setTransportOverride(fn: TelegramTransport | null): void {
    this.transportOverride = fn;
  }

  public clearCapabilityCacheForTests(): void {
    this.rejectedEmojiIds.clear();
    this.styleUnsupportedUntil = 0;
  }

  private getEndpoint(method: string): string {
    if (!this.token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  private collectCustomEmojiIds(markup?: TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup): string[] {
    if (!markup) return [];
    const ids: string[] = [];
    if ('inline_keyboard' in markup) {
      for (const row of markup.inline_keyboard) {
        for (const btn of row) {
          if (btn.icon_custom_emoji_id) ids.push(btn.icon_custom_emoji_id);
        }
      }
    } else if ('keyboard' in markup) {
      for (const row of markup.keyboard) {
        for (const btn of row) {
          if (btn.icon_custom_emoji_id) ids.push(btn.icon_custom_emoji_id);
        }
      }
    }
    return ids;
  }

  private preStripCachedUnsupported(
    markup: TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup | undefined
  ): TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup | undefined {
    if (!markup) return markup;
    const now = Date.now();
    const stripStyle = this.styleUnsupportedUntil > now;

    if ('inline_keyboard' in markup) {
      let changed = false;
      const nextRows = markup.inline_keyboard.map(row =>
        row.map(btn => {
          const emojiExpiredAt = btn.icon_custom_emoji_id ? this.rejectedEmojiIds.get(btn.icon_custom_emoji_id) : undefined;
          const stripThisEmoji = Boolean(emojiExpiredAt && emojiExpiredAt > now);
          const stripThisStyle = Boolean(stripStyle && btn.style);
          if (!stripThisEmoji && !stripThisStyle) return btn;

          changed = true;
          const fallbackText = (btn as any)[FALLBACK_TEXT_SYMBOL] as string | undefined;
          const cloned: TelegramInlineKeyboardButton = {
            text: stripThisEmoji && fallbackText ? fallbackText : btn.text,
          };
          if (btn.callback_data !== undefined) cloned.callback_data = btn.callback_data;
          if (btn.url !== undefined) cloned.url = btn.url;
          if (!stripThisStyle && btn.style) cloned.style = btn.style;
          if (!stripThisEmoji && btn.icon_custom_emoji_id) cloned.icon_custom_emoji_id = btn.icon_custom_emoji_id;
          return cloned;
        })
      );
      return changed ? { inline_keyboard: nextRows } : markup;
    }

    if ('keyboard' in markup) {
      let changed = false;
      const nextRows = markup.keyboard.map(row =>
        row.map(btn => {
          const emojiExpiredAt = btn.icon_custom_emoji_id ? this.rejectedEmojiIds.get(btn.icon_custom_emoji_id) : undefined;
          const stripThisEmoji = Boolean(emojiExpiredAt && emojiExpiredAt > now);
          const stripThisStyle = Boolean(stripStyle && btn.style);
          if (!stripThisEmoji && !stripThisStyle) return btn;

          changed = true;
          const fallbackText = (btn as any)[FALLBACK_TEXT_SYMBOL] as string | undefined;
          const cloned: TelegramReplyKeyboardButton = {
            text: stripThisEmoji && fallbackText ? fallbackText : btn.text,
          };
          if (!stripThisStyle && btn.style) cloned.style = btn.style;
          if (!stripThisEmoji && btn.icon_custom_emoji_id) cloned.icon_custom_emoji_id = btn.icon_custom_emoji_id;
          return cloned;
        })
      );
      return changed ? { ...markup, keyboard: nextRows } : markup;
    }

    return markup;
  }

  private cacheRejectedEmojis(markup: TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup | undefined): void {
    const expiresAt = Date.now() + this.capabilityCacheTtlMs;
    for (const id of this.collectCustomEmojiIds(markup)) {
      this.rejectedEmojiIds.set(id, expiresAt);
    }
  }

  private cloneMarkupStripping(
    markup: TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup | undefined,
    stripEmoji: boolean,
    stripStyle: boolean
  ): TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup | undefined {
    if (!markup) return undefined;

    if ('inline_keyboard' in markup) {
      return {
        inline_keyboard: markup.inline_keyboard.map(row =>
          row.map((btn: TelegramInlineKeyboardButton) => {
            const fallbackText = (btn as any)[FALLBACK_TEXT_SYMBOL] as string | undefined;
            const cloned: TelegramInlineKeyboardButton = {
              text: stripEmoji && fallbackText ? fallbackText : btn.text,
            };
            if (btn.callback_data !== undefined) cloned.callback_data = btn.callback_data;
            if (btn.url !== undefined) cloned.url = btn.url;
            if (!stripStyle && btn.style) cloned.style = btn.style;
            if (!stripEmoji && btn.icon_custom_emoji_id) cloned.icon_custom_emoji_id = btn.icon_custom_emoji_id;
            return cloned;
          })
        ),
      };
    }

    if ('keyboard' in markup) {
      return {
        ...markup,
        keyboard: markup.keyboard.map(row =>
          row.map((btn: TelegramReplyKeyboardButton) => {
            const fallbackText = (btn as any)[FALLBACK_TEXT_SYMBOL] as string | undefined;
            const cloned: TelegramReplyKeyboardButton = {
              text: stripEmoji && fallbackText ? fallbackText : btn.text,
            };
            if (!stripStyle && btn.style) cloned.style = btn.style;
            if (!stripEmoji && btn.icon_custom_emoji_id) cloned.icon_custom_emoji_id = btn.icon_custom_emoji_id;
            return cloned;
          })
        ),
      };
    }

    return markup;
  }

  private hasCustomEmoji(markup?: TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup): boolean {
    if (!markup) return false;
    if ('inline_keyboard' in markup) {
      return markup.inline_keyboard.some(r => r.some(b => Boolean(b.icon_custom_emoji_id)));
    }
    if ('keyboard' in markup) {
      return markup.keyboard.some(r => r.some(b => Boolean(b.icon_custom_emoji_id)));
    }
    return false;
  }

  private hasButtonStyle(markup?: TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup): boolean {
    if (!markup) return false;
    if ('inline_keyboard' in markup) {
      return markup.inline_keyboard.some(r => r.some(b => Boolean(b.style)));
    }
    if ('keyboard' in markup) {
      return markup.keyboard.some(r => r.some(b => Boolean(b.style)));
    }
    return false;
  }

  private isEmojiError(description = ''): boolean {
    const d = description.toLowerCase();
    return (
      d.includes('custom_emoji') ||
      d.includes('icon_custom_emoji_id') ||
      d.includes('document_invalid') ||
      d.includes('emoji')
    );
  }

  private isStyleError(description = ''): boolean {
    const d = description.toLowerCase();
    return d.includes('style') || d.includes('button_type_invalid') || d.includes('unexpected field');
  }

  private async postRaw(method: string, body: Record<string, any>): Promise<any> {
    const startedAt = Date.now();
    if (this.transportOverride) {
      const mockRes = await this.transportOverride(method, body);
      return mockRes;
    }

    if (!this.token) {
      logger.warn('Skipping Telegram API call: TELEGRAM_BOT_TOKEN is not set', { method });
      return { ok: false, description: 'TOKEN_NOT_CONFIGURED' };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(this.getEndpoint(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await res.json();
      const durationMs = Date.now() - startedAt;
      if (!data.ok) {
        logger.warn('Telegram API method returned error', {
          method,
          errorCode: data.error_code,
          description: data.description,
          durationMs,
        });
      } else if (durationMs > 800) {
        logger.info('Slow Telegram API call detected', { method, durationMs });
      }
      return data;
    } catch (err: any) {
      logger.error('Telegram API request exception', {
        method,
        error: err.message,
        durationMs: Date.now() - startedAt,
      });
      return { ok: false, description: err.message };
    }
  }

  /**
   * Safe post with short-TTL capability cache + automatic fallback degradation if Telegram rejects custom emojis or button styles.
   */
  private async post(method: string, body: Record<string, any>): Promise<any> {
    const preparedMarkup = this.preStripCachedUnsupported(
      body.reply_markup as TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup | undefined
    );
    const preparedBody = preparedMarkup !== body.reply_markup ? { ...body, reply_markup: preparedMarkup } : body;

    const res = await this.postRaw(method, preparedBody);
    if (res?.ok) return res;

    const desc = String(res?.description || '');
    const markup = preparedBody.reply_markup as TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup | undefined;

    if (markup && (method === 'sendMessage' || method === 'editMessageText' || method === 'editMessageReplyMarkup')) {
      const hasEmoji = this.hasCustomEmoji(markup);
      const hasStyle = this.hasButtonStyle(markup);

      // Step 1: If rejected due to custom emoji (or generic 400 with custom emoji present), strip custom emoji & cache rejection
      if (hasEmoji && (this.isEmojiError(desc) || res?.error_code === 400)) {
        this.cacheRejectedEmojis(markup);
        logger.warn('Custom emoji rejected by Telegram API; degrading gracefully to Unicode fallback', {
          method,
          description: desc,
        });
        const retryBody1 = {
          ...preparedBody,
          reply_markup: this.cloneMarkupStripping(markup, true, false),
        };
        const retry1 = await this.postRaw(method, retryBody1);
        if (retry1?.ok) return retry1;

        const desc1 = String(retry1?.description || '');
        if (hasStyle && (this.isStyleError(desc1) || retry1?.error_code === 400)) {
          this.styleUnsupportedUntil = Date.now() + this.capabilityCacheTtlMs;
          logger.warn('Button style also rejected; falling back to standard unstyled buttons', { method });
          const retryBody2 = {
            ...preparedBody,
            reply_markup: this.cloneMarkupStripping(markup, true, true),
          };
          return await this.postRaw(method, retryBody2);
        }
        return retry1;
      }

      // Step 2: If rejected due to style field, strip style, cache capability rejection, and retry
      if (hasStyle && this.isStyleError(desc)) {
        this.styleUnsupportedUntil = Date.now() + this.capabilityCacheTtlMs;
        logger.warn('Button style rejected by Telegram API; degrading gracefully to default style', {
          method,
          description: desc,
        });
        const retryBody = {
          ...preparedBody,
          reply_markup: this.cloneMarkupStripping(markup, false, true),
        };
        return await this.postRaw(method, retryBody);
      }
    }

    return res;
  }

  public async getMe(): Promise<any> {
    return await this.post('getMe', {});
  }

  public async setWebhook(url: string, secretToken?: string): Promise<any> {
    return await this.post('setWebhook', {
      url,
      secret_token: secretToken,
      drop_pending_updates: false,
    });
  }

  /**
   * Register Telegram native Bot API slash-command menu (setMyCommands).
   */
  public async setMyCommands(
    commands: TelegramBotCommand[],
    scope?: TelegramBotCommandScope,
    languageCode?: string
  ): Promise<any> {
    const payload: Record<string, any> = {
      commands: commands.slice(0, 100),
    };
    if (scope) {
      payload.scope = scope;
    }
    if (languageCode) {
      payload.language_code = languageCode;
    }
    return await this.post('setMyCommands', payload);
  }

  /**
   * Register built-in Telegram slash commands for default, English, Urdu, and scoped admin chats.
   * Non-fatal and safe on startup or missing tokens (never throws or exposes credentials).
   */
  public async registerBotCommandsSafely(): Promise<{
    registered: boolean;
    scopes: string[];
    skippedReason?: string;
  }> {
    if (!this.token && !this.transportOverride) {
      return { registered: false, scopes: [], skippedReason: 'TOKEN_NOT_CONFIGURED' };
    }

    const startedAt = Date.now();
    try {
      await uiConfigService.ensureLoaded();
      const registeredScopes: string[] = [];

      // 1. Default global customer menu (used by Roman Urdu and all non-listed locales)
      const defaultCmds = uiConfigService.getBotCommands('en', false);
      const defRes = await this.setMyCommands(defaultCmds, { type: 'default' });
      if (defRes?.ok) registeredScopes.push('default');

      // 2. English localized menu
      const enCmds = uiConfigService.getBotCommands('en', false);
      const enRes = await this.setMyCommands(enCmds, { type: 'default' }, 'en');
      if (enRes?.ok) registeredScopes.push('en');

      // 3. Urdu localized menu
      const urCmds = uiConfigService.getBotCommands('ur', false);
      const urRes = await this.setMyCommands(urCmds, { type: 'default' }, 'ur');
      if (urRes?.ok) registeredScopes.push('ur');

      // 4. Scoped admin command list ONLY for configured TELEGRAM_ADMIN_IDS chats
      const adminCmds = uiConfigService.getBotCommands('en', true);
      for (const adminId of config.telegram.adminIds) {
        if (/^-?\d+$/.test(String(adminId).trim())) {
          const admRes = await this.setMyCommands(adminCmds, {
            type: 'chat',
            chat_id: Number(adminId.trim()),
          });
          if (admRes?.ok) registeredScopes.push(`chat:${adminId}`);
        }
      }

      logger.info('Telegram built-in slash command menu sync completed', {
        scopesCount: registeredScopes.length,
        durationMs: Date.now() - startedAt,
      });
      return { registered: registeredScopes.length > 0, scopes: registeredScopes };
    } catch (err: any) {
      logger.warn('Non-blocking setMyCommands registration failed', {
        error: err.message,
        durationMs: Date.now() - startedAt,
      });
      return { registered: false, scopes: [], skippedReason: err.message };
    }
  }

  public async sendMessage(chatId: number | string, text: string, options: SendMessageOptions = {}): Promise<any> {
    const payload: Record<string, any> = {
      chat_id: chatId,
      text,
      parse_mode: options.parse_mode || 'Markdown',
      disable_web_page_preview: options.disable_web_page_preview !== false,
      reply_markup: options.reply_markup,
    };
    if (options.disable_notification !== undefined) {
      payload.disable_notification = options.disable_notification;
    }
    return await this.post('sendMessage', payload);
  }

  /**
   * Edit message text safely. If message is deleted/too old/uneditable, sends a fresh menu message.
   * Ignores benign "message is not modified" without sending duplicate messages.
   */
  public async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    options: SendMessageOptions = {}
  ): Promise<any> {
    const res = await this.post('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: options.parse_mode || 'Markdown',
      disable_web_page_preview: options.disable_web_page_preview !== false,
      reply_markup: options.reply_markup,
    });

    if (!res?.ok) {
      const desc = String(res?.description || '').toLowerCase();
      if (desc.includes('message is not modified')) {
        return { ok: true, result: { message_id: messageId }, notModified: true };
      }
      if (desc !== 'token_not_configured') {
        return await this.sendMessage(chatId, text, options);
      }
    }
    return res;
  }

  public async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<any> {
    return await this.post('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  }
}

export const telegramClient = new TelegramClient();
