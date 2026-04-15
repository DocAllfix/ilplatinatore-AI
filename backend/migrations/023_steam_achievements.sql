-- Migration 023: Supporto Steam achievements
--
-- Tre cambiamenti:
-- 1. Aggiunge steam_appid su games per lookup rapido Steam → gioco
-- 2. Aggiunge steam_achievement_id su trophies per dedup Steam achievements
-- 3. Estende rarity_source per includere 'steam_official'

-- ── 1. Steam App ID su games ───────────────────────────────────────────────
-- Permette di collegare un gioco al suo equivalente Steam Store.
-- Popolato via IGDB external_games (category=1) o manualmente.

ALTER TABLE games
ADD COLUMN IF NOT EXISTS steam_appid INTEGER;

-- Indice unico per dedup e lookup rapido. NULL ammesso (giochi senza Steam).
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_steam_appid
ON games(steam_appid)
WHERE steam_appid IS NOT NULL;

-- ── 2. Steam achievement ID su trophies ────────────────────────────────────
-- L'API Steam identifica ogni achievement con un apiname (stringa).
-- Insieme al game_id forma la chiave unica per dedup.

ALTER TABLE trophies
ADD COLUMN IF NOT EXISTS steam_achievement_id VARCHAR(255);

-- Indice unico parziale per ON CONFLICT: (game_id, steam_achievement_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_trophies_steam_id
ON trophies(game_id, steam_achievement_id)
WHERE steam_achievement_id IS NOT NULL;

-- ── 3. Estende rarity_source per Steam ─────────────────────────────────────
-- Aggiunge 'steam_official' ai valori ammessi.
-- DROP + recreate perché ALTER CONSTRAINT non supporta ADD VALUE su CHECK.

ALTER TABLE trophies DROP CONSTRAINT IF EXISTS trophies_rarity_source_check;
ALTER TABLE trophies ADD CONSTRAINT trophies_rarity_source_check
    CHECK (rarity_source IN ('psn_official', 'psnprofiles', 'estimated', 'steam_official'));
