-- Migration 006: Tabella users
-- CORREZIONE AUDIT: rimosso queries_today (gestito da Redis)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255),
    display_name VARCHAR(100),
    tier VARCHAR(20) DEFAULT 'free' CHECK (tier IN ('free','pro','platinum')),
    language VARCHAR(10) DEFAULT 'it',
    total_queries INT DEFAULT 0,
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_active TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_tier ON users(tier);
