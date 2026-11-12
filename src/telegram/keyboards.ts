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
 * Product List Inline Buttons (Product items with selling price, pagination, back/home)
 */
export function getProductListKeyboard(params: {
  products: Array<{ id: string; name: string; sellingPrice: string }>;
  page: number;
  totalPages: number;
  catId: string;
}): TelegramInlineKeyboardMarkup {
  const { products, page, totalPages, catId } = params;
  const rows: any[][] = [];

  // Each product button shows: Product Name — Selling Price USDT
  for (const p of products) {
    const label = `${p.name} — ${p.sellingPrice} USDT`;
    rows.push([
      {
        text: label,
        callback_data: `p:${p.id}:${catId}:${page}`,
      },
    ]);
  }

  // Pagination row: ⬅️ PREVIOUS | PAGE X / Y | NEXT ➡️
  const navRow: any[] = [];
  if (page > 1) {
    navRow.push({ text: '⬅️ PREVIOUS', callback_data: `cat:${catId}:${page - 1}` });
  } else {
    navRow.push({ text: '⬅️ PREVIOUS', callback_data: 'noop' });
  }

  navRow.push({ text: `PAGE ${page} / ${Math.max(1, totalPages)}`, callback_data: 'noop' });

  if (page < totalPages) {
    navRow.push({ text: 'NEXT ➡️', callback_data: `cat:${catId}:${page + 1}` });
  } else {
    navRow.push({ text: 'NEXT ➡️', callback_data: 'noop' });
  }
  rows.push(navRow);

  // Bottom navigation row: ⬅️ BACK | 🏠 HOME
  rows.push([
    { text: '⬅️ BACK', callback_data: 'm:prod' },
    { text: '🏠 HOME', callback_data: 'm:home' },
  ]);

  return { inline_keyboard: rows };
}

/**
 * Product Detail Inline Buttons (Quantity controls, Buy Now, More Details, Prev/Next Product, Back to list, Home)
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
  } = params;

  const rows: any[][] = [];

  // Row 1: Quantity controls
  const decQty = Math.max(1, quantity - 1);
  const incQty = quantity + 1;
  rows.push([
    { text: '➖', callback_data: `qty:${productId}:${decQty}:${catId}:${page}` },
    { text: `Qty: ${quantity}`, callback_data: 'noop' },
    { text: '➕', callback_data: `qty:${productId}:${incQty}:${catId}:${page}` },
  ]);

  // Row 2: Action buttons (Buy Now, More Details)
  rows.push([
    { text: '🛒 BUY NOW', callback_data: `buy:${productId}:${quantity}` },
    { text: '📋 MORE DETAILS', callback_data: `det:${productId}:${catId}:${page}` },
  ]);

  // Row 3: Product Navigation (⬅️ PREVIOUS PRODUCT | NEXT PRODUCT ➡️)
  const productNavRow: any[] = [];
  if (prevProductId) {
    productNavRow.push({
      text: '⬅️ PREVIOUS PRODUCT',
      callback_data: `p:${prevProductId}:${catId}:${prevProductPage}`,
    });
  }
  if (nextProductId) {
    productNavRow.push({
      text: 'NEXT PRODUCT ➡️',
      callback_data: `p:${nextProductId}:${catId}:${nextProductPage}`,
    });
  }
  if (productNavRow.length > 0) {
    rows.push(productNavRow);
  }

  // Row 4: List Navigation (📋 BACK TO LIST preserves page, 🏠 HOME)
  rows.push([
    { text: '📋 BACK TO LIST', callback_data: `cat:${catId}:${page}` },
    { text: '🏠 HOME', callback_data: 'm:home' },
  ]);

  return { inline_keyboard: rows };
}

/**
 * More Details Screen Keyboard
 */
export function getMoreDetailsKeyboard(productId: string, catId = 'all', page = 1): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '⬅️ BACK TO PRODUCT', callback_data: `p:${productId}:${catId}:${page}` },
        { text: '🏠 HOME', callback_data: 'm:home' },
      ],
    ],
  };
}

/**
 * Backwards compatibility helper for existing references
 */
export function getProductCardKeyboard(productId: string, quantity = 1, backCatId = 'all', page = 1): TelegramInlineKeyboardMarkup {
  return getProductDetailKeyboard({
    productId,
    quantity,
    catId: backCatId,
    page,
  });
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
export function getBinanceInvoiceKeyboard(depositId: string, showManualTxid = true): TelegramInlineKeyboardMarkup {
  const rows: any[][] = [
    [{ text: '✅ I HAVE PAID — VERIFY NOW', callback_data: `bin_v:${depositId}` }],
  ];

  if (showManualTxid) {
    rows.push([{ text: '🔎 VERIFY WITH TRANSACTION ID', callback_data: `bin_tx:${depositId}` }]);
  }

  rows.push([
    { text: '❌ CANCEL', callback_data: 'm:dep' },
    { text: '🏠 HOME', callback_data: 'm:home' },
  ]);

  return { inline_keyboard: rows };
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
