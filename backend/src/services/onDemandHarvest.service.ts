import { query } from "@/config/database.js";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";

/**
 * On-Demand Live Harvesting service (Fase 25).
 *
 * Flusso:
 *   1. Orchestrator: RAG fail → `triggerHarvest(query, userId, gameId?)`
 *      → INSERT pending in `on_demand_requests`, ritorna requestId.
 *   2. Worker Python: `on_demand_worker.py` polla la tabella, processa, marca completed/failed.
 *   3. Orchestrator: `pollRequest(requestId, timeoutMs)` con backoff 2s,
 *      ritorna `{ status, guideId? }` quando worker termina o timeout.
 *
 * Feature-flagged: `env.ON_DEMAND_HARVEST_ENABLED=false` di default.
 * Quando OFF, `triggerHarvest` lancia errore esplicito — il caller controlla il flag.
 */

export type OnDemandStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "timeout";

export interface OnDemandResult {
  requestId: number;
  status: OnDemandStatus;
  guideId: number | null;
  errorMessage: string | null;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Inserisce una richiesta pending. Il worker Python la processerà.
 * NON aspetta il completamento — il caller usa `pollRequest()` separatamente.
 */
async function triggerHarvest(
  userQuery: string,
  userId: number | null,
  gameId: number | null = null,
): Promise<number> {
  if (!env.ON_DEMAND_HARVEST_ENABLED) {
    throw new Error("ON_DEMAND_HARVEST_ENABLED is false — caller should have checked the flag");
  }
  const trimmed = userQuery.trim();
  if (!trimmed) {
    throw new Error("triggerHarvest: empty query");
  }
  const { rows } = await query<{ id: number }>(
    `-- Insert pending on-demand request. Worker Python pollerà entro 5s.
     INSERT INTO on_demand_requests (user_id, query, game_id, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id`,
    [userId, trimmed, gameId],
  );
  const requestId = rows[0]!.id;
  logger.info({ requestId, userId, gameId, queryLen: trimmed.length }, "On-demand harvest triggered");
  return requestId;
}

/**
 * Polling backoff su `on_demand_requests` finché status terminale (completed/failed)
 * o timeout. Quando timeout, marca status='timeout' (best-effort) e ritorna.
 *
 * Il caller può inoltre cancellare il polling lato client (es. utente refresh):
 * il worker continuerà comunque, e la guide creata sarà disponibile per future query.
 */
async function pollRequest(
  requestId: number,
  timeoutMs: number = env.ON_DEMAND_HARVEST_TIMEOUT_MS,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): Promise<OnDemandResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { rows } = await query<{
      status: OnDemandStatus;
      guide_id: number | null;
      error_message: string | null;
    }>(
      `-- Check status corrente della richiesta on-demand.
       SELECT status, guide_id, error_message
       FROM on_demand_requests
       WHERE id = $1`,
      [requestId],
    );
    if (rows.length === 0) {
      throw new Error(`On-demand request ${requestId} non trovata`);
    }
    const row = rows[0]!;
    if (row.status === "completed" || row.status === "failed") {
      logger.info(
        { requestId, status: row.status, guideId: row.guide_id, ms: timeoutMs - (deadline - Date.now()) },
        "On-demand harvest terminale",
      );
      return {
        requestId,
        status: row.status,
        guideId: row.guide_id,
        errorMessage: row.error_message,
      };
    }
    await sleep(pollIntervalMs);
  }

  // Timeout: best-effort marca timeout (worker potrebbe completare dopo, fine).
  await query(
    `-- Marca status timeout solo se ancora pending/processing (no race override).
     UPDATE on_demand_requests
     SET status = 'timeout', completed_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'processing')`,
    [requestId],
  );
  logger.warn({ requestId, timeoutMs }, "On-demand harvest timeout");
  return {
    requestId,
    status: "timeout",
    guideId: null,
    errorMessage: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const OnDemandHarvestService = {
  triggerHarvest,
  pollRequest,
};
