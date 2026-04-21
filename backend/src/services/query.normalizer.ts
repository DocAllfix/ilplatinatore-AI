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
}

// ── Language detection: euristica parole funzione ─────────────────────────
// Non è perfetta ma NON servono librerie esterne: il RAG e il template ci
// girano attorno bene (translateGuide assorbe gli errori di routing).
const IT_MARKERS = [
  "come", "perché", "dove", "trovo", "ottengo", "prendo", "guida", "trofeo",
  "passaggi", "missabile", "platino", "sconfiggere", "boss", "il", "la", "lo",
  "della", "del", "nel", "nella", "di", "da", "cosa",
];
const EN_MARKERS = [
  "how", "where", "find", "get", "guide", "trophy", "steps", "missable",
  "platinum", "defeat", "boss", "the", "of", "a", "in", "what",
];

export function detectLanguage(query: string): string {
  const tokens = query.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  let itHits = 0;
  let enHits = 0;
  for (const t of tokens) {
    if (IT_MARKERS.includes(t)) itHits++;
    if (EN_MARKERS.includes(t)) enHits++;
  }
  if (itHits === 0 && enHits === 0) return "en"; // default prudente
  return itHits >= enHits ? "it" : "en";
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

export async function extractGame(query: string): Promise<GameRow | null> {
  try {
    const tokens = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((t) => !FILTER_TOKENS.has(t));
    if (tokens.length === 0) return null;

    // Provo 3 strategie in ordine: 3-gram, 2-gram, 1-gram top.
    // Esempio: "the last of us" → "last of us", "last of", "last".
    const candidates: string[] = [];
    for (const size of [3, 2, 1]) {
      for (let i = 0; i + size <= tokens.length; i++) {
        const slice = tokens.slice(i, i + size).join(" ").trim();
        if (slice.length >= 3) candidates.push(slice);
      }
    }

    for (const c of candidates) {
      const games = await GamesModel.search(c);
      if (games.length > 0) {
        logger.debug({ query, matched: games[0]!.title, via: c }, "extractGame: match");
        return games[0]!;
      }
    }
    return null;
  } catch (err) {
    logger.error({ err, query }, "extractGame failed, ritorno null");
    return null;
  }
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
 */
export async function normalizeQuery(
  rawQuery: string,
  explicitLanguage?: string,
): Promise<NormalizedQuery> {
  const language = explicitLanguage && explicitLanguage.trim().length > 0
    ? explicitLanguage.trim().toLowerCase()
    : detectLanguage(rawQuery);
  const game = await extractGame(rawQuery);

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
  };
}
