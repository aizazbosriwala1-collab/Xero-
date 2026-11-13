-- ==============================================================================
-- 003_binance_order_id.sql: Binance Order ID Storage & Unique Replay Protection
-- Additive, idempotent, pg-mem & PostgreSQL compatible.
-- ==============================================================================

ALTER TABLE deposits ADD COLUMN IF NOT EXISTS binance_order_id VARCHAR(128);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS binance_match_type VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_binance_order_id ON deposits (binance_order_id);
