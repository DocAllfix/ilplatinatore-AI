import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";
import type { GuideDraftRow } from "@/models/guideDrafts.model.js";

// ── Payload schema ────────────────────────────────────────────────────────────

export interface DraftCreatedPayload {
  event: "draft.created";
  draftId: string;
  gameTitle: string;
  targetName: string;
  guideType: string | null;
  originalQuery: string | null;
  language: string;
  dashboardUrl: string | null;
  createdAt: string;
}

// Timeout fetch — il webhook NON deve bloccare la response al chatbot.
const WEBHOOK_TIMEOUT_MS = 3000;

// ── Builder ───────────────────────────────────────────────────────────────────

function buildPayload(draft: GuideDraftRow): DraftCreatedPayload {
  const meta = draft.search_metadata as { gameTitle?: string; targetName?: string };
  return {
    event: "draft.created",
    draftId: draft.id,
    gameTitle: meta.gameTitle ?? "unknown",
    targetName: meta.targetName ?? draft.original_query ?? "unknown",
    guideType: draft.guide_type,
    originalQuery: draft.original_query,
    language: draft.language,
    dashboardUrl: env.ADMIN_DASHBOARD_URL
      ? `${env.ADMIN_DASHBOARD_URL.replace(/\/$/, "")}/drafts/${draft.id}`
      : null,
    createdAt:
      draft.created_at instanceof Date
        ? draft.created_at.toISOString()
        : String(draft.created_at),
  };
}

// ── Sender (fail-open) ────────────────────────────────────────────────────────

export async function notifyNewDraft(draft: GuideDraftRow): Promise<void> {
  if (!env.ADMIN_WEBHOOK_URL) {
    // No-op silenzioso quando il webhook non è configurato.
    logger.debug({ draftId: draft.id }, "notification: ADMIN_WEBHOOK_URL non configurato, skip");
    return;
  }

  const payload = buildPayload(draft);

  // AbortController per timeout — un webhook lento non deve allungare la response chat.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetch(env.ADMIN_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(
        { draftId: draft.id, status: res.status },
        "notification: webhook risposto con status non-2xx (non-fatal)",
      );
      return;
    }
    logger.info({ draftId: draft.id }, "notification: webhook inviato");
  } catch (err) {
    // Fail-open: timeout, DNS, connection refused — non bloccare l'utente.
    logger.warn({ err, draftId: draft.id }, "notification: webhook fallito (non-fatal)");
  } finally {
    clearTimeout(timer);
  }
}
