# EXECUTION_TRACKER — Pre-Beta Audit Implementation

**Source audit**: Pre-Beta Deep Audit & Execution Roadmap (sessione 2026-04-30)
**Owner**: Claude Code (autonomous execution)
**Started**: 2026-04-30

---

## Sprint 1 — P0 Blockers (BLOCCANTI per Beta)

| ID | Task | Status | Files modificati | NPM deps |
|----|------|--------|------------------|----------|
| T1.1 | detectLanguage → franc-min (9 lingue) | ⏳ | `query.normalizer.ts` + test | `franc-min` |
| T1.2 | Migration 028 (lang default 'en', embeddings.language, embedding_model, chunk_hash) | ⏳ | `migrations/028_*.sql` + `embeddings.model.ts` | — |
| T1.3 | Migration 029 (search_vector ts_config per-row + trigger) | ⏳ | `migrations/029_*.sql` + `rag.service.ts` | — |
| T1.4 | prompt.builder.ts i18n (HEADERS_I18N) | ⏳ | `prompt.builder.ts` + `orchestrator.shared.ts` + test | — |
| T1.5 | Fix race enqueueLiveEmbedding su state=active | ⏳ | `embedding.queue.ts` | — |
| T1.6 | Embedding chunk_hash idempotency | ⏳ | `embedding.service.ts` + `embeddings.model.ts` | — |
| T1.7 | statement_timeout 5s | ⏳ | `rag.service.ts` | — |

**Pacchetti npm necessari**: `franc-min` (~100KB, supporta 82 lingue, zero dep nativi).

---

## Sprint 2 — P1 Hardening + Multilingua test ✅ COMPLETATO

| ID | Task | Status |
|----|------|--------|
| T2.1 | Suite E2E multilingua (9 lingue × 5 guide_type = 45 test) | ✅ |
| T2.2 | Fix scraper.client incrementDailyCount post-success + cache empty TTL ridotto | ✅ |
| T2.3 | Cron cleanup `query_log` > 90d via node-cron (02:30 Europe/Rome) | ✅ |
| T2.4 | Cron cleanup `guide_drafts` rejected/failed > 30d (02:45 Europe/Rome) | ✅ |
| T2.5 | Migration 030 — idx_query_log_user_date, idx_drafts_user_status, idx_drafts_search_metadata_gin | ✅ |
| T2.6 | Rate limit per-tier `tierRateLimiter()`: free=5, reg=10, pro=30, platinum=∞ | ✅ |
| T2.7 | HNSW retune skipped — dataset <50k embeddings (eseguibile in futuro se serve) | ⏭️ |

---

## Sprint 3 — Killer Features ✅ COMPLETATO

| ID | Task | Status |
|----|------|--------|
| T3.1 | KF-1 Conversational Memory (Redis 1h TTL, max 5 turn, cross-game reset) | ✅ |
| T3.2 | KF-3 Game Disambiguation (SSE event + chip selectable + explicitGameId bypass) | ✅ |
| T3.3 | KF-2 Inline citations [N] (prompt rule + sources enriched) | ✅ |
| T3.4 | KF-5 SSE 3-phase streaming (understanding/searching/writing) | ✅ |
| T3.5 | KF-4 PSN cross-check post-processing (regex + batch DB lookup) | ✅ |

---

## Sprint 4 — Quality gate Pre-Beta

| ID | Task | Status |
|----|------|--------|
| T4.1 | KF-6 Auto-quality scoring + auto-route HITL se score<60 | ⏳ |
| T4.2 | Load test 100 utenti × 10 lingue × 30 min | ⏳ |
| T4.3 | Chaos test (kill Redis/Tavily/Gemini) | ⏳ |
| T4.4 | Audit security (prompt injection 50 payload + IDOR) | ⏳ |
| T4.5 | Runbook admin (monitoring, queue ops, migration rollback) | ⏳ |
| T4.6 | ARCHITECTURE.md update + sequenza pipeline | ⏳ |

---

## Definition of Done — Pre-Beta

- [ ] Tutti P0 chiusi
- [ ] Test branch coverage ≥ 90%, services lines ≥ 70%
- [ ] Test multilingua 9 lingue verde
- [ ] Load test p95 < 3s, error < 0.5%
- [ ] KF-1 + KF-3 produzione, altre KF ramp-up
- [ ] Runbook completo
- [ ] Migrations 028, 029 (030 cond.) applicate
- [ ] Beta gating via `feature.beta_access` flag

---

## Self-audit checklist per ogni fase

Prima di chiudere ogni task:
1. ✅ TypeScript compile (`npx tsc --noEmit`)
2. ✅ Test suite verde (`npx vitest run`)
3. ✅ Branch coverage ≥ 85% (vitest threshold)
4. ✅ Nessun `console.log` in production code
5. ✅ Nessun `any` non documentato
6. ✅ Logger.warn/error per tutti i fail-open
7. ✅ Memory updates dove applicable

---

**Status sintetico**: Sprint 1 in corso · 0/7 task completati
