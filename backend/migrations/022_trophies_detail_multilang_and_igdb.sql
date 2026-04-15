-- Migration 022: Descrizioni trofei multilingua + IGDB ID + upcoming games tracking
--
-- Tre cambiamenti:
-- 1. Aggiunge colonne detail_* per le 8 lingue mancanti (fr/de/es/pt/ja/ko/zh_hans/zh_hant)
-- 2. Aggiunge igdb_id su games per dedup affidabile e lookup O(log n)
-- 3. Crea tabella upcoming_games per tracciare giochi pre-release

-- ── 1. Descrizioni trofei multilingua ───────────────────────────────────────
-- Migration 017 aveva aggiunto solo detail_en e detail_it.
-- PSN Trophy API restituisce trophyDetail per tutte le lingue — ora le salviamo.

ALTER TABLE trophies
ADD COLUMN IF NOT EXISTS detail_fr      TEXT,
ADD COLUMN IF NOT EXISTS detail_de      TEXT,
ADD COLUMN IF NOT EXISTS detail_es      TEXT,
ADD COLUMN IF NOT EXISTS detail_pt      TEXT,
ADD COLUMN IF NOT EXISTS detail_ja      TEXT,
ADD COLUMN IF NOT EXISTS detail_ko      TEXT,
ADD COLUMN IF NOT EXISTS detail_zh_hans TEXT,
ADD COLUMN IF NOT EXISTS detail_zh_hant TEXT;

-- ── 2. IGDB ID su games ─────────────────────────────────────────────────────
-- Permette dedup deterministica per giochi scoperti via IGDB senza dipendere
-- dal matching slug (che può variare tra IGDB e PSN Store).

ALTER TABLE games
ADD COLUMN IF NOT EXISTS igdb_id INTEGER;

-- Indice unico per garantire nessun duplicato e lookup rapido.
-- NULL ammesso (giochi inseriti manualmente senza IGDB).
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_igdb_id
ON games(igdb_id)
WHERE igdb_id IS NOT NULL;

-- ── 3. Tabella upcoming_games ───────────────────────────────────────────────
-- Traccia giochi non ancora usciti con alto numero di follower/hype su IGDB.
-- Quando il gioco viene rilasciato, un job lo migra a games e avvia il
-- processo di discovery trofei (PSN/Steam/Xbox).

CREATE TABLE IF NOT EXISTS upcoming_games (
    id              SERIAL PRIMARY KEY,
    igdb_id         INTEGER UNIQUE NOT NULL,
    title           TEXT NOT NULL,
    slug            TEXT,
    platforms       TEXT[] DEFAULT '{}',
    expected_date   DATE,
    hypes           INTEGER DEFAULT 0,
    follows         INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'upcoming'
        CHECK (status IN ('upcoming', 'released', 'cancelled')),
    processed       BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indice per il job periodico che controlla gli upcoming non ancora processati.
CREATE INDEX IF NOT EXISTS idx_upcoming_pending
ON upcoming_games(status, processed)
WHERE status = 'upcoming' AND processed = FALSE;
