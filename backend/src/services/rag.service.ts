import { getClient } from "@/config/database.js";
import { logger } from "@/utils/logger.js";
import { EmbeddingService } from "@/services/embedding.service.js";
import { SystemConfigModel } from "@/models/systemConfig.model.js";
import {
  reciprocalRankFusion,
  classifyMatch,
  assembleContext,
  applyRankingBoost,
  DEFAULT_BOOST,
  type RagResult,
} from "@/services/rag.fusion.js";
import {
  retrieveForTrophy,
  retrieveForTopic,
} from "@/services/rag.specialized.js";

export type {
  MatchType,
  RagResult,
  ConfidenceLevel,
  GuideSource,
  RetrievalSource,
  RankingBoostConfig,
} from "@/services/rag.fusion.js";
export type {
  RetrieveForTrophyParams,
  RetrieveForTopicParams,
} from "@/services/rag.specialized.js";
export {
  reciprocalRankFusion,
  classifyMatch,
  assembleContext,
  applyRankingBoost,
  DEFAULT_BOOST,
};

export interface RagSearchOptions {
  gameId?: number;
  language?: string;
  limit?: number;
}

interface VectorHit {
  guide_id: number;
  chunk_text: string;
  chunk_index: number;
  title: string;
  slug: string;
  language: string;
  quality_score: number;
  verified: boolean;
  guide_type: string | null;
  vector_score: number;
}

interface FtsHit {
  guide_id: number;
  title: string;
  slug: string;
  content: string;
  language: string;
  quality_score: number;
  verified: boolean;
  guide_type: string | null;
  fts_score: number;
}

interface Thresholds {
  high: number;
  low: number;
  maxResults: number;
}

const THRESHOLDS_TTL_MS = 5 * 60 * 1000; // 5 min — prompt esplicito
const DEFAULT_THRESHOLD_HIGH = 0.85;
const DEFAULT_THRESHOLD_LOW = 0.6;
const DEFAULT_MAX_RESULTS = 5;
const VECTOR_SEARCH_LIMIT = 10;
const FTS_SEARCH_LIMIT = 10;

let thresholdsCache: { value: Thresholds; at: number } | null = null;

async function getThresholds(): Promise<Thresholds> {
  const now = Date.now();
  if (thresholdsCache && now - thresholdsCache.at < THRESHOLDS_TTL_MS) {
    return thresholdsCache.value;
  }
  try {
    const [highRaw, lowRaw, maxRaw] = await Promise.all([
      SystemConfigModel.get("rag_threshold_high"),
      SystemConfigModel.get("rag_threshold_low"),
      SystemConfigModel.get("rag_max_results"),
    ]);
    const value: Thresholds = {
      high: highRaw !== null ? Number.parseFloat(highRaw) : DEFAULT_THRESHOLD_HIGH,
      low: lowRaw !== null ? Number.parseFloat(lowRaw) : DEFAULT_THRESHOLD_LOW,
      maxResults: maxRaw !== null ? Number.parseInt(maxRaw, 10) : DEFAULT_MAX_RESULTS,
    };
    if (!Number.isFinite(value.high)) value.high = DEFAULT_THRESHOLD_HIGH;
    if (!Number.isFinite(value.low)) value.low = DEFAULT_THRESHOLD_LOW;
    if (!Number.isInteger(value.maxResults) || value.maxResults <= 0) {
      value.maxResults = DEFAULT_MAX_RESULTS;
    }
    thresholdsCache = { value, at: now };
    return value;
  } catch (err) {
    logger.error({ err }, "RagService: lettura soglie da system_config fallita, uso default");
    const fallback: Thresholds = {
      high: DEFAULT_THRESHOLD_HIGH,
      low: DEFAULT_THRESHOLD_LOW,
      maxResults: DEFAULT_MAX_RESULTS,
    };
    thresholdsCache = { value: fallback, at: now };
    return fallback;
  }
}

// Mappa ISO-639-1 → regconfig PostgreSQL. Speculare al trigger SQL in
// migration 029 — se aggiungi una lingua, aggiorna entrambi.
function langToTsConfig(lang: string | undefined): string {
  switch (lang) {
    case "it": return "italian";
    case "en": return "english";
    case "es": return "spanish";
    case "fr": return "french";
    case "de": return "german";
    case "pt": return "portuguese";
    case "ru": return "russian";
    default:   return "simple"; // ja, zh, e ogni altra lingua
  }
}

// T1.7 — statement_timeout 5s scoped alla transazione (PgBouncer-safe).
const STATEMENT_TIMEOUT = "5s";

async function runVectorSearch(
  queryEmbedding: number[],
  gameId: number | undefined,
  language: string | undefined,
  thresholdLow: number,
): Promise<VectorHit[]> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    // AUDIT FIX (W2): ef_search=200 per recall >98% sul retrieval RAG critico.
    // SET LOCAL è scoped alla transazione → safe con PgBouncer transaction pooling.
    await client.query("SET LOCAL hnsw.ef_search = 200");
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    const vectorStr = `[${queryEmbedding.join(",")}]`;
    // T1.2 — filtro per language su guide_embeddings (denormalizzato) +
    // su guides (per coerenza). Un embedding multilingua matcherebbe semanti-
    // camente cross-language, ma vogliamo coerenza linguistica nel RAG.
    const res = await client.query<VectorHit>(
      `-- Top-N chunk per similarità coseno via indice HNSW su guide_embeddings.
       -- 1 - (a <=> b) = cosine similarity in [0,1]; filtro soglia low per scartare rumore.
       -- Filtro language: ge.language usato per filtro selettivo PRIMA dell'HNSW.
       SELECT ge.guide_id, ge.chunk_text, ge.chunk_index,
              g.title, g.slug, g.language, g.quality_score, g.verified, g.guide_type,
              1 - (ge.embedding <=> $1::vector) AS vector_score
       FROM guide_embeddings ge
       JOIN guides g ON g.id = ge.guide_id
       WHERE ($2::int IS NULL OR g.game_id = $2)
         AND ($3::text IS NULL OR ge.language = $3)
         AND 1 - (ge.embedding <=> $1::vector) > $4
       ORDER BY vector_score DESC
       LIMIT $5`,
      [vectorStr, gameId ?? null, language ?? null, thresholdLow, VECTOR_SEARCH_LIMIT],
    );
    await client.query("COMMIT");
    return res.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    logger.error({ err }, "RagService: vector search fallita, fallback a solo FTS");
    return [];
  } finally {
    client.release();
  }
}

async function runFtsSearch(
  queryText: string,
  gameId: number | undefined,
  language: string | undefined,
): Promise<FtsHit[]> {
  try {
    const client = await getClient();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      // T1.3 — FTS multilingua: usa g.ts_config (per riga) per parsare la query
      // con lo stesso config con cui è stato generato il search_vector.
      // Fallback a 'simple' (no stemming) se language non riconosciuto.
      const res = await client.query<FtsHit>(
        `-- FTS su search_vector (popolato da trigger con ts_config per riga).
         -- plainto_tsquery normalizza l'input senza rischi di sintassi ts_query.
         -- Usa g.ts_config per ogni riga: matcha guide IT con query IT, EN con EN, ecc.
         SELECT g.id AS guide_id, g.title, g.slug, g.content,
                g.language, g.quality_score, g.verified, g.guide_type,
                ts_rank_cd(g.search_vector, plainto_tsquery(g.ts_config, $1)) AS fts_score
         FROM guides g
         WHERE g.search_vector @@ plainto_tsquery(g.ts_config, $1)
           AND ($2::int IS NULL OR g.game_id = $2)
           AND ($3::text IS NULL OR g.language = $3)
         ORDER BY fts_score DESC
         LIMIT $4`,
        [queryText, gameId ?? null, language ?? null, FTS_SEARCH_LIMIT],
      );
      await client.query("COMMIT");
      return res.rows;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err, tsConfig: langToTsConfig(language) }, "RagService: FTS fallita");
    return [];
  }
}

function mergeResults(
  vectorHits: VectorHit[],
  ftsHits: FtsHit[],
  thresholds: Thresholds,
): RagResult[] {
  const fusion = reciprocalRankFusion(vectorHits, ftsHits);

  const vectorByGuide = new Map<number, VectorHit>();
  for (const h of vectorHits) {
    const prev = vectorByGuide.get(h.guide_id);
    if (!prev || h.vector_score > prev.vector_score) vectorByGuide.set(h.guide_id, h);
  }
  const ftsByGuide = new Map<number, FtsHit>();
  for (const h of ftsHits) {
    const prev = ftsByGuide.get(h.guide_id);
    if (!prev || h.fts_score > prev.fts_score) ftsByGuide.set(h.guide_id, h);
  }

  const merged: RagResult[] = [];
  for (const [guideId, s] of fusion.entries()) {
    const v = vectorByGuide.get(guideId);
    const f = ftsByGuide.get(guideId);
    const source = v ?? f!;
    const vectorScore = v?.vector_score ?? 0;
    // Assemblaggio base senza campi optional — poi aggiungo chunkText/content
    // solo se definiti per rispettare exactOptionalPropertyTypes.
    const result: RagResult = {
      guideId,
      title: source.title,
      slug: source.slug,
      language: source.language,
      qualityScore: source.quality_score,
      verified: source.verified,
      guideType: source.guide_type ?? "unknown",
      vectorScore,
      ftsScore: f?.fts_score ?? 0,
      rrfScore: s.rrfScore,
      matchType: classifyMatch(vectorScore, thresholds.high, thresholds.low),
    };
    if (v?.chunk_text !== undefined) result.chunkText = v.chunk_text;
    if (f?.content !== undefined) result.content = f.content;
    merged.push(result);
  }
  merged.sort((a, b) => b.rrfScore - a.rrfScore);
  return merged;
}

export const RagService = {
  async search(queryText: string, options: RagSearchOptions = {}): Promise<RagResult[]> {
    const { gameId, language, limit } = options;
    const start = performance.now();
    const thresholds = await getThresholds();
    const maxResults = limit ?? thresholds.maxResults;

    // STEP A — embedding query. Fallback: se fallisce, solo FTS.
    const embedStart = performance.now();
    const queryEmbedding = await EmbeddingService.generateEmbedding(queryText);
    const embedMs = Math.round(performance.now() - embedStart);

    // STEP B — vector search con SET LOCAL hnsw.ef_search=200 (eseguita solo se embed OK).
    const vStart = performance.now();
    const vectorHits: VectorHit[] = queryEmbedding !== null
      ? await runVectorSearch(queryEmbedding, gameId, language, thresholds.low)
      : [];
    const vectorMs = Math.round(performance.now() - vStart);

    // STEP C — FTS (sempre eseguita, indipendente dal vector).
    const fStart = performance.now();
    const ftsHits = await runFtsSearch(queryText, gameId, language);
    const ftsMs = Math.round(performance.now() - fStart);

    // STEP D — Reciprocal Rank Fusion + ordinamento + top-N.
    const merged = mergeResults(vectorHits, ftsHits, thresholds);
    const top = merged.slice(0, maxResults);

    const totalMs = Math.round(performance.now() - start);
    logger.info(
      {
        query: queryText.slice(0, 80),
        gameId,
        language,
        embedMs,
        vectorMs,
        vectorResults: vectorHits.length,
        ftsMs,
        ftsResults: ftsHits.length,
        fused: merged.length,
        returned: top.length,
        topMatch: top[0]?.matchType ?? "none",
        topVectorScore: top[0]?.vectorScore ?? 0,
        totalMs,
      },
      "RAG search completata",
    );

    return top;
  },

  classifyMatch,
  assembleContext,
  reciprocalRankFusion,
  applyRankingBoost,
  // Fase 13.3 — retrieval specializzati trophy/topic-aware.
  retrieveForTrophy,
  retrieveForTopic,

  /** Forza il reload delle soglie al prossimo accesso (uso: test / admin panel). */
  invalidateThresholdsCache(): void {
    thresholdsCache = null;
  },
};
