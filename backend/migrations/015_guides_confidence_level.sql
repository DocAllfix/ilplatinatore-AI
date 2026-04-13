-- Migration: Aggiunta confidence_level alla tabella guides
-- verified = da WordPress o approvata da utenti
-- harvested = generata dall'ingestion engine, non ancora verificata
-- generated = generata on-demand da scraping + LLM
-- unverified = generata solo dalla conoscenza interna dell'LLM

ALTER TABLE guides
ADD COLUMN IF NOT EXISTS confidence_level VARCHAR(20)
DEFAULT 'generated'
CHECK (confidence_level IN ('verified', 'harvested', 'generated', 'unverified'));

-- Le guide già presenti (migrate da WordPress) sono verified
UPDATE guides SET confidence_level = 'verified' WHERE source = 'wordpress';
UPDATE guides SET confidence_level = 'verified' WHERE source = 'openclaw';

CREATE INDEX IF NOT EXISTS idx_guides_confidence ON guides(confidence_level);
