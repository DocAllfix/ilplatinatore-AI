#!/usr/bin/env bash
# migrate.sh — Runner migrazioni SQL numerati
# Uso: ./scripts/migrate.sh
# Connessione DIRETTA a PostgreSQL (non PgBouncer) per DDL e transazioni di migrazione

set -euo pipefail

MIGRATIONS_DIR="$(dirname "$0")/../backend/migrations"
POSTGRES_URL="${POSTGRES_DIRECT_URL:-$DATABASE_URL}"

if [[ -z "$POSTGRES_URL" ]]; then
  echo "ERROR: POSTGRES_DIRECT_URL o DATABASE_URL non impostati" >&2
  exit 1
fi

echo "==> Esecuzione migrazioni da: $MIGRATIONS_DIR"

for migration_file in "$MIGRATIONS_DIR"/*.sql; do
  if [[ -f "$migration_file" ]]; then
    echo "  -> Applying: $(basename "$migration_file")"
    psql "$POSTGRES_URL" -f "$migration_file"
  fi
done

echo "==> Migrazioni completate."
