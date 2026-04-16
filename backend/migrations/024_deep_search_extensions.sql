-- Migration 024: Deep Search Extensions
--
-- Tre aggiornamenti:
-- 1. Colonna topic su guides — identifica l'argomento della guida (boss, personaggio,
--    arma, enigma) separato dal trofeo. Usata da retrieveForTopic in Fase 13.
-- 2. Indice composto game_id + guide_type + topic per query RAG granulari.
-- 3. Indici GIN trigram su trophies.name_en e name_it per findTrophyByName fuzzy
--    (Fase 13). pg_trgm è già abilitata in 001_extensions.sql.

-- ── 1. Colonna topic su guides ─────────────────────────────────────────────
-- Nullable: guide trophy-specifiche non hanno topic (topic = NULL).
-- Guide granulari (boss/lore/build/collectible) popolano questo campo.

ALTER TABLE guides
ADD COLUMN IF NOT EXISTS topic VARCHAR(255);

-- ── 2. Indice composto per query RAG granulari ────────────────────────────
-- Parziale: solo righe con topic NOT NULL (guide granulari).
-- Usato da retrieveForTopic: WHERE game_id=$1 AND guide_type=$2 AND topic=$3.

CREATE INDEX IF NOT EXISTS idx_guides_game_type_topic
ON guides(game_id, guide_type, topic)
WHERE topic IS NOT NULL;

-- ── 3. Indici GIN trigram su trophies.name_en e name_it ──────────────────
-- Prerequisito per findTrophyByName fuzzy (Fase 13, migration F in DEEP_SEARCH_ADDITIONS).
-- name_en: sempre presente (lingua primaria DB).
-- name_it: lingua principale utenti italiani (PSN anchor prompt).

CREATE INDEX IF NOT EXISTS idx_trophies_name_en_trgm
ON trophies USING gin (name_en gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_trophies_name_it_trgm
ON trophies USING gin (name_it gin_trgm_ops);
