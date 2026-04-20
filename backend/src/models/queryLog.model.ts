import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

export interface QueryLogRow {
  id: number;
  user_id: number | null;
  session_id: string | null;
  query_text: string;
  game_detected: string | null;
  trophy_detected: string | null;
  source_used: string | null;
  response_time_ms: number | null;
  quality_score: number | null;
  user_rating: number | null;
  created_at: Date;
}

export interface QueryLogCreate {
  user_id?: number | null;
  session_id?: string | null;
  query_text: string;
  game_detected?: string | null;
  trophy_detected?: string | null;
  source_used?: string | null;
  response_time_ms?: number | null;
  quality_score?: number | null;
  user_rating?: number | null;
}

export interface PopularGame {
  game_detected: string;
  query_count: string;
}

export const QueryLogModel = {
  async create(data: QueryLogCreate): Promise<QueryLogRow> {
    try {
      const res = await query<QueryLogRow>(
        `-- Inserisce log query nella tabella partizionata per mese (migration 008).
         -- PostgreSQL seleziona automaticamente la partizione corretta su created_at.
         INSERT INTO query_log (
           user_id, session_id, query_text, game_detected, trophy_detected,
           source_used, response_time_ms, quality_score, user_rating
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING
           id, user_id, session_id, query_text, game_detected, trophy_detected,
           source_used, response_time_ms, quality_score, user_rating, created_at`,
        [
          data.user_id ?? null,
          data.session_id ?? null,
          data.query_text,
          data.game_detected ?? null,
          data.trophy_detected ?? null,
          data.source_used ?? null,
          data.response_time_ms ?? null,
          data.quality_score ?? null,
          data.user_rating ?? null,
        ],
      );
      return res.rows[0]!;
    } catch (err) {
      logger.error({ err }, "QueryLogModel.create failed");
      throw err;
    }
  },

  async getPopularGames(days: number, limit: number): Promise<PopularGame[]> {
    try {
      const res = await query<PopularGame>(
        `-- Aggrega i giochi più cercati negli ultimi N giorni.
         -- L'indice idx_query_log_game (migration 008) accelera il filtro su game_detected.
         -- $1::int * INTERVAL '1 day' evita concatenazione server-side; $2 limita i risultati.
         SELECT
           game_detected,
           COUNT(*) AS query_count
         FROM query_log
         WHERE game_detected IS NOT NULL
           AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
         GROUP BY game_detected
         ORDER BY query_count DESC
         LIMIT $2`,
        [days, limit],
      );
      return res.rows;
    } catch (err) {
      logger.error({ err, days, limit }, "QueryLogModel.getPopularGames failed");
      throw err;
    }
  },
};
