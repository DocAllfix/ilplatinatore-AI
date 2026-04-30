import { logger } from "@/utils/logger.js";
import { normalizeQuery } from "@/services/query.normalizer.js";
import { GuideCache, type CachedGuide } from "@/services/guide.cache.js";
import { generateGuideStream } from "@/services/llm.service.js";
import {
  retrieveContext,
  enrichWithScraping,
  type RetrievalBundle,
} from "@/services/orchestrator.retrieval.js";
import {
  buildCacheKeyParams,
  buildPromptContext,
  logAndTrack,
  type HandleGuideParams,
} from "@/services/orchestrator.shared.js";
import { validatePsnTrophyIdsInContent } from "@/services/psn.validator.js";
import {
  getConversation,
  appendTurn,
  clearConversation,
} from "@/services/conversation.memory.js";

// T3.1 — Conversational identifier helper (mirror di orchestrator.service).
function conversationId(p: HandleGuideParams): string | null {
  if (p.userId != null) return `user:${p.userId}`;
  if (p.sessionId) return `session:${p.sessionId}`;
  return null;
}

/**
 * Generator SSE per il chatbot. Allineato a Sprint 1 (T1.4 i18n native, no più
 * translate) + Sprint 3 (T3.4 stage events + T3.5 PSN cross-check).
 *
 * Eventi emessi (in ordine tipico):
 *   1. stage(understanding) — dopo STEP 1 (normalize) — utente vede subito
 *      cosa il sistema ha "capito" (game/trophy/topic/lingua).
 *   2. stage(searching) — dopo STEP 3+4 (RAG + scraping) — utente vede le
 *      fonti che il sistema sta usando.
 *   3. meta — payload completo (cached:false + sourceUsed) prima dello stream.
 *   4. stage(writing) — segnale che il LLM stream sta per partire.
 *   5. delta × N — chunk di testo dal LLM in streaming.
 *   6. done — payload finale con elapsedMs, length, templateId, model,
 *      unverifiedPsnIds (T3.5).
 *   7. error — fallback per qualsiasi errore non recuperabile.
 */

export type StreamEventType =
  | "stage"
  | "disambiguation"
  | "meta"
  | "delta"
  | "done"
  | "error";

export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
}

export interface StagePayload {
  /** Fase corrente del processing — usato dal frontend per UX 3-phase. */
  phase: "understanding" | "searching" | "writing";
  /** Payload arbitrario specifico della fase. */
  detail?: Record<string, unknown>;
}

export async function* handleGuideStream(
  params: HandleGuideParams,
): AsyncGenerator<StreamEvent, void, void> {
  const start = Date.now();
  try {
    // ── STEP 1 — normalize ──────────────────────────────────────────────
    const norm = await normalizeQuery(params.query, params.language, params.explicitGameId);
    const cacheKey = buildCacheKeyParams(norm);

    // T3.1 — Conversational Memory: recupera turn precedenti, gestisce
    // cross-game contamination con reset automatico.
    const convId = conversationId(params);
    let previousTurns: Array<{ role: "user" | "assistant"; text: string }> | undefined;
    if (convId) {
      const conv = await getConversation(convId, norm.game?.id ?? null);
      if (conv.resetSuggested) {
        logger.info({ convId, gameId: norm.game?.id }, "stream: cross-game reset memory");
        await clearConversation(convId);
      } else if (conv.previousTurns.length > 0) {
        previousTurns = conv.previousTurns.map((t) => ({ role: t.role, text: t.text }));
      }
    }

    // T3.2 — KF-3 Game disambiguation: se 2+ giochi sono candidati ambigui,
    // emetti evento DEDICATO `disambiguation` PRIMA di proseguire. Il frontend
    // può scegliere se: (a) attendere la scelta utente prima di mostrare il
    // resto, oppure (b) mostrare comunque la guida del top1 e offrire chip
    // "intendevi questo invece?". L'orchestrator NON blocca: la guida viene
    // generata sul top1 — disambiguation è informativa.
    if (norm.gameCandidates && norm.gameCandidates.length > 0) {
      yield {
        type: "disambiguation",
        data: {
          chosen: norm.game ? { id: norm.game.id, title: norm.game.title, slug: norm.game.slug } : null,
          candidates: norm.gameCandidates,
        },
      };
    }
    const baseMeta = {
      gameDetected: norm.game?.title ?? null,
      trophyDetected: norm.trophy?.name_en ?? null,
      guideType: norm.guideType,
      language: norm.language,
    };

    // T3.4 — stage 1: "understanding" → l'utente vede cosa abbiamo capito.
    yield {
      type: "stage",
      data: {
        phase: "understanding",
        detail: {
          ...baseMeta,
          topic: norm.topic,
        },
      } satisfies StagePayload,
    };

    // ── STEP 3+4 — retrieval + scraping (parallelizzabile in futuro) ─────
    let bundle: RetrievalBundle;
    try {
      bundle = await retrieveContext(norm);
    } catch (err) {
      logger.error({ err }, "stream STEP 3 (retrieve): fallito");
      bundle = { results: [], sourceUsed: "none", ragContext: "", scrapingContext: "", sources: [] };
    }
    if (norm.game) {
      try {
        bundle = await enrichWithScraping(bundle, norm.game.title, params.query);
      } catch (err) {
        logger.warn({ err }, "stream STEP 4 (scraping): fallito");
      }
    }

    // T3.4 — stage 2: "searching" → l'utente vede le fonti consultate.
    yield {
      type: "stage",
      data: {
        phase: "searching",
        detail: {
          sourceUsed: bundle.sourceUsed,
          sourcesCount: bundle.sources.length,
          // Top 3 source URLs/domains (no body) per l'UI senza payload pesante.
          topSources: bundle.sources.slice(0, 3).map((s) => ({
            url: s.url ?? null,
            domain: s.domain ?? null,
            title: s.title ?? null,
          })),
        },
      } satisfies StagePayload,
    };

    yield {
      type: "meta",
      data: { ...baseMeta, cached: false, sourceUsed: bundle.sourceUsed },
    };

    // ── STEP 5 — LLM stream ─────────────────────────────────────────────
    const promptCtx = buildPromptContext(norm, bundle, params.query, previousTurns);
    let accumulated = "";
    let templateId: string = norm.guideType;
    let model = "";

    // T3.4 — stage 3: "writing" → segnale che il LLM sta producendo testo.
    yield {
      type: "stage",
      data: { phase: "writing", detail: { templateId } } satisfies StagePayload,
    };

    try {
      // T1.4 — il prompt builder genera native-lang: niente più translate
      // post-stream. Stream incrementale token-by-token sempre.
      const iter = generateGuideStream(promptCtx);
      let next = await iter.next();
      while (!next.done) {
        accumulated += next.value.text;
        yield { type: "delta", data: { text: next.value.text } };
        next = await iter.next();
      }
      templateId = next.value.templateId;
      model = next.value.model;
    } catch (err) {
      logger.error({ err }, "stream STEP 5 (LLM): errore");
      yield { type: "error", data: { message: "Errore durante la generazione" } };
      return;
    }

    // ── STEP 6b — T3.5 PSN cross-check (anti-hallucination) ─────────────
    let unverifiedPsnIds: string[] | undefined;
    if (accumulated) {
      try {
        const psnCheck = await validatePsnTrophyIdsInContent(accumulated);
        if (psnCheck.unverifiedIds.length > 0) {
          unverifiedPsnIds = psnCheck.unverifiedIds;
        }
      } catch (err) {
        logger.warn({ err }, "stream STEP 6b (PSN cross-check): non-fatal");
      }
    }

    // ── STEP 7 — cache + log + tracker (tutti non-fatal) ────────────────
    const payload: CachedGuide = {
      content: accumulated, sources: bundle.sources,
      generatedAt: Date.now(), templateId, model,
    };
    try {
      await GuideCache.set(cacheKey, payload);
    } catch (err) {
      logger.warn({ err }, "stream STEP 7 (cache.set): fallito");
    }
    // T3.1 — salva turn corrente nella memoria conversazionale.
    if (convId && accumulated) {
      void appendTurn(convId, "user", params.query, norm.game?.id ?? null);
      void appendTurn(convId, "assistant", accumulated, norm.game?.id ?? null);
    }
    const elapsedMs = Date.now() - start;
    void logAndTrack(params, norm, bundle.sourceUsed, elapsedMs);

    yield {
      type: "done",
      data: {
        elapsedMs,
        length: accumulated.length,
        templateId,
        model,
        ...(unverifiedPsnIds && { unverifiedPsnIds }),
      },
    };
  } catch (err) {
    logger.error({ err }, "orchestrator.stream: errore non recuperabile (cordon sanitaire)");
    yield { type: "error", data: { message: err instanceof Error ? err.message : "Errore interno" } };
  }
}
