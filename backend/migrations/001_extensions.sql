-- Migration 001: Abilita estensioni necessarie
-- IMPORTANTE: Eseguire come superuser

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
