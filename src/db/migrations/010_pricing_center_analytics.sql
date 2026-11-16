-- ==============================================================================
-- 010_pricing_center_analytics.sql:
-- Per-Supplier Pricing Overrides (Fixed USDT or Percentage Markup) & Analytics Indexes
-- ==============================================================================

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(16);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pricing_markup_value NUMERIC(18, 4);
