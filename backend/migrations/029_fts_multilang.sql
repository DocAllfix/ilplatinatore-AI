-- Migration 029 (T1.3): FTS multilingua via ts_config per riga
--
-- Risolve P0-2: il search_vector era hardcoded `to_tsvector('italian', ...)`,
-- inutile per guide in EN/ES/FR/DE/PT/JA/ZH/RU.
--
-- Strategia:
--   1. DROP search_vector (GENERATED, vincolato all'italiano).
--   2. ADD ts_config regconfig per riga (derivato da language).
--   3. ADD search_vector tsvector aggiornato da trigger BEFORE INSERT/UPDATE.
--   4. Backfill via UPDATE forzato (trigger ricalcola tutto).
--   5. Re-create indice GIN.
--
-- NOTA su lingue senza stemmer PG nativo:
--   PostgreSQL ships con: italian, english, spanish, french, german,
--   portuguese, russian, dutch, ... NO Japanese/Chinese stemmer nativo.
--   Per ja/zh usiamo 'simple' (no stemming, solo lowercase + tokenize).
--   Funzionale ma non ottimale — migrabile a tsearch2-mecab in futuro.

-- ── 1. Drop indice + colonna GENERATED legacy ──────────────────────────────
DROP INDEX IF EXISTS idx_guides_fts;
ALTER TABLE guides DROP COLUMN IF EXISTS search_vector;

-- ── 2. ts_config column: derivata da language. NOT GENERATED perché useremo
--      trigger (PostgreSQL non permette GENERATED dependency da altra GENERATED).
ALTER TABLE guides
    ADD COLUMN IF NOT EXISTS ts_config regconfig DEFAULT 'english'::regconfig NOT NULL;

-- ── 3. search_vector column non-generata, popolata da trigger ──────────────
ALTER TABLE guides
    ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- ── 4. Funzione trigger: deriva ts_config da language + ricalcola search_vector
CREATE OR REPLACE FUNCTION guides_update_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    -- Mappa language ISO-639-1 → regconfig PostgreSQL.
    -- Lingue senza stemmer PG → 'simple' (tokenize + lowercase).
    NEW.ts_config := CASE NEW.language
        WHEN 'it' THEN 'italian'::regconfig
        WHEN 'en' THEN 'english'::regconfig
        WHEN 'es' THEN 'spanish'::regconfig
        WHEN 'fr' THEN 'french'::regconfig
        WHEN 'de' THEN 'german'::regconfig
        WHEN 'pt' THEN 'portuguese'::regconfig
        WHEN 'ru' THEN 'russian'::regconfig
        ELSE 'simple'::regconfig  -- ja, zh, e ogni altra lingua
    END;

    NEW.search_vector :=
        setweight(to_tsvector(NEW.ts_config, coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector(NEW.ts_config, coalesce(NEW.content, '')), 'B');

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 5. Trigger BEFORE INSERT/UPDATE — riarma search_vector quando cambia
--      title, content o language ────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_guides_search_vector ON guides;
CREATE TRIGGER trg_guides_search_vector
    BEFORE INSERT OR UPDATE OF title, content, language
    ON guides
    FOR EACH ROW EXECUTE FUNCTION guides_update_search_vector();

-- ── 6. Backfill: UPDATE no-op forza trigger su tutte le righe esistenti ────
-- Dummy SET title = title fa scattare il trigger (UPDATE OF title) anche se
-- il valore non cambia. Su 100k righe è ~30s, accettabile per migration one-shot.
UPDATE guides SET title = title;

-- ── 7. Indice GIN per FTS hot-path ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_guides_fts
    ON guides USING gin(search_vector);

-- ── 8. Indice composito per filtro language + FTS ──────────────────────────
-- Permette query type:
--   WHERE language = $lang AND search_vector @@ plainto_tsquery(ts_config, $q)
CREATE INDEX IF NOT EXISTS idx_guides_lang_fts
    ON guides(language) INCLUDE (ts_config);
