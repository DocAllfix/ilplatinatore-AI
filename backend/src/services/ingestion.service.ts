import { logger } from "@/utils/logger.js";
import { GuideDraftsModel, type GuideDraftRow, type DraftValidationError } from "@/models/guideDrafts.model.js";
import { GuidesModel, type GuideRow } from "@/models/guides.model.js";
import { enqueueLiveEmbedding } from "@/queues/embedding.queue.js";
import { slugify } from "@/services/guide.cache.js";
import { NotFoundError, ValidationError } from "@/utils/errors.js";

// ── Validation constants ──────────────────────────────────────────────────────

const MIN_CONTENT_LENGTH = 200;

// Sezioni minime attese per ogni guide_type (header markdown).
const REQUIRED_SECTIONS: Record<string, string[]> = {
  trophy:      ["## Requisiti", "## Passaggi"],
  walkthrough: ["## Panoramica", "## Walkthrough"],
  collectible: ["## Posizioni"],
  challenge:   ["## Strategia"],
  platinum:    ["## Fase 1", "## Fase 2"],
};

// Pattern di rifiuto LLM — il modello dichiara esplicitamente di non avere info.
const LLM_REFUSAL_PATTERNS = [
  "non ho informazioni sufficienti",
  "i don't have enough information",
  "non posso fornire",
  "i cannot provide",
  "non sono in grado",
];

// ── Slug generation ───────────────────────────────────────────────────────────

function buildGuideSlug(draft: GuideDraftRow): string {
  const titlePart = draft.title
    ? slugify(draft.title)
    : slugify(`${draft.guide_type ?? "guide"}-${draft.game_id ?? "unknown"}`);
  // 8-char UUID hex suffix guarantees uniqueness even for identical titles
  const suffix = draft.id.replace(/-/g, "").slice(0, 8);
  return titlePart ? `${titlePart}-${suffix}` : `guide-${suffix}`;
}

// ── Validation (5 layers) ─────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: DraftValidationError[];
}

export function validateDraft(draft: GuideDraftRow): ValidationResult {
  const errors: DraftValidationError[] = [];

  // Layer 1: content length
  if (!draft.content || draft.content.trim().length < MIN_CONTENT_LENGTH) {
    errors.push({
      layer: 1,
      message: `Contenuto troppo corto (minimo ${MIN_CONTENT_LENGTH} caratteri).`,
    });
  }

  // Layer 2: required markdown sections
  const guideType = draft.guide_type ?? "trophy";
  const required = REQUIRED_SECTIONS[guideType] ?? [];
  for (const section of required) {
    if (!draft.content.includes(section)) {
      errors.push({
        layer: 2,
        message: `Sezione richiesta mancante: '${section}'.`,
      });
    }
  }

  // Layer 3: game linkage (can't publish without a game)
  if (!draft.game_id) {
    errors.push({
      layer: 3,
      message: "La bozza non ha un game_id — impossibile pubblicare senza gioco associato.",
    });
  }

  // Layer 4: trophy guide must have a trophy_id
  if (draft.guide_type === "trophy" && !draft.trophy_id) {
    errors.push({
      layer: 4,
      message: "Le guide di tipo 'trophy' devono avere un trophy_id associato.",
    });
  }

  // Layer 5: LLM refusal markers (model declared insufficient context)
  const lowerContent = draft.content.toLowerCase();
  for (const pattern of LLM_REFUSAL_PATTERNS) {
    if (lowerContent.includes(pattern)) {
      errors.push({
        layer: 5,
        message: `Il contenuto contiene un marker di rifiuto LLM: '${pattern}'.`,
      });
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Ingestion pipeline ────────────────────────────────────────────────────────

export async function ingestApprovedDraft(draftId: string): Promise<GuideRow> {
  // Load draft
  const draft = await GuideDraftsModel.findById(draftId);
  if (!draft) throw new NotFoundError(`Draft ${draftId} non trovata`);

  // Idempotency: if already published, return the existing guide (before status guard)
  if (draft.published_guide_id) {
    logger.info({ draftId, guideId: draft.published_guide_id }, "ingestion: già pubblicata, skip");
    const existing = await GuidesModel.findById(draft.published_guide_id);
    if (existing) return existing;
  }

  // Status guard
  if (draft.status !== "approved") {
    throw new ValidationError(
      `Ingestion richiede status 'approved', trovato '${draft.status}'.`,
    );
  }

  // Validate content
  const validation = validateDraft(draft);
  if (!validation.valid) {
    await GuideDraftsModel.markFailed(draftId, validation.errors);
    logger.warn(
      { draftId, errors: validation.errors },
      "ingestion: bozza fallita validazione",
    );
    throw new ValidationError(
      `Validazione fallita: ${validation.errors.map((e) => e.message).join("; ")}`,
    );
  }

  // Build title and slug
  const meta = draft.search_metadata as { gameTitle?: string; targetName?: string };
  const title =
    draft.title ??
    (meta.targetName
      ? `Guide: ${meta.targetName}`
      : `Guide: ${draft.guide_type ?? "unknown"}`);

  const slug = buildGuideSlug(draft);

  // Create guide in guides table
  let guide: GuideRow;
  try {
    guide = await GuidesModel.create({
      game_id: draft.game_id!,
      trophy_id: draft.trophy_id,
      title,
      slug,
      content: draft.content,
      language: draft.language,
      guide_type: draft.guide_type,
      source: "chatbot",
      quality_score: draft.quality_score,
      verified: false,
      confidence_level: "generated",
      topic: draft.topic,
      embedding_pending: true,
    });
  } catch (err) {
    logger.error({ err, draftId }, "ingestion: GuidesModel.create failed");
    await GuideDraftsModel.markFailed(draftId, [
      { layer: 0, message: `DB insert failed: ${err instanceof Error ? err.message : String(err)}` },
    ]);
    throw err;
  }

  // Link draft to published guide — non-transactional, log if fails
  try {
    await GuideDraftsModel.markPublished(draftId, guide.id);
  } catch (err) {
    logger.error(
      { err, draftId, guideId: guide.id },
      "ingestion: markPublished failed — guide created but draft unlinked (admin recovery needed)",
    );
  }

  // Enqueue embedding with live priority
  try {
    await enqueueLiveEmbedding(guide.id);
  } catch (err) {
    logger.warn({ err, guideId: guide.id }, "ingestion: enqueueLiveEmbedding failed (non-fatal)");
  }

  logger.info({ draftId, guideId: guide.id, slug }, "ingestion: guida pubblicata con successo");
  return guide;
}
