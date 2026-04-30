# Il Platinatore AI — Operations Runbook

**Audience**: admin / on-call. Manuale operativo per le procedure più comuni
(monitoring, troubleshooting, rollback, manutenzione).

> Versione: post-Sprint 4 (Pre-Beta) · Updated: 2026-04-30

---

## 1. Servizi e dipendenze

| Servizio | Container | Porta | Health endpoint |
|----------|-----------|-------|-----------------|
| Backend API | `platinatore-api` | 3000 | `GET /health` |
| PostgreSQL + pgvector | `platinatore-postgres` | 5432 (dev override) | `pg_isready` |
| PgBouncer | `platinatore-pgbouncer` | 6432 | TCP probe |
| Redis | `platinatore-redis` | 6379 (dev) | `redis-cli ping` |
| Harvester | `platinatore-harvester` | — (interno) | log heartbeat |
| Scraper | `platinatore-scraper` | — (interno) | log heartbeat |

Tutto compose-orchestrato:
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

---

## 2. Health checks rapidi

### Verificare che il backend risponda
```bash
curl -fsS http://localhost:3000/health
# {"ok":true,"now":"2026-04-30T..."}
```

### Verificare lo stato del Circuit Breaker LLM
```bash
# Endpoint admin (TODO Sprint successivo)
# Per ora via log: cerca "circuit OPEN" in pino output
docker logs platinatore-api --tail 200 | grep -i circuit
```

### Verificare embedding queue depth
```bash
docker exec -it platinatore-redis redis-cli -n 0 \
  --eval - <<'EOF'
local waiting = redis.call('LLEN', 'bull:embedding:wait')
local active  = redis.call('LLEN', 'bull:embedding:active')
local delayed = redis.call('ZCARD', 'bull:embedding:delayed')
local failed  = redis.call('ZCARD', 'bull:embedding:failed')
return {waiting, active, delayed, failed}
EOF
```

Allarmi:
- `waiting > 10_000` → scheduler 03:00 sta accumulando, verifica worker concurrency
- `failed > 100` → ispeziona ultimi 10 fail con `bullmq-board` o query Redis

---

## 3. Monitoring & metrics

### Logs strutturati (pino)
Ogni service emette JSON. Filtri tipici:
```bash
# Errori ultimi 5 min
docker logs platinatore-api --since 5m 2>&1 | grep '"level":50'

# Slow query (RAG > 2s)
docker logs platinatore-api --since 1h 2>&1 | grep "RAG search" | jq 'select(.totalMs > 2000)'

# Tutte le bozze HITL create oggi
docker logs platinatore-api --since 24h 2>&1 | grep "createDraft"
```

### Query log analytics
```sql
-- Query per dashboard utilizzo
SELECT
  date_trunc('hour', created_at) AS hour,
  source_used,
  COUNT(*) AS queries,
  AVG(response_time_ms) AS avg_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms) AS p95_ms
FROM query_log
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
```

### Embedding queue health (BullMQ)
```sql
-- Bozze in coda embedding (pending=true) ordered by age
SELECT id, title, language, created_at,
       NOW() - created_at AS age
FROM guides
WHERE embedding_pending = true
ORDER BY created_at ASC
LIMIT 50;
```

---

## 4. Troubleshooting

### "Il chatbot non risponde / 500 ovunque"

1. Verifica che tutti i container siano `healthy`:
   ```bash
   docker compose ps
   ```
2. Tail dei log API:
   ```bash
   docker logs platinatore-api --tail 50 -f
   ```
3. Se vedi `circuit OPEN`: il LLM è giù. Controlla quota Gemini su
   console.cloud.google.com. Il breaker riapre dopo 5 min auto.
4. Se vedi `ECONNREFUSED ::1:5432`: postgres giù → `docker compose start postgres`.
5. Se vedi `Redis ECONNREFUSED`: redis giù → `docker compose start redis`.

### "Le query in lingua X danno output strani"

T1.1 supporta solo 9 lingue Tier 1 (it/en/es/fr/de/pt/ja/zh/ru). Lingue
non whitelisted ricadono su EN.

Verifica: `detectLanguage("query")` dovrebbe ritornare ISO-639-1 noto.

Se la lingua è in whitelist ma l'output è degradato:
1. Controlla che la migration 029 sia applicata (FTS multilingua):
   ```sql
   \d guides
   -- deve avere colonna ts_config regconfig
   ```
2. Verifica i template i18n in `prompt.builder.ts` — se la lingua usa un
   set di label EN come fallback è ok ma l'output sarà parzialmente in EN.

### "Quality score sempre basso, troppe bozze HITL"

Cause comuni:
- LLM sta producendo refusal pattern (`I don't have enough information`):
  → il RAG è vuoto. Verifica `query_log.source_used` ultimo run.
- PSN cross-check segnala unverified ids:
  → il LLM sta inventando trofei. Verifica `trophies.psn_trophy_id` populato.
  → harvester PSN deve essere passato per il game_id in questione.
- Sources < 2: il RAG retrieve sotto-soglia. Aggiungi guide al DB
  (re-run harvester) o ammorbidisci `RAG_SIMILARITY_THRESHOLD_LOW` in env.

### "Cache hit ratio basso"

```bash
# Conta HIT/MISS dai log ultimi 1h
docker logs platinatore-api --since 1h 2>&1 \
  | grep -E "GuideCache: HIT|orchestrator STEP 2" \
  | jq -s 'group_by(.message) | map({k:.[0].message, n:length})'
```

Cache key: `guide:{game_slug}:{trophy_slug}:{lang}`. Bassa hit ratio è
attesa per i primi 100 utenti (cold cache). Dopo 1k+ query unique
dovrebbe attestarsi al 30-50%.

---

## 5. Maintenance

### Applicare nuove migrations
```bash
cd backend
npm run migrate
# Output: ogni migration eseguita o "skip" se già applicata.
```

### Rollback di una migration
PostgreSQL non ha rollback automatico per migration ad-hoc. Procedura manuale:
1. Identifica le DDL inverse (DROP/ALTER inverse).
2. Crea una nuova migration `NNN_revert_X.sql` con quelle DDL.
3. Esegui `npm run migrate`.

⚠️ **MAI** modificare una migration già applicata. Sempre nuove migration con numerazione progressiva.

### Re-embed di guide bloccate
```bash
# Re-accoda tutte le guide con embedding_pending=true e flag stuck
cd backend
npm run re-embed -- --batch-size 100
```

### Bulk seed di guide JSONL
```bash
cd backend
npm run seed -- --file /path/to/guides.jsonl --batch-size 50
# Il file ha checkpoint automatico: --resume riprende dal punto interrotto.
```

### Cleanup retention manuale
I cron `cleanup.scheduler.ts` girano daily a 02:30/02:45 Europe/Rome.
Per esecuzione on-demand:
```bash
docker exec -it platinatore-postgres psql -U platinatore -d platinatore_db -c \
  "DELETE FROM query_log WHERE created_at < NOW() - INTERVAL '90 days';"

docker exec -it platinatore-postgres psql -U platinatore -d platinatore_db -c \
  "DELETE FROM guide_drafts WHERE status IN ('rejected','failed') AND updated_at < NOW() - INTERVAL '30 days';"
```

### Re-cluster pg_trgm e refresh materialized view rating
```sql
REINDEX INDEX idx_games_title_trgm;          -- ribilancia trgm
REFRESH MATERIALIZED VIEW CONCURRENTLY guide_rating_summary;
```

---

## 6. Disaster recovery

### "Postgres data volume corrotto"
1. Stop: `docker compose stop postgres`
2. Backup volume corrotto: `docker run --rm -v il-platinatore-ai_postgres_data:/d -v ${PWD}:/b alpine tar czf /b/pg-corrupt.tar.gz -C /d .`
3. Restore da ultimo backup (se esiste): `docker run --rm -v il-platinatore-ai_postgres_data:/d -v /backups:/b alpine tar xzf /b/pg-yyyy-mm-dd.tar.gz -C /d`
4. Start: `docker compose start postgres`
5. Verifica: `docker exec platinatore-postgres pg_isready`

### "Redis data lost (no AOF)"
- Cache: si ricostruisce automaticamente (cold start)
- Embedding queue: BullMQ ha `removeOnComplete` con age=1h, perdita = re-embed dei pending
- Conversation memory: TTL 1h, perdita = utenti perdono multi-turn (acceptable)
- Rate limit windows: perdita = utenti possono superare brevemente i limiti

### "PgBouncer pg_hba MD5 perso"
Sintomo: log API "wrong password type". Se hai fatto `docker compose down -v` la regola `172.16.0.0/12 md5` nel volume PgBouncer è perduta.

Fix:
```bash
docker exec -it platinatore-pgbouncer sh -c \
  "echo 'host all all 172.16.0.0/12 md5' >> /etc/pgbouncer/pg_hba.conf && \
   pgbouncer -R /etc/pgbouncer/pgbouncer.ini"
```

---

## 7. Capacity planning

### Limiti attuali (single-replica)
- API: 1 replica (CLAUDE.md regola #11)
- Embedding worker: concurrency=2, limiter 20/sec
- Tavily: 500 req/giorno (free tier)
- Gemini chat: 1500 RPM (Google standard)
- Gemini embedding: 1500 RPM (separato dal chat)

### Quando scalare orizzontalmente
- API > 80% CPU sostenuto: serve secondo container BullMQ Pro per non duplicare worker embedding (vedi memoria `regola_11`).
- Embedding queue depth > 50_000: aumenta `concurrency` nel worker O migra a BullMQ Pro per scaling distribuito.
- DB CPU > 70%: aggiungi indici (T2.5 ne ha già 4 chiave) o read replicas.

### Costi proiettati (Beta 1k utenti)
- Gemini chat: ~150 query/utente/mese × 1k × 5k token = 750M token/mese ≈ $30/mese
- Gemini embedding: ~3 chunk/guida × 1k guide nuove/mese × 768 dim = 2.3M token ≈ $0.05/mese
- Tavily: 500 req/giorno = ~15k/mese (free tier)
- Postgres + Redis: VPS standard ~$20/mese

**Total: ~$50/mese per 1k utenti Beta.**

---

## 8. Procedura deploy production

1. Verifica `EXECUTION_TRACKER.md` — tutti gli sprint completati.
2. Test full: `cd backend && npm test` — deve essere VERDE.
3. Type check: `npx tsc --noEmit` — clean (escluso debito test legacy).
4. Build: `npm run build` — verifica `dist/` produced.
5. Tag git: `git tag v0.beta.X && git push origin v0.beta.X`.
6. Deploy via `docker-compose.yml` (NO override dev) sul server prod.
7. Apply migrations: `docker exec platinatore-api npm run migrate`.
8. Smoke test: `curl https://api.iltuosito.com/health`.
9. Monitor logs primi 30 min: `docker compose logs -f api`.

---

## 9. Contatti & escalation

- **Lead Dev**: <user> — `angiuloleandro@gmail.com`
- **Repository**: [DocAllfix/ilplatinatore-AI](https://github.com/DocAllfix/ilplatinatore-AI)
- **Knowledge graph**: [DocAllfix/platinatore-graph](https://github.com/DocAllfix/platinatore-graph) (Obsidian)
- **Memoria assistente**: `~/.claude/projects/c--Users-user-PlatinatoreAI/memory/`

In caso di outage:
1. Tail dei log + screenshot
2. `docker compose ps` per stato container
3. Apri issue su GitHub con label `outage`

---

**Last updated**: 2026-04-30 (Sprint 4 completion).
