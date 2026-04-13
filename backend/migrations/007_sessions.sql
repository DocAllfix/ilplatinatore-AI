-- Migration 007: Tabella sessions (per utenti non registrati, GDPR-compliant)
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip_address INET,
    user_agent TEXT,
    queries_used INT DEFAULT 0,
    max_queries INT DEFAULT 3,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
