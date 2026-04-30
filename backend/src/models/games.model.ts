import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

export interface GameRow {
  id: number;
  title: string;
  slug: string;
  platform: string[];
  release_date: Date | null;
  genre: string[];
  cover_url: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface GameCreate {
  title: string;
  slug: string;
  platform?: string[];
  release_date?: Date | string | null;
  genre?: string[];
  cover_url?: string | null;
  metadata?: Record<string, unknown>;
}

export interface GameUpdate {
  title?: string;
  slug?: string;
  platform?: string[];
  release_date?: Date | string | null;
  genre?: string[];
  cover_url?: string | null;
  metadata?: Record<string, unknown>;
}

const GAME_COLS = `
  id, title, slug, platform, release_date,
  genre, cover_url, metadata, created_at, updated_at
`;

// Whitelist colonne aggiornabili — nomi colonna sono costanti sviluppatore, non input utente.
const UPDATABLE_COLS = [
  "title", "slug", "platform", "release_date",
  "genre", "cover_url", "metadata",
] as const;

function buildSetClause(
  data: Record<string, unknown>,
  allowed: readonly string[],
): { clause: string; values: unknown[] } {
  const pairs = allowed
    .filter((col) => data[col] !== undefined)
    .map((col, i) => ({ col, ph: i + 1, val: data[col] }));
  if (pairs.length === 0) throw new Error("No updatable fields provided");
  return {
    clause: pairs.map((p) => `${p.col} = $${p.ph}`).join(", "),
    values: pairs.map((p) => p.val),
  };
}

export const GamesModel = {
  async findAll(limit: number, offset: number): Promise<GameRow[]> {
    try {
      const res = await query<GameRow>(
        `-- Elenca tutti i giochi ordinati alfabeticamente con paginazione.
         SELECT ${GAME_COLS}
         FROM games
         ORDER BY title
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return res.rows;
    } catch (err) {
      logger.error({ err }, "GamesModel.findAll failed");
      throw err;
    }
  },

  async findBySlug(slug: string): Promise<GameRow | null> {
    try {
      const res = await query<GameRow>(
        `-- Recupera gioco per slug (URL-friendly identifier univoco).
         SELECT ${GAME_COLS}
         FROM games
         WHERE slug = $1`,
        [slug],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, slug }, "GamesModel.findBySlug failed");
      throw err;
    }
  },

  async findById(id: number): Promise<GameRow | null> {
    try {
      const res = await query<GameRow>(
        `-- Recupera gioco per chiave primaria.
         SELECT ${GAME_COLS}
         FROM games
         WHERE id = $1`,
        [id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "GamesModel.findById failed");
      throw err;
    }
  },

  async search(searchQuery: string): Promise<GameRow[]> {
    try {
      const res = await query<GameRow>(
        `-- Ricerca fuzzy su title e slug via pg_trgm.
         -- L'indice idx_games_title_trgm (migration 002) accelera la similarity.
         SELECT ${GAME_COLS}
         FROM games
         WHERE title ILIKE '%' || $1 || '%'
            OR slug  ILIKE '%' || $1 || '%'
         ORDER BY similarity(title, $1) DESC
         LIMIT 10`,
        [searchQuery],
      );
      return res.rows;
    } catch (err) {
      logger.error({ err, searchQuery }, "GamesModel.search failed");
      throw err;
    }
  },

  /**
   * T3.2 — KF-3 Game disambiguation: come `search` ma espone il similarity
   * score al chiamante. Permette al normalizzatore di rilevare candidati
   * "ambigui" (top1 vicino a top2) e chiedere disambiguation all'utente.
   */
  async searchWithScores(
    searchQuery: string,
    limit = 5,
  ): Promise<Array<{ game: GameRow; similarity: number }>> {
    try {
      const res = await query<GameRow & { sim: number }>(
        `SELECT ${GAME_COLS}, similarity(title, $1) AS sim
         FROM games
         WHERE title ILIKE '%' || $1 || '%'
            OR slug  ILIKE '%' || $1 || '%'
         ORDER BY sim DESC
         LIMIT $2`,
        [searchQuery, limit],
      );
      return res.rows.map((r) => {
        const { sim, ...game } = r;
        return { game: game as GameRow, similarity: sim };
      });
    } catch (err) {
      logger.error({ err, searchQuery }, "GamesModel.searchWithScores failed");
      throw err;
    }
  },

  async create(data: GameCreate): Promise<GameRow> {
    try {
      const res = await query<GameRow>(
        `-- Inserisce nuovo gioco; slug deve essere univoco (constraint DB).
         INSERT INTO games (
           title, slug, platform, release_date, genre, cover_url, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${GAME_COLS}`,
        [
          data.title,
          data.slug,
          data.platform ?? [],
          data.release_date ?? null,
          data.genre ?? [],
          data.cover_url ?? null,
          data.metadata ?? {},
        ],
      );
      return res.rows[0]!;
    } catch (err) {
      logger.error({ err }, "GamesModel.create failed");
      throw err;
    }
  },

  async update(id: number, data: GameUpdate): Promise<GameRow | null> {
    try {
      const { clause, values } = buildSetClause(
        data as Record<string, unknown>,
        UPDATABLE_COLS,
      );
      const idIdx = values.length + 1;
      const res = await query<GameRow>(
        `-- Aggiorna gioco; colonne dinamiche da whitelist costante, valori parametrizzati.
         UPDATE games
         SET ${clause}, updated_at = NOW()
         WHERE id = $${idIdx}
         RETURNING ${GAME_COLS}`,
        [...values, id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "GamesModel.update failed");
      throw err;
    }
  },

  async count(): Promise<number> {
    try {
      const res = await query<{ count: string }>(
        `-- Conta il numero totale di giochi nel catalogo.
         SELECT COUNT(*) AS count FROM games`,
      );
      return parseInt(res.rows[0]?.count ?? "0", 10);
    } catch (err) {
      logger.error({ err }, "GamesModel.count failed");
      throw err;
    }
  },
};
