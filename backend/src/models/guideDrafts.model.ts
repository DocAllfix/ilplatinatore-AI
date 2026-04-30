import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

// ── Local types (no cross-layer imports) ──────────────────────────────────────

export type DraftStatus =
  | "draft"
  | "revision"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "published"
  | "failed";

export type DraftGuideType =
  | "trophy"
  | "walkthrough"
  | "collectible"
  | "challenge"
  | "platinum";

export interface DraftSource {
  url: string;
  domain: string;
  reliability: number;
}

export interface DraftValidationError {
  layer: number;
  message: string;
}

// ── Row interface (mirrors migration 025 columns) ─────────────────────────────

export interface GuideDraftRow {
  id: string;
  session_id: string | null;
  user_id: number | null;
  game_id: number | null;
  trophy_id: number | null;
  title: string | null;
  slug: string | null;
  content: string;
  language: string;
  guide_type: DraftGuideType | null;
  topic: string | null;
  status: DraftStatus;
  iteration_count: number;
  original_query: string | null;
  sources_json: DraftSource[];
  search_metadata: Record<string, unknown>;
  quality_score: number;
  validation_errors: DraftValidationError[];
  created_at: Date;
  updated_at: Date;
  approved_at: Date | null;
  published_at: Date | null;
  published_guide_id: number | null;
}

// ── Create / Update interfaces ────────────────────────────────────────────────

export interface DraftCreate {
  content: string;
  session_id?: string | null;
  user_id?: number | null;
  game_id?: number | null;
  trophy_id?: number | null;
  title?: string | null;
  slug?: string | null;
  language?: string;
  guide_type?: DraftGuideType | null;
  topic?: string | null;
  original_query?: string | null;
  sources_json?: DraftSource[];
  search_metadata?: Record<string, unknown>;
  quality_score?: number;
}

export interface DraftUpdate {
  title?: string | null;
  slug?: string | null;
  content?: string;
  language?: string;
  guide_type?: DraftGuideType | null;
  topic?: string | null;
  original_query?: string | null;
  sources_json?: DraftSource[];
  search_metadata?: Record<string, unknown>;
  quality_score?: number;
  validation_errors?: DraftValidationError[];
}

// ── Column constants ──────────────────────────────────────────────────────────

// Tutti i 23 campi — nessuna colonna GENERATED (guide_drafts non ne ha).
const DRAFT_COLS = `
  id, session_id, user_id, game_id, trophy_id,
  title, slug, content, language, guide_type, topic,
  status, iteration_count, original_query,
  sources_json, search_metadata, quality_score, validation_errors,
  created_at, updated_at, approved_at, published_at, published_guide_id
`;

// Campi aggiornabili via update() generico.
// ESCLUSI intenzionalmente: status (solo metodi dedicati), iteration_count
// (solo incrementIteration), session_id/user_id/game_id/trophy_id (immutabili dopo create).
const UPDATABLE_COLS = [
  "title",
  "slug",
  "content",
  "language",
  "guide_type",
  "topic",
  "original_query",
  "sources_json",
  "search_metadata",
  "quality_score",
  "validation_errors",
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

// ── Model ─────────────────────────────────────────────────────────────────────

export const GuideDraftsModel = {
  async create(data: DraftCreate): Promise<GuideDraftRow> {
    try {
      const res = await query<GuideDraftRow>(
        `-- Inserisce bozza; status DEFAULT 'draft' (DB), id UUID generato da gen_random_uuid().
         INSERT INTO guide_drafts (
           session_id, user_id, game_id, trophy_id,
           title, slug, content, language, guide_type, topic,
           original_query, sources_json, search_metadata, quality_score
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14
         )
         RETURNING ${DRAFT_COLS}`,
        [
          data.session_id ?? null,
          data.user_id ?? null,
          data.game_id ?? null,
          data.trophy_id ?? null,
          data.title ?? null,
          data.slug ?? null,
          data.content,
          data.language ?? "en",
          data.guide_type ?? null,
          data.topic ?? null,
          data.original_query ?? null,
          data.sources_json ?? [],
          data.search_metadata ?? {},
          data.quality_score ?? 0,
        ],
      );
      return res.rows[0]!;
    } catch (err) {
      logger.error({ err }, "GuideDraftsModel.create failed");
      throw err;
    }
  },

  async findById(id: string): Promise<GuideDraftRow | null> {
    try {
      const res = await query<GuideDraftRow>(
        `-- Recupera bozza per UUID.
         SELECT ${DRAFT_COLS}
         FROM guide_drafts
         WHERE id = $1`,
        [id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "GuideDraftsModel.findById failed");
      throw err;
    }
  },

  async findBySession(
    sessionId: string,
    limit = 10,
  ): Promise<GuideDraftRow[]> {
    try {
      const res = await query<GuideDraftRow>(
        `-- Recupera bozze per session_id, più recenti prima.
         SELECT ${DRAFT_COLS}
         FROM guide_drafts
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [sessionId, limit],
      );
      return res.rows;
    } catch (err) {
      logger.error({ err, sessionId }, "GuideDraftsModel.findBySession failed");
      throw err;
    }
  },

  async update(id: string, data: DraftUpdate): Promise<GuideDraftRow | null> {
    try {
      const { clause, values } = buildSetClause(
        data as Record<string, unknown>,
        UPDATABLE_COLS,
      );
      const idIdx = values.length + 1;
      const res = await query<GuideDraftRow>(
        `-- Aggiorna campi contenuto bozza; status escluso (solo metodi dedicati).
         UPDATE guide_drafts
         SET ${clause}, updated_at = NOW()
         WHERE id = $${idIdx}
         RETURNING ${DRAFT_COLS}`,
        [...values, id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "GuideDraftsModel.update failed");
      throw err;
    }
  },

  async updateStatus(
    id: string,
    status: DraftStatus,
  ): Promise<GuideDraftRow | null> {
    try {
      const res = await query<GuideDraftRow>(
        `-- Transizione FSM generica (draft→revision, revision→pending_approval, pending_approval→rejected).
         -- Per transizioni con timestamp dedicato (approved, published, failed) usare metodi specifici.
         UPDATE guide_drafts
         SET status = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING ${DRAFT_COLS}`,
        [status, id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id, status }, "GuideDraftsModel.updateStatus failed");
      throw err;
    }
  },

  async markApproved(id: string): Promise<GuideDraftRow | null> {
    try {
      const res = await query<GuideDraftRow>(
        `-- Marca bozza come approvata con timestamp.
         UPDATE guide_drafts
         SET status = 'approved', approved_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING ${DRAFT_COLS}`,
        [id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "GuideDraftsModel.markApproved failed");
      throw err;
    }
  },

  async markPublished(
    id: string,
    guideId: number,
  ): Promise<GuideDraftRow | null> {
    try {
      const res = await query<GuideDraftRow>(
        `-- Marca bozza come pubblicata; published_guide_id collega alla guida inserita.
         -- Chiamato dall'ingestion service dentro una transazione con GuidesModel.create.
         UPDATE guide_drafts
         SET status = 'published',
             published_at = NOW(),
             published_guide_id = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING ${DRAFT_COLS}`,
        [guideId, id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id, guideId }, "GuideDraftsModel.markPublished failed");
      throw err;
    }
  },

  async markFailed(
    id: string,
    errors: DraftValidationError[],
  ): Promise<GuideDraftRow | null> {
    try {
      const res = await query<GuideDraftRow>(
        `-- Marca bozza come fallita con dettaglio errori di validazione.
         UPDATE guide_drafts
         SET status = 'failed',
             validation_errors = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING ${DRAFT_COLS}`,
        [errors, id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "GuideDraftsModel.markFailed failed");
      throw err;
    }
  },

  async incrementIteration(id: string): Promise<GuideDraftRow | null> {
    try {
      const res = await query<GuideDraftRow>(
        `-- Incrementa atomicamente il contatore revisioni senza race condition.
         UPDATE guide_drafts
         SET iteration_count = iteration_count + 1, updated_at = NOW()
         WHERE id = $1
         RETURNING ${DRAFT_COLS}`,
        [id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "GuideDraftsModel.incrementIteration failed");
      throw err;
    }
  },

  async getPendingApproval(
    limit = 20,
    offset = 0,
  ): Promise<GuideDraftRow[]> {
    try {
      const res = await query<GuideDraftRow>(
        `-- Coda approvazione: bozze in attesa, ordinate per anzianità (FIFO).
         -- L'indice parziale idx_guide_drafts_pending (migration 025) rende la scan veloce.
         SELECT ${DRAFT_COLS}
         FROM guide_drafts
         WHERE status = 'pending_approval'
         ORDER BY created_at ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return res.rows;
    } catch (err) {
      logger.error({ err }, "GuideDraftsModel.getPendingApproval failed");
      throw err;
    }
  },

  async findByStatus(
    status: DraftStatus,
    limit = 20,
    offset = 0,
  ): Promise<GuideDraftRow[]> {
    try {
      const res = await query<GuideDraftRow>(
        `-- Lista filtrata per status (admin dashboard). idx_guide_drafts_status copre il filtro.
         SELECT ${DRAFT_COLS}
         FROM guide_drafts
         WHERE status = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [status, limit, offset],
      );
      return res.rows;
    } catch (err) {
      logger.error({ err, status }, "GuideDraftsModel.findByStatus failed");
      throw err;
    }
  },

  async countByStatus(status: DraftStatus): Promise<number> {
    try {
      const res = await query<{ count: string }>(
        `-- Conta bozze per stato (paginazione + dashboard).
         SELECT COUNT(*)::text AS count FROM guide_drafts WHERE status = $1`,
        [status],
      );
      return parseInt(res.rows[0]?.count ?? "0", 10);
    } catch (err) {
      logger.error({ err, status }, "GuideDraftsModel.countByStatus failed");
      throw err;
    }
  },

  async getStats(): Promise<Record<DraftStatus, number>> {
    try {
      const res = await query<{ status: DraftStatus; count: string }>(
        `-- Snapshot di tutti gli stati FSM in una sola query (dashboard admin).
         SELECT status, COUNT(*)::text AS count
         FROM guide_drafts
         GROUP BY status`,
      );
      const stats: Record<DraftStatus, number> = {
        draft: 0,
        revision: 0,
        pending_approval: 0,
        approved: 0,
        rejected: 0,
        published: 0,
        failed: 0,
      };
      for (const row of res.rows) {
        stats[row.status] = parseInt(row.count, 10);
      }
      return stats;
    } catch (err) {
      logger.error({ err }, "GuideDraftsModel.getStats failed");
      throw err;
    }
  },
};
