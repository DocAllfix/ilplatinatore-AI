import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

// ── Row interface (mirrors migration 027 columns) ─────────────────────────────

export interface UserGameStatsRow {
  id: string;
  user_id: number;
  game_id: number;
  game_slug: string;
  game_name: string;
  total_playtime: number;
  bosses_felled: number;
  current_level: number;
  quests_completed: number;
  progression_percentage: number;
  created_at: Date;
  updated_at: Date;
}

// ── Create / Update interfaces ────────────────────────────────────────────────

export interface UserGameStatsCreate {
  user_id: number;
  game_id: number;
  game_slug: string;
  game_name: string;
  total_playtime?: number;
  bosses_felled?: number;
  current_level?: number;
  quests_completed?: number;
  progression_percentage?: number;
}

export interface UserGameStatsUpdate {
  total_playtime?: number;
  bosses_felled?: number;
  current_level?: number;
  quests_completed?: number;
  progression_percentage?: number;
  game_name?: string;
}

const STATS_COLS = `
  id, user_id, game_id, game_slug, game_name,
  total_playtime, bosses_felled, current_level, quests_completed,
  progression_percentage, created_at, updated_at
`;

const UPDATABLE_COLS = [
  "total_playtime",
  "bosses_felled",
  "current_level",
  "quests_completed",
  "progression_percentage",
  "game_name",
] as const;

export const UserGameStatsModel = {
  /**
   * Lista stats di un utente filtrate opzionalmente per game_slug.
   * Il frontend chiama: filter({ gameSlug }) → array di max 1 elemento (UNIQUE constraint).
   */
  async findByUser(
    userId: number,
    gameSlug?: string,
  ): Promise<UserGameStatsRow[]> {
    try {
      if (gameSlug !== undefined) {
        const res = await query<UserGameStatsRow>(
          `-- Lookup stats per (user_id, game_slug) — copre idx_user_game_stats_user_slug.
           SELECT ${STATS_COLS}
           FROM user_game_stats
           WHERE user_id = $1 AND game_slug = $2`,
          [userId, gameSlug],
        );
        return res.rows;
      }
      const res = await query<UserGameStatsRow>(
        `-- Tutte le stats di un utente (dashboard).
         SELECT ${STATS_COLS}
         FROM user_game_stats
         WHERE user_id = $1
         ORDER BY updated_at DESC`,
        [userId],
      );
      return res.rows;
    } catch (err) {
      logger.error({ err, userId, gameSlug }, "UserGameStatsModel.findByUser failed");
      throw err;
    }
  },

  /**
   * Upsert idempotente — su (user_id, game_id) duplicato aggiorna i campi.
   * Risolve race condition di doppio POST dal frontend (clic ripetuto).
   */
  async upsert(data: UserGameStatsCreate): Promise<UserGameStatsRow> {
    try {
      const res = await query<UserGameStatsRow>(
        `-- Upsert su user_game_stats_uniq (user_id, game_id).
         -- ON CONFLICT aggiorna tutti i campi numerici + game_name (slug invariato).
         INSERT INTO user_game_stats (
           user_id, game_id, game_slug, game_name,
           total_playtime, bosses_felled, current_level,
           quests_completed, progression_percentage
         ) VALUES (
           $1, $2, $3, $4,
           COALESCE($5, 0), COALESCE($6, 0), COALESCE($7, 1),
           COALESCE($8, 0), COALESCE($9, 0)
         )
         ON CONFLICT ON CONSTRAINT user_game_stats_uniq
         DO UPDATE SET
           game_name              = EXCLUDED.game_name,
           total_playtime         = EXCLUDED.total_playtime,
           bosses_felled          = EXCLUDED.bosses_felled,
           current_level          = EXCLUDED.current_level,
           quests_completed       = EXCLUDED.quests_completed,
           progression_percentage = EXCLUDED.progression_percentage
         RETURNING ${STATS_COLS}`,
        [
          data.user_id,
          data.game_id,
          data.game_slug,
          data.game_name,
          data.total_playtime ?? null,
          data.bosses_felled ?? null,
          data.current_level ?? null,
          data.quests_completed ?? null,
          data.progression_percentage ?? null,
        ],
      );
      return res.rows[0]!;
    } catch (err) {
      logger.error({ err }, "UserGameStatsModel.upsert failed");
      throw err;
    }
  },

  /**
   * Update SET dinamico CON IDOR-check (user_id obbligatorio nella WHERE).
   * Se id non appartiene all'utente loggato → 0 rows → ritorna null → 404.
   */
  async updateByIdAndUser(
    id: string,
    userId: number,
    data: UserGameStatsUpdate,
  ): Promise<UserGameStatsRow | null> {
    try {
      const fields: string[] = [];
      const values: unknown[] = [];
      let idx = 1;
      for (const col of UPDATABLE_COLS) {
        const v = (data as Record<string, unknown>)[col];
        if (v !== undefined) {
          fields.push(`${col} = $${idx++}`);
          values.push(v);
        }
      }
      if (fields.length === 0) {
        // Niente da aggiornare → ritorna riga corrente (idempotente).
        const res = await query<UserGameStatsRow>(
          `SELECT ${STATS_COLS} FROM user_game_stats WHERE id = $1 AND user_id = $2`,
          [id, userId],
        );
        return res.rows[0] ?? null;
      }
      values.push(id, userId);
      const res = await query<UserGameStatsRow>(
        `-- Update con guard IDOR: WHERE id AND user_id (no info disclosure su 404).
         UPDATE user_game_stats
         SET ${fields.join(", ")}
         WHERE id = $${idx++} AND user_id = $${idx}
         RETURNING ${STATS_COLS}`,
        values,
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id, userId }, "UserGameStatsModel.updateByIdAndUser failed");
      throw err;
    }
  },
};
