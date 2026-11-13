-- ==============================================================================
-- 002_ui_customization.sql: XERO KHAN V2 UI Customization & Navigation State
-- Additive, reversible, pg-mem & PostgreSQL compatible.
-- ==============================================================================

-- 1. Persistent DB-Backed Admin-Editable UI Configuration
CREATE TABLE IF NOT EXISTS ui_settings (
    id VARCHAR(128) PRIMARY KEY,
    setting_key VARCHAR(128) NOT NULL,
    section VARCHAR(64) NOT NULL,
    language_code VARCHAR(16) NOT NULL DEFAULT 'en',
    text_value TEXT NOT NULL,
    fallback_emoji VARCHAR(32) DEFAULT '',
    custom_emoji_id VARCHAR(64),
    button_style VARCHAR(16) NOT NULL DEFAULT 'default',
    is_visible BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    updated_by VARCHAR(64),
    CONSTRAINT uq_ui_setting_key_lang UNIQUE (setting_key, language_code)
);

-- 2. Persistent Navigation Context & Active Menu State
CREATE TABLE IF NOT EXISTS ui_navigation_states (
    user_id VARCHAR(64) PRIMARY KEY,
    active_message_id BIGINT,
    screen VARCHAR(64) NOT NULL DEFAULT 'home',
    category_id VARCHAR(64),
    product_id VARCHAR(64),
    page INT DEFAULT 1,
    search_query VARCHAR(255),
    quantity INT DEFAULT 1,
    filters_json JSONB DEFAULT '{}',
    state_token VARCHAR(32) NOT NULL,
    expires_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT now()
);
