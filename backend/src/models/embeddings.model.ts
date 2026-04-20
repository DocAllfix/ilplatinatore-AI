import type { PoolClient } from "pg";
import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

export interface EmbeddingInsert {
  chunk_index: number;
  chunk_text: string;
  embedding: number[]; // 768 floats per text-embedding-004
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
  ): Promise<number> {
    if (items.length === 0) return 0;
    try {
      // 4 colonne × N righe. Colonne hard-coded, valori parametrizzati.
      const values: unknown[] = [];
      const rows = items.map((item, i) => {
        const base = i * 4;
        // pgvector accetta stringhe "[f1,f2,...]" castate a vector.
        // Usiamo Number.toString() — supporta sia notazione decimale che scientifica.
        const vectorStr = `[${item.embedding.join(",")}]`;
        values.push(guideId, item.chunk_index, item.chunk_text, vectorStr);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::vector)`;
      });

      const res = await runQuery(
        client,
        `-- Bulk insert chunk embeddings. La stringa "[f1,...]" è castata a vector(768).
         INSERT INTO guide_embeddings (guide_id, chunk_index, chunk_text, embedding)
         VALUES ${rows.join(", ")}`,
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
};
