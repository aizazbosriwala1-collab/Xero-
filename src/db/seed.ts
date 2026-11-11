import { db } from './index.js';
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

  // 2. Seed Default Product Categories
  const existingCategories = await db.query('SELECT slug FROM product_categories');
  const existingCategorySlugs = new Set(existingCategories.rows.map(r => r.slug));

  const defaultCategories = [
    { slug: 'ai-tools', name: '🤖 AI & Assistants', order: 1 },
    { slug: 'streaming', name: '🎬 Streaming & Media', order: 2 },
    { slug: 'developer', name: '💻 Dev & Cloud Tools', order: 3 },
    { slug: 'design', name: '🎨 Design & Productivity', order: 4 },
    { slug: 'vpn-security', name: '🛡️ VPN & Security', order: 5 },
  ];

  for (const cat of defaultCategories) {
    if (!existingCategorySlugs.has(cat.slug)) {
      await db.query(`
        INSERT INTO product_categories (id, slug, name, display_order, is_visible)
        VALUES ($1, $2, $3, $4, true)
      `, [`cat_${cat.slug}`, cat.slug, cat.name, cat.order]);
    }
  }

  // 3. Seed Default System Settings
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
      }
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
