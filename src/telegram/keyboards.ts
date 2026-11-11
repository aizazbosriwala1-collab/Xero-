import { TelegramInlineKeyboardMarkup, TelegramReplyKeyboardMarkup } from './types.js';

/**
 * Customer Main Persistent Reply Keyboard
 */
export function getCustomerMainReplyKeyboard(): TelegramReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: '🛍️ PRODUCTS' }, { text: '🔥 FEATURED' }, { text: '🔎 SEARCH' }],
      [{ text: '💰 WALLET' }, { text: '➕ ADD FUNDS' }, { text: '📦 MY ORDERS' }],
      [{ text: '🎁 GIVEAWAYS' }, { text: '👥 REFER & EARN' }, { text: '🛟 SUPPORT' }],
      [{ text: '👤 PROFILE' }, { text: '🌐 LANGUAGE' }]
    ],
    resize_keyboard: true,
  };
}

/**
 * Customer Main Inline Keyboard Menu
 */
export function getCustomerMainInlineKeyboard(isAdmin = false): TelegramInlineKeyboardMarkup {
  const buttons = [
    [
      { text: '🛍️ PRODUCTS', callback_data: 'm:prod' },
      { text: '🔥 FEATURED', callback_data: 'm:feat' },
    ],
    [
      { text: '🔎 SEARCH', callback_data: 'm:srch' },
      { text: '💰 WALLET', callback_data: 'm:wall' },
    ],
    [
      { text: '➕ ADD FUNDS', callback_data: 'm:dep' },
      { text: '📦 MY ORDERS', callback_data: 'm:ord' },
    ],
    [
      { text: '🎁 GIVEAWAYS', callback_data: 'm:give' },
      { text: '👥 REFER & EARN', callback_data: 'm:ref' },
    ],
    [
      { text: '🛟 SUPPORT', callback_data: 'm:supp' },
      { text: '👤 PROFILE', callback_data: 'm:prof' },
      { text: '🌐 LANG', callback_data: 'm:lang' },
    ],
  ];

  if (isAdmin) {
    buttons.push([{ text: '👑 ADMIN CONTROL CENTER', callback_data: 'adm:main' }]);
  }

  return { inline_keyboard: buttons };
}

/**
 * Back and Home navigation buttons
 */
export function getBackHomeKeyboard(backCallback = 'm:home'): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '⬅️ BACK', callback_data: backCallback },
        { text: '🏠 HOME', callback_data: 'm:home' },
      ]
    ]
  };
}

/**
 * Product Categories Keyboard
 */
export function getCategoryKeyboard(categories: Array<{ id: string; name: string }>): TelegramInlineKeyboardMarkup {
  const rows: any[][] = [];
  for (let i = 0; i < categories.length; i += 2) {
    const row = [{ text: categories[i].name, callback_data: `cat:${categories[i].id}:1` }];
    if (categories[i + 1]) {
      row.push({ text: categories[i + 1].name, callback_data: `cat:${categories[i + 1].id}:1` });
    }
    rows.push(row);
  }
  rows.push([
    { text: '⚡ ALL PRODUCTS', callback_data: 'cat:all:1' },
    { text: '🔥 FEATURED', callback_data: 'm:feat' },
  ]);
  rows.push([
    { text: '🏠 HOME', callback_data: 'm:home' },
  ]);
  return { inline_keyboard: rows };
}

/**
 * Product Card Inline Buttons (Buy, Quantity, Details, Back)
 */
export function getProductCardKeyboard(productId: string, quantity = 1, backCatId = 'all'): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '➖', callback_data: `qty:${productId}:${Math.max(1, quantity - 1)}:${backCatId}` },
        { text: `Qty: ${quantity}`, callback_data: 'noop' },
        { text: '➕', callback_data: `qty:${productId}:${quantity + 1}:${backCatId}` },
      ],
      [
        { text: '🛒 BUY NOW', callback_data: `buy:${productId}:${quantity}` },
        { text: '📋 MORE DETAILS', callback_data: `det:${productId}` },
      ],
      [
        { text: '⬅️ BACK', callback_data: `cat:${backCatId}:1` },
        { text: '🏠 HOME', callback_data: 'm:home' },
      ]
    ]
  };
}

/**
 * Payment Methods Keyboard
 */
export function getDepositMethodsKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '⚡ BINANCE PAY USDT (Instant)', callback_data: 'dep_m:binance' }],
      [{ text: '📱 EASYPAISA (PKR / Manual)', callback_data: 'dep_m:easypaisa' }],
      [{ text: '📱 JAZZCASH (PKR / Manual)', callback_data: 'dep_m:jazzcash' }],
      [{ text: '⬅️ BACK', callback_data: 'm:wall' }, { text: '🏠 HOME', callback_data: 'm:home' }]
    ]
  };
}

/**
 * Binance Invoice Action Keyboard
 */
export function getBinanceInvoiceKeyboard(depositId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '✅ I HAVE PAID — VERIFY NOW', callback_data: `bin_v:${depositId}` }],
      [{ text: '🔑 ENTER TRANSACTION ID', callback_data: `bin_tx:${depositId}` }],
      [{ text: '⬅️ BACK', callback_data: 'm:dep' }, { text: '🏠 HOME', callback_data: 'm:home' }]
    ]
  };
}

/**
 * Admin Main Menu Keyboard
 */
export function getAdminMainMenuKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '📊 DASHBOARD', callback_data: 'adm:dash' },
        { text: '🛍️ PRODUCTS', callback_data: 'adm:prod:1' },
      ],
      [
        { text: '💲 PRICING', callback_data: 'adm:price' },
        { text: '🗂️ CATEGORIES', callback_data: 'adm:cat' },
      ],
      [
        { text: '📦 ORDERS', callback_data: 'adm:ord' },
        { text: '💰 WALLETS', callback_data: 'adm:wal' },
      ],
      [
        { text: '💳 DEPOSITS (Pending)', callback_data: 'adm:dep' },
        { text: '🎁 GIVEAWAYS', callback_data: 'adm:gw' },
      ],
      [
        { text: '🔄 SUPPLIER SYNC', callback_data: 'adm:sync' },
        { text: '🩺 SYSTEM HEALTH', callback_data: 'adm:hlth' },
      ],
      [
        { text: '🚪 EXIT ADMIN', callback_data: 'm:home' }
      ]
    ]
  };
}
