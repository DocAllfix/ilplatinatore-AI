import { getClient } from "@/config/database.js";
import { logger } from "@/utils/logger.js";
import { EmbeddingService } from "@/services/embedding.service.js";
import { SystemConfigModel } from "@/models/systemConfig.model.js";
import {
  reciprocalRankFusion,
  classifyMatch,
  assembleContext,
  type RagResult,
} from "@/services/rag.fusion.js";

export type { MatchType, RagResult } from "@/services/rag.fusion.js";
export { reciprocalRankFusion, classifyMatch, assembleContext };

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

async function runVectorSearch(
  queryEmbedding: number[],
  gameId: number | undefined,
  thresholdLow: number,
): Promise<VectorHit[]> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    // AUDIT FIX (W2): ef_search=200 per recall >98% sul retrieval RAG critico.
    // SET LOCAL è scoped alla transazione → safe con PgBouncer transaction pooling.
    await client.query("SET LOCAL hnsw.ef_search = 200");
    const vectorStr = `[${queryEmbedding.join(",")}]`;
    const res = await client.query<VectorHit>(
      `-- Top-N chunk per similarità coseno via indice HNSW su guide_embeddings.
       -- 1 - (a <=> b) = cosine similarity in [0,1]; filtro soglia low per scartare rumore.
       SELECT ge.guide_id, ge.chunk_text, ge.chunk_index,
              g.title, g.slug, g.language, g.quality_score, g.verified, g.guide_type,
              1 - (ge.embedding <=> $1::vector) AS vector_score
       FROM guide_embeddings ge
       JOIN guides g ON g.id = ge.guide_id
       WHERE ($2::int IS NULL OR g.game_id = $2)
         AND 1 - (ge.embedding <=> $1::vector) > $3
       ORDER BY vector_score DESC
       LIMIT $4`,
      [vectorStr, gameId ?? null, thresholdLow, VECTOR_SEARCH_LIMIT],
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
): Promise<FtsHit[]> {
  try {
    const client = await getClient();
    try {
      const res = await client.query<FtsHit>(
        `-- FTS su search_vector (GENERATED, stemming italiano).
         -- plainto_tsquery normalizza l'input senza rischi di sintassi ts_query.
         SELECT g.id AS guide_id, g.title, g.slug, g.content,
                g.language, g.quality_score, g.verified, g.guide_type,
                ts_rank_cd(g.search_vector, plainto_tsquery('italian', $1)) AS fts_score
         FROM guides g
         WHERE g.search_vector @@ plainto_tsquery('italian', $1)
           AND ($2::int IS NULL OR g.game_id = $2)
         ORDER BY fts_score DESC
         LIMIT $3`,
        [queryText, gameId ?? null, FTS_SEARCH_LIMIT],
      );
      return res.rows;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, "RagService: FTS fallita, procedo col solo vector ranking");
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
      ? await runVectorSearch(queryEmbedding, gameId, thresholds.low)
      : [];
    const vectorMs = Math.round(performance.now() - vStart);

    // STEP C — FTS (sempre eseguita, indipendente dal vector).
    const fStart = performance.now();
    const ftsHits = await runFtsSearch(queryText, gameId);
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

  /** Forza il reload delle soglie al prossimo accesso (uso: test / admin panel). */
  invalidateThresholdsCache(): void {
    thresholdsCache = null;
  },
};
