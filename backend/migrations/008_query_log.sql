-- Migration 008: Tabella query_log (PARTIZIONATA per mese)
-- CORREZIONE AUDIT: partizionamento per performance a lungo termine
CREATE TABLE IF NOT EXISTS query_log (
    id SERIAL,
    user_id INT REFERENCES users(id),
    session_id UUID REFERENCES sessions(id),
    query_text TEXT NOT NULL,
    game_detected VARCHAR(255),
    trophy_detected VARCHAR(255),
    source_used VARCHAR(30),
    response_time_ms INT,
    quality_score DECIMAL(3,2),
    user_rating SMALLINT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Crea partizioni per i prossimi 6 mesi
CREATE TABLE IF NOT EXISTS query_log_2026_04 PARTITION OF query_log
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS query_log_2026_05 PARTITION OF query_log
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS query_log_2026_06 PARTITION OF query_log
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS query_log_2026_07 PARTITION OF query_log
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS query_log_2026_08 PARTITION OF query_log
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS query_log_2026_09 PARTITION OF query_log
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE INDEX IF NOT EXISTS idx_query_log_user ON query_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_query_log_game ON query_log(game_detected, created_at);
