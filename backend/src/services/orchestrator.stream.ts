import { logger } from "@/utils/logger.js";
import { normalizeQuery } from "@/services/query.normalizer.js";
import { GuideCache, type CachedGuide } from "@/services/guide.cache.js";
import {
  generateGuideStream,
  translateGuide,
  type StreamChunk,
} from "@/services/llm.service.js";
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
} from "@/services/orchestrator.shared.js";

/**
 * Generator SSE estratto da orchestrator.service.ts per rispettare il
 * 300-line cap (CLAUDE.md §Codice). Stesso flusso 7-step del non-streaming,
 * ma emette eventi `meta` / `delta` / `done` / `error`.
 */

export interface StreamEvent {
  type: "meta" | "delta" | "done" | "error";
  data: unknown;
}

export async function* handleGuideStream(
  params: HandleGuideParams,
): AsyncGenerator<StreamEvent, void, void> {
  const start = Date.now();
  try {
    // STEP 1
    const norm = await normalizeQuery(params.query, params.language);
    const cacheKey = buildCacheKeyParams(norm);
    const baseMeta = {
      gameDetected: norm.game?.title ?? null,
      trophyDetected: norm.trophy?.name_en ?? null,
      guideType: norm.guideType,
      language: norm.language,
    };

    // Niente cache check qui: la route gestisce il dual-response prima di entrare nello stream.
    // STEP 3+4
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
    yield { type: "meta", data: { ...baseMeta, cached: false, sourceUsed: bundle.sourceUsed } };

    // STEP 5 stream
    const promptCtx = buildPromptContext(norm, bundle, params.query);
    const needsTranslation = norm.language !== DB_CANONICAL_LANGUAGE;
    let accumulated = "";
    let templateId: string = norm.guideType;
    let model = "";
    try {
      if (needsTranslation) {
        const iter: AsyncGenerator<StreamChunk, { templateId: string; model: string; elapsedMs: number }, void> =
          generateGuideStream(promptCtx);
        let next = await iter.next();
        while (!next.done) { accumulated += next.value.text; next = await iter.next(); }
        templateId = next.value.templateId; model = next.value.model;
        // STEP 6
        let translated = accumulated;
        try {
          translated = await translateGuide(accumulated, DB_CANONICAL_LANGUAGE, norm.language);
        } catch (err) {
          logger.warn({ err }, "stream STEP 6 (translate): fallback testo originale");
        }
        yield { type: "delta", data: { text: translated } };
        accumulated = translated;
      } else {
        const iter = generateGuideStream(promptCtx);
        let next = await iter.next();
        while (!next.done) {
          accumulated += next.value.text;
          yield { type: "delta", data: { text: next.value.text } };
          next = await iter.next();
        }
        templateId = next.value.templateId; model = next.value.model;
      }
    } catch (err) {
      logger.error({ err }, "stream STEP 5 (LLM): errore");
      yield { type: "error", data: { message: "Errore durante la generazione" } };
      return;
    }

    // STEP 7
    const payload: CachedGuide = {
      content: accumulated, sources: bundle.sources,
      generatedAt: Date.now(), templateId, model,
    };
    try {
      await GuideCache.set(cacheKey, payload);
    } catch (err) {
      logger.warn({ err }, "stream STEP 7 (cache.set): fallito");
    }
    const elapsedMs = Date.now() - start;
    void logAndTrack(params, norm, bundle.sourceUsed, elapsedMs);
    yield { type: "done", data: { elapsedMs, length: accumulated.length, templateId, model } };
  } catch (err) {
    logger.error({ err }, "orchestrator.stream: errore non recuperabile (cordon sanitaire)");
    yield { type: "error", data: { message: err instanceof Error ? err.message : "Errore interno" } };
  }
}
