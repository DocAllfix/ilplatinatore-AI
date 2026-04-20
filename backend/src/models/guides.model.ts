import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

export interface GuideRow {
  id: number;
  game_id: number;
  trophy_id: number | null;
  title: string;
  slug: string;
  content: string;
  content_html: string | null;
  language: string;
  guide_type: "trophy" | "walkthrough" | "collectible" | "challenge" | "platinum" | null;
  source: string;
  quality_score: number;
  verified: boolean;
  view_count: number;
  helpful_count: number;
  report_count: number;
  metadata: Record<string, unknown>;
  embedding_pending: boolean;
  confidence_level: "verified" | "harvested" | "generated" | "unverified";
  topic: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface GuideWithGame extends GuideRow {
  game_title: string;
  game_slug: string;
}

export interface GuideCreate {
  game_id: number;
  trophy_id?: number | null;
  title: string;
  slug: string;
  content: string;
  content_html?: string | null;
  language?: string;
  guide_type?: GuideRow["guide_type"];
  source?: string;
  quality_score?: number;
  verified?: boolean;
  metadata?: Record<string, unknown>;
  confidence_level?: GuideRow["confidence_level"];
  topic?: string | null;
  embedding_pending?: boolean;
}

export interface GuideUpdate {
  title?: string;
  slug?: string;
  content?: string;
  content_html?: string | null;
  language?: string;
  guide_type?: GuideRow["guide_type"];
  source?: string;
  quality_score?: number;
  verified?: boolean;
  metadata?: Record<string, unknown>;
  confidence_level?: GuideRow["confidence_level"];
  topic?: string | null;
  embedding_pending?: boolean;
}

export interface FindByGameOptions {
  guide_type?: string;
  language?: string;
  verified?: boolean;
  confidence_level?: string;
  limit?: number;
  offset?: number;
}

// search_vector è GENERATED ALWAYS — esclusa da SELECT, INSERT e RETURNING.
const GUIDE_COLS = `
  id, game_id, trophy_id, title, slug, content, content_html,
  language, guide_type, source, quality_score, verified,
  view_count, helpful_count, report_count, metadata,
  embedding_pending, confidence_level, topic, created_at, updated_at
`;

const GUIDE_WITH_GAME_COLS = `
  g.id, g.game_id, g.trophy_id, g.title, g.slug, g.content, g.content_html,
  g.language, g.guide_type, g.source, g.quality_score, g.verified,
  g.view_count, g.helpful_count, g.report_count, g.metadata,
  g.embedding_pending, g.confidence_level, g.topic, g.created_at, g.updated_at,
  gm.title AS game_title, gm.slug AS game_slug
`;

const UPDATABLE_COLS = [
  "title", "slug", "content", "content_html", "language", "guide_type",
  "source", "quality_score", "verified", "metadata",
  "confidence_level", "topic", "embedding_pending",
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

export const GuidesModel = {
  async findById(id: number): Promise<GuideWithGame | null> {
    try {
      const res = await query<GuideWithGame>(
        `-- Recupera guida per id con titolo e slug del gioco associato.
         SELECT ${GUIDE_WITH_GAME_COLS}
         FROM guides g
         JOIN games gm ON gm.id = g.game_id
         WHERE g.id = $1`,
        [id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "GuidesModel.findById failed");
      throw err;
    }
  },

  async findBySlug(slug: string): Promise<GuideWithGame | null> {
    try {
      const res = await query<GuideWithGame>(
        `-- Recupera guida per slug con titolo e slug del gioco associato.
         SELECT ${GUIDE_WITH_GAME_COLS}
         FROM guides g
         JOIN games gm ON gm.id = g.game_id
         WHERE g.slug = $1`,
        [slug],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, slug }, "GuidesModel.findBySlug failed");
      throw err;
    }
  },

  async findByGame(
    gameId: number,
    options: FindByGameOptions = {},
  ): Promise<GuideRow[]> {
    try {
      const conditions: string[] = ["g.game_id = $1"];
      const params: unknown[] = [gameId];
      let idx = 2;

      if (options.guide_type !== undefined) {
        conditions.push(`g.guide_type = $${idx++}`);
        params.push(options.guide_type);
      }
      if (options.language !== undefined) {
        conditions.push(`g.language = $${idx++}`);
        params.push(options.language);
      }
      if (options.verified !== undefined) {
        conditions.push(`g.verified = $${idx++}`);
        params.push(options.verified);
      }
      if (options.confidence_level !== undefined) {
        conditions.push(`g.confidence_level = $${idx++}`);
        params.push(options.confidence_level);
      }

      const limit = options.limit ?? 20;
      const offset = options.offset ?? 0;
      params.push(limit, offset);

      const res = await query<GuideRow>(
        `-- Recupera guide per gioco con filtri opzionali su tipo, lingua, stato.
         -- WHERE costruito da whitelist: condizioni aggiunge solo campi noti.
         SELECT ${GUIDE_COLS}
         FROM guides g
         WHERE ${conditions.join(" AND ")}
         ORDER BY g.quality_score DESC, g.view_count DESC
         LIMIT $${idx++} OFFSET $${idx}`,
        params,
      );
      return res.rows;
    } catch (err) {
      logger.error({ err, gameId, options }, "GuidesModel.findByGame failed");
      throw err;
    }
  },

  async fullTextSearch(
    searchQuery: string,
    gameId?: number,
  ): Promise<GuideWithGame[]> {
    try {
      const params: unknown[] = [searchQuery];
      let gameFilter = "";
      if (gameId !== undefined) {
        params.push(gameId);
        gameFilter = `AND g.game_id = $${params.length}`;
      }

      const res = await query<GuideWithGame>(
        `-- Ricerca full-text su search_vector (GENERATED da title+content, stemming italiano).
         -- plainto_tsquery normalizza l'input utente senza rischi di sintassi ts_query.
         -- ts_rank è calcolato solo nell'ORDER BY — non selezionato per evitare colonne extra.
         SELECT ${GUIDE_WITH_GAME_COLS}
         FROM guides g
         JOIN games gm ON gm.id = g.game_id
         WHERE g.search_vector @@ plainto_tsquery('italian', $1)
           ${gameFilter}
         ORDER BY ts_rank(g.search_vector, plainto_tsquery('italian', $1)) DESC
         LIMIT 20`,
        params,
      );
      return res.rows;
    } catch (err) {
      logger.error({ err, searchQuery, gameId }, "GuidesModel.fullTextSearch failed");
      throw err;
    }
  },

  async create(data: GuideCreate): Promise<GuideRow> {
    try {
      const res = await query<GuideRow>(
        `-- Inserisce nuova guida; search_vector è GENERATED ALWAYS, non inclusa nell'INSERT.
         INSERT INTO guides (
           game_id, trophy_id, title, slug, content, content_html,
           language, guide_type, source, quality_score, verified,
           metadata, confidence_level, topic, embedding_pending
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11,
           $12, $13, $14, $15
         )
         RETURNING ${GUIDE_COLS}`,
        [
          data.game_id,
          data.trophy_id ?? null,
          data.title,
          data.slug,
          data.content,
          data.content_html ?? null,
          data.language ?? "it",
          data.guide_type ?? null,
          data.source ?? "chatbot",
          data.quality_score ?? 0,
          data.verified ?? false,
          data.metadata ?? {},
          data.confidence_level ?? "generated",
          data.topic ?? null,
          data.embedding_pending ?? false,
        ],
      );
      return res.rows[0]!;
    } catch (err) {
      logger.error({ err }, "GuidesModel.create failed");
      throw err;
    }
  },

  async update(id: number, data: GuideUpdate): Promise<GuideRow | null> {
    try {
      const { clause, values } = buildSetClause(
        data as Record<string, unknown>,
        UPDATABLE_COLS,
      );
      const idIdx = values.length + 1;
      const res = await query<GuideRow>(
        `-- Aggiorna guida; updated_at sempre rinfrescato; colonne da whitelist costante.
         UPDATE guides
         SET ${clause}, updated_at = NOW()
         WHERE id = $${idIdx}
         RETURNING ${GUIDE_COLS}`,
        [...values, id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "GuidesModel.update failed");
      throw err;
    }
  },

  async incrementViewCount(id: number): Promise<void> {
    try {
      await query(
        `-- Incrementa atomicamente il contatore visualizzazioni senza race condition.
         UPDATE guides SET view_count = view_count + 1 WHERE id = $1`,
        [id],
      );
    } catch (err) {
      logger.error({ err, id }, "GuidesModel.incrementViewCount failed");
      throw err;
    }
  },

  async markAsVerified(id: number): Promise<GuideRow | null> {
    try {
      const res = await query<GuideRow>(
        `-- Marca guida come verificata e allinea confidence_level.
         UPDATE guides
         SET verified = true, confidence_level = 'verified', updated_at = NOW()
         WHERE id = $1
         RETURNING ${GUIDE_COLS}`,
        [id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "GuidesModel.markAsVerified failed");
      throw err;
    }
  },
};
