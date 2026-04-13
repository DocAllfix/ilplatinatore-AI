#!/usr/bin/env bash
# seed.sh — Runner seed dati di test
# Uso: ./scripts/seed.sh
# DA USARE SOLO in ambiente development/staging, MAI in produzione

set -euo pipefail

SEEDS_DIR="$(dirname "$0")/../backend/seeds"
POSTGRES_URL="${POSTGRES_DIRECT_URL:-$DATABASE_URL}"

if [[ "$NODE_ENV" == "production" ]]; then
  echo "ERROR: seed.sh non può essere eseguito in produzione" >&2
  exit 1
fi

if [[ -z "$POSTGRES_URL" ]]; then
  echo "ERROR: POSTGRES_DIRECT_URL o DATABASE_URL non impostati" >&2
  exit 1
fi

echo "==> Caricamento seed da: $SEEDS_DIR"

for seed_file in "$SEEDS_DIR"/*.sql; do
  if [[ -f "$seed_file" ]]; then
    echo "  -> Applying: $(basename "$seed_file")"
    psql "$POSTGRES_URL" -f "$seed_file"
  fi
done

echo "==> Seed completato."
