-- Migration 026: Aggiunge avatar_url alla tabella users
--
-- Necessario per Fase 21.x — sblocco stub frontend `uploadAvatar`.
-- Path relativo (es: "/uploads/avatars/123-1714478400000.png"); il frontend lo
-- concatena al base URL dell'API. Migrazione futura a CDN = solo cambio prefix.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500);

-- Indice non necessario: avatar_url è solo letto via id (PK già indicizzata).
