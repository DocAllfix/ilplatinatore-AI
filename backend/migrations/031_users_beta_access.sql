-- Migration 031: Beta gating — users.beta_access flag
--
-- Audit Sprint 4 / Definition of Done:
--   "Beta gating: white-list 50 utenti via flag `feature.beta_access` su
--    `users.metadata`"
--
-- Implementazione: colonna BOOLEAN dedicata invece che JSONB metadata, per
-- query indicizzata WHERE beta_access = true. Migrabile a feature flag system
-- (LaunchDarkly/PostHog) in futuro senza data loss.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS beta_access BOOLEAN DEFAULT false NOT NULL;

-- Indice parziale: la maggior parte degli utenti NON ha beta_access (Beta è
-- closed). Indice partial copre solo gli abilitati → footprint ridotto.
CREATE INDEX IF NOT EXISTS idx_users_beta_access
    ON users(beta_access)
    WHERE beta_access = true;

-- Audit metadata: chi ha attivato / quando.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS beta_access_granted_at TIMESTAMPTZ;
