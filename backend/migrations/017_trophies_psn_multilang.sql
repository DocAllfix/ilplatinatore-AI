-- Migration 017: Estensione trophies con campi PSN multilingua
-- Aggiunge nomi ufficiali Sony in 10 lingue + metadati PSN Trophy API

ALTER TABLE trophies
ADD COLUMN IF NOT EXISTS psn_trophy_id    VARCHAR(50),
ADD COLUMN IF NOT EXISTS psn_communication_id VARCHAR(50),
ADD COLUMN IF NOT EXISTS name_en          TEXT,
ADD COLUMN IF NOT EXISTS name_it          TEXT,
ADD COLUMN IF NOT EXISTS name_fr          TEXT,
ADD COLUMN IF NOT EXISTS name_de          TEXT,
ADD COLUMN IF NOT EXISTS name_es          TEXT,
ADD COLUMN IF NOT EXISTS name_pt          TEXT,
ADD COLUMN IF NOT EXISTS name_ja          TEXT,
ADD COLUMN IF NOT EXISTS name_ko          TEXT,
ADD COLUMN IF NOT EXISTS name_zh_hans     TEXT,
ADD COLUMN IF NOT EXISTS name_zh_hant     TEXT,
ADD COLUMN IF NOT EXISTS detail_en        TEXT,
ADD COLUMN IF NOT EXISTS detail_it        TEXT,
ADD COLUMN IF NOT EXISTS icon_url         TEXT,
ADD COLUMN IF NOT EXISTS rarity_source    VARCHAR(20) DEFAULT 'estimated'
    CHECK (rarity_source IN ('psn_official', 'psnprofiles', 'estimated'));

-- Indice univoco per lookup via PSN IDs (solo dove valorizzato).
-- Permette upsert idempotente dal fetcher senza duplicati.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trophies_psn_id
ON trophies(psn_communication_id, psn_trophy_id)
WHERE psn_trophy_id IS NOT NULL;

-- Backfill: copia name esistente in name_en come fallback
-- per le righe già presenti prima di questa migration.
UPDATE trophies SET name_en = name WHERE name_en IS NULL;
