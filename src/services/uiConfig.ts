import { db } from '../db/index.js';
import { redis } from './redis.js';
import { ButtonStyle, TelegramBotCommand } from '../telegram/types.js';
import { SupportedLanguage, SUPPORTED_LANGUAGES, translations } from './i18n.js';
import { createLogger } from './logger.js';

const logger = createLogger('UISettingService');

export type UISection =
  | 'main_menu'
  | 'categories'
  | 'product_detail'
  | 'wallet_dep'
  | 'navigation'
  | 'messages'
  | 'commands'
  | 'admin';

export interface UISettingRecord {
  id: string;
  settingKey: string;
  section: UISection;
  languageCode: SupportedLanguage;
  textValue: string;
  fallbackEmoji: string;
  customEmojiId: string | null;
  buttonStyle: ButtonStyle;
  isVisible: boolean;
  metadata: Record<string, any>;
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface DefaultUISettingSpec {
  settingKey: string;
  section: UISection;
  textValue: string;
  fallbackEmoji: string;
  buttonStyle: ButtonStyle;
  isVisible?: boolean;
  localizedText?: Partial<Record<SupportedLanguage, string>>;
  metadata?: Record<string, any>;
}

export const ALLOWED_BUTTON_STYLES: ButtonStyle[] = ['primary', 'success', 'danger', 'default'];

export const DEFAULT_UI_SETTINGS: DefaultUISettingSpec[] = [
  // Persistent Bottom Quick-Action Reply Keyboard (Exactly 2 buttons: Deposit & Support)
  {
    settingKey: 'btn.reply.deposit',
    section: 'main_menu',
    textValue: 'DEPOSIT',
    fallbackEmoji: '➕',
    buttonStyle: 'success',
    localizedText: { en: 'DEPOSIT', ur: 'جمع کریں', 'ur-ro': 'DEPOSIT' },
  },
  {
    settingKey: 'btn.reply.support',
    section: 'main_menu',
    textValue: 'SUPPORT',
    fallbackEmoji: '🎧',
    buttonStyle: 'primary',
    localizedText: { en: 'SUPPORT', ur: 'سپورٹ', 'ur-ro': 'SUPPORT' },
  },
  {
    settingKey: 'msg.input_placeholder',
    section: 'messages',
    textValue: translations.en.input_placeholder,
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: {
      en: translations.en.input_placeholder,
      ur: translations.ur.input_placeholder,
      'ur-ro': translations['ur-ro'].input_placeholder,
    },
  },

  // Main Menu Inline Buttons
  {
    settingKey: 'btn.menu.products',
    section: 'main_menu',
    textValue: 'PRODUCTS',
    fallbackEmoji: '🛍️',
    buttonStyle: 'primary',
    localizedText: { en: 'PRODUCTS', ur: 'پروڈکٹس', 'ur-ro': 'PRODUCTS' },
  },
  {
    settingKey: 'btn.menu.featured',
    section: 'main_menu',
    textValue: 'FEATURED',
    fallbackEmoji: '🔥',
    buttonStyle: 'primary',
    localizedText: { en: 'FEATURED', ur: 'نمایاں', 'ur-ro': 'FEATURED' },
  },
  {
    settingKey: 'btn.menu.search',
    section: 'main_menu',
    textValue: 'SEARCH',
    fallbackEmoji: '🔎',
    buttonStyle: 'primary',
    localizedText: { en: 'SEARCH', ur: 'تلاش', 'ur-ro': 'SEARCH' },
  },
  {
    settingKey: 'btn.menu.wallet',
    section: 'main_menu',
    textValue: 'WALLET',
    fallbackEmoji: '💳',
    buttonStyle: 'default',
    localizedText: { en: 'WALLET', ur: 'والٹ', 'ur-ro': 'WALLET' },
  },
  {
    settingKey: 'btn.menu.add_funds',
    section: 'main_menu',
    textValue: 'ADD FUNDS',
    fallbackEmoji: '➕',
    buttonStyle: 'success',
    localizedText: { en: 'ADD FUNDS', ur: 'رقم جمع کریں', 'ur-ro': 'ADD FUNDS' },
  },
  {
    settingKey: 'btn.menu.orders',
    section: 'main_menu',
    textValue: 'MY ORDERS',
    fallbackEmoji: '📦',
    buttonStyle: 'default',
    localizedText: { en: 'MY ORDERS', ur: 'میرے آرڈرز', 'ur-ro': 'MY ORDERS' },
  },
  {
    settingKey: 'btn.menu.giveaways',
    section: 'main_menu',
    textValue: 'GIVEAWAYS',
    fallbackEmoji: '🎁',
    buttonStyle: 'default',
    localizedText: { en: 'GIVEAWAYS', ur: 'انعامات', 'ur-ro': 'GIVEAWAYS' },
  },
  {
    settingKey: 'btn.menu.referral',
    section: 'main_menu',
    textValue: 'REFER & EARN',
    fallbackEmoji: '👥',
    buttonStyle: 'default',
    localizedText: { en: 'REFER & EARN', ur: 'ریفرل', 'ur-ro': 'REFER & EARN' },
  },
  {
    settingKey: 'btn.menu.support',
    section: 'main_menu',
    textValue: 'SUPPORT',
    fallbackEmoji: '🎧',
    buttonStyle: 'default',
    localizedText: { en: 'SUPPORT', ur: 'سپورٹ', 'ur-ro': 'SUPPORT' },
  },
  {
    settingKey: 'btn.menu.profile',
    section: 'main_menu',
    textValue: 'PROFILE',
    fallbackEmoji: '👤',
    buttonStyle: 'default',
    localizedText: { en: 'PROFILE', ur: 'پروفائل', 'ur-ro': 'PROFILE' },
  },
  {
    settingKey: 'btn.menu.language',
    section: 'main_menu',
    textValue: 'LANGUAGE',
    fallbackEmoji: '🌐',
    buttonStyle: 'default',
    localizedText: { en: 'LANGUAGE', ur: 'زبان', 'ur-ro': 'ZUBAN' },
  },
  {
    settingKey: 'btn.menu.admin',
    section: 'main_menu',
    textValue: 'ADMIN CONTROL CENTER',
    fallbackEmoji: '👑',
    buttonStyle: 'danger',
    localizedText: { en: 'ADMIN CONTROL CENTER', ur: 'ایڈمن کنٹرول سینٹر', 'ur-ro': 'ADMIN CONTROL CENTER' },
  },

  // Category Screen Buttons
  {
    settingKey: 'btn.cat.all',
    section: 'categories',
    textValue: 'ALL PRODUCTS',
    fallbackEmoji: '⚡',
    buttonStyle: 'primary',
    localizedText: { en: 'ALL PRODUCTS', ur: 'تمام پروڈکٹس', 'ur-ro': 'ALL PRODUCTS' },
  },
  {
    settingKey: 'btn.cat.featured',
    section: 'categories',
    textValue: 'FEATURED',
    fallbackEmoji: '🔥',
    buttonStyle: 'primary',
    localizedText: { en: 'FEATURED', ur: 'نمایاں', 'ur-ro': 'FEATURED' },
  },
  {
    settingKey: 'btn.cat.search',
    section: 'categories',
    textValue: 'SEARCH',
    fallbackEmoji: '🔎',
    buttonStyle: 'primary',
    localizedText: { en: 'SEARCH', ur: 'تلاش', 'ur-ro': 'SEARCH' },
  },
  {
    settingKey: 'btn.cat.support',
    section: 'categories',
    textValue: 'SUPPORT',
    fallbackEmoji: '🎧',
    buttonStyle: 'default',
    localizedText: { en: 'SUPPORT', ur: 'سپورٹ', 'ur-ro': 'SUPPORT' },
  },

  // Product Detail & Purchase Buttons
  {
    settingKey: 'btn.prod.buy_now',
    section: 'product_detail',
    textValue: 'BUY NOW',
    fallbackEmoji: '🛒',
    buttonStyle: 'success',
    localizedText: { en: 'BUY NOW', ur: 'خریدیں', 'ur-ro': 'KHAREEDEIN' },
  },
  {
    settingKey: 'btn.prod.more_details',
    section: 'product_detail',
    textValue: 'MORE DETAILS',
    fallbackEmoji: '📋',
    buttonStyle: 'primary',
    localizedText: { en: 'MORE DETAILS', ur: 'مزید تفصیلات', 'ur-ro': 'MORE DETAILS' },
  },
  {
    settingKey: 'btn.prod.confirm_buy',
    section: 'product_detail',
    textValue: 'CONFIRM PURCHASE',
    fallbackEmoji: '✅',
    buttonStyle: 'success',
    localizedText: { en: 'CONFIRM PURCHASE', ur: 'خریداری کی تصدیق کریں', 'ur-ro': 'CONFIRM PURCHASE' },
  },
  {
    settingKey: 'btn.prod.cancel',
    section: 'product_detail',
    textValue: 'CANCEL',
    fallbackEmoji: '❌',
    buttonStyle: 'danger',
    localizedText: { en: 'CANCEL', ur: 'منسوخ', 'ur-ro': 'CANCEL' },
  },

  // Navigation & Language Buttons
  {
    settingKey: 'btn.nav.back',
    section: 'navigation',
    textValue: 'BACK',
    fallbackEmoji: '⬅️',
    buttonStyle: 'default',
    localizedText: { en: 'BACK', ur: 'واپس', 'ur-ro': 'WAPAS' },
  },
  {
    settingKey: 'btn.nav.home',
    section: 'navigation',
    textValue: 'HOME',
    fallbackEmoji: '🏠',
    buttonStyle: 'default',
    localizedText: { en: 'HOME', ur: 'ہوم', 'ur-ro': 'HOME' },
  },
  {
    settingKey: 'btn.nav.prev',
    section: 'navigation',
    textValue: 'PREVIOUS',
    fallbackEmoji: '⬅️',
    buttonStyle: 'primary',
    localizedText: { en: 'PREVIOUS', ur: 'پچھلا', 'ur-ro': 'PREVIOUS' },
  },
  {
    settingKey: 'btn.nav.next',
    section: 'navigation',
    textValue: 'NEXT ➡️',
    fallbackEmoji: '',
    buttonStyle: 'primary',
    localizedText: { en: 'NEXT ➡️', ur: 'اگلا ➡️', 'ur-ro': 'NEXT ➡️' },
  },
  {
    settingKey: 'btn.nav.back_to_list',
    section: 'navigation',
    textValue: 'BACK TO LIST',
    fallbackEmoji: '📋',
    buttonStyle: 'default',
    localizedText: { en: 'BACK TO LIST', ur: 'فہرست پر واپس', 'ur-ro': 'BACK TO LIST' },
  },
  {
    settingKey: 'btn.nav.back_to_product',
    section: 'navigation',
    textValue: 'BACK TO PRODUCT',
    fallbackEmoji: '⬅️',
    buttonStyle: 'default',
    localizedText: { en: 'BACK TO PRODUCT', ur: 'پروڈکٹ پر واپس', 'ur-ro': 'BACK TO PRODUCT' },
  },
  {
    settingKey: 'btn.nav.prev_product',
    section: 'navigation',
    textValue: 'PREVIOUS PRODUCT',
    fallbackEmoji: '⬅️',
    buttonStyle: 'primary',
    localizedText: { en: 'PREVIOUS PRODUCT', ur: 'پچھلا پروڈکٹ', 'ur-ro': 'PREVIOUS PRODUCT' },
  },
  {
    settingKey: 'btn.nav.next_product',
    section: 'navigation',
    textValue: 'NEXT PRODUCT ➡️',
    fallbackEmoji: '',
    buttonStyle: 'primary',
    localizedText: { en: 'NEXT PRODUCT ➡️', ur: 'اگلا پروڈکٹ ➡️', 'ur-ro': 'NEXT PRODUCT ➡️' },
  },
  {
    settingKey: 'btn.lang.en',
    section: 'navigation',
    textValue: 'English',
    fallbackEmoji: '🇬🇧',
    buttonStyle: 'primary',
  },
  {
    settingKey: 'btn.lang.ur',
    section: 'navigation',
    textValue: 'اردو (Urdu)',
    fallbackEmoji: '🇵🇰',
    buttonStyle: 'primary',
  },
  {
    settingKey: 'btn.lang.ur_ro',
    section: 'navigation',
    textValue: 'Roman Urdu',
    fallbackEmoji: '🇵🇰',
    buttonStyle: 'primary',
  },

  // Wallet & Deposit Buttons
  {
    settingKey: 'btn.wall.add_funds',
    section: 'wallet_dep',
    textValue: 'ADD FUNDS',
    fallbackEmoji: '➕',
    buttonStyle: 'success',
    localizedText: { en: 'ADD FUNDS', ur: 'رقم جمع کریں', 'ur-ro': 'ADD FUNDS' },
  },
  {
    settingKey: 'btn.wall.history',
    section: 'wallet_dep',
    textValue: 'TRANSACTION HISTORY',
    fallbackEmoji: '📜',
    buttonStyle: 'primary',
    localizedText: { en: 'TRANSACTION HISTORY', ur: 'لین دین کی تاریخ', 'ur-ro': 'TRANSACTION HISTORY' },
  },
  {
    settingKey: 'btn.dep.binance',
    section: 'wallet_dep',
    textValue: 'BINANCE PAY USDT (Instant)',
    fallbackEmoji: '⚡',
    buttonStyle: 'primary',
  },
  {
    settingKey: 'btn.dep.easypaisa',
    section: 'wallet_dep',
    textValue: 'EASYPAISA (PKR / Manual)',
    fallbackEmoji: '📱',
    buttonStyle: 'primary',
  },
  {
    settingKey: 'btn.dep.jazzcash',
    section: 'wallet_dep',
    textValue: 'JAZZCASH (PKR / Manual)',
    fallbackEmoji: '📱',
    buttonStyle: 'primary',
  },
  {
    settingKey: 'btn.dep.bin_submit',
    section: 'wallet_dep',
    textValue: 'SUBMIT TRANSACTION ID',
    fallbackEmoji: '🔎',
    buttonStyle: 'success',
  },
  {
    settingKey: 'btn.dep.cancel',
    section: 'wallet_dep',
    textValue: 'CANCEL',
    fallbackEmoji: '❌',
    buttonStyle: 'danger',
  },
  {
    settingKey: 'btn.give.claim',
    section: 'wallet_dep',
    textValue: 'CLAIM REWARD',
    fallbackEmoji: '🎁',
    buttonStyle: 'success',
  },

  // Screen Messages (Editable Texts)
  {
    settingKey: 'msg.welcome',
    section: 'messages',
    textValue: translations.en.welcome,
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: translations.en.welcome, ur: translations.ur.welcome, 'ur-ro': translations['ur-ro'].welcome },
  },
  {
    settingKey: 'msg.categories_header',
    section: 'messages',
    textValue: translations.en.categories_header,
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: {
      en: translations.en.categories_header,
      ur: translations.ur.categories_header,
      'ur-ro': translations['ur-ro'].categories_header,
    },
  },
  {
    settingKey: 'msg.wallet_info',
    section: 'messages',
    textValue: translations.en.wallet_info,
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: {
      en: translations.en.wallet_info,
      ur: translations.ur.wallet_info,
      'ur-ro': translations['ur-ro'].wallet_info,
    },
  },
  {
    settingKey: 'msg.choose_payment',
    section: 'messages',
    textValue: translations.en.choose_payment,
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: {
      en: translations.en.choose_payment,
      ur: translations.ur.choose_payment,
      'ur-ro': translations['ur-ro'].choose_payment,
    },
  },
  {
    settingKey: 'msg.referral_title',
    section: 'messages',
    textValue: translations.en.referral_title,
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: {
      en: translations.en.referral_title,
      ur: translations.ur.referral_title,
      'ur-ro': translations['ur-ro'].referral_title,
    },
  },
  {
    settingKey: 'msg.support_prompt',
    section: 'messages',
    textValue: translations.en.support_prompt,
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: {
      en: translations.en.support_prompt,
      ur: translations.ur.support_prompt,
      'ur-ro': translations['ur-ro'].support_prompt,
    },
  },
  {
    settingKey: 'msg.profile_header',
    section: 'messages',
    textValue: translations.en.profile_header,
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: {
      en: translations.en.profile_header,
      ur: translations.ur.profile_header,
      'ur-ro': translations['ur-ro'].profile_header,
    },
  },
  {
    settingKey: 'msg.language_select',
    section: 'messages',
    textValue: translations.en.language_select,
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: {
      en: translations.en.language_select,
      ur: translations.ur.language_select,
      'ur-ro': translations['ur-ro'].language_select,
    },
  },

  // Admin Buttons
  {
    settingKey: 'btn.adm.approve',
    section: 'admin',
    textValue: 'APPROVE & CREDIT',
    fallbackEmoji: '✅',
    buttonStyle: 'success',
  },
  {
    settingKey: 'btn.adm.reject',
    section: 'admin',
    textValue: 'REJECT',
    fallbackEmoji: '❌',
    buttonStyle: 'danger',
  },
  {
    settingKey: 'btn.adm.ui_editor',
    section: 'admin',
    textValue: 'UI & BUTTONS',
    fallbackEmoji: '🎨',
    buttonStyle: 'primary',
  },
  {
    settingKey: 'btn.adm.exit',
    section: 'admin',
    textValue: 'EXIT ADMIN',
    fallbackEmoji: '🚪',
    buttonStyle: 'danger',
  },

  // Built-in Telegram Slash-Command Menu Descriptions (DB-backed)
  {
    settingKey: 'cmd.start',
    section: 'commands',
    textValue: 'Open the XERO KHAN home screen',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'Open the XERO KHAN home screen', ur: 'زیرو خان ہوم اسکرین کھولیں' },
  },
  {
    settingKey: 'cmd.shop',
    section: 'commands',
    textValue: 'Browse all products',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'Browse all products', ur: 'تمام پروڈکٹس دیکھیں' },
  },
  {
    settingKey: 'cmd.featured',
    section: 'commands',
    textValue: 'View featured products',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'View featured products', ur: 'نمایاں پروڈکٹس دیکھیں' },
  },
  {
    settingKey: 'cmd.search',
    section: 'commands',
    textValue: 'Search the catalogue',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'Search the catalogue', ur: 'کیٹلاگ میں تلاش کریں' },
  },
  {
    settingKey: 'cmd.wallet',
    section: 'commands',
    textValue: 'View your wallet',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'View your wallet', ur: 'اپنا والٹ دیکھیں' },
  },
  {
    settingKey: 'cmd.deposit',
    section: 'commands',
    textValue: 'Add funds to your wallet',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'Add funds to your wallet', ur: 'والٹ میں رقم جمع کریں' },
  },
  {
    settingKey: 'cmd.orders',
    section: 'commands',
    textValue: 'View your orders',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'View your orders', ur: 'اپنے آرڈرز دیکھیں' },
  },
  {
    settingKey: 'cmd.giveaways',
    section: 'commands',
    textValue: 'View active giveaways',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'View active giveaways', ur: 'فعال گیو اوے دیکھیں' },
  },
  {
    settingKey: 'cmd.refer',
    section: 'commands',
    textValue: 'Refer friends and earn',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'Refer friends and earn', ur: 'دوستوں کو مدعو کریں اور کمائیں' },
  },
  {
    settingKey: 'cmd.support',
    section: 'commands',
    textValue: 'Contact support',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'Contact support', ur: 'سپورٹ سے رابطہ کریں' },
  },
  {
    settingKey: 'cmd.profile',
    section: 'commands',
    textValue: 'View your account',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'View your account', ur: 'اپنا اکاؤنٹ دیکھیں' },
  },
  {
    settingKey: 'cmd.language',
    section: 'commands',
    textValue: 'Change language',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'Change language', ur: 'زبان تبدیل کریں' },
  },
  {
    settingKey: 'cmd.api',
    section: 'commands',
    textValue: 'Reseller API access',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'Reseller API access', ur: 'ری سیلر API رسائی' },
  },
  {
    settingKey: 'cmd.admin',
    section: 'commands',
    textValue: 'Open Admin Control Center',
    fallbackEmoji: '',
    buttonStyle: 'default',
    localizedText: { en: 'Open Admin Control Center', ur: 'ایڈمن کنٹرول سینٹر کھولیں' },
  },
];

export const CUSTOMER_COMMAND_ORDER = [
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
] as const;

const DEFAULT_SPEC_MAP = new Map<string, DefaultUISettingSpec>(
  DEFAULT_UI_SETTINGS.map(spec => [spec.settingKey, spec])
);

export class UISettingService {
  private cache: Map<string, UISettingRecord> = new Map();
  private loaded = false;
  private commandChangeListener: (() => void) | null = null;
  private commandSyncTimer: ReturnType<typeof setTimeout> | null = null;

  public setCommandsChangeListener(fn: (() => void) | null): void {
    this.commandChangeListener = fn;
  }

  private scheduleCommandRefresh(): void {
    if (!this.commandChangeListener) return;
    if (this.commandSyncTimer) {
      clearTimeout(this.commandSyncTimer);
    }
    this.commandSyncTimer = setTimeout(() => {
      this.commandSyncTimer = null;
      try {
        this.commandChangeListener?.();
      } catch (err: any) {
        logger.warn('Debounced command refresh callback failed', { error: err.message });
      }
    }, 1500);
    if (typeof (this.commandSyncTimer as any).unref === 'function') {
      (this.commandSyncTimer as any).unref();
    }
  }

  /**
   * Build validated, deduplicated Telegram BotCommand[] list from DB-backed settings.
   */
  public getBotCommands(lang: SupportedLanguage = 'en', includeAdmin = false): TelegramBotCommand[] {
    const names: string[] = [...CUSTOMER_COMMAND_ORDER];
    if (includeAdmin) {
      names.push('admin');
    }
    const seen = new Set<string>();
    const list: TelegramBotCommand[] = [];
    for (const cmd of names) {
      if (!/^[a-z0-9_]{1,32}$/.test(cmd) || seen.has(cmd)) continue;
      seen.add(cmd);
      const rawDesc = this.getText(`cmd.${cmd}`, lang) || `/${cmd}`;
      const cleanDesc = rawDesc.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 256);
      list.push({
        command: cmd,
        description: cleanDesc.length >= 3 ? cleanDesc : `Run /${cmd}`,
      });
    }
    return list;
  }

  private cacheKey(settingKey: string, lang: SupportedLanguage): string {
    return `${settingKey}::${lang}`;
  }

  public makeSettingId(settingKey: string, lang: SupportedLanguage): string {
    return `ui_${settingKey.replace(/[^a-zA-Z0-9_]/g, '_')}_${lang}`;
  }

  public validateButtonStyle(style: string): ButtonStyle {
    const norm = (style || '').trim().toLowerCase() as ButtonStyle;
    if (!ALLOWED_BUTTON_STYLES.includes(norm)) {
      throw new Error(`Invalid button style "${style}". Allowed values: ${ALLOWED_BUTTON_STYLES.join(', ')}`);
    }
    return norm;
  }

  public validateCustomEmojiId(emojiId?: string | null): string | null {
    if (emojiId === undefined || emojiId === null) return null;
    const trimmed = String(emojiId).trim();
    if (!trimmed || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'clear') {
      return null;
    }
    if (!/^\d{5,30}$/.test(trimmed)) {
      throw new Error('Custom emoji ID must be a 5–30 digit numeric string.');
    }
    return trimmed;
  }

  public validateSafeUrl(url?: string | null): string | null {
    if (!url) return null;
    const trimmed = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error('Invalid URL format.');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('Only https:// URLs are permitted.');
    }
    return parsed.toString();
  }

  public sanitizeText(text: string, isMessage = false): string {
    if (typeof text !== 'string') {
      throw new Error('Text value must be a string.');
    }
    // Strip ASCII control characters except newline/tab
    const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
    if (!cleaned) {
      throw new Error('Text cannot be empty.');
    }
    const maxLen = isMessage ? 3800 : 64;
    if (cleaned.length > maxLen) {
      throw new Error(`Text exceeds maximum allowed length of ${maxLen} characters.`);
    }
    return cleaned;
  }

  public sanitizeFallbackEmoji(emoji?: string | null): string {
    if (!emoji) return '';
    const cleaned = emoji.replace(/[\x00-\x1F\x7F]/g, '').trim();
    if (cleaned.length > 16) {
      throw new Error('Fallback emoji must be 16 characters or fewer.');
    }
    return cleaned;
  }

  private specToRecord(spec: DefaultUISettingSpec, lang: SupportedLanguage): UISettingRecord {
    const textValue = spec.localizedText?.[lang] || spec.textValue;
    return {
      id: this.makeSettingId(spec.settingKey, lang),
      settingKey: spec.settingKey,
      section: spec.section,
      languageCode: lang,
      textValue,
      fallbackEmoji: spec.fallbackEmoji,
      customEmojiId: null,
      buttonStyle: spec.buttonStyle,
      isVisible: spec.isVisible !== false,
      metadata: spec.metadata || {},
      updatedBy: 'SYSTEM_DEFAULT',
    };
  }

  /**
   * Seed default UI settings idempotently into PostgreSQL (non-destructive: ON CONFLICT DO NOTHING).
   */
  public async seedDefaults(): Promise<void> {
    for (const spec of DEFAULT_UI_SETTINGS) {
      for (const lang of SUPPORTED_LANGUAGES) {
        const rec = this.specToRecord(spec, lang);
        await db.query(
          `INSERT INTO ui_settings (
            id, setting_key, section, language_code, text_value,
            fallback_emoji, custom_emoji_id, button_style, is_visible,
            metadata, created_at, updated_at, updated_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $11)
          ON CONFLICT (setting_key, language_code) DO NOTHING`,
          [
            rec.id,
            rec.settingKey,
            rec.section,
            rec.languageCode,
            rec.textValue,
            rec.fallbackEmoji,
            rec.customEmojiId,
            rec.buttonStyle,
            rec.isVisible,
            JSON.stringify(rec.metadata),
            'SYSTEM_DEFAULT',
          ]
        );
      }
    }
    await this.reloadCache();
  }

  public async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.reloadCache();
    }
  }

  public async reloadCache(): Promise<void> {
    try {
      const res = await db.query<any>(
        `SELECT id, setting_key as "settingKey", section, language_code as "languageCode",
                text_value as "textValue", fallback_emoji as "fallbackEmoji",
                custom_emoji_id as "customEmojiId", button_style as "buttonStyle",
                is_visible as "isVisible", metadata, updated_at as "updatedAt",
                updated_by as "updatedBy"
         FROM ui_settings`
      );
      const nextCache = new Map<string, UISettingRecord>();
      for (const row of res.rows) {
        const lang = (row.languageCode || 'en') as SupportedLanguage;
        nextCache.set(this.cacheKey(row.settingKey, lang), {
          id: row.id,
          settingKey: row.settingKey,
          section: row.section as UISection,
          languageCode: lang,
          textValue: row.textValue,
          fallbackEmoji: row.fallbackEmoji || '',
          customEmojiId: row.customEmojiId ? String(row.customEmojiId) : null,
          buttonStyle: (row.buttonStyle || 'default') as ButtonStyle,
          isVisible: row.isVisible !== false,
          metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {},
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
        });
      }
      this.cache = nextCache;
      this.loaded = true;
    } catch (err: any) {
      // Safe fallback if migration 002 has not yet executed during isolated unit startup
      logger.warn('UI settings table load deferred; using built-in defaults', { error: err.message });
      this.loaded = true;
    }
  }

  public invalidateCache(): void {
    this.loaded = false;
  }

  /**
   * Synchronous read from loaded cache with automatic fallback to English / built-in defaults.
   */
  public getCachedSetting(settingKey: string, lang: SupportedLanguage = 'en'): UISettingRecord | null {
    const direct = this.cache.get(this.cacheKey(settingKey, lang));
    if (direct) return direct;

    const enDb = this.cache.get(this.cacheKey(settingKey, 'en'));
    if (enDb) return enDb;

    const spec = DEFAULT_SPEC_MAP.get(settingKey);
    if (spec) return this.specToRecord(spec, lang);

    return null;
  }

  public getText(settingKey: string, lang: SupportedLanguage = 'en', params: Record<string, string | number> = {}): string {
    const rec = this.getCachedSetting(settingKey, lang);
    let out = rec ? rec.textValue : settingKey;
    for (const [k, v] of Object.entries(params)) {
      out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return out;
  }

  public async listBySection(section: UISection, lang: SupportedLanguage = 'en'): Promise<UISettingRecord[]> {
    await this.ensureLoaded();
    const results: UISettingRecord[] = [];
    for (const spec of DEFAULT_UI_SETTINGS) {
      if (spec.section === section) {
        const rec = this.getCachedSetting(spec.settingKey, lang);
        if (rec) results.push(rec);
      }
    }
    // Include any dynamically created settings in this section (e.g. category UI overrides)
    for (const rec of this.cache.values()) {
      if (rec.section === section && rec.languageCode === lang && !results.some(r => r.settingKey === rec.settingKey)) {
        results.push(rec);
      }
    }
    return results;
  }

  public async upsertSetting(params: {
    settingKey: string;
    section?: UISection;
    languageCode?: SupportedLanguage;
    textValue?: string;
    fallbackEmoji?: string;
    customEmojiId?: string | null;
    buttonStyle?: ButtonStyle;
    isVisible?: boolean;
    metadata?: Record<string, any>;
    adminId: string;
  }): Promise<UISettingRecord> {
    await this.ensureLoaded();
    const lang = params.languageCode || 'en';
    const existing = this.getCachedSetting(params.settingKey, lang);
    const defaultSpec = DEFAULT_SPEC_MAP.get(params.settingKey);

    const section = params.section || existing?.section || defaultSpec?.section || 'categories';
    const isMessage = params.settingKey.startsWith('msg.');
    const textValue =
      params.textValue !== undefined
        ? this.sanitizeText(params.textValue, isMessage)
        : existing?.textValue || defaultSpec?.textValue || params.settingKey;
    const fallbackEmoji =
      params.fallbackEmoji !== undefined
        ? this.sanitizeFallbackEmoji(params.fallbackEmoji)
        : existing?.fallbackEmoji ?? defaultSpec?.fallbackEmoji ?? '';
    const customEmojiId =
      params.customEmojiId !== undefined
        ? this.validateCustomEmojiId(params.customEmojiId)
        : existing?.customEmojiId ?? null;
    const buttonStyle =
      params.buttonStyle !== undefined
        ? this.validateButtonStyle(params.buttonStyle)
        : existing?.buttonStyle ?? defaultSpec?.buttonStyle ?? 'default';
    const isVisible = params.isVisible !== undefined ? Boolean(params.isVisible) : existing?.isVisible ?? true;
    const metadata = params.metadata !== undefined ? params.metadata : existing?.metadata ?? {};

    if (metadata?.url) {
      this.validateSafeUrl(metadata.url);
    }

    const id = this.makeSettingId(params.settingKey, lang);

    await db.query(
      `INSERT INTO ui_settings (
        id, setting_key, section, language_code, text_value,
        fallback_emoji, custom_emoji_id, button_style, is_visible,
        metadata, created_at, updated_at, updated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $11)
      ON CONFLICT (setting_key, language_code) DO UPDATE SET
        text_value = EXCLUDED.text_value,
        fallback_emoji = EXCLUDED.fallback_emoji,
        custom_emoji_id = EXCLUDED.custom_emoji_id,
        button_style = EXCLUDED.button_style,
        is_visible = EXCLUDED.is_visible,
        metadata = EXCLUDED.metadata,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = EXCLUDED.updated_by`,
      [
        id,
        params.settingKey,
        section,
        lang,
        textValue,
        fallbackEmoji,
        customEmojiId,
        buttonStyle,
        isVisible,
        JSON.stringify(metadata),
        params.adminId,
      ]
    );

    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'UPDATE_UI_SETTING', 'ui_setting', $3, $4)`,
      [
        `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        params.adminId,
        `${params.settingKey}:${lang}`,
        JSON.stringify({ buttonStyle, isVisible, hasCustomEmoji: Boolean(customEmojiId) }),
      ]
    );

    await redis.del(`ui:${params.settingKey}:${lang}`);
    await this.reloadCache();

    const updated = this.getCachedSetting(params.settingKey, lang)!;
    if (params.settingKey.startsWith('cmd.')) {
      this.scheduleCommandRefresh();
    }
    logger.info('UI setting updated by admin', {
      settingKey: params.settingKey,
      lang,
      buttonStyle,
      isVisible,
      adminId: params.adminId,
    });
    return updated;
  }

  public async resetSetting(settingKey: string, lang: SupportedLanguage, adminId: string): Promise<UISettingRecord | null> {
    const spec = DEFAULT_SPEC_MAP.get(settingKey);
    if (!spec) {
      // Remove non-default override (e.g. dynamic category customization)
      await db.query('DELETE FROM ui_settings WHERE setting_key = $1 AND language_code = $2', [settingKey, lang]);
      await this.reloadCache();
      return null;
    }

    const def = this.specToRecord(spec, lang);
    return await this.upsertSetting({
      settingKey: def.settingKey,
      section: def.section,
      languageCode: lang,
      textValue: def.textValue,
      fallbackEmoji: def.fallbackEmoji,
      customEmojiId: null,
      buttonStyle: def.buttonStyle,
      isVisible: def.isVisible,
      metadata: def.metadata,
      adminId,
    });
  }

  public async resetSection(section: UISection, lang: SupportedLanguage, adminId: string): Promise<number> {
    let count = 0;
    for (const spec of DEFAULT_UI_SETTINGS) {
      if (spec.section === section) {
        await this.resetSetting(spec.settingKey, lang, adminId);
        count++;
      }
    }
    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'RESET_UI_SECTION', 'ui_section', $3, $4)`,
      [`log_${Date.now()}`, adminId, `${section}:${lang}`, JSON.stringify({ count })]
    );
    return count;
  }

  public async resetAllSettings(adminId: string): Promise<number> {
    await db.query('DELETE FROM ui_settings');
    await this.seedDefaults();
    await db.query(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
       VALUES ($1, $2, 'RESET_ALL_UI', 'ui_settings', 'ALL', '{}')`,
      [`log_${Date.now()}`, adminId]
    );
    logger.info('All UI settings reset to factory defaults', { adminId });
    this.scheduleCommandRefresh();
    return DEFAULT_UI_SETTINGS.length * SUPPORTED_LANGUAGES.length;
  }

  public async exportSettingsJson(): Promise<string> {
    await this.ensureLoaded();
    const res = await db.query<any>(
      `SELECT setting_key as "settingKey", section, language_code as "languageCode",
              text_value as "textValue", fallback_emoji as "fallbackEmoji",
              custom_emoji_id as "customEmojiId", button_style as "buttonStyle",
              is_visible as "isVisible", metadata
       FROM ui_settings
       ORDER BY section ASC, setting_key ASC, language_code ASC`
    );
    return JSON.stringify(
      {
        schemaVersion: 'xero-khan-ui-v2',
        exportedAt: new Date().toISOString(),
        settings: res.rows,
      },
      null,
      2
    );
  }

  public async importSettingsJson(rawJson: string, adminId: string): Promise<{ imported: number }> {
    let parsed: any;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new Error('Invalid JSON payload.');
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.settings)) {
      throw new Error('Import JSON must contain a "settings" array.');
    }
    if (parsed.settings.length > 500) {
      throw new Error('Import payload exceeds maximum 500 settings entries.');
    }

    // Validate all entries first before applying any write
    const validated: Array<{
      settingKey: string;
      section: UISection;
      languageCode: SupportedLanguage;
      textValue: string;
      fallbackEmoji: string;
      customEmojiId: string | null;
      buttonStyle: ButtonStyle;
      isVisible: boolean;
      metadata: Record<string, any>;
    }> = [];

    const allowedSections: UISection[] = [
      'main_menu',
      'categories',
      'product_detail',
      'wallet_dep',
      'navigation',
      'messages',
      'commands',
      'admin',
    ];

    for (const item of parsed.settings) {
      if (!item || typeof item.settingKey !== 'string' || !/^[a-zA-Z0-9_.:-]{2,120}$/.test(item.settingKey)) {
        throw new Error(`Invalid settingKey in import: ${String(item?.settingKey)}`);
      }
      const section = (item.section || 'categories') as UISection;
      if (!allowedSections.includes(section)) {
        throw new Error(`Invalid section "${item.section}" for key ${item.settingKey}`);
      }
      const lang = (item.languageCode || 'en') as SupportedLanguage;
      if (!SUPPORTED_LANGUAGES.includes(lang)) {
        throw new Error(`Unsupported languageCode "${item.languageCode}"`);
      }
      const isMessage = item.settingKey.startsWith('msg.');
      const textValue = this.sanitizeText(String(item.textValue || ''), isMessage);
      const fallbackEmoji = this.sanitizeFallbackEmoji(item.fallbackEmoji);
      const customEmojiId = this.validateCustomEmojiId(item.customEmojiId);
      const buttonStyle = this.validateButtonStyle(item.buttonStyle || 'default');
      const isVisible = item.isVisible !== false;
      const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
      if (metadata.url) {
        this.validateSafeUrl(metadata.url);
      }

      validated.push({
        settingKey: item.settingKey,
        section,
        languageCode: lang,
        textValue,
        fallbackEmoji,
        customEmojiId,
        buttonStyle,
        isVisible,
        metadata,
      });
    }

    for (const entry of validated) {
      await this.upsertSetting({ ...entry, adminId });
    }

    return { imported: validated.length };
  }
}

export const uiConfigService = new UISettingService();
