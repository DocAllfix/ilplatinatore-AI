import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

export interface EmbeddingInsert {
  chunk_index: number;
  chunk_text: string;
  embedding: number[]; // 768 floats — gemini-embedding-001 truncated MRL
}

/**
 * sha256 hex del chunk_text — usato come chiave idempotency in
 * UNIQUE (guide_id, chunk_hash, embedding_model).
 * T1.6: l'INSERT usa ON CONFLICT DO NOTHING su questo hash così retry
 * parziali non creano duplicati né scartano embedding già scritti.
 */
export function chunkHash(chunkText: string): string {
  return createHash("sha256").update(chunkText).digest("hex");
}

// Helper: esegue query su un PoolClient fornito (transazione) o sul pool globale.
type Executor = Pick<PoolClient, "query"> | null;
async function runQuery(
  executor: Executor,
  text: string,
  values: unknown[],
): Promise<{ rowCount: number }> {
  if (executor) {
    const res = await executor.query(text, values);
    return { rowCount: res.rowCount ?? 0 };
  }
  const res = await query(text, values);
  return { rowCount: res.rowCount ?? 0 };
}

export const EmbeddingsModel = {
  async deleteByGuide(
    guideId: number,
    client: PoolClient | null = null,
  ): Promise<number> {
    try {
      const res = await runQuery(
        client,
        `-- Cancella TUTTI gli embedding della guida prima del re-embedding.
         -- Il constraint FK guide_id ON DELETE CASCADE (migration 005) garantisce
         -- che non ci siano orfani se la guida viene eliminata.
         DELETE FROM guide_embeddings WHERE guide_id = $1`,
        [guideId],
      );
      return res.rowCount;
    } catch (err) {
      logger.error({ err, guideId }, "EmbeddingsModel.deleteByGuide failed");
      throw err;
    }
  },

  async insertBatch(
    guideId: number,
    items: EmbeddingInsert[],
    client: PoolClient | null = null,
    options: { language?: string; embeddingModel?: string } = {},
  ): Promise<number> {
    if (items.length === 0) return 0;
    const language = options.language ?? "en";
    const embeddingModel = options.embeddingModel ?? "gemini-embedding-001";
    try {
      // T1.6 — colonne ora 7: aggiungiamo language, embedding_model, chunk_hash.
      // ON CONFLICT (guide_id, chunk_hash, embedding_model) DO NOTHING garantisce
      // idempotency su retry parziali (un chunk già scritto non viene duplicato,
      // né causa abort della transazione).
      const values: unknown[] = [];
      const rows = items.map((item, i) => {
        const base = i * 7;
        const vectorStr = `[${item.embedding.join(",")}]`;
        const hash = chunkHash(item.chunk_text);
        values.push(
          guideId,
          item.chunk_index,
          item.chunk_text,
          vectorStr,
          language,
          embeddingModel,
          hash,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::vector, $${base + 5}, $${base + 6}, $${base + 7})`;
      });

      const res = await runQuery(
        client,
        `-- Bulk insert chunk embeddings idempotente (T1.6).
         -- ON CONFLICT su (guide_id, chunk_hash, embedding_model): se un retry
         -- BullMQ riarriva con chunk già scritto, salta silenziosamente.
         INSERT INTO guide_embeddings (
           guide_id, chunk_index, chunk_text, embedding,
           language, embedding_model, chunk_hash
         )
         VALUES ${rows.join(", ")}
         ON CONFLICT ON CONSTRAINT guide_embeddings_chunk_uniq DO NOTHING`,
        values,
      );
      return res.rowCount;
    } catch (err) {
      logger.error(
        { err, guideId, count: items.length },
        "EmbeddingsModel.insertBatch failed",
      );
      throw err;
    }
  },

  /**
   * T1.6 — ritorna il set di chunk_hash già presenti per una guide.
   * Permette al service di skippare chunk già embeddati senza chiamare l'API.
   */
  async existingHashes(
    guideId: number,
    embeddingModel: string,
    client: PoolClient | null = null,
  ): Promise<Set<string>> {
    try {
      const sql = `-- Restituisce gli hash dei chunk già embeddati per la guide+model.
                   SELECT chunk_hash FROM guide_embeddings
                   WHERE guide_id = $1 AND embedding_model = $2`;
      const params = [guideId, embeddingModel];
      const res = client
        ? await client.query<{ chunk_hash: string }>(sql, params)
        : await query<{ chunk_hash: string }>(sql, params);
      return new Set(res.rows.map((r) => r.chunk_hash));
    } catch (err) {
      logger.error({ err, guideId }, "EmbeddingsModel.existingHashes failed");
      throw err;
    }
  },
};
