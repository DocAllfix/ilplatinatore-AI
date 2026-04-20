import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

export interface RatingRow {
  id: number;
  guide_id: number;
  user_id: number | null;
  session_id: string | null;
  stars: number;
  suggestion: string | null;
  language: string | null;
  created_at: Date;
}

export interface RatingWithUser extends RatingRow {
  user_display_name: string | null;
}

export interface RatingSummary {
  guide_id: number;
  total_ratings: number;  // cast a int in query — pg restituisce bigint come string senza cast
  avg_stars: number;      // cast a float in query — pg restituisce numeric come string senza cast
  total_suggestions: number;
}

export interface RatingCreate {
  guide_id: number;
  stars: number;
  suggestion?: string | null;
  language?: string | null;
}

const RATING_COLS = `
  id, guide_id, user_id, session_id, stars, suggestion, language, created_at
`;

export const RatingsModel = {
  async createUserRating(
    data: RatingCreate & { user_id: number },
  ): Promise<RatingRow> {
    try {
      const res = await query<RatingRow>(
        `-- Upsert voto autenticato: ON CONFLICT su (guide_id, user_id) per constraint
         -- uq_rating_user (migration 009) — aggiorna stelle e suggerimento senza duplicati.
         INSERT INTO guide_ratings (guide_id, user_id, stars, suggestion, language)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (guide_id, user_id)
         DO UPDATE SET
           stars      = EXCLUDED.stars,
           suggestion = EXCLUDED.suggestion
         RETURNING ${RATING_COLS}`,
        [
          data.guide_id,
          data.user_id,
          data.stars,
          data.suggestion ?? null,
          data.language ?? null,
        ],
      );
      return res.rows[0]!;
    } catch (err) {
      logger.error({ err }, "RatingsModel.createUserRating failed");
      throw err;
    }
  },

  async createSessionRating(
    data: RatingCreate & { session_id: string },
  ): Promise<RatingRow> {
    try {
      const res = await query<RatingRow>(
        `-- Upsert voto anonimo: ON CONFLICT su (guide_id, session_id) per constraint
         -- uq_rating_session (migration 009) — aggiorna stelle e suggerimento senza duplicati.
         INSERT INTO guide_ratings (guide_id, session_id, stars, suggestion, language)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (guide_id, session_id)
         DO UPDATE SET
           stars      = EXCLUDED.stars,
           suggestion = EXCLUDED.suggestion
         RETURNING ${RATING_COLS}`,
        [
          data.guide_id,
          data.session_id,
          data.stars,
          data.suggestion ?? null,
          data.language ?? null,
        ],
      );
      return res.rows[0]!;
    } catch (err) {
      logger.error({ err }, "RatingsModel.createSessionRating failed");
      throw err;
    }
  },

  async getByGuide(guideId: number): Promise<RatingWithUser[]> {
    try {
      const res = await query<RatingWithUser>(
        `-- Recupera tutti i voti per una guida con display_name utente se disponibile.
         SELECT
           gr.id, gr.guide_id, gr.user_id, gr.session_id,
           gr.stars, gr.suggestion, gr.language, gr.created_at,
           u.display_name AS user_display_name
         FROM guide_ratings gr
         LEFT JOIN users u ON u.id = gr.user_id
         WHERE gr.guide_id = $1
         ORDER BY gr.created_at DESC`,
        [guideId],
      );
      return res.rows;
    } catch (err) {
      logger.error({ err, guideId }, "RatingsModel.getByGuide failed");
      throw err;
    }
  },

  async getSummary(guideId: number): Promise<RatingSummary | null> {
    try {
      const res = await query<RatingSummary>(
        `-- Legge aggregazione dalla vista materializzata guide_rating_summary.
         -- Cast espliciti: bigint→int e numeric→float per evitare che pg ritorni stringhe.
         SELECT
           guide_id,
           total_ratings::int      AS total_ratings,
           avg_stars::float        AS avg_stars,
           total_suggestions::int  AS total_suggestions
         FROM guide_rating_summary
         WHERE guide_id = $1`,
        [guideId],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, guideId }, "RatingsModel.getSummary failed");
      throw err;
    }
  },

  async refreshSummary(): Promise<void> {
    try {
      await query(
        `-- Ricalcola la vista materializzata senza bloccare i lettori (CONCURRENTLY).
         -- Richiede l'indice UNIQUE idx_rating_summary_guide (migration 009).
         REFRESH MATERIALIZED VIEW CONCURRENTLY guide_rating_summary`,
      );
    } catch (err) {
      logger.error({ err }, "RatingsModel.refreshSummary failed");
      throw err;
    }
  },
};
