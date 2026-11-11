import Decimal from 'decimal.js';
import { db } from '../../db/index.js';
import { redis } from '../../services/redis.js';
import { walletService } from '../../services/wallet.js';
import { pricingService } from '../../services/pricing.js';
import { manualPaymentService } from '../../services/manualPayment.js';
import { binanceService } from '../../services/binance.js';
import { orderService } from '../../services/order.js';
import { referralService } from '../../services/referral.js';
import { giveawayService } from '../../services/giveaway.js';
import { supportService } from '../../services/support.js';
import { t, SupportedLanguage } from '../../services/i18n.js';
import { config } from '../../config/env.js';
import {
  getCustomerMainInlineKeyboard,
  getCustomerMainReplyKeyboard,
  getCategoryKeyboard,
  getProductCardKeyboard,
  getDepositMethodsKeyboard,
  getBinanceInvoiceKeyboard,
  getBackHomeKeyboard,
} from '../keyboards.js';
import { telegramClient } from '../client.js';
import { TelegramMessage, TelegramCallbackQuery, UserFsmState } from '../types.js';
import { createLogger } from '../../services/logger.js';

const logger = createLogger('CustomerHandler');

export class CustomerHandler {
  /**
   * Ensure user exists in authoritative PostgreSQL database
   */
  public async ensureUser(from: { id: number; first_name: string; last_name?: string; username?: string; language_code?: string }) {
    const userId = String(from.id);
    const isAdmin = config.telegram.adminIds.includes(userId);

    await db.query(`
      INSERT INTO users (id, telegram_id, username, first_name, last_name, language_code, is_admin, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        is_admin = $7,
        updated_at = CURRENT_TIMESTAMP
    `, [userId, from.id, from.username || null, from.first_name, from.last_name || null, from.language_code || 'en', isAdmin]);

    await db.query(`
      INSERT INTO user_profiles (user_id, preferred_language, created_at, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id) DO NOTHING
    `, [userId, from.language_code || 'en']);

    await walletService.getOrCreateWallet(userId);
    return { userId, isAdmin };
  }

  /**
   * Handle /start command
   */
  public async handleStart(msg: TelegramMessage, referrerCode?: string) {
    if (!msg.from) return;
    const { userId, isAdmin } = await this.ensureUser(msg.from);

    // If referred by another user
    if (referrerCode && referrerCode.startsWith('ref_')) {
      const referrerId = referrerCode.replace('ref_', '').trim();
      await referralService.registerReferral(referrerId, userId);
    }

    const welcomeText = t('welcome', 'en');

    // Send persistent reply keyboard
    await telegramClient.sendMessage(msg.chat.id, '⚡ *XERO KHAN MENU READY*', {
      reply_markup: getCustomerMainReplyKeyboard(),
    });

    // Send colourful interactive inline menu
    await telegramClient.sendMessage(msg.chat.id, welcomeText, {
      reply_markup: getCustomerMainInlineKeyboard(isAdmin),
    });
  }

  /**
   * Handle Customer Inline Callbacks
   */
  public async handleCallback(cb: TelegramCallbackQuery) {
    if (!cb.message || !cb.data) return;
    const chatId = cb.message.chat.id;
    const messageId = cb.message.message_id;
    const userId = String(cb.from.id);
    const data = cb.data;
    const isAdmin = config.telegram.adminIds.includes(userId);

    await telegramClient.answerCallbackQuery(cb.id);

    // Navigation: Home
    if (data === 'm:home') {
      await redis.clearFsmState(userId);
      await telegramClient.editMessageText(chatId, messageId, t('welcome', 'en'), {
        reply_markup: getCustomerMainInlineKeyboard(isAdmin),
      });
      return;
    }

    // Navigation: Products / Categories
    if (data === 'm:prod') {
      const categories = await db.query<any>('SELECT id, name FROM product_categories WHERE is_visible = TRUE ORDER BY display_order ASC');
      const text = '🛍️ *BROWSE CATEGORIES*\n\nSelect a category below to explore available digital tools:';
      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: getCategoryKeyboard(categories.rows),
      });
      return;
    }

    // Category / Products List
    if (data.startsWith('cat:')) {
      const [, catId, pageStr] = data.split(':');
      const page = parseInt(pageStr || '1', 10);
      const isAll = catId === 'all';

      const catalog = await pricingService.getCatalog({
        categoryId: isAll ? undefined : catId,
        page,
        pageSize: 5,
      });

      if (catalog.items.length === 0) {
        await telegramClient.editMessageText(chatId, messageId, '⚠️ Live catalogue temporarily unavailable. Please check back shortly.', {
          reply_markup: getBackHomeKeyboard('m:prod'),
        });
        return;
      }

      // Display first product card in category with pagination
      const first = catalog.items[0];
      const cardText = this.formatProductCard(first);
      await telegramClient.editMessageText(chatId, messageId, cardText, {
        reply_markup: getProductCardKeyboard(first.id, 1, catId),
      });
      return;
    }

    // Quantity selector
    if (data.startsWith('qty:')) {
      const [, productId, qtyStr, backCatId] = data.split(':');
      const qty = parseInt(qtyStr || '1', 10);
      const product = await db.queryRow<any>('SELECT * FROM supplier_products WHERE id = $1', [productId]);
      if (!product) return;

      const card = (await pricingService.getCatalog({ search: product.original_name })).items[0];
      if (card) {
        const text = this.formatProductCard(card);
        await telegramClient.editMessageText(chatId, messageId, text, {
          reply_markup: getProductCardKeyboard(card.id, qty, backCatId),
        });
      }
      return;
    }

    // Buy Now
    if (data.startsWith('buy:')) {
      const [, productId, qtyStr] = data.split(':');
      const qty = parseInt(qtyStr || '1', 10);
      const product = await db.queryRow<any>('SELECT * FROM supplier_products WHERE id = $1', [productId]);
      if (!product) return;

      if (product.requires_email) {
        await redis.setFsmState(userId, {
          step: 'AWAITING_EMAIL_FOR_ORDER',
          data: { productId, quantity: qty },
        });
        await telegramClient.editMessageText(chatId, messageId, `📧 *EMAIL REQUIRED*\n\nPlease type your delivery email address for *${product.original_name}* (Qty: ${qty}):`, {
          reply_markup: getBackHomeKeyboard('m:prod'),
        });
        return;
      }

      // Execute order directly if email not required
      await this.executePurchase(chatId, messageId, userId, productId, qty);
      return;
    }

    // Product More Details
    if (data.startsWith('det:')) {
      const [, productId] = data.split(':');
      const product = await db.queryRow<any>('SELECT * FROM supplier_products WHERE id = $1', [productId]);
      if (!product) return;

      const detailsText = `📋 *PRODUCT DETAILS*\n\n*${product.original_name}*\n\n${product.original_description || 'No additional description provided.'}\n\n🛡️ *Warranty:* ${product.warranty_summary || 'Standard replacement guarantee'}`;
      await telegramClient.sendMessage(chatId, detailsText, {
        reply_markup: getBackHomeKeyboard('m:prod'),
      });
      return;
    }

    // Wallet
    if (data === 'm:wall') {
      const { balance, locked } = await walletService.getBalance(userId);
      const text = t('wallet_info', 'en', {
        balance: balance.toFixed(2),
        locked: locked.toFixed(2),
      });
      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ ADD FUNDS', callback_data: 'm:dep' }],
            [{ text: '📜 TRANSACTION HISTORY', callback_data: 'w:hist' }],
            [{ text: '🏠 HOME', callback_data: 'm:home' }]
          ]
        }
      });
      return;
    }

    // Add Funds / Payment Methods
    if (data === 'm:dep') {
      await telegramClient.editMessageText(chatId, messageId, t('choose_payment', 'en'), {
        reply_markup: getDepositMethodsKeyboard(),
      });
      return;
    }

    // Method: Binance Pay USDT
    if (data === 'dep_m:binance') {
      await redis.setFsmState(userId, { step: 'AWAITING_BINANCE_AMOUNT' });
      const prompt = `⚡ *BINANCE PAY USDT DEPOSIT*\n\nPlease enter the USDT amount you wish to deposit (Min: ${config.binance.minDepositUsdt} USDT, Max: ${config.binance.maxDepositUsdt} USDT):\n\n_Example: 5.00_`;
      await telegramClient.editMessageText(chatId, messageId, prompt, {
        reply_markup: getBackHomeKeyboard('m:dep'),
      });
      return;
    }

    // Method: Easypaisa or JazzCash
    if (data === 'dep_m:easypaisa' || data === 'dep_m:jazzcash') {
      const code = data === 'dep_m:easypaisa' ? 'EASYPAISA' : 'JAZZCASH';
      const method = await manualPaymentService.getMethodByCode(code);
      if (!method) return;

      await redis.setFsmState(userId, { step: 'AWAITING_MANUAL_AMOUNT', data: { methodCode: code } });
      const prompt = `📱 *${method.name}*\n\n` +
        `Account Title: \`${method.accountTitle}\`\n` +
        `Account Number: \`${method.accountNumber}\`\n\n` +
        `Instructions: ${method.instructions}\n\n` +
        `Please enter the amount you wish to deposit in USDT equivalent (Min: ${method.minAmount}, Max: ${method.maxAmount}):`;

      await telegramClient.editMessageText(chatId, messageId, prompt, {
        reply_markup: getBackHomeKeyboard('m:dep'),
      });
      return;
    }

    // Binance: Verify payment button
    if (data.startsWith('bin_v:')) {
      const [, depositId] = data.split(':');
      await telegramClient.sendMessage(chatId, '🔍 Checking Binance transaction history for matching incoming transfer...');
      const verifyResult = await binanceService.verifyDeposit(depositId);

      if (verifyResult.verified) {
        await telegramClient.sendMessage(chatId, `✅ *PAYMENT VERIFIED!*\n\n${verifyResult.message}`, {
          reply_markup: getBackHomeKeyboard('m:wall'),
        });
      } else {
        await telegramClient.sendMessage(chatId, `⚠️ *VERIFICATION RESULT: ${verifyResult.classification}*\n\n${verifyResult.message}`, {
          reply_markup: getBinanceInvoiceKeyboard(depositId),
        });
      }
      return;
    }

    // Binance: Enter Transaction ID
    if (data.startsWith('bin_tx:')) {
      const [, depositId] = data.split(':');
      await redis.setFsmState(userId, { step: 'AWAITING_BINANCE_TXID', data: { depositId } });
      await telegramClient.sendMessage(chatId, '🔑 Please send your Binance Transaction ID (found in Binance Pay Transaction details):', {
        reply_markup: getBackHomeKeyboard('m:dep'),
      });
      return;
    }

    // My Orders
    if (data === 'm:ord') {
      const orders = await orderService.getCustomerOrders(userId, 5);
      if (orders.length === 0) {
        await telegramClient.editMessageText(chatId, messageId, '📦 *MY ORDERS*\n\nYou have not placed any orders yet. Tap 🛍️ PRODUCTS to start shopping!', {
          reply_markup: getBackHomeKeyboard('m:home'),
        });
        return;
      }

      let text = '📦 *YOUR RECENT ORDERS*\n\n';
      for (const ord of orders) {
        text += `🔹 *Order:* \`${ord.id}\`\n` +
          `• Item: ${ord.productName} (x${ord.quantity})\n` +
          `• Total: \`${ord.totalPrice} USDT\`\n` +
          `• Status: *${ord.status}*\n`;
        if (ord.deliveredItems.length > 0) {
          text += `• Credentials: \`${ord.deliveredItems[0]}\`\n`;
        }
        text += '\n';
      }

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: getBackHomeKeyboard('m:home'),
      });
      return;
    }

    // Giveaways
    if (data === 'm:give') {
      const giveaways = await giveawayService.getActiveGiveaways(userId);
      if (giveaways.length === 0) {
        await telegramClient.editMessageText(chatId, messageId, '🎁 *GIVEAWAYS*\n\nNo dynamic giveaways are active at this moment. Check back soon!', {
          reply_markup: getBackHomeKeyboard('m:home'),
        });
        return;
      }

      let text = '🎁 *DYNAMIC GIVEAWAYS*\n\n';
      const rows: any[][] = [];
      for (const gw of giveaways) {
        const prog = gw.userProgress;
        text += `🏆 *${gw.title}*\n` +
          `• Reward: ${gw.rewardProductName} (x${gw.rewardQuantity})\n` +
          `• Requirement: ${gw.requiredQualifiedReferrals} Qualified Referrals\n`;
        if (prog) {
          text += `• Your Progress: *${prog.currentQualified} / ${prog.required}*\n` +
            `• Status: ${prog.hasClaimed ? '✅ CLAIMED' : (prog.isEligible ? '🌟 ELIGIBLE TO CLAIM' : '⏳ In Progress')}\n\n`;

          if (prog.isEligible && !prog.hasClaimed) {
            rows.push([{ text: `🎁 CLAIM: ${gw.title}`, callback_data: `gw_cl:${gw.id}` }]);
          }
        }
      }

      rows.push([{ text: '🏠 HOME', callback_data: 'm:home' }]);
      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: { inline_keyboard: rows },
      });
      return;
    }

    // Claim Giveaway
    if (data.startsWith('gw_cl:')) {
      const [, giveawayId] = data.split(':');
      try {
        const res = await giveawayService.claimGiveaway(giveawayId, userId);
        await telegramClient.sendMessage(chatId, `🎉 ${res.message}`, {
          reply_markup: getBackHomeKeyboard('m:give'),
        });
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ ${err.message}`, {
          reply_markup: getBackHomeKeyboard('m:give'),
        });
      }
      return;
    }

    // Refer & Earn
    if (data === 'm:ref') {
      const stats = await referralService.getStats(userId);
      const text = t('referral_title', 'en', {
        link: stats.referralLink,
        total: stats.totalReferred,
        qualified: stats.qualifiedCount,
        pending: stats.pendingCount,
      });
      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: getBackHomeKeyboard('m:home'),
      });
      return;
    }

    // Search
    if (data === 'm:srch') {
      await redis.setFsmState(userId, { step: 'AWAITING_SEARCH_QUERY' });
      await telegramClient.editMessageText(chatId, messageId, '🔎 *SEARCH CATALOGUE*\n\nPlease type the name or keywords of the tool you are looking for (e.g., Netflix, ChatGPT, Canva):', {
        reply_markup: getBackHomeKeyboard('m:home'),
      });
      return;
    }

    // Support
    if (data === 'm:supp') {
      await redis.setFsmState(userId, { step: 'AWAITING_SUPPORT_MESSAGE' });
      await telegramClient.editMessageText(chatId, messageId, '🛟 *CUSTOMER SUPPORT TICKET*\n\nPlease describe your question or issue, including your Order ID if applicable. Our team will assist you promptly:', {
        reply_markup: getBackHomeKeyboard('m:home'),
      });
      return;
    }

    // Profile
    if (data === 'm:prof') {
      const { balance } = await walletService.getBalance(userId);
      const stats = await referralService.getStats(userId);
      const text = `👤 *CUSTOMER PROFILE*\n\n` +
        `• Telegram ID: \`${userId}\`\n` +
        `• Wallet Balance: \`${balance.toFixed(2)} USDT\`\n` +
        `• Qualified Referrals: \`${stats.qualifiedCount}\`\n` +
        `• Language: English\n\n` +
        `_Protected by XERO KHAN Ledger Security._`;
      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: getBackHomeKeyboard('m:home'),
      });
      return;
    }
  }

  /**
   * Handle text messages according to active FSM State
   */
  public async handleTextMessage(msg: TelegramMessage) {
    if (!msg.from || !msg.text) return;
    const userId = String(msg.from.id);
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // Check menu button clicks from Reply Keyboard
    if (text === '🛍️ PRODUCTS') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:prod' });
    if (text === '🔥 FEATURED') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'cat:all:1' });
    if (text === '🔎 SEARCH') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:srch' });
    if (text === '💰 WALLET') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:wall' });
    if (text === '➕ ADD FUNDS') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:dep' });
    if (text === '📦 MY ORDERS') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:ord' });
    if (text === '🎁 GIVEAWAYS') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:give' });
    if (text === '👥 REFER & EARN') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:ref' });
    if (text === '🛟 SUPPORT') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:supp' });
    if (text === '👤 PROFILE') return this.handleCallback({ id: '0', from: msg.from, message: msg, data: 'm:prof' });

    const fsm = await redis.getFsmState<UserFsmState>(userId);
    if (!fsm) return;

    // FSM: Search Query
    if (fsm.step === 'AWAITING_SEARCH_QUERY') {
      await redis.clearFsmState(userId);
      const results = await pricingService.getCatalog({ search: text, pageSize: 5 });
      if (results.items.length === 0) {
        await telegramClient.sendMessage(chatId, `🔍 No products matched "${text}". Try another search term!`, {
          reply_markup: getBackHomeKeyboard('m:prod'),
        });
        return;
      }

      const first = results.items[0];
      await telegramClient.sendMessage(chatId, `🔍 *SEARCH RESULTS (${results.total} found)*\n\n` + this.formatProductCard(first), {
        reply_markup: getProductCardKeyboard(first.id, 1, 'all'),
      });
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
      await this.executePurchase(chatId, undefined, userId, productId, quantity, text);
      return;
    }

    // FSM: Binance Deposit Amount
    if (fsm.step === 'AWAITING_BINANCE_AMOUNT') {
      const amountDec = new Decimal(text);
      if (amountDec.isNaN() || amountDec.lessThan(config.binance.minDepositUsdt)) {
        await telegramClient.sendMessage(chatId, `⚠️ Minimum Binance deposit is ${config.binance.minDepositUsdt} USDT. Please enter a valid number:`);
        return;
      }

      await redis.clearFsmState(userId);
      const invoice = await binanceService.createInvoice(userId, amountDec);
      const invoiceMsg = `⚡ *BINANCE PAY INVOICE CREATED*\n\n` +
        `• Invoice ID: \`${invoice.id}\`\n` +
        `• Exact Amount: \`${invoice.amount} USDT\`\n` +
        `• Binance Pay Receiver ID: \`${invoice.receiverRef}\`\n` +
        `• Expires In: \`60 minutes\`\n\n` +
        `1. Open Binance App -> Binance Pay -> Send\n` +
        `2. Send exactly *${invoice.amount} USDT* to the Receiver ID\n` +
        `3. Tap *I HAVE PAID* below for automatic verification.`;

      await telegramClient.sendMessage(chatId, invoiceMsg, {
        reply_markup: getBinanceInvoiceKeyboard(invoice.id),
      });
      return;
    }

    // FSM: Binance TXID
    if (fsm.step === 'AWAITING_BINANCE_TXID') {
      const depositId = fsm.data?.depositId;
      await redis.clearFsmState(userId);
      await telegramClient.sendMessage(chatId, `🔍 Verifying submitted Transaction ID \`${text}\`...`);
      const res = await binanceService.verifyDeposit(depositId, text);
      if (res.verified) {
        await telegramClient.sendMessage(chatId, `✅ *PAYMENT VERIFIED!*\n\n${res.message}`, {
          reply_markup: getBackHomeKeyboard('m:wall'),
        });
      } else {
        await telegramClient.sendMessage(chatId, `⚠️ *VERIFICATION FAILED (${res.classification})*\n\n${res.message}`, {
          reply_markup: getBinanceInvoiceKeyboard(depositId),
        });
      }
      return;
    }

    // FSM: Manual Payment Amount
    if (fsm.step === 'AWAITING_MANUAL_AMOUNT') {
      const methodCode = fsm.data?.methodCode;
      const amountDec = new Decimal(text);
      if (amountDec.isNaN() || amountDec.lessThan(0.50)) {
        await telegramClient.sendMessage(chatId, '⚠️ Please enter a valid amount (e.g. 5.00):');
        return;
      }

      await redis.setFsmState(userId, {
        step: 'AWAITING_MANUAL_TXID',
        data: { methodCode, amount: amountDec.toFixed(4) },
      });

      await telegramClient.sendMessage(chatId, `📱 Amount: *${amountDec.toFixed(2)} USDT*\n\nPlease enter the Transaction ID (TRX ID / TID) of your completed payment:`);
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
      const ticketId = await supportService.createTicket({
        userId,
        issueType: 'GENERAL_INQUIRY',
        subject: text.substring(0, 50),
        message: text,
      });

      await telegramClient.sendMessage(chatId, `✅ *TICKET CREATED (#${ticketId})*\n\nOur support team has received your inquiry. You will be notified when an admin replies!`, {
        reply_markup: getBackHomeKeyboard('m:home'),
      });
      return;
    }
  }

  /**
   * Handle Photo uploads (e.g. proof screenshot for manual deposit)
   */
  public async handlePhoto(msg: TelegramMessage) {
    if (!msg.from || !msg.photo || msg.photo.length === 0) return;
    const userId = String(msg.from.id);
    const chatId = msg.chat.id;

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

      const confirmMsg = `✅ *PAYMENT SUBMITTED FOR REVIEW*\n\n` +
        `• Deposit ID: \`${sub.depositId}\`\n` +
        `• Method: *${methodCode}*\n` +
        `• Amount: \`${amount} USDT\`\n` +
        `• TXID: \`${txid}\`\n\n` +
        (sub.isDuplicateTxid ? '⚠️ _Notice: This TXID was previously submitted and is flagged for manual review._\n\n' : '') +
        `Our admins will review your receipt and credit your wallet shortly.`;

      await telegramClient.sendMessage(chatId, confirmMsg, {
        reply_markup: getBackHomeKeyboard('m:wall'),
      });
    }
  }

  /**
   * Execute purchase helper
   */
  private async executePurchase(chatId: number, messageId: number | undefined, userId: string, productId: string, quantity: number, customerEmail?: string) {
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
        let msg = `${t('order_success', 'en', { orderId: res.orderId })}\n\n`;
        if (res.deliveredItems.length > 0) {
          msg += `\`\`\`\n${res.deliveredItems.join('\n')}\n\`\`\``;
        } else {
          msg += `_Status: ${res.status}. Your access invite has been scheduled and will be delivered shortly._`;
        }
        await telegramClient.sendMessage(chatId, msg, {
          reply_markup: getBackHomeKeyboard('m:ord'),
        });
      } else {
        await telegramClient.sendMessage(chatId, `⚠️ *ORDER STATUS: ${res.status}*\n\n${res.message}`, {
          reply_markup: getBackHomeKeyboard('m:prod'),
        });
      }
    } catch (err: any) {
      await telegramClient.sendMessage(chatId, `❌ *PURCHASE FAILED*\n\n${err.message}`, {
        reply_markup: getBackHomeKeyboard('m:prod'),
      });
    }
  }

  /**
   * Format product card text
   */
  private formatProductCard(p: any): string {
    const stockStr = p.isUnlimited ? '♾️ Unlimited' : (p.stock > 0 ? `${p.stock} in stock` : '❌ Out of stock');
    const emailStr = p.requiresEmail ? '⚠️ Email Required' : '⚡ Instant Key/Account';

    return `🛍️ *${p.name}*\n\n` +
      `💰 *Price:* \`${p.sellingPrice} USDT\`\n` +
      `📦 *Availability:* ${stockStr}\n` +
      `⏱️ *Duration:* ${p.duration}\n` +
      `🔑 *Type:* ${emailStr}\n\n` +
      `📝 *Description:*\n_${p.description.substring(0, 160)}${p.description.length > 160 ? '...' : ''}_\n\n` +
      `🛡️ *Warranty:* ${p.warrantySummary}`;
  }
}

export const customerHandler = new CustomerHandler();
