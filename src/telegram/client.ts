import { config } from '../config/env.js';
import { TelegramInlineKeyboardMarkup, TelegramReplyKeyboardMarkup } from './types.js';
import { createLogger } from '../services/logger.js';

const logger = createLogger('TelegramClient');

export interface SendMessageOptions {
  parse_mode?: 'Markdown' | 'HTML';
  reply_markup?: TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup;
  disable_web_page_preview?: boolean;
}

export class TelegramClient {
  private token?: string;
  private baseUrl: string;

  constructor() {
    this.token = config.telegram.botToken;
    this.baseUrl = 'https://api.telegram.org';
  }

  private getEndpoint(method: string): string {
    if (!this.token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  /**
   * Safe post request to Telegram Bot API
   */
  private async post(method: string, body: Record<string, any>): Promise<any> {
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
   * Edit message text. If message is not modified or editing fails, gracefully sends a new message.
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

    if (!res.ok) {
      // If edit failed because message is too old or content identical, fall back safely to sendMessage
      if (!res.description?.includes('message is not modified')) {
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
