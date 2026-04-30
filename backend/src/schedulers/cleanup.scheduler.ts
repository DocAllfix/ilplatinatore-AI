import cron from "node-cron";
import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

/**
 * T2.3 + T2.4 — Cleanup scheduler: rimuove dati di osservabilità ed eventi
 * terminali oltre la retention policy.
 *
 * Tabelle gestite:
 *   - query_log         → retention 90 giorni (telemetry usage)
 *   - guide_drafts      → status terminali (rejected, failed) > 30 giorni
 *
 * Modalità: DELETE batched con LIMIT a step (50_000) per non lockare la
 * tabella in produzione. Loop finché ritorna < limit (zero righe rimaste).
 *
 * Schedule:
 *   02:30 Europe/Rome — query_log cleanup
 *   02:45 Europe/Rome — guide_drafts cleanup
 *
 * Fail-open: ogni catch logga errore ma non lancia. Il prossimo tick riprova.
 */

const QUERY_LOG_RETENTION_DAYS = 90;
const DRAFT_TERMINAL_RETENTION_DAYS = 30;
const BATCH_DELETE_LIMIT = 50_000;
const MAX_BATCH_ITERATIONS = 20; // safety cap → max 1M righe per run

async function deleteOldQueryLog(): Promise<number> {
  let totalDeleted = 0;
  for (let i = 0; i < MAX_BATCH_ITERATIONS; i++) {
    try {
      const res = await query(
        `-- Cleanup query_log batched (LIMIT per evitare lock prolungati).
         -- WHERE id IN (SELECT id ... LIMIT) consente al planner di usare l'indice
         -- su created_at e fare un loop di delete brevi invece di un singolo
         -- statement che lockerebbe l'intera tabella.
         DELETE FROM query_log
         WHERE id IN (
           SELECT id FROM query_log
           WHERE created_at < NOW() - INTERVAL '${QUERY_LOG_RETENTION_DAYS} days'
           LIMIT ${BATCH_DELETE_LIMIT}
         )`,
      );
      const deleted = res.rowCount ?? 0;
      totalDeleted += deleted;
      if (deleted < BATCH_DELETE_LIMIT) break;
    } catch (err) {
      logger.error({ err, iter: i }, "cleanup: query_log batch delete fallito");
      break; // fail-open: il prossimo run del cron riprova
    }
  }
  return totalDeleted;
}

async function deleteOldTerminalDrafts(): Promise<number> {
  let totalDeleted = 0;
  for (let i = 0; i < MAX_BATCH_ITERATIONS; i++) {
    try {
      const res = await query(
        `-- Cleanup guide_drafts in stato terminale (rejected, failed) > N giorni.
         -- 'published' NON è incluso: è uno stato terminale "ok" linkato a guides
         -- via published_guide_id e va conservato per audit/rollback.
         DELETE FROM guide_drafts
         WHERE id IN (
           SELECT id FROM guide_drafts
           WHERE status IN ('rejected', 'failed')
             AND updated_at < NOW() - INTERVAL '${DRAFT_TERMINAL_RETENTION_DAYS} days'
           LIMIT ${BATCH_DELETE_LIMIT}
         )`,
      );
      const deleted = res.rowCount ?? 0;
      totalDeleted += deleted;
      if (deleted < BATCH_DELETE_LIMIT) break;
    } catch (err) {
      logger.error({ err, iter: i }, "cleanup: guide_drafts batch delete fallito");
      break;
    }
  }
  return totalDeleted;
}

export function startCleanupScheduler(): void {
  // 02:30 — query_log
  cron.schedule(
    "30 2 * * *",
    async () => {
      const start = Date.now();
      const deleted = await deleteOldQueryLog();
      logger.info(
        { deleted, ms: Date.now() - start, retentionDays: QUERY_LOG_RETENTION_DAYS },
        "cleanup scheduler: query_log retention applied",
      );
    },
    { timezone: "Europe/Rome" },
  );

  // 02:45 — guide_drafts terminali
  cron.schedule(
    "45 2 * * *",
    async () => {
      const start = Date.now();
      const deleted = await deleteOldTerminalDrafts();
      logger.info(
        { deleted, ms: Date.now() - start, retentionDays: DRAFT_TERMINAL_RETENTION_DAYS },
        "cleanup scheduler: guide_drafts terminal retention applied",
      );
    },
    { timezone: "Europe/Rome" },
  );

  logger.info(
    {
      queryLogRetentionDays: QUERY_LOG_RETENTION_DAYS,
      draftTerminalRetentionDays: DRAFT_TERMINAL_RETENTION_DAYS,
    },
    "Cleanup scheduler avviato (02:30 + 02:45 Europe/Rome, daily)",
  );
}

// Esposto per test e per esecuzione manuale (admin runbook).
export const __cleanup = {
  deleteOldQueryLog,
  deleteOldTerminalDrafts,
  QUERY_LOG_RETENTION_DAYS,
  DRAFT_TERMINAL_RETENTION_DAYS,
};
