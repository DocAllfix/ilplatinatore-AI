import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

// Whitelist delle lingue supportate — allineata a migration 017 (trophies.name_<lang>).
// CRITICO: usata per interpolare il nome colonna nella query. DEVE restare whitelisted:
// il nome colonna NON può essere passato come parametro prepared ($1) in SQL.
export const ALLOWED_LANGS = [
  "en", "it", "fr", "de", "es", "pt", "ja", "ko", "zh_hans", "zh_hant",
] as const;
export type AllowedLang = (typeof ALLOWED_LANGS)[number];

export function isAllowedLang(lang: string): lang is AllowedLang {
  return (ALLOWED_LANGS as readonly string[]).includes(lang);
}

export type TrophyMatchType = "exact_lang" | "exact_en" | "fuzzy_lang";

export interface TrophyMatch {
  id: number;
  game_id: number;
  trophy_type: string | null;
  name_en: string | null;
  name_it: string | null;
  detail_en: string | null;
  detail_it: string | null;
  psn_trophy_id: string | null;
  psn_communication_id: string | null;
  rarity_source: string | null;
  match: TrophyMatchType;
  // Similarity del match fuzzy (0-1). NULL per match exact.
  similarity: number | null;
}

// Soglia fuzzy trigram: tarata empiricamente a 0.4 (vedi DEEP_SEARCH_ADDITIONS.md §13).
// Sotto 0.4 i match sono rumore (trofei non correlati); sopra 0.4 sono riconoscibili.
const FUZZY_THRESHOLD = 0.4;

// name_en/detail_en usati come anchor autoritativo EN nel prompt LLM (Fase 16.1).
// detail_it tenuto per future post-translation substitution senza extra SELECT.
const TROPHY_BASE_COLS = `
  id, game_id, trophy_type,
  name_en, name_it, detail_en, detail_it,
  psn_trophy_id, psn_communication_id, rarity_source
`;

export const TrophyLookupService = {
  /**
   * Trova un trofeo tramite nome fuzzy in cascata:
   *   1. exact_lang : ILIKE su name_<language> (case-insensitive, stessa lingua)
   *   2. exact_en   : ILIKE su name_en (fallback sempre presente per migration 017)
   *   3. fuzzy_lang : pg_trgm similarity >= 0.4 su name_<language> (indice GIN migration 024)
   * Ritorna null se nessuno dei tre matcha.
   */
  async findTrophyByName(
    name: string,
    gameId: number,
    language: string = "en",
  ): Promise<TrophyMatch | null> {
    if (!name.trim()) return null;
    if (!isAllowedLang(language)) {
      throw new Error(`Language not allowed: ${language}`);
    }
    const col = `name_${language}`;

    try {
      // 1. exact_lang — case-insensitive match sulla lingua richiesta.
      const exact = await query<Omit<TrophyMatch, "match" | "similarity">>(
        `-- Match esatto (case-insensitive) su nome trofeo in lingua richiesta.
         -- ${col} è whitelisted da isAllowedLang — safe per interpolazione.
         SELECT ${TROPHY_BASE_COLS}
         FROM trophies
         WHERE game_id = $1 AND ${col} ILIKE $2
         LIMIT 1`,
        [gameId, name],
      );
      if (exact.rows[0]) {
        logger.debug({ gameId, name, language, match: "exact_lang" }, "Trophy matched");
        return { ...exact.rows[0], match: "exact_lang", similarity: null };
      }

      // 2. exact_en — fallback alla lingua primaria (name_en sempre backfilled da migration 017).
      if (language !== "en") {
        const en = await query<Omit<TrophyMatch, "match" | "similarity">>(
          `-- Fallback su name_en: garantito popolato da UPDATE backfill in migration 017.
           SELECT ${TROPHY_BASE_COLS}
           FROM trophies
           WHERE game_id = $1 AND name_en ILIKE $2
           LIMIT 1`,
          [gameId, name],
        );
        if (en.rows[0]) {
          logger.debug({ gameId, name, language, match: "exact_en" }, "Trophy matched");
          return { ...en.rows[0], match: "exact_en", similarity: null };
        }
      }

      // 3. fuzzy_lang — pg_trgm similarity. Richiede idx_trophies_name_<lang>_trgm (migration 024).
      const fuzzy = await query<
        Omit<TrophyMatch, "match" | "similarity"> & { sim: number }
      >(
        `-- Trigram similarity: cattura typo e abbreviazioni ("Signore d'El" → "Signore d'Elden").
         -- Operatore %: richiede pg_trgm (migration 001) + indice GIN (migration 024).
         SELECT ${TROPHY_BASE_COLS}, similarity(${col}, $2) AS sim
         FROM trophies
         WHERE game_id = $1 AND ${col} % $2
         ORDER BY sim DESC
         LIMIT 1`,
        [gameId, name],
      );
      const top = fuzzy.rows[0];
      if (top && top.sim >= FUZZY_THRESHOLD) {
        logger.debug(
          { gameId, name, language, match: "fuzzy_lang", sim: top.sim },
          "Trophy matched (fuzzy)",
        );
        const { sim, ...rest } = top;
        return { ...rest, match: "fuzzy_lang", similarity: sim };
      }

      logger.debug({ gameId, name, language }, "Trophy not matched");
      return null;
    } catch (err) {
      logger.error(
        { err, gameId, name, language },
        "TrophyLookupService.findTrophyByName failed",
      );
      throw err;
    }
  },
};
