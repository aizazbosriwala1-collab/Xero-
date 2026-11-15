import { db } from '../db/index.js';
import { redis } from './redis.js';

export type SupportedLanguage = 'en' | 'ur' | 'ur-ro';

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = ['en', 'ur', 'ur-ro'];

export function resolveLanguage(lang?: string | null): SupportedLanguage {
  if (!lang) return 'en';
  const norm = lang.trim().toLowerCase();
  if (norm === 'ur' || norm === 'urdu') return 'ur';
  if (norm === 'ur-ro' || norm === 'roman' || norm === 'roman-urdu') return 'ur-ro';
  return 'en';
}

export async function invalidateUserLanguageCache(userId: string): Promise<void> {
  try {
    await redis.del(`userlang:${userId}`);
  } catch {
    // Non-fatal
  }
}

export async function getUserLanguage(userId: string): Promise<SupportedLanguage> {
  try {
    const cached = await redis.getHot(`userlang:${userId}`, 4000);
    if (cached) {
      return resolveLanguage(cached);
    }
  } catch {
    // Safe fallback to PostgreSQL
  }

  try {
    const profile = await db.queryRow<{ preferred_language?: string }>(
      'SELECT preferred_language FROM user_profiles WHERE user_id = $1',
      [userId]
    );
    if (profile?.preferred_language) {
      const lang = resolveLanguage(profile.preferred_language);
      await redis.set(`userlang:${userId}`, lang, 300).catch(() => {});
      return lang;
    }
    const user = await db.queryRow<{ language_code?: string }>(
      'SELECT language_code FROM users WHERE id = $1',
      [userId]
    );
    const lang = resolveLanguage(user?.language_code);
    await redis.set(`userlang:${userId}`, lang, 300).catch(() => {});
    return lang;
  } catch {
    return 'en';
  }
}

export const translations: Record<SupportedLanguage, Record<string, string>> = {
  en: {
    welcome: '👋 *Welcome to Master Xero*\n\nPremium Digital Marketplace',
    menu_ready: '⚡ *Master Xero Ready*\nTap *☰ MENU* anytime to open the store.',
    categories_header: '🛍 *Products*\n\nSelect a category:',
    featured_header: '🔥 *Featured Tools* (Page {page} of {totalPages})',
    featured_empty: '🔥 *Featured Tools*\n\nNo featured items right now. Browse all products below.',
    search_prompt: '🔎 *Search*\n\nType a product name or keyword (e.g. ChatGPT, Canva, Netflix):',
    search_results: '🔎 *Results for "{query}"*\n\nFound *{total}* items (Page {page}/{totalPages}):',
    search_empty: '🔎 *No Results*\n\nNothing matched `"{query}"`. Try another keyword or browse categories.',
    wallet_info: '💳 *Wallet*\n\n💰 *Balance:* `{balance} USDT`\n🔒 *Locked:* `{locked} USDT`',
    wallet_history_header: '📜 *Transactions*\n\n',
    wallet_history_empty: '📜 *Transactions*\n\nNo transactions yet.',
    choose_payment: '➕ *Add Funds*\n\nChoose a payment method:',
    binance_desc: '⚡ *Binance Pay USDT*\n\nInstant Order ID verification. No screenshot needed.',
    manual_desc: '📱 *Local Mobile Payment*\n\nVerified within 5–30 minutes.',
    order_success:
      '🎉 *Order Completed*\n\nOrder `{orderId}` delivered successfully.\n\n*Credentials / Details:*',
    orders_hub: '📦 *Orders*\n\n• Active: `{activeCount}`\n• Completed: `{historyCount}`',
    orders_header: '📜 *Order History*\n\n',
    orders_empty: '📦 *Orders*\n\nNo orders yet. Tap *🛍 Products* to get started.',
    orders_active_header: '📦 *Active Orders*\n\n',
    orders_active_empty: '📦 *Active Orders*\n\nNo active orders right now.',
    orders_history_header: '📜 *Order History*\n\n',
    orders_history_empty: '📜 *Order History*\n\nNo past orders yet.',
    free_stuff_header:
      '🎁 *Get Free Stuff*\n\nInvite friends, join giveaways, and claim milestone rewards.',
    rewards_header: '🏆 *Rewards*\n\nQualified Referrals: `{qualified}`\n',
    rewards_empty: '🏆 *Rewards*\n\nNo referral reward tiers are active right now. Invite friends or check giveaways!',
    insufficient_funds:
      '⚠️ *Insufficient Funds*\n\nRequired: `{required} USDT`\nAvailable: `{available} USDT`\n\nTap *➕ Add Funds* to top up.',
    giveaways_header: '🎁 *Giveaways*\n\n',
    giveaways_empty: '🎁 *Giveaways*\n\nNo active giveaways right now. Check back soon!',
    referral_title:
      '👥 *Invite Friends*\n\nShare your personal link to unlock rewards.\n\n🔗 *Link:*\n`{link}`\n\n• Total Invited: `{total}`\n• Qualified: `{qualified}`\n• Pending: `{pending}`',
    support_hub: '🎧 *Support*\n\nHow can we help you today?',
    support_prompt:
      '💬 *Contact Support*\n\nSend your question or Order ID below and our team will reply shortly:',
    support_created:
      '✅ *Ticket Created (#{ticketId})*\n\nSupport has received your message and will reply shortly.',
    support_faq:
      '❓ *FAQ — Master Xero*\n\n' +
      '• *Delivery:* Most digital tools deliver instantly after checkout.\n' +
      '• *Add Funds:* Instant via Binance Pay USDT, or manual PKR via Easypaisa / JazzCash.\n' +
      '• *Orders:* Check *📦 Orders → Active Orders* for processing items or *Order History* for saved credentials.\n' +
      '• *Need Help?* Tap *💬 Contact Support* and include your Order ID.',
    profile_header:
      '👤 *Account*\n\n• ID: `{userId}`\n• Balance: `{balance} USDT`\n• Qualified Referrals: `{qualified}`\n• Language: *{langLabel}*',
    language_select: '🌐 *Select Language*\n\nChoose your preferred language:',
    language_updated: '✅ Language updated to *English*.',
    stale_menu: '🔄 *Menu Updated*\n\nOpen a fresh menu below:',
    confirm_purchase:
      '🛒 *Confirm Purchase*\n\n• Product: *{name}*\n• Quantity: `{qty}`\n• Price: `{unitPrice} USDT`\n• Total: `{totalPrice} USDT`\n• Balance: `{balance} USDT`',
    menu_products: '🛍 Products',
    menu_featured: '🔥 Featured',
    menu_search: '🔎 Search',
    menu_wallet: '💳 Wallet',
    menu_add_funds: '➕ Add Funds',
    menu_orders: '📦 Orders',
    menu_free_stuff: '🎁 Get Free Stuff',
    menu_giveaways: '🎁 Giveaways',
    menu_referral: '👥 Invite Friends',
    menu_rewards: '🏆 Rewards',
    menu_support: '🎧 Support',
    menu_profile: '👤 Profile',
    menu_language: '🌐 Language',
    input_placeholder: 'Choose an option or type a message…',
    api_info:
      '🔌 *Reseller API Access*\n\nAutomated API integration is available for verified partners.\n\nContact Support for onboarding.',
    btn_back: '⬅️ Back',
    btn_home: '🏠 Home',
    btn_buy: '🛒 Buy Now',
    btn_details: '📋 Details',
    btn_confirm: '✅ Confirm',
    btn_cancel: '❌ Cancel',
  },
  ur: {
    welcome: '👋 *ماسٹر زیرو میں خوش آمدید*\n\nپریمیم ڈیجیٹل مارکیٹ پلیس',
    menu_ready: '⚡ *ماسٹر زیرو مینو تیار ہے*\nکسی بھی وقت *☰ MENU* دبائیں۔',
    categories_header: '🛍 *پروڈکٹس*\n\nکیٹیگری منتخب کریں:',
    featured_header: '🔥 *نمایاں ٹولز* (صفحہ {page} از {totalPages})',
    featured_empty: '🔥 *نمایاں ٹولز*\n\nاس وقت کوئی نمایاں آئٹم نہیں۔ تمام پروڈکٹس نیچے دیکھیں۔',
    search_prompt: '🔎 *تلاش*\n\nپروڈکٹ کا نام لکھیں (مثلاً ChatGPT, Canva, Netflix):',
    search_results: '🔎 *نتائج: "{query}"*\n\n*{total}* آئٹمز ملے (صفحہ {page}/{totalPages}):',
    search_empty: '🔎 *کوئی نتیجہ نہیں*\n\n`"{query}"` کے لیے کچھ نہیں ملا۔',
    wallet_info: '💳 *والٹ*\n\n💰 *بیلنس:* `{balance} USDT`\n🔒 *لاک:* `{locked} USDT`',
    wallet_history_header: '📜 *لین دین*\n\n',
    wallet_history_empty: '📜 *لین دین*\n\nابھی کوئی لین دین موجود نہیں۔',
    choose_payment: '➕ *رقم جمع کریں*\n\nادائیگی کا طریقہ منتخب کریں:',
    binance_desc: '⚡ *بائننس پے USDT*\n\nفوری آرڈر آئی ڈی تصدیق۔ اسکرین شاٹ درکار نہیں۔',
    manual_desc: '📱 *ایزی پیسہ / جاز کیش*\n\nتصدیق 5 سے 30 منٹ میں۔',
    order_success:
      '🎉 *آرڈر مکمل*\n\nآرڈر `{orderId}` کامیابی سے ڈیلیور ہو گیا۔\n\n*اسناد / تفصیلات:*',
    orders_hub: '📦 *آرڈرز*\n\n• فعال: `{activeCount}`\n• مکمل / پچھلے: `{historyCount}`',
    orders_header: '📜 *آرڈر ہسٹری*\n\n',
    orders_empty: '📦 *آرڈرز*\n\nابھی کوئی آرڈر نہیں۔ خریداری کے لیے *🛍 پروڈکٹس* دیکھیں۔',
    orders_active_header: '📦 *فعال آرڈرز*\n\n',
    orders_active_empty: '📦 *فعال آرڈرز*\n\nاس وقت کوئی فعال آرڈر نہیں ہے۔',
    orders_history_header: '📜 *آرڈر ہسٹری*\n\n',
    orders_history_empty: '📜 *آرڈر ہسٹری*\n\nابھی کوئی پچھلا آرڈر موجود نہیں۔',
    free_stuff_header:
      '🎁 *مفت انعامات حاصل کریں*\n\nدوستوں کو مدعو کریں، گیو اوے میں شامل ہوں اور انعامات حاصل کریں۔',
    rewards_header: '🏆 *انعامات*\n\nاہل ریفرلز: `{qualified}`\n',
    rewards_empty: '🏆 *انعامات*\n\nاس وقت کوئی ریفرل انعام فعال نہیں۔ دوستوں کو مدعو کریں یا گیو اوے دیکھیں!',
    insufficient_funds:
      '⚠️ *ناکافی بیلنس*\n\nدرکار: `{required} USDT`\nدستیاب: `{available} USDT`\n\nرقم جمع کرنے کے لیے *➕ رقم جمع کریں* دبائیں۔',
    giveaways_header: '🎁 *گیو اوے*\n\n',
    giveaways_empty: '🎁 *گیو اوے*\n\nاس وقت کوئی فعال گیو اوے نہیں ہے۔',
    referral_title:
      '👥 *دوستوں کو مدعو کریں*\n\nانعامات کے لیے اپنا لنک شیئر کریں۔\n\n🔗 *لنک:*\n`{link}`\n\n• کل مدعو: `{total}`\n• اہل: `{qualified}`\n• زیر التوا: `{pending}`',
    support_hub: '🎧 *سپورٹ*\n\nہم آپ کی کیا مدد کر سکتے ہیں؟',
    support_prompt:
      '💬 *سپورٹ سے رابطہ*\n\nاپنا سوال یا آرڈر آئی ڈی لکھیں، ہماری ٹیم جلد جواب دے گی:',
    support_created:
      '✅ *ٹکٹ بن گیا (#{ticketId})*\n\nسپورٹ ٹیم کو آپ کا پیغام موصول ہو گیا ہے۔',
    support_faq:
      '❓ *عمومی سوالات — Master Xero*\n\n' +
      '• *ڈیلیوری:* زیادہ تر ڈیجیٹل ٹولز فوری ڈیلیور ہوتے ہیں۔\n' +
      '• *رقم جمع:* بائننس پے USDT فوری یا ایزی پیسہ / جاز کیش سے جمع کریں۔\n' +
      '• *آرڈرز:* فعال آرڈرز اور محفوظ اسناد *📦 آرڈرز* میں دیکھیں۔\n' +
      '• *مدد:* *💬 سپورٹ سے رابطہ* دبائیں اور آرڈر آئی ڈی شامل کریں۔',
    profile_header:
      '👤 *اکاؤنٹ*\n\n• آئی ڈی: `{userId}`\n• بیلنس: `{balance} USDT`\n• اہل ریفرلز: `{qualified}`\n• زبان: *{langLabel}*',
    language_select: '🌐 *زبان منتخب کریں*\n\nاپنی زبان منتخب کریں:',
    language_updated: '✅ زبان *اردو* میں تبدیل کر دی گئی ہے۔',
    stale_menu: '🔄 *مینو اپڈیٹ*\n\nنیا مینو نیچے سے کھولیں:',
    confirm_purchase:
      '🛒 *خریداری کی تصدیق*\n\n• پروڈکٹ: *{name}*\n• تعداد: `{qty}`\n• قیمت: `{unitPrice} USDT`\n• کل: `{totalPrice} USDT`\n• بیلنس: `{balance} USDT`',
    menu_products: '🛍 پروڈکٹس',
    menu_featured: '🔥 نمایاں',
    menu_search: '🔎 تلاش',
    menu_wallet: '💳 والٹ',
    menu_add_funds: '➕ رقم جمع کریں',
    menu_orders: '📦 آرڈرز',
    menu_free_stuff: '🎁 مفت انعامات',
    menu_giveaways: '🎁 گیو اوے',
    menu_referral: '👥 دوستوں کو مدعو کریں',
    menu_rewards: '🏆 انعامات',
    menu_support: '🎧 سپورٹ',
    menu_profile: '👤 پروفائل',
    menu_language: '🌐 زبان',
    input_placeholder: 'کوئی آپشن منتخب کریں یا پیغام لکھیں…',
    api_info:
      '🔌 *ری سیلر API رسائی*\n\nتصدیق شدہ پارٹنرز کے لیے API دستیاب ہے۔ سپورٹ سے رابطہ کریں۔',
    btn_back: '⬅️ واپس',
    btn_home: '🏠 ہوم',
    btn_buy: '🛒 خریدیں',
    btn_details: '📋 تفصیلات',
    btn_confirm: '✅ تصدیق',
    btn_cancel: '❌ منسوخ',
  },
  'ur-ro': {
    welcome: '👋 *Master Xero Mein Khushamdeed*\n\nPremium Digital Marketplace',
    menu_ready: '⚡ *Master Xero Ready*\nStore kholne ke liye *☰ MENU* dabayein.',
    categories_header: '🛍 *Products*\n\nCategory chunen:',
    featured_header: '🔥 *Featured Tools* (Page {page}/{totalPages})',
    featured_empty: '🔥 *Featured Tools*\n\nAbhi koi featured item nahi hai. Neeche sab products dekhein.',
    search_prompt: '🔎 *Search*\n\nProduct ka naam likhein (jaise ChatGPT, Canva, Netflix):',
    search_results: '🔎 *Results: "{query}"*\n\n*{total}* items mile (Page {page}/{totalPages}):',
    search_empty: '🔎 *Koi Result Nahi*\n\n`"{query}"` se koi item match nahi hua.',
    wallet_info: '💳 *Wallet*\n\n💰 *Balance:* `{balance} USDT`\n🔒 *Locked:* `{locked} USDT`',
    wallet_history_header: '📜 *Transactions*\n\n',
    wallet_history_empty: '📜 *Transactions*\n\nAbhi koi transaction nahi hai.',
    choose_payment: '➕ *Add Funds*\n\nPayment method chunen:',
    binance_desc: '⚡ *Binance Pay USDT*\n\nForan Order ID verification. Screenshot zaroori nahi.',
    manual_desc: '📱 *Easypaisa / JazzCash*\n\nVerification 5–30 minutes mein.',
    order_success:
      '🎉 *Order Completed*\n\nOrder `{orderId}` deliver ho gaya hai.\n\n*Credentials / Details:*',
    orders_hub: '📦 *Orders*\n\n• Active: `{activeCount}`\n• Completed: `{historyCount}`',
    orders_header: '📜 *Order History*\n\n',
    orders_empty: '📦 *Orders*\n\nAbhi koi order nahi hai. *🛍 Products* dekhein.',
    orders_active_header: '📦 *Active Orders*\n\n',
    orders_active_empty: '📦 *Active Orders*\n\nAbhi koi active order nahi hai.',
    orders_history_header: '📜 *Order History*\n\n',
    orders_history_empty: '📜 *Order History*\n\nAbhi koi purana order nahi hai.',
    free_stuff_header:
      '🎁 *Get Free Stuff*\n\nDoston ko invite karein, giveaways join karein aur rewards hasil karein.',
    rewards_header: '🏆 *Rewards*\n\nQualified Referrals: `{qualified}`\n',
    rewards_empty: '🏆 *Rewards*\n\nAbhi koi reward tier active nahi hai.',
    insufficient_funds:
      '⚠️ *Kam Balance*\n\nRequired: `{required} USDT`\nAvailable: `{available} USDT`\n\nTop up ke liye *➕ Add Funds* dabayein.',
    giveaways_header: '🎁 *Giveaways*\n\n',
    giveaways_empty: '🎁 *Giveaways*\n\nAbhi koi giveaway active nahi hai.',
    referral_title:
      '👥 *Invite Friends*\n\nRewards ke liye apna link share karein.\n\n🔗 *Link:*\n`{link}`\n\n• Total Invited: `{total}`\n• Qualified: `{qualified}`\n• Pending: `{pending}`',
    support_hub: '🎧 *Support*\n\nHum aap ki kya madad kar sakte hain?',
    support_prompt:
      '💬 *Contact Support*\n\nApna sawal ya Order ID likhein, team jald jawab degi:',
    support_created:
      '✅ *Ticket Ban Gaya (#{ticketId})*\n\nSupport team ko aap ka message mil gaya hai.',
    support_faq:
      '❓ *FAQ — Master Xero*\n\n' +
      '• *Delivery:* Zyada tar digital tools foran deliver hote hain.\n' +
      '• *Add Funds:* Binance Pay USDT foran ya Easypaisa / JazzCash se.\n' +
      '• *Orders:* Active aur purane orders *📦 Orders* mein dekhein.\n' +
      '• *Help:* *💬 Contact Support* dabayein aur Order ID likhein.',
    profile_header:
      '👤 *Account*\n\n• ID: `{userId}`\n• Balance: `{balance} USDT`\n• Qualified Referrals: `{qualified}`\n• Language: *{langLabel}*',
    language_select: '🌐 *Zuban Chunen*\n\nApni zuban chunen:',
    language_updated: '✅ Zuban *Roman Urdu* mein tabdeel ho gayi hai.',
    stale_menu: '🔄 *Menu Updated*\n\nNaya menu neeche se kholein:',
    confirm_purchase:
      '🛒 *Confirm Purchase*\n\n• Product: *{name}*\n• Qty: `{qty}`\n• Price: `{unitPrice} USDT`\n• Total: `{totalPrice} USDT`\n• Balance: `{balance} USDT`',
    menu_products: '🛍 Products',
    menu_featured: '🔥 Featured',
    menu_search: '🔎 Search',
    menu_wallet: '💳 Wallet',
    menu_add_funds: '➕ Add Funds',
    menu_orders: '📦 Orders',
    menu_free_stuff: '🎁 Get Free Stuff',
    menu_giveaways: '🎁 Giveaways',
    menu_referral: '👥 Invite Friends',
    menu_rewards: '🏆 Rewards',
    menu_support: '🎧 Support',
    menu_profile: '👤 Profile',
    menu_language: '🌐 Zuban',
    input_placeholder: 'Option chunen ya message likhein…',
    api_info:
      '🔌 *Reseller API Access*\n\nVerified partners ke liye API dastiyab hai. Support se rabta karein.',
    btn_back: '⬅️ Wapas',
    btn_home: '🏠 Home',
    btn_buy: '🛒 Khareedein',
    btn_details: '📋 Details',
    btn_confirm: '✅ Confirm',
    btn_cancel: '❌ Cancel',
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
