-- XERO KHAN V1: Referrals, Custom/Wallet Giveaways, Non-Blocking Announcements & Query Performance Indexes

ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS reward_type VARCHAR(32) DEFAULT 'STORE_PRODUCT';
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS reward_amount_usdt NUMERIC(18, 4) DEFAULT 0.0000;

CREATE TABLE IF NOT EXISTS announcements (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  message_text TEXT NOT NULL,
  media_type VARCHAR(32) DEFAULT 'TEXT',
  media_file_id TEXT,
  buttons_json JSONB DEFAULT '[]',
  status VARCHAR(32) DEFAULT 'DRAFT',
  total_users INT DEFAULT 0,
  delivered_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  blocked_count INT DEFAULT 0,
  created_by VARCHAR(64) NOT NULL,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Targeted performance indexes for hot customer & admin queries
CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON ledger_entries (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_products_avail ON supplier_products (is_available, is_unlimited, latest_stock);
CREATE INDEX IF NOT EXISTS idx_local_orders_status_created ON local_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_created ON referrals (referrer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_giveaways_reward_type ON giveaways (reward_type, is_active);
CREATE INDEX IF NOT EXISTS idx_announcements_status_created ON announcements (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_required_channels_order ON required_channels (is_active, display_order);
