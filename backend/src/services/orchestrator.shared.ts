import { logger } from "@/utils/logger.js";
import {
  slugify,
  type CachedGuide,
  type GuideCacheKeyParams,
} from "@/services/guide.cache.js";
import type { NormalizedQuery } from "@/services/query.normalizer.js";
import type { RetrievalBundle } from "@/services/orchestrator.retrieval.js";
import type { PromptContext } from "@/services/prompt.builder.js";
import { QueryLogModel } from "@/models/queryLog.model.js";
import { GuideRequestTrackerModel } from "@/models/guideRequestTracker.model.js";

/**
 * Helper condivisi tra orchestrator.service (JSON) e orchestrator.stream (SSE).
 * Estratti per rispettare il 300-line cap di CLAUDE.md.
 */

// Il DB è canonicamente in inglese (harvester rule). Il LLM risponde in EN e
// traduciamo al volo se la lingua utente ≠ EN (translateGuide).
export const DB_CANONICAL_LANGUAGE = "en";

export interface HandleGuideParams {
  query: string;
  language?: string;
  userId?: number | null;
  sessionId?: string | null;
}

export interface HandleGuideResult {
  content: string;
  sources: CachedGuide["sources"];
  meta: {
    cached: boolean;
    gameDetected: string | null;
    trophyDetected: string | null;
    guideType: string;
    sourceUsed: "cache" | "rag" | "scraping" | "none";
    language: string;
    elapsedMs: number;
    templateId: string;
    // Presente solo quando è stata creata una bozza HITL (sourceUsed ≠ rag)
    draftId?: string;
    canRevise?: boolean;
    canApprove?: boolean;
  };
}

export function buildCacheKeyParams(norm: NormalizedQuery): GuideCacheKeyParams {
  return {
    gameSlug: norm.game?.slug ?? null,
    trophySlug: norm.trophy ? slugify(norm.trophy.name_en ?? norm.trophy.name_it ?? "") || null : null,
    topic: norm.topic,
    guideType: norm.guideType,
    language: norm.language,
  };
}

export function buildPromptContext(
  norm: NormalizedQuery,
  bundle: RetrievalBundle,
  query: string,
): PromptContext {
  return {
    ragContext: bundle.ragContext,
    scrapingContext: bundle.scrapingContext,
    gameTitle: norm.game?.title ?? "gioco non identificato",
    targetName: norm.trophy?.name_en ?? norm.topic ?? query,
    guideType: norm.guideType,
    language: DB_CANONICAL_LANGUAGE, // LLM risponde in EN → traduciamo a valle
    userQuery: query,
    ...(norm.trophy && {
      psnAnchor: {
        psn_trophy_id: norm.trophy.psn_trophy_id,
        psn_communication_id: norm.trophy.psn_communication_id,
        rarity_source: norm.trophy.rarity_source,
      },
    }),
    // psnOfficial emesso solo se name_en presente (migration 017:31 lo backfilla
    // da `name` per ogni riga pre-esistente → ~sempre valorizzato).
    // detail_en può essere null: il formatter emette solo la riga NOME in quel caso.
    ...(norm.trophy?.name_en && {
      psnOfficial: {
        officialName: norm.trophy.name_en,
        officialDetail: norm.trophy.detail_en,
      },
    }),
  };
}

/**
 * Loggato in query_log SEMPRE, nel tracker SOLO se trophy-centric.
 * UNIQUE(game_id, trophy_id) collassa i NULL — relax in Fase 17.
 */
export async function logAndTrack(
  params: HandleGuideParams,
  norm: NormalizedQuery,
  sourceUsed: "cache" | "rag" | "scraping" | "none",
  responseTimeMs: number,
): Promise<void> {
  try {
    await QueryLogModel.create({
      user_id: params.userId ?? null,
      session_id: params.sessionId ?? null,
      query_text: params.query,
      game_detected: norm.game?.title ?? null,
      trophy_detected: norm.trophy?.name_en ?? norm.trophy?.name_it ?? null,
      source_used: sourceUsed,
      response_time_ms: responseTimeMs,
      quality_score: null,
    });
  } catch (err) {
    logger.warn({ err }, "orchestrator: query_log insert fallita (non-fatal)");
  }
  if (norm.game && norm.trophy) {
    const trophySlug = slugify(norm.trophy.name_en ?? norm.trophy.name_it ?? "") || `id-${norm.trophy.id}`;
    await GuideRequestTrackerModel.upsertTrophyRequest({
      game_id: norm.game.id,
      trophy_id: norm.trophy.id,
      game_slug: norm.game.slug,
      trophy_slug: trophySlug,
    });
  }
}
