-- Migration 004: Tabella guides (CORE) — con correzioni audit
CREATE TABLE IF NOT EXISTS guides (
    id SERIAL PRIMARY KEY,
    game_id INT REFERENCES games(id),
    trophy_id INT REFERENCES trophies(id),
    title VARCHAR(500) NOT NULL,
    slug VARCHAR(500) UNIQUE NOT NULL,
    content TEXT NOT NULL,
    content_html TEXT,
    language VARCHAR(10) DEFAULT 'it',
    guide_type VARCHAR(30) CHECK (guide_type IN ('trophy','walkthrough','collectible','challenge','platinum')),
    source VARCHAR(30) DEFAULT 'wordpress' CHECK (source IN ('wordpress','chatbot','manual','scraping','harvested')),
    quality_score DECIMAL(3,2) DEFAULT 0.00,
    verified BOOLEAN DEFAULT false,
    view_count INT DEFAULT 0,
    helpful_count INT DEFAULT 0,
    report_count INT DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    -- CORREZIONE AUDIT: colonna tsvector generata con stemming italiano e pesi
    search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('italian', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('italian', coalesce(content, '')), 'B')
    ) STORED,
    -- AUDIT FIX (Fatal Flaw #2 + R6): flag per embedding differito in finestra notturna.
    -- L'harvester inserisce guide con embedding_pending = true e fa ENQUEUE nella coda UNICA
    -- `embedding` con priority=10 (bassa). Il worker (concurrency=2, limiter.groupKey='gemini-embed')
    -- svuota la coda in finestra notturna 03:00-06:00 CET con advisory lock e batch max 50.
    embedding_pending BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guides_game ON guides(game_id);
CREATE INDEX IF NOT EXISTS idx_guides_slug ON guides(slug);
CREATE INDEX IF NOT EXISTS idx_guides_lang ON guides(language);
CREATE INDEX IF NOT EXISTS idx_guides_verified ON guides(verified) WHERE verified = true;
-- CORREZIONE AUDIT: indice GIN sulla colonna generata, non sull'espressione
CREATE INDEX IF NOT EXISTS idx_guides_fts ON guides USING gin(search_vector);
