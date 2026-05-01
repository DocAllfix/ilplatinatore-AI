-- Migration 032: Knowledge Graph Topic Mapper (Fase 24)
--
-- Auto-discovery di topic granulari per ogni gioco (boss, build, collectible, lore,
-- puzzle). Riempita dall'harvester Python `src.topics.topic_mapper` che scrape
-- Fextralife/Fandom/Reddit/PowerPyx e estrae nomi di entità.
--
-- I topic con `guide_generated=false` rappresentano la coda di guide da generare
-- via pipeline esistente (HarvestPipeline.process_single_guide con guide_type
-- override). La generazione è OPT-IN — viene attivata da `topic_mapper --generate-guides`.

CREATE TABLE IF NOT EXISTS game_topics (
    id SERIAL PRIMARY KEY,
    game_id INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    -- topic_type: una delle categorie supportate. Vincolata da CHECK per evitare drift.
    topic_type VARCHAR(32) NOT NULL,
    -- topic_name: nome leggibile (es. "Malenia, Blade of Miquella").
    topic_name VARCHAR(255) NOT NULL,
    -- topic_slug: nome normalizzato per URL/dedup (es. "malenia-blade-of-miquella").
    topic_slug VARCHAR(255) NOT NULL,
    -- discovered_from: array di sorgenti che hanno trovato questo topic.
    -- Più sorgenti = topic più "canonico" (boost priority via priority_scorer).
    discovered_from TEXT[] NOT NULL DEFAULT '{}',
    -- priority: 1=high (genera prima), 10=low. Default 5, modificato da scorer.
    priority SMALLINT NOT NULL DEFAULT 5,
    -- guide_generated: true quando la pipeline ha già prodotto una guide_id per questo topic.
    guide_generated BOOLEAN NOT NULL DEFAULT false,
    -- generated_guide_id: quale guide è stata creata (per audit + cleanup).
    generated_guide_id INT REFERENCES guides(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Whitelist topic_type (drift protection).
    CONSTRAINT chk_topic_type CHECK (topic_type IN ('boss', 'build', 'collectible', 'lore', 'puzzle')),
    -- Priority clamp [1, 10]
    CONSTRAINT chk_priority CHECK (priority BETWEEN 1 AND 10),
    -- Idempotency: stesso (game, type, slug) = stesso topic.
    UNIQUE (game_id, topic_type, topic_slug)
);

-- Index per coda generazione: filtra "pending" + ordina priority crescente.
CREATE INDEX IF NOT EXISTS idx_game_topics_pending
    ON game_topics(game_id, topic_type, priority)
    WHERE guide_generated = false;

-- Index per cleanup/audit cross-game su tipologia.
CREATE INDEX IF NOT EXISTS idx_game_topics_type
    ON game_topics(topic_type)
    WHERE guide_generated = false;

-- Trigger: aggiorna updated_at su ogni UPDATE.
CREATE OR REPLACE FUNCTION game_topics_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_game_topics_updated_at ON game_topics;
CREATE TRIGGER trg_game_topics_updated_at
    BEFORE UPDATE ON game_topics
    FOR EACH ROW
    EXECUTE FUNCTION game_topics_set_updated_at();
