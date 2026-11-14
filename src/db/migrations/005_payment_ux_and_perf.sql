-- ==============================================================================
-- 005_payment_ux_and_perf.sql: Simplified Easypaisa/JazzCash UX columns
-- + performance indexes
-- Additive, idempotent, pg-mem & PostgreSQL compatible.
-- ==============================================================================

-- 1. Simplified manual deposit metadata (sender phone, optional PKR/OCR, admin approved USD)
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS sender_phone VARCHAR(64);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS submitted_pkr_amount NUMERIC(18, 2);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS suggested_usd_amount NUMERIC(18, 4);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS approved_usd_amount NUMERIC(18, 4);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS approved_by VARCHAR(64);

-- 2. Additional query performance indexes for deposit review & catalogue browsing
CREATE INDEX IF NOT EXISTS idx_deposits_status_created ON deposits (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_product_overrides_cat_featured ON product_overrides (category_id, is_featured, is_hidden);
