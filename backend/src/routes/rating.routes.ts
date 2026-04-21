import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "@/utils/asyncHandler.js";
import { validate } from "@/middleware/validate.js";
import { NotFoundError } from "@/utils/errors.js";
import { RatingService } from "@/services/rating.service.js";

/**
 * Fase 17 — rating endpoints.
 *   POST /api/guide/:id/rating   → upsert voto + trigger promozione
 *   GET  /api/guide/:id/ratings  → summary aggregato dalla materialized view
 *
 * Mount suggerito in routes/index.ts:
 *   rootRouter.use("/api/guide", ratingRouter);
 * Convive con guideRouter (POST / · GET /stream) perché i path non collidono.
 */

export const ratingRouter = Router();

// :id è un intero positivo. Usato sia dal POST che dal GET.
const guideIdParamSchema = z.coerce.number().int().positive();

const ratingBodySchema = z.object({
  stars: z.number().int().min(1).max(5),
  suggestion: z.string().trim().max(1000).optional(),
  language: z.string().trim().min(2).max(8).toLowerCase().optional(),
  // sessionId dal body finché l'auth cookie (Fase 18) non è attiva.
  sessionId: z.string().uuid().optional(),
});

// ── POST /api/guide/:id/rating ─────────────────────────────────────────────
ratingRouter.post(
  "/:id/rating",
  validate(ratingBodySchema, "body"),
  asyncHandler(async (req: Request, res: Response) => {
    const parsedId = guideIdParamSchema.safeParse(req.params.id);
    if (!parsedId.success) throw new NotFoundError("Guida non trovata");
    const body = req.body as z.infer<typeof ratingBodySchema>;

    // userId: verrà iniettato dal middleware auth (Fase 18). Per ora
    // tutti i voti arrivano come anonymous-session.
    const { promoted } = await RatingService.submitRating({
      guideId: parsedId.data,
      userId: null,
      sessionId: body.sessionId ?? null,
      stars: body.stars,
      ...(body.suggestion !== undefined && { suggestion: body.suggestion }),
      ...(body.language !== undefined && { language: body.language }),
    });

    res.status(201).json({
      data: { message: "Rating salvato", promoted },
    });
  }),
);

// ── GET /api/guide/:id/ratings ─────────────────────────────────────────────
ratingRouter.get(
  "/:id/ratings",
  asyncHandler(async (req: Request, res: Response) => {
    const parsedId = guideIdParamSchema.safeParse(req.params.id);
    if (!parsedId.success) throw new NotFoundError("Guida non trovata");

    const summary = await RatingService.getGuideRatings(parsedId.data);
    res.json({ data: summary });
  }),
);
