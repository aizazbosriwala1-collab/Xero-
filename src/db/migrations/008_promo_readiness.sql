-- ==============================================================================
-- 008_promo_readiness.sql:
-- Track Telegram channel can_post_messages permission on promo_channels
-- ==============================================================================

ALTER TABLE promo_channels
ADD COLUMN IF NOT EXISTS can_post_messages BOOLEAN NOT NULL DEFAULT FALSE;
