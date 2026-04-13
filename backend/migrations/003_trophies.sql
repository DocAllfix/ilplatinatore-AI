-- Migration 003: Tabella trophies
CREATE TABLE IF NOT EXISTS trophies (
    id SERIAL PRIMARY KEY,
    game_id INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type VARCHAR(20) CHECK (type IN ('bronze','silver','gold','platinum')),
    hidden BOOLEAN DEFAULT false,
    rarity_pct DECIMAL(5,2),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trophies_game ON trophies(game_id);
CREATE INDEX IF NOT EXISTS idx_trophies_name_trgm ON trophies USING gin(name gin_trgm_ops);
