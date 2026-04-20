import cron from "node-cron";
import { embeddingQueue } from "@/queues/embedding.queue.js";
import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

/**
 * Scheduler cron: 03:00 Europe/Rome, accoda fino a 1000 guide con embedding_pending=true.
 * AUDIT FIX (FF-NEW-3): è l'UNICO enqueuer batch. L'harvester Python NON deve
 * interagire con BullMQ/Redis per questo — marca solo embedding_pending=true nel DB.
 */
export function startEmbeddingScheduler(): void {
  cron.schedule(
    "0 3 * * *",
    async () => {
      const start = Date.now();
      try {
        const { rows } = await query<{ id: number }>(
          `-- Guide in attesa di embedding, FIFO (più vecchie prima).
           -- LIMIT 1000 per cap giornaliero: 1000 guide × ~3 chunk × 60ms API ≈ 3min.
           SELECT id FROM guides
           WHERE embedding_pending = true
           ORDER BY created_at ASC
           LIMIT 1000`,
        );
        logger.info({ count: rows.length }, "Embedding scheduler: enqueue batch");

        for (const { id } of rows) {
          await embeddingQueue.add(
            "embed",
            { guideId: id },
            {
              // AUDIT FIX (R5-3): jobId stabile → BullMQ rifiuta duplicati automaticamente.
              jobId: `embed-${id}`,
              priority: 10,
              attempts: 3,
              backoff: { type: "exponential", delay: 5000 },
            },
          );
        }

        logger.info(
          { count: rows.length, ms: Date.now() - start },
          "Embedding scheduler: enqueue completato",
        );
      } catch (err) {
        logger.error({ err }, "Embedding scheduler fallito");
      }
    },
    { timezone: "Europe/Rome" },
  );

  logger.info("Embedding scheduler avviato (03:00 Europe/Rome, daily)");
}
