-- Migration 018: Estende guide_type con nuovi tipi per deep search
-- e aggiunge indice su embedding_pending (colonna già presente da 004).

-- DROP + RECREATE del CHECK su guide_type.
-- Il nome guides_guide_type_check è generato automaticamente da PostgreSQL
-- dalla definizione inline in 004_guides.sql (schema: {table}_{col}_check).
ALTER TABLE guides
DROP CONSTRAINT IF EXISTS guides_guide_type_check;

ALTER TABLE guides
ADD CONSTRAINT guides_guide_type_check
CHECK (guide_type IN (
    'trophy',
    'walkthrough',
    'collectible',
    'challenge',
    'platinum',
    'boss',
    'build',
    'puzzle',
    'meta',
    'lore',
    'faq'
));

-- Indice parziale su embedding_pending per performance del worker Node.js.
-- La colonna esiste già da 004_guides.sql — aggiungiamo solo l'indice.
CREATE INDEX IF NOT EXISTS idx_guides_embedding_pending
ON guides(embedding_pending)
WHERE embedding_pending = true;
