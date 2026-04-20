import type { ExtractedContent } from "@/types";

// Whitelist affidabilità per dominio. Tarata empiricamente:
// powerpyx/psnprofiles sono fonti guide-trofei quasi autorevoli (95/90);
// reddit/youtube sono UGC quindi penalizzati.
export const SOURCE_RELIABILITY: Record<string, number> = {
  "powerpyx.com": 0.95,
  "psnprofiles.com": 0.9,
  "trueachievements.com": 0.9,
  "ign.com": 0.85,
  "fextralife.com": 0.85,
  "gamefaqs.gamespot.com": 0.8,
  "reddit.com": 0.7,
  "youtube.com": 0.6,
};

const UNKNOWN_DOMAIN_SCORE = 0.5;
const WORDCOUNT_CAP = 5000;

// Pesi compositi — regola prompt FILE 5:
//   "reliability * 0.6 + contentQuality * 0.4 DESC"
const W_RELIABILITY = 0.6;
const W_QUALITY = 0.4;

/**
 * Affidabilità di un URL in [0, 1]. Default 0.5 per domini sconosciuti.
 * Match su hostname normalizzato (lowercase, senza www.); riconosce subdomain
 * di domini noti (es. "guides.powerpyx.com" → powerpyx.com score).
 */
export function getReliabilityScore(url: string): number {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const direct = SOURCE_RELIABILITY[host];
    if (direct !== undefined) return direct;
    for (const [known, score] of Object.entries(SOURCE_RELIABILITY)) {
      if (host === known || host.endsWith(`.${known}`)) return score;
    }
    return UNKNOWN_DOMAIN_SCORE;
  } catch {
    return UNKNOWN_DOMAIN_SCORE;
  }
}

/**
 * Quality proxy: wordCount normalizzato in [0, 1], cap a 5000 words.
 * Oltre 5000 words diminishing returns — la lunghezza smette di segnalare qualità.
 */
export function contentQualityScore(wordCount: number): number {
  if (wordCount <= 0) return 0;
  return Math.min(wordCount / WORDCOUNT_CAP, 1);
}

/** Score composito per ranking DESC. */
export function compositeScore(
  reliability: number,
  wordCount: number,
): number {
  return reliability * W_RELIABILITY + contentQualityScore(wordCount) * W_QUALITY;
}

/**
 * Ordina i contenuti per score composito DESC.
 * Immutable: ritorna nuovo array, non muta l'input (safe per retry/debug log).
 */
export function rankSources(contents: ExtractedContent[]): ExtractedContent[] {
  return [...contents].sort((a, b) => {
    const sa = compositeScore(getReliabilityScore(a.source), a.wordCount);
    const sb = compositeScore(getReliabilityScore(b.source), b.wordCount);
    return sb - sa;
  });
}
