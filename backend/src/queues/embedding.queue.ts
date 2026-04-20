import { Queue } from "bullmq";
import IORedisModule from "ioredis";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";

// Stesso pattern di src/config/redis.ts — compatibilità ESM/CJS default export.
const IORedis = IORedisModule.default ?? IORedisModule;

// AUDIT FIX: BullMQ richiede `maxRetriesPerRequest: null` — NON possiamo riusare
// il client ioredis in src/config/redis.ts (maxRetriesPerRequest: 3).
// Instanzia una connection dedicata per le code.
export const bullmqConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

bullmqConnection.on("error", (err: Error) => {
  logger.error({ err }, "BullMQ Redis connection error");
});

// AUDIT FIX (R6 — Shared Gemini Rate Limiter): UNICA coda embedding.
// priority=1 → job live (UI), priority=10 → job batch (harvester notturno).
// Il rate limit Gemini è condiviso automaticamente a livello di worker.
export const embeddingQueue = new Queue("embedding", {
  connection: bullmqConnection,
});

export interface EmbedJobData {
  guideId: number;
}

// AUDIT FIX (R5-3 + R6-2): jobId stabile per deduplica BullMQ + priority-upgrade.
// Se lo scheduler notturno ha già accodato lo stesso guideId (priority=10) e l'utente
// apre la guida via UI, promuoviamo il job a priority=1 anziché fallire il duplicato.
export async function enqueueLiveEmbedding(guideId: number): Promise<void> {
  const jobId = `embed-${guideId}`;
  const existing = await embeddingQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    if (state === "waiting" || state === "delayed" || state === "prioritized") {
      const currentPriority = existing.opts.priority ?? 0;
      if (currentPriority > 1) {
        await existing.changePriority({ priority: 1 });
        logger.info(
          { guideId, jobId, from: currentPriority, to: 1 },
          "Embedding job priority upgraded (R6-2)",
        );
      }
    }
    // 'active' | 'completed' | 'failed' → nulla da fare.
    return;
  }

  await embeddingQueue.add(
    "embed",
    { guideId },
    {
      jobId,
      priority: 1,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  );
}
