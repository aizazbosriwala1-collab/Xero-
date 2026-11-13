import { config } from '../config/env.js';
import {
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
  TelegramReplyKeyboardButton,
  TelegramReplyKeyboardMarkup,
} from './types.js';
import { FALLBACK_TEXT_SYMBOL } from './buttonBuilder.js';
import { createLogger } from '../services/logger.js';

const logger = createLogger('TelegramClient');

export interface SendMessageOptions {
  parse_mode?: 'Markdown' | 'HTML';
  reply_markup?: TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup;
  disable_web_page_preview?: boolean;
}

export type TelegramTransport = (method: string, body: Record<string, any>) => Promise<any>;

export class TelegramClient {
  private token?: string;
  private baseUrl: string;
  private transportOverride: TelegramTransport | null = null;

  constructor() {
    this.token = config.telegram.botToken;
    this.baseUrl = 'https://api.telegram.org';
  }

  public setTransportOverride(fn: TelegramTransport | null): void {
    this.transportOverride = fn;
  }

  private getEndpoint(method: string): string {
    if (!this.token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }
    return `${this.baseUrl}/bot${this.token}/${method}`;
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
    if (this.transportOverride) {
      return await this.transportOverride(method, body);
    }

    if (!this.token) {
      logger.warn('Skipping Telegram API call: TELEGRAM_BOT_TOKEN is not set');
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
      if (!data.ok) {
        logger.warn('Telegram API method returned error', {
          method,
          errorCode: data.error_code,
          description: data.description,
        });
      }
      return data;
    } catch (err: any) {
      logger.error('Telegram API request exception', { method, error: err.message });
      return { ok: false, description: err.message };
    }
  }

  /**
   * Safe post with automatic fallback degradation if Telegram rejects custom emojis or button styles.
   */
  private async post(method: string, body: Record<string, any>): Promise<any> {
    const res = await this.postRaw(method, body);
    if (res?.ok) return res;

    const desc = String(res?.description || '');
    const markup = body.reply_markup as TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup | undefined;

    if (markup && (method === 'sendMessage' || method === 'editMessageText' || method === 'editMessageReplyMarkup')) {
      const hasEmoji = this.hasCustomEmoji(markup);
      const hasStyle = this.hasButtonStyle(markup);

      // Step 1: If rejected due to custom emoji (or generic 400 with custom emoji present), strip custom emoji & restore Unicode fallback
      if (hasEmoji && (this.isEmojiError(desc) || res?.error_code === 400)) {
        logger.warn('Custom emoji rejected by Telegram API; degrading gracefully to Unicode fallback', {
          method,
          description: desc,
        });
        const retryBody1 = {
          ...body,
          reply_markup: this.cloneMarkupStripping(markup, true, false),
        };
        const retry1 = await this.postRaw(method, retryBody1);
        if (retry1?.ok) return retry1;

        const desc1 = String(retry1?.description || '');
        if (hasStyle && (this.isStyleError(desc1) || retry1?.error_code === 400)) {
          logger.warn('Button style also rejected; falling back to standard unstyled buttons', { method });
          const retryBody2 = {
            ...body,
            reply_markup: this.cloneMarkupStripping(markup, true, true),
          };
          return await this.postRaw(method, retryBody2);
        }
        return retry1;
      }

      // Step 2: If rejected due to style field, strip style and retry
      if (hasStyle && this.isStyleError(desc)) {
        logger.warn('Button style rejected by Telegram API; degrading gracefully to default style', {
          method,
          description: desc,
        });
        const retryBody = {
          ...body,
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

  public async sendMessage(chatId: number | string, text: string, options: SendMessageOptions = {}): Promise<any> {
    return await this.post('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: options.parse_mode || 'Markdown',
      disable_web_page_preview: options.disable_web_page_preview !== false,
      reply_markup: options.reply_markup,
    });
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
