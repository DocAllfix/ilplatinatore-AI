import { RagService, type RagResult } from "@/services/rag.service.js";
import { assembleContext } from "@/services/rag.fusion.js";
import { fetchScrapedContext } from "@/services/scraper.client.js";
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
 * Fallback scraping live: invocato SOLO se RAG è vuoto (ragContext.trim() === "").
 * In Fase 16 il client scraper è uno stub (scraper.client.ts) → ritorna no-op
 * finché non viene wired il transport HTTP verso il microservizio scraper.
 */
export async function enrichWithScraping(
  bundle: RetrievalBundle,
  gameTitle: string,
  query: string,
): Promise<RetrievalBundle> {
  if (bundle.ragContext.trim().length > 0) return bundle;
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
