/**
 * Funzioni pure del RAG: tipi, Reciprocal Rank Fusion, classificazione match,
 * assemblaggio contesto LLM, ranking boost per confidence/source.
 * Nessun I/O (no DB, no Redis, no API). Testabili in isolamento.
 */

export type MatchType = "exact" | "partial" | "none";
export type RetrievalSource = "trophy" | "topic" | "generic";
export type ConfidenceLevel = "verified" | "harvested" | "generated" | "unverified";
// Allineato a migration 004: CHECK (source IN ('wordpress','chatbot','manual','scraping','harvested')).
export type GuideSource = "wordpress" | "chatbot" | "manual" | "scraping" | "harvested";

export interface RagResult {
  guideId: number;
  title: string;
  slug: string;
  chunkText?: string | undefined;
  content?: string | undefined;
  language: string;
  qualityScore: number;
  verified: boolean;
  guideType: string;
  vectorScore: number;
  ftsScore: number;
  rrfScore: number;
  matchType: MatchType;
  // Aggiunti in Fase 13.3 — popolati opzionalmente dai retrieval specializzati.
  confidenceLevel?: ConfidenceLevel | undefined;
  source?: GuideSource | undefined;
  trophyId?: number | null | undefined;
  retrievalSource?: RetrievalSource | undefined;
}

export interface VectorRankItem {
  guide_id: number;
  vector_score: number;
}
export interface FtsRankItem {
  guide_id: number;
  fts_score: number;
}

export interface RankingBoostConfig {
  // Moltiplicatori dello rrfScore (1.0 = no effect, >1 boost, <1 penalty).
  bySource: Partial<Record<GuideSource, number>>;
  byConfidence: Partial<Record<ConfidenceLevel, number>>;
}

/**
 * Default boost conforme a DEEP_SEARCH_ADDITIONS.md §13:
 *   "source='wordpress' +0.2, 'harvested' +0.1"
 * Traduzione additiva → moltiplicativa: +0.2 → ×1.20, +0.1 → ×1.10.
 * Estensione coerente: verified +0.2 (match wordpress), unverified ×0.95 (lieve penalty).
 * Valori configurabili via override — es. SystemConfig per A/B tuning in prod.
 */
export const DEFAULT_BOOST: RankingBoostConfig = {
  bySource: { wordpress: 1.2 },
  byConfidence: { verified: 1.2, harvested: 1.1, generated: 1.0, unverified: 0.95 },
};

// RRF constant (Cormack et al. 2009).
export const RRF_K = 60;

const CHARS_PER_TOKEN = 4;

/**
 * Reciprocal Rank Fusion: combina N ranking indipendenti.
 * Dedup guide-level: chunk duplicati NON consumano rank (il fusion è guide-vs-guide).
 */
export function reciprocalRankFusion(
  vectorRanking: VectorRankItem[],
  ftsRanking: FtsRankItem[],
  k: number = RRF_K,
): Map<number, { rrfScore: number; vectorScore: number; ftsScore: number }> {
  const scores = new Map<
    number,
    { rrfScore: number; vectorScore: number; ftsScore: number }
  >();

  const addContribution = (
    guideId: number,
    rank: number,
    vectorScore: number,
    ftsScore: number,
  ): void => {
    const contribution = 1 / (k + rank);
    const prev = scores.get(guideId);
    if (prev) {
      prev.rrfScore += contribution;
      if (vectorScore > prev.vectorScore) prev.vectorScore = vectorScore;
      if (ftsScore > prev.ftsScore) prev.ftsScore = ftsScore;
    } else {
      scores.set(guideId, { rrfScore: contribution, vectorScore, ftsScore });
    }
  };

  const seenVector = new Set<number>();
  let vectorRank = 0;
  for (const hit of vectorRanking) {
    if (seenVector.has(hit.guide_id)) continue;
    seenVector.add(hit.guide_id);
    vectorRank += 1;
    addContribution(hit.guide_id, vectorRank, hit.vector_score, 0);
  }

  const seenFts = new Set<number>();
  let ftsRank = 0;
  for (const hit of ftsRanking) {
    if (seenFts.has(hit.guide_id)) continue;
    seenFts.add(hit.guide_id);
    ftsRank += 1;
    addContribution(hit.guide_id, ftsRank, 0, hit.fts_score);
  }

  return scores;
}

/**
 * Classifica il top result secondo soglie di similarità vettoriale.
 * Bordi: score==high → partial, score==low → partial. Pura, no mix di dimensioni.
 */
export function classifyMatch(
  topVectorScore: number | undefined,
  thresholdHigh: number,
  thresholdLow: number,
): MatchType {
  if (topVectorScore === undefined || topVectorScore < thresholdLow) return "none";
  if (topVectorScore > thresholdHigh) return "exact";
  return "partial";
}

/**
 * Applica boost moltiplicativo a rrfScore per source + confidenceLevel,
 * poi re-ordina DESC. Immutable: ritorna nuovo array, non muta l'input.
 * Se source o confidenceLevel sono undefined, il factor relativo è 1.0 (neutrale).
 */
export function applyRankingBoost(
  results: RagResult[],
  config: RankingBoostConfig = DEFAULT_BOOST,
): RagResult[] {
  const boosted = results.map((r) => {
    const sourceFactor = r.source !== undefined
      ? (config.bySource[r.source] ?? 1)
      : 1;
    const confidenceFactor = r.confidenceLevel !== undefined
      ? (config.byConfidence[r.confidenceLevel] ?? 1)
      : 1;
    const factor = sourceFactor * confidenceFactor;
    // Copia per immutabilità; se factor=1 lasciamo invariato il valore.
    return factor === 1 ? { ...r } : { ...r, rrfScore: r.rrfScore * factor };
  });
  boosted.sort((a, b) => b.rrfScore - a.rrfScore);
  return boosted;
}

/**
 * Concatena risultati in contesto testuale per l'LLM.
 * 4 char/token, truncation fine-blocco, skip body vuoti (il numero FONTE
 * resta legato all'indice originale per tracciabilità).
 */
export function assembleContext(results: RagResult[], maxTokens = 8000): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts: string[] = [];
  let total = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const body = r.chunkText ?? r.content ?? "";
    if (!body.trim()) continue;

    const header = `--- FONTE ${i + 1}: ${r.title} (score: ${r.rrfScore.toFixed(4)}) ---`;
    const block = `${header}\n${body}`;
    const separatorSize = parts.length > 0 ? 2 : 0;
    const blockSize = block.length + separatorSize;

    if (total + blockSize > maxChars) {
      const remaining = maxChars - total - separatorSize - header.length - 1;
      if (remaining > 0) {
        parts.push(`${header}\n${body.slice(0, remaining)}`);
      }
      break;
    }
    parts.push(block);
    total += blockSize;
  }

  return parts.join("\n\n");
}
