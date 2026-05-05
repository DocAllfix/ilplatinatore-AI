-- Migration 034: Games auto-creation support for draft ingestion
--
-- Aggiunge il flag `auto_created` ai giochi creati automaticamente durante
-- l'ingestione di bozze HITL quando il gioco non è presente nel catalogo.
-- Permette all'admin di filtrare i giochi che necessitano arricchimento manuale
-- (trofei PSN, cover IGDB, piattaforme, etc.).

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS auto_created BOOLEAN NOT NULL DEFAULT FALSE;

-- Indice parziale: solo i giochi auto-creati (solitamente < 1% del catalogo).
-- Utile per la pagina admin "giochi da rivedere".
CREATE INDEX IF NOT EXISTS idx_games_auto_created
  ON games(created_at DESC)
  WHERE auto_created = TRUE;
