-- Migration 028 (T1.2): Multilingua + embedding hardening
--
-- Risolve:
--   - guides.language default 'it' → 'en' (canon DB inglese)
--   - guide_embeddings senza colonna language → impossibile filtrare RAG per lingua
--   - guide_embeddings senza embedding_model → cambio modello = purge totale
--   - guide_embeddings senza chunk_hash → impossibile idempotency su retry
--
-- Strategia: ALTER non-distruttivo. Le righe esistenti ottengono il default
-- 'en' per language e il modello attuale 'text-embedding-004'.

-- ── 1. guides.language: cambia default 'it' → 'en' ─────────────────────────
-- I record esistenti restano con 'it' (la regola DB canon english si applica
-- ai nuovi insert). Per migrare retroattivamente serve un job dedicato che
-- distingua guide IT-by-design (Fase 20 WordPress) da guide HARVESTED (sempre EN).
ALTER TABLE guides ALTER COLUMN language SET DEFAULT 'en';

-- ── 2. guide_embeddings.language: denormalizzato per filtri HNSW ───────────
-- Backfill da guides via JOIN, poi NOT NULL.
ALTER TABLE guide_embeddings
    ADD COLUMN IF NOT EXISTS language VARCHAR(10);

UPDATE guide_embeddings ge
   SET language = g.language
  FROM guides g
 WHERE ge.guide_id = g.id
   AND ge.language IS NULL;

ALTER TABLE guide_embeddings
    ALTER COLUMN language SET NOT NULL,
    ALTER COLUMN language SET DEFAULT 'en';

-- Indice composito per RAG language-aware. Il vector search filtra prima per
-- lingua (selettivo), poi applica HNSW sul subset.
CREATE INDEX IF NOT EXISTS idx_embeddings_lang
    ON guide_embeddings(language);

-- ── 3. guide_embeddings.embedding_model: tracking modello generatore ───────
-- Permette migrazioni soft (text-embedding-004 → 005) tenendo embedding multipli.
ALTER TABLE guide_embeddings
    ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(50)
    DEFAULT 'text-embedding-004' NOT NULL;

-- ── 4. guide_embeddings.chunk_hash: idempotency su retry parziali ──────────
-- sha256 hex (64 char) del chunk_text. Permette ON CONFLICT su retry.
ALTER TABLE guide_embeddings
    ADD COLUMN IF NOT EXISTS chunk_hash VARCHAR(64);

-- Backfill hash sui record esistenti via funzione PostgreSQL nativa.
UPDATE guide_embeddings
   SET chunk_hash = encode(digest(chunk_text, 'sha256'), 'hex')
 WHERE chunk_hash IS NULL;

ALTER TABLE guide_embeddings
    ALTER COLUMN chunk_hash SET NOT NULL;

-- UNIQUE su (guide_id, chunk_hash, embedding_model): evita duplicati cross-modello.
-- L'INSERT idempotente in embedding.service usa ON CONFLICT su questo constraint.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'guide_embeddings_chunk_uniq'
    ) THEN
        ALTER TABLE guide_embeddings
            ADD CONSTRAINT guide_embeddings_chunk_uniq
            UNIQUE (guide_id, chunk_hash, embedding_model);
    END IF;
END $$;

-- ── 5. Indice composito multi-tenant per query RAG hot-path ────────────────
-- Coperto da WHERE g.game_id = $1 AND g.language = $2 AND g.verified = true
-- frequente sull'orchestrator quando il game è normalizzato.
CREATE INDEX IF NOT EXISTS idx_guides_game_lang_verified
    ON guides(game_id, language, verified)
    WHERE verified = true;
