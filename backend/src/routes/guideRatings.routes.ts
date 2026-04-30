import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "@/utils/asyncHandler.js";
import { validate } from "@/middleware/validate.js";
import { requireAuth } from "@/middleware/auth.middleware.js";
import { RatingsModel } from "@/models/ratings.model.js";

/**
 * GET /api/guide-ratings — lista paginata dei rating dell'utente loggato.
 * Frontend stub: stubs.js#listGuideRatings (Fase 21.x).
 */
export const guideRatingsRouter = Router();

const listMineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

guideRatingsRouter.get(
  "/",
  requireAuth,
  validate(listMineQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = req.query as unknown as z.infer<
      typeof listMineQuerySchema
    >;
    const userId = req.user!.userId;

    const [rows, total] = await Promise.all([
      RatingsModel.findByUser(userId, limit, offset),
      RatingsModel.countByUser(userId),
    ]);

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        guideId: r.guide_id,
        guideTitle: r.guide_title,
        guideSlug: r.guide_slug,
        stars: r.stars,
        suggestion: r.suggestion,
        language: r.language,
        createdAt: r.created_at,
      })),
      meta: { limit, offset, total },
    });
  }),
);
