import { redis } from "@/config/redis.js";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";
import { generateGuide } from "@/services/llm.service.js";
import {
  GuideDraftsModel,
  type GuideDraftRow,
  type DraftSource,
  type DraftGuideType,
  type DraftStatus,
} from "@/models/guideDrafts.model.js";
import { NotFoundError, ValidationError } from "@/utils/errors.js";
import type { PromptContext } from "@/services/prompt.builder.js";
import { notifyNewDraft } from "@/services/notification.service.js";

const MAX_ITERATIONS = 5;
const CONV_KEY_PREFIX = "draft:conv:";

// ── Redis conversation state helpers ──────────────────────────────────────────

interface ConvEntry {
  role: "user" | "model";
  text: string;
  timestamp: number;
}

async function appendConvState(draftId: string, entry: ConvEntry): Promise<void> {
  const key = `${CONV_KEY_PREFIX}${draftId}`;
  try {
    const existing = await redis.get(key);
    const history: ConvEntry[] = existing ? (JSON.parse(existing) as ConvEntry[]) : [];
    history.push(entry);
    await redis.setex(key, env.DRAFT_TTL_SECONDS, JSON.stringify(history));
  } catch (err) {
    logger.warn({ err, draftId }, "draft.service: errore scrittura stato conversazione Redis");
  }
}

export async function getConvHistory(draftId: string): Promise<ConvEntry[]> {
  const key = `${CONV_KEY_PREFIX}${draftId}`;
  try {
    const raw = await redis.get(key);
    if (!raw) return [];
    return JSON.parse(raw) as ConvEntry[];
  } catch (err) {
    logger.warn({ err, draftId }, "draft.service: errore lettura stato conversazione Redis");
    return [];
  }
}

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface DraftCreateParams {
  content: string;
  sessionId: string | null;
  userId: number | null;
  gameId: number | null;
  trophyId: number | null;
  gameTitle: string;
  targetName: string;
  guideType: DraftGuideType | null;
  topic: string | null;
  language: string;
  originalQuery: string;
  sources: DraftSource[];
}

export interface DraftReviseResult {
  draftId: string;
  content: string;
  iterationCount: number;
  status: DraftStatus;
}

// ── Service methods ───────────────────────────────────────────────────────────

export async function createDraft(params: DraftCreateParams): Promise<GuideDraftRow> {
  try {
    const draft = await GuideDraftsModel.create({
      content: params.content,
      session_id: params.sessionId,
      user_id: params.userId,
      game_id: params.gameId,
      trophy_id: params.trophyId,
      guide_type: params.guideType,
      topic: params.topic,
      language: params.language,
      original_query: params.originalQuery,
      sources_json: params.sources,
      search_metadata: {
        gameTitle: params.gameTitle,
        targetName: params.targetName,
      },
    });

    await appendConvState(draft.id, {
      role: "model",
      text: params.content,
      timestamp: Date.now(),
    });

    // Fire-and-forget: notifica admin via webhook (timeout 3s, fail-open).
    // Il .catch() neutralizza il dangling promise; notifyNewDraft già non lancia,
    // ma manteniamo la guard per difesa in profondità.
    notifyNewDraft(draft).catch(() => {
      /* notifyNewDraft è fail-open per design — non si arriva qui */
    });

    logger.info({ draftId: draft.id, gameId: params.gameId }, "draft.service: bozza creata");
    return draft;
  } catch (err) {
    logger.error({ err }, "draft.service.createDraft failed");
    throw err;
  }
}

export async function getDraft(draftId: string): Promise<GuideDraftRow> {
  try {
    const draft = await GuideDraftsModel.findById(draftId);
    if (!draft) throw new NotFoundError(`Draft ${draftId} not found`);
    return draft;
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    logger.error({ err, draftId }, "draft.service.getDraft failed");
    throw err;
  }
}

export async function reviseDraft(
  draftId: string,
  feedback: string,
): Promise<DraftReviseResult> {
  const draft = await getDraft(draftId);

  if (draft.iteration_count >= MAX_ITERATIONS) {
    throw new ValidationError(
      `Raggiunto il limite massimo di ${MAX_ITERATIONS} revisioni. Approva o rifiuta la bozza.`,
    );
  }

  const meta = draft.search_metadata as {
    gameTitle?: string;
    targetName?: string;
  };

  const sanitizedFeedback = feedback.trim().slice(0, 500);

  const promptCtx: PromptContext = {
    ragContext: `CURRENT GUIDE CONTENT:\n\n${draft.content}`,
    gameTitle: meta.gameTitle ?? "unknown game",
    targetName: meta.targetName ?? draft.original_query ?? "guide",
    guideType: (draft.guide_type as PromptContext["guideType"]) ?? "walkthrough",
    language: "en",
    userQuery: `Revise this guide to address the following feedback: ${sanitizedFeedback}`,
  };

  let revised: string;
  try {
    const result = await generateGuide(promptCtx);
    revised = result.content;
  } catch (err) {
    logger.error({ err, draftId }, "draft.service.reviseDraft: LLM call failed");
    throw err;
  }

  // Increment counter atomically before update to avoid count/content drift
  const afterIncrement = await GuideDraftsModel.incrementIteration(draftId);
  const newCount = afterIncrement?.iteration_count ?? draft.iteration_count + 1;

  const newStatus: DraftStatus =
    newCount >= MAX_ITERATIONS ? "pending_approval" : "revision";

  await GuideDraftsModel.update(draftId, { content: revised });
  if (newStatus === "pending_approval") {
    await GuideDraftsModel.updateStatus(draftId, "pending_approval");
  } else {
    await GuideDraftsModel.updateStatus(draftId, "revision");
  }

  // Append both user feedback and model response to conversation log
  await appendConvState(draftId, {
    role: "user",
    text: sanitizedFeedback,
    timestamp: Date.now(),
  });
  await appendConvState(draftId, {
    role: "model",
    text: revised,
    timestamp: Date.now(),
  });

  logger.info(
    { draftId, iteration: newCount, status: newStatus },
    "draft.service: bozza revisionata",
  );

  return { draftId, content: revised, iterationCount: newCount, status: newStatus };
}

export async function approveDraft(draftId: string): Promise<GuideDraftRow> {
  const draft = await getDraft(draftId);

  if (draft.status !== "pending_approval") {
    throw new ValidationError(
      `La bozza non può essere approvata: status attuale '${draft.status}' (richiesto 'pending_approval').`,
    );
  }

  try {
    const updated = await GuideDraftsModel.markApproved(draftId);
    if (!updated) throw new NotFoundError(`Draft ${draftId} non trovata dopo markApproved`);
    logger.info({ draftId }, "draft.service: bozza approvata");
    return updated;
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ValidationError) throw err;
    logger.error({ err, draftId }, "draft.service.approveDraft failed");
    throw err;
  }
}

export async function rejectDraft(draftId: string): Promise<GuideDraftRow> {
  const draft = await getDraft(draftId);

  if (draft.status !== "pending_approval") {
    throw new ValidationError(
      `La bozza non può essere rifiutata: status attuale '${draft.status}' (richiesto 'pending_approval').`,
    );
  }

  try {
    const updated = await GuideDraftsModel.updateStatus(draftId, "rejected");
    if (!updated) throw new NotFoundError(`Draft ${draftId} non trovata dopo reject`);
    logger.info({ draftId }, "draft.service: bozza rifiutata");
    return updated;
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ValidationError) throw err;
    logger.error({ err, draftId }, "draft.service.rejectDraft failed");
    throw err;
  }
}
