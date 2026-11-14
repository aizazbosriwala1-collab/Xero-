-- ==============================================================================
-- 004_public_release_polish.sql: Giveaways, Referral Tiers, Required Channels,
-- Supplier Control Center & Launch Settings
-- Additive, idempotent, pg-mem & PostgreSQL compatible.
-- ==============================================================================

-- 1. Giveaways enhancements (required total referrals, public visibility, reward label)
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS required_total_referrals INT DEFAULT 0;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT TRUE;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS reward_label VARCHAR(255);

-- 2. Configurable Referral Reward Tiers & Claims
CREATE TABLE IF NOT EXISTS referral_reward_tiers (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    required_qualified_referrals INT NOT NULL,
    reward_type VARCHAR(32) NOT NULL DEFAULT 'WALLET_USDT',
    reward_product_id VARCHAR(64),
    reward_amount NUMERIC(18, 4) DEFAULT 0.0000,
    reward_quantity INT DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_reward_claims (
    id VARCHAR(64) PRIMARY KEY,
    tier_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'CLAIMED',
    reward_details JSONB DEFAULT '{}',
    claimed_at TIMESTAMP DEFAULT now(),
    CONSTRAINT uq_referral_tier_user UNIQUE (tier_id, user_id)
);

-- 3. Required Channels Management
CREATE TABLE IF NOT EXISTS required_channels (
    id VARCHAR(64) PRIMARY KEY,
    channel_identifier VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    invite_url VARCHAR(512) NOT NULL,
    display_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 4. Supplier Control Center
CREATE TABLE IF NOT EXISTS suppliers (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    base_url VARCHAR(512) NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    routing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ordering_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_balance_usdt NUMERIC(18, 4),
    last_balance_at TIMESTAMP,
    last_sync_at TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 5. Performance Indexes (safe idempotent creation)
CREATE INDEX IF NOT EXISTS idx_local_orders_user_created ON local_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivered_items_order ON delivered_items (local_order_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_status ON referrals (referrer_id, status);
CREATE INDEX IF NOT EXISTS idx_giveaways_active_public ON giveaways (is_active, is_public, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_required_channels_order ON required_channels (is_active, display_order ASC);
