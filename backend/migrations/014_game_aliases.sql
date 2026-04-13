-- Migration: Tabella game_aliases — varianti nomi giochi per query normalizer
-- "GTA V", "GTA 5", "Grand Theft Auto Five" -> stesso game_id

CREATE TABLE IF NOT EXISTS game_aliases (
    id SERIAL PRIMARY KEY,
    game_id INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    alias VARCHAR(255) NOT NULL,
    alias_type VARCHAR(20) DEFAULT 'alternate'
        CHECK (alias_type IN ('alternate', 'abbreviation', 'translation')),
    language VARCHAR(10),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alias_game ON game_aliases(game_id);
CREATE INDEX IF NOT EXISTS idx_alias_trgm ON game_aliases USING gin(alias gin_trgm_ops);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_unique ON game_aliases(game_id, lower(alias));
