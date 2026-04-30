# Il Platinatore AI — Architecture Map

Mappa concept → implementazione. Questo documento esiste per chiudere il gap di
graphify tra **concept_*** nodes (estratti dai README) e i **file/funzioni concrete**
che li realizzano nel codice.

Ogni sezione segue il pattern:
> **Concept**: descrizione breve.
> *Implementato in*: `path/to/file.ts:funzione`, `path/to/altro.ts:metodo`.

---

## Pipeline RAG e generazione guide

### `RAG hybrid pipeline (HNSW + RRF)`
Pipeline ibrida: vector search HNSW + keyword search BM25 fusi via Reciprocal Rank Fusion.
*Implementato in*: [`backend/src/services/rag.service.ts`](backend/src/services/rag.service.ts), [`backend/src/services/rag.fusion.ts`](backend/src/services/rag.fusion.ts), [`backend/src/services/rag.specialized.ts`](backend/src/services/rag.specialized.ts).

### `SSE streaming chat UX (chunked bubble)`
Risposta LLM in streaming via Server-Sent Events; il client mostra la bubble crescere.
*Implementato in*: [`backend/src/services/orchestrator.stream.ts`](backend/src/services/orchestrator.stream.ts) → `handleGuideStream`, route GET in [`backend/src/routes/guide.routes.ts`](backend/src/routes/guide.routes.ts).

### `SSE Dual Response (cache HIT JSON / MISS SSE)`
La rotta unica risponde JSON quando c'è cache hit (immediato), SSE altrimenti.
*Implementato in*: [`backend/src/services/orchestrator.service.ts`](backend/src/services/orchestrator.service.ts) STEP 1 cache check, [`backend/src/services/orchestrator.stream.ts`](backend/src/services/orchestrator.stream.ts).

### `GuideType taxonomy (5 fissi — migration 004)`
Cinque tipi: trophy, walkthrough, collectible, challenge, platinum. Schema CHECK in DB.
*Implementato in*: [`backend/migrations/004_*.sql`](backend/migrations) (CHECK constraint), [`backend/src/services/prompt.builder.ts`](backend/src/services/prompt.builder.ts) (`BUILDERS` dispatch).

### `PSN anchor anti-hallucination pattern`
Quando il trofeo ha `psn_trophy_id`, il prompt include il nome ufficiale PSN come anchor.
*Implementato in*: [`backend/src/services/orchestrator.shared.ts:buildPromptContext`](backend/src/services/orchestrator.shared.ts) (campi `psnAnchor` + `psnOfficial`), [`backend/src/services/prompt.builder.ts:formatPsnAnchor`](backend/src/services/prompt.builder.ts).

### `Prompt injection sanitization defense`
User query sanitizzata (HTML strip, newline normalize, pattern injection) prima del prompt.
*Implementato in*: [`backend/src/services/prompt.builder.ts:sanitizeUserQuery`](backend/src/services/prompt.builder.ts) (chiamato da `buildPrompt`).

### `DB canonically English (harvester rule)`
Tutto il knowledge base è in inglese; traduzione on-the-fly al chatbot output.
*Implementato in*: [`harvester/src/transformer/synthesizer.py:GuideSynthesizer`](harvester/src/transformer/synthesizer.py) (output sempre EN), [`backend/src/services/translation.service.ts`](backend/src/services/translation.service.ts) (`translateGuide` EN→user lang via Gemini).

### `Tavily daily request cap (Redis incr)`
Counter giornaliero in Redis per non superare 500 req/24h del free tier Tavily.
*Implementato in*: [`backend/src/services/scraper.client.ts:checkDailyLimit`](backend/src/services/scraper.client.ts).

---

## Auth e sicurezza (Fase 18)

### `JWT + CSRF + Refresh Token Pair`
Triade: access token JWT (15min, body), refresh token (httpOnly cookie 7d), CSRF token (header).
*Implementato in*: [`backend/src/services/auth.service.ts`](backend/src/services/auth.service.ts), [`backend/src/services/auth.csrf.ts`](backend/src/services/auth.csrf.ts), [`backend/src/routes/auth.routes.ts:setRefreshCookie`](backend/src/routes/auth.routes.ts).

### `Refresh token rotation + reuse detection`
Ad ogni `/refresh` viene emessa nuova famiglia; se vecchio refresh viene riutilizzato → revoca tutta la famiglia (token theft detection).
*Implementato in*: [`backend/src/services/auth.service.ts:refresh`](backend/src/services/auth.service.ts), tabella `refresh_token_families` (migration Fase 18).

### `Phase 18 — Auth (JWT+refresh family rotation)`
Vedi sopra. Suite test integration in [`backend/tests/integration/auth.service.test.ts`](backend/tests/integration/auth.service.test.ts).

### `IDOR Guard via WHERE user_id`
Ogni endpoint che opera su risorse user-owned filtra anche per `user_id` (no info leak su 404).
*Implementato in*: [`backend/src/models/userGameStats.model.ts:updateByIdAndUser`](backend/src/models/userGameStats.model.ts), [`backend/src/routes/auth.routes.ts:PATCH /me`](backend/src/routes/auth.routes.ts).

### `Redis Lua Sliding Window Rate Limit`
Sorted-set + script Lua atomico per finestra scorrevole. No race condition tra worker.
*Implementato in*: [`backend/src/middleware/rateLimiter.ts`](backend/src/middleware/rateLimiter.ts).

### `Zod Strict Schema Validation`
Tutti i body usano `z.object().strict()` per rifiutare campi extra (anti privilege-escalation).
*Esempi in*: [`backend/src/routes/auth.routes.ts:updateMeSchema`](backend/src/routes/auth.routes.ts), [`backend/src/routes/gameStats.routes.ts:createBodySchema`](backend/src/routes/gameStats.routes.ts).

---

## HITL Self-Learning RAG (Fase 23)

### `Phase 23 — HITL Self-Learning RAG`
Bot genera draft → admin revisiona/approva → ingest in `guides` + embedding queue.

### `Draft FSM (draft → revision → pending → approved → published)`
State machine con 7 stati: `draft, revision, pending_approval, approved, rejected, published, failed`.
*Implementato in*: [`backend/migrations/025_guide_drafts.sql`](backend/migrations/025_guide_drafts.sql) (CHECK constraint),
[`backend/src/services/draft.service.ts`](backend/src/services/draft.service.ts) (transizioni `reviseDraft`/`approveDraft`/`rejectDraft`),
[`backend/src/services/ingestion.service.ts`](backend/src/services/ingestion.service.ts) (`approved` → `published`),
[`backend/src/routes/draft.routes.ts`](backend/src/routes/draft.routes.ts).

### Admin endpoints HITL (Fase 24)
Dashboard admin: stats per stato, lista filtrata, paginazione corretta.
*Implementato in*: [`backend/src/routes/draft.routes.ts`](backend/src/routes/draft.routes.ts) (`GET /stats`, `GET /?status=X`, `GET /pending`),
[`backend/src/models/guideDrafts.model.ts:getStats`](backend/src/models/guideDrafts.model.ts) / `findByStatus` / `countByStatus`.

### Notifica admin via webhook (Fase 24)
Webhook generico HTTP POST (Slack/Discord/n8n compatibile) fire-and-forget con timeout 3s.
*Implementato in*: [`backend/src/services/notification.service.ts:notifyNewDraft`](backend/src/services/notification.service.ts),
hook in [`backend/src/services/draft.service.ts:createDraft`](backend/src/services/draft.service.ts) STEP 8.

---

## Frontend stub closure (Fase 21)

### `Phase 21.x — Avatar uploads + game stats`
Quattro endpoint che chiudono gli stub `frontend/src/api/stubs.js`.

### Avatar upload
Multer 2.x memoryStorage + magic bytes validation PNG/JPG/WEBP + cleanup file orfani.
*Implementato in*: [`backend/src/services/avatar.service.ts`](backend/src/services/avatar.service.ts) (`detectImageType`, `uploadAvatar`),
[`backend/src/routes/uploads.routes.ts`](backend/src/routes/uploads.routes.ts),
[`backend/migrations/026_users_avatar_url.sql`](backend/migrations/026_users_avatar_url.sql),
volume Docker `uploads_data` in `docker-compose.yml`.

### Game stats CRUD
Tabella `user_game_stats` con UNIQUE(user_id, game_id) + IDOR check.
*Implementato in*: [`backend/src/models/userGameStats.model.ts`](backend/src/models/userGameStats.model.ts) (`findByUser`, `upsert`, `updateByIdAndUser`),
[`backend/src/routes/gameStats.routes.ts`](backend/src/routes/gameStats.routes.ts),
[`backend/migrations/027_user_game_stats.sql`](backend/migrations/027_user_game_stats.sql).

### PATCH /api/auth/me + GET /api/guide-ratings
*Implementato in*: [`backend/src/models/users.model.ts:updateProfile`](backend/src/models/users.model.ts),
[`backend/src/models/ratings.model.ts:findByUser` / `countByUser`](backend/src/models/ratings.model.ts),
[`backend/src/routes/guideRatings.routes.ts`](backend/src/routes/guideRatings.routes.ts).

---

## Pattern trasversali

### `Idempotency via ON CONFLICT DO NOTHING`
Upsert sicuri lato app (no race condition su double-click frontend).
*Esempi*:
- [`backend/src/scripts/bulk-seed.ts:insertGuideOrSkip`](backend/src/scripts/bulk-seed.ts) (su `slug`)
- [`backend/src/models/userGameStats.model.ts:upsert`](backend/src/models/userGameStats.model.ts) (su `(user_id, game_id)`)
- [`backend/src/models/ratings.model.ts:createUserRating`](backend/src/models/ratings.model.ts) (su `(guide_id, user_id)`)

### `Fail-open pattern (degrade graceful)`
Servizi non-critical (cache, webhook, tracker, audit log) usano try/catch con `logger.warn` invece di throw.
*Esempi*:
- [`backend/src/services/notification.service.ts`](backend/src/services/notification.service.ts) (webhook timeout 3s)
- [`backend/src/services/orchestrator.shared.ts:logAndTrack`](backend/src/services/orchestrator.shared.ts) (query_log fail-open)
- [`backend/src/services/draft.service.ts:getConvHistory`](backend/src/services/draft.service.ts) (Redis fail → array vuoto)

### `PgBouncer Connection (port 6432)`
Tutta l'app si connette via PgBouncer in transaction-pool mode. Migrazioni via direct connection (5432).
*Implementato in*: [`backend/src/config/database.ts`](backend/src/config/database.ts) (DATABASE_URL → 6432),
[`backend/scripts/run-migrations.ts`](backend/scripts/run-migrations.ts) (POSTGRES_DIRECT_URL → 5432),
[`infra/docker/pgbouncer/`](infra/docker/pgbouncer).

### `Rating auto-promotion ≥3.5 avg & ≥3 votes`
Quando una guida raggiunge avg≥3.5 con ≥3 voti viene promossa a `verified`.
*Implementato in*: [`backend/src/services/rating.service.ts:submitRating`](backend/src/services/rating.service.ts) (controllo post-vote).

### `300-line cap rule (CLAUDE.md)`
Regola di progetto: nessun file >300 righe. Splittare in moduli quando supera.
*Riferimento*: [`CLAUDE.md`](CLAUDE.md).

---

## Repository correlati

- **Codice**: [DocAllfix/ilplatinatore-AI](https://github.com/DocAllfix/ilplatinatore-AI) (questo repo)
- **Knowledge graph**: [DocAllfix/platinatore-graph](https://github.com/DocAllfix/platinatore-graph) (Obsidian vault auto-generato da `/graphify`)
