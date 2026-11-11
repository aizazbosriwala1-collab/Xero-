-- ==============================================================================
-- 001_initial_schema.sql: XERO KHAN Authoritative PostgreSQL Schema
-- ==============================================================================

-- 1. Schema Migrations tracker
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    applied_at TIMESTAMP DEFAULT now()
);

-- 2. Users
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    language_code VARCHAR(16) DEFAULT 'en',
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 3. User Profiles
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id VARCHAR(64) PRIMARY KEY,
    preferred_language VARCHAR(16) DEFAULT 'en',
    notification_settings JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 4. Wallets
CREATE TABLE IF NOT EXISTS wallets (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) UNIQUE NOT NULL,
    currency VARCHAR(16) DEFAULT 'USDT',
    balance NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
    locked_balance NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 5. Append-only Immutable Ledger
CREATE TABLE IF NOT EXISTS ledger_entries (
    id VARCHAR(64) PRIMARY KEY,
    wallet_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    operation_ref VARCHAR(128) UNIQUE NOT NULL,
    idempotency_key VARCHAR(128),
    amount NUMERIC(18, 4) NOT NULL,
    balance_after NUMERIC(18, 4) NOT NULL,
    entry_type VARCHAR(32) NOT NULL,
    reason VARCHAR(255) NOT NULL,
    source VARCHAR(64) NOT NULL,
    actor VARCHAR(64) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT now()
);

-- 6. Payment Methods Configuration
CREATE TABLE IF NOT EXISTS payment_methods (
    id VARCHAR(64) PRIMARY KEY,
    code VARCHAR(32) UNIQUE NOT NULL,
    name VARCHAR(128) NOT NULL,
    account_title VARCHAR(255) NOT NULL,
    account_number VARCHAR(255) NOT NULL,
    instructions TEXT NOT NULL,
    min_amount NUMERIC(18, 4) NOT NULL DEFAULT 0.10,
    max_amount NUMERIC(18, 4) NOT NULL DEFAULT 10000.00,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    proof_required BOOLEAN NOT NULL DEFAULT TRUE,
    review_message TEXT,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 7. Deposits
CREATE TABLE IF NOT EXISTS deposits (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    payment_method_code VARCHAR(32) NOT NULL,
    amount NUMERIC(18, 4) NOT NULL,
    currency VARCHAR(16) NOT NULL DEFAULT 'USDT',
    status VARCHAR(32) NOT NULL,
    txid VARCHAR(255),
    proof_file_id VARCHAR(255),
    binance_transaction_id VARCHAR(128) UNIQUE,
    binance_order_type VARCHAR(64),
    receiver_ref VARCHAR(128),
    expires_at TIMESTAMP,
    verified_at TIMESTAMP,
    attempt_count INT DEFAULT 0,
    failure_reason VARCHAR(255),
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 8. Deposit Attempts
CREATE TABLE IF NOT EXISTS deposit_attempts (
    id VARCHAR(64) PRIMARY KEY,
    deposit_id VARCHAR(64) NOT NULL,
    attempt_number INT NOT NULL,
    payload JSONB DEFAULT '{}',
    response JSONB DEFAULT '{}',
    error_classification VARCHAR(64),
    created_at TIMESTAMP DEFAULT now()
);

-- 9. Payment Transactions (Audit)
CREATE TABLE IF NOT EXISTS payment_transactions (
    id VARCHAR(64) PRIMARY KEY,
    deposit_id VARCHAR(64) NOT NULL,
    provider VARCHAR(64) NOT NULL,
    external_ref VARCHAR(255),
    amount NUMERIC(18, 4) NOT NULL,
    currency VARCHAR(16) NOT NULL,
    raw_data JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT now()
);

-- 10. Product Categories
CREATE TABLE IF NOT EXISTS product_categories (
    id VARCHAR(64) PRIMARY KEY,
    slug VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(128) NOT NULL,
    display_order INT DEFAULT 0,
    is_visible BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 11. Supplier Products Mirror
CREATE TABLE IF NOT EXISTS supplier_products (
    id VARCHAR(64) PRIMARY KEY,
    supplier VARCHAR(32) DEFAULT 'aitoolshop',
    supplier_product_id VARCHAR(64) UNIQUE NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    original_description TEXT,
    latest_cost NUMERIC(18, 4) NOT NULL,
    latest_stock INT DEFAULT 0,
    is_unlimited BOOLEAN DEFAULT FALSE,
    requires_email BOOLEAN DEFAULT FALSE,
    supplier_type VARCHAR(64) DEFAULT 'account',
    is_available BOOLEAN DEFAULT TRUE,
    duration VARCHAR(64),
    warranty_summary TEXT,
    raw_payload JSONB DEFAULT '{}',
    last_synced_at TIMESTAMP DEFAULT now(),
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 12. Local Product Overrides & Admin Pricing
CREATE TABLE IF NOT EXISTS product_overrides (
    product_id VARCHAR(64) PRIMARY KEY,
    display_name_override VARCHAR(255),
    description_override TEXT,
    category_id VARCHAR(64),
    fixed_retail_price NUMERIC(18, 4),
    fixed_markup NUMERIC(18, 4),
    percent_markup NUMERIC(8, 4),
    is_hidden BOOLEAN DEFAULT FALSE,
    is_featured BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 13. Local Customer Orders
CREATE TABLE IF NOT EXISTS local_orders (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(128) UNIQUE NOT NULL,
    product_id VARCHAR(64) NOT NULL,
    quantity INT NOT NULL,
    unit_price NUMERIC(18, 4) NOT NULL,
    total_price NUMERIC(18, 4) NOT NULL,
    supplier_cost NUMERIC(18, 4) NOT NULL,
    customer_email VARCHAR(255),
    status VARCHAR(32) NOT NULL,
    delivery_type VARCHAR(64),
    error_message TEXT,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 14. Supplier Orders Integration
CREATE TABLE IF NOT EXISTS supplier_orders (
    id VARCHAR(64) PRIMARY KEY,
    local_order_id VARCHAR(64) UNIQUE NOT NULL,
    supplier_order_ref VARCHAR(128),
    idempotency_key VARCHAR(128) UNIQUE NOT NULL,
    supplier_status VARCHAR(64) NOT NULL,
    response_payload JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 15. Delivered Items
CREATE TABLE IF NOT EXISTS delivered_items (
    id VARCHAR(64) PRIMARY KEY,
    local_order_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    content TEXT NOT NULL,
    item_type VARCHAR(32) DEFAULT 'text',
    delivered_at TIMESTAMP DEFAULT now()
);

-- 16. Referrals
CREATE TABLE IF NOT EXISTS referrals (
    id VARCHAR(64) PRIMARY KEY,
    referrer_id VARCHAR(64) NOT NULL,
    referred_id VARCHAR(64) UNIQUE NOT NULL,
    status VARCHAR(32) NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 17. Referral Qualifications
CREATE TABLE IF NOT EXISTS referral_qualifications (
    id VARCHAR(64) PRIMARY KEY,
    referral_id VARCHAR(64) UNIQUE NOT NULL,
    qualifying_order_id VARCHAR(64) UNIQUE NOT NULL,
    qualified_at TIMESTAMP DEFAULT now()
);

-- 18. Dynamic Giveaways
CREATE TABLE IF NOT EXISTS giveaways (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    reward_product_id VARCHAR(64),
    reward_quantity INT DEFAULT 1,
    required_qualified_referrals INT NOT NULL DEFAULT 5,
    start_at TIMESTAMP,
    end_at TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    claim_limit INT DEFAULT 100,
    claims_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 19. Giveaway Claims
CREATE TABLE IF NOT EXISTS giveaway_claims (
    id VARCHAR(64) PRIMARY KEY,
    giveaway_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    local_order_id VARCHAR(64),
    status VARCHAR(32) NOT NULL,
    claimed_at TIMESTAMP DEFAULT now(),
    CONSTRAINT uq_giveaway_user UNIQUE(giveaway_id, user_id)
);

-- 20. Support Tickets
CREATE TABLE IF NOT EXISTS support_tickets (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    order_id VARCHAR(64),
    issue_type VARCHAR(64) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- 21. Support Messages
CREATE TABLE IF NOT EXISTS support_messages (
    id VARCHAR(64) PRIMARY KEY,
    ticket_id VARCHAR(64) NOT NULL,
    sender_type VARCHAR(32) NOT NULL,
    sender_id VARCHAR(64) NOT NULL,
    message TEXT NOT NULL,
    attachment_file_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT now()
);

-- 22. Telegram Processed Updates
CREATE TABLE IF NOT EXISTS telegram_processed_updates (
    update_id BIGINT PRIMARY KEY,
    processed_at TIMESTAMP DEFAULT now()
);

-- 23. Admin Audit Logs
CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    admin_id VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,
    target_entity VARCHAR(64) NOT NULL,
    target_id VARCHAR(64),
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT now()
);

-- 24. System Settings
CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(64) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP DEFAULT now()
);
