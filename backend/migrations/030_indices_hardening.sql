-- Migration 030 (T2.5): Indici composti per query hot-path Pre-Beta
--
-- Risolve audit punto 2.6: mancavano indici critici per:
--   - dashboard utente (query_log per user)
--   - admin HITL (guide_drafts filtrati per status + user_id)
--   - ricerca per gameTitle/targetName in search_metadata JSONB
--
-- Tutti gli indici sono CREATE IF NOT EXISTS (idempotenti). Nessun lock
-- esclusivo: usiamo CONCURRENTLY dove il lock matter (su tabelle popolate).

-- ── 1. query_log: lookup per user ordinato per data (dashboard "Le mie query") ─
-- WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50
CREATE INDEX IF NOT EXISTS idx_query_log_user_date
    ON query_log(user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

-- ── 2. guide_drafts: filtri admin per (user_id, status) ────────────────────
-- WHERE user_id = $1 AND status IN ('pending_approval','approved') ORDER BY created_at DESC
-- L'indice parziale idx_guide_drafts_pending (mig 025) copre solo pending_approval;
-- questo composito serve per la "Le mie bozze" dashboard utente.
CREATE INDEX IF NOT EXISTS idx_drafts_user_status
    ON guide_drafts(user_id, status, created_at DESC)
    WHERE user_id IS NOT NULL;

-- ── 3. guide_drafts.search_metadata: ricerca per gameTitle nel JSONB ───────
-- Permette query come WHERE search_metadata->>'gameTitle' = 'Elden Ring'
-- senza full table scan (il GIN su JSONB indicizza tutte le chiavi).
-- jsonb_path_ops è più piccolo e veloce per ricerche di equality.
CREATE INDEX IF NOT EXISTS idx_drafts_search_metadata_gin
    ON guide_drafts USING gin (search_metadata jsonb_path_ops);

-- ── 4. guide_drafts.session_id senza WHERE NOT NULL: dup di mig 025 ───────
-- (già presente: idx_guide_drafts_session) — skip.

-- ── 5. guides: indice composto game_id + language + verified per RAG ──────
-- Coperto da idx_guides_game_lang_verified (creato in mig 028) — skip.

-- ── 6. user_game_stats già OK con UNIQUE (user_id, game_id) ────────────────
-- e idx_user_game_stats_user_slug (mig 027) — skip.
