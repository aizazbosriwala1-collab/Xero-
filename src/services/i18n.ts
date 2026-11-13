import { db } from '../db/index.js';

export type SupportedLanguage = 'en' | 'ur' | 'ur-ro';

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = ['en', 'ur', 'ur-ro'];

export function resolveLanguage(lang?: string | null): SupportedLanguage {
  if (!lang) return 'en';
  const norm = lang.trim().toLowerCase();
  if (norm === 'ur' || norm === 'urdu') return 'ur';
  if (norm === 'ur-ro' || norm === 'roman' || norm === 'roman-urdu') return 'ur-ro';
  return 'en';
}

export async function getUserLanguage(userId: string): Promise<SupportedLanguage> {
  try {
    const profile = await db.queryRow<{ preferred_language?: string }>(
      'SELECT preferred_language FROM user_profiles WHERE user_id = $1',
      [userId]
    );
    if (profile?.preferred_language) {
      return resolveLanguage(profile.preferred_language);
    }
    const user = await db.queryRow<{ language_code?: string }>(
      'SELECT language_code FROM users WHERE id = $1',
      [userId]
    );
    return resolveLanguage(user?.language_code);
  } catch {
    return 'en';
  }
}

export const translations: Record<SupportedLanguage, Record<string, string>> = {
  en: {
    welcome:
      '⚡ *WELCOME TO XERO KHAN*\n_Digital Tools. Instant Access._\n\nBrowse premium AI, developer, streaming, design, and security tools with instant automated delivery and protected wallet payments.',
    menu_ready: '⚡ *XERO KHAN MENU READY*\nTap *☰ MENU* anytime to open the store.',
    categories_header:
      '🛍️ *BROWSE CATEGORIES*\n\nSelect a category below to explore live in-stock tools, or browse all products:',
    featured_header:
      '🔥 *FEATURED DIGITAL TOOLS*\n\nHand-picked popular tools with instant delivery (Page {page} of {totalPages}):',
    featured_empty:
      '🔥 *FEATURED DIGITAL TOOLS*\n\nNo featured items are highlighted right now. Explore all live products below!',
    search_prompt:
      '🔎 *SEARCH CATALOGUE*\n\nType the name or keyword of the tool you are looking for (e.g., ChatGPT, Canva, Netflix, Cursor):',
    search_results:
      '🔎 *SEARCH RESULTS FOR "{query}"*\n\nFound *{total}* matching tools (Page {page} of {totalPages}). Tap any item to view details:',
    search_empty:
      '🔎 *NO MATCHING TOOLS*\n\nNo in-stock products matched `"{query}"`. Try another keyword or browse categories:',
    wallet_info:
      '💳 *YOUR WALLET BALANCE*\n\n• Available: `{balance} USDT`\n• Locked: `{locked} USDT`\n\nInstant Binance Pay USDT verification or manual Easypaisa / JazzCash top-ups supported.',
    wallet_history_header: '📜 *RECENT WALLET TRANSACTIONS*\n\n',
    wallet_history_empty: '📜 *WALLET TRANSACTIONS*\n\nNo wallet transactions recorded yet.',
    choose_payment:
      '➕ *ADD FUNDS TO WALLET*\n\nSelect your preferred deposit method below:',
    binance_desc:
      '⚡ *BINANCE PAY USDT*\n\nInstant TXID verification. No screenshot required.',
    manual_desc:
      '📱 *LOCAL MOBILE PAYMENT*\n\nManual verification by admin within 5–30 minutes.',
    order_success:
      '🎉 *ORDER COMPLETED!*\n\nYour order `{orderId}` has been delivered successfully.\n\n*Credentials / Details:*',
    orders_header: '📦 *YOUR RECENT ORDERS*\n\n',
    orders_empty:
      '📦 *MY ORDERS*\n\nYou have not placed any orders yet. Tap *🛍️ PRODUCTS* to start shopping!',
    insufficient_funds:
      '⚠️ *INSUFFICIENT FUNDS*\n\nYou need `{required} USDT` but have `{available} USDT`. Tap *➕ ADD FUNDS* below to top up.',
    giveaways_header: '🎁 *DYNAMIC GIVEAWAYS*\n\n',
    giveaways_empty:
      '🎁 *GIVEAWAYS*\n\nNo dynamic giveaways are active right now. Check back soon!',
    referral_title:
      '👥 *REFER & EARN PROGRAM*\n\nShare your personal invite link. When friends complete their first purchase, you earn progress toward dynamic giveaway rewards!\n\n🔗 *Your Referral Link:*\n`{link}`\n\n📊 *Your Stats:*\n• Total Invited: `{total}`\n• Qualified: `{qualified}`\n• Pending: `{pending}`',
    support_prompt:
      '🎧 *CUSTOMER SUPPORT TICKET*\n\nDescribe your question or issue (include your Order ID if relevant). Our support team will respond promptly:',
    support_created:
      '✅ *TICKET CREATED (#{ticketId})*\n\nOur support team has received your inquiry and will reply here shortly.',
    profile_header:
      '👤 *CUSTOMER PROFILE*\n\n• Telegram ID: `{userId}`\n• Wallet Balance: `{balance} USDT`\n• Qualified Referrals: `{qualified}`\n• Language: *{langLabel}*\n\n_Protected by XERO KHAN Ledger Security._',
    language_select:
      '🌐 *SELECT LANGUAGE / زبان منتخب کریں*\n\nChoose your preferred interface language:',
    language_updated: '✅ Language updated to *English*.',
    stale_menu:
      '🔄 *MENU UPDATED*\n\nThis menu session expired or was replaced. Open a fresh menu below:',
    confirm_purchase:
      '🛒 *CONFIRM PURCHASE*\n\n• Product: *{name}*\n• Quantity: `{qty}`\n• Unit Price: `{unitPrice} USDT`\n• Total: `{totalPrice} USDT`\n• Your Wallet: `{balance} USDT`\n\nConfirm below to complete your order:',
    menu_products: '🛍️ PRODUCTS',
    menu_featured: '🔥 FEATURED',
    menu_search: '🔎 SEARCH',
    menu_wallet: '💳 WALLET',
    menu_add_funds: '➕ ADD FUNDS',
    menu_orders: '📦 MY ORDERS',
    menu_giveaways: '🎁 GIVEAWAYS',
    menu_referral: '👥 REFER & EARN',
    menu_support: '🎧 SUPPORT',
    menu_profile: '👤 PROFILE',
    menu_language: '🌐 LANGUAGE',
    btn_back: '⬅️ BACK',
    btn_home: '🏠 HOME',
    btn_buy: '🛒 BUY NOW',
    btn_details: '📋 MORE DETAILS',
    btn_confirm: '✅ CONFIRM',
    btn_cancel: '❌ CANCEL',
  },
  ur: {
    welcome:
      '⚡ *زیرو خان میں خوش آمدید*\n_ڈیجیٹل ٹولز۔ فوری رسائی۔_\n\nپریمیم اے آئی، ڈویلپر، میڈیا اور سیکیورٹی ٹولز فوری ڈیلیوری اور محفوظ ادائیگی کے ساتھ حاصل کریں۔',
    menu_ready: '⚡ *زیرو خان مینو تیار ہے*\nکسی بھی وقت *☰ MENU* دبائیں۔',
    categories_header:
      '🛍️ *کیٹیگریز دیکھیں*\n\nدستیاب ڈیجیٹل ٹولز دیکھنے کے لیے نیچے سے کیٹیگری منتخب کریں:',
    featured_header:
      '🔥 *نمایاں ڈیجیٹل ٹولز*\n\nمنتخب مقبول ٹولز فوری ڈیلیوری کے ساتھ (صفحہ {page} از {totalPages}):',
    featured_empty:
      '🔥 *نمایاں ڈیجیٹل ٹولز*\n\nاس وقت کوئی نمایاں آئٹم موجود نہیں ہے۔ تمام دستیاب پروڈکٹس نیچے دیکھیں!',
    search_prompt:
      '🔎 *کیٹلاگ میں تلاش کریں*\n\nاپنے مطلوبہ ٹول کا نام یا لفظ لکھیں (مثلاً ChatGPT, Canva, Netflix):',
    search_results:
      '🔎 *تلاش کے نتائج: "{query}"*\n\nکل *{total}* پروڈکٹس ملے (صفحہ {page} از {totalPages})۔ تفصیل کے لیے کلک کریں:',
    search_empty:
      '🔎 *کوئی پروڈکٹ نہیں ملا*\n\n`"{query}"` کے مطابق کوئی دستیاب پروڈکٹ نہیں ملا۔ کوئی اور لفظ لکھیں یا کیٹیگری دیکھیں:',
    wallet_info:
      '💳 *آپ کا والٹ بیلنس*\n\n• دستیاب: `{balance} USDT`\n• لاک شدہ: `{locked} USDT`\n\nفوری بائننس پے USDT یا ایزی پیسہ / جاز کیش کے ذریعے رقم جمع کریں۔',
    wallet_history_header: '📜 *حالیہ والٹ لین دین*\n\n',
    wallet_history_empty: '📜 *والٹ لین دین*\n\nابھی تک کوئی لین دین ریکارڈ نہیں ہوا۔',
    choose_payment:
      '➕ *والٹ میں رقم جمع کریں*\n\nنیچے سے ادائیگی کا طریقہ منتخب کریں:',
    binance_desc: '⚡ *بائننس پے USDT*\n\nفوری ٹرانزیکشن آئی ڈی تصدیق۔',
    manual_desc: '📱 *ایزی پیسہ / جاز کیش*\n\nایڈمن کی تصدیق 5 سے 30 منٹ میں۔',
    order_success:
      '🎉 *آرڈر مکمل ہو گیا!*\n\nآپ کا آرڈر `{orderId}` کامیابی سے ڈیلیور ہو چکا ہے۔\n\n*تفصیلات / اسناد:*',
    orders_header: '📦 *آپ کے حالیہ آرڈرز*\n\n',
    orders_empty:
      '📦 *میرے آرڈرز*\n\nآپ نے ابھی تک کوئی آرڈر نہیں دیا۔ خریداری کے لیے *🛍️ پروڈکٹس* پر کلک کریں!',
    insufficient_funds:
      '⚠️ *ناکافی بیلنس*\n\nآپ کو `{required} USDT` درکار ہیں جبکہ دستیاب `{available} USDT` ہیں۔',
    giveaways_header: '🎁 *انعامات / گیو اوے*\n\n',
    giveaways_empty:
      '🎁 *انعامات*\n\nاس وقت کوئی گیو اوے فعال نہیں ہے۔ جلد دوبارہ چیک کریں!',
    referral_title:
      '👥 *ریفرل پروگرام*\n\nاپنا لنک دوستوں کے ساتھ شیئر کریں۔ جب وہ پہلی خریداری مکمل کریں گے تو آپ انعامات کے اہل ہوں گے!\n\n🔗 *آپ کا ریفرل لنک:*\n`{link}`\n\n📊 *آپ کے اعدادوشمار:*\n• کل مدعو: `{total}`\n• اہل: `{qualified}`\n• زیر التوا: `{pending}`',
    support_prompt:
      '🎧 *کسٹمر سپورٹ ٹکٹ*\n\nبراہ کرم اپنا سوال یا مسئلہ بیان کریں (آرڈر آئی ڈی شامل کریں اگر موجود ہو):',
    support_created:
      '✅ *ٹکٹ بن گیا (#{ticketId})*\n\nہماری سپورٹ ٹیم کو آپ کا پیغام موصول ہو گیا ہے اور جلد جواب دیا جائے گا۔',
    profile_header:
      '👤 *کسٹمر پروفائل*\n\n• ٹیلیگرام آئی ڈی: `{userId}`\n• والٹ بیلنس: `{balance} USDT`\n• اہل ریفرلز: `{qualified}`\n• زبان: *{langLabel}*\n\n_زیرو خان لیجر سیکیورٹی سے محفوظ۔_',
    language_select:
      '🌐 *زبان منتخب کریں / SELECT LANGUAGE*\n\nاپنی پسندیدہ زبان منتخب کریں:',
    language_updated: '✅ زبان *اردو* میں تبدیل کر دی گئی ہے۔',
    stale_menu:
      '🔄 *مینو اپڈیٹ ہو گیا*\n\nیہ مینو پرانا ہو چکا ہے۔ نیا مینو نیچے سے کھولیں:',
    confirm_purchase:
      '🛒 *خریداری کی تصدیق کریں*\n\n• پروڈکٹ: *{name}*\n• تعداد: `{qty}`\n• فی قیمت: `{unitPrice} USDT`\n• کل رقم: `{totalPrice} USDT`\n• آپ کا بیلنس: `{balance} USDT`\n\nآرڈر مکمل کرنے کے لیے تصدیق کریں:',
    menu_products: '🛍️ پروڈکٹس',
    menu_featured: '🔥 نمایاں',
    menu_search: '🔎 تلاش',
    menu_wallet: '💳 والٹ',
    menu_add_funds: '➕ رقم جمع کریں',
    menu_orders: '📦 میرے آرڈرز',
    menu_giveaways: '🎁 انعامات',
    menu_referral: '👥 ریفرل',
    menu_support: '🎧 سپورٹ',
    menu_profile: '👤 پروفائل',
    menu_language: '🌐 زبان',
    btn_back: '⬅️ واپس',
    btn_home: '🏠 ہوم',
    btn_buy: '🛒 خریدیں',
    btn_details: '📋 مزید تفصیلات',
    btn_confirm: '✅ تصدیق کریں',
    btn_cancel: '❌ منسوخ',
  },
  'ur-ro': {
    welcome:
      '⚡ *XERO KHAN MEIN KHUSHAMDEED*\n_Digital Tools. Instant Access._\n\nPremium AI, Developer, Streaming aur Security tools foran delivery aur mehfooz payment ke sath hasil karein.',
    menu_ready: '⚡ *XERO KHAN MENU TAYAR HAI*\nStore kholne ke liye kisi bhi waqt *☰ MENU* dabayein.',
    categories_header:
      '🛍️ *CATEGORIES DEKHEIN*\n\nDastiyab tools dekhne ke liye neeche se category chunen:',
    featured_header:
      '🔥 *FEATURED DIGITAL TOOLS*\n\nMuntakhab mashhoor tools foran delivery ke sath (Page {page} of {totalPages}):',
    featured_empty:
      '🔥 *FEATURED TOOLS*\n\nAbhi koi featured item highlight nahi hai. Neeche tamam live products dekhein!',
    search_prompt:
      '🔎 *CATALOGUE SEARCH*\n\nTool ka naam ya keyword likhein (jaise ChatGPT, Canva, Netflix):',
    search_results:
      '🔎 *SEARCH RESULTS FOR "{query}"*\n\nTotal *{total}* tools mile (Page {page} of {totalPages}). Details dekhne ke liye click karein:',
    search_empty:
      '🔎 *KOI PRODUCT NAHI MILA*\n\n`"{query}"` se koi dastiyab item match nahi hua. Doosra lafz try karein:',
    wallet_info:
      '💳 *AAP KA WALLET BALANCE*\n\n• Dastiyab: `{balance} USDT`\n• Locked: `{locked} USDT`\n\nBinance Pay USDT ya Easypaisa / JazzCash se funds add karein.',
    wallet_history_header: '📜 *HALIYA WALLET TRANSACTIONS*\n\n',
    wallet_history_empty: '📜 *WALLET TRANSACTIONS*\n\nAbhi tak koi transaction record nahi hui.',
    choose_payment:
      '➕ *WALLET MEIN FUNDS ADD KAREIN*\n\nApna pasandeeda payment method chunen:',
    binance_desc: '⚡ *BINANCE PAY USDT*\n\nForan TXID verification. Screenshot zaroori nahi.',
    manual_desc: '📱 *EASYPAISA / JAZZCASH*\n\nAdmin verification 5–30 minutes mein.',
    order_success:
      '🎉 *ORDER MUKAMMAL HOGAYA!*\n\nAap ka order `{orderId}` kamyabi se deliver kardiya gaya hai.\n\n*Credentials / Details:*',
    orders_header: '📦 *AAP KE RECENT ORDERS*\n\n',
    orders_empty:
      '📦 *MY ORDERS*\n\nAap ne abhi tak koi order nahi diya. Shopping shuru karne ke liye *🛍️ PRODUCTS* dabayein!',
    insufficient_funds:
      '⚠️ *KAM BALANCE*\n\nAap ko `{required} USDT` chahiye magar dastiyab `{available} USDT` hain. Funds add karein.',
    giveaways_header: '🎁 *DYNAMIC GIVEAWAYS*\n\n',
    giveaways_empty:
      '🎁 *GIVEAWAYS*\n\nAbhi koi giveaway active nahi hai. Jald wapas check karein!',
    referral_title:
      '👥 *REFER & EARN PROGRAM*\n\nApna link doston ke sath share karein. Jab woh apna pehla order karein ge to aap rewards ke haqdar hon ge!\n\n🔗 *Aap Ka Referral Link:*\n`{link}`\n\n📊 *Aap Ke Stats:*\n• Total Invited: `{total}`\n• Qualified: `{qualified}`\n• Pending: `{pending}`',
    support_prompt:
      '🎧 *CUSTOMER SUPPORT TICKET*\n\nApna sawal ya masla likhein (Order ID zaroor likhein agar ho):',
    support_created:
      '✅ *TICKET BAN GAYA (#{ticketId})*\n\nHamari team ko aap ka message mil gaya hai, jald jawab mile ga.',
    profile_header:
      '👤 *CUSTOMER PROFILE*\n\n• Telegram ID: `{userId}`\n• Wallet Balance: `{balance} USDT`\n• Qualified Referrals: `{qualified}`\n• Language: *{langLabel}*\n\n_XERO KHAN Ledger Security se mehfooz._',
    language_select:
      '🌐 *ZUBAN CHUNEN / SELECT LANGUAGE*\n\nApni pasandeeda zuban chunen:',
    language_updated: '✅ Zuban *Roman Urdu* mein tabdeel kar di gayi hai.',
    stale_menu:
      '🔄 *MENU UPDATE HO GAYA*\n\nYeh purana menu hai. Neeche se naya menu kholein:',
    confirm_purchase:
      '🛒 *KHARIDARI CONFIRM KAREIN*\n\n• Product: *{name}*\n• Quantity: `{qty}`\n• Unit Price: `{unitPrice} USDT`\n• Total: `{totalPrice} USDT`\n• Aap Ka Wallet: `{balance} USDT`\n\nOrder mukammal karne ke liye confirm karein:',
    menu_products: '🛍️ PRODUCTS',
    menu_featured: '🔥 FEATURED',
    menu_search: '🔎 SEARCH',
    menu_wallet: '💳 WALLET',
    menu_add_funds: '➕ ADD FUNDS',
    menu_orders: '📦 MY ORDERS',
    menu_giveaways: '🎁 GIVEAWAYS',
    menu_referral: '👥 REFER & EARN',
    menu_support: '🎧 SUPPORT',
    menu_profile: '👤 PROFILE',
    menu_language: '🌐 ZUBAN',
    btn_back: '⬅️ WAPAS',
    btn_home: '🏠 HOME',
    btn_buy: '🛒 KHAREEDEIN',
    btn_details: '📋 DETAILS',
    btn_confirm: '✅ CONFIRM',
    btn_cancel: '❌ CANCEL',
  },
};

export function t(key: string, lang: SupportedLanguage = 'en', params: Record<string, string | number> = {}): string {
  const dict = translations[lang] || translations.en;
  let text = dict[key] || translations.en[key] || key;
  for (const [k, v] of Object.entries(params)) {
    text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return text;
}
