import { pool } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

export interface GameGuideLink {
  id: number;
  game_id: number;
  url: string;
  domain: string;
  guide_type: string;
  language: string;
  reliability: number;
  verified_at: Date | null;
  auto_found: boolean;
  created_at: Date;
  updated_at: Date;
}

export const GameGuideLinksModel = {
  /**
   * Recupera i link verificati per un gioco, opzionalmente filtrati per guide_type.
   * Se guideType non corrisponde a nessun risultato, ritorna i link 'general' come fallback.
   */
  async findByGame(
    gameId: number,
    guideType?: string,
  ): Promise<GameGuideLink[]> {
    try {
      if (guideType && guideType !== "general") {
        const res = await pool.query<GameGuideLink>(
          /* sql — cerca per tipo specifico, fallback a general se vuoto */
          `SELECT id, game_id, url, domain, guide_type, language, reliability,
                  verified_at, auto_found, created_at, updated_at
           FROM game_guide_links
           WHERE game_id = $1 AND guide_type = $2
           ORDER BY reliability DESC
           LIMIT 3`,
          [gameId, guideType],
        );
        if (res.rows.length > 0) return res.rows;
      }
      const res = await pool.query<GameGuideLink>(
        /* sql — fallback: qualsiasi link per il gioco ordinato per reliability */
        `SELECT id, game_id, url, domain, guide_type, language, reliability,
                verified_at, auto_found, created_at, updated_at
         FROM game_guide_links
         WHERE game_id = $1
         ORDER BY reliability DESC
         LIMIT 3`,
        [gameId],
      );
      return res.rows;
    } catch (err) {
      logger.error({ err, gameId, guideType }, "GameGuideLinksModel.findByGame failed");
      return [];
    }
  },

  /**
   * Inserisce o aggiorna un link. Usa ON CONFLICT per idempotenza su (game_id, url).
   * Aggiorna reliability e verified_at se il link esiste già.
   */
  async upsert(
    gameId: number,
    url: string,
    domain: string,
    guideType: string,
    reliability = 0.8,
    language = "en",
    autoFound = true,
  ): Promise<void> {
    try {
      await pool.query(
        /* sql — upsert idempotente: aggiorna se il link esiste già */
        `INSERT INTO game_guide_links (game_id, url, domain, guide_type, language, reliability, auto_found, verified_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (game_id, url) DO UPDATE SET
           guide_type  = EXCLUDED.guide_type,
           reliability = GREATEST(game_guide_links.reliability, EXCLUDED.reliability),
           verified_at = NOW(),
           updated_at  = NOW()`,
        [gameId, url, domain, guideType, language, reliability, autoFound],
      );
    } catch (err) {
      logger.error({ err, gameId, url }, "GameGuideLinksModel.upsert failed");
      throw err;
    }
  },

  /** Conta link per gioco — utile per healthcheck/stats. */
  async countByGame(gameId: number): Promise<number> {
    try {
      const res = await pool.query<{ n: string }>(
        "SELECT count(*) as n FROM game_guide_links WHERE game_id = $1",
        [gameId],
      );
      return parseInt(res.rows[0]?.n ?? "0", 10);
    } catch (err) {
      logger.error({ err, gameId }, "GameGuideLinksModel.countByGame failed");
      return 0;
    }
  },
};
