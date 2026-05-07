import { RagService, type RagResult } from "@/services/rag.service.js";
import { assembleContext } from "@/services/rag.fusion.js";
import { fetchScrapedContext, fetchDirectUrl } from "@/services/scraper.client.js";
import { OnDemandHarvestService } from "@/services/onDemandHarvest.service.js";
import { GuidesModel } from "@/models/guides.model.js";
import { GameGuideLinksModel } from "@/models/gameGuideLinks.model.js";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";
import type { NormalizedQuery } from "@/services/query.normalizer.js";
import type { CachedGuide } from "@/services/guide.cache.js";

/**
 * Modulo estratto dall'orchestrator per mantenere il file principale sotto
 * 300 righe (CLAUDE.md §Codice). Ospita la logica di dispatch retrieval:
 *   trophy → retrieveForTrophy
 *   topic  → retrieveForTopic
 *   else   → RagService.search
 * Più il fallback scraping quando RAG ritorna contesto vuoto.
 */

export interface RetrievalBundle {
  results: RagResult[];
  sourceUsed: "rag" | "scraping" | "none";
  ragContext: string;
  scrapingContext: string;
  sources: CachedGuide["sources"];
}

function bundleFromResults(results: RagResult[]): RetrievalBundle {
  const context = assembleContext(results);
  // T3.3 — KF-2 Inline citations: enriched sources con index 1-based,
  // reliability derivata da verified+qualityScore, vectorScore per UI hover.
  const sources = results.slice(0, 5).map((r, i) => ({
    index: i + 1, // 1-based per matching prompt "[1]", "[2]", ...
    guideId: r.guideId,
    title: r.title,
    reliability: r.verified ? 0.95 : Math.max(0.4, r.qualityScore),
    verified: r.verified,
    vectorScore: r.vectorScore,
  }));
  return {
    results,
    sourceUsed: context.trim().length > 0 ? "rag" : "none",
    ragContext: context,
    scrapingContext: "",
    sources,
  };
}

/**
 * Dispatch principale: sceglie il retriever più specifico disponibile.
 * Niente gameId → RAG generico (FTS-only utile); con gameId prova trophy → topic → RAG.
 */
export async function retrieveContext(
  norm: NormalizedQuery,
): Promise<RetrievalBundle> {
  const gameId = norm.game?.id;
  if (gameId === undefined) {
    const results = await RagService.search(norm.rawQuery, { language: norm.language });
    return bundleFromResults(results);
  }

  if (norm.trophy) {
    const results = await RagService.retrieveForTrophy({
      gameId,
      trophyId: norm.trophy.id,
      language: norm.language,
    });
    return bundleFromResults(results);
  }

  if (norm.topic) {
    const results = await RagService.retrieveForTopic({
      gameId,
      topic: norm.topic,
      guideType: norm.guideType,
      language: norm.language,
    });
    return bundleFromResults(results);
  }

  const results = await RagService.search(norm.rawQuery, {
    gameId,
    language: norm.language,
  });
  return bundleFromResults(results);
}

/**
 * Fallback scraping con cascade a 3 livelli:
 *   1. RAG presente → ritorna subito (nessun fetch necessario)
 *   2. game_guide_links ha link per il gioco → fetcha i primi 2 URL in parallelo.
 *      Se almeno 1 ritorna contenuto reale → usa quello (zero quota Tavily consumata).
 *   3. Nessun link salvato o tutti i fetch falliti → Tavily generico (fallback invariato).
 */
export async function enrichWithScraping(
  bundle: RetrievalBundle,
  gameTitle: string,
  query: string,
  gameId?: number,
  guideType?: string,
): Promise<RetrievalBundle> {
  if (bundle.ragContext.trim().length > 0) return bundle;

  // Livello 2: link pre-verificati in game_guide_links
  if (gameId !== undefined) {
    const savedLinks = await GameGuideLinksModel.findByGame(gameId, guideType);
    if (savedLinks.length > 0) {
      const topLinks = savedLinks.slice(0, 2);
      const fetched = await Promise.all(
        topLinks.map((link) => fetchDirectUrl(link.url).then((text) => ({ link, text }))),
      );
      const valid = fetched.filter((f) => f.text !== null && f.text.length >= 300);
      if (valid.length > 0) {
        const contextParts = valid.map((f, i) =>
          `--- FONTE ${i + 1}: ${f.link.url} ---\n${f.text!.trim()}`,
        );
        const context = contextParts.join("\n\n");
        logger.info(
          { gameId, guideType, links: valid.map((f) => f.link.url) },
          "enrichWithScraping: usati link pre-verificati da game_guide_links",
        );
        return {
          ...bundle,
          sourceUsed: "scraping",
          scrapingContext: context,
          sources: valid.map((f, i) => ({
            index: i + 1,
            url: f.link.url,
            domain: f.link.domain,
            reliability: f.link.reliability,
          })),
        };
      }
      logger.debug(
        { gameId, links: topLinks.map((l) => l.url) },
        "enrichWithScraping: link salvati non raggiungibili, fallback Tavily",
      );
    }
  }

  // Livello 3: Tavily generico
  const scraped = await fetchScrapedContext(gameTitle, query);
  if (scraped.context.trim().length === 0) return bundle;
  return {
    ...bundle,
    sourceUsed: "scraping",
    scrapingContext: scraped.context,
    // T3.3 — anche scraping sources includono index e reliability (dal client).
    sources: scraped.sources.map((s, i) => ({
      index: i + 1,
      url: s.url,
      domain: s.domain,
      reliability: s.reliability,
    })),
  };
}

export interface OnDemandHarvestEvent {
  phase: "started" | "completed" | "timeout" | "failed";
  requestId: number;
  guideId?: number;
  message?: string;
}

/**
 * Fase 25 — On-Demand Live Harvesting fallback (FEATURE-FLAGGED).
 *
 * Pre-condizioni per attivarsi:
 *   1. `env.ON_DEMAND_HARVEST_ENABLED === true`
 *   2. bundle.sourceUsed === 'none' (RAG vuoto E scraping vuoto)
 *
 * Se attivato:
 *   - Inserisce richiesta pending in `on_demand_requests`
 *   - Yield evento 'started' al caller (per SSE)
 *   - Polla DB con backoff finché completed/failed/timeout
 *   - Se completed: fetch guide e arricchisce bundle con context vero
 *   - Se non completed: bundle invariato + evento timeout/failed
 *
 * Il caller (stream.ts) usa questa funzione come AsyncGenerator per intercalare
 * eventi SSE durante il polling.
 */
export async function* enrichWithOnDemandHarvest(
  bundle: RetrievalBundle,
  query: string,
  userId: number | null,
  gameId: number | null = null,
): AsyncGenerator<OnDemandHarvestEvent, RetrievalBundle, void> {
  if (!env.ON_DEMAND_HARVEST_ENABLED) return bundle;
  if (bundle.sourceUsed !== "none") return bundle;
  if (!query.trim()) return bundle;

  let requestId: number;
  try {
    requestId = await OnDemandHarvestService.triggerHarvest(query, userId, gameId);
  } catch (err) {
    logger.warn({ err }, "on-demand: triggerHarvest fallito, skip");
    return bundle;
  }
  yield { phase: "started", requestId };

  let result: Awaited<ReturnType<typeof OnDemandHarvestService.pollRequest>>;
  try {
    result = await OnDemandHarvestService.pollRequest(requestId);
  } catch (err) {
    logger.warn({ err, requestId }, "on-demand: pollRequest fallito");
    yield { phase: "failed", requestId, message: "polling error" };
    return bundle;
  }

  if (result.status === "completed" && result.guideId) {
    try {
      const guide = await GuidesModel.findById(result.guideId);
      if (guide && guide.content) {
        const enriched: RetrievalBundle = {
          ...bundle,
          sourceUsed: "rag",
          ragContext: assembleContext([
            {
              guideId: guide.id,
              title: guide.title,
              slug: guide.slug,
              chunkText: guide.content,
              vectorScore: 0.9,
              ftsScore: 0,
              rrfScore: 0.9,
              matchType: "exact",
              qualityScore: guide.quality_score ?? 0.5,
              verified: guide.verified,
              language: guide.language,
              guideType: guide.guide_type ?? "trophy",
            } satisfies RagResult,
          ]),
          sources: [
            {
              index: 1,
              guideId: guide.id,
              title: guide.title,
              reliability: guide.verified ? 0.95 : 0.7,
              verified: guide.verified,
            },
          ],
        };
        yield { phase: "completed", requestId, guideId: result.guideId };
        return enriched;
      }
    } catch (err) {
      logger.warn({ err, guideId: result.guideId }, "on-demand: fetch guide fallito");
    }
  }

  const phase = result.status === "timeout" ? "timeout" : "failed";
  yield {
    phase,
    requestId,
    ...(result.errorMessage ? { message: result.errorMessage } : {}),
  };
  return bundle;
}
