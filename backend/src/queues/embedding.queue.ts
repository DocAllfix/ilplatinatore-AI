import { Queue, QueueEvents } from "bullmq";
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

// T1.5 — QueueEvents per `waitUntilFinished` quando un job in stato 'active'
// deve essere atteso da un caller live. Lazy-init (apre una connessione Redis
// aggiuntiva solo al primo uso) per non sprecare risorse in flow normali.
let _embeddingQueueEvents: QueueEvents | null = null;
export function getEmbeddingQueueEvents(): QueueEvents {
  if (_embeddingQueueEvents === null) {
    _embeddingQueueEvents = new QueueEvents("embedding", {
      connection: bullmqConnection.duplicate(),
    });
    _embeddingQueueEvents.on("error", (err: Error) => {
      logger.error({ err }, "QueueEvents 'embedding' error");
    });
  }
  return _embeddingQueueEvents;
}

export interface EmbedJobData {
  guideId: number;
}

// AUDIT FIX (R5-3 + R6-2): jobId stabile per deduplica BullMQ + priority-upgrade.
// Se lo scheduler notturno ha già accodato lo stesso guideId (priority=10) e l'utente
// apre la guida via UI, promuoviamo il job a priority=1 anziché fallire il duplicato.
//
// T1.5 — race condition fix: quando il job è in stato 'active' (sta processando
// in batch a priority=10 e l'utente lo richiede live) il caller deve attendere
// la completion. Restituiamo `awaitable` esposto come Promise opzionale:
// se il job è waiting/delayed/prioritized → upgrade priority sincrono;
// se è active → aspettiamo finché completa (con timeout di sicurezza);
// se è completed → resolve immediato;
// se è failed → re-enqueue con priority=1.
export async function enqueueLiveEmbedding(
  guideId: number,
  options: { waitForActive?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const jobId = `embed-${guideId}`;
  const { waitForActive = false, timeoutMs = 30_000 } = options;
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
      return;
    }

    if (state === "active") {
      // T1.5: il job sta già processando. Se il caller vuole sincronia
      // (waitForActive=true) attendiamo finché completa con safety timeout.
      // Di default loggiamo e ritorniamo — il caller riceverà il risultato
      // via cache/polling normale.
      logger.info(
        { guideId, jobId, waitForActive, timeoutMs },
        "Embedding job già active — race con batch scheduler",
      );
      if (waitForActive) {
        try {
          await existing.waitUntilFinished(getEmbeddingQueueEvents(), timeoutMs);
          logger.info({ guideId, jobId }, "Embedding job (race) completato");
        } catch (err) {
          logger.warn(
            { err, guideId, jobId },
            "Embedding job race timeout o failure — il caller dovrà ritentare",
          );
        }
      }
      return;
    }

    if (state === "completed") {
      // Job già fatto: niente da fare. Il caller troverà gli embedding in DB.
      return;
    }

    if (state === "failed") {
      // T1.5: re-enqueue al posto di rimanere in stato terminale.
      logger.warn(
        { guideId, jobId },
        "Embedding job in stato failed — re-enqueue con priority=1",
      );
      await existing.remove();
      // fallthrough → nuova add() qui sotto
    } else {
      // Stati transienti non previsti (es. 'unknown'): no-op difensivo.
      return;
    }
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
