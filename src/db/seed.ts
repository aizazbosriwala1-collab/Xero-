import { db } from './index.js';
import { config } from '../config/env.js';
import { createLogger } from '../services/logger.js';

const logger = createLogger('Seed');

export async function seedInitialData(): Promise<void> {
  // 1. Seed Payment Methods (Easypaisa, JazzCash, Binance)
  const existingMethods = await db.query('SELECT code FROM payment_methods');
  const existingCodes = new Set(existingMethods.rows.map(r => r.code));

  if (!existingCodes.has('EASYPAISA')) {
    await db.query(`
      INSERT INTO payment_methods (
        id, code, name, account_title, account_number, instructions,
        min_amount, max_amount, is_enabled, proof_required, review_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      'pm_easypaisa',
      'EASYPAISA',
      'Easypaisa Mobile Account',
      'Muhammad Abbas',
      '03705851403',
      'Send the exact PKR equivalent or USDT rate to the Easypaisa mobile account. Once sent, provide the 11-digit TRX ID and upload a screenshot proof of the completed receipt.',
      '1.0000',
      '1000.0000',
      true,
      true,
      'Your Easypaisa payment has been submitted for manual admin verification. Approval usually takes 5-30 minutes.'
    ]);
    logger.info('Seeded Easypaisa payment method');
  }

  if (!existingCodes.has('JAZZCASH')) {
    await db.query(`
      INSERT INTO payment_methods (
        id, code, name, account_title, account_number, instructions,
        min_amount, max_amount, is_enabled, proof_required, review_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      'pm_jazzcash',
      'JAZZCASH',
      'JazzCash Mobile Account',
      'Muhammad Abbas',
      '03705851403',
      'Send the amount to the JazzCash mobile account. Once sent, provide the TID (Transaction ID) and upload a screenshot proof of the receipt.',
      '1.0000',
      '1000.0000',
      true,
      true,
      'Your JazzCash payment has been submitted for manual admin verification. Approval usually takes 5-30 minutes.'
    ]);
    logger.info('Seeded JazzCash payment method');
  }

  if (!existingCodes.has('BINANCE_USDT')) {
    await db.query(`
      INSERT INTO payment_methods (
        id, code, name, account_title, account_number, instructions,
        min_amount, max_amount, is_enabled, proof_required, review_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      'pm_binance',
      'BINANCE_USDT',
      'Binance Pay USDT (Instant Verification)',
      'Binance Pay Receiver',
      'BINANCE_PAY',
      'Transfer the exact USDT amount via Binance Pay to the configured Binance Pay ID. Verification is automatic and your wallet is credited instantaneously once payment is detected.',
      '0.1000',
      '10000.0000',
      true,
      false,
      'Binance transaction verified and credited automatically.'
    ]);
    logger.info('Seeded Binance Pay method');
  }

  // 2. Seed & Align Clean 6-Category Storefront (non-destructive: keeps overrides/FKs intact)
  const defaultCategories = [
    { slug: 'ai-tools', name: '🤖 AI Tools', order: 1 },
    { slug: 'design', name: '🎨 Design Tools', order: 2 },
    { slug: 'courses', name: '📚 Courses', order: 3 },
    { slug: 'streaming', name: '🎬 Streaming', order: 4 },
    { slug: 'vpn-security', name: '🌐 VPN', order: 5 },
    { slug: 'gaming', name: '🎮 Gaming', order: 6 },
  ];

  for (const cat of defaultCategories) {
    await db.query(
      `INSERT INTO product_categories (id, slug, name, display_order, is_visible)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         display_order = EXCLUDED.display_order,
         is_visible = true,
         updated_at = CURRENT_TIMESTAMP`,
      [`cat_${cat.slug}`, cat.slug, cat.name, cat.order]
    );
  }

  // Keep legacy developer category hidden from the minimal 6-category grid without breaking product mappings
  await db.query(
    `UPDATE product_categories
     SET is_visible = FALSE, display_order = 99, updated_at = CURRENT_TIMESTAMP
     WHERE slug = 'developer' AND is_visible = TRUE`
  );

  // 3. Seed Primary Supplier Control Record (never deletable from UI)
  await db.query(`
    INSERT INTO suppliers (
      id, name, base_url, is_enabled, routing_enabled, ordering_enabled, sync_enabled,
      created_at, updated_at
    ) VALUES ($1, $2, $3, TRUE, TRUE, TRUE, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO NOTHING
  `, ['aitoolshop', 'AiToolShop Reseller', config.supplier.baseUrl]);

  // 4. Seed Default System Settings
  const defaultSettings = [
    {
      key: 'pricing_global_rules',
      value: {
        defaultPercentMarkup: '0.15', // 15% default markup
        defaultFixedMarkup: '0.05',    // 0.05 USDT minimal fixed markup
        minMarkupFloor: '0.02',        // Never sell below cost + 0.02 USDT
      }
    },
    {
      key: 'referral_rules',
      value: {
        rewardPercentage: '0.05',      // 5% reward on first qualifying order
        minQualifyingOrderUsdt: '1.00',
        rewardsEnabled: true,
      }
    },
    {
      key: 'required_channels_config',
      value: {
        verificationEnabled: false,
        cacheTtlSeconds: 180,
      }
    },
    {
      key: 'giveaway_config',
      value: {
        enabled: true,
        defaultClaimLimit: 100,
        notifyAdminOnClaim: true,
      }
    },
    {
      key: 'maintenance_config',
      value: {
        enabled: false,
        message: '⚠️ *MAINTENANCE IN PROGRESS*\n\nXERO KHAN is undergoing a brief scheduled upgrade. Please check back in a few minutes.',
      }
    },
    {
      key: 'banner_images',
      value: {
        welcomeBannerUrl: '',
        shopBannerUrl: '',
        supportBannerUrl: '',
      }
    },
    {
      key: 'deposit_settings',
      value: {
        pkrPerUsd: '290',
        minPkr: '30',
        maxPkr: '6000',
        allowCustomCredit: true,
        autoSuggestCredit: true,
      },
    },
    {
      key: 'auto_promotion_config',
      value: {
        enabled: false,
        intervalMinutes: 180,
        lastPostedAt: null,
        lastProductId: null,
      },
    },
    {
      key: 'brand_info',
      value: {
        brandName: 'XERO KHAN',
        tagline: 'Digital Tools. Instant Access.',
        supportHandle: '@XeroKhanSupport',
        channelUrl: 'https://t.me/XeroKhanUpdates'
      }
    }
  ];

  for (const s of defaultSettings) {
    await db.query(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO NOTHING
    `, [s.key, JSON.stringify(s.value)]);
  }

  logger.info('Initial seed configuration complete');
}
