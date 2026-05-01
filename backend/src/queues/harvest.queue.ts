import { Queue } from "bullmq";
import { bullmqConnection } from "@/queues/embedding.queue.js";

/**
 * Harvest queue (Fase 25) — On-Demand Live Harvesting.
 *
 * NOTA architetturale: il worker che processa questi job NON gira nel backend
 * Node.js (Fase 25 → harvester Python `on_demand_worker.py`). Questa coda è
 * un canale di segnale: il backend può aggiungere job qui per fare push notification
 * via Redis al worker Python (futuro miglioramento) oppure il worker Python può
 * pollare direttamente la tabella `on_demand_requests`.
 *
 * Per la Pre-Beta baseline implementiamo polling DB-driven dal worker (più robusto:
 * sopravvive a Redis crash). Questa coda esiste come opzione futura per push reattivo.
 *
 * Riusa la connection BullMQ già allocata da embedding.queue.ts (non serve creare
 * una seconda Redis connection — `maxRetriesPerRequest: null` è condiviso).
 */
export const harvestQueue = new Queue("harvest", {
  connection: bullmqConnection,
});

export interface HarvestJobData {
  requestId: number;
  query: string;
  userId: number | null;
  gameId: number | null;
}
