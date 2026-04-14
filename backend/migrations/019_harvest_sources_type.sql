-- Migration 019: Aggiunge source_type a harvest_sources
-- Permette di distinguere la fonte primaria (guida principale),
-- fonti supplementari (wiki, Reddit) e fonti community.

ALTER TABLE harvest_sources
ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) DEFAULT 'primary'
    CHECK (source_type IN ('primary', 'supplementary', 'community'));

-- Indice per filtrare per tipo di fonte nelle query RAG.
CREATE INDEX IF NOT EXISTS idx_harvest_source_type
ON harvest_sources(source_type);
