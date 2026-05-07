-- Migration 036: campi popolarità IGDB su games.
-- igdb_rating_count: numero di rating utenti su IGDB (proxy affidabilità/notorietà).
-- igdb_hypes:        numero di utenti che hanno messo il gioco in wishlist pre-release.
-- igdb_follows:      numero di follower del gioco su IGDB.
-- Tutti e tre insieme permettono di ordinare per popolarità reale e selezionare
-- i giochi più rilevanti per la generazione guide e il feed discovery.

ALTER TABLE games
    ADD COLUMN IF NOT EXISTS igdb_rating_count INTEGER,
    ADD COLUMN IF NOT EXISTS igdb_hypes        INTEGER,
    ADD COLUMN IF NOT EXISTS igdb_follows      INTEGER;

-- Indice per ORDER BY igdb_rating_count DESC (top giochi per guide, seed, etc.)
CREATE INDEX IF NOT EXISTS idx_games_igdb_rating_count
    ON games (igdb_rating_count DESC NULLS LAST)
    WHERE igdb_rating_count IS NOT NULL;
