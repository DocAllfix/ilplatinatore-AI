import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "@/utils/asyncHandler.js";
import { validate } from "@/middleware/validate.js";
import { optionalAuth, requireAuth } from "@/middleware/auth.middleware.js";
import { NotFoundError } from "@/utils/errors.js";
import {
  getDraft,
  reviseDraft,
  approveDraft,
  rejectDraft,
  getConvHistory,
} from "@/services/draft.service.js";
import { ingestApprovedDraft } from "@/services/ingestion.service.js";
import { GuideDraftsModel } from "@/models/guideDrafts.model.js";

export const draftRouter = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const uuidParam = z.string().uuid();

const reviseBodySchema = z.object({
  feedback: z.string().trim().min(1, "Il feedback non può essere vuoto").max(500),
});

const rejectBodySchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});

const pendingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseUuidOrThrow(raw: string): string {
  const result = uuidParam.safeParse(raw);
  if (!result.success) throw new NotFoundError("Bozza non trovata");
  return result.data;
}

// ── GET /api/draft/pending ────────────────────────────────────────────────────
// IMPORTANTE: deve essere registrata PRIMA di /:id per evitare che Express
// catturi la stringa "pending" come valore del parametro id.
draftRouter.get(
  "/pending",
  requireAuth,
  validate(pendingQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = req.query as unknown as z.infer<
      typeof pendingQuerySchema
    >;
    const drafts = await GuideDraftsModel.getPendingApproval(limit, offset);
    res.json({ data: drafts, meta: { limit, offset, total: drafts.length } });
  }),
);

// ── GET /api/draft/:id ────────────────────────────────────────────────────────
draftRouter.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseUuidOrThrow(req.params.id as string);
    const draft = await getDraft(id);
    res.json({ data: draft });
  }),
);

// ── GET /api/draft/:id/history ────────────────────────────────────────────────
draftRouter.get(
  "/:id/history",
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseUuidOrThrow(req.params.id as string);
    // Verify draft exists before returning history
    await getDraft(id);
    const history = await getConvHistory(id);
    res.json({ data: history });
  }),
);

// ── POST /api/draft/:id/revise ────────────────────────────────────────────────
draftRouter.post(
  "/:id/revise",
  optionalAuth,
  validate(reviseBodySchema, "body"),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseUuidOrThrow(req.params.id as string);
    const { feedback } = req.body as z.infer<typeof reviseBodySchema>;
    const result = await reviseDraft(id, feedback);
    res.json({ data: result });
  }),
);

// ── POST /api/draft/:id/approve ───────────────────────────────────────────────
draftRouter.post(
  "/:id/approve",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseUuidOrThrow(req.params.id as string);
    const draft = await approveDraft(id);
    res.json({ data: draft });
  }),
);

// ── POST /api/draft/:id/reject ────────────────────────────────────────────────
draftRouter.post(
  "/:id/reject",
  requireAuth,
  validate(rejectBodySchema, "body"),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseUuidOrThrow(req.params.id as string);
    // reason is logged for audit; service currently does not store it separately
    const draft = await rejectDraft(id);
    res.json({ data: draft });
  }),
);

// ── POST /api/draft/:id/ingest ────────────────────────────────────────────────
draftRouter.post(
  "/:id/ingest",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseUuidOrThrow(req.params.id as string);
    const guide = await ingestApprovedDraft(id);
    res.status(201).json({ data: guide });
  }),
);


