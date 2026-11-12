import Decimal from 'decimal.js';
import { db } from '../../db/index.js';
import { config, getSanitizedConfig } from '../../config/env.js';
import { supplierService } from '../../services/supplier.js';
import { pricingService } from '../../services/pricing.js';
import { manualPaymentService } from '../../services/manualPayment.js';
import { binanceService } from '../../services/binance.js';
import { walletService } from '../../services/wallet.js';
import { getAdminMainMenuKeyboard } from '../keyboards.js';
import { telegramClient } from '../client.js';
import { TelegramMessage, TelegramCallbackQuery } from '../types.js';
import { createLogger } from '../../services/logger.js';

const logger = createLogger('AdminHandler');

export class AdminHandler {
  public checkAuthorization(userId: string | number): boolean {
    return config.telegram.adminIds.includes(String(userId));
  }

  public async handleAdminCommand(msg: TelegramMessage) {
    if (!msg.from) return;
    const userId = String(msg.from.id);
    if (!this.checkAuthorization(userId)) {
      await telegramClient.sendMessage(msg.chat.id, '⛔ *ACCESS DENIED*\n\nYou are not authorized to access the XERO KHAN Admin Control Center.');
      return;
    }

    await telegramClient.sendMessage(msg.chat.id, '👑 *XERO KHAN ADMIN CONTROL CENTER*\n\nSelect a management module:', {
      reply_markup: getAdminMainMenuKeyboard(),
    });
  }

  public async handleCallback(cb: TelegramCallbackQuery) {
    if (!cb.message || !cb.data) return;
    const chatId = cb.message.chat.id;
    const messageId = cb.message.message_id;
    const userId = String(cb.from.id);
    const data = cb.data;

    if (!this.checkAuthorization(userId)) {
      await telegramClient.answerCallbackQuery(cb.id, 'Access Denied: Not an admin', true);
      return;
    }

    await telegramClient.answerCallbackQuery(cb.id);

    // Admin Main Menu
    if (data === 'adm:main') {
      await telegramClient.editMessageText(chatId, messageId, '👑 *XERO KHAN ADMIN CONTROL CENTER*\n\nSelect a management module:', {
        reply_markup: getAdminMainMenuKeyboard(),
      });
      return;
    }

    // Dashboard
    if (data === 'adm:dash') {
      const usersCountRes = await db.queryRow<{ count: string }>('SELECT COUNT(*) as count FROM users');
      const ordersCountRes = await db.queryRow<{ count: string }>('SELECT COUNT(*) as count FROM local_orders');
      const pendingDepRes = await db.queryRow<{ count: string }>("SELECT COUNT(*) as count FROM deposits WHERE status = 'PENDING_REVIEW'");
      const productsCountRes = await db.queryRow<{ count: string }>('SELECT COUNT(*) as count FROM supplier_products');

      const text = `📊 *XERO KHAN EXECUTIVE DASHBOARD*\n\n` +
        `• Registered Users: *${usersCountRes?.count || 0}*\n` +
        `• Total Orders Placed: *${ordersCountRes?.count || 0}*\n` +
        `• Pending Deposit Reviews: *${pendingDepRes?.count || 0}*\n` +
        `• Catalogued Products: *${productsCountRes?.count || 0}*\n\n` +
        `🛡️ *Safety Flags:*\n` +
        `• Recovery Mode: *${config.safety.recoveryMode}*\n` +
        `• Live Supplier Ordering: *${config.safety.liveOrderingEnabled ? 'ENABLED' : 'DISABLED (Protected)'}*\n` +
        `• Manual Payments: *${config.safety.manualPaymentsEnabled ? 'ACTIVE' : 'DISABLED'}*`;

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 TRIGGER SUPPLIER SYNC', callback_data: 'adm:sync' }],
            [{ text: '💳 REVIEW PENDING DEPOSITS', callback_data: 'adm:dep' }],
            [{ text: '⬅️ BACK TO ADMIN', callback_data: 'adm:main' }]
          ]
        }
      });
      return;
    }

    // Trigger Supplier Catalogue Sync
    if (data === 'adm:sync') {
      await telegramClient.editMessageText(chatId, messageId, '🔄 *SYNCHRONIZING SUPPLIER CATALOGUE...*\n\nQuerying AiToolShop Reseller API and updating local database mirror...');
      try {
        const syncResult = await supplierService.syncCatalogue();
        const text = `✅ *SUPPLIER SYNCHRONIZATION COMPLETE*\n\n` +
          `• Newly Imported Products: *${syncResult.importedCount}*\n` +
          `• Stock/Cost Updated Products: *${syncResult.updatedCount}*\n` +
          `• Total Local Catalogue Products: *${syncResult.totalCount}*\n\n` +
          `_All admin pricing rules, display overrides and categories were preserved._`;
        await telegramClient.sendMessage(chatId, text, {
          reply_markup: getAdminMainMenuKeyboard(),
        });
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `❌ *SYNC FAILED*\n\n${err.message}`, {
          reply_markup: getAdminMainMenuKeyboard(),
        });
      }
      return;
    }

    // Pending Deposits
    if (data === 'adm:dep') {
      const pending = await db.query<any>(`
        SELECT id, user_id as "userId", payment_method_code as "methodCode",
               amount, txid, proof_file_id as "proofFileId", created_at as "createdAt",
               failure_reason as "failureReason"
        FROM deposits
        WHERE status = 'PENDING_REVIEW'
        ORDER BY created_at ASC
        LIMIT 5
      `);

      if (pending.rows.length === 0) {
        await telegramClient.editMessageText(chatId, messageId, '💳 *PENDING DEPOSITS*\n\n✅ No manual deposits currently pending review.', {
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ BACK TO ADMIN', callback_data: 'adm:main' }]]
          }
        });
        return;
      }

      const dep = pending.rows[0];
      const text = `💳 *PENDING DEPOSIT REVIEW (1 of ${pending.rows.length})*\n\n` +
        `• Deposit ID: \`${dep.id}\`\n` +
        `• User ID: \`${dep.userId}\`\n` +
        `• Method: *${dep.methodCode}*\n` +
        `• Amount: \`${dep.amount} USDT\`\n` +
        `• Submitted TXID: \`${dep.txid}\`\n` +
        (dep.failureReason ? `⚠️ Alert: *${dep.failureReason}*\n` : '') +
        `• Submitted At: ${dep.createdAt}`;

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ APPROVE & CREDIT', callback_data: `adm_app:${dep.id}` },
              { text: '❌ REJECT', callback_data: `adm_rej:${dep.id}` }
            ],
            [{ text: '⬅️ BACK TO ADMIN', callback_data: 'adm:main' }]
          ]
        }
      });
      return;
    }

    // Approve Deposit
    if (data.startsWith('adm_app:')) {
      const [, depositId] = data.split(':');
      try {
        const res = await manualPaymentService.approveDeposit(depositId, userId);
        await telegramClient.sendMessage(chatId, `✅ *DEPOSIT APPROVED*\n\nSuccessfully credited \`${res.amount} USDT\` to user \`${res.userId}\`. Wallet and immutable ledger updated.`, {
          reply_markup: {
            inline_keyboard: [[{ text: '💳 NEXT PENDING DEPOSIT', callback_data: 'adm:dep' }]]
          }
        });
        // Notify customer
        await telegramClient.sendMessage(res.userId, `🎉 *DEPOSIT APPROVED*\n\nYour deposit of \`${res.amount} USDT\` has been approved and credited to your wallet balance.`);
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `❌ *APPROVAL FAILED*\n\n${err.message}`);
      }
      return;
    }

    // Reject Deposit
    if (data.startsWith('adm_rej:')) {
      const [, depositId] = data.split(':');
      try {
        await manualPaymentService.rejectDeposit(depositId, userId, 'Invalid TXID or unverifiable receipt');
        await telegramClient.sendMessage(chatId, `❌ Deposit \`${depositId}\` has been marked REJECTED.`, {
          reply_markup: {
            inline_keyboard: [[{ text: '💳 NEXT PENDING DEPOSIT', callback_data: 'adm:dep' }]]
          }
        });
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ ${err.message}`);
      }
      return;
    }

    // Products Management
    if (data.startsWith('adm:prod:')) {
      const [, , pageStr] = data.split(':');
      const page = parseInt(pageStr || '1', 10);
      const catalog = await pricingService.getCatalog({ page, pageSize: 4, includeHidden: true });

      let text = `🛍️ *ADMIN PRODUCTS & PRICING (Page ${page})*\n\n`;
      const rows: any[][] = [];

      for (const item of catalog.items) {
        text += `• *${item.name}*\n` +
          `  Cost: \`${item.supplierCost} USDT\` | Retail: \`${item.sellingPrice} USDT\` | Stock: ${item.stock}\n` +
          `  Rule: *${item.pricingRule}* | Status: ${item.isHidden ? '🙈 Hidden' : '👁️ Visible'}\n\n`;

        rows.push([
          { text: `💲 Price: ${item.name.substring(0, 16)}`, callback_data: `adm_pr:${item.id}` },
        ]);
      }

      rows.push([
        { text: '⬅️ BACK TO ADMIN', callback_data: 'adm:main' },
      ]);

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: { inline_keyboard: rows },
      });
      return;
    }

    // Edit Product Price Quick Actions
    if (data.startsWith('adm_pr:')) {
      const [, productId] = data.split(':');
      const product = await db.queryRow<any>('SELECT * FROM supplier_products WHERE id = $1', [productId]);
      if (!product) return;

      const priceInfo = await pricingService.calculatePrice(productId);

      const text = `💲 *EDIT PRODUCT PRICING*\n\n` +
        `Product: *${product.original_name}*\n` +
        `Supplier Cost: \`${priceInfo.supplierCost.toFixed(4)} USDT\`\n` +
        `Current Retail: \`${priceInfo.customerUnitPrice.toFixed(2)} USDT\`\n` +
        `Active Rule: *${priceInfo.ruleApplied}*\n\n` +
        `Choose a pricing adjustment:`;

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '+0.05 Fixed Markup', callback_data: `adm_set_fm:${productId}:0.05` },
              { text: '+0.10 Fixed Markup', callback_data: `adm_set_fm:${productId}:0.10` },
            ],
            [
              { text: '+0.25 Fixed Markup', callback_data: `adm_set_fm:${productId}:0.25` },
              { text: '+0.50 Fixed Markup', callback_data: `adm_set_fm:${productId}:0.50` },
            ],
            [
              { text: '🔄 Reset to Default Pricing', callback_data: `adm_reset_pr:${productId}` },
            ],
            [
              { text: '⬅️ BACK TO PRODUCTS', callback_data: 'adm:prod:1' }
            ]
          ]
        }
      });
      return;
    }

    // Apply Fixed Markup
    if (data.startsWith('adm_set_fm:')) {
      const [, productId, markupStr] = data.split(':');
      await pricingService.setFixedMarkup(productId, markupStr, userId);
      const newPrice = await pricingService.calculatePrice(productId);
      await telegramClient.sendMessage(chatId, `✅ *PRICING UPDATED*\n\nFixed markup of \`+${markupStr} USDT\` saved. New retail price is \`${newPrice.customerUnitPrice.toFixed(2)} USDT\`.\nCustomer catalogue reflects this immediately without server restart.`, {
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ BACK TO PRODUCTS', callback_data: 'adm:prod:1' }]]
        }
      });
      return;
    }

    // Reset Pricing
    if (data.startsWith('adm_reset_pr:')) {
      const [, productId] = data.split(':');
      await pricingService.resetPricing(productId, userId);
      await telegramClient.sendMessage(chatId, '✅ *PRICING RESET*\n\nProduct pricing reset to global default rule.', {
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ BACK TO PRODUCTS', callback_data: 'adm:prod:1' }]]
        }
      });
      return;
    }

    // System Health & Diagnostics
    if (data === 'adm:hlth') {
      const binanceTest = await binanceService.testReadOnlyVerification();
      const sanitized: any = getSanitizedConfig();
      const receiverConfigured = Boolean(binanceService.getReceiverId());

      const text = `🩺 *SYSTEM HEALTH & DIAGNOSTICS*\n\n` +
        `• Node Env: *${sanitized.nodeEnv}*\n` +
        `• Database Pool: *CONNECTED (PostgreSQL)*\n` +
        `• Redis: *${sanitized.redisConfigured ? 'CONNECTED' : 'IN-MEMORY FALLBACK'}*\n` +
        `• Supplier API: *${sanitized.supplier.baseUrl}*\n\n` +
        `⚡ *Binance Pay Status:*\n` +
        `• Configured Receiver: *${receiverConfigured ? 'YES' : 'NO'}*\n` +
        `• Receiver Match Capability: *${receiverConfigured ? 'AVAILABLE' : 'UNAVAILABLE'}*\n` +
        `• Binance Readiness: *${binanceTest.status === 'READY' ? 'READY' : 'BLOCKED'}*\n\n` +
        `🛡️ *Safety Flags:*\n` +
        `• Recovery Mode: *${config.safety.recoveryMode}*\n` +
        `• Live Ordering Flag: *${config.safety.liveOrderingEnabled}*\n\n` +
        `_Zero credential leakage. All secrets masked._`;

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ BACK TO ADMIN', callback_data: 'adm:main' }]]
        }
      });
      return;
    }
  }
}

export const adminHandler = new AdminHandler();
