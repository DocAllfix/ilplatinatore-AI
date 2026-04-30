-- Migration 027: Tabella user_game_stats — statistiche utente per gioco
--
-- Frontend: GameStatsPanel.jsx + ProgressDashboard.jsx (Fase 21.x).
-- Tracciamento manuale dell'utente: ore giocate, boss sconfitti, livello, quest, % completamento.
-- Un set di stat per ogni coppia (user_id, game_id).

CREATE TABLE IF NOT EXISTS user_game_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- ── FK con CASCADE: stat cancellate se utente o gioco vengono rimossi ──
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,

    -- ── Cache denormalizzata (frontend filtra per slug, non id) ──
    -- Lo slug di un gioco è considerato immutabile per design; in caso contrario
    -- una migration di rename aggiornerà esplicitamente questa colonna.
    game_slug VARCHAR(255) NOT NULL,
    game_name VARCHAR(500) NOT NULL,

    -- ── Statistiche manuali (anti-input-malformato via CHECK) ──
    total_playtime         INT      DEFAULT 0  CHECK (total_playtime >= 0),
    bosses_felled          INT      DEFAULT 0  CHECK (bosses_felled >= 0),
    current_level          INT      DEFAULT 1  CHECK (current_level >= 1),
    quests_completed       INT      DEFAULT 0  CHECK (quests_completed >= 0),
    progression_percentage SMALLINT DEFAULT 0  CHECK (progression_percentage BETWEEN 0 AND 100),

    -- ── Timestamps ──
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Un solo set di stat per (utente, gioco). Forza upsert idempotente lato app.
    CONSTRAINT user_game_stats_uniq UNIQUE (user_id, game_id)
);

-- Indice per la query principale del frontend: GET /api/game-stats?gameSlug=X
-- (dove X è anchor sull'utente loggato → user_id + game_slug).
CREATE INDEX IF NOT EXISTS idx_user_game_stats_user_slug
ON user_game_stats(user_id, game_slug);

-- Trigger updated_at automatico (riusa funzione globale già definita).
CREATE TRIGGER trg_user_game_stats_updated_at
BEFORE UPDATE ON user_game_stats
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
