-- Migration 010: Tabella guide_request_tracker
-- CORREZIONE AUDIT: UNIQUE su (game_id, trophy_id) non su query_normalized
CREATE TABLE IF NOT EXISTS guide_request_tracker (
    id SERIAL PRIMARY KEY,
    game_id INT REFERENCES games(id),
    trophy_id INT REFERENCES trophies(id),
    game_slug VARCHAR(255) NOT NULL,
    trophy_slug VARCHAR(255),
    request_count INT DEFAULT 1,
    first_requested TIMESTAMPTZ DEFAULT NOW(),
    last_requested TIMESTAMPTZ DEFAULT NOW(),
    published_to_wp BOOLEAN DEFAULT false,
    wp_post_id INT,
    flagged_at TIMESTAMPTZ,
    UNIQUE(game_id, trophy_id)
);

CREATE INDEX IF NOT EXISTS idx_tracker_count ON guide_request_tracker(request_count DESC);
CREATE INDEX IF NOT EXISTS idx_tracker_flagged ON guide_request_tracker(flagged_at) WHERE flagged_at IS NOT NULL;
