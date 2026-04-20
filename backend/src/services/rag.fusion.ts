/**
 * Funzioni pure del RAG: tipi, Reciprocal Rank Fusion, classificazione match,
 * assemblaggio contesto LLM. Nessun I/O (no DB, no Redis, no API). Testabili in isolamento.
 */

export type MatchType = "exact" | "partial" | "none";

export interface RagResult {
  guideId: number;
  title: string;
  slug: string;
  // | undefined esplicito: compatibile con exactOptionalPropertyTypes quando il
  // valore deriva da un hit di vector OR fts che può mancare.
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
}

// Shape minima richiesta da reciprocalRankFusion — facilita test con fixture leggere.
export interface VectorRankItem {
  guide_id: number;
  vector_score: number;
}
export interface FtsRankItem {
  guide_id: number;
  fts_score: number;
}

// RRF constant (Cormack et al. 2009). 40-80 tipici; 60 è lo standard de-facto.
export const RRF_K = 60;

const CHARS_PER_TOKEN = 4;

/**
 * Reciprocal Rank Fusion: combina N ranking indipendenti in uno singolo.
 * Formula: RRF(d) = Σ 1/(k + rank_i(d)) con rank 1-based.
 *
 * Dedup guide-level: se un guide appare più volte nello stesso ranking (chunk multipli
 * dal vector search), conta la PRIMA occorrenza e i duplicati NON consumano rank.
 * Motivazione: il fusion è guide-vs-guide, non chunk-vs-chunk — un chunk duplicato
 * non deve penalizzare il rank di un altro guide.
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
 *  - exact   (score > high): guida nel DB, LLM deve solo riformattare.
 *  - partial (low ≤ score ≤ high): arricchire con scraping.
 *  - none    (score < low | undefined): scraping completo.
 * Bordi: score==high → partial (strictly greater per exact), score==low → partial.
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
 * Concatena i risultati in un contesto testuale per l'LLM.
 * maxTokens stimato a 4 char/token; truncation alla fine dell'ultimo blocco che sta.
 * Ordine preservato: primo input = massima priorità in testa.
 * Blocchi con body vuoto sono saltati (ma il numero FONTE resta legato all'indice originale).
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
    const separatorSize = parts.length > 0 ? 2 : 0; // "\n\n"
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
