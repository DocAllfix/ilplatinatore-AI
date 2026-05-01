import { Worker, type Job } from "bullmq";
import { bullmqConnection, type EmbedJobData } from "@/queues/embedding.queue.js";
import { EmbeddingService } from "@/services/embedding.service.js";
import { logger } from "@/utils/logger.js";

async function embeddingProcessor(job: Job<EmbedJobData>): Promise<void> {
  const { guideId } = job.data;
  logger.info(
    { guideId, jobId: job.id, priority: job.opts.priority, attempt: job.attemptsMade + 1 },
    "Processing embed job",
  );
  await EmbeddingService.embedAndStoreGuide(guideId);
}

export function startEmbeddingWorker(): Worker<EmbedJobData> {
  // AUDIT FIX (Fatal Flaw #4 + R6): concurrency + limiter + cleanup automatico.
  //  - concurrency=2 → max 2 job concorrenti (non satura PgBouncer pool).
  //  - limiter max=20/sec → ben sotto i 25 RPS (1500 RPM) di gemini-embedding-001.
  //  - removeOnComplete/Fail → cleanup automatico, Redis non si gonfia.
  // NOTA: `limiter.groupKey` è una feature BullMQ Pro. Nella OSS v5 il limiter è
  //   PER-WORKER. Con 1 worker + 1 replica (regola #11 CLAUDE.md) siamo comunque
  //   sotto ai 1500 RPM. Per scaling orizzontale servirà BullMQ Pro o token-bucket
  //   Redis custom — vedi regola #11.
  const worker = new Worker<EmbedJobData>("embedding", embeddingProcessor, {
    connection: bullmqConnection,
    concurrency: 2,
    limiter: {
      max: 20,
      duration: 1000,
    },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400 },
  });

  worker.on("completed", (job) => {
    logger.debug(
      { jobId: job.id, guideId: job.data.guideId },
      "Embed job completed",
    );
  });
  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, guideId: job?.data.guideId, attempt: job?.attemptsMade, err },
      "Embed job failed",
    );
  });
  worker.on("error", (err) => {
    logger.error({ err }, "Embedding worker error");
  });

  logger.info("Embedding worker avviato (concurrency=2, limiter=20/s)");
  return worker;
}
