import { Router } from "express";
import { z } from "zod";
import { GamesModel } from "@/models/games.model.js";
import { NotFoundError } from "@/utils/errors.js";
import { asyncHandler } from "@/utils/asyncHandler.js";
import { validate } from "@/middleware/validate.js";

export const gamesRouter = Router();

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const searchSchema = z.object({
  q: z.string().min(1).max(200),
});

// slug: lettere, cifre e trattini, non inizia/finisce con trattino
const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug non valido");

// GET /api/games — lista con paginazione
gamesRouter.get(
  "/",
  validate(paginationSchema, "query"),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query as unknown as z.infer<typeof paginationSchema>;
    const offset = (page - 1) * limit;

    const [games, total] = await Promise.all([
      GamesModel.findAll(limit, offset),
      GamesModel.count(),
    ]);

    res.json({
      data: games,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  }),
);

// GET /api/games/search?q=elden — ricerca fuzzy (prima di /:slug per non essere catturata)
gamesRouter.get(
  "/search",
  validate(searchSchema, "query"),
  asyncHandler(async (req, res) => {
    const { q } = req.query as unknown as z.infer<typeof searchSchema>;
    const games = await GamesModel.search(q);
    res.json({ data: games, meta: { total: games.length } });
  }),
);

// GET /api/games/:slug — dettaglio gioco
gamesRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const parsed = slugSchema.safeParse(req.params.slug);
    if (!parsed.success) throw new NotFoundError("Gioco non trovato");
    const game = await GamesModel.findBySlug(parsed.data);
    if (!game) throw new NotFoundError(`Gioco non trovato: ${parsed.data}`);
    res.json({ data: game });
  }),
);
