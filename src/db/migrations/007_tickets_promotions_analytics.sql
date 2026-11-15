-- ==============================================================================
-- 007_tickets_promotions_analytics.sql:
-- Proper Support Tickets (#ticket_number, Reply/Close), Channel Auto Promotions,
-- Multi-Supplier Failover Priority & Referral Analytics Indexes
-- ==============================================================================

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ticket_number INT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS closed_by VARCHAR(64);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS priority INT DEFAULT 100;

CREATE TABLE IF NOT EXISTS promo_channels (
    id VARCHAR(64) PRIMARY KEY,
    channel_identifier VARCHAR(255) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    bot_is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_posted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS promotion_posts (
    id VARCHAR(64) PRIMARY KEY,
    channel_id VARCHAR(64) NOT NULL,
    product_id VARCHAR(64) NOT NULL,
    telegram_message_id BIGINT,
    status VARCHAR(32) NOT NULL DEFAULT 'POSTED',
    error_message TEXT,
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status_upd ON support_tickets (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_number ON support_tickets (ticket_number);
CREATE INDEX IF NOT EXISTS idx_support_messages_tkt ON support_messages (ticket_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_promo_channels_active ON promo_channels (is_active, bot_is_admin);
CREATE INDEX IF NOT EXISTS idx_promotion_posts_created ON promotion_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_local_orders_user_status ON local_orders (user_id, status);
CREATE INDEX IF NOT EXISTS idx_suppliers_priority ON suppliers (is_enabled, routing_enabled, priority ASC);
