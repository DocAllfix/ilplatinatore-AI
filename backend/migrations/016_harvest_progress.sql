-- Tabella per tracciare progresso batch harvester.
-- Permette restart idempotente: se il container crasha,
-- al riavvio riprende dall'ultimo gioco processato con successo.
CREATE TABLE IF NOT EXISTS harvest_progress (
    seed_file    VARCHAR(255) PRIMARY KEY,
    last_seed_slug VARCHAR(255),
    last_seen_at   TIMESTAMPTZ DEFAULT NOW(),
    total_processed INT DEFAULT 0,
    total_failed    INT DEFAULT 0
);
