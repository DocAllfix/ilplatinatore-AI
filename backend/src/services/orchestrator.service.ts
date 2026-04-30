import { logger } from "@/utils/logger.js";
import { normalizeQuery, type NormalizedQuery } from "@/services/query.normalizer.js";
import { GuideCache, type CachedGuide } from "@/services/guide.cache.js";
import { generateGuide } from "@/services/llm.service.js";
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
  type HandleGuideResult,
} from "@/services/orchestrator.shared.js";
import { createDraft } from "@/services/draft.service.js";
import { validatePsnTrophyIdsInContent } from "@/services/psn.validator.js";
import {
  getConversation,
  appendTurn,
  clearConversation,
} from "@/services/conversation.memory.js";

// T3.1 — Conversational identifier: privilegia userId (stabile across sessions),
// fallback a sessionId per anonymous. Non-empty richiesto altrimenti memory disabled.
function conversationId(params: HandleGuideParams): string | null {
  if (params.userId != null) return `user:${params.userId}`;
  if (params.sessionId) return `session:${params.sessionId}`;
  return null;
}

/**
 * Orchestratore Fase 16 — flusso 7-step, ogni step isolato in try/catch con
 * safe-default per non crashare mai la response. Il try/catch più esterno
 * è un cordon sanitaire finale.
 *   STEP 1 normalize · STEP 2 cache · STEP 3 retrieve · STEP 4 scraping-fallback
 *   STEP 5 LLM · STEP 6 translate · STEP 7 cache+log+tracker
 *
 * Stream (SSE) estratto in orchestrator.stream.ts per 300-line cap — qui
 * ri-esportato per preservare la superficie storica del modulo.
 */

export { handleGuideStream, type StreamEvent } from "@/services/orchestrator.stream.js";
export type { HandleGuideParams, HandleGuideResult } from "@/services/orchestrator.shared.js";

// ── Entry point non-streaming ──────────────────────────────────────────────
export async function handleGuideRequest(
  params: HandleGuideParams,
): Promise<HandleGuideResult> {
  const start = Date.now();
  // STEP 1 — normalize (soft-fail interno già nei sub-extractor)
  // T3.2 — explicitGameId bypassa extraction quando l'utente ha già scelto.
  let norm: NormalizedQuery;
  try {
    norm = await normalizeQuery(params.query, params.language, params.explicitGameId);
  } catch (err) {
    logger.error({ err }, "orchestrator STEP 1 (normalize): errore, uso fallback minimo");
    norm = {
      language: params.language ?? "en",
      game: null,
      trophy: null,
      topic: null,
      guideType: "walkthrough",
      rawQuery: params.query,
    };
  }
  logger.info(
    { query: params.query.slice(0, 80), gameId: norm.game?.id, trophyId: norm.trophy?.id, guideType: norm.guideType },
    "orchestrator STEP 1: normalized",
  );

  // STEP 2 — cache read (safe-default: null)
  const cacheKey = buildCacheKeyParams(norm);
  const cached = await GuideCache.get(cacheKey);
  if (cached) {
    const elapsedMs = Date.now() - start;
    void logAndTrack(params, norm, "cache", elapsedMs);
    // T3.1 — anche cache hit popola la memoria conversazionale.
    const convId = conversationId(params);
    if (convId) {
      void appendTurn(convId, "user", params.query, norm.game?.id ?? null);
      void appendTurn(convId, "assistant", cached.content, norm.game?.id ?? null);
    }
    return {
      content: cached.content, sources: cached.sources,
      meta: {
        cached: true, gameDetected: norm.game?.title ?? null,
        trophyDetected: norm.trophy?.name_en ?? null, guideType: norm.guideType,
        sourceUsed: "cache", language: norm.language, elapsedMs, templateId: cached.templateId,
      },
    };
  }

  // T3.1 — recupera turn precedenti PRIMA del LLM call. Cross-game contamination
  // → reset automatico della memoria (mai mescolare contesti di giochi diversi).
  const convId = conversationId(params);
  let previousTurns: Array<{ role: "user" | "assistant"; text: string }> | undefined;
  if (convId) {
    const conv = await getConversation(convId, norm.game?.id ?? null);
    if (conv.resetSuggested) {
      logger.info({ convId, gameId: norm.game?.id }, "orchestrator: cross-game reset memory");
      await clearConversation(convId);
    } else if (conv.previousTurns.length > 0) {
      previousTurns = conv.previousTurns.map((t) => ({ role: t.role, text: t.text }));
    }
  }

  // STEP 3 — retrieve (safe-default: bundle vuoto)
  let bundle: RetrievalBundle;
  try {
    bundle = await retrieveContext(norm);
  } catch (err) {
    logger.error({ err }, "orchestrator STEP 3 (retrieve): fallito, contesto vuoto");
    bundle = { results: [], sourceUsed: "none", ragContext: "", scrapingContext: "", sources: [] };
  }

  // STEP 4 — scraping fallback
  if (norm.game) {
    try {
      bundle = await enrichWithScraping(bundle, norm.game.title, params.query);
    } catch (err) {
      logger.warn({ err }, "orchestrator STEP 4 (scraping): fallito, continuo senza");
    }
  }

  // STEP 5 — LLM (circuit breaker già dentro llm.service)
  let llmContent = "";
  let templateId: string = norm.guideType;
  let model = "";
  let llmSucceeded = false;
  try {
    const r = await generateGuide(buildPromptContext(norm, bundle, params.query, previousTurns));
    llmContent = r.content;
    templateId = r.templateId;
    model = r.model;
    llmSucceeded = true;
  } catch (err) {
    logger.error({ err }, "orchestrator STEP 5 (LLM): fallito, ritorno messaggio di degradation");
    llmContent =
      "Il servizio di generazione è temporaneamente indisponibile. " +
      "Riprova tra qualche minuto. Se il problema persiste, segnala l'errore.";
  }

  // STEP 6 — translate skippato (T1.4): il prompt builder ora genera native-lang.
  // translateGuide resta disponibile in llm.service per emergency fallback ma
  // non viene più chiamato nel flow normale.
  const finalContent = llmContent;

  // STEP 6b — T3.5 PSN cross-check (anti-hallucination): estrae i psn_trophy_id
  // citati dal LLM e ne verifica l'esistenza in tabella trophies. Fail-open:
  // errore DB → unverifiedIds=[].
  let unverifiedPsnIds: string[] | undefined;
  if (llmSucceeded && finalContent) {
    try {
      const psnCheck = await validatePsnTrophyIdsInContent(finalContent);
      if (psnCheck.unverifiedIds.length > 0) {
        unverifiedPsnIds = psnCheck.unverifiedIds;
      }
    } catch (err) {
      logger.warn({ err }, "orchestrator STEP 6b (PSN cross-check): non-fatal");
    }
  }

  // STEP 7 — cache + log + tracker + memory (tutti non-fatal)
  const payload: CachedGuide = {
    content: finalContent, sources: bundle.sources,
    generatedAt: Date.now(), templateId, model,
  };
  try {
    await GuideCache.set(cacheKey, payload);
  } catch (err) {
    logger.warn({ err }, "orchestrator STEP 7 (cache.set): fallito (non-fatal)");
  }
  // T3.1 — salva il turn corrente in memory (fail-open dentro al service).
  if (convId && llmSucceeded) {
    void appendTurn(convId, "user", params.query, norm.game?.id ?? null);
    void appendTurn(convId, "assistant", finalContent, norm.game?.id ?? null);
  }
  const elapsedMs = Date.now() - start;
  void logAndTrack(params, norm, bundle.sourceUsed, elapsedMs);

  // STEP 8 — HITL: crea bozza per contenuto non-RAG (non-fatal)
  // Solo se LLM ha prodotto contenuto reale (non il messaggio di degradation).
  let draftId: string | undefined;
  if (bundle.sourceUsed !== "rag" && llmSucceeded) {
    try {
      const draftSources = bundle.sources
        .filter((s) => !!(s.url && s.domain))
        .map((s) => ({ url: s.url as string, domain: s.domain as string, reliability: 0.7 }));
      const draft = await createDraft({
        content: finalContent,
        sessionId: params.sessionId ?? null,
        userId: params.userId ?? null,
        gameId: norm.game?.id ?? null,
        trophyId: norm.trophy?.id ?? null,
        gameTitle: norm.game?.title ?? "unknown",
        targetName: norm.trophy?.name_en ?? norm.topic ?? params.query,
        guideType: norm.guideType,
        topic: norm.topic,
        language: norm.language,
        originalQuery: params.query,
        sources: draftSources,
      });
      draftId = draft.id;
      logger.info({ draftId, sourceUsed: bundle.sourceUsed }, "orchestrator STEP 8: bozza HITL creata");
    } catch (err) {
      logger.warn({ err }, "orchestrator STEP 8 (createDraft): non-fatal");
    }
  }

  return {
    content: finalContent, sources: bundle.sources,
    meta: {
      cached: false, gameDetected: norm.game?.title ?? null,
      trophyDetected: norm.trophy?.name_en ?? null, guideType: norm.guideType,
      sourceUsed: bundle.sourceUsed, language: norm.language, elapsedMs, templateId,
      ...(draftId !== undefined && { draftId, canRevise: true, canApprove: false }),
      ...(unverifiedPsnIds && { unverifiedPsnIds }),
      ...(norm.gameCandidates && { gameCandidates: norm.gameCandidates }),
    },
  };
}

/**
 * Solo cache check — usato dalla route /stream per switchare tra risposta
 * JSON (HIT) e SSE (MISS). Ritorna HandleGuideResult se HIT, altrimenti null.
 */
export async function tryCacheHit(
  params: HandleGuideParams,
): Promise<HandleGuideResult | null> {
  const start = Date.now();
  let norm: NormalizedQuery;
  try {
    norm = await normalizeQuery(params.query, params.language);
  } catch {
    return null;
  }
  const cached = await GuideCache.get(buildCacheKeyParams(norm));
  if (!cached) return null;
  const elapsedMs = Date.now() - start;
  void logAndTrack(params, norm, "cache", elapsedMs);
  return {
    content: cached.content, sources: cached.sources,
    meta: {
      cached: true, gameDetected: norm.game?.title ?? null,
      trophyDetected: norm.trophy?.name_en ?? null, guideType: norm.guideType,
      sourceUsed: "cache", language: norm.language, elapsedMs, templateId: cached.templateId,
    },
  };
}
