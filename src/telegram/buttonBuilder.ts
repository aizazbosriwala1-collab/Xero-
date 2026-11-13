import {
  ButtonStyle,
  TelegramApiButtonStyle,
  TelegramInlineKeyboardButton,
  TelegramReplyKeyboardButton,
} from './types.js';
import { uiConfigService } from '../services/uiConfig.js';
import { SupportedLanguage } from '../services/i18n.js';

export const FALLBACK_TEXT_SYMBOL = Symbol('fallbackButtonText');

export interface ButtonBuildOptions {
  settingKey?: string;
  lang?: SupportedLanguage;
  text?: string;
  fallbackEmoji?: string;
  customEmojiId?: string | null;
  style?: ButtonStyle;
  callbackData?: string;
  url?: string;
  disabled?: boolean;
  forceVisible?: boolean;
  suffix?: string;
}

export class ButtonBuilder {
  public static assertCallbackLength(callbackData: string): string {
    const bytes = Buffer.byteLength(callbackData, 'utf8');
    if (bytes > 64) {
      throw new Error(`Telegram callback_data "${callbackData}" (${bytes} bytes) exceeds 64-byte limit.`);
    }
    return callbackData;
  }

  public static mapApiStyle(style?: ButtonStyle, disabled = false): TelegramApiButtonStyle | undefined {
    if (disabled) return undefined;
    if (style === 'primary' || style === 'success' || style === 'danger') {
      return style;
    }
    return undefined;
  }

  public static formatDisplayText(text: string, fallbackEmoji = '', hasCustomEmoji = false): string {
    const cleanText = text.trim();
    const cleanEmoji = (fallbackEmoji || '').trim();
    if (!cleanEmoji) return cleanText;

    if (hasCustomEmoji) {
      // Avoid stacking custom emoji AND fallback Unicode emoji
      if (cleanText.startsWith(cleanEmoji)) {
        return cleanText.slice(cleanEmoji.length).trim() || cleanText;
      }
      return cleanText;
    }

    if (cleanText.startsWith(cleanEmoji)) {
      return cleanText;
    }
    return `${cleanEmoji} ${cleanText}`.trim();
  }

  /**
   * Build an inline button from a DB-backed setting key (with optional overrides) or direct config.
   * Returns null if admin marked the button hidden (unless forceVisible = true).
   */
  public static buildButton(opts: ButtonBuildOptions): TelegramInlineKeyboardButton | null {
    const lang = opts.lang || 'en';
    const setting = opts.settingKey ? uiConfigService.getCachedSetting(opts.settingKey, lang) : null;

    if (setting && !setting.isVisible && !opts.forceVisible) {
      return null;
    }

    const baseText = opts.text ?? setting?.textValue ?? opts.settingKey ?? 'Action';
    const fullBaseText = opts.suffix ? `${baseText} ${opts.suffix}`.trim() : baseText;
    const fallbackEmoji = opts.fallbackEmoji ?? setting?.fallbackEmoji ?? '';
    const customEmojiId = opts.customEmojiId !== undefined ? opts.customEmojiId : setting?.customEmojiId ?? null;
    const effectiveStyle = opts.style ?? setting?.buttonStyle ?? 'default';

    const hasCustomEmoji = Boolean(customEmojiId && /^\d{5,30}$/.test(customEmojiId) && !opts.disabled);
    const displayText = this.formatDisplayText(fullBaseText, fallbackEmoji, hasCustomEmoji);
    const fallbackText = this.formatDisplayText(fullBaseText, fallbackEmoji, false);

    const btn: TelegramInlineKeyboardButton = {
      text: displayText,
    };

    if (opts.url) {
      btn.url = uiConfigService.validateSafeUrl(opts.url) || opts.url;
    } else if (opts.callbackData !== undefined) {
      btn.callback_data = this.assertCallbackLength(opts.callbackData);
    } else {
      btn.callback_data = 'noop';
    }

    const apiStyle = this.mapApiStyle(effectiveStyle, Boolean(opts.disabled));
    if (apiStyle) {
      btn.style = apiStyle;
    }

    if (hasCustomEmoji && customEmojiId) {
      btn.icon_custom_emoji_id = customEmojiId;
      // Attach non-enumerable fallback text so TelegramClient can degrade seamlessly without polluting JSON
      Object.defineProperty(btn, FALLBACK_TEXT_SYMBOL, {
        value: fallbackText,
        enumerable: false,
        configurable: true,
      });
    }

    return btn;
  }

  /**
   * Build a reply keyboard button from setting key.
   */
  public static buildReplyButton(opts: {
    settingKey?: string;
    lang?: SupportedLanguage;
    text?: string;
    fallbackEmoji?: string;
    style?: ButtonStyle;
  }): TelegramReplyKeyboardButton {
    const lang = opts.lang || 'en';
    const setting = opts.settingKey ? uiConfigService.getCachedSetting(opts.settingKey, lang) : null;

    const baseText = opts.text ?? setting?.textValue ?? 'MENU';
    const fallbackEmoji = opts.fallbackEmoji ?? setting?.fallbackEmoji ?? '';
    const customEmojiId = setting?.customEmojiId ?? null;
    const effectiveStyle = opts.style ?? setting?.buttonStyle ?? 'primary';
    const hasCustomEmoji = Boolean(customEmojiId && /^\d{5,30}$/.test(customEmojiId));

    const btn: TelegramReplyKeyboardButton = {
      text: this.formatDisplayText(baseText, fallbackEmoji, hasCustomEmoji),
    };

    const apiStyle = this.mapApiStyle(effectiveStyle, false);
    if (apiStyle) {
      btn.style = apiStyle;
    }
    if (hasCustomEmoji && customEmojiId) {
      btn.icon_custom_emoji_id = customEmojiId;
      Object.defineProperty(btn, FALLBACK_TEXT_SYMBOL, {
        value: this.formatDisplayText(baseText, fallbackEmoji, false),
        enumerable: false,
        configurable: true,
      });
    }

    return btn;
  }

  /**
   * Filter out hidden/null buttons and build a row; returns empty array if none visible.
   */
  public static buildActionRow(buttons: Array<TelegramInlineKeyboardButton | null | undefined>): TelegramInlineKeyboardButton[] {
    return buttons.filter((b): b is TelegramInlineKeyboardButton => Boolean(b));
  }

  /**
   * Build balanced N-column grid from an array of buttons (automatically skips null/hidden buttons).
   */
  public static buildGrid(
    buttons: Array<TelegramInlineKeyboardButton | null | undefined>,
    columns = 3
  ): TelegramInlineKeyboardButton[][] {
    const visible = this.buildActionRow(buttons);
    const rows: TelegramInlineKeyboardButton[][] = [];
    const cols = Math.max(1, columns);
    for (let i = 0; i < visible.length; i += cols) {
      rows.push(visible.slice(i, i + cols));
    }
    return rows;
  }

  /**
   * Build standard Back + Home navigation row.
   */
  public static buildNavigationRow(
    backCallback = 'm:home',
    lang: SupportedLanguage = 'en',
    backSettingKey = 'btn.nav.back'
  ): TelegramInlineKeyboardButton[] {
    return this.buildActionRow([
      this.buildButton({ settingKey: backSettingKey, lang, callbackData: backCallback, forceVisible: true }),
      this.buildButton({ settingKey: 'btn.nav.home', lang, callbackData: 'm:home', forceVisible: true }),
    ]);
  }
}
