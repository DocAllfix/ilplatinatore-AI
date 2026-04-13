-- Migration 009: Tabella guide_ratings
-- CORREZIONE AUDIT: vincolo UNIQUE (guide_id, user_id) per impedire voti multipli
CREATE TABLE IF NOT EXISTS guide_ratings (
    id SERIAL PRIMARY KEY,
    guide_id INT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id),
    session_id UUID REFERENCES sessions(id),
    stars SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
    suggestion TEXT,
    language VARCHAR(10),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    -- CORREZIONE AUDIT: un utente/sessione può votare una guida una sola volta
    CONSTRAINT uq_rating_user UNIQUE (guide_id, user_id),
    CONSTRAINT uq_rating_session UNIQUE (guide_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_guide ON guide_ratings(guide_id);

-- Vista materializzata per aggregazione rating
CREATE MATERIALIZED VIEW IF NOT EXISTS guide_rating_summary AS
    SELECT
        guide_id,
        COUNT(*) AS total_ratings,
        ROUND(AVG(stars)::numeric, 2) AS avg_stars,
        COUNT(*) FILTER (WHERE suggestion IS NOT NULL) AS total_suggestions
    FROM guide_ratings
    GROUP BY guide_id;

-- CORREZIONE AUDIT: indice UNIQUE per REFRESH CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_rating_summary_guide ON guide_rating_summary(guide_id);
