import { db } from '../../db/index.js';
import { redis } from '../../services/redis.js';
import { config, getSanitizedConfig } from '../../config/env.js';
import { supplierService } from '../../services/supplier.js';
import { pricingService } from '../../services/pricing.js';
import { manualPaymentService } from '../../services/manualPayment.js';
import { binanceService } from '../../services/binance.js';
import { uiConfigService, UISection, UISettingRecord } from '../../services/uiConfig.js';
import { SupportedLanguage } from '../../services/i18n.js';
import { ButtonBuilder } from '../buttonBuilder.js';
import {
  getAdminMainMenuKeyboard,
  getAdminUiCenterKeyboard,
  getAdminUiSectionKeyboard,
  getAdminUiItemEditorKeyboard,
} from '../keyboards.js';
import { telegramClient } from '../client.js';
import { TelegramMessage, TelegramCallbackQuery, UserFsmState, ButtonStyle } from '../types.js';
import { createLogger } from '../../services/logger.js';

const logger = createLogger('AdminHandler');

export class AdminHandler {
  public checkAuthorization(userId: string | number): boolean {
    return config.telegram.adminIds.includes(String(userId));
  }

  public async handleAdminCommand(msg: TelegramMessage) {
    if (!msg.from) return;
    await uiConfigService.ensureLoaded();
    const userId = String(msg.from.id);
    if (!this.checkAuthorization(userId)) {
      await telegramClient.sendMessage(
        msg.chat.id,
        '⛔ *ACCESS DENIED*\n\nYou are not authorized to access the XERO KHAN Admin Control Center.'
      );
      return;
    }

    await redis.clearFsmState(userId);
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

    const ackPromise =
      cb.id && cb.id !== '0'
        ? telegramClient.answerCallbackQuery(cb.id).catch(() => {})
        : Promise.resolve();

    await uiConfigService.ensureLoaded();
    await ackPromise;

    // Admin Main Menu
    if (data === 'adm:main') {
      await redis.clearFsmState(userId);
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

      const text =
        `📊 *XERO KHAN EXECUTIVE DASHBOARD*\n\n` +
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
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'TRIGGER SUPPLIER SYNC', fallbackEmoji: '🔄', style: 'primary', callbackData: 'adm:sync' }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'REVIEW PENDING DEPOSITS', fallbackEmoji: '💳', style: 'primary', callbackData: 'adm:dep' }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'UI & BUTTONS EDITOR', fallbackEmoji: '🎨', style: 'primary', callbackData: 'adm:ui' }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main' }),
            ]),
          ],
        },
      });
      return;
    }

    // Pricing Overview
    if (data === 'adm:price') {
      const rule = await db.queryRow<any>("SELECT value FROM system_settings WHERE key = 'pricing_global_rules'");
      const val = rule?.value || {};
      const text =
        `💲 *GLOBAL PRICING ENGINE*\n\n` +
        `• Default Percent Markup: \`${val.defaultPercentMarkup || '0.15'}\`\n` +
        `• Default Fixed Markup: \`${val.defaultFixedMarkup || '0.05'} USDT\`\n` +
        `• Min Markup Floor: \`${val.minMarkupFloor || '0.02'} USDT\`\n\n` +
        `To edit individual product prices or markups, open *🛍️ PRODUCTS*:`;

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'OPEN PRODUCT PRICING', fallbackEmoji: '🛍️', style: 'primary', callbackData: 'adm:prod:1' }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main' }),
            ]),
          ],
        },
      });
      return;
    }

    // Categories Management
    if (data === 'adm:cat' || data.startsWith('adm:cat_tog:')) {
      if (data.startsWith('adm:cat_tog:')) {
        const catId = data.split(':')[2];
        await db.query('UPDATE product_categories SET is_visible = NOT is_visible, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [catId]);
      }

      const cats = await db.query<any>('SELECT id, name, is_visible as "isVisible" FROM product_categories ORDER BY display_order ASC');
      let text = `🗂️ *CATEGORIES MANAGEMENT*\n\nTap a category below to toggle customer visibility:\n\n`;
      const rows: any[][] = [];
      for (const c of cats.rows) {
        const icon = c.isVisible ? '👁️' : '🙈';
        text += `${icon} *${c.name}* (\`${c.id}\`)\n`;
        rows.push(
          ButtonBuilder.buildActionRow([
            ButtonBuilder.buildButton({
              text: `${icon} ${c.name}`,
              style: c.isVisible ? 'primary' : 'default',
              callbackData: `adm:cat_tog:${c.id}`,
            }),
          ])
        );
      }
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main' }),
        ])
      );
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
      return;
    }

    // Recent Orders Overview
    if (data === 'adm:ord') {
      const res = await db.query<any>(
        `SELECT id, user_id as "userId", total_price as "totalPrice", status, created_at as "createdAt"
         FROM local_orders ORDER BY created_at DESC LIMIT 8`
      );
      let text = `📦 *RECENT CUSTOMER ORDERS*\n\n`;
      if (res.rows.length === 0) {
        text += `_No customer orders placed yet._`;
      } else {
        for (const o of res.rows) {
          text += `• \`${o.id}\` | User: \`${o.userId}\` | \`${o.totalPrice} USDT\` | *${o.status}*\n`;
        }
      }
      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main' }),
            ]),
          ],
        },
      });
      return;
    }

    // Wallets Overview
    if (data === 'adm:wal') {
      const res = await db.query<any>(
        `SELECT user_id as "userId", balance, locked_balance as "locked"
         FROM wallets ORDER BY balance DESC LIMIT 10`
      );
      let text = `💰 *TOP CUSTOMER WALLETS*\n\n`;
      if (res.rows.length === 0) {
        text += `_No customer wallets created yet._`;
      } else {
        for (const w of res.rows) {
          text += `• User \`${w.userId}\`: \`${w.balance} USDT\` (Locked: \`${w.locked}\`)\n`;
        }
      }
      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main' }),
            ]),
          ],
        },
      });
      return;
    }

    // Giveaways Overview & Toggle
    if (data === 'adm:gw' || data.startsWith('adm:gw_tog:')) {
      if (data.startsWith('adm:gw_tog:')) {
        const gwId = data.split(':')[2];
        await db.query('UPDATE giveaways SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [gwId]);
      }

      const gws = await db.query<any>(
        `SELECT id, title, required_qualified_referrals as req, is_active as active, claims_count as claims, claim_limit as lim
         FROM giveaways ORDER BY created_at DESC LIMIT 8`
      );
      let text = `🎁 *DYNAMIC GIVEAWAYS MANAGEMENT*\n\n`;
      const rows: any[][] = [];
      if (gws.rows.length === 0) {
        text += `_No giveaways configured yet._`;
      } else {
        for (const g of gws.rows) {
          const icon = g.active ? '🟢' : '⏸️';
          text += `${icon} *${g.title}* — Req: ${g.req} | Claims: ${g.claims}/${g.lim}\n`;
          rows.push(
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: `${icon} Toggle: ${g.title.slice(0, 22)}`,
                style: g.active ? 'success' : 'default',
                callbackData: `adm:gw_tog:${g.id}`,
              }),
            ])
          );
        }
      }
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main' }),
        ])
      );
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
      return;
    }

    // Trigger Supplier Catalogue Sync
    if (data === 'adm:sync') {
      await telegramClient.editMessageText(
        chatId,
        messageId,
        '🔄 *SYNCHRONIZING SUPPLIER CATALOGUE...*\n\nQuerying AiToolShop Reseller API and updating local database mirror...'
      );
      try {
        const syncResult = await supplierService.syncCatalogue();
        const text =
          `✅ *SUPPLIER SYNCHRONIZATION COMPLETE*\n\n` +
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
      const pending = await db.query<any>(
        `SELECT id, user_id as "userId", payment_method_code as "methodCode",
                amount, txid, proof_file_id as "proofFileId", created_at as "createdAt",
                failure_reason as "failureReason"
         FROM deposits
         WHERE status = 'PENDING_REVIEW'
         ORDER BY created_at ASC
         LIMIT 5`
      );

      if (pending.rows.length === 0) {
        await telegramClient.editMessageText(chatId, messageId, '💳 *PENDING DEPOSITS*\n\n✅ No manual deposits currently pending review.', {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main' }),
              ]),
            ],
          },
        });
        return;
      }

      const dep = pending.rows[0];
      const text =
        `💳 *PENDING DEPOSIT REVIEW (1 of ${pending.rows.length})*\n\n` +
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
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ settingKey: 'btn.adm.approve', callbackData: `adm_app:${dep.id}`, forceVisible: true }),
              ButtonBuilder.buildButton({ settingKey: 'btn.adm.reject', callbackData: `adm_rej:${dep.id}`, forceVisible: true }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main' }),
            ]),
          ],
        },
      });
      return;
    }

    // Approve Deposit
    if (data.startsWith('adm_app:')) {
      const [, depositId] = data.split(':');
      try {
        const res = await manualPaymentService.approveDeposit(depositId, userId);
        await telegramClient.sendMessage(
          chatId,
          `✅ *DEPOSIT APPROVED*\n\nSuccessfully credited \`${res.amount} USDT\` to user \`${res.userId}\`. Wallet and immutable ledger updated.`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'NEXT PENDING DEPOSIT', fallbackEmoji: '💳', style: 'primary', callbackData: 'adm:dep' }),
                ]),
              ],
            },
          }
        );
        await telegramClient.sendMessage(
          res.userId,
          `🎉 *DEPOSIT APPROVED*\n\nYour deposit of \`${res.amount} USDT\` has been approved and credited to your wallet balance.`
        );
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
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'NEXT PENDING DEPOSIT', fallbackEmoji: '💳', style: 'primary', callbackData: 'adm:dep' }),
              ]),
            ],
          },
        });
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ ${err.message}`);
      }
      return;
    }

    // Products Management (Paginated)
    if (data.startsWith('adm:prod:')) {
      const [, , pageStr] = data.split(':');
      const page = Math.max(1, parseInt(pageStr || '1', 10));
      const pageSize = 4;
      const catalog = await pricingService.getCatalog({ page, pageSize, includeHidden: true });
      const totalPages = Math.max(1, Math.ceil(catalog.total / pageSize));

      let text = `🛍️ *ADMIN PRODUCTS & PRICING (Page ${page} / ${totalPages})*\n\n`;
      const rows: any[][] = [];

      for (const item of catalog.items) {
        text +=
          `• *${item.name}*\n` +
          `  Cost: \`${item.supplierCost} USDT\` | Retail: \`${item.sellingPrice} USDT\` | Stock: ${item.stock}\n` +
          `  Rule: *${item.pricingRule}* | Status: ${item.isHidden ? '🙈 Hidden' : '👁️ Visible'}\n\n`;

        rows.push(
          ButtonBuilder.buildActionRow([
            ButtonBuilder.buildButton({
              text: `Price: ${item.name.substring(0, 18)}`,
              fallbackEmoji: '💲',
              style: 'primary',
              callbackData: `adm_pr:${item.id}`,
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
              callbackData: page > 1 ? `adm:prod:${page - 1}` : 'noop',
            }),
            ButtonBuilder.buildButton({ text: `${page}/${totalPages}`, style: 'default', callbackData: 'noop' }),
            ButtonBuilder.buildButton({
              text: 'NEXT ➡️',
              style: page < totalPages ? 'primary' : 'default',
              callbackData: page < totalPages ? `adm:prod:${page + 1}` : 'noop',
            }),
          ])
        );
      }

      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main' }),
        ])
      );

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
      const text =
        `💲 *EDIT PRODUCT PRICING*\n\n` +
        `Product: *${product.original_name}*\n` +
        `Supplier Cost: \`${priceInfo.supplierCost.toFixed(4)} USDT\`\n` +
        `Current Retail: \`${priceInfo.customerUnitPrice.toFixed(2)} USDT\`\n` +
        `Active Rule: *${priceInfo.ruleApplied}*\n\n` +
        `Choose a pricing adjustment:`;

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: '+0.05 Fixed Markup', style: 'primary', callbackData: `adm_set_fm:${productId}:0.05` }),
              ButtonBuilder.buildButton({ text: '+0.10 Fixed Markup', style: 'primary', callbackData: `adm_set_fm:${productId}:0.10` }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: '+0.25 Fixed Markup', style: 'primary', callbackData: `adm_set_fm:${productId}:0.25` }),
              ButtonBuilder.buildButton({ text: '+0.50 Fixed Markup', style: 'primary', callbackData: `adm_set_fm:${productId}:0.50` }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'Reset to Default Pricing', fallbackEmoji: '🔄', style: 'danger', callbackData: `adm_reset_pr:${productId}` }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'BACK TO PRODUCTS', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:prod:1' }),
            ]),
          ],
        },
      });
      return;
    }

    // Apply Fixed Markup
    if (data.startsWith('adm_set_fm:')) {
      const [, productId, markupStr] = data.split(':');
      await pricingService.setFixedMarkup(productId, markupStr, userId);
      const newPrice = await pricingService.calculatePrice(productId);
      await telegramClient.sendMessage(
        chatId,
        `✅ *PRICING UPDATED*\n\nFixed markup of \`+${markupStr} USDT\` saved. New retail price is \`${newPrice.customerUnitPrice.toFixed(2)} USDT\`.\nCustomer catalogue reflects this immediately without server restart.`,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'BACK TO PRODUCTS', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:prod:1' }),
              ]),
            ],
          },
        }
      );
      return;
    }

    // Reset Pricing
    if (data.startsWith('adm_reset_pr:')) {
      const [, productId] = data.split(':');
      await pricingService.resetPricing(productId, userId);
      await telegramClient.sendMessage(chatId, '✅ *PRICING RESET*\n\nProduct pricing reset to global default rule.', {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'BACK TO PRODUCTS', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:prod:1' }),
            ]),
          ],
        },
      });
      return;
    }

    // System Health & Diagnostics
    if (data === 'adm:hlth') {
      const binanceTest = await binanceService.testReadOnlyVerification();
      const sanitized: any = getSanitizedConfig();
      const receiverConfigured = Boolean(binanceService.getReceiverId());

      const text =
        `🩺 *SYSTEM HEALTH & DIAGNOSTICS*\n\n` +
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
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main' }),
            ]),
          ],
        },
      });
      return;
    }

    // =========================================================================
    // ADMIN UI CUSTOMIZATION CENTER
    // =========================================================================

    if (data === 'adm:ui') {
      await redis.clearFsmState(userId);
      const text =
        `🎨 *UI & BUTTONS CUSTOMIZATION CENTER*\n\n` +
        `Edit button text, colors (\`primary\` Blue, \`success\` Green, \`danger\` Red, \`default\`), custom emojis, fallback Unicode emojis, visibility, and messages — saved persistently in PostgreSQL with instant live refresh.`;
      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: getAdminUiCenterKeyboard(),
      });
      return;
    }

    // Section list: adm:uis:<section>:<page>
    if (data.startsWith('adm:uis:')) {
      const [, , sectionRaw, pageStr = '1'] = data.split(':');
      const section = sectionRaw as UISection;
      const page = Math.max(1, parseInt(pageStr, 10));
      const allItems = await uiConfigService.listBySection(section, 'en');
      const pageSize = 6;
      const totalPages = Math.max(1, Math.ceil(allItems.length / pageSize));
      const safePage = Math.min(page, totalPages);
      const slice = allItems.slice((safePage - 1) * pageSize, safePage * pageSize);

      const text =
        `🎨 *EDIT UI SECTION: ${section.toUpperCase()}*\n\n` +
        `Select any button or text item below to customize its text, color style, custom emoji, or visibility:`;
      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: getAdminUiSectionKeyboard(section, slice, safePage, totalPages, 'en'),
      });
      return;
    }

    // Item Editor: adm:uie:<settingKey>:<lang>
    if (data.startsWith('adm:uie:')) {
      const [, , settingKey, langRaw = 'en'] = data.split(':');
      const lang = langRaw as SupportedLanguage;
      const item = uiConfigService.getCachedSetting(settingKey, lang);
      if (!item) return;
      await this.renderUiItemEditor(chatId, messageId, item);
      return;
    }

    // Prompt Edit Text: adm:uit:<settingKey>:<lang>
    if (data.startsWith('adm:uit:')) {
      const [, , settingKey, langRaw = 'en'] = data.split(':');
      await redis.setFsmState(userId, {
        step: 'ADMIN_UI_EDIT_TEXT',
        data: { settingKey, lang: langRaw },
      });
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `✏️ *EDIT TEXT FOR* \`${settingKey}\` (*${langRaw.toUpperCase()}*)\n\nSend the new text in your next message:`,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'CANCEL', fallbackEmoji: '❌', style: 'danger', callbackData: `adm:uie:${settingKey}:${langRaw}` }),
              ]),
            ],
          },
        }
      );
      return;
    }

    // Prompt Edit Emoji: adm:uiem:<settingKey>:<lang>
    if (data.startsWith('adm:uiem:')) {
      const [, , settingKey, langRaw = 'en'] = data.split(':');
      await redis.setFsmState(userId, {
        step: 'ADMIN_UI_EDIT_EMOJI',
        data: { settingKey, lang: langRaw },
      });
      const prompt =
        `😀 *EDIT EMOJI FOR* \`${settingKey}\` (*${langRaw.toUpperCase()}*)\n\n` +
        `You can reply with ANY of the following:\n` +
        `1. Send a Telegram **Custom Emoji** directly (we extract its \`custom_emoji_id\` automatically)\n` +
        `2. Paste a numeric **Custom Emoji ID** string (e.g. \`542385311234567890\`)\n` +
        `3. Send a standard Unicode emoji (e.g. \`🚀\`) to update the fallback icon\n` +
        `4. Send \`clear\` to remove the custom emoji ID`;
      await telegramClient.editMessageText(chatId, messageId, prompt, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'CANCEL', fallbackEmoji: '❌', style: 'danger', callbackData: `adm:uie:${settingKey}:${langRaw}` }),
            ]),
          ],
        },
      });
      return;
    }

    // Set Button Style: adm:uist:<settingKey>:<lang>:<style>
    if (data.startsWith('adm:uist:')) {
      const [, , settingKey, langRaw = 'en', styleRaw = 'default'] = data.split(':');
      const updated = await uiConfigService.upsertSetting({
        settingKey,
        languageCode: langRaw as SupportedLanguage,
        buttonStyle: styleRaw as ButtonStyle,
        adminId: userId,
      });
      await this.renderUiItemEditor(chatId, messageId, updated, `✅ Style updated to *${updated.buttonStyle}*`);
      return;
    }

    // Toggle Visibility: adm:uiv:<settingKey>:<lang>
    if (data.startsWith('adm:uiv:')) {
      const [, , settingKey, langRaw = 'en'] = data.split(':');
      const current = uiConfigService.getCachedSetting(settingKey, langRaw as SupportedLanguage);
      if (!current) return;
      const updated = await uiConfigService.upsertSetting({
        settingKey,
        languageCode: langRaw as SupportedLanguage,
        isVisible: !current.isVisible,
        adminId: userId,
      });
      await this.renderUiItemEditor(
        chatId,
        messageId,
        updated,
        `✅ Visibility updated to *${updated.isVisible ? 'VISIBLE' : 'HIDDEN'}*`
      );
      return;
    }

    // Reset Single Item: adm:uir:<settingKey>:<lang>
    if (data.startsWith('adm:uir:')) {
      const [, , settingKey, langRaw = 'en'] = data.split(':');
      const updated = await uiConfigService.resetSetting(settingKey, langRaw as SupportedLanguage, userId);
      if (updated) {
        await this.renderUiItemEditor(chatId, messageId, updated, '🔄 Reset to factory default.');
      }
      return;
    }

    // Reset Section: adm:ui_rs:<section>:<lang>
    if (data.startsWith('adm:ui_rs:')) {
      const [, , sectionRaw, langRaw = 'en'] = data.split(':');
      const count = await uiConfigService.resetSection(sectionRaw as UISection, langRaw as SupportedLanguage, userId);
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `🔄 Reset *${count}* items in section \`${sectionRaw}\` (${langRaw.toUpperCase()}) to defaults.`,
        { reply_markup: getAdminUiCenterKeyboard() }
      );
      return;
    }

    // Export UI JSON
    if (data === 'adm:ui_exp') {
      const exported = await uiConfigService.exportSettingsJson();
      const preview = exported.length > 3200 ? exported.slice(0, 3200) + '\n... (truncated)' : exported;
      await telegramClient.sendMessage(chatId, `📤 *UI CONFIGURATION EXPORT (JSON)*\n\n\`\`\`json\n${preview}\n\`\`\``, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'BACK TO UI CENTER', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:ui' }),
            ]),
          ],
        },
      });
      return;
    }

    // Import UI JSON prompt
    if (data === 'adm:ui_imp') {
      await redis.setFsmState(userId, { step: 'ADMIN_UI_IMPORT_JSON' });
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `📥 *IMPORT UI CONFIGURATION (JSON)*\n\nPaste a valid exported XERO KHAN UI JSON payload in your next message:`,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'CANCEL', fallbackEmoji: '❌', style: 'danger', callbackData: 'adm:ui' }),
              ]),
            ],
          },
        }
      );
      return;
    }

    // Reset ALL UI confirmation prompt
    if (data === 'adm:ui_rst_all') {
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `⚠️ *CONFIRM RESET ALL UI DEFAULTS*\n\nThis will restore every customized button text, color style, custom emoji, and message across all languages back to factory defaults.\n\nProceed?`,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'YES, RESET ALL UI', fallbackEmoji: '⚠️', style: 'danger', callbackData: 'adm:ui_rst_all_c' }),
                ButtonBuilder.buildButton({ text: 'CANCEL', fallbackEmoji: '❌', style: 'default', callbackData: 'adm:ui' }),
              ]),
            ],
          },
        }
      );
      return;
    }

    // Execute Reset ALL UI
    if (data === 'adm:ui_rst_all_c') {
      const count = await uiConfigService.resetAllSettings(userId);
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `✅ *ALL UI DEFAULTS RESTORED*\n\nRestored ${count} localized UI records to defaults.`,
        { reply_markup: getAdminUiCenterKeyboard() }
      );
      return;
    }
  }

  /**
   * Handle admin FSM text/emoji inputs with strict server-side authorization
   */
  public async handleAdminTextInput(msg: TelegramMessage, fsm: UserFsmState): Promise<void> {
    if (!msg.from || !msg.text) return;
    const userId = String(msg.from.id);
    const chatId = msg.chat.id;

    if (!this.checkAuthorization(userId)) {
      await redis.clearFsmState(userId);
      await telegramClient.sendMessage(chatId, '⛔ *ACCESS DENIED*');
      return;
    }

    const text = msg.text.trim();

    if (fsm.step === 'ADMIN_UI_EDIT_TEXT') {
      const { settingKey, lang = 'en' } = fsm.data || {};
      try {
        const updated = await uiConfigService.upsertSetting({
          settingKey,
          languageCode: lang,
          textValue: text,
          adminId: userId,
        });
        await redis.clearFsmState(userId);
        await this.renderUiItemEditor(chatId, undefined, updated, '✅ Text saved & applied live!');
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ *VALIDATION ERROR*\n\n${err.message}\n\nPlease try again:`);
      }
      return;
    }

    if (fsm.step === 'ADMIN_UI_EDIT_EMOJI') {
      const { settingKey, lang = 'en' } = fsm.data || {};
      try {
        // 1. Check Telegram message entities for custom_emoji
        const customEntity = [...(msg.entities || []), ...(msg.caption_entities || [])].find(
          e => e.type === 'custom_emoji' && e.custom_emoji_id
        );

        let updated: UISettingRecord;
        let notice: string;

        if (customEntity?.custom_emoji_id) {
          updated = await uiConfigService.upsertSetting({
            settingKey,
            languageCode: lang,
            customEmojiId: String(customEntity.custom_emoji_id),
            adminId: userId,
          });
          notice = `✅ Captured Telegram Custom Emoji ID \`${updated.customEmojiId}\`!`;
        } else if (text.toLowerCase() === 'clear' || text.toLowerCase() === 'none') {
          updated = await uiConfigService.upsertSetting({
            settingKey,
            languageCode: lang,
            customEmojiId: null,
            adminId: userId,
          });
          notice = '✅ Custom emoji cleared; Unicode fallback active.';
        } else if (/^\d{5,30}$/.test(text)) {
          updated = await uiConfigService.upsertSetting({
            settingKey,
            languageCode: lang,
            customEmojiId: text,
            adminId: userId,
          });
          notice = `✅ Saved Custom Emoji ID \`${updated.customEmojiId}\`!`;
        } else {
          updated = await uiConfigService.upsertSetting({
            settingKey,
            languageCode: lang,
            fallbackEmoji: text,
            adminId: userId,
          });
          notice = `✅ Updated fallback Unicode emoji to ${updated.fallbackEmoji || '(none)'}!`;
        }

        await redis.clearFsmState(userId);
        await this.renderUiItemEditor(chatId, undefined, updated, notice);
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ *VALIDATION ERROR*\n\n${err.message}\n\nPlease try again:`);
      }
      return;
    }

    if (fsm.step === 'ADMIN_UI_IMPORT_JSON') {
      try {
        const res = await uiConfigService.importSettingsJson(text, userId);
        await redis.clearFsmState(userId);
        await telegramClient.sendMessage(
          chatId,
          `✅ *UI IMPORT SUCCESSFUL*\n\nValidated and imported *${res.imported}* UI settings live.`,
          { reply_markup: getAdminUiCenterKeyboard() }
        );
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ *IMPORT REJECTED*\n\n${err.message}\n\nPlease fix the JSON and try again:`);
      }
      return;
    }
  }

  private async renderUiItemEditor(
    chatId: number,
    messageId: number | undefined,
    item: UISettingRecord,
    notice?: string
  ): Promise<void> {
    const previewBtn = ButtonBuilder.buildButton({
      settingKey: item.settingKey,
      lang: item.languageCode,
      callbackData: 'noop',
      forceVisible: true,
    });

    const text =
      (notice ? `${notice}\n\n` : '') +
      `🎛️ *UI ITEM EDITOR*\n\n` +
      `• Key: \`${item.settingKey}\`\n` +
      `• Section: *${item.section}*\n` +
      `• Language: *${item.languageCode.toUpperCase()}*\n` +
      `• Text: \`${item.textValue.slice(0, 120)}${item.textValue.length > 120 ? '...' : ''}\`\n` +
      `• Fallback Emoji: ${item.fallbackEmoji || '_None_'}\n` +
      `• Custom Emoji ID: ${item.customEmojiId ? `\`${item.customEmojiId}\`` : '_None_'}\n` +
      `• Color Style: *${item.buttonStyle}*\n` +
      `• Visibility: *${item.isVisible ? '👁️ VISIBLE' : '🙈 HIDDEN'}*\n\n` +
      `• Live Button Preview: *${previewBtn?.text || item.textValue}*`;

    const markup = getAdminUiItemEditorKeyboard(item);
    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: markup });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: markup });
    }
  }
}

export const adminHandler = new AdminHandler();
