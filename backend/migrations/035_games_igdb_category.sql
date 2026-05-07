-- Migration 035: aggiunge igdb_category e igdb_parent_game ai giochi.
--
-- igdb_category: enum numerico IGDB (0=main/remaster/remake, 1=DLC, 2=expansion,
--   3=bundle, 4=standalone_expansion, 6=episode, 7=season, ecc.).
--   NULL per giochi inseriti prima di questa migration o senza igdb_id.
--
-- igdb_parent_game: igdb_id del gioco "padre" (es. per TLoU Remastered punta
--   all'igdb_id di TLoU originale). NULL se il gioco non ha un parent in IGDB.
--   NON è una FK perché il parent potrebbe non essere nel nostro DB.

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS igdb_category    INTEGER,
  ADD COLUMN IF NOT EXISTS igdb_parent_game INTEGER;

-- Index per filtrare per categoria (es. tutti i remake, tutti i DLC)
CREATE INDEX IF NOT EXISTS idx_games_igdb_category
  ON games (igdb_category)
  WHERE igdb_category IS NOT NULL;

-- Index per trovare tutti i "figli" di un gioco parent
CREATE INDEX IF NOT EXISTS idx_games_igdb_parent_game
  ON games (igdb_parent_game)
  WHERE igdb_parent_game IS NOT NULL;

-- Commento descrittivo sulle colonne
COMMENT ON COLUMN games.igdb_category IS
  'IGDB category enum: 0=main_game/remaster/remake, 1=dlc, 2=expansion, 3=bundle, 4=standalone_expansion, 6=episode, 7=season. NULL se non importato da IGDB.';

COMMENT ON COLUMN games.igdb_parent_game IS
  'IGDB ID del gioco originale (padre). Es: TLoU Remastered -> igdb_id di TLoU. NULL se gioco originale o non noto.';
