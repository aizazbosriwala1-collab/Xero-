-- ==============================================================================
-- 009_supplier_ecosystem.sql:
-- Supplier Mirror, Pluggable Driver Metadata, Canonical Master Products,
-- Multi-Supplier Product Slot Mapping & Supplier Health Monitoring
-- ==============================================================================

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS driver_key VARCHAR(64) DEFAULT 'aitoolshop';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS api_status VARCHAR(32) DEFAULT 'Healthy';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS low_balance_threshold NUMERIC(18, 4) DEFAULT 20.0000;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS last_health_check_at TIMESTAMP;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS last_latency_ms INT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE supplier_orders ADD COLUMN IF NOT EXISTS fulfilled_supplier_id VARCHAR(64);

CREATE TABLE IF NOT EXISTS master_products (
    id VARCHAR(64) PRIMARY KEY,
    canonical_name VARCHAR(255) NOT NULL,
    description TEXT,
    category_id VARCHAR(64),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS supplier_catalog_mirror (
    id VARCHAR(64) PRIMARY KEY,
    supplier_id VARCHAR(64) NOT NULL,
    supplier_product_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    cost_usdt NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
    stock INT NOT NULL DEFAULT 0,
    is_unlimited BOOLEAN NOT NULL DEFAULT FALSE,
    requires_email BOOLEAN NOT NULL DEFAULT FALSE,
    supplier_type VARCHAR(64) DEFAULT 'account',
    duration VARCHAR(64),
    warranty_summary TEXT,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    raw_payload JSONB DEFAULT '{}',
    last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (supplier_id, supplier_product_id)
);

CREATE TABLE IF NOT EXISTS product_supplier_mappings (
    id VARCHAR(64) PRIMARY KEY,
    master_product_id VARCHAR(64) NOT NULL,
    slot_rank INT NOT NULL,
    supplier_id VARCHAR(64) NOT NULL,
    supplier_product_id VARCHAR(64) NOT NULL,
    mirror_item_id VARCHAR(64),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (master_product_id, slot_rank)
);

CREATE TABLE IF NOT EXISTS supplier_health_logs (
    id VARCHAR(64) PRIMARY KEY,
    supplier_id VARCHAR(64) NOT NULL,
    operation VARCHAR(32) NOT NULL,
    success BOOLEAN NOT NULL,
    latency_ms INT NOT NULL DEFAULT 0,
    error_code VARCHAR(64),
    error_message TEXT,
    local_order_id VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sup_mirror_sup ON supplier_catalog_mirror (supplier_id, is_available);
CREATE INDEX IF NOT EXISTS idx_prod_sup_map_master ON product_supplier_mappings (master_product_id, slot_rank ASC);
CREATE INDEX IF NOT EXISTS idx_prod_sup_map_sup ON product_supplier_mappings (supplier_id, is_active);
CREATE INDEX IF NOT EXISTS idx_sup_health_logs_sup ON supplier_health_logs (supplier_id, created_at DESC);
