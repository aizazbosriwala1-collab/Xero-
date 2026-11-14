import Decimal from 'decimal.js';
import { db } from '../../db/index.js';
import { redis } from '../../services/redis.js';
import { config, getSanitizedConfig } from '../../config/env.js';
import {
  supplierService,
  SupplierControlFlag,
  SupplierReadOnlyDiagnosticResult,
  maskSupplierRef,
} from '../../services/supplier.js';
import { pricingService } from '../../services/pricing.js';
import { orderService } from '../../services/order.js';
import { giveawayService, GiveawayRewardType } from '../../services/giveaway.js';
import { announcementService, AnnouncementMediaType } from '../../services/announcement.js';
import { referralService } from '../../services/referral.js';
import { channelService } from '../../services/channel.js';
import { settingsService } from '../../services/settings.js';
import { launchAuditService } from '../../services/audit.js';
import { manualPaymentService } from '../../services/manualPayment.js';
import {
  binanceService,
  BINANCE_DIAGNOSTIC_FIXED_WINDOW,
  BinanceReadOnlyDiagnosticResult,
  maskIdentifier,
} from '../../services/binance.js';
import { uiConfigService, UISection, UISettingRecord } from '../../services/uiConfig.js';
import { SupportedLanguage, getUserLanguage, t } from '../../services/i18n.js';
import { ButtonBuilder } from '../buttonBuilder.js';
import {
  getAdminMainMenuKeyboard,
  getAdminUiCenterKeyboard,
  getAdminUiSectionKeyboard,
  getAdminUiItemEditorKeyboard,
  getBackHomeKeyboard,
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
        await pricingService.invalidateCategoryCache();
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

    // Recent Orders & Uncertain Orders Overview
    if (data === 'adm:ord' || data === 'adm:ord_unc') {
      const uncertainOnly = data === 'adm:ord_unc';
      const orders = await orderService.listAdminOrders(8, uncertainOnly);

      let text = uncertainOnly
        ? `⚠️ *UNCERTAIN CUSTOMER ORDERS*\n\nTap any order below to open details and reconcile safely:\n\n`
        : `📦 *RECENT CUSTOMER ORDERS*\n\nTap any order below to inspect details (⚠️ *UNCERTAIN* orders listed first):\n\n`;

      const rows: any[][] = [];
      if (orders.length === 0) {
        text += uncertainOnly
          ? `_No UNCERTAIN orders pending review._`
          : `_No customer orders placed yet._`;
      } else {
        for (const o of orders) {
          const isUncertain = o.status === 'UNCERTAIN';
          const badge = isUncertain ? '⚠️' : o.status === 'COMPLETED' ? '✅' : '📦';
          const refLabel = o.supplierOrderRef ? maskSupplierRef(o.supplierOrderRef) : 'NO REF';
          text += `${badge} \`${o.id}\` | User: \`${o.userId}\` | \`${o.totalPrice} USDT\` | *${o.status}* | Ref: \`${refLabel}\`\n`;
          rows.push(
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: `${o.id} (${o.status})`,
                fallbackEmoji: badge,
                style: isUncertain ? 'danger' : 'default',
                callbackData: `adm:ord_det:${o.id}`,
                forceVisible: true,
              }),
            ])
          );
        }
      }

      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: uncertainOnly ? 'ALL RECENT ORDERS' : 'UNCERTAIN ORDERS ONLY',
            fallbackEmoji: uncertainOnly ? '📦' : '⚠️',
            style: 'primary',
            callbackData: uncertainOnly ? 'adm:ord' : 'adm:ord_unc',
            forceVisible: true,
          }),
        ])
      );
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
        ])
      );

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: { inline_keyboard: rows },
      });
      return;
    }

    // Admin Order Detail Screen
    if (data.startsWith('adm:ord_det:')) {
      const orderId = data.slice('adm:ord_det:'.length);
      const detail = await orderService.getAdminOrderDetail(orderId);
      if (!detail) {
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `⚠️ *ORDER NOT FOUND*\n\nOrder \`${this.escapeDiagMarkdown(orderId)}\` could not be found.`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Back', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:ord', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      await telegramClient.editMessageText(chatId, messageId, this.formatAdminOrderDetailText(detail), {
        reply_markup: this.getAdminOrderDetailKeyboard(detail.id),
      });
      return;
    }

    // Admin Order Action: Read-Only Supplier Lookup (GET /order/{ref})
    if (data.startsWith('adm:ord_lkp:')) {
      const orderId = data.slice('adm:ord_lkp:'.length);
      const detail = await orderService.getAdminOrderDetail(orderId);
      if (!detail) {
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `⚠️ *ORDER NOT FOUND*\n\nOrder \`${this.escapeDiagMarkdown(orderId)}\` could not be found.`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Back', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:ord', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      const lookup = await supplierService.lookupOrderReadOnly({
        supplierOrderRef: detail.supplierOrderRef,
        idempotencyKey: detail.idempotencyKey,
      });

      await this.recordOrderAuditLog(userId, 'ADMIN_ORDER_SUPPLIER_LOOKUP', orderId, {
        mode: 'READ_ONLY',
        newOrderPlaced: false,
        walletDebitCreated: false,
        refundCreated: false,
        lookupMethod: lookup.lookupMethod,
        httpStatus: lookup.httpStatus,
        found: lookup.found,
        lookupStatus: lookup.status,
        supplierOrderRef: lookup.order_ref || detail.supplierOrderRef || null,
        credentialsPresent: (lookup.delivered_items?.length || 0) > 0,
        credentialsCount: lookup.delivered_items?.length || 0,
      });

      const resolvedRef = lookup.order_ref || detail.supplierOrderRef || 'NONE';
      const credCount = lookup.delivered_items?.length || 0;
      const text =
        `🔎 *SUPPLIER ORDER LOOKUP (READ-ONLY)*\n\n` +
        `• Local Order ID: \`${detail.id}\`\n` +
        `• Supplier Order Ref: \`${this.escapeDiagMarkdown(String(resolvedRef))}\`\n` +
        `• Current Local Status: *${detail.status}*\n\n` +
        `📡 *Supplier API Response:*\n` +
        `• Lookup Method: \`${lookup.lookupMethod}\`\n` +
        `• HTTP Status: \`${lookup.httpStatus}\`\n` +
        `• Found: \`${lookup.found ? 'YES' : 'NO'}\`\n` +
        `• Normalized Status: *${lookup.status.toUpperCase()}*\n` +
        `• Credentials Available: *${credCount > 0 ? `YES (${credCount})` : 'NO'}*\n` +
        `• Diagnostic Message: ${this.escapeDiagMarkdown(lookup.message || 'OK')}\n\n` +
        `_Strictly read-only (GET /order/{ref}). No local state, balance, or order was modified._`;

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: 'Reconcile Order',
                fallbackEmoji: '🔄',
                style: 'success',
                callbackData: `adm:ord_rec:${detail.id}`,
                forceVisible: true,
              }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: 'View Status History',
                fallbackEmoji: '📜',
                style: 'default',
                callbackData: `adm:ord_hst:${detail.id}`,
                forceVisible: true,
              }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: 'Back',
                fallbackEmoji: '⬅️',
                style: 'default',
                callbackData: `adm:ord_det:${detail.id}`,
                forceVisible: true,
              }),
            ]),
          ],
        },
      });
      return;
    }

    // Admin Order Action: Safe Reconcile Order (never places new order, never debits, never refunds)
    if (data.startsWith('adm:ord_rec:')) {
      const orderId = data.slice('adm:ord_rec:'.length);
      const beforeDetail = await orderService.getAdminOrderDetail(orderId);
      if (!beforeDetail) {
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `⚠️ *ORDER NOT FOUND*\n\nOrder \`${this.escapeDiagMarkdown(orderId)}\` could not be found.`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Back', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:ord', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      const recon = await orderService.reconcileUncertainOrder(orderId, { allowRefund: false });
      const afterDetail = await orderService.getAdminOrderDetail(orderId);

      let customerDelivered = false;
      let deliveryError: string | undefined;

      if (recon.status === 'COMPLETED' && recon.newlyCompleted) {
        try {
          const custLang = await getUserLanguage(beforeDetail.userId);
          let custMsg = `${t('order_success', custLang, { orderId: recon.orderId })}\n\n`;
          if (recon.deliveredItems.length > 0) {
            custMsg += `\`\`\`\n${recon.deliveredItems.join('\n')}\n\`\`\``;
          } else {
            custMsg += `_Status: ${recon.status}. Your access invite has been fulfilled._`;
          }
          await telegramClient.sendMessage(Number(beforeDetail.userId), custMsg, {
            reply_markup: getBackHomeKeyboard('m:ord', custLang),
          });
          customerDelivered = true;
        } catch (err: any) {
          deliveryError = err?.message || 'Telegram DM delivery failed';
          logger.error('Admin reconciliation succeeded but XERO KHAN customer DM delivery failed', {
            orderId: recon.orderId,
            error: deliveryError,
          });
        }
      }

      await this.recordOrderAuditLog(userId, 'ADMIN_ORDER_RECONCILE', orderId, {
        previousStatus: beforeDetail.status,
        resultingStatus: recon.status,
        newlyCompleted: recon.newlyCompleted,
        lookupMethod: recon.lookupMethod || 'NONE',
        lookupStatus: recon.lookupStatus || 'UNKNOWN',
        httpStatus: recon.httpStatus ?? 0,
        supplierOrderRef: afterDetail?.supplierOrderRef || recon.supplierOrderRef || null,
        storedSupplierStatus: afterDetail?.supplierStatus || null,
        deliveredItemsCount: afterDetail?.deliveredCount ?? recon.deliveredItems.length,
        credentialsEncrypted: (afterDetail?.deliveredCount ?? 0) > 0,
        customerDelivered,
        deliveryError: deliveryError || null,
        diagnosticReason: recon.message,
        newOrderPlaced: false,
        walletDebitCreated: false,
        refundCreated: false,
      });

      const resolvedRef = afterDetail?.supplierOrderRef || recon.supplierOrderRef || 'NONE';
      const storedSupStatus = afterDetail?.supplierStatus || 'NONE';
      const deliveredCount = afterDetail?.deliveredCount ?? recon.deliveredItems.length;

      let report: string;
      if (recon.status === 'COMPLETED') {
        const deliveryLine = recon.newlyCompleted
          ? customerDelivered
            ? `• Customer Delivery: *DELIVERED via XERO KHAN* (User \`${beforeDetail.userId}\`)\n`
            : `• Customer Delivery: ⚠️ *DM FAILED* (${this.escapeDiagMarkdown(deliveryError || 'Unknown')})\n`
          : `• Customer Delivery: *ALREADY COMPLETED PRIOR*\n`;

        report =
          `✅ *ORDER RECONCILED & COMPLETED*\n\n` +
          `• Local Order ID: \`${recon.orderId}\`\n` +
          `• Supplier Order Ref: \`${this.escapeDiagMarkdown(String(resolvedRef))}\`\n` +
          `• Local Status: *COMPLETED*\n` +
          `• Stored Supplier Status: *${this.escapeDiagMarkdown(storedSupStatus)}*\n` +
          `• Delivered Items Created: *${deliveredCount}* (Encrypted AES-256-GCM)\n` +
          deliveryLine +
          `\n🛡️ *Safety Guarantees:*\n` +
          `• Lookup Used: \`${recon.lookupMethod || 'GET /order/{ref}'}\` (HTTP \`${recon.httpStatus ?? 0}\`)\n` +
          `• New Supplier Order Placed: *NO*\n` +
          `• New Wallet Debit / Refund: *NO*`;
      } else {
        report =
          `⚠️ *RECONCILIATION UNRESOLVED — STILL ${recon.status}*\n\n` +
          `• Local Order ID: \`${recon.orderId}\`\n` +
          `• Supplier Order Ref: \`${this.escapeDiagMarkdown(String(resolvedRef))}\`\n` +
          `• Local Status: *${recon.status}*\n` +
          `• Stored Supplier Status: *${this.escapeDiagMarkdown(storedSupStatus)}*\n` +
          `• Lookup Method: \`${recon.lookupMethod || 'NONE'}\` (HTTP \`${recon.httpStatus ?? 0}\`)\n` +
          `• Diagnostic Reason: ${this.escapeDiagMarkdown(recon.message)}\n\n` +
          `🛡️ *Safety Guarantees:*\n` +
          `• New Supplier Order Placed: *NO*\n` +
          `• New Wallet Debit: *NO*\n` +
          `• Refund Issued: *NO*`;
      }

      await telegramClient.editMessageText(chatId, messageId, report, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: 'View Status History',
                fallbackEmoji: '📜',
                style: 'default',
                callbackData: `adm:ord_hst:${orderId}`,
                forceVisible: true,
              }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: 'Back',
                fallbackEmoji: '⬅️',
                style: 'default',
                callbackData: `adm:ord_det:${orderId}`,
                forceVisible: true,
              }),
            ]),
          ],
        },
      });
      return;
    }

    // Admin Order Action: View Status History
    if (data.startsWith('adm:ord_hst:')) {
      const orderId = data.slice('adm:ord_hst:'.length);
      const hist = await orderService.getAdminOrderStatusHistory(orderId);
      if (!hist) {
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `⚠️ *ORDER NOT FOUND*\n\nOrder \`${this.escapeDiagMarkdown(orderId)}\` could not be found.`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Back', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:ord', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      await this.recordOrderAuditLog(userId, 'ADMIN_ORDER_HISTORY_VIEWED', orderId, {
        currentStatus: hist.order.status,
        supplierStatus: hist.supplierOrder?.supplierStatus || null,
      });

      const createdIso = new Date(hist.order.createdAt).toISOString();
      const updatedIso = new Date(hist.order.updatedAt).toISOString();

      let text =
        `📜 *ORDER STATUS HISTORY*\n\n` +
        `• Local Order ID: \`${hist.order.id}\`\n` +
        `• Local Status: *${hist.order.status}*\n` +
        `• Created: \`${createdIso}\`\n` +
        `• Last Updated: \`${updatedIso}\`\n` +
        (hist.order.errorMessage
          ? `• Diagnostic Note: ${this.escapeDiagMarkdown(hist.order.errorMessage)}\n`
          : '');

      if (hist.supplierOrder) {
        text +=
          `\n📡 *Supplier Record:*\n` +
          `• Supplier Order Ref: \`${this.escapeDiagMarkdown(hist.supplierOrder.supplierOrderRef || 'NONE')}\`\n` +
          `• Supplier Status: *${this.escapeDiagMarkdown(hist.supplierOrder.supplierStatus)}*\n` +
          `• Updated: \`${new Date(hist.supplierOrder.updatedAt).toISOString()}\`\n`;
      } else {
        text += `\n📡 *Supplier Record:* _None stored yet._\n`;
      }

      text +=
        `\n🔐 *Delivered Items:* \`${hist.deliveredCount}\` encrypted item(s)` +
        (hist.firstDeliveredAt ? ` (at \`${new Date(hist.firstDeliveredAt).toISOString()}\`)` : '') +
        `\n`;

      text += `\n📒 *Wallet Ledger Entries (${hist.ledgerEntries.length}):*\n`;
      if (hist.ledgerEntries.length === 0) {
        text += `• _None recorded_\n`;
      } else {
        for (const le of hist.ledgerEntries) {
          text += `• *${le.entryType}*: \`${le.amount} USDT\` (\`${le.operationRef}\`)\n`;
        }
      }

      text += `\n🛡️ *Admin Audit Trail:*\n`;
      if (hist.auditLogs.length === 0) {
        text += `• _No prior admin actions_`;
      } else {
        for (const al of hist.auditLogs.slice(0, 5)) {
          text += `• \`${al.action}\` by \`${al.adminId}\` at \`${new Date(al.createdAt).toISOString()}\`\n`;
        }
      }

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: 'Back',
                fallbackEmoji: '⬅️',
                style: 'default',
                callbackData: `adm:ord_det:${orderId}`,
                forceVisible: true,
              }),
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

    // =========================================================================
    // GIVEAWAYS SYSTEM MANAGEMENT (BUILDER / EDITOR / FILTERED VIEWS)
    // =========================================================================
    if (
      data === 'adm:gw' ||
      data === 'adm:gw_act' ||
      data === 'adm:gw_fin' ||
      data.startsWith('adm:gw_tog:') ||
      data.startsWith('adm:gw_vis:')
    ) {
      let filter: 'active' | 'finished' | 'all' = 'all';
      if (data === 'adm:gw_act') filter = 'active';
      if (data === 'adm:gw_fin') filter = 'finished';

      if (data.startsWith('adm:gw_tog:')) {
        const gwId = data.slice('adm:gw_tog:'.length);
        const curr = await giveawayService.getGiveawayById(gwId);
        if (curr) {
          await giveawayService.setGiveawayActive(gwId, !curr.isActive, userId);
          await this.renderAdminGiveawayDetail(chatId, messageId, gwId, !curr.isActive ? '✅ Giveaway enabled.' : '⏸️ Giveaway disabled.');
          return;
        }
      }

      if (data.startsWith('adm:gw_vis:')) {
        const gwId = data.slice('adm:gw_vis:'.length);
        const curr = await giveawayService.getGiveawayById(gwId);
        if (curr) {
          await giveawayService.updateGiveaway(gwId, { isPublic: !curr.isPublic }, userId);
          await this.renderAdminGiveawayDetail(chatId, messageId, gwId, !curr.isPublic ? '👁️ Visibility set to PUBLIC.' : '🙈 Visibility set to PRIVATE.');
          return;
        }
      }

      const gws = await giveawayService.listAdminGiveaways(filter);
      const headerLabel =
        filter === 'active' ? 'ACTIVE GIVEAWAYS' : filter === 'finished' ? 'FINISHED GIVEAWAYS' : 'GIVEAWAYS CONTROL CENTER';
      let text = `🎁 *${headerLabel}*\n\n`;
      const rows: any[][] = [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Create Giveaway', fallbackEmoji: '➕', style: 'success', callbackData: 'adm:gw_new', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Active', fallbackEmoji: '🟢', style: filter === 'active' ? 'primary' : 'default', callbackData: 'adm:gw_act', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Finished', fallbackEmoji: '🏁', style: filter === 'finished' ? 'primary' : 'default', callbackData: 'adm:gw_fin', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'All', fallbackEmoji: '📋', style: filter === 'all' ? 'primary' : 'default', callbackData: 'adm:gw', forceVisible: true }),
        ]),
      ];

      if (gws.length === 0) {
        text += `_No ${filter === 'all' ? '' : `${filter} `}giveaways found._\n`;
      } else {
        for (const g of gws.slice(0, 10)) {
          const icon = g.isActive ? '✅' : '⚠️';
          text += `${icon} *${this.escapeDiagMarkdown(g.title)}*\n   Reward: ${this.escapeDiagMarkdown(g.rewardProductName)} x${g.rewardQuantity} | Req: ${g.requiredQualifiedReferrals}Q/${g.requiredTotalReferrals}T | Claims: ${g.claimsCount}/${g.claimLimit}\n`;
          rows.push(
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: `${g.isActive ? '✅' : '⏸️'} ${g.title.slice(0, 28)}`,
                style: g.isActive ? 'primary' : 'default',
                callbackData: `adm:gw_v:${g.id}`,
                forceVisible: true,
              }),
            ])
          );
        }
      }

      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
        ])
      );
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
      return;
    }

    if (data === 'adm:gw_new' || data === 'adm:gw_draft_vis' || data === 'adm:gw_draft_act') {
      const draftKey = `gw_draft:${userId}`;
      const existingRaw = data === 'adm:gw_new' ? null : await redis.get(draftKey).catch(() => null);
      const draft = existingRaw
        ? JSON.parse(existingRaw)
        : {
            title: '',
            description: '',
            rewardType: 'STORE_PRODUCT' as GiveawayRewardType,
            rewardProductId: '',
            rewardProductName: '',
            rewardLabel: '',
            rewardAmountUsdt: '0.00',
            rewardQuantity: 1,
            requiredTotalReferrals: 0,
            requiredQualifiedReferrals: 3,
            claimLimit: 50,
            startAt: null,
            endAt: null,
            isActive: true,
            isPublic: true,
          };

      if (data === 'adm:gw_draft_vis') draft.isPublic = !draft.isPublic;
      if (data === 'adm:gw_draft_act') draft.isActive = !draft.isActive;
      await redis.set(draftKey, JSON.stringify(draft), 1800);
      await this.renderAdminGiveawayDraft(chatId, messageId, draft);
      return;
    }

    if (data.startsWith('adm:gw_rt:')) {
      const rest = data.slice('adm:gw_rt:'.length);
      const lastColon = rest.lastIndexOf(':');
      const targetId = lastColon > 0 ? rest.slice(0, lastColon) : 'draft';
      const shortType = lastColon > 0 ? rest.slice(lastColon + 1) : 'store';
      const rewardType: GiveawayRewardType =
        shortType === 'custom' ? 'CUSTOM_PRODUCT' : shortType === 'wallet' ? 'WALLET_CREDIT' : 'STORE_PRODUCT';

      if (targetId === 'draft') {
        const draftKey = `gw_draft:${userId}`;
        const raw = await redis.get(draftKey).catch(() => null);
        const draft = raw
          ? JSON.parse(raw)
          : {
              title: '',
              description: '',
              rewardType,
              rewardProductId: '',
              rewardProductName: '',
              rewardLabel: '',
              rewardAmountUsdt: '0.00',
              rewardQuantity: 1,
              requiredTotalReferrals: 0,
              requiredQualifiedReferrals: 3,
              claimLimit: 50,
              startAt: null,
              endAt: null,
              isActive: true,
              isPublic: true,
            };
        draft.rewardType = rewardType;
        if (rewardType === 'CUSTOM_PRODUCT') {
          draft.rewardProductId = '';
          draft.rewardProductName = '';
        } else if (rewardType === 'WALLET_CREDIT') {
          draft.rewardProductId = '';
          draft.rewardProductName = '';
          if (!Number(draft.rewardAmountUsdt)) draft.rewardAmountUsdt = '1.00';
        }
        await redis.set(draftKey, JSON.stringify(draft), 1800);
        await this.renderAdminGiveawayDraft(chatId, messageId, draft, `✅ Reward type set to *${rewardType}*`);
      } else {
        const curr = await giveawayService.getGiveawayById(targetId);
        if (!curr) return;
        const patch: any = { rewardType };
        if (rewardType === 'CUSTOM_PRODUCT' && !curr.rewardLabel) {
          patch.rewardLabel = 'Custom Reward';
        } else if (rewardType === 'WALLET_CREDIT' && Number(curr.rewardAmountUsdt || 0) <= 0) {
          patch.rewardAmountUsdt = '1.00';
        }
        await giveawayService.updateGiveaway(targetId, patch, userId);
        await this.renderAdminGiveawayDetail(chatId, messageId, targetId, `✅ Reward type updated to *${rewardType}*`);
      }
      return;
    }

    if (data === 'adm:gw_draft_save') {
      const raw = await redis.get(`gw_draft:${userId}`).catch(() => null);
      if (!raw) {
        await telegramClient.editMessageText(chatId, messageId, '⚠️ Draft expired. Please start again.', {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'Create Giveaway', fallbackEmoji: '➕', style: 'primary', callbackData: 'adm:gw_new' }),
                ButtonBuilder.buildButton({ text: 'Back', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:gw' }),
              ]),
            ],
          },
        });
        return;
      }

      const draft = JSON.parse(raw);
      try {
        const newId = await giveawayService.createGiveaway(draft, userId);
        await redis.del(`gw_draft:${userId}`).catch(() => {});
        await this.renderAdminGiveawayDetail(chatId, messageId, newId, '✅ Giveaway created & saved to database!');
      } catch (err: any) {
        await this.renderAdminGiveawayDraft(chatId, messageId, draft, `⚠️ ${err.message}`);
      }
      return;
    }

    if (data.startsWith('adm:gw_v:') || data.startsWith('adm:gw_ed:')) {
      const gwId = data.startsWith('adm:gw_v:') ? data.slice('adm:gw_v:'.length) : data.slice('adm:gw_ed:'.length);
      await this.renderAdminGiveawayDetail(chatId, messageId, gwId);
      return;
    }

    if (data.startsWith('adm:gw_del:')) {
      const gwId = data.slice('adm:gw_del:'.length);
      const gw = await giveawayService.getGiveawayById(gwId);
      if (!gw) return;
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `⚠️ *CONFIRM DELETE GIVEAWAY*\n\nDelete *${this.escapeDiagMarkdown(gw.title)}* and all claim records?\nThis cannot be undone.`,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'YES, DELETE', fallbackEmoji: '🗑️', style: 'danger', callbackData: `adm:gw_delc:${gwId}`, forceVisible: true }),
                ButtonBuilder.buildButton({ text: 'Cancel', fallbackEmoji: '❌', style: 'default', callbackData: `adm:gw_v:${gwId}`, forceVisible: true }),
              ]),
            ],
          },
        }
      );
      return;
    }

    if (data.startsWith('adm:gw_delc:')) {
      const gwId = data.slice('adm:gw_delc:'.length);
      await giveawayService.deleteGiveaway(gwId, userId);
      await telegramClient.editMessageText(chatId, messageId, '✅ Giveaway deleted cleanly.', {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'Back to Giveaways', fallbackEmoji: '🎁', style: 'primary', callbackData: 'adm:gw', forceVisible: true }),
            ]),
          ],
        },
      });
      return;
    }

    if (data.startsWith('adm:gw_prod:')) {
      const rest = data.slice('adm:gw_prod:'.length);
      const lastColon = rest.lastIndexOf(':');
      const targetId = lastColon > 0 ? rest.slice(0, lastColon) : 'draft';
      const page = Math.max(1, parseInt(lastColon > 0 ? rest.slice(lastColon + 1) : '1', 10));
      await redis.set(`gw_pick_target:${userId}`, targetId, 900);

      const catalog = await pricingService.getCatalog({ page, pageSize: 6, includeHidden: true });
      const totalPages = Math.max(1, Math.ceil(catalog.total / 6));
      const rows: any[][] = [];
      for (const item of catalog.items) {
        rows.push(
          ButtonBuilder.buildActionRow([
            ButtonBuilder.buildButton({
              text: `${item.name.slice(0, 28)} (${item.sellingPrice} USDT)`,
              style: 'default',
              callbackData: `adm:gws:${item.id}`,
              forceVisible: true,
            }),
          ])
        );
      }
      if (totalPages > 1) {
        rows.push(
          ButtonBuilder.buildActionRow([
            ButtonBuilder.buildButton({ text: '⬅️ Prev', style: 'primary', callbackData: page > 1 ? `adm:gw_prod:${targetId}:${page - 1}` : 'noop', forceVisible: true }),
            ButtonBuilder.buildButton({ text: `${page}/${totalPages}`, style: 'default', callbackData: 'noop', forceVisible: true }),
            ButtonBuilder.buildButton({ text: 'Next ➡️', style: 'primary', callbackData: page < totalPages ? `adm:gw_prod:${targetId}:${page + 1}` : 'noop', forceVisible: true }),
          ])
        );
      }
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'Back',
            fallbackEmoji: '⬅️',
            style: 'default',
            callbackData: targetId === 'draft' ? 'adm:gw_draft_vis' : `adm:gw_v:${targetId}`,
            forceVisible: true,
          }),
        ])
      );
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `🛍️ *SELECT REWARD PRODUCT (FROM DATABASE)*\n\nTotal synced products: \`${catalog.total}\` (Page ${page}/${totalPages}):`,
        { reply_markup: { inline_keyboard: rows } }
      );
      return;
    }

    if (data.startsWith('adm:gws:')) {
      const prodId = data.slice('adm:gws:'.length);
      const targetId = (await redis.get(`gw_pick_target:${userId}`).catch(() => null)) || 'draft';
      const prod = await db.queryRow<any>('SELECT id, original_name FROM supplier_products WHERE id = $1', [prodId]);
      if (!prod) return;

      if (targetId === 'draft') {
        const raw = await redis.get(`gw_draft:${userId}`).catch(() => null);
        const draft = raw ? JSON.parse(raw) : { rewardQuantity: 1, requiredTotalReferrals: 0, requiredQualifiedReferrals: 3, claimLimit: 50, isActive: true, isPublic: true };
        draft.rewardProductId = prod.id;
        draft.rewardProductName = prod.original_name;
        await redis.set(`gw_draft:${userId}`, JSON.stringify(draft), 1800);
        await this.renderAdminGiveawayDraft(chatId, messageId, draft, `✅ Reward product set: *${this.escapeDiagMarkdown(prod.original_name)}*`);
      } else {
        await giveawayService.updateGiveaway(targetId, { rewardProductId: prod.id }, userId);
        await this.renderAdminGiveawayDetail(chatId, messageId, targetId, `✅ Reward product updated to *${this.escapeDiagMarkdown(prod.original_name)}*`);
      }
      return;
    }

    if (data.startsWith('adm:gw_f:')) {
      const rest = data.slice('adm:gw_f:'.length);
      const lastColon = rest.lastIndexOf(':');
      const targetId = rest.slice(0, lastColon);
      const field = rest.slice(lastColon + 1);

      const prompts: Record<string, string> = {
        title: 'Enter *Giveaway Name*:',
        desc: 'Enter *Description* (or send `clear`):',
        clabel: 'Enter *Custom Product Name* (e.g. `CapCut Premium`, `Netflix Private`, `VIP Package`):',
        wamt: 'Enter *Wallet Credit Reward Amount (USDT)* (e.g. `2.50`):',
        qty: 'Enter *Reward Quantity* (integer >= 1):',
        reqq: 'Enter *Required Qualified Referrals* (integer >= 0):',
        reqt: 'Enter *Required Total Referrals* (integer >= 0):',
        lim: 'Enter *Maximum Winners* (`claimLimit`, integer >= 1):',
        start: 'Enter *Start Time* in ISO UTC (e.g. `2026-11-20T00:00:00Z`) or `clear`:',
        end: 'Enter *End Time* in ISO UTC (e.g. `2026-12-01T23:59:59Z`) or `clear`:',
      };
      await redis.setFsmState(userId, {
        step: 'ADMIN_GW_EDIT_VALUE',
        data: { targetId, field },
      });
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `✏️ *EDIT GIVEAWAY FIELD*\n\n${prompts[field] || 'Enter new value:'}`,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({
                  text: 'Cancel',
                  fallbackEmoji: '❌',
                  style: 'danger',
                  callbackData: targetId === 'draft' ? 'adm:gw_draft_vis' : `adm:gw_v:${targetId}`,
                  forceVisible: true,
                }),
              ]),
            ],
          },
        }
      );
      return;
    }

    // =========================================================================
    // ANNOUNCEMENTS & NON-BLOCKING BACKGROUND BROADCAST SYSTEM
    // =========================================================================
    if (data === 'adm:ann' || data === 'adm:ann_hist') {
      const list = await announcementService.listAnnouncements(20);
      const isHist = data === 'adm:ann_hist';
      let text = isHist
        ? `📜 *ANNOUNCEMENT BROADCAST HISTORY*\n\n`
        : `📢 *ANNOUNCEMENTS & BROADCAST CENTER*\n\nCreate text, photo, or banner broadcasts with inline buttons and monitor delivery without blocking customers.\n\n`;

      const rows: any[][] = [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Create Announcement', fallbackEmoji: '➕', style: 'success', callbackData: 'adm:ann_new', forceVisible: true }),
          ButtonBuilder.buildButton({ text: isHist ? 'Overview' : 'Broadcast History', fallbackEmoji: '📜', style: 'primary', callbackData: isHist ? 'adm:ann' : 'adm:ann_hist', forceVisible: true }),
        ]),
      ];

      if (list.length === 0) {
        text += `_No announcements created yet._`;
      } else {
        for (const a of list.slice(0, 8)) {
          const badge =
            a.status === 'COMPLETED' ? '✅' : a.status === 'SENDING' ? '🚀' : a.status === 'CANCELLED' ? '🛑' : '📝';
          text += `${badge} *${this.escapeDiagMarkdown(a.title)}* (${a.mediaType})\n   Status: \`${a.status}\` | Delivered: \`${a.deliveredCount}/${a.totalUsers}\` | Blocked: \`${a.blockedCount}\` | Failed: \`${a.failedCount}\`\n`;
          rows.push(
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: `${badge} ${a.title.slice(0, 26)}`,
                style: a.status === 'SENDING' ? 'success' : 'default',
                callbackData: `adm:ann_v:${a.id}`,
                forceVisible: true,
              }),
            ])
          );
        }
      }

      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
        ])
      );
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
      return;
    }

    if (data === 'adm:ann_new') {
      const draft = {
        title: '',
        messageText: '',
        mediaType: 'TEXT' as AnnouncementMediaType,
        mediaFileId: null as string | null,
        buttons: [] as any[],
      };
      await redis.set(`ann_draft:${userId}`, JSON.stringify(draft), 1800);
      await this.renderAdminAnnouncementDraft(chatId, messageId, draft);
      return;
    }

    if (data.startsWith('adm:ann_mt:')) {
      const rest = data.slice('adm:ann_mt:'.length);
      const lastColon = rest.lastIndexOf(':');
      const targetId = lastColon > 0 ? rest.slice(0, lastColon) : 'draft';
      const shortType = lastColon > 0 ? rest.slice(lastColon + 1) : 'text';
      const mediaType: AnnouncementMediaType =
        shortType === 'photo' ? 'PHOTO' : shortType === 'banner' ? 'BANNER' : 'TEXT';

      if (targetId === 'draft') {
        const raw = await redis.get(`ann_draft:${userId}`).catch(() => null);
        const draft = raw ? JSON.parse(raw) : { title: '', messageText: '', mediaType, mediaFileId: null, buttons: [] };
        draft.mediaType = mediaType;
        if (mediaType === 'TEXT') draft.mediaFileId = null;
        await redis.set(`ann_draft:${userId}`, JSON.stringify(draft), 1800);
        await this.renderAdminAnnouncementDraft(chatId, messageId, draft, `✅ Media type set to *${mediaType}*`);
      } else {
        await announcementService.updateAnnouncement(
          targetId,
          { mediaType, ...(mediaType === 'TEXT' ? { mediaFileId: null } : {}) },
          userId
        );
        await this.renderAdminAnnouncementDetail(chatId, messageId, targetId, `✅ Media type updated to *${mediaType}*`);
      }
      return;
    }

    if (data.startsWith('adm:ann_f:')) {
      const rest = data.slice('adm:ann_f:'.length);
      const lastColon = rest.lastIndexOf(':');
      const targetId = rest.slice(0, lastColon);
      const field = rest.slice(lastColon + 1);
      const prompts: Record<string, string> = {
        title: 'Enter *Announcement Title* (admin reference label):',
        msg: 'Enter *Message Body* (supports Telegram Markdown):',
        btns: 'Enter *Inline Buttons* (up to 6, one per line) in format:\n`Open Channel | https://t.me/yourchannel`\n`Visit Shop | m:prod`\n\nOr send `clear` to remove all buttons:',
      };

      await redis.setFsmState(userId, {
        step: 'ADMIN_ANN_EDIT_VALUE',
        data: { targetId, field },
      });
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `📢 *EDIT ANNOUNCEMENT*\n\n${prompts[field] || 'Enter new value:'}`,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({
                  text: 'Cancel',
                  fallbackEmoji: '❌',
                  style: 'danger',
                  callbackData: targetId === 'draft' ? 'adm:ann' : `adm:ann_v:${targetId}`,
                  forceVisible: true,
                }),
              ]),
            ],
          },
        }
      );
      return;
    }

    if (data.startsWith('adm:ann_m:')) {
      const targetId = data.slice('adm:ann_m:'.length);
      await redis.setFsmState(userId, {
        step: 'ADMIN_ANN_EDIT_MEDIA',
        data: { targetId },
      });
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `🖼️ *SET ANNOUNCEMENT PHOTO / BANNER*\n\nUpload a *Telegram Photo* directly in chat, OR paste an *HTTPS Image URL* / Telegram \`file_id\`, OR send \`clear\` to revert to Text-only:`,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({
                  text: 'Cancel',
                  fallbackEmoji: '❌',
                  style: 'danger',
                  callbackData: targetId === 'draft' ? 'adm:ann' : `adm:ann_v:${targetId}`,
                  forceVisible: true,
                }),
              ]),
            ],
          },
        }
      );
      return;
    }

    if (data === 'adm:ann_save') {
      const raw = await redis.get(`ann_draft:${userId}`).catch(() => null);
      if (!raw) {
        await telegramClient.editMessageText(chatId, messageId, '⚠️ Draft expired. Start a new announcement.', {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'Create Announcement', fallbackEmoji: '➕', style: 'primary', callbackData: 'adm:ann_new', forceVisible: true }),
                ButtonBuilder.buildButton({ text: 'Back', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:ann', forceVisible: true }),
              ]),
            ],
          },
        });
        return;
      }

      const draft = JSON.parse(raw);
      try {
        const created = await announcementService.createAnnouncement(draft, userId);
        await redis.del(`ann_draft:${userId}`).catch(() => {});
        await this.renderAdminAnnouncementDetail(chatId, messageId, created.id, '✅ Announcement draft saved!');
      } catch (err: any) {
        await this.renderAdminAnnouncementDraft(chatId, messageId, draft, `⚠️ ${err.message}`);
      }
      return;
    }

    if (data.startsWith('adm:ann_prev:')) {
      const targetId = data.slice('adm:ann_prev:'.length);
      try {
        if (targetId === 'draft') {
          const raw = await redis.get(`ann_draft:${userId}`).catch(() => null);
          const draft = raw ? JSON.parse(raw) : null;
          if (!draft || !draft.messageText) {
            throw new Error('Set Message Body before sending a preview.');
          }
          await announcementService.sendPreview(draft, chatId);
          await this.renderAdminAnnouncementDraft(chatId, messageId, draft, '✅ Preview sent to your Telegram chat!');
        } else {
          const ann = await announcementService.getAnnouncementById(targetId);
          if (!ann) return;
          await announcementService.sendPreview(ann, chatId);
          await this.renderAdminAnnouncementDetail(chatId, messageId, targetId, '✅ Preview sent to your Telegram chat!');
        }
      } catch (err: any) {
        if (targetId === 'draft') {
          const raw = await redis.get(`ann_draft:${userId}`).catch(() => null);
          await this.renderAdminAnnouncementDraft(chatId, messageId, raw ? JSON.parse(raw) : {}, `⚠️ ${err.message}`);
        } else {
          await this.renderAdminAnnouncementDetail(chatId, messageId, targetId, `⚠️ ${err.message}`);
        }
      }
      return;
    }

    if (data.startsWith('adm:ann_send:')) {
      let targetId = data.slice('adm:ann_send:'.length);
      if (targetId === 'draft') {
        const raw = await redis.get(`ann_draft:${userId}`).catch(() => null);
        if (!raw) return;
        const draft = JSON.parse(raw);
        try {
          const created = await announcementService.createAnnouncement(draft, userId);
          await redis.del(`ann_draft:${userId}`).catch(() => {});
          targetId = created.id;
        } catch (err: any) {
          await this.renderAdminAnnouncementDraft(chatId, messageId, draft, `⚠️ ${err.message}`);
          return;
        }
      }

      const ann = await announcementService.getAnnouncementById(targetId);
      if (!ann) return;
      const usersRes = await db.queryRow<{ c: string }>('SELECT COUNT(*) as c FROM users');
      const userCount = parseInt(usersRes?.c || '0', 10);

      await telegramClient.editMessageText(
        chatId,
        messageId,
        `🚀 *CONFIRM BROADCAST TO ALL USERS*\n\n` +
          `• Title: *${this.escapeDiagMarkdown(ann.title)}*\n` +
          `• Media: \`${ann.mediaType}\` | Buttons: \`${ann.buttons.length}\`\n` +
          `• Estimated Audience: \`${userCount} users\`\n\n` +
          `_Broadcast runs asynchronously in the background so customer shopping and wallets stay fast._`,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({
                  text: 'YES, SEND TO ALL USERS',
                  fallbackEmoji: '🚀',
                  style: 'success',
                  callbackData: `adm:ann_sendc:${ann.id}`,
                  forceVisible: true,
                }),
              ]),
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({
                  text: 'Cancel',
                  fallbackEmoji: '❌',
                  style: 'danger',
                  callbackData: `adm:ann_v:${ann.id}`,
                  forceVisible: true,
                }),
              ]),
            ],
          },
        }
      );
      return;
    }

    if (data.startsWith('adm:ann_sendc:')) {
      const annId = data.slice('adm:ann_sendc:'.length);
      try {
        await announcementService.startBroadcast(annId, userId);
        await this.renderAdminAnnouncementDetail(
          chatId,
          messageId,
          annId,
          '🚀 *Background broadcast started!* Customer commands remain responsive. Tap Refresh Progress below.'
        );
      } catch (err: any) {
        await this.renderAdminAnnouncementDetail(chatId, messageId, annId, `⚠️ ${err.message}`);
      }
      return;
    }

    if (data.startsWith('adm:ann_v:')) {
      const annId = data.slice('adm:ann_v:'.length);
      await this.renderAdminAnnouncementDetail(chatId, messageId, annId);
      return;
    }

    if (data.startsWith('adm:ann_cancel:')) {
      const annId = data.slice('adm:ann_cancel:'.length);
      await announcementService.cancelBroadcast(annId, userId);
      await this.renderAdminAnnouncementDetail(chatId, messageId, annId, '🛑 Broadcast cancelled.');
      return;
    }

    // =========================================================================
    // REFERRAL REWARDS & RULES MANAGEMENT (ZERO HARDCODED TIERS)
    // =========================================================================
    if (data === 'adm:ref') {
      await this.renderAdminReferralsHub(chatId, messageId);
      return;
    }

    if (data === 'adm:ref_set' || data.startsWith('adm:set_ref_t:') || data.startsWith('adm:ref_st:')) {
      if (data.startsWith('adm:set_ref_t:')) {
        const curr = await referralService.getSettings();
        await referralService.updateSettings({ rewardsEnabled: !curr.rewardsEnabled }, userId);
      }
      if (data.startsWith('adm:ref_st:')) {
        const field = data.slice('adm:ref_st:'.length);
        await redis.setFsmState(userId, { step: 'ADMIN_REF_SETTINGS_VALUE', data: { field } });
        await telegramClient.editMessageText(
          chatId,
          messageId,
          field === 'min'
            ? '✏️ Enter *Minimum Qualifying Order Amount (USDT)* (e.g. `1.00`):'
            : '✏️ Enter *Referral Reward Percentage* (decimal, e.g. `0.05` = 5%):',
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Cancel', fallbackEmoji: '❌', style: 'danger', callbackData: 'adm:ref_set', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      const settings = await referralService.getSettings();
      const text =
        `⚙️ *REFERRAL THRESHOLD & REWARD RULES*\n\n` +
        `• Rewards Active: ${settings.rewardsEnabled ? '✅ ENABLED' : '❌ PAUSED'}\n` +
        `• Min Qualifying COMPLETED Order: \`${settings.minQualifyingOrderUsdt} USDT\`\n` +
        `• Reward Percentage: \`${settings.rewardPercentage}\`\n\n` +
        `ℹ️ *Fixed Core Policy:* _Referral join gives ZERO reward. Qualification triggers ONLY on a COMPLETED order._`;

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: settings.rewardsEnabled ? 'Pause Rewards' : 'Enable Rewards',
                fallbackEmoji: settings.rewardsEnabled ? '⏸️' : '✅',
                style: settings.rewardsEnabled ? 'danger' : 'success',
                callbackData: 'adm:set_ref_t:tog',
                forceVisible: true,
              }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'Edit Min Order USDT', fallbackEmoji: '💲', style: 'primary', callbackData: 'adm:ref_st:min', forceVisible: true }),
              ButtonBuilder.buildButton({ text: 'Edit Reward %', fallbackEmoji: '📈', style: 'primary', callbackData: 'adm:ref_st:pct', forceVisible: true }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'Back to Referrals', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:ref', forceVisible: true }),
            ]),
          ],
        },
      });
      return;
    }

    if (data === 'adm:ref_new' || data === 'adm:ref_draft_type') {
      const draftKey = `ref_draft:${userId}`;
      const existingRaw = data === 'adm:ref_new' ? null : await redis.get(draftKey).catch(() => null);
      const draft = existingRaw
        ? JSON.parse(existingRaw)
        : {
            title: '',
            description: '',
            requiredQualifiedReferrals: 3,
            rewardType: 'WALLET_USDT',
            rewardAmount: '1.00',
            rewardProductId: null,
            rewardProductName: null,
            rewardQuantity: 1,
            isActive: true,
          };
      if (data === 'adm:ref_draft_type') {
        draft.rewardType = draft.rewardType === 'WALLET_USDT' ? 'PRODUCT' : 'WALLET_USDT';
      }
      await redis.set(draftKey, JSON.stringify(draft), 1800);
      await this.renderAdminReferralDraft(chatId, messageId, draft);
      return;
    }

    if (data === 'adm:ref_draft_save') {
      const raw = await redis.get(`ref_draft:${userId}`).catch(() => null);
      if (!raw) {
        await this.renderAdminReferralsHub(chatId, messageId, '⚠️ Draft expired. Please start again.');
        return;
      }
      const draft = JSON.parse(raw);
      try {
        const tierId = await referralService.createRewardTier(draft, userId);
        await redis.del(`ref_draft:${userId}`).catch(() => {});
        await this.renderAdminReferralTierDetail(chatId, messageId, tierId, '✅ Milestone tier created!');
      } catch (err: any) {
        await this.renderAdminReferralDraft(chatId, messageId, draft, `⚠️ ${err.message}`);
      }
      return;
    }

    if (data.startsWith('adm:ref_v:') || data.startsWith('adm:ref_ed:')) {
      const tierId = data.startsWith('adm:ref_v:') ? data.slice('adm:ref_v:'.length) : data.slice('adm:ref_ed:'.length);
      await this.renderAdminReferralTierDetail(chatId, messageId, tierId);
      return;
    }

    if (data.startsWith('adm:ref_tog:')) {
      const tierId = data.slice('adm:ref_tog:'.length);
      const tier = await referralService.getRewardTierById(tierId);
      if (tier) {
        await referralService.updateRewardTier(tierId, { isActive: !tier.isActive }, userId);
        await this.renderAdminReferralTierDetail(chatId, messageId, tierId, !tier.isActive ? '✅ Tier enabled.' : '⏸️ Tier disabled.');
      }
      return;
    }

    if (data.startsWith('adm:ref_del:')) {
      const tierId = data.slice('adm:ref_del:'.length);
      await referralService.deleteRewardTier(tierId, userId);
      await this.renderAdminReferralsHub(chatId, messageId, '✅ Referral milestone tier deleted.');
      return;
    }

    if (data.startsWith('adm:ref_prod:')) {
      const rest = data.slice('adm:ref_prod:'.length);
      const lastColon = rest.lastIndexOf(':');
      const targetId = lastColon > 0 ? rest.slice(0, lastColon) : 'draft';
      const page = Math.max(1, parseInt(lastColon > 0 ? rest.slice(lastColon + 1) : '1', 10));
      await redis.set(`ref_pick_target:${userId}`, targetId, 900);

      const catalog = await pricingService.getCatalog({ page, pageSize: 6, includeHidden: true });
      const totalPages = Math.max(1, Math.ceil(catalog.total / 6));
      const rows: any[][] = [];
      for (const item of catalog.items) {
        rows.push(
          ButtonBuilder.buildActionRow([
            ButtonBuilder.buildButton({
              text: `${item.name.slice(0, 28)} (${item.sellingPrice} USDT)`,
              style: 'default',
              callbackData: `adm:rfs:${item.id}`,
              forceVisible: true,
            }),
          ])
        );
      }
      if (totalPages > 1) {
        rows.push(
          ButtonBuilder.buildActionRow([
            ButtonBuilder.buildButton({ text: '⬅️ Prev', style: 'primary', callbackData: page > 1 ? `adm:ref_prod:${targetId}:${page - 1}` : 'noop', forceVisible: true }),
            ButtonBuilder.buildButton({ text: `${page}/${totalPages}`, style: 'default', callbackData: 'noop', forceVisible: true }),
            ButtonBuilder.buildButton({ text: 'Next ➡️', style: 'primary', callbackData: page < totalPages ? `adm:ref_prod:${targetId}:${page + 1}` : 'noop', forceVisible: true }),
          ])
        );
      }
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'Back',
            fallbackEmoji: '⬅️',
            style: 'default',
            callbackData: targetId === 'draft' ? 'adm:ref_draft_type' : `adm:ref_v:${targetId}`,
            forceVisible: true,
          }),
        ])
      );
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `🛍️ *SELECT REFERRAL REWARD PRODUCT*\n\nTotal products: \`${catalog.total}\` (Page ${page}/${totalPages}):`,
        { reply_markup: { inline_keyboard: rows } }
      );
      return;
    }

    if (data.startsWith('adm:rfs:')) {
      const prodId = data.slice('adm:rfs:'.length);
      const targetId = (await redis.get(`ref_pick_target:${userId}`).catch(() => null)) || 'draft';
      const prod = await db.queryRow<any>('SELECT id, original_name FROM supplier_products WHERE id = $1', [prodId]);
      if (!prod) return;

      if (targetId === 'draft') {
        const raw = await redis.get(`ref_draft:${userId}`).catch(() => null);
        const draft = raw ? JSON.parse(raw) : { requiredQualifiedReferrals: 3, rewardType: 'PRODUCT', rewardQuantity: 1, isActive: true };
        draft.rewardType = 'PRODUCT';
        draft.rewardProductId = prod.id;
        draft.rewardProductName = prod.original_name;
        await redis.set(`ref_draft:${userId}`, JSON.stringify(draft), 1800);
        await this.renderAdminReferralDraft(chatId, messageId, draft, `✅ Product selected: *${this.escapeDiagMarkdown(prod.original_name)}*`);
      } else {
        await referralService.updateRewardTier(targetId, { rewardType: 'PRODUCT', rewardProductId: prod.id }, userId);
        await this.renderAdminReferralTierDetail(chatId, messageId, targetId, `✅ Reward product updated to *${this.escapeDiagMarkdown(prod.original_name)}*`);
      }
      return;
    }

    if (data.startsWith('adm:ref_f:')) {
      const rest = data.slice('adm:ref_f:'.length);
      const lastColon = rest.lastIndexOf(':');
      const targetId = rest.slice(0, lastColon);
      const field = rest.slice(lastColon + 1);
      const prompts: Record<string, string> = {
        title: 'Enter *Milestone Tier Title*:',
        req: 'Enter *Required Qualified Referrals* (integer >= 1):',
        amt: 'Enter *Wallet Reward USDT Amount* (e.g. `2.50`):',
        qty: 'Enter *Product Reward Quantity* (integer >= 1):',
      };
      await redis.setFsmState(userId, { step: 'ADMIN_REF_EDIT_VALUE', data: { targetId, field } });
      await telegramClient.editMessageText(chatId, messageId, `✏️ *EDIT REFERRAL TIER*\n\n${prompts[field] || 'Enter new value:'}`, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({
                text: 'Cancel',
                fallbackEmoji: '❌',
                style: 'danger',
                callbackData: targetId === 'draft' ? 'adm:ref_draft_type' : `adm:ref_v:${targetId}`,
                forceVisible: true,
              }),
            ]),
          ],
        },
      });
      return;
    }

    // =========================================================================
    // REQUIRED CHANNELS MANAGEMENT
    // =========================================================================
    if (data === 'adm:ch' || data === 'adm:ch_tog' || data === 'adm:ch_test' || data.startsWith('adm:ch_rem:') || data.startsWith('adm:ch_up:') || data.startsWith('adm:ch_dn:')) {
      let notice: string | undefined;

      if (data === 'adm:ch_tog') {
        const curr = await channelService.getConfig();
        const next = await channelService.setVerificationEnabled(!curr.verificationEnabled, userId);
        notice = next.verificationEnabled
          ? '✅ Channel membership verification ENABLED.'
          : '❌ Channel membership verification DISABLED.';
      } else if (data.startsWith('adm:ch_rem:')) {
        const chId = data.slice('adm:ch_rem:'.length);
        await channelService.removeChannel(chId, userId);
        notice = '🗑️ Channel removed.';
      } else if (data.startsWith('adm:ch_up:')) {
        await channelService.moveChannel(data.slice('adm:ch_up:'.length), 'up', userId);
        notice = '⬆️ Moved channel up.';
      } else if (data.startsWith('adm:ch_dn:')) {
        await channelService.moveChannel(data.slice('adm:ch_dn:'.length), 'down', userId);
        notice = '⬇️ Moved channel down.';
      } else if (data === 'adm:ch_test') {
        const res = await channelService.checkUserMembership(userId, { forceRefresh: true });
        if (res.details.length === 0) {
          notice = 'ℹ️ No active required channels configured to test.';
        } else {
          notice =
            '🧪 *Membership Probe Results (Your Admin Account):*\n' +
            res.details
              .map(d => `• ${d.joined ? '✅' : '❌'} *${this.escapeDiagMarkdown(d.channel.title)}* (\`${d.memberStatus}\`)`)
              .join('\n');
        }
      }

      await this.renderAdminChannelsHub(chatId, messageId, notice);
      return;
    }

    if (data === 'adm:ch_add') {
      await redis.setFsmState(userId, { step: 'ADMIN_CH_ADD_INPUT' });
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `📢 *ADD REQUIRED CHANNEL*\n\n` +
          `Send the channel details in one line:\n` +
          `• Public channel: \`@ChannelUsername\` or \`@ChannelUsername | Display Title\`\n` +
          `• Private channel: \`-1001234567890 | Display Title | https://t.me/+InviteCode\``,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'Cancel', fallbackEmoji: '❌', style: 'danger', callbackData: 'adm:ch', forceVisible: true }),
              ]),
            ],
          },
        }
      );
      return;
    }

    // =========================================================================
    // SUPPLIER CONTROL CENTER (NO DELETE CAPABILITY)
    // =========================================================================
    if (data === 'adm:sup' || data.startsWith('adm:sup_v:') || data.startsWith('adm:sup_bal:') || data.startsWith('adm:sup_ord:') || data.startsWith('adm:sup_sync:') || data.startsWith('adm:sup_tog:')) {
      if (data === 'adm:sup') {
        await this.renderAdminSuppliersHub(chatId, messageId);
        return;
      }

      if (data.startsWith('adm:sup_v:')) {
        const supId = data.slice('adm:sup_v:'.length);
        await this.renderAdminSupplierDetail(chatId, messageId, supId);
        return;
      }

      if (data.startsWith('adm:sup_bal:')) {
        const supId = data.slice('adm:sup_bal:'.length);
        const bal = await supplierService.getBalance();
        const notice = bal
          ? `✅ Live Supplier Balance: \`${bal.balanceUsdt.toFixed(4)} ${bal.currency}\``
          : '⚠️ Unable to fetch live supplier balance right now.';
        await this.renderAdminSupplierDetail(chatId, messageId, supId, notice);
        return;
      }

      if (data.startsWith('adm:sup_ord:')) {
        const supId = data.slice('adm:sup_ord:'.length);
        const list = await supplierService.listOrdersReadOnly();
        let notice = list.ok
          ? `📦 *Recent Supplier Orders (${list.orders.length}):*\n` +
            list.orders
              .slice(0, 5)
              .map(o => `• \`${maskSupplierRef(o.order_ref || o.id)}\` — *${o.status || 'UNKNOWN'}*`)
              .join('\n')
          : `⚠️ GET /orders failed: ${this.escapeDiagMarkdown(list.error || 'ERROR')}`;
        if (list.ok && list.orders.length === 0) notice = 'ℹ️ No orders returned by supplier GET /orders.';
        await this.renderAdminSupplierDetail(chatId, messageId, supId, notice);
        return;
      }

      if (data.startsWith('adm:sup_sync:')) {
        const supId = data.slice('adm:sup_sync:'.length);
        try {
          const syncRes = await supplierService.syncCatalogue();
          await this.renderAdminSupplierDetail(
            chatId,
            messageId,
            supId,
            `✅ Sync complete: ${syncRes.importedCount} new, ${syncRes.updatedCount} updated (${syncRes.totalCount} total).`
          );
        } catch (err: any) {
          await this.renderAdminSupplierDetail(chatId, messageId, supId, `❌ Sync failed: ${this.escapeDiagMarkdown(err.message)}`);
        }
        return;
      }

      if (data.startsWith('adm:sup_tog:')) {
        const [, , shortFlag, supId = 'aitoolshop'] = data.split(':');
        const map: Record<string, SupplierControlFlag> = {
          en: 'is_enabled',
          rt: 'routing_enabled',
          or: 'ordering_enabled',
          sy: 'sync_enabled',
        };
        const field = map[shortFlag];
        if (!field) return;
        const curr = await supplierService.getSupplierControl(supId);
        const currentVal =
          field === 'is_enabled'
            ? curr.isEnabled
            : field === 'routing_enabled'
            ? curr.routingEnabled
            : field === 'ordering_enabled'
            ? curr.orderingEnabled
            : curr.syncEnabled;
        await supplierService.setSupplierFlag(supId, field, !currentVal, userId);
        await this.renderAdminSupplierDetail(chatId, messageId, supId, `✅ Updated \`${field}\` → *${!currentVal ? 'ON' : 'OFF'}*`);
        return;
      }
    }

    // =========================================================================
    // SETTINGS CENTER (NO-REDEPLOY CONFIGURATION)
    // =========================================================================
    if (
      data === 'adm:set' ||
      data === 'adm:set_maint' ||
      data === 'adm:set_gw' ||
      data === 'adm:set_ban' ||
      data.startsWith('adm:set_gw_t:') ||
      data.startsWith('adm:set_e:') ||
      data.startsWith('adm:ban_e:') ||
      data.startsWith('adm:ban_clr:')
    ) {
      if (data === 'adm:set_maint') {
        const curr = await settingsService.getMaintenanceConfig();
        const next = await settingsService.updateMaintenanceConfig({ enabled: !curr.enabled }, userId);
        await this.renderAdminSettingsCenter(
          chatId,
          messageId,
          next.enabled ? '⚠️ Maintenance Mode ENABLED (customers paused).' : '✅ Maintenance Mode DISABLED (shop live).'
        );
        return;
      }

      if (data === 'adm:set_gw' || data.startsWith('adm:set_gw_t:')) {
        if (data === 'adm:set_gw_t:en') {
          const curr = await giveawayService.getSettings();
          await giveawayService.updateSettings({ enabled: !curr.enabled }, userId);
        } else if (data === 'adm:set_gw_t:not') {
          const curr = await giveawayService.getSettings();
          await giveawayService.updateSettings({ notifyAdminOnClaim: !curr.notifyAdminOnClaim }, userId);
        }
        const gs = await giveawayService.getSettings();
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `🎁 *GIVEAWAY GLOBAL SETTINGS*\n\n` +
            `• Giveaways System: ${gs.enabled ? '✅ ENABLED' : '❌ PAUSED'}\n` +
            `• Admin Notifications on Claim: ${gs.notifyAdminOnClaim ? '✅ ON' : '❌ OFF'}\n` +
            `• Default Claim Limit: \`${gs.defaultClaimLimit}\``,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: gs.enabled ? 'Pause Giveaways' : 'Enable Giveaways', style: gs.enabled ? 'danger' : 'success', callbackData: 'adm:set_gw_t:en', forceVisible: true }),
                  ButtonBuilder.buildButton({ text: gs.notifyAdminOnClaim ? 'Notify: ON' : 'Notify: OFF', style: 'primary', callbackData: 'adm:set_gw_t:not', forceVisible: true }),
                ]),
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Edit Default Limit', fallbackEmoji: '✏️', style: 'primary', callbackData: 'adm:set_e:gw_lim', forceVisible: true }),
                  ButtonBuilder.buildButton({ text: 'Back', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:set', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      if (data === 'adm:set_ban' || data.startsWith('adm:ban_clr:')) {
        if (data.startsWith('adm:ban_clr:')) {
          const slot = data.slice('adm:ban_clr:'.length);
          const patch: any = {};
          if (slot === 'welcome') patch.welcomeBannerUrl = '';
          if (slot === 'shop') patch.shopBannerUrl = '';
          if (slot === 'support') patch.supportBannerUrl = '';
          await settingsService.updateBannerImages(patch, userId);
        }
        const ban = await settingsService.getBannerImages();
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `🖼️ *BANNER IMAGES SETTINGS*\n\n` +
            `• Welcome Banner: ${ban.welcomeBannerUrl ? `✅ Configured` : '_None_'}\n` +
            `• Shop Banner: ${ban.shopBannerUrl ? `✅ Configured` : '_None_'}\n` +
            `• Support Banner: ${ban.supportBannerUrl ? `✅ Configured` : '_None_'}\n\n` +
            `_Send an https:// image URL or Telegram file_id to set a banner, or clear it below._`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Set Welcome Banner', style: 'primary', callbackData: 'adm:ban_e:welcome', forceVisible: true }),
                  ButtonBuilder.buildButton({ text: 'Clear', style: 'danger', callbackData: 'adm:ban_clr:welcome', forceVisible: true }),
                ]),
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Set Shop Banner', style: 'primary', callbackData: 'adm:ban_e:shop', forceVisible: true }),
                  ButtonBuilder.buildButton({ text: 'Clear', style: 'danger', callbackData: 'adm:ban_clr:shop', forceVisible: true }),
                ]),
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Set Support Banner', style: 'primary', callbackData: 'adm:ban_e:support', forceVisible: true }),
                  ButtonBuilder.buildButton({ text: 'Clear', style: 'danger', callbackData: 'adm:ban_clr:support', forceVisible: true }),
                ]),
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Back to Settings', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:set', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      if (data.startsWith('adm:ban_e:')) {
        const slot = data.slice('adm:ban_e:'.length);
        await redis.setFsmState(userId, { step: 'ADMIN_SETTINGS_VALUE', data: { kind: `banner_${slot}` } });
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `🖼️ Send an \`https://\` image URL (or Telegram photo \`file_id\`, or \`clear\`) for the *${slot.toUpperCase()}* banner:`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Cancel', fallbackEmoji: '❌', style: 'danger', callbackData: 'adm:set_ban', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      if (data.startsWith('adm:set_e:')) {
        const kind = data.slice('adm:set_e:'.length);
        const labelMap: Record<string, string> = {
          welcome: 'Welcome Message (supports `{brand}`)',
          support: 'Support Prompt Message',
          maint_msg: 'Maintenance Notice Message',
          gw_lim: 'Default Giveaway Claim Limit (integer >= 1)',
        };
        await redis.setFsmState(userId, { step: 'ADMIN_SETTINGS_VALUE', data: { kind } });
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `✏️ *EDIT SETTING*\n\nSend the new value for *${labelMap[kind] || kind}*:`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Cancel', fallbackEmoji: '❌', style: 'danger', callbackData: 'adm:set', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      await this.renderAdminSettingsCenter(chatId, messageId);
      return;
    }

    // =========================================================================
    // DIAGNOSTICS HUB, LAUNCH READINESS AUDIT & PERFORMANCE AUDIT
    // =========================================================================
    if (data === 'adm:diag') {
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `🔬 *DIAGNOSTICS & RELEASE AUDIT HUB*\n\nSelect a strictly read-only diagnostic or automated audit:`,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'Launch Readiness Audit', fallbackEmoji: '🚀', style: 'success', callbackData: 'adm:audit', forceVisible: true }),
              ]),
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'Performance Audit', fallbackEmoji: '⚡', style: 'primary', callbackData: 'adm:perf', forceVisible: true }),
                ButtonBuilder.buildButton({ text: 'System Health', fallbackEmoji: '🩺', style: 'default', callbackData: 'adm:hlth', forceVisible: true }),
              ]),
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'Supplier Read-Only Diag', fallbackEmoji: '🏭', style: 'primary', callbackData: 'adm:sup_diag', forceVisible: true }),
              ]),
              ...(config.binance.diagnosticEnabled
                ? [
                    ButtonBuilder.buildActionRow([
                      ButtonBuilder.buildButton({ text: 'Binance History Diag', fallbackEmoji: '🔬', style: 'primary', callbackData: 'adm:bin_diag', forceVisible: true }),
                    ]),
                  ]
                : []),
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
              ]),
            ],
          },
        }
      );
      return;
    }

    if (data === 'adm:audit' || data === 'adm:audit_net') {
      const liveNetwork = data === 'adm:audit_net';
      const report = await launchAuditService.runFullAudit(userId, { liveNetwork });
      const overallBadge = report.overallStatus === 'PUBLIC LAUNCH READY' ? '✅ PUBLIC LAUNCH READY' : '❌ ISSUES FOUND';
      let text =
        `🚀 *XERO KHAN LAUNCH READINESS AUDIT*\n\n` +
        `• Verdict: *${overallBadge}*\n` +
        `• Passed: \`${report.passCount}/10\` | Warnings: \`${report.warnCount}\` | Failures: \`${report.failCount}\`\n` +
        `• Duration: \`${report.durationMs}ms\`\n\n`;

      for (const c of report.checks) {
        const icon = c.status === 'PASS' ? '✅' : c.status === 'WARN' ? '⚠️' : '❌';
        text += `${icon} *${c.area}*\n   ${this.escapeDiagMarkdown(c.summary)}\n`;
      }

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'Re-Run Audit', fallbackEmoji: '🔄', style: 'primary', callbackData: 'adm:audit', forceVisible: true }),
              ButtonBuilder.buildButton({ text: '+ Live Supplier Check', fallbackEmoji: '🌐', style: 'primary', callbackData: 'adm:audit_net', forceVisible: true }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'Performance Audit', fallbackEmoji: '⚡', style: 'default', callbackData: 'adm:perf', forceVisible: true }),
              ButtonBuilder.buildButton({ text: 'ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
            ]),
          ],
        },
      });
      return;
    }

    if (data === 'adm:perf') {
      const perf = await launchAuditService.runPerformanceAudit();
      let text =
        `⚡ *PERFORMANCE & CALLBACK AUDIT*\n\n` +
        `• N+1 Query Guard: ${perf.nPlusOneFree ? '✅ OPTIMIZED' : '⚠️ REVIEW NEEDED'}\n` +
        `• Suite Benchmark Latency: \`${perf.totalDurationMs}ms\`\n\n`;

      for (const m of perf.metrics) {
        const badge = m.status === 'FAST' ? '✅' : m.status === 'MODERATE' ? '⚠️' : '❌';
        text += `${badge} *${m.label}:* \`${m.durationMs}ms\` (${m.status})\n`;
      }

      if (perf.recentCallbacks.length > 0) {
        text += `\n📊 *Recent Callback Latencies:*\n`;
        for (const cb of perf.recentCallbacks.slice(0, 6)) {
          const icon = cb.slow ? '🐢' : '⚡';
          text += `${icon} \`${this.escapeDiagMarkdown(cb.callbackName)}\` → \`${cb.responseTimeMs}ms\` (DB: \`${cb.dbTimeMs}ms\`/${cb.dbQueryCount}q, Sup: \`${cb.supplierTimeMs}ms\`)\n`;
        }
      }

      if (perf.slowCallbacks300.length > 0) {
        text += `\n⚠️ *Slow Callbacks (>300ms):* \`${perf.slowCallbacks300.length}\` (>500ms: \`${perf.slowCallbacks.length}\`)\n`;
        for (const s of perf.slowCallbacks300.slice(0, 4)) {
          text += `• \`${this.escapeDiagMarkdown(s.callbackName)}\` — \`${s.responseTimeMs}ms\` (DB \`${s.dbTimeMs}ms\`, Sup \`${s.supplierTimeMs}ms\`)\n`;
        }
      } else {
        text += `\n✅ *Slow Callbacks (>300ms):* \`0\` | *(>500ms):* \`0\`\n`;
      }

      text += `\nℹ️ _${this.escapeDiagMarkdown(perf.summary)}_`;

      await telegramClient.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'Run Benchmark Again', fallbackEmoji: '🔄', style: 'primary', callbackData: 'adm:perf', forceVisible: true }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'Diagnostics Hub', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:diag', forceVisible: true }),
              ButtonBuilder.buildButton({ text: 'ADMIN', fallbackEmoji: '👑', style: 'default', callbackData: 'adm:main', forceVisible: true }),
            ]),
          ],
        },
      });
      return;
    }

    // Trigger Supplier Catalogue Sync (in-place fast update)
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
        await telegramClient.editMessageText(chatId, messageId, text, {
          reply_markup: getAdminMainMenuKeyboard(),
        });
      } catch (err: any) {
        await telegramClient.editMessageText(chatId, messageId, `❌ *SYNC FAILED*\n\n${err.message}`, {
          reply_markup: getAdminMainMenuKeyboard(),
        });
      }
      return;
    }

    // Pending Deposits Queue & Review Screen
    if (data === 'adm:dep' || data.startsWith('adm:dep_v:')) {
      const targetDepId = data.startsWith('adm:dep_v:') ? data.slice('adm:dep_v:'.length) : undefined;
      await this.renderAdminPendingDeposit(chatId, messageId, targetDepId);
      return;
    }

    // View Attached Deposit Screenshot
    if (data.startsWith('adm_dep_pic:')) {
      const depositId = data.slice('adm_dep_pic:'.length);
      const dep = await db.queryRow<any>(
        `SELECT d.proof_file_id as "proofFileId", d.payment_method_code as "methodCode",
                d.sender_phone as "senderPhone", d.submitted_pkr_amount as "submittedPkrAmount",
                u.username as "username"
         FROM deposits d
         LEFT JOIN users u ON d.user_id = u.id
         WHERE d.id = $1`,
        [depositId]
      );
      if (!dep || !dep.proofFileId) {
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `⚠️ No screenshot image attached for deposit \`${depositId}\`.`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Back to Deposit', fallbackEmoji: '⬅️', style: 'default', callbackData: `adm:dep_v:${depositId}`, forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      const caption =
        `🖼️ *Deposit Screenshot* (\`${depositId}\`)\n` +
        `• Method: *${dep.methodCode}*\n` +
        `• Customer: ${dep.username ? `@${dep.username}` : 'Customer'}\n` +
        (dep.senderPhone ? `• Sender Number: \`${dep.senderPhone}\`\n` : '') +
        (dep.submittedPkrAmount ? `• Detected Paid: \`${dep.submittedPkrAmount} PKR\`` : '');

      await telegramClient.sendPhoto(chatId, dep.proofFileId, caption, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'Review & Credit', fallbackEmoji: '💳', style: 'primary', callbackData: `adm:dep_v:${depositId}`, forceVisible: true }),
            ]),
          ],
        },
      });
      return;
    }

    // Approve Deposit via Preset / Auto-Suggested USD Amount: adm_app_amt:<depId>:<usd>
    if (data.startsWith('adm_app_amt:')) {
      const rest = data.slice('adm_app_amt:'.length);
      const sep = rest.lastIndexOf(':');
      const depositId = rest.slice(0, sep);
      const usdAmount = rest.slice(sep + 1);
      try {
        const res = await manualPaymentService.approveDeposit(depositId, userId, {
          customUsdAmount: usdAmount,
          isCustomInput: false,
        });
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `✅ *DEPOSIT APPROVED*\n\nCredited \`$${Number(res.amount).toFixed(2)} USD\` (\`${res.amount} USDT\`) to user \`${res.userId}\`.\nWallet and immutable ledger updated atomically.`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'NEXT PENDING DEPOSIT', fallbackEmoji: '💳', style: 'primary', callbackData: 'adm:dep', forceVisible: true }),
                ]),
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        await telegramClient.sendMessage(
          res.userId,
          `🎉 *DEPOSIT APPROVED*\n\nYour deposit of \`$${Number(res.amount).toFixed(2)} USD\` has been approved and credited to your wallet balance.`
        ).catch(() => {});
      } catch (err: any) {
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `❌ *APPROVAL FAILED*\n\n${this.escapeDiagMarkdown(err.message)}`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'PENDING DEPOSITS', fallbackEmoji: '💳', style: 'primary', callbackData: 'adm:dep', forceVisible: true }),
                ]),
              ],
            },
          }
        );
      }
      return;
    }

    // Custom USD Credit Prompt: adm_app_cust:<depId>
    if (data.startsWith('adm_app_cust:')) {
      const depositId = data.slice('adm_app_cust:'.length);
      const depCfg = await manualPaymentService.getDepositSettings();
      if (!depCfg.allowCustomCredit) {
        await telegramClient.editMessageText(
          chatId,
          messageId,
          '🔒 *CUSTOM CREDIT DISABLED*\n\nCustom USD credit is currently OFF in `⚙️ Deposit Settings`.',
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Back to Deposit', fallbackEmoji: '⬅️', style: 'default', callbackData: `adm:dep_v:${depositId}`, forceVisible: true }),
                  ButtonBuilder.buildButton({ text: 'Deposit Settings', fallbackEmoji: '⚙️', style: 'primary', callbackData: 'adm:dep_set', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      await redis.setFsmState(userId, {
        step: 'ADMIN_DEP_CUSTOM_USD',
        data: { depositId },
      });

      await telegramClient.editMessageText(
        chatId,
        messageId,
        `✏️ *CUSTOM USD CREDIT*\n\nDeposit ID: \`${depositId}\`\nExchange Rate: \`1 USD = ${depCfg.pkrPerUsd} PKR\`\n\nEnter the exact USD amount to credit to this customer's wallet (e.g. \`0.10\`, \`0.50\`, \`1.25\`, \`2.75\`):`,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'Cancel', fallbackEmoji: '❌', style: 'danger', callbackData: `adm:dep_v:${depositId}`, forceVisible: true }),
              ]),
            ],
          },
        }
      );
      return;
    }

    // Deposit Settings Hub (Exchange Rate, Min/Max PKR, Toggles)
    if (
      data === 'adm:dep_set' ||
      data === 'adm:dep_set_t:custom' ||
      data === 'adm:dep_set_t:suggest' ||
      data.startsWith('adm:dep_set_e:')
    ) {
      if (data === 'adm:dep_set_t:custom') {
        const curr = await manualPaymentService.getDepositSettings();
        await manualPaymentService.updateDepositSettings({ allowCustomCredit: !curr.allowCustomCredit }, userId);
        await this.renderAdminDepositSettings(
          chatId,
          messageId,
          `✅ Allow Custom Credit set to *${!curr.allowCustomCredit ? 'ON' : 'OFF'}*.`
        );
        return;
      }

      if (data === 'adm:dep_set_t:suggest') {
        const curr = await manualPaymentService.getDepositSettings();
        await manualPaymentService.updateDepositSettings({ autoSuggestCredit: !curr.autoSuggestCredit }, userId);
        await this.renderAdminDepositSettings(
          chatId,
          messageId,
          `✅ Auto Suggest Credit set to *${!curr.autoSuggestCredit ? 'ON' : 'OFF'}*.`
        );
        return;
      }

      if (data.startsWith('adm:dep_set_e:')) {
        const field = data.slice('adm:dep_set_e:'.length);
        const promptMap: Record<string, string> = {
          rate: 'Enter *Exchange Rate* (PKR per 1 USD, e.g. `290`):',
          min: 'Enter *Minimum Deposit* in PKR (e.g. `30`):',
          max: 'Enter *Maximum Deposit* in PKR (e.g. `6000`):',
        };
        await redis.setFsmState(userId, {
          step: 'ADMIN_DEP_SETTINGS_VALUE',
          data: { field },
        });
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `⚙️ *EDIT DEPOSIT SETTING*\n\n${promptMap[field] || 'Enter new numeric value:'}`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'Cancel', fallbackEmoji: '❌', style: 'danger', callbackData: 'adm:dep_set', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      await this.renderAdminDepositSettings(chatId, messageId);
      return;
    }

    // Legacy / Direct Approve Deposit
    if (data.startsWith('adm_app:')) {
      const [, depositId] = data.split(':');
      try {
        const res = await manualPaymentService.approveDeposit(depositId, userId);
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `✅ *DEPOSIT APPROVED*\n\nSuccessfully credited \`${res.amount} USDT\` to user \`${res.userId}\`. Wallet and immutable ledger updated.`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'NEXT PENDING DEPOSIT', fallbackEmoji: '💳', style: 'primary', callbackData: 'adm:dep', forceVisible: true }),
                ]),
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        await telegramClient.sendMessage(
          res.userId,
          `🎉 *DEPOSIT APPROVED*\n\nYour deposit of \`${res.amount} USDT\` has been approved and credited to your wallet balance.`
        ).catch(() => {});
      } catch (err: any) {
        await telegramClient.editMessageText(chatId, messageId, `❌ *APPROVAL FAILED*\n\n${err.message}`, {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'PENDING DEPOSITS', fallbackEmoji: '💳', style: 'primary', callbackData: 'adm:dep', forceVisible: true }),
              ]),
            ],
          },
        });
      }
      return;
    }

    // Reject Deposit
    if (data.startsWith('adm_rej:')) {
      const [, depositId] = data.split(':');
      try {
        const rej = await manualPaymentService.rejectDeposit(depositId, userId, 'Payment could not be verified');
        await telegramClient.editMessageText(
          chatId,
          messageId,
          `❌ Deposit \`${depositId}\` has been marked *REJECTED*.`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'NEXT PENDING DEPOSIT', fallbackEmoji: '💳', style: 'primary', callbackData: 'adm:dep', forceVisible: true }),
                ]),
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        await telegramClient.sendMessage(
          rej.userId,
          `⚠️ *DEPOSIT REJECTED*\n\nYour manual deposit (\`${depositId}\`) could not be verified and was rejected. Contact support if you need assistance.`
        ).catch(() => {});
      } catch (err: any) {
        await telegramClient.editMessageText(chatId, messageId, `⚠️ ${err.message}`, {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'PENDING DEPOSITS', fallbackEmoji: '💳', style: 'primary', callbackData: 'adm:dep', forceVisible: true }),
              ]),
            ],
          },
        });
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

    // Apply Fixed Markup (in-place update)
    if (data.startsWith('adm_set_fm:')) {
      const [, productId, markupStr] = data.split(':');
      await pricingService.setFixedMarkup(productId, markupStr, userId);
      const newPrice = await pricingService.calculatePrice(productId);
      await telegramClient.editMessageText(
        chatId,
        messageId,
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

    // Reset Pricing (in-place update)
    if (data.startsWith('adm_reset_pr:')) {
      const [, productId] = data.split(':');
      await pricingService.resetPricing(productId, userId);
      await telegramClient.editMessageText(chatId, messageId, '✅ *PRICING RESET*\n\nProduct pricing reset to global default rule.', {
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
        `• Supplier API: \`${sanitized.supplier.baseUrl}\`\n` +
        `• Supplier URL Source: \`${sanitized.supplier.baseUrlSource}\`\n` +
        `• Official Doc URL: \`${sanitized.supplier.officialDocBaseUrl}\`\n\n` +
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
              ButtonBuilder.buildButton({ text: 'SUPPLIER READ-ONLY DIAG', fallbackEmoji: '🔬', style: 'primary', callbackData: 'adm:sup_diag' }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main' }),
            ]),
          ],
        },
      });
      return;
    }

    // =========================================================================
    // ADMIN-ONLY READ-ONLY SUPPLIER DIAGNOSTIC (ZERO PURCHASING CAPABILITY)
    // =========================================================================

    if (data === 'adm:sup_diag') {
      await redis.clearFsmState(userId);
      const sanitized: any = getSanitizedConfig();
      const intro =
        `🔬 *SUPPLIER READ-ONLY DIAGNOSTIC*\n\n` +
        `• Mode: \`READ-ONLY\`\n` +
        `• Purchasing Capability: \`ZERO (No POST /order)\`\n` +
        `• Wallet Mutation: \`IMPOSSIBLE\`\n` +
        `• LIVE\\_ORDERING\\_ENABLED: \`${config.safety.liveOrderingEnabled}\`\n\n` +
        `🌐 *Endpoint Resolution:*\n` +
        `• Active Base URL: \`${sanitized.supplier.baseUrl}\`\n` +
        `• Source: \`${sanitized.supplier.baseUrlSource}\`\n` +
        `• Official Doc URL: \`${sanitized.supplier.officialDocBaseUrl}\`\n` +
        `• Reseller Key Configured: \`${sanitized.supplier.apiKeyConfigured ? 'YES (MASKED)' : 'NO'}\`\n\n` +
        `Checks executed read-only: \`GET /balance\`, \`GET /products\`, \`GET /orders\`, and \`GET /order/:ref\`.`;

      await telegramClient.editMessageText(chatId, messageId, intro, {
        reply_markup: this.getSupplierDiagnosticActionKeyboard(),
      });
      return;
    }

    if (data === 'adm:sup_diag_run') {
      await redis.clearFsmState(userId);
      const cachedRef = (await redis.get(`adm_sup_diag_ref:${userId}`).catch(() => null)) || undefined;
      await this.executeAdminSupplierDiagnostic(chatId, userId, cachedRef);
      return;
    }

    if (data === 'adm:sup_diag_ord') {
      await redis.setFsmState(userId, { step: 'ADMIN_SUPPLIER_DIAG_ORDER_REF', data: { readOnly: true } }, 300);
      await telegramClient.editMessageText(
        chatId,
        messageId,
        `🔎 *SUPPLIER ORDER LOOKUP (READ-ONLY)*\n\n` +
          `Enter the \`supplier_order_ref\` (or order reference) to inspect via \`GET /order/:ref\`.\n\n` +
          `_Strictly read-only. Zero POST /order calls. Held in short-TTL Redis state only._`,
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'CLEAR DIAGNOSTIC STATE', fallbackEmoji: '🧹', style: 'default', callbackData: 'adm:sup_diag_clr', forceVisible: true }),
              ]),
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'BACK TO SUPPLIER DIAG', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:sup_diag', forceVisible: true }),
              ]),
            ],
          },
        }
      );
      return;
    }

    if (data === 'adm:sup_diag_clr') {
      await redis.clearFsmState(userId);
      await redis.del(`adm_sup_diag_ref:${userId}`).catch(() => {});
      await telegramClient.editMessageText(
        chatId,
        messageId,
        '🧹 *SUPPLIER DIAGNOSTIC STATE CLEARED*\n\nTemporary order reference and FSM state removed.',
        {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'SUPPLIER READ-ONLY DIAG', fallbackEmoji: '🔬', style: 'primary', callbackData: 'adm:sup_diag', forceVisible: true }),
              ]),
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'ADMIN MENU', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
              ]),
            ],
          },
        }
      );
      return;
    }

    // =========================================================================
    // TEMPORARY ADMIN-ONLY READ-ONLY BINANCE HISTORY DIAGNOSTIC
    // =========================================================================

    if (data === 'adm:bin_diag') {
      if (!config.binance.diagnosticEnabled) {
        await redis.clearFsmState(userId);
        await redis.del(`adm_bin_diag_ref:${userId}`).catch(() => {});
        await telegramClient.editMessageText(
          chatId,
          messageId,
          '🔒 *DIAGNOSTIC DISABLED*\n\nThis temporary Binance read-only diagnostic is disabled (`BINANCE_DIAGNOSTIC_ENABLED=false`).',
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'ADMIN MENU', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      await redis.setFsmState(
        userId,
        { step: 'ADMIN_BINANCE_DIAG_ORDER_ID', data: { fixedWindow: true } },
        300
      );

      const prompt =
        `🔬 *BINANCE READ-ONLY HISTORY DIAGNOSTIC*\n\n` +
        `• Mode: \`READ-ONLY\`\n` +
        `• Wallet Mutation: \`IMPOSSIBLE\`\n` +
        `• Fixed Window:\n` +
        `\`2026-11-13 14:55:45Z\`\n` +
        `to\n` +
        `\`2026-11-13 15:15:45Z\`\n\n` +
        `Please enter the customer-visible Binance *Order ID* to compare against official Binance API records.\n\n` +
        `_Held temporarily in short-TTL Redis state only (never stored in PostgreSQL)._`;

      await telegramClient.editMessageText(chatId, messageId, prompt, {
        reply_markup: {
          inline_keyboard: [
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'CLEAR DIAGNOSTIC STATE', fallbackEmoji: '🧹', style: 'default', callbackData: 'adm:bin_diag_clr', forceVisible: true }),
            ]),
            ButtonBuilder.buildActionRow([
              ButtonBuilder.buildButton({ text: 'ADMIN MENU', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
            ]),
          ],
        },
      });
      return;
    }

    if (data === 'adm:bin_diag_run') {
      if (!config.binance.diagnosticEnabled) {
        await redis.clearFsmState(userId);
        await redis.del(`adm_bin_diag_ref:${userId}`).catch(() => {});
        await telegramClient.editMessageText(
          chatId,
          messageId,
          '🔒 *DIAGNOSTIC DISABLED*\n\nTemporary Binance history diagnostic is disabled (`BINANCE_DIAGNOSTIC_ENABLED=false`).',
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'ADMIN MENU', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      const cachedRef = (await redis.get(`adm_bin_diag_ref:${userId}`).catch(() => null)) || '';
      await this.executeAdminBinanceDiagnostic(chatId, userId, cachedRef);
      return;
    }

    if (data === 'adm:bin_diag_clr') {
      await redis.clearFsmState(userId);
      await redis.del(`adm_bin_diag_ref:${userId}`).catch(() => {});
      await telegramClient.editMessageText(
        chatId,
        messageId,
        '🧹 *DIAGNOSTIC STATE CLEARED*\n\nTemporary diagnostic reference and FSM state removed.',
        {
          reply_markup: {
            inline_keyboard: [
              ...(config.binance.diagnosticEnabled
                ? [
                    ButtonBuilder.buildActionRow([
                      ButtonBuilder.buildButton({ text: 'BINANCE HISTORY DIAGNOSTIC', fallbackEmoji: '🔬', style: 'primary', callbackData: 'adm:bin_diag', forceVisible: true }),
                    ]),
                  ]
                : []),
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'ADMIN MENU', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
              ]),
            ],
          },
        }
      );
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

    if (fsm.step === 'ADMIN_BINANCE_DIAG_ORDER_ID') {
      await redis.clearFsmState(userId);
      if (!config.binance.diagnosticEnabled) {
        await redis.del(`adm_bin_diag_ref:${userId}`).catch(() => {});
        await telegramClient.sendMessage(
          chatId,
          '🔒 *DIAGNOSTIC DISABLED*\n\nTemporary Binance history diagnostic is disabled (`BINANCE_DIAGNOSTIC_ENABLED=false`).',
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'ADMIN MENU', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        return;
      }

      const normalizedOrderId = text.trim();
      if (normalizedOrderId) {
        await redis.set(`adm_bin_diag_ref:${userId}`, normalizedOrderId, 300).catch(() => {});
      }
      await this.executeAdminBinanceDiagnostic(chatId, userId, normalizedOrderId);
      return;
    }

    if (fsm.step === 'ADMIN_SUPPLIER_DIAG_ORDER_REF') {
      await redis.clearFsmState(userId);
      const submittedRef = text.trim();
      if (submittedRef) {
        await redis.set(`adm_sup_diag_ref:${userId}`, submittedRef, 300).catch(() => {});
      }
      await this.executeAdminSupplierDiagnostic(chatId, userId, submittedRef || undefined);
      return;
    }

    if (fsm.step === 'ADMIN_GW_EDIT_VALUE') {
      const { targetId = 'draft', field } = fsm.data || {};
      try {
        const patch: any = {};
        if (field === 'title') {
          if (!text.trim()) throw new Error('Giveaway title cannot be empty.');
          patch.title = text.trim();
        } else if (field === 'desc') {
          patch.description = text.trim().toLowerCase() === 'clear' ? '' : text.trim();
        } else if (field === 'clabel') {
          if (!text.trim()) throw new Error('Custom product reward name cannot be empty.');
          patch.rewardType = 'CUSTOM_PRODUCT';
          patch.rewardProductId = '';
          patch.rewardLabel = text.trim();
          patch.rewardAmountUsdt = '0.00';
        } else if (field === 'wamt') {
          let dec: Decimal;
          try {
            dec = new Decimal(text.trim());
          } catch {
            throw new Error('Enter a valid USDT amount (e.g. 2.50).');
          }
          if (dec.isNaN() || dec.lessThanOrEqualTo(0)) {
            throw new Error('Wallet credit reward amount must be greater than 0 USDT.');
          }
          patch.rewardType = 'WALLET_CREDIT';
          patch.rewardProductId = '';
          patch.rewardAmountUsdt = dec.toFixed(2);
          patch.rewardLabel = `${dec.toFixed(2)} USDT Wallet Credit`;
        } else if (field === 'qty') {
          const n = parseInt(text, 10);
          if (!Number.isFinite(n) || n < 1) throw new Error('Quantity must be an integer >= 1.');
          patch.rewardQuantity = n;
        } else if (field === 'reqq') {
          const n = parseInt(text, 10);
          if (!Number.isFinite(n) || n < 0) throw new Error('Required qualified referrals must be >= 0.');
          patch.requiredQualifiedReferrals = n;
        } else if (field === 'reqt') {
          const n = parseInt(text, 10);
          if (!Number.isFinite(n) || n < 0) throw new Error('Required total referrals must be >= 0.');
          patch.requiredTotalReferrals = n;
        } else if (field === 'lim') {
          const n = parseInt(text, 10);
          if (!Number.isFinite(n) || n < 1) throw new Error('Maximum winners must be >= 1.');
          patch.claimLimit = n;
        } else if (field === 'start' || field === 'end') {
          if (text.trim().toLowerCase() === 'clear') {
            patch[field === 'start' ? 'startAt' : 'endAt'] = null;
          } else {
            const d = new Date(text.trim());
            if (isNaN(d.getTime())) throw new Error('Invalid date/time. Use ISO format e.g. 2026-12-01T00:00:00Z');
            patch[field === 'start' ? 'startAt' : 'endAt'] = d.toISOString();
          }
        }

        await redis.clearFsmState(userId);
        if (targetId === 'draft') {
          const raw = await redis.get(`gw_draft:${userId}`).catch(() => null);
          const draft = raw ? { ...JSON.parse(raw), ...patch } : patch;
          await redis.set(`gw_draft:${userId}`, JSON.stringify(draft), 1800);
          await this.renderAdminGiveawayDraft(chatId, undefined, draft, '✅ Field updated!');
        } else {
          await giveawayService.updateGiveaway(targetId, patch, userId);
          await this.renderAdminGiveawayDetail(chatId, undefined, targetId, '✅ Giveaway updated live!');
        }
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ *VALIDATION ERROR*\n\n${err.message}\n\nPlease try again:`);
      }
      return;
    }

    if (fsm.step === 'ADMIN_REF_EDIT_VALUE') {
      const { targetId = 'draft', field } = fsm.data || {};
      try {
        const patch: any = {};
        if (field === 'title') {
          if (!text.trim()) throw new Error('Tier title cannot be empty.');
          patch.title = text.trim();
        } else if (field === 'req') {
          const n = parseInt(text, 10);
          if (!Number.isFinite(n) || n < 1) throw new Error('Required qualified referrals must be >= 1.');
          patch.requiredQualifiedReferrals = n;
        } else if (field === 'amt') {
          const num = Number(text.trim());
          if (!Number.isFinite(num) || num <= 0) throw new Error('Amount must be > 0.');
          patch.rewardAmount = text.trim();
        } else if (field === 'qty') {
          const n = parseInt(text, 10);
          if (!Number.isFinite(n) || n < 1) throw new Error('Quantity must be >= 1.');
          patch.rewardQuantity = n;
        }

        await redis.clearFsmState(userId);
        if (targetId === 'draft') {
          const raw = await redis.get(`ref_draft:${userId}`).catch(() => null);
          const draft = raw ? { ...JSON.parse(raw), ...patch } : patch;
          await redis.set(`ref_draft:${userId}`, JSON.stringify(draft), 1800);
          await this.renderAdminReferralDraft(chatId, undefined, draft, '✅ Tier field updated!');
        } else {
          await referralService.updateRewardTier(targetId, patch, userId);
          await this.renderAdminReferralTierDetail(chatId, undefined, targetId, '✅ Referral tier updated!');
        }
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ *VALIDATION ERROR*\n\n${err.message}\n\nPlease try again:`);
      }
      return;
    }

    if (fsm.step === 'ADMIN_REF_SETTINGS_VALUE') {
      const { field } = fsm.data || {};
      try {
        const num = Number(text.trim());
        if (!Number.isFinite(num) || num < 0) throw new Error('Enter a valid non-negative number.');
        await referralService.updateSettings(
          field === 'min' ? { minQualifyingOrderUsdt: text.trim() } : { rewardPercentage: text.trim() },
          userId
        );
        await redis.clearFsmState(userId);
        await telegramClient.sendMessage(chatId, '✅ Referral threshold rules updated!', {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'Back to Referrals', fallbackEmoji: '👥', style: 'primary', callbackData: 'adm:ref' }),
              ]),
            ],
          },
        });
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ ${err.message}`);
      }
      return;
    }

    if (fsm.step === 'ADMIN_CH_ADD_INPUT') {
      try {
        const parts = text.split('|').map(s => s.trim()).filter(Boolean);
        const channelIdentifier = parts[0] || '';
        const title = parts[1] || channelIdentifier;
        const inviteUrl = parts[2];
        await channelService.addChannel({ channelIdentifier, title, inviteUrl }, userId);
        await redis.clearFsmState(userId);
        await this.renderAdminChannelsHub(chatId, undefined, `✅ Added channel *${this.escapeDiagMarkdown(title)}*.`);
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ *VALIDATION ERROR*\n\n${err.message}\n\nTry again (e.g. \`@MyChannel | My Channel\`):`);
      }
      return;
    }

    if (fsm.step === 'ADMIN_SETTINGS_VALUE') {
      const { kind } = fsm.data || {};
      try {
        if (kind === 'welcome') {
          await uiConfigService.upsertSetting({ settingKey: 'msg.welcome', languageCode: 'en', textValue: text, adminId: userId });
        } else if (kind === 'support') {
          await uiConfigService.upsertSetting({ settingKey: 'msg.support_prompt', languageCode: 'en', textValue: text, adminId: userId });
        } else if (kind === 'maint_msg') {
          await settingsService.updateMaintenanceConfig({ message: text }, userId);
        } else if (kind === 'gw_lim') {
          const lim = parseInt(text, 10);
          if (!Number.isFinite(lim) || lim < 1) throw new Error('Limit must be an integer >= 1.');
          await giveawayService.updateSettings({ defaultClaimLimit: lim }, userId);
        } else if (kind === 'banner_welcome') {
          await settingsService.updateBannerImages({ welcomeBannerUrl: text }, userId);
        } else if (kind === 'banner_shop') {
          await settingsService.updateBannerImages({ shopBannerUrl: text }, userId);
        } else if (kind === 'banner_support') {
          await settingsService.updateBannerImages({ supportBannerUrl: text }, userId);
        }
        await redis.clearFsmState(userId);
        await this.renderAdminSettingsCenter(chatId, undefined, '✅ Setting updated live without redeploy!');
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ *VALIDATION ERROR*\n\n${err.message}`);
      }
      return;
    }

    if (fsm.step === 'ADMIN_DEP_CUSTOM_USD') {
      const { depositId } = fsm.data || {};
      try {
        let dec: Decimal;
        try {
          dec = new Decimal(text.trim());
        } catch {
          throw new Error('Enter a valid numeric USD amount (e.g. 0.50 or 1.25).');
        }
        if (dec.isNaN() || dec.lessThanOrEqualTo(0)) {
          throw new Error('USD credit amount must be greater than 0.00.');
        }

        const res = await manualPaymentService.approveDeposit(depositId, userId, {
          customUsdAmount: dec.toFixed(2),
          isCustomInput: true,
          notes: `Custom admin USD credit (${dec.toFixed(2)})`,
        });
        await redis.clearFsmState(userId);

        await telegramClient.sendMessage(
          chatId,
          `✅ *CUSTOM DEPOSIT CREDITED*\n\nDeposit \`${depositId}\` approved.\nCredited \`$${Number(res.amount).toFixed(2)} USD\` to user \`${res.userId}\`.`,
          {
            reply_markup: {
              inline_keyboard: [
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'NEXT PENDING DEPOSIT', fallbackEmoji: '💳', style: 'primary', callbackData: 'adm:dep', forceVisible: true }),
                ]),
                ButtonBuilder.buildActionRow([
                  ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
                ]),
              ],
            },
          }
        );
        await telegramClient.sendMessage(
          res.userId,
          `🎉 *DEPOSIT APPROVED*\n\nYour deposit of \`$${Number(res.amount).toFixed(2)} USD\` has been approved and credited to your wallet balance.`
        ).catch(() => {});
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ *CUSTOM CREDIT ERROR*\n\n${err.message}\n\nPlease enter a valid USD amount (e.g. \`1.25\`):`, {
          reply_markup: {
            inline_keyboard: [
              ButtonBuilder.buildActionRow([
                ButtonBuilder.buildButton({ text: 'Cancel', fallbackEmoji: '❌', style: 'danger', callbackData: `adm:dep_v:${depositId}`, forceVisible: true }),
              ]),
            ],
          },
        });
      }
      return;
    }

    if (fsm.step === 'ADMIN_DEP_SETTINGS_VALUE') {
      const { field } = fsm.data || {};
      try {
        if (field === 'rate') {
          await manualPaymentService.updateDepositSettings({ pkrPerUsd: text.trim() }, userId);
        } else if (field === 'min') {
          await manualPaymentService.updateDepositSettings({ minPkr: text.trim() }, userId);
        } else if (field === 'max') {
          await manualPaymentService.updateDepositSettings({ maxPkr: text.trim() }, userId);
        }
        await redis.clearFsmState(userId);
        await this.renderAdminDepositSettings(chatId, undefined, '✅ Deposit settings updated live without redeploy!');
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ *VALIDATION ERROR*\n\n${err.message}\n\nPlease try again:`);
      }
      return;
    }

    if (fsm.step === 'ADMIN_ANN_EDIT_VALUE') {
      const { targetId = 'draft', field } = fsm.data || {};
      try {
        const patch: any = {};
        if (field === 'title') {
          if (!text.trim()) throw new Error('Announcement title cannot be empty.');
          patch.title = text.trim();
        } else if (field === 'msg') {
          if (!text.trim()) throw new Error('Announcement message cannot be empty.');
          patch.messageText = text;
        } else if (field === 'btns') {
          patch.buttons = announcementService.parseButtonsInput(text);
        }

        await redis.clearFsmState(userId);
        if (targetId === 'draft') {
          const raw = await redis.get(`ann_draft:${userId}`).catch(() => null);
          const draft = raw ? { ...JSON.parse(raw), ...patch } : patch;
          await redis.set(`ann_draft:${userId}`, JSON.stringify(draft), 1800);
          await this.renderAdminAnnouncementDraft(chatId, undefined, draft, '✅ Field updated!');
        } else {
          await announcementService.updateAnnouncement(targetId, patch, userId);
          await this.renderAdminAnnouncementDetail(chatId, undefined, targetId, '✅ Announcement updated!');
        }
      } catch (err: any) {
        await telegramClient.sendMessage(chatId, `⚠️ *VALIDATION ERROR*\n\n${err.message}\n\nPlease try again:`);
      }
      return;
    }

    if (fsm.step === 'ADMIN_ANN_EDIT_MEDIA') {
      const { targetId = 'draft' } = fsm.data || {};
      const clean = text.trim();
      const clearing = clean.toLowerCase() === 'clear' || clean.toLowerCase() === 'none';
      await redis.clearFsmState(userId);

      if (targetId === 'draft') {
        const raw = await redis.get(`ann_draft:${userId}`).catch(() => null);
        const draft = raw ? JSON.parse(raw) : { title: '', messageText: '', mediaType: 'TEXT', mediaFileId: null, buttons: [] };
        if (clearing) {
          draft.mediaFileId = null;
          draft.mediaType = 'TEXT';
        } else {
          draft.mediaFileId = clean;
          if (draft.mediaType === 'TEXT') draft.mediaType = 'PHOTO';
        }
        await redis.set(`ann_draft:${userId}`, JSON.stringify(draft), 1800);
        await this.renderAdminAnnouncementDraft(
          chatId,
          undefined,
          draft,
          clearing ? '✅ Media cleared (Text-only).' : '✅ Media image saved!'
        );
      } else {
        const curr = await announcementService.getAnnouncementById(targetId);
        await announcementService.updateAnnouncement(
          targetId,
          clearing
            ? { mediaType: 'TEXT', mediaFileId: null }
            : { mediaType: curr?.mediaType === 'BANNER' ? 'BANNER' : 'PHOTO', mediaFileId: clean },
          userId
        );
        await this.renderAdminAnnouncementDetail(
          chatId,
          undefined,
          targetId,
          clearing ? '✅ Media cleared (Text-only).' : '✅ Media image updated!'
        );
      }
      return;
    }
  }

  public async handleAdminPhotoInput(msg: TelegramMessage, fsm: UserFsmState): Promise<void> {
    if (!msg.from || !msg.photo || msg.photo.length === 0) return;
    const userId = String(msg.from.id);
    const chatId = msg.chat.id;

    if (!this.checkAuthorization(userId)) {
      await redis.clearFsmState(userId);
      await telegramClient.sendMessage(chatId, '⛔ *ACCESS DENIED*');
      return;
    }

    if (fsm.step === 'ADMIN_ANN_EDIT_MEDIA') {
      const { targetId = 'draft' } = fsm.data || {};
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      await redis.clearFsmState(userId);

      if (targetId === 'draft') {
        const raw = await redis.get(`ann_draft:${userId}`).catch(() => null);
        const draft = raw ? JSON.parse(raw) : { title: '', messageText: '', mediaType: 'PHOTO', mediaFileId: null, buttons: [] };
        draft.mediaFileId = fileId;
        if (draft.mediaType === 'TEXT') draft.mediaType = 'PHOTO';
        await redis.set(`ann_draft:${userId}`, JSON.stringify(draft), 1800);
        await this.renderAdminAnnouncementDraft(chatId, undefined, draft, '✅ Photo attached from Telegram upload!');
      } else {
        const curr = await announcementService.getAnnouncementById(targetId);
        await announcementService.updateAnnouncement(
          targetId,
          { mediaType: curr?.mediaType === 'BANNER' ? 'BANNER' : 'PHOTO', mediaFileId: fileId },
          userId
        );
        await this.renderAdminAnnouncementDetail(chatId, undefined, targetId, '✅ Photo updated from Telegram upload!');
      }
    }
  }

  private escapeDiagMarkdown(val: string): string {
    return String(val || '').replace(/([_*`\[])/g, '\\$1');
  }

  private getDiagnosticActionKeyboard() {
    return {
      inline_keyboard: [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'RUN READ-ONLY AGAIN',
            fallbackEmoji: '🔄',
            style: 'primary',
            callbackData: 'adm:bin_diag_run',
            forceVisible: true,
          }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'CLEAR DIAGNOSTIC STATE',
            fallbackEmoji: '🧹',
            style: 'default',
            callbackData: 'adm:bin_diag_clr',
            forceVisible: true,
          }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'ADMIN MENU',
            fallbackEmoji: '⬅️',
            style: 'default',
            callbackData: 'adm:main',
            forceVisible: true,
          }),
        ]),
      ],
    };
  }

  /**
   * Execute temporary admin-only read-only Binance history diagnostic with guaranteed terminal response.
   */
  public async executeAdminBinanceDiagnostic(
    chatId: number,
    userId: string,
    submittedReference = ''
  ): Promise<BinanceReadOnlyDiagnosticResult> {
    if (!this.checkAuthorization(userId)) {
      await telegramClient.sendMessage(chatId, '⛔ *ACCESS DENIED*');
      throw new Error('Unauthorized admin diagnostic execution');
    }

    if (!config.binance.diagnosticEnabled) {
      const blocked: BinanceReadOnlyDiagnosticResult = {
        mode: 'READ_ONLY',
        walletMutation: 'IMPOSSIBLE',
        windowStartMs: BINANCE_DIAGNOSTIC_FIXED_WINDOW.startTime,
        windowEndMs: BINANCE_DIAGNOSTIC_FIXED_WINDOW.endTime,
        windowStartIso: new Date(BINANCE_DIAGNOSTIC_FIXED_WINDOW.startTime).toISOString(),
        windowEndIso: new Date(BINANCE_DIAGNOSTIC_FIXED_WINDOW.endTime).toISOString(),
        httpStatus: 0,
        binanceCode: null,
        binanceMessage: 'Feature flag BINANCE_DIAGNOSTIC_ENABLED is false',
        recordsReturned: 0,
        relevantRecordsCount: 0,
        candidates: [],
        identifierConclusion: 'BINANCE_API_REJECTED',
        durationMs: 0,
        success: false,
      };
      await telegramClient.sendMessage(
        chatId,
        '🔒 *DIAGNOSTIC DISABLED*\n\nFeature flag `BINANCE_DIAGNOSTIC_ENABLED=false`.',
        { reply_markup: this.getDiagnosticActionKeyboard() }
      );
      return blocked;
    }

    await telegramClient.sendMessage(chatId, '🔬 Running read-only Binance history diagnostic...').catch(() => {});

    let diag: BinanceReadOnlyDiagnosticResult;
    try {
      diag = await binanceService.inspectPayHistoryReadOnly(
        BINANCE_DIAGNOSTIC_FIXED_WINDOW.startTime,
        BINANCE_DIAGNOSTIC_FIXED_WINDOW.endTime,
        submittedReference
      );
    } catch (err: any) {
      diag = {
        mode: 'READ_ONLY',
        walletMutation: 'IMPOSSIBLE',
        windowStartMs: BINANCE_DIAGNOSTIC_FIXED_WINDOW.startTime,
        windowEndMs: BINANCE_DIAGNOSTIC_FIXED_WINDOW.endTime,
        windowStartIso: new Date(BINANCE_DIAGNOSTIC_FIXED_WINDOW.startTime).toISOString(),
        windowEndIso: new Date(BINANCE_DIAGNOSTIC_FIXED_WINDOW.endTime).toISOString(),
        httpStatus: 0,
        binanceCode: null,
        binanceMessage: 'Diagnostic exception occurred safely without mutation',
        recordsReturned: 0,
        relevantRecordsCount: 0,
        candidates: [],
        identifierConclusion: 'BINANCE_API_REJECTED',
        durationMs: 0,
        success: false,
        errorClassification: err?.message || 'EXCEPTION',
      };
    }

    const maskedAdmin = maskIdentifier(userId);
    const auditPayload = {
      adminUserId: maskedAdmin,
      windowStart: diag.windowStartIso,
      windowEnd: diag.windowEndIso,
      httpStatus: diag.httpStatus,
      binanceCode: diag.binanceCode,
      recordsReturned: diag.recordsReturned,
      relevantRecords: diag.relevantRecordsCount,
      identifierConclusion: diag.identifierConclusion,
      durationMs: diag.durationMs,
      status: diag.success ? 'SUCCESS' : 'FAILED',
    };

    logger.info('BINANCE_READ_ONLY_DIAGNOSTIC_EXECUTED', auditPayload);
    try {
      await db.query(
        `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
         VALUES ($1, $2, 'BINANCE_READ_ONLY_DIAGNOSTIC_EXECUTED', 'binance_pay_history', $3, $4)`,
        [
          `aud_bin_diag_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          maskedAdmin,
          'fixed_20261113_0_2_usdt',
          JSON.stringify(auditPayload),
        ]
      );
    } catch (auditErr: any) {
      logger.warn('Failed to persist sanitized Binance diagnostic audit row (non-fatal)', {
        error: auditErr?.message,
      });
    }

    let report =
      `🔬 *BINANCE READ-ONLY DIAGNOSTIC*\n\n` +
      `Mode: \`READ-ONLY\`\n` +
      `Wallet Mutation: \`IMPOSSIBLE\`\n` +
      `Window:\n` +
      `\`2026-11-13 14:55:45Z\`\n` +
      `to\n` +
      `\`2026-11-13 15:15:45Z\`\n\n` +
      `HTTP Status: \`${diag.httpStatus}\`\n` +
      `Binance Code: \`${diag.binanceCode || 'NONE'}\`\n` +
      `Message: ${this.escapeDiagMarkdown(diag.binanceMessage || 'NONE')}\n` +
      `Records Returned: \`${diag.recordsReturned}\`\n` +
      `Relevant 0.2 USDT Records: \`${diag.relevantRecordsCount}\`\n`;

    if (diag.candidates.length > 0) {
      for (const c of diag.candidates.slice(0, 5)) {
        const timeIso = new Date(c.transactionTime).toISOString();
        const keysStr = c.presentIdentifierKeys.length > 0 ? c.presentIdentifierKeys.join(', ') : 'NONE';
        report +=
          `\nCandidate:\n` +
          `Time: \`${timeIso}\`\n` +
          `Amount: \`${c.amount} ${c.currency}\`\n` +
          `Order Type: \`${c.orderType.replace(/`/g, '')}\`\n` +
          `Direction: \`${c.direction}\`\n` +
          `Receiver Match: \`${c.receiverMatch}\`\n` +
          `Transaction ID: \`${c.maskedTransactionId}\`\n` +
          `Order ID Present: \`${c.orderIdPresent}\`\n` +
          (c.orderIdPresent === 'YES' && c.maskedOrderId ? `Masked Order ID: \`${c.maskedOrderId}\`\n` : '') +
          (c.orderNoPresent === 'YES' && c.maskedOrderNo ? `Order No Present: \`YES\` (\`${c.maskedOrderNo}\`)\n` : '') +
          `Identifier Keys: \`${keysStr}\`\n`;
      }
    }

    report +=
      `\nSubmitted Reference Match:\n` +
      `\`${diag.identifierConclusion}\`\n\n` +
      `No wallet or deposit was modified.`;

    await telegramClient.sendMessage(chatId, report, {
      reply_markup: this.getDiagnosticActionKeyboard(),
    });

    return diag;
  }

  private getSupplierDiagnosticActionKeyboard() {
    return {
      inline_keyboard: [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'RUN READ-ONLY PROBE',
            fallbackEmoji: '▶️',
            style: 'primary',
            callbackData: 'adm:sup_diag_run',
            forceVisible: true,
          }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'LOOKUP ORDER REF (READ-ONLY)',
            fallbackEmoji: '🔎',
            style: 'default',
            callbackData: 'adm:sup_diag_ord',
            forceVisible: true,
          }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'CLEAR DIAGNOSTIC STATE',
            fallbackEmoji: '🧹',
            style: 'default',
            callbackData: 'adm:sup_diag_clr',
            forceVisible: true,
          }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'ADMIN MENU',
            fallbackEmoji: '⬅️',
            style: 'default',
            callbackData: 'adm:main',
            forceVisible: true,
          }),
        ]),
      ],
    };
  }

  /**
   * Execute admin-only, strictly read-only AiToolShop Supplier Diagnostic.
   * Queries GET /balance, GET /products, GET /orders, and GET /order/:ref.
   * Zero POST /order capability, zero wallet mutation, masked output only.
   */
  public async executeAdminSupplierDiagnostic(
    chatId: number,
    userId: string,
    submittedOrderRef?: string
  ): Promise<SupplierReadOnlyDiagnosticResult> {
    if (!this.checkAuthorization(userId)) {
      await telegramClient.sendMessage(chatId, '⛔ *ACCESS DENIED*');
      throw new Error('Unauthorized admin supplier diagnostic execution');
    }

    await telegramClient.sendMessage(chatId, '🔬 Running read-only AiToolShop supplier diagnostic...').catch(() => {});

    const diag = await supplierService.runReadOnlyDiagnostic(submittedOrderRef);
    const maskedAdmin = maskIdentifier(userId);
    const auditPayload = {
      adminUserId: maskedAdmin,
      activeBaseUrl: diag.activeBaseUrl,
      baseUrlSource: diag.baseUrlSource,
      balanceOk: diag.balanceCheck.ok,
      balanceHttpStatus: diag.balanceCheck.httpStatus,
      productsOk: diag.productsCheck.ok,
      productsHttpStatus: diag.productsCheck.httpStatus,
      productsCount: diag.productsCheck.totalCount,
      cheapestCandidateId: diag.productsCheck.cheapestActiveInStock?.supplierProductId || null,
      ordersListOk: diag.ordersListCheck.ok,
      ordersListHttpStatus: diag.ordersListCheck.httpStatus,
      orderRefTested: diag.orderRefCheck.tested,
      orderRefMasked: diag.orderRefCheck.testedRefMasked || null,
      orderRefHttpStatus: diag.orderRefCheck.httpStatus,
      durationMs: diag.durationMs,
    };

    logger.info('SUPPLIER_READ_ONLY_DIAGNOSTIC_EXECUTED', auditPayload);
    try {
      await db.query(
        `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
         VALUES ($1, $2, 'SUPPLIER_READ_ONLY_DIAGNOSTIC_EXECUTED', 'supplier_reseller_api', $3, $4)`,
        [
          `aud_sup_diag_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          maskedAdmin,
          submittedOrderRef ? maskSupplierRef(submittedOrderRef) : 'probe',
          JSON.stringify(auditPayload),
        ]
      );
    } catch (auditErr: any) {
      logger.warn('Failed to persist sanitized supplier diagnostic audit row (non-fatal)', {
        error: auditErr?.message,
      });
    }

    const cheapest = diag.productsCheck.cheapestActiveInStock;
    const cheapestInstant = diag.productsCheck.cheapestInstantInStock;

    let report =
      `🔬 *SUPPLIER READ-ONLY DIAGNOSTIC REPORT*\n\n` +
      `Mode: \`${diag.mode}\`\n` +
      `Purchasing Capability: \`${diag.purchasingCapability}\`\n` +
      `Wallet Mutation: \`${diag.walletMutation}\`\n` +
      `LIVE\\_ORDERING\\_ENABLED: \`${diag.liveOrderingEnabled}\`\n\n` +
      `🌐 *Base URL Configuration:*\n` +
      `• Active URL: \`${diag.activeBaseUrl}\`\n` +
      `• Source: \`${diag.baseUrlSource}\`\n` +
      `• Official Doc URL: \`${diag.officialDocBaseUrl}\`\n` +
      `• API Key Present: \`${diag.apiKeyConfigured ? 'YES (MASKED)' : 'NO'}\`\n\n` +
      `💳 *GET /balance:*\n` +
      `• HTTP Status: \`${diag.balanceCheck.httpStatus}\`\n` +
      `• OK: \`${diag.balanceCheck.ok}\`\n` +
      (diag.balanceCheck.ok
        ? `• Reseller Balance: \`${diag.balanceCheck.balanceUsdt} ${diag.balanceCheck.currency || 'USDT'}\`\n`
        : `• Error: ${this.escapeDiagMarkdown(diag.balanceCheck.error || 'UNKNOWN')}\n`) +
      `\n🛍️ *GET /products:*\n` +
      `• HTTP Status: \`${diag.productsCheck.httpStatus}\`\n` +
      `• Total Returned: \`${diag.productsCheck.totalCount}\`\n` +
      `• Active In-Stock: \`${diag.productsCheck.activeInStockCount}\`\n`;

    if (cheapest) {
      report +=
        `• Cheapest Active SKU: ID \`${cheapest.supplierProductId}\` | ` +
        `\`${cheapest.costUsdt} USDT\` | ` +
        `Stock: \`${cheapest.isUnlimited ? 'UNLIMITED' : cheapest.stock}\` | ` +
        `Requires Email: \`${cheapest.requiresEmail}\`\n` +
        `  Name: ${this.escapeDiagMarkdown(cheapest.name)}\n`;
    }
    if (cheapestInstant && cheapestInstant.supplierProductId !== cheapest?.supplierProductId) {
      report +=
        `• Cheapest Instant SKU: ID \`${cheapestInstant.supplierProductId}\` | ` +
        `\`${cheapestInstant.costUsdt} USDT\` | Requires Email: \`false\`\n` +
        `  Name: ${this.escapeDiagMarkdown(cheapestInstant.name)}\n`;
    }
    if (!diag.productsCheck.ok && diag.productsCheck.error) {
      report += `• Error: ${this.escapeDiagMarkdown(diag.productsCheck.error)}\n`;
    }

    report +=
      `\n📦 *GET /orders:*\n` +
      `• HTTP Status: \`${diag.ordersListCheck.httpStatus}\`\n` +
      `• OK: \`${diag.ordersListCheck.ok}\`\n` +
      `• Orders Returned: \`${diag.ordersListCheck.count}\`\n` +
      (diag.ordersListCheck.latestMaskedRef
        ? `• Latest Order Ref (Masked): \`${diag.ordersListCheck.latestMaskedRef}\`\n`
        : '') +
      (diag.ordersListCheck.error
        ? `• Error: ${this.escapeDiagMarkdown(diag.ordersListCheck.error)}\n`
        : '') +
      `\n🔎 *GET /order/:ref:*\n` +
      `• Tested: \`${diag.orderRefCheck.tested}\`\n` +
      (diag.orderRefCheck.tested
        ? `• Probe Target (Masked): \`${diag.orderRefCheck.testedRefMasked || 'NONE'}\`\n` +
          `• HTTP Status: \`${diag.orderRefCheck.httpStatus}\`\n` +
          `• Found: \`${diag.orderRefCheck.found}\`\n` +
          `• Normalized Status: \`${diag.orderRefCheck.status}\`\n` +
          (diag.orderRefCheck.error
            ? `• Error: ${this.escapeDiagMarkdown(diag.orderRefCheck.error)}\n`
            : '')
        : `• Reason: ${this.escapeDiagMarkdown(diag.orderRefCheck.error || 'SKIPPED')}\n`) +
      `\n⏱️ Duration: \`${diag.durationMs}ms\`\n` +
      `_No order was placed. No wallet was modified. All keys/refs masked._`;

    await telegramClient.sendMessage(chatId, report, {
      reply_markup: this.getSupplierDiagnosticActionKeyboard(),
    });

    return diag;
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

  private formatAdminOrderDetailText(detail: NonNullable<Awaited<ReturnType<typeof orderService.getAdminOrderDetail>>>): string {
    const customerHandle = detail.customerUsername
      ? `@${this.escapeDiagMarkdown(detail.customerUsername)}`
      : detail.customerFirstName
      ? this.escapeDiagMarkdown(detail.customerFirstName)
      : 'Customer';
    const createdIso = new Date(detail.createdAt).toISOString();

    return (
      `📋 *ADMIN ORDER DETAIL*\n\n` +
      `• Local Order ID: \`${detail.id}\`\n` +
      `• Supplier Order Ref: \`${this.escapeDiagMarkdown(detail.supplierOrderRef || 'NONE')}\`\n` +
      `• Status: *${detail.status}* (Supplier: *${this.escapeDiagMarkdown(detail.supplierStatus || 'NONE')}*)\n` +
      `• Created Time: \`${createdIso}\`\n` +
      `• Customer: \`${detail.userId}\` (${customerHandle})\n\n` +
      `• Product: *${this.escapeDiagMarkdown(detail.productName)}* x${detail.quantity}\n` +
      `• Amount Paid: \`${detail.totalPrice} USDT\`\n` +
      `• Delivered Items Stored: *${detail.deliveredCount}*\n` +
      (detail.errorMessage ? `• Diagnostic Note: ${this.escapeDiagMarkdown(detail.errorMessage)}\n` : '') +
      `\n_Reconciliation performs read-only GET /order/{ref} only — zero reorders, debits, or refunds._`
    );
  }

  private getAdminOrderDetailKeyboard(orderId: string) {
    return {
      inline_keyboard: [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'Lookup Supplier Order (Read-Only)',
            fallbackEmoji: '🔎',
            style: 'primary',
            callbackData: `adm:ord_lkp:${orderId}`,
            forceVisible: true,
          }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'Reconcile Order',
            fallbackEmoji: '🔄',
            style: 'success',
            callbackData: `adm:ord_rec:${orderId}`,
            forceVisible: true,
          }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'View Status History',
            fallbackEmoji: '📜',
            style: 'default',
            callbackData: `adm:ord_hst:${orderId}`,
            forceVisible: true,
          }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'Back',
            fallbackEmoji: '⬅️',
            style: 'default',
            callbackData: 'adm:ord',
            forceVisible: true,
          }),
        ]),
      ],
    };
  }

  private async recordOrderAuditLog(
    adminUserId: string,
    action: string,
    orderId: string,
    details: Record<string, unknown>
  ): Promise<void> {
    const maskedAdmin = maskIdentifier(adminUserId);
    const payload = {
      adminUserId: maskedAdmin,
      orderId,
      ...details,
    };
    logger.info(action, payload);
    try {
      await db.query(
        `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
         VALUES ($1, $2, $3, 'local_orders', $4, $5)`,
        [
          `aud_ord_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          maskedAdmin,
          action,
          orderId,
          JSON.stringify(payload),
        ]
      );
    } catch (auditErr: any) {
      logger.warn('Failed to persist admin order audit log (non-fatal)', {
        action,
        orderId,
        error: auditErr?.message,
      });
    }
  }

  // ===========================================================================
  // RENDER HELPERS FOR GIVEAWAYS, REFERRALS, CHANNELS, SUPPLIERS & SETTINGS
  // ===========================================================================

  private async renderAdminGiveawayDraft(
    chatId: number,
    messageId: number | undefined,
    draft: any,
    notice?: string
  ): Promise<void> {
    const rType: GiveawayRewardType = draft.rewardType || 'STORE_PRODUCT';
    const rewardDisplay =
      rType === 'WALLET_CREDIT'
        ? `${draft.rewardAmountUsdt || '0.00'} USDT Wallet Credit`
        : rType === 'CUSTOM_PRODUCT'
        ? draft.rewardLabel || 'Not set'
        : draft.rewardProductName || 'Not selected';

    const primaryRewardBtn =
      rType === 'WALLET_CREDIT'
        ? ButtonBuilder.buildButton({ text: 'Set Wallet USDT', fallbackEmoji: '💰', style: 'primary', callbackData: 'adm:gw_f:draft:wamt', forceVisible: true })
        : rType === 'CUSTOM_PRODUCT'
        ? ButtonBuilder.buildButton({ text: 'Set Custom Name', fallbackEmoji: '🎁', style: 'primary', callbackData: 'adm:gw_f:draft:clabel', forceVisible: true })
        : ButtonBuilder.buildButton({ text: 'Pick Product (DB)', fallbackEmoji: '🛍️', style: 'primary', callbackData: 'adm:gw_prod:draft:1', forceVisible: true });

    const text =
      (notice ? `${notice}\n\n` : '') +
      `🎁 *CREATE NEW GIVEAWAY*\n\n` +
      `• Name: *${this.escapeDiagMarkdown(draft.title || 'Not set')}*\n` +
      `• Reward Type: \`${rType}\`\n` +
      `• Reward: *${this.escapeDiagMarkdown(rewardDisplay)}*\n` +
      `• Reward Qty: \`${draft.rewardQuantity || 1}\`\n` +
      `• Req Qualified Referrals: \`${draft.requiredQualifiedReferrals ?? 3}\`\n` +
      `• Req Total Referrals: \`${draft.requiredTotalReferrals ?? 0}\`\n` +
      `• Max Winners: \`${draft.claimLimit || 50}\`\n` +
      `• Start Time: \`${draft.startAt || 'Immediate'}\`\n` +
      `• End Time: \`${draft.endAt || 'No expiry'}\`\n` +
      `• Status: ${draft.isActive !== false ? '✅ Active' : '⏸️ Inactive'} | ${draft.isPublic !== false ? '👁️ Public' : '🙈 Private'}\n` +
      (draft.description ? `• Description: _${this.escapeDiagMarkdown(draft.description)}_\n` : '');

    const markup = {
      inline_keyboard: [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Set Name', fallbackEmoji: '✏️', style: 'primary', callbackData: 'adm:gw_f:draft:title', forceVisible: true }),
          primaryRewardBtn,
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Store Product', style: rType === 'STORE_PRODUCT' ? 'success' : 'default', callbackData: 'adm:gw_rt:draft:store', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Custom Product', style: rType === 'CUSTOM_PRODUCT' ? 'success' : 'default', callbackData: 'adm:gw_rt:draft:custom', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Wallet Credit', style: rType === 'WALLET_CREDIT' ? 'success' : 'default', callbackData: 'adm:gw_rt:draft:wallet', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Reward Qty', style: 'default', callbackData: 'adm:gw_f:draft:qty', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Req Qualified', style: 'default', callbackData: 'adm:gw_f:draft:reqq', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Req Total', style: 'default', callbackData: 'adm:gw_f:draft:reqt', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Max Winners', style: 'default', callbackData: 'adm:gw_f:draft:lim', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Start Time', style: 'default', callbackData: 'adm:gw_f:draft:start', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'End Time', style: 'default', callbackData: 'adm:gw_f:draft:end', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Description', style: 'default', callbackData: 'adm:gw_f:draft:desc', forceVisible: true }),
          ButtonBuilder.buildButton({ text: draft.isPublic !== false ? 'Public: YES' : 'Public: NO', style: 'default', callbackData: 'adm:gw_draft_vis', forceVisible: true }),
          ButtonBuilder.buildButton({ text: draft.isActive !== false ? 'Active: YES' : 'Active: NO', style: 'default', callbackData: 'adm:gw_draft_act', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'SAVE & PUBLISH GIVEAWAY', fallbackEmoji: '✅', style: 'success', callbackData: 'adm:gw_draft_save', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Cancel', fallbackEmoji: '⬅️', style: 'danger', callbackData: 'adm:gw', forceVisible: true }),
        ]),
      ],
    };

    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: markup });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: markup });
    }
  }

  private async renderAdminGiveawayDetail(
    chatId: number,
    messageId: number | undefined,
    giveawayId: string,
    notice?: string
  ): Promise<void> {
    const gw = await giveawayService.getGiveawayById(giveawayId);
    if (!gw) {
      const text = '⚠️ Giveaway not found.';
      if (messageId) {
        await telegramClient.editMessageText(chatId, messageId, text);
      } else {
        await telegramClient.sendMessage(chatId, text);
      }
      return;
    }

    const primaryRewardBtn =
      gw.rewardType === 'WALLET_CREDIT'
        ? ButtonBuilder.buildButton({ text: 'Edit Wallet USDT', style: 'primary', callbackData: `adm:gw_f:${gw.id}:wamt`, forceVisible: true })
        : gw.rewardType === 'CUSTOM_PRODUCT'
        ? ButtonBuilder.buildButton({ text: 'Edit Custom Name', style: 'primary', callbackData: `adm:gw_f:${gw.id}:clabel`, forceVisible: true })
        : ButtonBuilder.buildButton({ text: 'Change Product', style: 'primary', callbackData: `adm:gw_prod:${gw.id}:1`, forceVisible: true });

    const text =
      (notice ? `${notice}\n\n` : '') +
      `🎁 *GIVEAWAY DETAILS & EDITOR*\n\n` +
      `• Title: *${this.escapeDiagMarkdown(gw.title)}*\n` +
      `• Reward Type: \`${gw.rewardType}\`\n` +
      `• Reward: *${this.escapeDiagMarkdown(gw.rewardProductName)}*\n` +
      (gw.rewardType === 'WALLET_CREDIT' ? `• Wallet Amount: \`${gw.rewardAmountUsdt} USDT\`\n` : '') +
      `• Reward Qty: \`${gw.rewardQuantity}\`\n` +
      `• Req Qualified Referrals: \`${gw.requiredQualifiedReferrals}\`\n` +
      `• Req Total Referrals: \`${gw.requiredTotalReferrals}\`\n` +
      `• Winners Claimed: \`${gw.claimsCount} / ${gw.claimLimit}\`\n` +
      `• Start Time: \`${gw.startAt || 'Immediate'}\`\n` +
      `• End Time: \`${gw.endAt || 'No expiry'}\`\n` +
      `• Active: ${gw.isActive ? '✅ ACTIVE' : '⏸️ DISABLED'} | Visibility: ${gw.isPublic ? '👁️ PUBLIC' : '🙈 PRIVATE'}\n` +
      (gw.description ? `• Description: _${this.escapeDiagMarkdown(gw.description)}_\n` : '');

    const markup = {
      inline_keyboard: [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Edit Name', style: 'primary', callbackData: `adm:gw_f:${gw.id}:title`, forceVisible: true }),
          primaryRewardBtn,
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Store Product', style: gw.rewardType === 'STORE_PRODUCT' ? 'success' : 'default', callbackData: `adm:gw_rt:${gw.id}:store`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Custom Product', style: gw.rewardType === 'CUSTOM_PRODUCT' ? 'success' : 'default', callbackData: `adm:gw_rt:${gw.id}:custom`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Wallet Credit', style: gw.rewardType === 'WALLET_CREDIT' ? 'success' : 'default', callbackData: `adm:gw_rt:${gw.id}:wallet`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Edit Qty', style: 'default', callbackData: `adm:gw_f:${gw.id}:qty`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Req Qualified', style: 'default', callbackData: `adm:gw_f:${gw.id}:reqq`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Req Total', style: 'default', callbackData: `adm:gw_f:${gw.id}:reqt`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Max Winners', style: 'default', callbackData: `adm:gw_f:${gw.id}:lim`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Start Time', style: 'default', callbackData: `adm:gw_f:${gw.id}:start`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'End Time', style: 'default', callbackData: `adm:gw_f:${gw.id}:end`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Description', style: 'default', callbackData: `adm:gw_f:${gw.id}:desc`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: gw.isPublic ? 'Set Private' : 'Set Public', style: 'default', callbackData: `adm:gw_vis:${gw.id}`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: gw.isActive ? 'Disable Giveaway' : 'Enable Giveaway',
            fallbackEmoji: gw.isActive ? '⏸️' : '✅',
            style: gw.isActive ? 'danger' : 'success',
            callbackData: `adm:gw_tog:${gw.id}`,
            forceVisible: true,
          }),
          ButtonBuilder.buildButton({
            text: 'Delete Giveaway',
            fallbackEmoji: '🗑️',
            style: 'danger',
            callbackData: `adm:gw_del:${gw.id}`,
            forceVisible: true,
          }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Back to Giveaways', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:gw', forceVisible: true }),
        ]),
      ],
    };

    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: markup });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: markup });
    }
  }

  private async renderAdminReferralsHub(
    chatId: number,
    messageId: number | undefined,
    notice?: string
  ): Promise<void> {
    const [settings, tiers] = await Promise.all([
      referralService.getSettings(),
      referralService.listRewardTiers({ activeOnly: false }),
    ]);

    let text =
      (notice ? `${notice}\n\n` : '') +
      `👥 *REFERRAL REWARDS CONTROL CENTER*\n\n` +
      `• System Status: ${settings.rewardsEnabled ? '✅ ENABLED' : '❌ PAUSED'}\n` +
      `• Min Qualifying Order: \`${settings.minQualifyingOrderUsdt} USDT\` (COMPLETED only)\n` +
      `• Configured Tiers: \`${tiers.length}\`\n\n`;

    const rows: any[][] = [
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Create Reward Tier', fallbackEmoji: '➕', style: 'success', callbackData: 'adm:ref_new', forceVisible: true }),
        ButtonBuilder.buildButton({ text: 'Threshold Rules', fallbackEmoji: '⚙️', style: 'primary', callbackData: 'adm:ref_set', forceVisible: true }),
      ]),
    ];

    if (tiers.length === 0) {
      text += `_No referral reward tiers configured yet. Add one above._`;
    } else {
      for (const tier of tiers) {
        const rewardLabel =
          tier.rewardType === 'WALLET_USDT'
            ? `${tier.rewardAmount} USDT`
            : `${tier.rewardProductName || 'Product'} x${tier.rewardQuantity}`;
        text += `${tier.isActive ? '✅' : '⏸️'} *${this.escapeDiagMarkdown(tier.title)}* — ${tier.requiredQualifiedReferrals} Qualified → ${this.escapeDiagMarkdown(rewardLabel)}\n`;
        rows.push(
          ButtonBuilder.buildActionRow([
            ButtonBuilder.buildButton({
              text: `${tier.isActive ? '✅' : '⏸️'} ${tier.title.slice(0, 26)}`,
              style: tier.isActive ? 'primary' : 'default',
              callbackData: `adm:ref_v:${tier.id}`,
              forceVisible: true,
            }),
          ])
        );
      }
    }

    rows.push(
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
      ])
    );

    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
    }
  }

  private async renderAdminReferralDraft(
    chatId: number,
    messageId: number | undefined,
    draft: any,
    notice?: string
  ): Promise<void> {
    const isWallet = draft.rewardType !== 'PRODUCT';
    const text =
      (notice ? `${notice}\n\n` : '') +
      `🎁 *CREATE REFERRAL REWARD TIER*\n\n` +
      `• Title: *${this.escapeDiagMarkdown(draft.title || 'Not set')}*\n` +
      `• Req Qualified Referrals: \`${draft.requiredQualifiedReferrals || 3}\`\n` +
      `• Reward Type: *${isWallet ? 'WALLET_USDT' : 'PRODUCT'}*\n` +
      (isWallet
        ? `• Reward Amount: \`${draft.rewardAmount || '1.00'} USDT\`\n`
        : `• Reward Product: *${this.escapeDiagMarkdown(draft.rewardProductName || 'Not selected')}* (x${draft.rewardQuantity || 1})\n`);

    const markup = {
      inline_keyboard: [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Set Title', fallbackEmoji: '✏️', style: 'primary', callbackData: 'adm:ref_f:draft:title', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Req Qualified', style: 'primary', callbackData: 'adm:ref_f:draft:req', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: `Type: ${isWallet ? 'WALLET' : 'PRODUCT'}`, fallbackEmoji: '🔄', style: 'default', callbackData: 'adm:ref_draft_type', forceVisible: true }),
          isWallet
            ? ButtonBuilder.buildButton({ text: 'Set USDT Amount', fallbackEmoji: '💲', style: 'primary', callbackData: 'adm:ref_f:draft:amt', forceVisible: true })
            : ButtonBuilder.buildButton({ text: 'Pick Product (DB)', fallbackEmoji: '🛍️', style: 'primary', callbackData: 'adm:ref_prod:draft:1', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'SAVE MILESTONE TIER', fallbackEmoji: '✅', style: 'success', callbackData: 'adm:ref_draft_save', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Cancel', fallbackEmoji: '⬅️', style: 'danger', callbackData: 'adm:ref', forceVisible: true }),
        ]),
      ],
    };

    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: markup });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: markup });
    }
  }

  private async renderAdminReferralTierDetail(
    chatId: number,
    messageId: number | undefined,
    tierId: string,
    notice?: string
  ): Promise<void> {
    const tier = await referralService.getRewardTierById(tierId);
    if (!tier) {
      await this.renderAdminReferralsHub(chatId, messageId, '⚠️ Tier not found.');
      return;
    }

    const isWallet = tier.rewardType === 'WALLET_USDT';
    const text =
      (notice ? `${notice}\n\n` : '') +
      `🎁 *REFERRAL TIER EDITOR*\n\n` +
      `• Title: *${this.escapeDiagMarkdown(tier.title)}*\n` +
      `• Required Qualified Referrals: \`${tier.requiredQualifiedReferrals}\`\n` +
      `• Reward Type: *${tier.rewardType}*\n` +
      (isWallet
        ? `• Wallet Credit: \`${tier.rewardAmount} USDT\`\n`
        : `• Product: *${this.escapeDiagMarkdown(tier.rewardProductName || 'None')}* (x${tier.rewardQuantity})\n`) +
      `• Status: ${tier.isActive ? '✅ ACTIVE' : '⏸️ DISABLED'}`;

    const markup = {
      inline_keyboard: [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Edit Title', style: 'primary', callbackData: `adm:ref_f:${tier.id}:title`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Req Qualified', style: 'primary', callbackData: `adm:ref_f:${tier.id}:req`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          isWallet
            ? ButtonBuilder.buildButton({ text: 'Edit USDT Amount', style: 'primary', callbackData: `adm:ref_f:${tier.id}:amt`, forceVisible: true })
            : ButtonBuilder.buildButton({ text: 'Pick Product (DB)', style: 'primary', callbackData: `adm:ref_prod:${tier.id}:1`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Edit Qty', style: 'default', callbackData: `adm:ref_f:${tier.id}:qty`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: tier.isActive ? 'Disable Tier' : 'Enable Tier',
            fallbackEmoji: tier.isActive ? '⏸️' : '✅',
            style: tier.isActive ? 'danger' : 'success',
            callbackData: `adm:ref_tog:${tier.id}`,
            forceVisible: true,
          }),
          ButtonBuilder.buildButton({ text: 'Delete Tier', fallbackEmoji: '🗑️', style: 'danger', callbackData: `adm:ref_del:${tier.id}`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Back to Referrals', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:ref', forceVisible: true }),
        ]),
      ],
    };

    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: markup });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: markup });
    }
  }

  private async renderAdminChannelsHub(
    chatId: number,
    messageId: number | undefined,
    notice?: string
  ): Promise<void> {
    const [cfg, channels] = await Promise.all([
      channelService.getConfig(),
      channelService.listChannels(false),
    ]);

    let text =
      (notice ? `${notice}\n\n` : '') +
      `📢 *REQUIRED CHANNELS MANAGER*\n\n` +
      `• Verification Gate: ${cfg.verificationEnabled ? '✅ ENABLED' : '❌ DISABLED'}\n` +
      `• Configured Channels: \`${channels.length}\`\n\n`;

    const rows: any[][] = [
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Add Channel', fallbackEmoji: '➕', style: 'success', callbackData: 'adm:ch_add', forceVisible: true }),
        ButtonBuilder.buildButton({
          text: cfg.verificationEnabled ? 'Disable Verification' : 'Enable Verification',
          fallbackEmoji: cfg.verificationEnabled ? '❌' : '✅',
          style: cfg.verificationEnabled ? 'danger' : 'success',
          callbackData: 'adm:ch_tog',
          forceVisible: true,
        }),
      ]),
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Test Membership Check', fallbackEmoji: '🧪', style: 'primary', callbackData: 'adm:ch_test', forceVisible: true }),
      ]),
    ];

    if (channels.length === 0) {
      text += `_No required channels added yet._`;
    } else {
      channels.forEach((ch, idx) => {
        text += `${idx + 1}. *${this.escapeDiagMarkdown(ch.title)}* (\`${this.escapeDiagMarkdown(ch.channelIdentifier)}\`)\n`;
        rows.push(
          ButtonBuilder.buildActionRow([
            ButtonBuilder.buildButton({ text: '⬆️', style: 'default', callbackData: `adm:ch_up:${ch.id}`, forceVisible: true }),
            ButtonBuilder.buildButton({ text: '⬇️', style: 'default', callbackData: `adm:ch_dn:${ch.id}`, forceVisible: true }),
            ButtonBuilder.buildButton({ text: `Remove ${ch.title.slice(0, 16)}`, fallbackEmoji: '🗑️', style: 'danger', callbackData: `adm:ch_rem:${ch.id}`, forceVisible: true }),
          ])
        );
      });
    }

    rows.push(
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
      ])
    );

    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
    }
  }

  private async renderAdminSuppliersHub(chatId: number, messageId: number | undefined): Promise<void> {
    const suppliers = await supplierService.listSuppliers();
    let text = `🏭 *SUPPLIER CONTROL CENTER*\n\n_Suppliers are managed safely via operational toggles (deletion is disabled to protect order history)._\n\n`;
    const rows: any[][] = [];

    for (const s of suppliers) {
      const statusBadge = s.isEnabled ? '✅ ENABLED' : '❌ DISABLED';
      text +=
        `• *${this.escapeDiagMarkdown(s.name)}* (${statusBadge})\n` +
        `  Routing: ${s.routingEnabled ? '✅' : '❌'} | Ordering: ${s.orderingEnabled ? '✅' : '❌'} | Sync: ${s.syncEnabled ? '✅' : '❌'}\n` +
        (s.lastBalanceUsdt ? `  Last Balance: \`${s.lastBalanceUsdt} USDT\`\n` : '');
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: `Manage ${s.name}`,
            fallbackEmoji: '🏭',
            style: 'primary',
            callbackData: `adm:sup_v:${s.id}`,
            forceVisible: true,
          }),
        ])
      );
    }

    rows.push(
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
      ])
    );

    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
    }
  }

  private async renderAdminSupplierDetail(
    chatId: number,
    messageId: number | undefined,
    supplierId: string,
    notice?: string
  ): Promise<void> {
    const s = await supplierService.getSupplierControl(supplierId);
    const text =
      (notice ? `${notice}\n\n` : '') +
      `🏭 *SUPPLIER: ${this.escapeDiagMarkdown(s.name.toUpperCase())}*\n\n` +
      `• Status: ${s.isEnabled ? '✅ Enabled' : '❌ Disabled'}\n` +
      `• Routing: ${s.routingEnabled ? '✅ ON' : '❌ OFF'}\n` +
      `• Ordering: ${s.orderingEnabled ? '✅ ON' : '❌ OFF'}\n` +
      `• Catalogue Sync: ${s.syncEnabled ? '✅ ON' : '❌ OFF'}\n` +
      `• Env Live Safety Gate: \`LIVE_ORDERING_ENABLED=${config.safety.liveOrderingEnabled}\`\n` +
      `• Last Balance: \`${s.lastBalanceUsdt ? `${s.lastBalanceUsdt} USDT` : 'Not queried'}\`\n` +
      `• Last Sync: \`${s.lastSyncAt || 'Not synced yet'}\``;

    const markup = {
      inline_keyboard: [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Check Balance', fallbackEmoji: '💰', style: 'primary', callbackData: `adm:sup_bal:${s.id}`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Orders (Read-Only)', fallbackEmoji: '📦', style: 'primary', callbackData: `adm:sup_ord:${s.id}`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Sync Catalogue', fallbackEmoji: '🔄', style: 'primary', callbackData: `adm:sup_sync:${s.id}`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Read-Only Diag', fallbackEmoji: '🔬', style: 'default', callbackData: 'adm:sup_diag', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: s.isEnabled ? 'Disable Supplier' : 'Enable Supplier', style: s.isEnabled ? 'danger' : 'success', callbackData: `adm:sup_tog:en:${s.id}`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: s.routingEnabled ? 'Routing: ON' : 'Routing: OFF', style: s.routingEnabled ? 'success' : 'danger', callbackData: `adm:sup_tog:rt:${s.id}`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: s.orderingEnabled ? 'Ordering: ON' : 'Ordering: OFF', style: s.orderingEnabled ? 'success' : 'danger', callbackData: `adm:sup_tog:or:${s.id}`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: s.syncEnabled ? 'Sync: ON' : 'Sync: OFF', style: s.syncEnabled ? 'success' : 'danger', callbackData: `adm:sup_tog:sy:${s.id}`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Back to Suppliers', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:sup', forceVisible: true }),
        ]),
      ],
    };

    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: markup });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: markup });
    }
  }

  private async renderAdminSettingsCenter(
    chatId: number,
    messageId: number | undefined,
    notice?: string
  ): Promise<void> {
    const maint = await settingsService.getMaintenanceConfig();
    const text =
      (notice ? `${notice}\n\n` : '') +
      `⚙️ *XERO KHAN SETTINGS CENTER*\n\n` +
      `Configure live messages, maintenance mode, banners, channels, giveaways & referrals without redeploying:\n\n` +
      `• Maintenance Mode: ${maint.enabled ? '⚠️ ENABLED' : '✅ LIVE (OFF)'}`;

    const markup = {
      inline_keyboard: [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Welcome Message', fallbackEmoji: '✏️', style: 'primary', callbackData: 'adm:set_e:welcome', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Support Message', fallbackEmoji: '🎧', style: 'primary', callbackData: 'adm:set_e:support', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: maint.enabled ? 'Disable Maintenance' : 'Enable Maintenance',
            fallbackEmoji: '🚧',
            style: maint.enabled ? 'success' : 'danger',
            callbackData: 'adm:set_maint',
            forceVisible: true,
          }),
          ButtonBuilder.buildButton({ text: 'Maintenance Msg', fallbackEmoji: '✏️', style: 'default', callbackData: 'adm:set_e:maint_msg', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Channel Settings', fallbackEmoji: '📢', style: 'default', callbackData: 'adm:ch', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Banner Images', fallbackEmoji: '🖼️', style: 'default', callbackData: 'adm:set_ban', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Giveaway Settings', fallbackEmoji: '🎁', style: 'default', callbackData: 'adm:set_gw', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Referral Settings', fallbackEmoji: '👥', style: 'default', callbackData: 'adm:ref_set', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Deposit Settings', fallbackEmoji: '💱', style: 'primary', callbackData: 'adm:dep_set', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'UI Labels & Buttons', fallbackEmoji: '🎨', style: 'primary', callbackData: 'adm:ui', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
        ]),
      ],
    };

    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: markup });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: markup });
    }
  }

  private async renderAdminPendingDeposit(
    chatId: number,
    messageId: number | undefined,
    targetDepositId?: string
  ): Promise<void> {
    const [{ items, totalPending }, depCfg] = await Promise.all([
      manualPaymentService.getPendingDeposits(10),
      manualPaymentService.getDepositSettings(),
    ]);

    if (items.length === 0) {
      const emptyMarkup = {
        inline_keyboard: [
          ButtonBuilder.buildActionRow([
            ButtonBuilder.buildButton({ text: 'Deposit Settings', fallbackEmoji: '⚙️', style: 'primary', callbackData: 'adm:dep_set', forceVisible: true }),
            ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
          ]),
        ],
      };
      const emptyText = '💳 *PENDING DEPOSITS*\n\n✅ No manual deposits currently pending review.';
      if (messageId) {
        await telegramClient.editMessageText(chatId, messageId, emptyText, { reply_markup: emptyMarkup });
      } else {
        await telegramClient.sendMessage(chatId, emptyText, { reply_markup: emptyMarkup });
      }
      return;
    }

    const idx = targetDepositId ? Math.max(0, items.findIndex(i => i.id === targetDepositId)) : 0;
    const dep = items[idx] || items[0];

    const customerHandle = dep.username
      ? `@${this.escapeDiagMarkdown(dep.username)}`
      : dep.firstName
      ? `${this.escapeDiagMarkdown(dep.firstName)} (ID: \`${dep.userId}\`)`
      : `User \`${dep.userId}\``;

    const liveSuggestedUsd =
      dep.submittedPkrAmount && depCfg.autoSuggestCredit
        ? manualPaymentService.calculateSuggestedUsd(dep.submittedPkrAmount, depCfg.pkrPerUsd)
        : dep.suggestedUsdAmount && depCfg.autoSuggestCredit
        ? dep.suggestedUsdAmount
        : null;

    let text =
      `💳 *PENDING DEPOSIT REVIEW (${idx + 1} of ${totalPending})*\n\n` +
      `• Customer: ${customerHandle} (\`${dep.userId}\`)\n` +
      `• Method: *${dep.methodCode}*\n` +
      `• Deposit ID: \`${dep.id}\`\n` +
      `• Sender Number: ${dep.senderPhone ? `\`${dep.senderPhone}\`` : '_Not provided_'}\n` +
      `• Screenshot: ${dep.proofFileId ? '✅ Attached' : '❌ Missing'}\n`;

    if (dep.submittedPkrAmount) {
      text += `• Paid: \`${dep.submittedPkrAmount} PKR\`\n`;
    } else {
      text += `• Submitted Amount: _Inspect screenshot_\n`;
    }

    if (liveSuggestedUsd) {
      text += `• Suggested: \`$${liveSuggestedUsd} USD\`\n`;
    } else if (Number(dep.amount) > 0) {
      text += `• Submitted USD: \`$${dep.amount} USD\`\n`;
    }

    if (dep.txid) {
      text += `• Legacy TXID: \`${this.escapeDiagMarkdown(dep.txid)}\`\n`;
    }
    if (dep.failureReason) {
      text += `⚠️ Alert: *${this.escapeDiagMarkdown(dep.failureReason)}*\n`;
    }
    text += `• Current Exchange Rate: \`1 USD = ${depCfg.pkrPerUsd} PKR\`\n`;
    text += `• Submitted At: \`${dep.createdAt ? dep.createdAt.slice(0, 19).replace('T', ' ') : ''}\``;

    const rows: any[][] = [];

    if (dep.proofFileId) {
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: 'View Screenshot',
            fallbackEmoji: '🖼️',
            style: 'primary',
            callbackData: `adm_dep_pic:${dep.id}`,
            forceVisible: true,
          }),
        ])
      );
    }

    if (liveSuggestedUsd) {
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: `Accept Suggestion ($${liveSuggestedUsd})`,
            fallbackEmoji: '✅',
            style: 'success',
            callbackData: `adm_app_amt:${dep.id}:${liveSuggestedUsd}`,
            forceVisible: true,
          }),
        ])
      );
    } else if (Number(dep.amount) > 0 && !dep.senderPhone) {
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            settingKey: 'btn.adm.approve',
            callbackData: `adm_app:${dep.id}`,
            forceVisible: true,
          }),
        ])
      );
    }

    rows.push(
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: '0.10$', style: 'success', callbackData: `adm_app_amt:${dep.id}:0.10`, forceVisible: true }),
        ButtonBuilder.buildButton({ text: '0.25$', style: 'success', callbackData: `adm_app_amt:${dep.id}:0.25`, forceVisible: true }),
        ButtonBuilder.buildButton({ text: '0.50$', style: 'success', callbackData: `adm_app_amt:${dep.id}:0.50`, forceVisible: true }),
      ])
    );

    rows.push(
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: '1$', style: 'success', callbackData: `adm_app_amt:${dep.id}:1.00`, forceVisible: true }),
        ButtonBuilder.buildButton({ text: '2$', style: 'success', callbackData: `adm_app_amt:${dep.id}:2.00`, forceVisible: true }),
        ButtonBuilder.buildButton({ text: '5$', style: 'success', callbackData: `adm_app_amt:${dep.id}:5.00`, forceVisible: true }),
      ])
    );

    const customRejectRow = [
      depCfg.allowCustomCredit
        ? ButtonBuilder.buildButton({
            text: 'Custom USD',
            fallbackEmoji: '✏️',
            style: 'primary',
            callbackData: `adm_app_cust:${dep.id}`,
            forceVisible: true,
          })
        : null,
      ButtonBuilder.buildButton({
        text: 'Reject',
        fallbackEmoji: '❌',
        style: 'danger',
        callbackData: `adm_rej:${dep.id}`,
        forceVisible: true,
      }),
    ].filter(Boolean) as any[];
    rows.push(ButtonBuilder.buildActionRow(customRejectRow));

    if (items.length > 1) {
      const nextDep = items[(idx + 1) % items.length];
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: `Next Pending (${idx + 1}/${items.length}) ➡️`,
            style: 'default',
            callbackData: `adm:dep_v:${nextDep.id}`,
            forceVisible: true,
          }),
        ])
      );
    }

    rows.push(
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Deposit Settings', fallbackEmoji: '⚙️', style: 'default', callbackData: 'adm:dep_set', forceVisible: true }),
        ButtonBuilder.buildButton({ text: 'BACK TO ADMIN', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:main', forceVisible: true }),
      ])
    );

    const markup = { inline_keyboard: rows };
    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: markup });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: markup });
    }
  }

  private async renderAdminDepositSettings(
    chatId: number,
    messageId: number | undefined,
    notice?: string
  ): Promise<void> {
    const cfg = await manualPaymentService.getDepositSettings();
    const text =
      (notice ? `${notice}\n\n` : '') +
      `⚙️ *DEPOSIT SETTINGS (LIVE)*\n\n` +
      `• Exchange Rate: \`${cfg.pkrPerUsd} PKR = 1 USD\`\n` +
      `• Minimum Deposit: \`${cfg.minPkr} PKR\`\n` +
      `• Maximum Deposit: \`${cfg.maxPkr} PKR\`\n` +
      `• Allow Custom Credit: ${cfg.allowCustomCredit ? '✅ ON' : '❌ OFF'}\n` +
      `• Auto Suggest Credit: ${cfg.autoSuggestCredit ? '✅ ON' : '❌ OFF'}\n\n` +
      `_Changes apply immediately to Easypaisa / JazzCash customer screens and admin deposit review without redeployment._`;

    const markup = {
      inline_keyboard: [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Exchange Rate', fallbackEmoji: '💱', style: 'primary', callbackData: 'adm:dep_set_e:rate', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Min Deposit PKR', fallbackEmoji: '🔽', style: 'primary', callbackData: 'adm:dep_set_e:min', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Max Deposit PKR', fallbackEmoji: '🔼', style: 'primary', callbackData: 'adm:dep_set_e:max', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({
            text: `Custom Credit: ${cfg.allowCustomCredit ? 'ON' : 'OFF'}`,
            fallbackEmoji: cfg.allowCustomCredit ? '✅' : '❌',
            style: cfg.allowCustomCredit ? 'success' : 'danger',
            callbackData: 'adm:dep_set_t:custom',
            forceVisible: true,
          }),
          ButtonBuilder.buildButton({
            text: `Auto Suggest: ${cfg.autoSuggestCredit ? 'ON' : 'OFF'}`,
            fallbackEmoji: cfg.autoSuggestCredit ? '💡' : '❌',
            style: cfg.autoSuggestCredit ? 'success' : 'danger',
            callbackData: 'adm:dep_set_t:suggest',
            forceVisible: true,
          }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Pending Deposits', fallbackEmoji: '💳', style: 'default', callbackData: 'adm:dep', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Settings', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:set', forceVisible: true }),
        ]),
      ],
    };

    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: markup });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: markup });
    }
  }

  private async renderAdminAnnouncementDraft(
    chatId: number,
    messageId: number | undefined,
    draft: any,
    notice?: string
  ): Promise<void> {
    const mType: AnnouncementMediaType = draft.mediaType || 'TEXT';
    const text =
      (notice ? `${notice}\n\n` : '') +
      `📢 *CREATE ANNOUNCEMENT*\n\n` +
      `• Title: *${this.escapeDiagMarkdown(draft.title || 'Not set')}*\n` +
      `• Media Type: \`${mType}\` ${draft.mediaFileId ? '✅ Attached' : mType === 'TEXT' ? '(Text-only)' : '⚠️ Missing photo'}\n` +
      `• Buttons: \`${Array.isArray(draft.buttons) ? draft.buttons.length : 0}\`\n` +
      `• Message Preview:\n${draft.messageText ? this.escapeDiagMarkdown(draft.messageText.slice(0, 200)) : '_Not set_'}\n`;

    const markup = {
      inline_keyboard: [
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Set Title', fallbackEmoji: '✏️', style: 'primary', callbackData: 'adm:ann_f:draft:title', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Set Message', fallbackEmoji: '📝', style: 'primary', callbackData: 'adm:ann_f:draft:msg', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'TEXT', style: mType === 'TEXT' ? 'success' : 'default', callbackData: 'adm:ann_mt:draft:text', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'PHOTO', style: mType === 'PHOTO' ? 'success' : 'default', callbackData: 'adm:ann_mt:draft:photo', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'BANNER', style: mType === 'BANNER' ? 'success' : 'default', callbackData: 'adm:ann_mt:draft:banner', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Upload/Set Photo', fallbackEmoji: '🖼️', style: 'default', callbackData: 'adm:ann_m:draft', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Inline Buttons', fallbackEmoji: '🔗', style: 'default', callbackData: 'adm:ann_f:draft:btns', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Preview to Me', fallbackEmoji: '👁️', style: 'primary', callbackData: 'adm:ann_prev:draft', forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Save Draft', fallbackEmoji: '💾', style: 'default', callbackData: 'adm:ann_save', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Send to All Users', fallbackEmoji: '🚀', style: 'success', callbackData: 'adm:ann_send:draft', forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Back to Announcements', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:ann', forceVisible: true }),
        ]),
      ],
    };

    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: markup });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: markup });
    }
  }

  private async renderAdminAnnouncementDetail(
    chatId: number,
    messageId: number | undefined,
    annId: string,
    notice?: string
  ): Promise<void> {
    const ann = await announcementService.getAnnouncementById(annId);
    if (!ann) {
      const msg = '⚠️ Announcement not found.';
      if (messageId) await telegramClient.editMessageText(chatId, messageId, msg);
      else await telegramClient.sendMessage(chatId, msg);
      return;
    }

    const text =
      (notice ? `${notice}\n\n` : '') +
      `📢 *ANNOUNCEMENT: ${this.escapeDiagMarkdown(ann.title)}*\n\n` +
      `• Status: \`${ann.status}\`\n` +
      `• Media Type: \`${ann.mediaType}\` ${ann.mediaFileId ? '✅ Attached' : ''}\n` +
      `• Buttons: \`${ann.buttons.length}\`\n` +
      `• Progress:\n` +
      `  👥 Total Users: \`${ann.totalUsers}\`\n` +
      `  ✅ Delivered: \`${ann.deliveredCount}\`\n` +
      `  🚫 Blocked: \`${ann.blockedCount}\`\n` +
      `  ❌ Failed: \`${ann.failedCount}\`\n\n` +
      `*Message:*\n${this.escapeDiagMarkdown(ann.messageText.slice(0, 300))}`;

    const rows: any[][] = [];
    if (ann.status === 'DRAFT' || ann.status === 'COMPLETED' || ann.status === 'CANCELLED') {
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Edit Title', style: 'primary', callbackData: `adm:ann_f:${ann.id}:title`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Edit Message', style: 'primary', callbackData: `adm:ann_f:${ann.id}:msg`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'TEXT', style: ann.mediaType === 'TEXT' ? 'success' : 'default', callbackData: `adm:ann_mt:${ann.id}:text`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'PHOTO', style: ann.mediaType === 'PHOTO' ? 'success' : 'default', callbackData: `adm:ann_mt:${ann.id}:photo`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'BANNER', style: ann.mediaType === 'BANNER' ? 'success' : 'default', callbackData: `adm:ann_mt:${ann.id}:banner`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Photo / Banner', fallbackEmoji: '🖼️', style: 'default', callbackData: `adm:ann_m:${ann.id}`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Edit Buttons', fallbackEmoji: '🔗', style: 'default', callbackData: `adm:ann_f:${ann.id}:btns`, forceVisible: true }),
        ]),
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Send Preview', fallbackEmoji: '👁️', style: 'primary', callbackData: `adm:ann_prev:${ann.id}`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Send to All Users', fallbackEmoji: '🚀', style: 'success', callbackData: `adm:ann_send:${ann.id}`, forceVisible: true }),
        ])
      );
    }

    if (ann.status === 'SENDING') {
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Refresh Progress', fallbackEmoji: '🔄', style: 'primary', callbackData: `adm:ann_v:${ann.id}`, forceVisible: true }),
          ButtonBuilder.buildButton({ text: 'Cancel Broadcast', fallbackEmoji: '🛑', style: 'danger', callbackData: `adm:ann_cancel:${ann.id}`, forceVisible: true }),
        ])
      );
    } else if (ann.status === 'DRAFT') {
      rows.push(
        ButtonBuilder.buildActionRow([
          ButtonBuilder.buildButton({ text: 'Cancel Draft', fallbackEmoji: '🛑', style: 'danger', callbackData: `adm:ann_cancel:${ann.id}`, forceVisible: true }),
        ])
      );
    }

    rows.push(
      ButtonBuilder.buildActionRow([
        ButtonBuilder.buildButton({ text: 'Announcements', fallbackEmoji: '⬅️', style: 'default', callbackData: 'adm:ann', forceVisible: true }),
        ButtonBuilder.buildButton({ text: 'ADMIN', fallbackEmoji: '👑', style: 'default', callbackData: 'adm:main', forceVisible: true }),
      ])
    );

    const markup = { inline_keyboard: rows };
    if (messageId) {
      await telegramClient.editMessageText(chatId, messageId, text, { reply_markup: markup });
    } else {
      await telegramClient.sendMessage(chatId, text, { reply_markup: markup });
    }
  }
}

export const adminHandler = new AdminHandler();
