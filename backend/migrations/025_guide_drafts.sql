-- Migration 025: Tabella guide_drafts — Self-Learning RAG (Human-in-the-Loop)
--
-- Memorizza le bozze generate dall'orchestrator prima della pubblicazione.
-- FSM status: draft → revision → pending_approval → approved/rejected → published/failed
-- Le bozze non approvate scadono via Redis TTL; quelle approvate vengono ingested in guides.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS guide_drafts (
    -- ── Identity ──────────────────────────────────────────────────────────────
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(36),
    user_id INT REFERENCES users(id) ON DELETE SET NULL,

    -- ── Guide Context ─────────────────────────────────────────────────────────
    game_id INT REFERENCES games(id) ON DELETE SET NULL,
    trophy_id INT REFERENCES trophies(id) ON DELETE SET NULL,
    title VARCHAR(500),
    slug VARCHAR(500),
    content TEXT NOT NULL,
    language VARCHAR(10) DEFAULT 'en',
    guide_type VARCHAR(30) CHECK (guide_type IN ('trophy','walkthrough','collectible','challenge','platinum')),
    topic VARCHAR(255),

    -- ── Draft FSM ─────────────────────────────────────────────────────────────
    -- draft: appena generata
    -- revision: in corso di revisione (max 5 iteration)
    -- pending_approval: pronta per revisione umana
    -- approved: approvata, pronta per ingestion
    -- rejected: scartata
    -- published: ingested in guides
    -- failed: ingestion fallita
    status VARCHAR(30) DEFAULT 'draft' CHECK (
        status IN ('draft','revision','pending_approval','approved','rejected','published','failed')
    ),
    iteration_count INT DEFAULT 0,
    original_query TEXT,

    -- ── Source Metadata ───────────────────────────────────────────────────────
    -- sources_json: array di {url, domain, reliability} dalla fase di scraping/RAG
    -- search_metadata: informazioni aggiuntive (Tavily query, timing, source_used)
    sources_json JSONB DEFAULT '[]',
    search_metadata JSONB DEFAULT '{}',

    -- ── Quality ───────────────────────────────────────────────────────────────
    quality_score DECIMAL(3,2) DEFAULT 0.00,
    validation_errors JSONB DEFAULT '[]',

    -- ── Timestamps ───────────────────────────────────────────────────────────
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    approved_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,

    -- ── Link to published guide ───────────────────────────────────────────────
    published_guide_id INT REFERENCES guides(id) ON DELETE SET NULL
);

-- Indici per lookup frequenti
CREATE INDEX IF NOT EXISTS idx_guide_drafts_session
ON guide_drafts(session_id)
WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_guide_drafts_user
ON guide_drafts(user_id)
WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_guide_drafts_status
ON guide_drafts(status);

-- Indice parziale per coda approvazione (pending_approval è piccola, scan rapido)
CREATE INDEX IF NOT EXISTS idx_guide_drafts_pending
ON guide_drafts(created_at DESC)
WHERE status = 'pending_approval';

-- Trigger updated_at automatico (riusa la funzione di migration 004 se esiste)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guide_drafts_updated_at
BEFORE UPDATE ON guide_drafts
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
