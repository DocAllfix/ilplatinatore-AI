import { Router } from "express";
import { z } from "zod";
import { GuidesModel } from "@/models/guides.model.js";
import { GamesModel } from "@/models/games.model.js";
import { NotFoundError } from "@/utils/errors.js";
import { asyncHandler } from "@/utils/asyncHandler.js";
import { validate } from "@/middleware/validate.js";

export const guidesRouter = Router();

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug non valido");

const guideFiltersSchema = z.object({
  type: z.enum(["trophy", "walkthrough", "collectible", "challenge", "platinum"]).optional(),
  language: z.string().length(2).optional(),
  verified: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /api/guides/game/:gameSlug — guide per gioco con filtri opzionali
// DEVE essere registrata prima di /:slug altrimenti Express intercetta "game" come slug.
guidesRouter.get(
  "/game/:gameSlug",
  validate(guideFiltersSchema, "query"),
  asyncHandler(async (req, res) => {
    const parsedSlug = slugSchema.safeParse(req.params.gameSlug);
    if (!parsedSlug.success) throw new NotFoundError("Gioco non trovato");
    const gameSlug = parsedSlug.data;

    const game = await GamesModel.findBySlug(gameSlug);
    if (!game) throw new NotFoundError(`Gioco non trovato: ${gameSlug}`);

    // Il middleware validate() ha già parsato req.query con guideFiltersSchema.
    // Cast via unknown necessario perché ParsedQs e il tipo Zod non si sovrappongono.
    const { type, language, verified, page, limit } =
      req.query as unknown as z.infer<typeof guideFiltersSchema>;
    const offset = (page - 1) * limit;

    // Con exactOptionalPropertyTypes le proprietà undefined devono essere assenti,
    // non passate esplicitamente — usiamo spread condizionale.
    const guides = await GuidesModel.findByGame(game.id, {
      ...(type !== undefined && { guide_type: type }),
      ...(language !== undefined && { language }),
      ...(verified !== undefined && { verified }),
      limit,
      offset,
    });

    res.json({
      data: guides,
      meta: { page, limit, total: guides.length, gameSlug },
    });
  }),
);

// GET /api/guides/:slug — dettaglio guida per slug
guidesRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const parsed = slugSchema.safeParse(req.params.slug);
    if (!parsed.success) throw new NotFoundError("Guida non trovata");
    const guide = await GuidesModel.findBySlug(parsed.data);
    if (!guide) throw new NotFoundError(`Guida non trovata: ${parsed.data}`);
    res.json({ data: guide });
  }),
);
