import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";
import {
  applyRankingBoost,
  DEFAULT_BOOST,
  type ConfidenceLevel,
  type GuideSource,
  type RagResult,
  type RankingBoostConfig,
} from "@/services/rag.fusion.js";

/**
 * Retrieval specializzati trophy/topic-aware (Fase 13.3).
 * Complementari a RagService.search() generico: usano SQL mirato + boost,
 * senza embedding — più veloci e deterministici per i casi diretti.
 */

const DEFAULT_LIMIT = 5;

interface GuideRow {
  guide_id: number;
  title: string;
  slug: string;
  content: string;
  language: string;
  quality_score: string; // DECIMAL(3,2) — viene da pg come string
  verified: boolean;
  guide_type: string | null;
  confidence_level: ConfidenceLevel;
  source: GuideSource;
  trophy_id: number | null;
}

// Candidate columns shared between retrieveForTrophy e retrieveForTopic.
const GUIDE_RETRIEVAL_COLS = `
  g.id AS guide_id, g.title, g.slug, g.content,
  g.language, g.quality_score, g.verified, g.guide_type,
  g.confidence_level, g.source, g.trophy_id
`;

function rowToResult(
  row: GuideRow,
  retrievalSource: "trophy" | "topic",
): RagResult {
  // quality_score arriva come string da pg (DECIMAL). Normalizza a 0..1 come rrfScore
  // surrogate: i retrieval specializzati non hanno un vero rrfScore, usiamo quality
  // come seme; applyRankingBoost lo moltiplica poi per source/confidence factor.
  const quality = Number.parseFloat(row.quality_score) || 0;
  return {
    guideId: row.guide_id,
    title: row.title,
    slug: row.slug,
    content: row.content,
    language: row.language,
    qualityScore: quality,
    verified: row.verified,
    guideType: row.guide_type ?? "unknown",
    vectorScore: 0,
    ftsScore: 0,
    rrfScore: quality, // seme per il boost — unit scale coerente con quality_score
    matchType: "exact", // retrieval diretto su trophy/topic = match più forte possibile
    confidenceLevel: row.confidence_level,
    source: row.source,
    trophyId: row.trophy_id,
    retrievalSource,
  };
}

export interface RetrieveForTrophyParams {
  gameId: number;
  trophyId: number;
  language?: string;
  limit?: number;
  boost?: RankingBoostConfig;
}

/**
 * Fallback chain per retrieval trophy-aware:
 *   1. guides WHERE trophy_id = X AND language = <lang>
 *   2. guides WHERE trophy_id = X AND language = 'en'
 *   3. guides WHERE game_id = Y AND trophy_id IS NULL (generiche del gioco)
 * Applica boost source/confidence, poi top-N.
 */
export async function retrieveForTrophy(
  params: RetrieveForTrophyParams,
): Promise<RagResult[]> {
  const { gameId, trophyId, language = "en", limit = DEFAULT_LIMIT, boost = DEFAULT_BOOST } = params;
  const start = performance.now();

  try {
    // STEP 1 — match trophy + lingua richiesta.
    let rows = await runTrophyQuery(trophyId, language);
    let fallback: "lang" | "en" | "generic" = "lang";

    // STEP 2 — fallback lingua 'en' (migration 017 garantisce backfill name_en sempre).
    if (rows.length === 0 && language !== "en") {
      rows = await runTrophyQuery(trophyId, "en");
      fallback = "en";
    }

    // STEP 3 — fallback generiche del gioco (trophy_id NULL) se ancora vuoto.
    if (rows.length === 0) {
      const res = await query<GuideRow>(
        `-- Ultimo fallback: guide generiche dello stesso gioco (niente trofeo specifico).
         SELECT ${GUIDE_RETRIEVAL_COLS}
         FROM guides g
         WHERE g.game_id = $1 AND g.trophy_id IS NULL
         ORDER BY g.quality_score DESC, g.updated_at DESC
         LIMIT $2`,
        [gameId, limit * 2],
      );
      rows = res.rows;
      fallback = "generic";
    }

    const results = rows.map((r) => rowToResult(r, "trophy"));
    const boosted = applyRankingBoost(results, boost);
    const top = boosted.slice(0, limit);

    logger.info(
      {
        gameId,
        trophyId,
        language,
        fallback,
        candidates: rows.length,
        returned: top.length,
        totalMs: Math.round(performance.now() - start),
      },
      "retrieveForTrophy completata",
    );
    return top;
  } catch (err) {
    logger.error({ err, gameId, trophyId, language }, "retrieveForTrophy failed");
    throw err;
  }
}

async function runTrophyQuery(trophyId: number, language: string): Promise<GuideRow[]> {
  const res = await query<GuideRow>(
    `-- Match guide per trophy_id + lingua. Ordinato per quality + freschezza;
     -- il boost source/confidence viene applicato dopo in applyRankingBoost.
     SELECT ${GUIDE_RETRIEVAL_COLS}
     FROM guides g
     WHERE g.trophy_id = $1 AND g.language = $2
     ORDER BY g.quality_score DESC, g.updated_at DESC`,
    [trophyId, language],
  );
  return res.rows;
}

export interface RetrieveForTopicParams {
  gameId: number;
  topic: string;
  guideType?: string;
  language?: string;
  limit?: number;
  boost?: RankingBoostConfig;
}

/**
 * Retrieval per topic (boss, lore, build, collectible, etc.).
 * Filtra su indice composto idx_guides_game_type_topic (migration 024) + fallback lingua.
 * guideType opzionale: se assente ritorna tutti i tipi per quel topic/gioco.
 */
export async function retrieveForTopic(
  params: RetrieveForTopicParams,
): Promise<RagResult[]> {
  const {
    gameId, topic, guideType, language = "en",
    limit = DEFAULT_LIMIT, boost = DEFAULT_BOOST,
  } = params;
  const start = performance.now();

  try {
    // STEP 1 — match topic + guideType opzionale + lingua richiesta.
    let rows = await runTopicQuery(gameId, topic, guideType, language);
    let fallback: "lang" | "en" = "lang";

    // STEP 2 — fallback lingua 'en'.
    if (rows.length === 0 && language !== "en") {
      rows = await runTopicQuery(gameId, topic, guideType, "en");
      fallback = "en";
    }

    const results = rows.slice(0, limit * 2).map((r) => rowToResult(r, "topic"));
    const boosted = applyRankingBoost(results, boost);
    const top = boosted.slice(0, limit);

    logger.info(
      {
        gameId,
        topic,
        guideType,
        language,
        fallback,
        candidates: rows.length,
        returned: top.length,
        totalMs: Math.round(performance.now() - start),
      },
      "retrieveForTopic completata",
    );
    return top;
  } catch (err) {
    logger.error({ err, gameId, topic, guideType, language }, "retrieveForTopic failed");
    throw err;
  }
}

async function runTopicQuery(
  gameId: number,
  topic: string,
  guideType: string | undefined,
  language: string,
): Promise<GuideRow[]> {
  // guideType nullable → $3 IS NULL bypassa il filtro tipo.
  const res = await query<GuideRow>(
    `-- Match guide per topic + tipo opzionale + lingua. Sfrutta idx_guides_game_type_topic
     -- (migration 024) per il caso tipico game_id + guide_type + topic.
     SELECT ${GUIDE_RETRIEVAL_COLS}
     FROM guides g
     WHERE g.game_id = $1
       AND g.topic = $2
       AND ($3::text IS NULL OR g.guide_type = $3)
       AND g.language = $4
     ORDER BY g.quality_score DESC, g.updated_at DESC`,
    [gameId, topic, guideType ?? null, language],
  );
  return res.rows;
}
