-- Migration 011: Tabella system_config per parametri modificabili senza redeploy
-- CORREZIONE AUDIT: le soglie RAG non devono essere hardcodate
CREATE TABLE IF NOT EXISTS system_config (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO system_config (key, value, description) VALUES
    ('rag_threshold_high', '0.85', 'Soglia similarità per match diretto dal DB'),
    ('rag_threshold_low', '0.60', 'Soglia minima similarità per contesto parziale'),
    ('rag_max_results', '5', 'Numero massimo risultati RAG'),
    ('scraping_delay_ms', '3000', 'Delay tra richieste scraping stesso dominio'),
    ('popular_guide_threshold', '50', 'Richieste per flaggare guida come popolare'),
    ('cache_guide_ttl_hours', '72', 'TTL cache guide in ore'),
    ('cache_scraping_ttl_days', '7', 'TTL cache risultati scraping in giorni')
ON CONFLICT (key) DO NOTHING;
