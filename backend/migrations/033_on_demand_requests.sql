-- Migration 033: On-Demand Live Harvesting (Fase 25)
--
-- Tabella per tracciare richieste live: quando il RAG non trova match (o low
-- confidence) e il flag ON_DEMAND_HARVEST_ENABLED=true, l'orchestrator backend
-- inserisce qui una riga `pending`. Il worker Python `on_demand_worker.py`
-- la pesca, esegue scrape+transform+inject, scrive `guide_id` e marca `completed`.
--
-- Il backend fa polling DB con backoff 2s (timeout client 45s), il worker timeout
-- job 30s (buffer 15s). Status 'timeout' viene scritto dal backend, non dal worker.

CREATE TABLE IF NOT EXISTS on_demand_requests (
    id SERIAL PRIMARY KEY,
    -- Chi ha fatto la richiesta (NULL per anonymous se mai consentito).
    user_id INT REFERENCES users(id) ON DELETE SET NULL,
    -- Query originale dell'utente (per ricostruire URL collector).
    query TEXT NOT NULL,
    -- Optional: gioco già identificato dall'orchestrator (skip discovery se presente).
    game_id INT REFERENCES games(id) ON DELETE SET NULL,
    -- Lifecycle: pending -> processing -> completed | failed | timeout.
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    -- Guide creata dal worker (filled on completion).
    guide_id INT REFERENCES guides(id) ON DELETE SET NULL,
    -- Errore worker (filled on failed).
    error_message TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CONSTRAINT chk_on_demand_status CHECK (
        status IN ('pending', 'processing', 'completed', 'failed', 'timeout')
    )
);

-- Index per polling worker: scan veloce su pending FIFO.
CREATE INDEX IF NOT EXISTS idx_on_demand_pending
    ON on_demand_requests(status, requested_at)
    WHERE status = 'pending';

-- Index per analytics user × tempo (audit/debug).
CREATE INDEX IF NOT EXISTS idx_on_demand_user_date
    ON on_demand_requests(user_id, requested_at DESC)
    WHERE user_id IS NOT NULL;
