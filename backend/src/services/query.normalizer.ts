import { franc } from "franc-min";
import { GamesModel, type GameRow } from "@/models/games.model.js";
import {
  TrophyLookupService,
  isAllowedLang,
  type TrophyMatch,
} from "@/services/trophyLookup.service.js";
import { logger } from "@/utils/logger.js";
import type { GuideType } from "@/services/prompt.builder.js";

/**
 * Normalizzazione query utente → parametri strutturati per orchestrator.
 *
 * Responsabilità:
 *   - detectLanguage: euristica leggera IT vs EN (no NLP pesante; Fase 16 non ce l'ha)
 *   - extractGame: fuzzy match via GamesModel.search (pg_trgm)
 *   - extractTrophy: fuzzy match via TrophyLookupService (migrazione 024)
 *   - extractTopic: match keyword su lista curata (boss/lore/build/armi/...)
 *   - classifyGuideType: routing del template in base agli indizi lessicali
 *
 * Non è NLP-grade: è SUFFICIENTE per il routing RAG. Se fallisce, orchestrator
 * cade su retrieval generico (RagService.search).
 */

export interface GameCandidate {
  /** Subset di GameRow esposto al client (no metadata interno). */
  id: number;
  title: string;
  slug: string;
  similarity: number;
}

export interface NormalizedQuery {
  /** Lingua rilevata dalla query (whitelist ALLOWED_LANGS). Fallback "en". */
  language: string;
  /** Match gioco, null se non identificato. */
  game: GameRow | null;
  /** Match trofeo, null se query non è trophy-centric o nessun match fuzzy. */
  trophy: TrophyMatch | null;
  /** Topic estratto da keyword curate, null se non riconosciuto. */
  topic: string | null;
  /** Classificazione tipologica deducibile dalla query stessa. */
  guideType: GuideType;
  /** Testo originale, preservato per prompt e logging. */
  rawQuery: string;
  /**
   * T3.2 — KF-3 Game disambiguation. Presente solo quando 2+ giochi sono
   * candidati con similarity comparabile (top1>0.7 AND top2/top1>0.8).
   * Il frontend mostra chip selectable e re-invia la query con explicitGameId.
   */
  gameCandidates?: GameCandidate[];
}

// ── Stopwords IT/EN per filtro token in extractGame (NON language detection) ─
// Usate in FILTER_TOKENS più sotto per ridurre il rumore prima del fuzzy match
// pg_trgm su games. La detection vera è fatta da franc-min in detectLanguage.
const IT_MARKERS = [
  "come", "perché", "dove", "trovo", "ottengo", "prendo", "guida", "trofeo",
  "passaggi", "missabile", "platino", "sconfiggere", "boss", "il", "la", "lo",
  "della", "del", "nel", "nella", "di", "da", "cosa",
];
const EN_MARKERS = [
  "how", "where", "find", "get", "guide", "trophy", "steps", "missable",
  "platinum", "defeat", "boss", "the", "of", "a", "in", "what",
];

// ── Language detection (T1.1 — multilingua reale) ─────────────────────────
// franc-min restituisce ISO-639-3 (3 char). Mappiamo alle 9 lingue Tier 1
// supportate dal sistema. Default 'en' su 'und' o lingua non whitelistata.
//
// Whitelist Tier 1: it, en, es, fr, de, pt, ja, zh, ru — coerente con
// HEADERS_I18N in prompt.builder.ts. Aggiungere una lingua qui richiede:
//   1. add ISO_639_3_TO_1 entry
//   2. add headers in prompt.builder HEADERS_I18N
//   3. add ts_config in migration 029 trigger (se serve FTS dedicato)

const ISO_639_3_TO_1: Record<string, string> = {
  ita: "it",
  eng: "en",
  spa: "es",
  fra: "fr",
  deu: "de",
  por: "pt",
  jpn: "ja",
  cmn: "zh", // Mandarin (franc usa cmn, mappiamo a zh per ISO-639-1)
  zho: "zh", // generic Chinese
  rus: "ru",
};

const SUPPORTED_LANGS = new Set(Object.values(ISO_639_3_TO_1));

const FRANC_MIN_LENGTH = 10; // sotto 10 char franc è troppo rumoroso → fallback EN

/**
 * Rileva lingua con franc-min. Restituisce un codice ISO-639-1 ∈ SUPPORTED_LANGS.
 * Fallback 'en' per:
 *   - query troppo corte (< FRANC_MIN_LENGTH)
 *   - lingua non whitelisted (es. ar, ko, hi non supportati al T1)
 *   - franc returns 'und' (undetermined)
 */
export function detectLanguage(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length < FRANC_MIN_LENGTH) return "en";

  // only: limita franc a confrontare contro il subset Tier 1 → riduce falsi
  // positivi su lingue rare (l'utente non scriverà mai in dialetti, etc.).
  const detected = franc(trimmed, {
    only: Object.keys(ISO_639_3_TO_1),
    minLength: FRANC_MIN_LENGTH,
  });

  if (detected === "und") return "en";
  const iso6391 = ISO_639_3_TO_1[detected];
  if (!iso6391 || !SUPPORTED_LANGS.has(iso6391)) return "en";
  return iso6391;
}

// ── Game extraction: prende il primo match GamesModel.search, se score alto ─
/**
 * Estrae un gioco dalla query. Strategia:
 *   - Rimuove parole funzione comuni ("guida", "come", "the", ...) per ridurre rumore.
 *   - Passa i token residui a GamesModel.search (già fuzzy via pg_trgm).
 *   - Ritorna top match se presente.
 *
 * NOTA: GamesModel.search ritorna max 10 risultati ordinati per similarity.
 * Non abbiamo qui un confidence cut-off perché la tabella `games` è curata
 * (seed da migration + IGDB). Un falso positivo qui significa RAG vuoto,
 * gestito downstream dall'orchestrator (fallback scraping).
 */
const FILTER_TOKENS = new Set([
  ...IT_MARKERS,
  ...EN_MARKERS,
  "?", "!", ".", ",", ":",
]);

// T3.2 — KF-3 ambiguity thresholds. Empirici:
//   - top1 > 0.7: il match top è "buono" (sopra soglia trgm)
//   - top2 / top1 > 0.8: il secondo è 80%+ del primo → ambiguo
// Sotto entrambe le soglie, il top1 wins senza disambiguation.
const AMBIGUITY_TOP1_THRESHOLD = 0.7;
const AMBIGUITY_RATIO_THRESHOLD = 0.8;

export interface ExtractedGameResult {
  /** Top match (può essere null se nessun candidato sopra soglia). */
  top: GameRow | null;
  /** Lista completa candidati con similarity (vuota se top=null). */
  candidates: Array<{ game: GameRow; similarity: number }>;
  /** True se top1 e top2 sono entrambi sopra soglia E ratio sopra soglia. */
  isAmbiguous: boolean;
}

export async function extractGameWithCandidates(
  query: string,
): Promise<ExtractedGameResult> {
  const empty: ExtractedGameResult = { top: null, candidates: [], isAmbiguous: false };
  try {
    const tokens = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((t) => !FILTER_TOKENS.has(t));
    if (tokens.length === 0) return empty;

    const ngrams: string[] = [];
    for (const size of [3, 2, 1]) {
      for (let i = 0; i + size <= tokens.length; i++) {
        const slice = tokens.slice(i, i + size).join(" ").trim();
        if (slice.length >= 3) ngrams.push(slice);
      }
    }

    for (const c of ngrams) {
      const candidates = await GamesModel.searchWithScores(c, 5);
      if (candidates.length === 0) continue;

      const top = candidates[0]!;
      const second = candidates[1];
      const isAmbiguous =
        top.similarity >= AMBIGUITY_TOP1_THRESHOLD &&
        second !== undefined &&
        second.similarity >= AMBIGUITY_TOP1_THRESHOLD &&
        second.similarity / top.similarity >= AMBIGUITY_RATIO_THRESHOLD;

      logger.debug(
        { query, top: top.game.title, sim: top.similarity, ambiguous: isAmbiguous, via: c },
        "extractGameWithCandidates: match",
      );
      return { top: top.game, candidates, isAmbiguous };
    }
    return empty;
  } catch (err) {
    logger.error({ err, query }, "extractGameWithCandidates failed, ritorno null");
    return empty;
  }
}

/** Backward-compat: vecchia signature. Usato dagli altri estrattori. */
export async function extractGame(query: string): Promise<GameRow | null> {
  const result = await extractGameWithCandidates(query);
  return result.top;
}

// ── Trophy extraction: solo se la query sembra trophy-centric ──────────────
const TROPHY_HINTS = [
  "trofeo", "trofei", "trophy", "trophies", "achievement", "achievements",
  "unlock", "sbloccare", "ottenere", "guadagnare",
];

function looksLikeTrophyQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return TROPHY_HINTS.some((h) => lower.includes(h));
}

/**
 * Estrae trofeo SOLO se la query ha hint trophy-centric, altrimenti ritorna null.
 * Evita di matchare trofei casuali quando l'utente chiede un boss/lore.
 * Richiede gameId risolto — se null, ritorna null.
 */
export async function extractTrophy(
  query: string,
  gameId: number | null,
  language: string,
): Promise<TrophyMatch | null> {
  if (gameId === null) return null;
  if (!looksLikeTrophyQuery(query)) return null;
  if (!isAllowedLang(language)) return null;

  // Stripping delle parole funzione per dare un candidato "nome trofeo" al lookup.
  const candidate = query
    .replace(/[?!.,:]/g, " ")
    .split(/\s+/)
    .filter((t) => !FILTER_TOKENS.has(t.toLowerCase()) && !TROPHY_HINTS.includes(t.toLowerCase()))
    .join(" ")
    .trim();
  if (candidate.length < 3) return null;

  try {
    return await TrophyLookupService.findTrophyByName(candidate, gameId, language);
  } catch (err) {
    logger.error({ err, query, gameId }, "extractTrophy failed, ritorno null");
    return null;
  }
}

// ── Topic extraction: keyword curata → guide_type/topic hint ──────────────
/**
 * Mappa keyword → (topic, guideType suggerito). Copre i casi tipici:
 *   "boss" → walkthrough (nessun topic dedicato)
 *   "armi" → collectible topic='weapons'
 *   "lore" → walkthrough topic='lore'
 *   "build" → challenge topic='build'
 *   "missable" → collectible topic='missables'
 *
 * Il dispatch finale è: se TROPHY_HINTS match → guide_type=trophy,
 * altrimenti usa questa mappa, con fallback walkthrough.
 */
interface TopicHint {
  topic: string | null;
  guideType: GuideType;
}

const TOPIC_KEYWORDS: Array<{ re: RegExp; hint: TopicHint }> = [
  { re: /\b(platin(o|um))\b/i, hint: { topic: null, guideType: "platinum" } },
  { re: /\b(missabil|missable)/i, hint: { topic: "missables", guideType: "collectible" } },
  { re: /\b(armi|weapons?)\b/i, hint: { topic: "weapons", guideType: "collectible" } },
  { re: /\b(armatur|armor)/i, hint: { topic: "armor", guideType: "collectible" } },
  { re: /\b(collectible|collezionabil)/i, hint: { topic: null, guideType: "collectible" } },
  { re: /\b(sfida|challenge)\b/i, hint: { topic: null, guideType: "challenge" } },
  { re: /\b(build|equipaggiament)/i, hint: { topic: "build", guideType: "challenge" } },
  { re: /\b(lore|trama|storia)\b/i, hint: { topic: "lore", guideType: "walkthrough" } },
  { re: /\b(boss)\b/i, hint: { topic: null, guideType: "walkthrough" } },
  { re: /\b(walkthrough|passaggi)\b/i, hint: { topic: null, guideType: "walkthrough" } },
];

function extractTopicHint(query: string): TopicHint | null {
  for (const { re, hint } of TOPIC_KEYWORDS) {
    if (re.test(query)) return hint;
  }
  return null;
}

/**
 * Orchestratore: normalizza una query utente in parametri strutturati.
 * Sequenza: language → game → (trophy OR topic) → guide_type.
 * Resiliente: ogni step fallisce soft a null, non crasha.
 *
 * @param rawQuery testo utente
 * @param explicitLanguage se presente (es. header Accept-Language, UI toggle),
 *                         bypassa detectLanguage — l'utente ha diritto di scelta.
 * @param explicitGameId T3.2 — bypassa extraction se l'utente ha già scelto
 *                       il gioco via disambiguation chip.
 */
export async function normalizeQuery(
  rawQuery: string,
  explicitLanguage?: string,
  explicitGameId?: number,
): Promise<NormalizedQuery> {
  const language = explicitLanguage && explicitLanguage.trim().length > 0
    ? explicitLanguage.trim().toLowerCase()
    : detectLanguage(rawQuery);

  // T3.2 — game extraction con disambiguation awareness.
  let game: GameRow | null = null;
  let gameCandidates: GameCandidate[] | undefined;
  if (explicitGameId !== undefined) {
    // Bypass extraction: l'utente ha già scelto via chip selectable.
    game = await GamesModel.findById(explicitGameId);
    if (!game) {
      logger.warn({ explicitGameId }, "normalizeQuery: explicitGameId non trovato in DB");
    }
  } else {
    const result = await extractGameWithCandidates(rawQuery);
    game = result.top;
    if (result.isAmbiguous) {
      gameCandidates = result.candidates.slice(0, 3).map((c) => ({
        id: c.game.id,
        title: c.game.title,
        slug: c.game.slug,
        similarity: c.similarity,
      }));
    }
  }

  let trophy: TrophyMatch | null = null;
  let topic: string | null = null;
  let guideType: GuideType = "walkthrough"; // default prudente

  if (looksLikeTrophyQuery(rawQuery)) {
    guideType = "trophy";
    trophy = await extractTrophy(rawQuery, game?.id ?? null, language);
  } else {
    const hint = extractTopicHint(rawQuery);
    if (hint) {
      guideType = hint.guideType;
      topic = hint.topic;
    }
  }

  return {
    language,
    game,
    trophy,
    topic,
    guideType,
    rawQuery,
    ...(gameCandidates && { gameCandidates }),
  };
}
