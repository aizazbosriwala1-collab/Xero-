import Decimal from 'decimal.js';
import { db } from '../../db/index.js';
import { redis } from '../../services/redis.js';
import { walletService } from '../../services/wallet.js';
import { pricingService } from '../../services/pricing.js';
import { manualPaymentService } from '../../services/manualPayment.js';
import { binanceService, BinanceVerificationResult, maskIdentifier } from '../../services/binance.js';
import { orderService } from '../../services/order.js';
import { referralService } from '../../services/referral.js';
import { giveawayService } from '../../services/giveaway.js';
import { supportService } from '../../services/support.js';
import { uiConfigService } from '../../services/uiConfig.js';
import { navigationService } from '../../services/navigation.js';
import { t, SupportedLanguage, resolveLanguage, getUserLanguage, invalidateUserLanguageCache } from '../../services/i18n.js';
import { config } from '../../config/env.js';
import {
  getCustomerMainInlineKeyboard,
  getCustomerMainReplyKeyboard,
  getCategoryKeyboard,
  getProductListKeyboard,
  getProductDetailKeyboard,
  getPurchaseConfirmKeyboard,
  getMoreDetailsKeyboard,
  getWalletKeyboard,
  getDepositMethodsKeyboard,
  getBinanceInvoiceKeyboard,
  getPaymentBeforeInvoiceKeyboard,
  getLanguageKeyboard,
  getBackHomeKeyboard,
  getStaleMenuKeyboard,
} from '../keyboards.js';
import { ButtonBuilder } from '../buttonBuilder.js';
import { telegramClient } from '../client.js';
import { TelegramMessage, TelegramCallbackQuery, UserFsmState } from '../types.js';
import { createLogger } from '../../services/logger.js';

const logger = createLogger('CustomerHandler');

export class CustomerHandler {
  /**
   * Ensure user exists in authoritative PostgreSQL database
   */
  public async ensureUser(from: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  }) {
    const userId = String(from.id);
    const isAdmin = config.telegram.adminIds.includes(userId);
    const normLang = resolveLanguage(from.language_code);

    await db.query(
      `INSERT INTO users (id, telegram_id, username, first_name, last_name, language_code, is_admin, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         is_admin = $7,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, from.id, from.username || null, from.first_name, from.last_name || null, normLang, isAdmin]
    );

    await db.query(
      `INSERT INTO user_profiles (user_id, preferred_language, created_at, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, normLang]
    );

    await walletService.getOrCreateWallet(userId);
    const lang = await getUserLanguage(userId);
    return { userId, isAdmin, lang };
  }

  /**
   * Handle /start command
   */
  public async handleStart(msg: TelegramMessage, referrerCode?: string) {
    if (!msg.from) return;
    const [, userInfo] = await Promise.all([uiConfigService.ensureLoaded(), this.ensureUser(msg.from)]);
    const { userId, isAdmin, lang } = userInfo;

    const [navState] = await Promise.all([
      navigationService.getState(userId),
      redis.clearFsmState(userId),
      referrerCode && referrerCode.startsWith('ref_')
        ? referralService.registerReferral(referrerCode.replace('ref_', '').trim(), userId)
        : Promise.resolve(false),
    ]);

    const welcomeText = uiConfigService.getText('msg.welcome', lang) || t('welcome', lang);

    // Send single polished welcome screen + colored inline dashboard
    const sent = await telegramClient.sendMessage(msg.chat.id, welcomeText, {
      reply_markup: getCustomerMainInlineKeyboard(isAdmin, lang),
    });

    // Attach/upgrade persistent 2-button bottom reply keyboard ([ Deposit ] [ Support ]) cleanly without duplicating home screen
    const needsReplyKbAttach = navState?.filters?.replyKbVersion !== 'v2_2btn';
    if (needsReplyKbAttach) {
      const quickBarHint =
        lang === 'ur'
          ? '⚡ فوری رسائی نیچے فعال ہے: رقم جمع کریں یا سپورٹ۔'
          : '⚡ Quick actions enabled below: Deposit or Support.';
      await telegramClient.sendMessage(msg.chat.id, quickBarHint, {
        disable_notification: true,
        reply_markup: getCustomerMainReplyKeyboard(lang),
      });
    }

    await navigationService.saveState(userId, {
      screen: 'home',
      activeMessageId: sent?.result?.message_id,
      filters: { ...(navState?.filters || {}), replyKbVersion: 'v2_2btn' },
      rotateToken: true,
    });
  }

  /**
   * Helper: Edit active menu message or send a fresh one if uneditable, updating activeMessageId.
   */
  private async renderMenu(
    chatId: number,
    messageId: number | undefined,
    userId: string,
    text: string,
    reply_markup: any
  ) {
    const res = messageId
      ? await telegramClient.editMessageText(chatId, messageId, text, { reply_markup })
      : await telegramClient.sendMessage(chatId, text, { reply_markup });

    const resolvedMsgId = res?.result?.message_id ?? messageId;
    if (resolvedMsgId) {
      await navigationService.saveState(userId, { activeMessageId: resolvedMsgId });
    }
    return res;
  }

  /**
   * Handle Customer Inline Callbacks
   */
  public async handleCallback(cb: TelegramCallbackQuery) {
    if (!cb.data) return;

    // Immediate callback acknowledgment before DB/UI lookups so Telegram stops spinner immediately
    const ackPromise =
      cb.id && cb.id !== '0'
        ? telegramClient.answerCallbackQuery(cb.id).catch(() => {})
        : Promise.resolve();

    const chatId = cb.message?.chat.id ?? cb.from.id;
    const messageId = cb.message?.message_id;
    const userId = String(cb.from.id);
    let data = cb.data;
    const isAdmin = config.telegram.adminIds.includes(userId);

    const [, lang] = await Promise.all([uiConfigService.ensureLoaded(), getUserLanguage(userId)]);

    if (data === 'noop') {
      await ackPromise;
      return;
    }

    // Stale token validation route
    if (data.startsWith('nav:')) {
      const [, token] = data.split(':');
      const check = await navigationService.validateToken(userId, token);
      if (!check.valid) {
        await this.renderMenu(chatId, messageId, userId, t('stale_menu', lang), getStaleMenuKeyboard(lang));
        await ackPromise;
        return;
      }
      data = 'm:home';
    }

    // Navigation: Home
    if (data === 'm:home') {
      await Promise.all([
        redis.clearFsmState(userId),
        navigationService.saveState(userId, { screen: 'home', categoryId: 'all', page: 1 }),
      ]);
      const welcomeText = uiConfigService.getText('msg.welcome', lang) || t('welcome', lang);
      await this.renderMenu(chatId, messageId, userId, welcomeText, getCustomerMainInlineKeyboard(isAdmin, lang));
      await ackPromise;
      return;
    }

    // Navigation: Categories Grid
    if (data === 'm:prod' || data.startsWith('catp:')) {
      const catPage = data.startsWith('catp:') ? Math.max(1, parseInt(data.split(':')[1] || '1', 10)) : 1;
      const categories = await db.query<any>(
        'SELECT id, name FROM product_categories WHERE is_visible = TRUE ORDER BY display_order ASC'
      );
      await navigationService.saveState(userId, { screen: 'categories', page: catPage });
      const text = uiConfigService.getText('msg.categories_header', lang) || t('categories_header', lang);
      await this.renderMenu(chatId, messageId, userId, text, getCategoryKeyboard(categories.rows, lang, catPage));
      return;
    }

    // Featured Products List (Paginated)
    if (data === 'm:feat' || data.startsWith('feat:')) {
      const page = data.startsWith('feat:') ? Math.max(1, parseInt(data.split(':')[1] || '1', 10)) : 1;
      const pageSize = 6;
      const catalog = await pricingService.getCatalog({ featuredOnly: true, page, pageSize });

      if (catalog.items.length === 0) {
        await this.renderMenu(
          chatId,
          messageId,
          userId,
          t('featured_empty', lang),
          {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ settingKey: 'btn.cat.all', lang, callbackData: 'cat:all:1', forceVisible: true }),
              ]),
              ButtonBuilder.buildNavigationRow('m:prod', lang),
            ],
          }
        );
        return;
      }

      const totalPages = Math.max(1, Math.ceil(catalog.total / pageSize));
      await navigationService.saveState(userId, { screen: 'featured', categoryId: 'all', page });
      await this.renderMenu(
        chatId,
        messageId,
        userId,
        t('featured_header', lang, { page, totalPages }),
        getProductListKeyboard({
          products: catalog.items.map(p => ({ id: p.id, name: p.name, sellingPrice: p.sellingPrice })),
          page,
          totalPages,
          catId: 'all',
          lang,
          paginationPrefix: 'feat',
        })
      );
      return;
    }

    // Search Pagination (using stored searchQuery)
    if (data.startsWith('srch:')) {
      const page = Math.max(1, parseInt(data.split(':')[1] || '1', 10));
      const navState = await navigationService.getState(userId);
      const query = navState?.searchQuery || '';
      if (!query) {
        await this.renderMenu(chatId, messageId, userId, t('stale_menu', lang), getStaleMenuKeyboard(lang));
        return;
      }
      await this.showSearchResults(chatId, messageId, userId, query, page, lang);
      return;
    }

    // Category / All Products Paginated List
    if (data.startsWith('cat:')) {
      const [, catId = 'all', pageStr = '1'] = data.split(':');
      const page = Math.max(1, parseInt(pageStr || '1', 10));
      const isAll = catId === 'all';
      const pageSize = 6;

      const catalog = await pricingService.getCatalog({
        categoryId: isAll ? undefined : catId,
        page,
        pageSize,
      });

      if (catalog.items.length === 0) {
        await this.renderMenu(
          chatId,
          messageId,
          userId,
          '⚠️ No in-stock products are currently available in this category. Check all products or try another category.',
          getBackHomeKeyboard('m:prod', lang)
        );
        return;
      }

      const totalPages = Math.max(1, Math.ceil(catalog.total / pageSize));
      const categoryTitle = isAll ? 'ALL PRODUCTS' : catalog.items[0]?.category.name || 'PRODUCTS';
      const listHeader =
        `⚡ *${categoryTitle.toUpperCase()}*\n\n` +
        `Browse our live inventory below. Tap any product to view details and purchase:\n` +
        `_Showing ${catalog.items.length} of ${catalog.total} items (Page ${page} of ${totalPages})_`;

      await navigationService.saveState(userId, { screen: 'catalog', categoryId: catId, page });
      await this.renderMenu(
        chatId,
        messageId,
        userId,
        listHeader,
        getProductListKeyboard({
          products: catalog.items.map(p => ({ id: p.id, name: p.name, sellingPrice: p.sellingPrice })),
          page,
          totalPages,
          catId,
          lang,
        })
      );
      return;
    }

    // Product Detail Screen
    if (data.startsWith('p:')) {
      const [, productId, catId = 'all', pageStr = '1'] = data.split(':');
      const page = Math.max(1, parseInt(pageStr || '1', 10));
      await navigationService.saveState(userId, { screen: 'product', productId, categoryId: catId, page, quantity: 1 });
      await this.showProductDetail(chatId, messageId, productId, 1, catId, page, lang);
      return;
    }

    // Quantity selector in Product Detail Screen
    if (data.startsWith('qty:')) {
      const [, productId, qtyStr, backCatId = 'all', pageStr = '1'] = data.split(':');
      const qty = Math.max(1, Math.min(50, parseInt(qtyStr || '1', 10)));
      const page = Math.max(1, parseInt(pageStr || '1', 10));
      await navigationService.saveState(userId, { productId, categoryId: backCatId, page, quantity: qty });
      await this.showProductDetail(chatId, messageId, productId, qty, backCatId, page, lang);
      return;
    }

    // Buy Now -> Confirmation or Email Prompt
    if (data.startsWith('buy:')) {
      const allowed = await navigationService.acquireActionLock(userId, `buy:${data}`, 2);
      if (!allowed) return;

      const [, productId, qtyStr] = data.split(':');
      const qty = Math.max(1, parseInt(qtyStr || '1', 10));
      const product = await db.queryRow<any>('SELECT * FROM supplier_products WHERE id = $1', [productId]);
      if (!product || !product.is_available) {
        await this.renderMenu(chatId, messageId, userId, '⚠️ This product is currently unavailable.', getBackHomeKeyboard('m:prod', lang));
        return;
      }

      if (!product.is_unlimited && product.latest_stock < qty) {
        await this.renderMenu(
          chatId,
          messageId,
          userId,
          `⚠️ Only *${product.latest_stock}* units are currently in stock.`,
          getBackHomeKeyboard(`p:${productId}:all:1`, lang)
        );
        return;
      }

      if (product.requires_email) {
        await redis.setFsmState(userId, {
          step: 'AWAITING_EMAIL_FOR_ORDER',
          data: { productId, quantity: qty },
        });
        await this.renderMenu(
          chatId,
          messageId,
          userId,
          `📧 *EMAIL REQUIRED*\n\nPlease type your delivery email address for *${product.original_name}* (Qty: ${qty}):`,
          getBackHomeKeyboard('m:prod', lang)
        );
        return;
      }

      const priceInfo = await pricingService.calculatePrice(productId);
      const totalDec = priceInfo.customerUnitPrice.times(qty);
      const { balance } = await walletService.getBalance(userId);
      const navState = await navigationService.getState(userId);
      const catId = navState?.categoryId || 'all';
      const page = navState?.page || 1;

      if (balance.lessThan(totalDec)) {
        await this.renderMenu(
          chatId,
          messageId,
          userId,
          t('insufficient_funds', lang, {
            required: totalDec.toFixed(2),
            available: balance.toFixed(2),
          }),
          {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ settingKey: 'btn.wall.add_funds', lang, callbackData: 'm:dep', forceVisible: true }),
              ]),
              ButtonBuilder.buildNavigationRow(`p:${productId}:${catId}:${page}`, lang),
            ],
          }
        );
        return;
      }

      await this.renderMenu(
        chatId,
        messageId,
        userId,
        t('confirm_purchase', lang, {
          name: product.original_name,
          qty,
          unitPrice: priceInfo.customerUnitPrice.toFixed(2),
          totalPrice: totalDec.toFixed(2),
          balance: balance.toFixed(2),
        }),
        getPurchaseConfirmKeyboard(productId, qty, catId, page, lang)
      );
      return;
    }

    // Confirmed Purchase Execution
    if (data.startsWith('buyc:')) {
      const allowed = await navigationService.acquireActionLock(userId, `buyc:${data}`, 3);
      if (!allowed) return;
      const [, productId, qtyStr] = data.split(':');
      const qty = Math.max(1, parseInt(qtyStr || '1', 10));
      await this.executePurchase(chatId, messageId, userId, productId, qty, undefined, lang);
      return;
    }

    // Product More Details
    if (data.startsWith('det:')) {
      const [, productId, catId = 'all', pageStr = '1'] = data.split(':');
      const page = Math.max(1, parseInt(pageStr || '1', 10));
      const product = await db.queryRow<any>('SELECT * FROM supplier_products WHERE id = $1', [productId]);
      if (!product) return;

      const detailsText =
        `📋 *PRODUCT DETAILS*\n\n` +
        `*${product.original_name}*\n\n` +
        `${product.original_description || 'No additional description provided.'}\n\n` +
        `⏱️ *Duration:* ${product.duration || '1 Month'}\n` +
        `🛡️ *Warranty:* ${product.warranty_summary || 'Standard replacement guarantee'}\n` +
        `🔑 *Delivery:* ${product.requires_email ? 'Manual invite / access via email' : 'Instant credentials via bot ledger'}`;

      await this.renderMenu(chatId, messageId, userId, detailsText, getMoreDetailsKeyboard(productId, catId, page, lang));
      return;
    }

    // Wallet
    if (data === 'm:wall') {
      const { balance, locked } = await walletService.getBalance(userId);
      const template = uiConfigService.getText('msg.wallet_info', lang) || t('wallet_info', lang);
      const text = template
        .replace(/\{balance\}/g, balance.toFixed(2))
        .replace(/\{locked\}/g, locked.toFixed(2));
      await navigationService.saveState(userId, { screen: 'wallet' });
      await this.renderMenu(chatId, messageId, userId, text, getWalletKeyboard(lang));
      return;
    }

    // Wallet Transaction History
    if (data === 'w:hist') {
      const entries = await walletService.getHistory(userId, 10);
      if (entries.length === 0) {
        await this.renderMenu(chatId, messageId, userId, t('wallet_history_empty', lang), getBackHomeKeyboard('m:wall', lang));
        return;
      }

      let text = t('wallet_history_header', lang);
      for (const e of entries) {
        const sign = new Decimal(e.amount).greaterThanOrEqualTo(0) ? '+' : '';
        text += `• *${e.entryType}* \`${sign}${e.amount} USDT\` — _${e.reason}_\n  Balance: \`${e.balanceAfter} USDT\`\n`;
      }
      await this.renderMenu(chatId, messageId, userId, text, getBackHomeKeyboard('m:wall', lang));
      return;
    }

    // Add Funds / Payment Methods
    if (data === 'm:dep') {
      const text = uiConfigService.getText('msg.choose_payment', lang) || t('choose_payment', lang);
      await navigationService.saveState(userId, { screen: 'deposit' });
      await this.renderMenu(chatId, messageId, userId, text, getDepositMethodsKeyboard(lang));
      return;
    }

    // Method: Binance Pay USDT
    if (data === 'dep_m:binance') {
      await redis.setFsmState(userId, { step: 'AWAITING_BINANCE_AMOUNT' });
      const prompt =
        `⚡ *BINANCE PAY USDT DEPOSIT*\n\n` +
        `Please enter the USDT amount you wish to deposit (Min: ${config.binance.minDepositUsdt} USDT, Max: ${config.binance.maxDepositUsdt} USDT):\n\n` +
        `_Example: 5.00_`;
      await this.renderMenu(chatId, messageId, userId, prompt, getBackHomeKeyboard('m:dep', lang));
      return;
    }

    // Method: Easypaisa or JazzCash
    if (data === 'dep_m:easypaisa' || data === 'dep_m:jazzcash') {
      const code = data === 'dep_m:easypaisa' ? 'EASYPAISA' : 'JAZZCASH';
      const method = await manualPaymentService.getMethodByCode(code);
      if (!method) return;

      await redis.setFsmState(userId, { step: 'AWAITING_MANUAL_AMOUNT', data: { methodCode: code } });
      const prompt =
        `📱 *${method.name}*\n\n` +
        `Account Title: \`${method.accountTitle}\`\n` +
        `Account Number: \`${method.accountNumber}\`\n\n` +
        `Instructions: ${method.instructions}\n\n` +
        `Please enter the amount you wish to deposit in USDT equivalent (Min: ${method.minAmount}, Max: ${method.maxAmount}):`;

      await this.renderMenu(chatId, messageId, userId, prompt, getBackHomeKeyboard('m:dep', lang));
      return;
    }

    // Binance: Submit Order ID
    if (data.startsWith('bin_tx:')) {
      const [, depositId] = data.split(':');
      await redis.setFsmState(userId, { step: 'AWAITING_BINANCE_TXID', data: { depositId } });
      const prompt =
        `🔎 *SUBMIT BINANCE ORDER ID*\n\n` +
        `Please paste the Binance *Order ID* from your completed Binance Pay transfer.\n\n` +
        `Where to find it in Binance:\n` +
        `1. Open Binance App → Pay → History\n` +
        `2. Open Payment Details for the transfer you just sent\n` +
        `3. Copy the *Order ID*\n\n` +
        `⚠️ Your Binance payment must be sent *after* creating this invoice.\n` +
        `_Official API Transaction IDs are also accepted for compatibility._\n\n` +
        `_Do NOT submit the invoice ID, receiver Binance ID, Binance account ID, Telegram user ID, or an Order ID from an earlier payment._`;

      await telegramClient.sendMessage(chatId, prompt, {
        reply_markup: getBackHomeKeyboard('m:dep', lang),
      });
      await ackPromise;
      return;
    }

    // Binance: Contact Support pre-seeded from pre-invoice / deposit notice
    if (data.startsWith('bin_sup:')) {
      const [, depositId] = data.split(':');
      await redis.setFsmState(userId, {
        step: 'AWAITING_SUPPORT_MESSAGE',
        data: { contextType: 'BINANCE_PRE_INVOICE', depositId },
      });
      const prompt =
        `🎧 *BINANCE DEPOSIT SUPPORT*\n\n` +
        `If you sent a Binance Pay payment before creating your invoice, please describe what happened (for example: approximate time and USDT amount sent).\n\n` +
        `Our support team will review and assist you promptly:`;
      await telegramClient.sendMessage(chatId, prompt, {
        reply_markup: getBackHomeKeyboard('m:dep', lang),
      });
      await ackPromise;
      return;
    }

    // Binance: Retry Verification with last submitted Order ID / TXID
    if (data.startsWith('bin_r:')) {
      const [, depositId] = data.split(':');
      const allowed = await navigationService.acquireActionLock(userId, `bin_r:${depositId}`, 3);
      if (!allowed) {
        await ackPromise;
        return;
      }

      const lastTx = await redis.get(`bin_last_tx:${userId}:${depositId}`).catch(() => null);
      if (!lastTx) {
        await redis.setFsmState(userId, { step: 'AWAITING_BINANCE_TXID', data: { depositId } });
        await telegramClient.sendMessage(
          chatId,
          '🔎 Please paste your Binance *Order ID* again to retry verification:',
          { reply_markup: getBackHomeKeyboard('m:dep', lang) }
        );
        await ackPromise;
        return;
      }

      await this.executeBinanceTxVerification(chatId, userId, depositId, lastTx, lang);
      await ackPromise;
      return;
    }

    // My Orders
    if (data === 'm:ord') {
      const orders = await orderService.getCustomerOrders(userId, 5);
      if (orders.length === 0) {
        await this.renderMenu(chatId, messageId, userId, t('orders_empty', lang), getBackHomeKeyboard('m:home', lang));
        return;
      }

      let text = t('orders_header', lang);
      for (const ord of orders) {
        text +=
          `🔹 *Order:* \`${ord.id}\`\n` +
          `• Item: ${ord.productName} (x${ord.quantity})\n` +
          `• Total: \`${ord.totalPrice} USDT\`\n` +
          `• Status: *${ord.status}*\n`;
        if (ord.deliveredItems.length > 0) {
          text += `• Credentials: \`${ord.deliveredItems[0]}\`\n`;
        }
        text += '\n';
      }

      await this.renderMenu(chatId, messageId, userId, text, getBackHomeKeyboard('m:home', lang));
      return;
    }

    // Giveaways
    if (data === 'm:give') {
      const giveaways = await giveawayService.getActiveGiveaways(userId);
      if (giveaways.length === 0) {
        await this.renderMenu(chatId, messageId, userId, t('giveaways_empty', lang), getBackHomeKeyboard('m:home', lang));
        return;
      }

      let text = t('giveaways_header', lang);
      const rows: any[][] = [];
      for (const gw of giveaways) {
        const prog = gw.userProgress;
        text +=
          `🏆 *${gw.title}*\n` +
          `• Reward: ${gw.rewardProductName} (x${gw.rewardQuantity})\n` +
          `• Requirement: ${gw.requiredQualifiedReferrals} Qualified Referrals\n`;
        if (prog) {
          text +=
            `• Your Progress: *${prog.currentQualified} / ${prog.required}*\n` +
            `• Status: ${prog.hasClaimed ? '✅ CLAIMED' : prog.isEligible ? '🌟 ELIGIBLE TO CLAIM' : '⏳ In Progress'}\n\n`;

          if (prog.isEligible && !prog.hasClaimed) {
            rows.push(
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({
                  settingKey: 'btn.give.claim',
                  lang,
                  suffix: `: ${gw.title.slice(0, 20)}`,
                  callbackData: `gw_cl:${gw.id}`,
                  forceVisible: true,
                }),
              ])
            );
          }
        }
      }

      rows.push(ButtonBuilder.buildNavigationRow('m:home', lang));
      await this.renderMenu(chatId, messageId, userId, text, { inline_keyboard: rows.filter(r => r.length > 0) });
      return;
    }

    // Claim Giveaway
    if (data.startsWith('gw_cl:')) {
      const allowed = await navigationService.acquireActionLock(userId, `gw:${data}`, 3);
      if (!allowed) return;
      const [, giveawayId] = data.split(':');
      try {
        const res = await giveawayService.claimGiveaway(giveawayId, userId);
        await telegramClient.sendMessage(chatId, `🎉 ${res.message}`, {
          reply_markup: getBackHomeKeyboard('m:give', lang),
        });
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ ${err.message}`, {
          reply_markup: getBackHomeKeyboard('m:give', lang),
        });
      }
      return;
    }

    // Refer & Earn
    if (data === 'm:ref') {
      const stats = await referralService.getStats(userId);
      const template = uiConfigService.getText('msg.referral_title', lang) || t('referral_title', lang);
      const text = template
        .replace(/\{link\}/g, stats.referralLink)
        .replace(/\{total\}/g, String(stats.totalReferred))
        .replace(/\{qualified\}/g, String(stats.qualifiedCount))
        .replace(/\{pending\}/g, String(stats.pendingCount));
      await this.renderMenu(chatId, messageId, userId, text, getBackHomeKeyboard('m:home', lang));
      return;
    }

    // Search
    if (data === 'm:srch') {
      await redis.setFsmState(userId, { step: 'AWAITING_SEARCH_QUERY' });
      await this.renderMenu(chatId, messageId, userId, t('search_prompt', lang), getBackHomeKeyboard('m:home', lang));
      return;
    }

    // Support
    if (data === 'm:supp') {
      await redis.setFsmState(userId, { step: 'AWAITING_SUPPORT_MESSAGE' });
      const text = uiConfigService.getText('msg.support_prompt', lang) || t('support_prompt', lang);
      await this.renderMenu(chatId, messageId, userId, text, getBackHomeKeyboard('m:home', lang));
      return;
    }

    // Profile
    if (data === 'm:prof') {
      const [{ balance }, stats] = await Promise.all([
        walletService.getBalance(userId),
        referralService.getStats(userId),
      ]);
      const langLabel = lang === 'ur' ? 'اردو' : lang === 'ur-ro' ? 'Roman Urdu' : 'English';
      const template = uiConfigService.getText('msg.profile_header', lang) || t('profile_header', lang);
      const text = template
        .replace(/\{userId\}/g, userId)
        .replace(/\{balance\}/g, balance.toFixed(2))
        .replace(/\{qualified\}/g, String(stats.qualifiedCount))
        .replace(/\{langLabel\}/g, langLabel);
      await this.renderMenu(chatId, messageId, userId, text, getBackHomeKeyboard('m:home', lang));
      await ackPromise;
      return;
    }

    // Reseller API info
    if (data === 'm:api') {
      await this.renderMenu(chatId, messageId, userId, t('api_info', lang), getBackHomeKeyboard('m:home', lang));
      await ackPromise;
      return;
    }

    // Language Selection Menu
    if (data === 'm:lang') {
      const text = uiConfigService.getText('msg.language_select', lang) || t('language_select', lang);
      await this.renderMenu(chatId, messageId, userId, text, getLanguageKeyboard(lang));
      await ackPromise;
      return;
    }

    // Apply Language Selection & Immediately Refresh Menu + Localized Bottom Bar
    if (data.startsWith('lang:')) {
      const selected = resolveLanguage(data.split(':')[1]);
      await Promise.all([
        db.query('UPDATE users SET language_code = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [selected, userId]),
        db.query(
          `INSERT INTO user_profiles (user_id, preferred_language, created_at, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id) DO UPDATE SET preferred_language = $2, updated_at = CURRENT_TIMESTAMP`,
          [userId, selected]
        ),
      ]);
      await invalidateUserLanguageCache(userId);
      await telegramClient.sendMessage(chatId, t('language_updated', selected), {
        disable_notification: true,
        reply_markup: getCustomerMainReplyKeyboard(selected),
      });
      const existingNav = await navigationService.getState(userId);
      await navigationService.saveState(userId, {
        filters: { ...(existingNav?.filters || {}), replyKbVersion: 'v2_2btn' },
      });
      const welcomeText = uiConfigService.getText('msg.welcome', selected) || t('welcome', selected);
      await this.renderMenu(chatId, messageId, userId, welcomeText, getCustomerMainInlineKeyboard(isAdmin, selected));
      await ackPromise;
      return;
    }

    // Unrecognized / expired callback safe recovery
    await this.renderMenu(chatId, messageId, userId, t('stale_menu', lang), getStaleMenuKeyboard(lang));
    await ackPromise;
  }

  /**
   * Handle text messages according to active FSM State and persistent/legacy reply keyboard
   */
  public async handleTextMessage(msg: TelegramMessage) {
    if (!msg.from || !msg.text) return;

    const userId = String(msg.from.id);
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const norm = text.toLowerCase();
    const isAdmin = config.telegram.adminIds.includes(userId);

    const [, lang] = await Promise.all([uiConfigService.ensureLoaded(), getUserLanguage(userId)]);

    const depBtnText = ButtonBuilder.buildReplyButton({ settingKey: 'btn.reply.deposit', lang }).text.trim().toLowerCase();
    const supBtnText = ButtonBuilder.buildReplyButton({ settingKey: 'btn.reply.support', lang }).text.trim().toLowerCase();

    // Persistent 2-button bottom bar: Deposit & Support (plus legacy variants)
    if (
      norm === depBtnText ||
      norm === '➕ deposit' ||
      norm === 'deposit' ||
      norm === '➕ add funds' ||
      norm === 'add funds' ||
      norm === '➕ جمع کریں'
    ) {
      await redis.clearFsmState(userId);
      return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:dep' });
    }

    if (
      norm === supBtnText ||
      norm === '🎧 support' ||
      norm === 'support' ||
      norm === '🛟 support' ||
      norm === '🎧 سپورٹ'
    ) {
      await redis.clearFsmState(userId);
      return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:supp' });
    }

    // Backward-compatible legacy reply keyboard button triggers (☰ MENU, Products, Shop, etc.)
    if (norm === '☰ menu' || norm === '☰ مینو' || norm === 'menu' || norm === '/menu') {
      await redis.clearFsmState(userId);
      const welcomeText = uiConfigService.getText('msg.welcome', lang) || t('welcome', lang);
      const sent = await telegramClient.sendMessage(chatId, welcomeText, {
        reply_markup: getCustomerMainInlineKeyboard(isAdmin, lang),
      });
      await navigationService.saveState(userId, {
        screen: 'home',
        activeMessageId: sent?.result?.message_id,
      });
      return;
    }

    if (norm === '🛍️ products' || norm === 'products' || norm === 'shop' || norm === '🛍️ پروڈکٹس') {
      return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:prod' });
    }
    if (norm === '🔥 featured') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:feat' });
    if (norm === '🔎 search') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:srch' });
    if (norm === '💰 wallet' || norm === '💳 wallet') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:wall' });
    if (norm === '📦 my orders') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:ord' });
    if (norm === '🎁 giveaways') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:give' });
    if (norm === '👥 refer & earn') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:ref' });
    if (norm === '👤 profile') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:prof' });
    if (norm === '🌐 language') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:lang' });

    const fsm = await redis.getFsmState<UserFsmState>(userId);
    if (!fsm) return;

    // Delegate Admin FSM steps securely to AdminHandler
    if (fsm.step.startsWith('ADMIN_')) {
      const { adminHandler } = await import('./admin.js');
      await adminHandler.handleAdminTextInput(msg, fsm);
      return;
    }

    // FSM: Search Query
    if (fsm.step === 'AWAITING_SEARCH_QUERY') {
      await redis.clearFsmState(userId);
      await navigationService.saveState(userId, { screen: 'search', searchQuery: text, page: 1 });
      await this.showSearchResults(chatId, undefined, userId, text, 1, lang);
      return;
    }

    // FSM: Awaiting Email for Order
    if (fsm.step === 'AWAITING_EMAIL_FOR_ORDER') {
      const { productId, quantity } = fsm.data || {};
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        await telegramClient.sendMessage(chatId, '⚠️ Please provide a valid email format (e.g. name@example.com):');
        return;
      }
      await redis.clearFsmState(userId);
      await this.executePurchase(chatId, undefined, userId, productId, quantity, text, lang);
      return;
    }

    // FSM: Binance Deposit Amount
    if (fsm.step === 'AWAITING_BINANCE_AMOUNT') {
      let amountDec: Decimal;
      try {
        amountDec = new Decimal(text);
      } catch {
        await telegramClient.sendMessage(chatId, '⚠️ Please enter a valid numeric USDT amount (e.g. 5.00):');
        return;
      }
      if (amountDec.isNaN() || amountDec.lessThan(config.binance.minDepositUsdt)) {
        await telegramClient.sendMessage(
          chatId,
          `⚠️ Minimum Binance deposit is ${config.binance.minDepositUsdt} USDT. Please enter a valid number:`
        );
        return;
      }

      await redis.clearFsmState(userId);
      const invoice = await binanceService.createInvoice(userId, amountDec);
      const receiverId = invoice.receiverRef || config.binance.receiverId || '';

      const invoiceMsg =
        `⚡ *BINANCE PAY INVOICE*\n\n` +
        `💵 *Exact Amount:*\n\`${invoice.amount} USDT\`\n\n` +
        `📋 *Send To Binance ID:*\n\`${receiverId}\`\n\n` +
        `_Long-press the Binance ID above to copy it._\n\n` +
        `⏳ *Expires In:* 60 minutes\n\n` +
        `1. Open Binance App → Pay → Send\n` +
        `2. Copy the Binance ID above\n` +
        `3. Send the exact displayed USDT amount *after* creating this invoice\n` +
        `4. Open Binance Pay → History → Payment Details and copy the *Order ID*\n` +
        `5. Tap *🔎 SUBMIT ORDER ID* below`;

      await telegramClient.sendMessage(chatId, invoiceMsg, {
        reply_markup: getBinanceInvoiceKeyboard(invoice.id, lang),
      });
      return;
    }

    // FSM: Binance TXID
    if (fsm.step === 'AWAITING_BINANCE_TXID') {
      const depositId = String(fsm.data?.depositId || '');
      await redis.clearFsmState(userId);
      await this.executeBinanceTxVerification(chatId, userId, depositId, text, lang);
      return;
    }

    // FSM: Manual Payment Amount
    if (fsm.step === 'AWAITING_MANUAL_AMOUNT') {
      const methodCode = fsm.data?.methodCode;
      let amountDec: Decimal;
      try {
        amountDec = new Decimal(text);
      } catch {
        await telegramClient.sendMessage(chatId, '⚠️ Please enter a valid numeric amount (e.g. 5.00):');
        return;
      }
      if (amountDec.isNaN() || amountDec.lessThan(0.5)) {
        await telegramClient.sendMessage(chatId, '⚠️ Please enter a valid amount (e.g. 5.00):');
        return;
      }

      await redis.setFsmState(userId, {
        step: 'AWAITING_MANUAL_TXID',
        data: { methodCode, amount: amountDec.toFixed(4) },
      });

      await telegramClient.sendMessage(
        chatId,
        `📱 Amount: *${amountDec.toFixed(2)} USDT*\n\nPlease enter the Transaction ID (TRX ID / TID) of your completed payment:`
      );
      return;
    }

    // FSM: Manual Payment TXID
    if (fsm.step === 'AWAITING_MANUAL_TXID') {
      const { methodCode, amount } = fsm.data || {};
      await redis.setFsmState(userId, {
        step: 'AWAITING_MANUAL_PROOF',
        data: { methodCode, amount, txid: text },
      });
      await telegramClient.sendMessage(chatId, '📸 *PROOF REQUIRED*\n\nPlease upload or send a screenshot image of your payment receipt:');
      return;
    }

    // FSM: Support Message
    if (fsm.step === 'AWAITING_SUPPORT_MESSAGE') {
      await redis.clearFsmState(userId);
      const isPreInvoice = fsm.data?.contextType === 'BINANCE_PRE_INVOICE';
      const relatedDep = fsm.data?.depositId ? String(fsm.data.depositId) : undefined;
      const ticketId = await supportService.createTicket({
        userId,
        issueType: isPreInvoice ? 'BINANCE_PRE_INVOICE' : 'GENERAL_INQUIRY',
        subject: isPreInvoice
          ? `Pre-invoice Binance deposit (${relatedDep || 'N/A'})`.substring(0, 50)
          : text.substring(0, 50),
        message: relatedDep ? `[Invoice Ref: ${relatedDep}] ${text}` : text,
      });

      await telegramClient.sendMessage(chatId, t('support_created', lang, { ticketId }), {
        reply_markup: getBackHomeKeyboard('m:home', lang),
      });
      return;
    }
  }

  private async showSearchResults(
    chatId: number,
    messageId: number | undefined,
    userId: string,
    query: string,
    page: number,
    lang: SupportedLanguage
  ) {
    const pageSize = 6;
    const results = await pricingService.getCatalog({ search: query, page, pageSize });
    if (results.items.length === 0) {
      await this.renderMenu(
        chatId,
        messageId,
        userId,
        t('search_empty', lang, { query }),
        getBackHomeKeyboard('m:prod', lang)
      );
      return;
    }

    const totalPages = Math.max(1, Math.ceil(results.total / pageSize));
    await this.renderMenu(
      chatId,
      messageId,
      userId,
      t('search_results', lang, { query, total: results.total, page, totalPages }),
      getProductListKeyboard({
        products: results.items.map(p => ({ id: p.id, name: p.name, sellingPrice: p.sellingPrice })),
        page,
        totalPages,
        catId: 'all',
        lang,
        paginationPrefix: 'srch',
      })
    );
  }

  /**
   * Handle Photo uploads (e.g. proof screenshot for manual deposit)
   */
  public async handlePhoto(msg: TelegramMessage) {
    if (!msg.from || !msg.photo || msg.photo.length === 0) return;
    const userId = String(msg.from.id);
    const chatId = msg.chat.id;
    const lang = await getUserLanguage(userId);

    const fsm = await redis.getFsmState<UserFsmState>(userId);
    if (fsm?.step === 'AWAITING_MANUAL_PROOF') {
      const { methodCode, amount, txid } = fsm.data || {};
      const largestPhoto = msg.photo[msg.photo.length - 1];

      await redis.clearFsmState(userId);
      const sub = await manualPaymentService.submitDeposit({
        userId,
        methodCode,
        amount,
        txid,
        proofFileId: largestPhoto.file_id,
      });

      const confirmMsg =
        `✅ *PAYMENT SUBMITTED FOR REVIEW*\n\n` +
        `• Deposit ID: \`${sub.depositId}\`\n` +
        `• Method: *${methodCode}*\n` +
        `• Amount: \`${amount} USDT\`\n` +
        `• TXID: \`${txid}\`\n\n` +
        (sub.isDuplicateTxid ? '⚠️ _Notice: This TXID was previously submitted and is flagged for manual review._\n\n' : '') +
        `Our admins will review your receipt and credit your wallet shortly.`;

      await telegramClient.sendMessage(chatId, confirmMsg, {
        reply_markup: getBackHomeKeyboard('m:wall', lang),
      });
    }
  }

  /**
   * Execute purchase helper
   */
  private async executePurchase(
    chatId: number,
    messageId: number | undefined,
    userId: string,
    productId: string,
    quantity: number,
    customerEmail?: string,
    lang: SupportedLanguage = 'en'
  ) {
    try {
      if (messageId) {
        await telegramClient.editMessageText(chatId, messageId, '🔄 Processing purchase securely with wallet ledger...');
      } else {
        await telegramClient.sendMessage(chatId, '🔄 Processing purchase securely with wallet ledger...');
      }

      const res = await orderService.checkout({
        userId,
        productId,
        quantity,
        customerEmail,
      });

      if (res.success) {
        let msg = `${t('order_success', lang, { orderId: res.orderId })}\n\n`;
        if (res.deliveredItems.length > 0) {
          msg += `\`\`\`\n${res.deliveredItems.join('\n')}\n\`\`\``;
        } else {
          msg += `_Status: ${res.status}. Your access invite has been scheduled and will be delivered shortly._`;
        }
        await telegramClient.sendMessage(chatId, msg, {
          reply_markup: getBackHomeKeyboard('m:ord', lang),
        });
      } else {
        await telegramClient.sendMessage(chatId, `⚠️ *ORDER STATUS: ${res.status}*\n\n${res.message}`, {
          reply_markup: getBackHomeKeyboard('m:prod', lang),
        });
      }
    } catch (err: any) {
      await telegramClient.sendMessage(chatId, `❌ *PURCHASE FAILED*\n\n${err.message}`, {
        reply_markup: getBackHomeKeyboard('m:prod', lang),
      });
    }
  }

  /**
   * Resolve adjacent (previous/next) product IDs and page locations within category/all
   */
  public async getAdjacentProducts(
    productId: string,
    catId = 'all',
    pageSize = 6
  ): Promise<{
    prevProductId: string | null;
    prevPage: number;
    nextProductId: string | null;
    nextPage: number;
    currentPage: number;
    total: number;
    index: number;
  }> {
    const isAll = catId === 'all';
    let whereClause = `WHERE (po.is_hidden IS NULL OR po.is_hidden = FALSE)
      AND (sp.is_unlimited = TRUE OR sp.latest_stock > 0)
      AND sp.is_available = TRUE`;
    const queryParams: any[] = [];

    if (!isAll) {
      whereClause += ` AND po.category_id = $1`;
      queryParams.push(catId);
    }

    const sql = `
      SELECT sp.id
      FROM supplier_products sp
      LEFT JOIN product_overrides po ON sp.id = po.product_id
      ${whereClause}
      ORDER BY po.is_featured DESC NULLS LAST, sp.original_name ASC
    `;

    const res = await db.query<{ id: string }>(sql, queryParams);
    const ids = res.rows.map(r => r.id);
    const index = ids.indexOf(productId);
    const total = ids.length;

    if (index === -1) {
      return {
        prevProductId: null,
        prevPage: 1,
        nextProductId: null,
        nextPage: 1,
        currentPage: 1,
        total,
        index: -1,
      };
    }

    const currentPage = Math.floor(index / pageSize) + 1;
    const prevIndex = index - 1;
    const nextIndex = index + 1;

    const prevProductId = prevIndex >= 0 ? ids[prevIndex] : null;
    const prevPage = prevIndex >= 0 ? Math.floor(prevIndex / pageSize) + 1 : currentPage;

    const nextProductId = nextIndex < total ? ids[nextIndex] : null;
    const nextPage = nextIndex < total ? Math.floor(nextIndex / pageSize) + 1 : currentPage;

    return {
      prevProductId,
      prevPage,
      nextProductId,
      nextPage,
      currentPage,
      total,
      index,
    };
  }

  /**
   * Render individual product detail view with quantity controls, buy now, more details, prev/next product, back to list
   */
  public async showProductDetail(
    chatId: number,
    messageId: number | undefined,
    productId: string,
    quantity = 1,
    catId = 'all',
    page = 1,
    lang: SupportedLanguage = 'en'
  ): Promise<void> {
    const [product, adj] = await Promise.all([
      pricingService.getCatalogItemById(productId),
      this.getAdjacentProducts(productId, catId, 6),
    ]);

    if (!product) {
      const notFoundMsg = '⚠️ Product is no longer available in the catalogue.';
      if (messageId) {
        await telegramClient.editMessageText(chatId, messageId, notFoundMsg, {
          reply_markup: getBackHomeKeyboard(`cat:${catId}:${page}`, lang),
        });
      } else {
        await telegramClient.sendMessage(chatId, notFoundMsg, {
          reply_markup: getBackHomeKeyboard(`cat:${catId}:${page}`, lang),
        });
      }
      return;
    }

    const text = this.formatProductCard(product, quantity);

    const keyboard = getProductDetailKeyboard({
      productId: product.id,
      quantity,
      catId,
      page,
      prevProductId: adj.prevProductId,
      prevProductPage: adj.prevPage,
      nextProductId: adj.nextProductId,
      nextProductPage: adj.nextPage,
      lang,
    });

    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: keyboard,
      });
    } else {
      await telegramClient.sendMessage(chatId, text, {
        reply_markup: keyboard,
      });
    }
  }

  /**
   * Format product card text
   */
  private formatProductCard(p: any, quantity = 1): string {
    const stockStr = p.isUnlimited ? '♾️ Unlimited' : p.stock > 0 ? `${p.stock} in stock` : '❌ Out of stock';
    const emailStr = p.requiresEmail ? '⚠️ Email Required' : '⚡ Instant Key/Account';
    const totalStr = new Decimal(p.sellingPrice).times(quantity).toFixed(2);

    return (
      `🛍️ *${p.name}*\n\n` +
      `💰 *Unit Price:* \`${p.sellingPrice} USDT\`\n` +
      (quantity > 1 ? `🧮 *Total (${quantity}x):* \`${totalStr} USDT\`\n` : '') +
      `📦 *Availability:* ${stockStr}\n` +
      `⏱️ *Duration:* ${p.duration}\n` +
      `🔑 *Type:* ${emailStr}\n\n` +
      `📝 *Description:*\n_${p.description.substring(0, 160)}${p.description.length > 160 ? '...' : ''}_\n\n` +
      `🛡️ *Warranty:* ${p.warrantySummary}`
    );
  }

  private escapeMarkdownText(raw: string): string {
    return String(raw || '').replace(/([_*`\[])/g, '\\$1');
  }

  /**
   * Execute Binance TXID verification with guaranteed terminal Telegram response + safe Retry Verification button.
   */
  public async executeBinanceTxVerification(
    chatId: number,
    userId: string,
    depositId: string,
    submittedTxId: string,
    lang: SupportedLanguage = 'en'
  ): Promise<BinanceVerificationResult> {
    const cleanTx = submittedTxId.trim();
    const maskedTx = maskIdentifier(cleanTx);
    const stageStart = Date.now();

    if (depositId && cleanTx) {
      await redis.set(`bin_last_tx:${userId}:${depositId}`, cleanTx, 3600).catch(() => {});
    }

    await telegramClient.sendMessage(chatId, `🔍 Verifying submitted Order ID \`${maskedTx || 'SUBMITTED'}\`...`);

    let res: BinanceVerificationResult;
    try {
      res = await binanceService.verifyDeposit(depositId, cleanTx, userId);
    } catch (err: any) {
      logger.error('Binance verification handler caught exception', {
        depositId,
        maskedTx,
        error: err?.message || 'Unknown error',
      });
      res = {
        verified: false,
        classification: 'BINANCE_API_ERROR',
        message: 'Verification could not complete due to a temporary server error. Zero credit was applied — please tap Retry Verification.',
        sanitizedDetails: { retryable: true },
      };
    }

    const sendStart = Date.now();
    let tgRes: any;
    if (res.verified) {
      const heading = res.classification === 'ALREADY_VERIFIED' ? '✅ *ALREADY VERIFIED*' : '✅ *PAYMENT VERIFIED!*';
      tgRes = await telegramClient.sendMessage(
        chatId,
        `${heading}\n\n${this.escapeMarkdownText(res.message)}`,
        { reply_markup: getBackHomeKeyboard('m:wall', lang) }
      );
    } else if (res.classification === 'PAYMENT_BEFORE_INVOICE') {
      const preInvoiceMsg =
        `⚠️ *PAYMENT COMPLETED BEFORE INVOICE*\n\n` +
        `This payment was completed before this invoice was created, so it cannot be used for this invoice. Please create a current invoice before making a payment.\n\n` +
        `If you genuinely sent funds earlier by mistake, tap *🎧 CONTACT SUPPORT* below so our team can review it.`;
      tgRes = await telegramClient.sendMessage(chatId, preInvoiceMsg, {
        reply_markup: getPaymentBeforeInvoiceKeyboard(lang, depositId),
      });
    } else {
      const safeClassification = this.escapeMarkdownText(res.classification);
      const safeMessage = this.escapeMarkdownText(res.message);

      let replyMarkup: any;
      if (res.classification === 'EXPIRED_INVOICE' || !depositId) {
        replyMarkup = {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: 'ADD FUNDS (NEW INVOICE)',
                fallbackEmoji: '➕',
                style: 'primary',
                callbackData: 'm:dep',
                forceVisible: true,
              }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ settingKey: 'btn.nav.home', lang, callbackData: 'm:home', forceVisible: true }),
            ]),
          ],
        };
      } else if (res.classification === 'BINANCE_API_TIMEOUT' || res.classification === 'BINANCE_API_ERROR') {
        replyMarkup = {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: 'RETRY VERIFICATION',
                fallbackEmoji: '🔄',
                style: 'primary',
                callbackData: `bin_r:${depositId}`,
                forceVisible: true,
              }),
            ]),
            ...getBinanceInvoiceKeyboard(depositId, lang).inline_keyboard,
          ],
        };
      } else {
        replyMarkup = getBinanceInvoiceKeyboard(depositId, lang);
      }

      tgRes = await telegramClient.sendMessage(
        chatId,
        `⚠️ *VERIFICATION RESULT (${safeClassification})*\n\n${safeMessage}`,
        { reply_markup: replyMarkup }
      );
    }

    logger.info('Binance verification stage: telegram_final_response_sent', {
      depositId,
      maskedTx,
      classification: res.classification,
      verified: res.verified,
      telegramOk: Boolean(tgRes?.ok),
      telegramSendMs: Date.now() - sendStart,
      totalHandlerMs: Date.now() - stageStart,
    });

    return res;
  }
}

export const customerHandler = new CustomerHandler();
