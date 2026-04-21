import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

/**
 * Model per la tabella guide_request_tracker (migration 010).
 *
 * ATTENZIONE: UNIQUE(game_id, trophy_id) è trophy-centric. Query non-trophy
 * (trophy_id=NULL) collasserebbero su una sola riga per game_id.
 * Fase 16 chiama l'upsert SOLO per query con trophy_id non-null.
 * (vedi memory project_fase16_decisions.md §2 — relax migration in Fase 17).
 */

export interface TrackerRow {
  id: number;
  game_id: number;
  trophy_id: number | null;
  game_slug: string;
  trophy_slug: string | null;
  request_count: number;
  first_requested: Date;
  last_requested: Date;
  published_to_wp: boolean;
  wp_post_id: number | null;
  flagged_at: Date | null;
}

export interface TrackerUpsertParams {
  game_id: number;
  trophy_id: number;
  game_slug: string;
  trophy_slug: string;
}

export const GuideRequestTrackerModel = {
  /**
   * Incrementa contatore richieste per (game_id, trophy_id) oppure crea la riga.
   * Ritorna la riga aggiornata. Errori non-fatali: loggiamo e ritorniamo null
   * per non bloccare la response utente.
   */
  async upsertTrophyRequest(
    params: TrackerUpsertParams,
  ): Promise<TrackerRow | null> {
    try {
      const res = await query<TrackerRow>(
        `-- Upsert tracker: inserisce se nuovo (count=1), incrementa count e refresh
         -- last_requested se già presente. Sfrutta constraint UNIQUE(game_id, trophy_id).
         INSERT INTO guide_request_tracker (
           game_id, trophy_id, game_slug, trophy_slug,
           request_count, first_requested, last_requested
         ) VALUES ($1, $2, $3, $4, 1, NOW(), NOW())
         ON CONFLICT (game_id, trophy_id) DO UPDATE
           SET request_count = guide_request_tracker.request_count + 1,
               last_requested = NOW()
         RETURNING
           id, game_id, trophy_id, game_slug, trophy_slug,
           request_count, first_requested, last_requested,
           published_to_wp, wp_post_id, flagged_at`,
        [params.game_id, params.trophy_id, params.game_slug, params.trophy_slug],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.warn({ err, params }, "GuideRequestTrackerModel.upsert failed (non-fatal)");
      return null;
    }
  },
};
