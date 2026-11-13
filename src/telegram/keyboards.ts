import {
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
  TelegramReplyKeyboardMarkup,
} from './types.js';
import { ButtonBuilder } from './buttonBuilder.js';
import { SupportedLanguage, t } from '../services/i18n.js';
import { uiConfigService, UISection, UISettingRecord } from '../services/uiConfig.js';
import { config } from '../config/env.js';

function filterNonEmptyRows(rows: TelegramInlineKeyboardButton[][]): TelegramInlineKeyboardButton[][] {
  return rows.filter(r => r.length > 0);
}

/**
 * Customer Persistent 2-Button Bottom Quick-Action Bar: [ ➕ DEPOSIT ] [ 🎧 SUPPORT ]
 */
export function getCustomerMainReplyKeyboard(lang: SupportedLanguage = 'en'): TelegramReplyKeyboardMarkup {
  const placeholder = (uiConfigService.getText('msg.input_placeholder', lang) || t('input_placeholder', lang))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 64);

  return {
    keyboard: [
      [
        ButtonBuilder.buildReplyButton({ settingKey: 'btn.reply.deposit', lang }),
        ButtonBuilder.buildReplyButton({ settingKey: 'btn.reply.support', lang }),
      ],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: placeholder || undefined,
  };
}

/**
 * Customer Main Inline Keyboard Menu (DB-driven, colored, custom-emoji ready)
 */
export function getCustomerMainInlineKeyboard(
  isAdmin = false,
  lang: SupportedLanguage = 'en'
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({ settingKey: 'btn.menu.products', lang, callbackData: 'm:prod' }),
      ButtonBuilder.buildButton({ settingKey: 'btn.menu.featured', lang, callbackData: 'm:feat' }),
    ]),
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({ settingKey: 'btn.menu.search', lang, callbackData: 'm:srch' }),
      ButtonBuilder.buildButton({ settingKey: 'btn.menu.wallet', lang, callbackData: 'm:wall' }),
    ]),
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({ settingKey: 'btn.menu.add_funds', lang, callbackData: 'm:dep' }),
      ButtonBuilder.buildButton({ settingKey: 'btn.menu.orders', lang, callbackData: 'm:ord' }),
    ]),
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({ settingKey: 'btn.menu.giveaways', lang, callbackData: 'm:give' }),
      ButtonBuilder.buildButton({ settingKey: 'btn.menu.referral', lang, callbackData: 'm:ref' }),
    ]),
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({ settingKey: 'btn.menu.support', lang, callbackData: 'm:supp' }),
      ButtonBuilder.buildButton({ settingKey: 'btn.menu.profile', lang, callbackData: 'm:prof' }),
      ButtonBuilder.buildButton({ settingKey: 'btn.menu.language', lang, callbackData: 'm:lang' }),
    ]),
  ];

  if (isAdmin) {
    rows.push(
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ settingKey: 'btn.menu.admin', lang, callbackData: 'adm:main', forceVisible: true }),
      ])
    );
  }

  return { inline_keyboard: filterNonEmptyRows(rows) };
}

/**
 * Back and Home navigation buttons
 */
export function getBackHomeKeyboard(
  backCallback = 'm:home',
  lang: SupportedLanguage = 'en'
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: filterNonEmptyRows([ButtonBuilder.buildNavigationRow(backCallback, lang)]),
  };
}

/**
 * Stale Menu Recovery Keyboard
 */
export function getStaleMenuKeyboard(lang: SupportedLanguage = 'en'): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          text: lang === 'ur' ? 'نیا مینو کھولیں' : 'OPEN NEW MENU',
          fallbackEmoji: '🔄',
          style: 'primary',
          callbackData: 'm:home',
          forceVisible: true,
        }),
      ]),
    ],
  };
}

/**
 * Product Categories Keyboard — Clean 3-column grid with blue primary style & utility actions
 */
export function getCategoryKeyboard(
  categories: Array<{ id: string; name: string }>,
  lang: SupportedLanguage = 'en',
  catPage = 1
): TelegramInlineKeyboardMarkup {
  const pageSize = 9;
  const totalPages = Math.max(1, Math.ceil(categories.length / pageSize));
  const safePage = Math.min(Math.max(1, catPage), totalPages);
  const start = (safePage - 1) * pageSize;
  const pageCategories = categories.slice(start, start + pageSize);

  const catButtons = pageCategories.map(cat => {
    const customSettingKey = `btn.cat.${cat.id}`;
    const custom = uiConfigService.getCachedSetting(customSettingKey, lang);
    if (custom) {
      return ButtonBuilder.buildButton({
        settingKey: customSettingKey,
        lang,
        callbackData: `cat:${cat.id}:1`,
      });
    }
    return ButtonBuilder.buildButton({
      text: cat.name,
      style: 'primary',
      callbackData: `cat:${cat.id}:1`,
    });
  });

  const rows: TelegramInlineKeyboardButton[][] = ButtonBuilder.buildGrid(catButtons, 3);

  if (totalPages > 1) {
    rows.push(
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          settingKey: 'btn.nav.prev',
          lang,
          callbackData: safePage > 1 ? `catp:${safePage - 1}` : 'noop',
          disabled: safePage <= 1,
          forceVisible: true,
        }),
        ButtonBuilder.buildButton({
          text: `${safePage} / ${totalPages}`,
          style: 'default',
          callbackData: 'noop',
          forceVisible: true,
        }),
        ButtonBuilder.buildButton({
          settingKey: 'btn.nav.next',
          lang,
          callbackData: safePage < totalPages ? `catp:${safePage + 1}` : 'noop',
          disabled: safePage >= totalPages,
          forceVisible: true,
        }),
      ])
    );
  }

  rows.push(
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({ settingKey: 'btn.cat.all', lang, callbackData: 'cat:all:1' }),
      ButtonBuilder.buildButton({ settingKey: 'btn.cat.featured', lang, callbackData: 'm:feat' }),
      ButtonBuilder.buildButton({ settingKey: 'btn.cat.search', lang, callbackData: 'm:srch' }),
    ])
  );

  rows.push(
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({ settingKey: 'btn.cat.support', lang, callbackData: 'm:supp' }),
      ButtonBuilder.buildButton({ settingKey: 'btn.nav.home', lang, callbackData: 'm:home', forceVisible: true }),
    ])
  );

  return { inline_keyboard: filterNonEmptyRows(rows) };
}

/**
 * Product List Inline Buttons (Product items with selling price, pagination, back/home)
 */
export function getProductListKeyboard(params: {
  products: Array<{ id: string; name: string; sellingPrice: string }>;
  page: number;
  totalPages: number;
  catId: string;
  lang?: SupportedLanguage;
  paginationPrefix?: 'cat' | 'feat' | 'srch';
}): TelegramInlineKeyboardMarkup {
  const { products, page, totalPages, catId, lang = 'en', paginationPrefix = 'cat' } = params;
  const rows: TelegramInlineKeyboardButton[][] = [];
  const safeTotal = Math.max(1, totalPages);

  for (const p of products) {
    const label = `${p.name} — ${p.sellingPrice} USDT`;
    rows.push(
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          text: label,
          style: 'default',
          callbackData: `p:${p.id}:${catId}:${page}`,
          forceVisible: true,
        }),
      ])
    );
  }

  const prevCb =
    page > 1
      ? paginationPrefix === 'cat'
        ? `cat:${catId}:${page - 1}`
        : `${paginationPrefix}:${page - 1}`
      : 'noop';
  const nextCb =
    page < safeTotal
      ? paginationPrefix === 'cat'
        ? `cat:${catId}:${page + 1}`
        : `${paginationPrefix}:${page + 1}`
      : 'noop';

  rows.push(
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({
        settingKey: 'btn.nav.prev',
        lang,
        callbackData: prevCb,
        disabled: page <= 1,
        forceVisible: true,
      }),
      ButtonBuilder.buildButton({
        text: `PAGE ${page} / ${safeTotal}`,
        style: 'default',
        callbackData: 'noop',
        forceVisible: true,
      }),
      ButtonBuilder.buildButton({
        settingKey: 'btn.nav.next',
        lang,
        callbackData: nextCb,
        disabled: page >= safeTotal,
        forceVisible: true,
      }),
    ])
  );

  rows.push(
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({
        settingKey: 'btn.nav.back',
        lang,
        callbackData: 'm:prod',
        forceVisible: true,
      }),
      ButtonBuilder.buildButton({
        settingKey: 'btn.nav.home',
        lang,
        callbackData: 'm:home',
        forceVisible: true,
      }),
    ])
  );

  return { inline_keyboard: filterNonEmptyRows(rows) };
}

/**
 * Product Detail Inline Buttons (Quantity controls, Buy Now [success], More Details [primary], Prev/Next Product, Back to list, Home)
 */
export function getProductDetailKeyboard(params: {
  productId: string;
  quantity?: number;
  catId?: string;
  page?: number;
  prevProductId?: string | null;
  prevProductPage?: number;
  nextProductId?: string | null;
  nextProductPage?: number;
  lang?: SupportedLanguage;
}): TelegramInlineKeyboardMarkup {
  const {
    productId,
    quantity = 1,
    catId = 'all',
    page = 1,
    prevProductId = null,
    prevProductPage = page,
    nextProductId = null,
    nextProductPage = page,
    lang = 'en',
  } = params;

  const rows: TelegramInlineKeyboardButton[][] = [];

  const decQty = Math.max(1, quantity - 1);
  const incQty = quantity + 1;
  rows.push(
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({
        text: '➖',
        style: 'default',
        callbackData: `qty:${productId}:${decQty}:${catId}:${page}`,
        forceVisible: true,
      }),
      ButtonBuilder.buildButton({
        text: `Qty: ${quantity}`,
        style: 'default',
        callbackData: 'noop',
        forceVisible: true,
      }),
      ButtonBuilder.buildButton({
        text: '➕',
        style: 'default',
        callbackData: `qty:${productId}:${incQty}:${catId}:${page}`,
        forceVisible: true,
      }),
    ])
  );

  rows.push(
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({
        settingKey: 'btn.prod.buy_now',
        lang,
        callbackData: `buy:${productId}:${quantity}`,
        forceVisible: true,
      }),
      ButtonBuilder.buildButton({
        settingKey: 'btn.prod.more_details',
        lang,
        callbackData: `det:${productId}:${catId}:${page}`,
      }),
    ])
  );

  const productNavRow = ButtonBuilder.buildActionRow([
    prevProductId
      ? ButtonBuilder.buildButton({
          settingKey: 'btn.nav.prev_product',
          lang,
          callbackData: `p:${prevProductId}:${catId}:${prevProductPage}`,
          forceVisible: true,
        })
      : null,
    nextProductId
      ? ButtonBuilder.buildButton({
          settingKey: 'btn.nav.next_product',
          lang,
          callbackData: `p:${nextProductId}:${catId}:${nextProductPage}`,
          forceVisible: true,
        })
      : null,
  ]);
  if (productNavRow.length > 0) {
    rows.push(productNavRow);
  }

  rows.push(
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({
        settingKey: 'btn.nav.back_to_list',
        lang,
        callbackData: `cat:${catId}:${page}`,
        forceVisible: true,
      }),
      ButtonBuilder.buildButton({
        settingKey: 'btn.nav.home',
        lang,
        callbackData: 'm:home',
        forceVisible: true,
      }),
    ])
  );

  return { inline_keyboard: filterNonEmptyRows(rows) };
}

/**
 * Purchase Confirmation Keyboard (Confirm [success], Cancel [danger])
 */
export function getPurchaseConfirmKeyboard(
  productId: string,
  quantity: number,
  catId = 'all',
  page = 1,
  lang: SupportedLanguage = 'en'
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: filterNonEmptyRows([
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          settingKey: 'btn.prod.confirm_buy',
          lang,
          callbackData: `buyc:${productId}:${quantity}`,
          forceVisible: true,
        }),
        ButtonBuilder.buildButton({
          settingKey: 'btn.prod.cancel',
          lang,
          callbackData: `p:${productId}:${catId}:${page}`,
          forceVisible: true,
        }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ settingKey: 'btn.nav.home', lang, callbackData: 'm:home', forceVisible: true }),
      ]),
    ]),
  };
}

/**
 * More Details Screen Keyboard
 */
export function getMoreDetailsKeyboard(
  productId: string,
  catId = 'all',
  page = 1,
  lang: SupportedLanguage = 'en'
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: filterNonEmptyRows([
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          settingKey: 'btn.nav.back_to_product',
          lang,
          callbackData: `p:${productId}:${catId}:${page}`,
          forceVisible: true,
        }),
        ButtonBuilder.buildButton({
          settingKey: 'btn.nav.home',
          lang,
          callbackData: 'm:home',
          forceVisible: true,
        }),
      ]),
    ]),
  };
}

export function getProductCardKeyboard(
  productId: string,
  quantity = 1,
  backCatId = 'all',
  page = 1,
  lang: SupportedLanguage = 'en'
): TelegramInlineKeyboardMarkup {
  return getProductDetailKeyboard({
    productId,
    quantity,
    catId: backCatId,
    page,
    lang,
  });
}

/**
 * Wallet Screen Keyboard
 */
export function getWalletKeyboard(lang: SupportedLanguage = 'en'): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: filterNonEmptyRows([
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ settingKey: 'btn.wall.add_funds', lang, callbackData: 'm:dep', forceVisible: true }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ settingKey: 'btn.wall.history', lang, callbackData: 'w:hist' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ settingKey: 'btn.nav.home', lang, callbackData: 'm:home', forceVisible: true }),
      ]),
    ]),
  };
}

/**
 * Payment Methods Keyboard
 */
export function getDepositMethodsKeyboard(lang: SupportedLanguage = 'en'): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: filterNonEmptyRows([
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ settingKey: 'btn.dep.binance', lang, callbackData: 'dep_m:binance' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ settingKey: 'btn.dep.easypaisa', lang, callbackData: 'dep_m:easypaisa' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ settingKey: 'btn.dep.jazzcash', lang, callbackData: 'dep_m:jazzcash' }),
      ]),
      ButtonBuilder.buildNavigationRow('m:wall', lang),
    ]),
  };
}

/**
 * Binance Invoice Action Keyboard (Order-ID Customer Flow)
 * Strictly TWO buttons: [ 🔎 SUBMIT ORDER ID ] (success) and [ ❌ CANCEL ] (danger)
 */
export function getBinanceInvoiceKeyboard(
  depositId: string,
  lang: SupportedLanguage = 'en'
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: filterNonEmptyRows([
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          settingKey: 'btn.dep.bin_submit',
          lang,
          callbackData: `bin_tx:${depositId}`,
          forceVisible: true,
        }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          settingKey: 'btn.dep.cancel',
          lang,
          callbackData: 'm:dep',
          forceVisible: true,
        }),
      ]),
    ]),
  };
}

/**
 * Keyboard shown when customer submits an Order ID belonging to a payment sent before invoice creation.
 */
export function getPaymentBeforeInvoiceKeyboard(
  lang: SupportedLanguage = 'en',
  depositId?: string
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: filterNonEmptyRows([
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          text: lang === 'ur' ? 'سپورٹ سے رابطہ کریں' : 'CONTACT SUPPORT',
          fallbackEmoji: '🎧',
          style: 'primary',
          callbackData: depositId ? `bin_sup:${depositId}` : 'm:supp',
          forceVisible: true,
        }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          text: lang === 'ur' ? 'موجودہ انوائس بنائیں' : 'CREATE CURRENT INVOICE',
          fallbackEmoji: '➕',
          style: 'success',
          callbackData: 'dep_m:binance',
          forceVisible: true,
        }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          settingKey: 'btn.nav.home',
          lang,
          callbackData: 'm:home',
          forceVisible: true,
        }),
      ]),
    ]),
  };
}

/**
 * Language Selection Keyboard
 */
export function getLanguageKeyboard(currentLang: SupportedLanguage = 'en'): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: filterNonEmptyRows([
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          settingKey: 'btn.lang.en',
          lang: currentLang,
          suffix: currentLang === 'en' ? '✓' : '',
          style: currentLang === 'en' ? 'success' : 'primary',
          callbackData: 'lang:en',
          forceVisible: true,
        }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          settingKey: 'btn.lang.ur',
          lang: currentLang,
          suffix: currentLang === 'ur' ? '✓' : '',
          style: currentLang === 'ur' ? 'success' : 'primary',
          callbackData: 'lang:ur',
          forceVisible: true,
        }),
        ButtonBuilder.buildButton({
          settingKey: 'btn.lang.ur_ro',
          lang: currentLang,
          suffix: currentLang === 'ur-ro' ? '✓' : '',
          style: currentLang === 'ur-ro' ? 'success' : 'primary',
          callbackData: 'lang:ur-ro',
          forceVisible: true,
        }),
      ]),
      ButtonBuilder.buildNavigationRow('m:home', currentLang),
    ]),
  };
}

/**
 * Admin Main Menu Keyboard
 */
export function getAdminMainMenuKeyboard(lang: SupportedLanguage = 'en'): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: filterNonEmptyRows([
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'DASHBOARD', fallbackEmoji: '📊', style: 'primary', callbackData: 'adm:dash' }),
        ButtonBuilder.buildButton({ text: 'PRODUCTS', fallbackEmoji: '🛍️', style: 'primary', callbackData: 'adm:prod:1' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'PRICING', fallbackEmoji: '💲', style: 'default', callbackData: 'adm:price' }),
        ButtonBuilder.buildButton({ text: 'CATEGORIES', fallbackEmoji: '🗂️', style: 'default', callbackData: 'adm:cat' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'ORDERS', fallbackEmoji: '📦', style: 'default', callbackData: 'adm:ord' }),
        ButtonBuilder.buildButton({ text: 'WALLETS', fallbackEmoji: '💰', style: 'default', callbackData: 'adm:wal' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'DEPOSITS (Pending)', fallbackEmoji: '💳', style: 'primary', callbackData: 'adm:dep' }),
        ButtonBuilder.buildButton({ text: 'GIVEAWAYS', fallbackEmoji: '🎁', style: 'default', callbackData: 'adm:gw' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ settingKey: 'btn.adm.ui_editor', lang, callbackData: 'adm:ui', forceVisible: true }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'SUPPLIER SYNC', fallbackEmoji: '🔄', style: 'primary', callbackData: 'adm:sync' }),
        ButtonBuilder.buildButton({ text: 'SYSTEM HEALTH', fallbackEmoji: '🩺', style: 'default', callbackData: 'adm:hlth' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          text: 'SUPPLIER READ-ONLY DIAG',
          fallbackEmoji: '🔬',
          style: 'primary',
          callbackData: 'adm:sup_diag',
          forceVisible: true,
        }),
      ]),
      ...(config.binance.diagnosticEnabled
        ? [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: 'BINANCE HISTORY DIAGNOSTIC',
                fallbackEmoji: '🔬',
                style: 'primary',
                callbackData: 'adm:bin_diag',
                forceVisible: true,
              }),
            ]),
          ]
        : []),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ settingKey: 'btn.adm.exit', lang, callbackData: 'm:home', forceVisible: true }),
      ]),
    ]),
  };
}

/**
 * Admin UI Customization Center Keyboard
 */
export function getAdminUiCenterKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: filterNonEmptyRows([
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Main Menu Buttons', fallbackEmoji: '🏠', style: 'primary', callbackData: 'adm:uis:main_menu:1' }),
        ButtonBuilder.buildButton({ text: 'Category Buttons', fallbackEmoji: '🗂️', style: 'primary', callbackData: 'adm:uis:categories:1' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Product & Buy', fallbackEmoji: '🛍️', style: 'primary', callbackData: 'adm:uis:product_detail:1' }),
        ButtonBuilder.buildButton({ text: 'Wallet & Deposit', fallbackEmoji: '💳', style: 'primary', callbackData: 'adm:uis:wallet_dep:1' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Nav & Language', fallbackEmoji: '🧭', style: 'primary', callbackData: 'adm:uis:navigation:1' }),
        ButtonBuilder.buildButton({ text: 'Texts & Messages', fallbackEmoji: '📝', style: 'primary', callbackData: 'adm:uis:messages:1' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Slash Commands', fallbackEmoji: '⌨️', style: 'primary', callbackData: 'adm:uis:commands:1' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Export UI JSON', fallbackEmoji: '📤', style: 'default', callbackData: 'adm:ui_exp' }),
        ButtonBuilder.buildButton({ text: 'Import UI JSON', fallbackEmoji: '📥', style: 'default', callbackData: 'adm:ui_imp' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Reset ALL UI Defaults', fallbackEmoji: '⚠️', style: 'danger', callbackData: 'adm:ui_rst_all' }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main' }),
      ]),
    ]),
  };
}

/**
 * Admin UI Section Item Picker Keyboard
 */
export function getAdminUiSectionKeyboard(
  section: UISection,
  items: UISettingRecord[],
  page: number,
  totalPages: number,
  lang: SupportedLanguage
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [];
  for (const item of items) {
    const visIcon = item.isVisible ? '👁️' : '🙈';
    const styleBadge = item.buttonStyle !== 'default' ? ` [${item.buttonStyle}]` : '';
    const emojiBadge = item.customEmojiId ? ' ✨' : item.fallbackEmoji ? ` ${item.fallbackEmoji}` : '';
    const label = `${visIcon}${emojiBadge} ${item.settingKey}${styleBadge}`.slice(0, 48);
    rows.push(
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          text: label,
          style: item.buttonStyle,
          callbackData: `adm:uie:${item.settingKey}:${lang}`,
          forceVisible: true,
        }),
      ])
    );
  }

  if (totalPages > 1) {
    rows.push(
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          text: 'PREV',
          fallbackEmoji: '⬅️',
          style: page > 1 ? 'primary' : 'default',
          callbackData: page > 1 ? `adm:uis:${section}:${page - 1}` : 'noop',
        }),
        ButtonBuilder.buildButton({ text: `${page}/${totalPages}`, style: 'default', callbackData: 'noop' }),
        ButtonBuilder.buildButton({
          text: 'NEXT ➡️',
          style: page < totalPages ? 'primary' : 'default',
          callbackData: page < totalPages ? `adm:uis:${section}:${page + 1}` : 'noop',
        }),
      ])
    );
  }

  rows.push(
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({
        text: `Reset Section (${lang.toUpperCase()})`,
        fallbackEmoji: '🔄',
        style: 'danger',
        callbackData: `adm:ui_rs:${section}:${lang}`,
      }),
    ])
  );
  rows.push(
    ButtonBuilder.buildActionRow([
      ButtonBuilder.buildButton({ text: 'UI CENTER', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:ui' }),
      ButtonBuilder.buildButton({ text: 'ADMIN', fallbackEmoji: '👑', style: 'default', callbackData: 'adm:main' }),
    ])
  );

  return { inline_keyboard: filterNonEmptyRows(rows) };
}

/**
 * Admin UI Single Item Editor Keyboard
 */
export function getAdminUiItemEditorKeyboard(item: UISettingRecord): TelegramInlineKeyboardMarkup {
  const k = item.settingKey;
  const l = item.languageCode;
  const nextLang: SupportedLanguage = l === 'en' ? 'ur' : l === 'ur' ? 'ur-ro' : 'en';

  return {
    inline_keyboard: filterNonEmptyRows([
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Edit Text', fallbackEmoji: '✏️', style: 'primary', callbackData: `adm:uit:${k}:${l}` }),
        ButtonBuilder.buildButton({ text: 'Edit Emoji', fallbackEmoji: '😀', style: 'primary', callbackData: `adm:uiem:${k}:${l}` }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Blue', fallbackEmoji: '🔵', style: 'primary', callbackData: `adm:uist:${k}:${l}:primary` }),
        ButtonBuilder.buildButton({ text: 'Green', fallbackEmoji: '🟢', style: 'success', callbackData: `adm:uist:${k}:${l}:success` }),
        ButtonBuilder.buildButton({ text: 'Red', fallbackEmoji: '🔴', style: 'danger', callbackData: `adm:uist:${k}:${l}:danger` }),
        ButtonBuilder.buildButton({ text: 'Default', fallbackEmoji: '⚪', style: 'default', callbackData: `adm:uist:${k}:${l}:default` }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({
          text: item.isVisible ? 'Hide Button' : 'Show Button',
          fallbackEmoji: item.isVisible ? '🙈' : '👁️',
          style: 'default',
          callbackData: `adm:uiv:${k}:${l}`,
        }),
        ButtonBuilder.buildButton({
          text: `Lang: ${l.toUpperCase()} → ${nextLang.toUpperCase()}`,
          fallbackEmoji: '🌐',
          style: 'default',
          callbackData: `adm:uie:${k}:${nextLang}`,
        }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Reset Item', fallbackEmoji: '🔄', style: 'danger', callbackData: `adm:uir:${k}:${l}` }),
        ButtonBuilder.buildButton({ text: 'BACK', fallbackEmoji: '⬅️', style: 'default', callbackData: `adm:uis:${item.section}:1` }),
      ]),
    ]),
  };
}
