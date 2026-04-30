import "dotenv/config";
import { fileURLToPath } from "node:url";
import { query, pool } from "@/config/database.js";
import { embeddingQueue, bullmqConnection } from "@/queues/embedding.queue.js";
import { logger } from "@/utils/logger.js";

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface EnqueueStats {
  found: number;
  enqueued: number;
  skipped: number;
  failed: number;
}

// ── Core logic ────────────────────────────────────────────────────────────────

export async function enqueuePendingGuides(batchSize = 100): Promise<EnqueueStats> {
  const stats: EnqueueStats = { found: 0, enqueued: 0, skipped: 0, failed: 0 };
  let lastId = 0;

  for (;;) {
    const res = await query<{ id: number }>(
      `-- Recupera guide con embedding_pending=true; cursor su id per paginazione O(log n).
       SELECT id FROM guides
       WHERE embedding_pending = true AND id > $1
       ORDER BY id ASC
       LIMIT $2`,
      [lastId, batchSize],
    );

    if (res.rows.length === 0) break;
    stats.found += res.rows.length;

    for (const row of res.rows) {
      try {
        await embeddingQueue.add(
          "embed",
          { guideId: row.id },
          {
            jobId: `embed-${row.id}`,
            priority: 10, // batch — non interferisce con live (priority=1)
            attempts: 3,
            backoff: { type: "exponential", delay: 5000 },
          },
        );
        stats.enqueued++;
      } catch (err) {
        const msg = String(err).toLowerCase();
        if (msg.includes("duplicate") || msg.includes("already exists")) {
          // Job già in coda — skip silenzioso
          stats.skipped++;
        } else {
          logger.warn({ err, guideId: row.id }, "re-embed: enqueue fallita");
          stats.failed++;
        }
      }
      lastId = row.id;
    }

    logger.info({ lastId, ...stats }, "re-embed: batch completato");
  }

  return stats;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const bsIdx = argv.indexOf("--batch-size");
  const batchSize = bsIdx >= 0 && argv[bsIdx + 1] ? parseInt(argv[bsIdx + 1]!, 10) : 100;

  logger.info({ batchSize }, "re-embed: avvio riaccodamento guide pending");
  const stats = await enqueuePendingGuides(batchSize);
  logger.info(stats, "re-embed: completato");
}

// Esegue main solo quando invocato direttamente (non in import per test).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let exitCode = 0;
  main()
    .catch((err) => {
      logger.error({ err }, "re-embed: errore fatale");
      exitCode = 1;
    })
    .finally(async () => {
      await embeddingQueue.close().catch(() => {});
      await bullmqConnection.quit().catch(() => {});
      await pool.end().catch(() => {});
      process.exit(exitCode);
    });
}
