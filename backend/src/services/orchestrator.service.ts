import { logger } from "@/utils/logger.js";
import { normalizeQuery, type NormalizedQuery } from "@/services/query.normalizer.js";
import { GuideCache, type CachedGuide } from "@/services/guide.cache.js";
import { generateGuide, translateGuide } from "@/services/llm.service.js";
import {
  retrieveContext,
  enrichWithScraping,
  type RetrievalBundle,
} from "@/services/orchestrator.retrieval.js";
import {
  DB_CANONICAL_LANGUAGE,
  buildCacheKeyParams,
  buildPromptContext,
  logAndTrack,
  type HandleGuideParams,
  type HandleGuideResult,
} from "@/services/orchestrator.shared.js";

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
  let norm: NormalizedQuery;
  try {
    norm = await normalizeQuery(params.query, params.language);
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
    return {
      content: cached.content, sources: cached.sources,
      meta: {
        cached: true, gameDetected: norm.game?.title ?? null,
        trophyDetected: norm.trophy?.name_en ?? null, guideType: norm.guideType,
        sourceUsed: "cache", language: norm.language, elapsedMs, templateId: cached.templateId,
      },
    };
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
  try {
    const r = await generateGuide(buildPromptContext(norm, bundle, params.query));
    llmContent = r.content;
    templateId = r.templateId;
    model = r.model;
  } catch (err) {
    logger.error({ err }, "orchestrator STEP 5 (LLM): fallito, ritorno messaggio di degradation");
    llmContent =
      "Il servizio di generazione è temporaneamente indisponibile. " +
      "Riprova tra qualche minuto. Se il problema persiste, segnala l'errore.";
  }

  // STEP 6 — translate se lingua utente ≠ EN
  let finalContent = llmContent;
  if (norm.language !== DB_CANONICAL_LANGUAGE && llmContent) {
    try {
      finalContent = await translateGuide(llmContent, DB_CANONICAL_LANGUAGE, norm.language);
    } catch (err) {
      logger.warn({ err }, "orchestrator STEP 6 (translate): fallback testo originale");
      finalContent = llmContent;
    }
  }

  // STEP 7 — cache + log + tracker (tutti non-fatal)
  const payload: CachedGuide = {
    content: finalContent, sources: bundle.sources,
    generatedAt: Date.now(), templateId, model,
  };
  try {
    await GuideCache.set(cacheKey, payload);
  } catch (err) {
    logger.warn({ err }, "orchestrator STEP 7 (cache.set): fallito (non-fatal)");
  }
  const elapsedMs = Date.now() - start;
  void logAndTrack(params, norm, bundle.sourceUsed, elapsedMs);

  return {
    content: finalContent, sources: bundle.sources,
    meta: {
      cached: false, gameDetected: norm.game?.title ?? null,
      trophyDetected: norm.trophy?.name_en ?? null, guideType: norm.guideType,
      sourceUsed: bundle.sourceUsed, language: norm.language, elapsedMs, templateId,
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
