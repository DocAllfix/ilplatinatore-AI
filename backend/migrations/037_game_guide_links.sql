-- Migration 037: tabella game_guide_links — URL verificati per gioco.
-- Salva 2-3 URL per gioco per tipo di contenuto (trophy, walkthrough, general, build, lore).
-- Non sostituisce harvest_sources (legata a guide_id per audit legale).
-- Questa è una rubrica stabile per-gioco che il retrieval usa prima di chiamare Tavily.

CREATE TABLE IF NOT EXISTS game_guide_links (
    id           SERIAL PRIMARY KEY,
    game_id      INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    url          TEXT NOT NULL,
    domain       VARCHAR(255) NOT NULL,
    guide_type   VARCHAR(50) NOT NULL DEFAULT 'general',
    -- 'general' | 'trophy' | 'walkthrough' | 'collectible' | 'build' | 'lore'
    language     VARCHAR(10) NOT NULL DEFAULT 'en',
    reliability  NUMERIC(3,2) NOT NULL DEFAULT 0.80,
    verified_at  TIMESTAMPTZ,
    auto_found   BOOLEAN NOT NULL DEFAULT TRUE,
    -- TRUE = trovato da script automatico, FALSE = inserito manualmente
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_game_guide_link UNIQUE (game_id, url)
);

CREATE INDEX IF NOT EXISTS idx_game_guide_links_game
    ON game_guide_links(game_id);

CREATE INDEX IF NOT EXISTS idx_game_guide_links_type
    ON game_guide_links(game_id, guide_type);
