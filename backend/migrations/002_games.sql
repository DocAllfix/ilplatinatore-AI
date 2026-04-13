-- Migration 002: Tabella games
CREATE TABLE IF NOT EXISTS games (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    platform VARCHAR(50)[] DEFAULT '{}',
    release_date DATE,
    genre VARCHAR(100)[] DEFAULT '{}',
    cover_url TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_games_slug ON games(slug);
CREATE INDEX IF NOT EXISTS idx_games_title_trgm ON games USING gin(title gin_trgm_ops);
