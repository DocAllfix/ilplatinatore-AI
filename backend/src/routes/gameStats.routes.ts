import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "@/utils/asyncHandler.js";
import { validate } from "@/middleware/validate.js";
import { requireAuth } from "@/middleware/auth.middleware.js";
import { NotFoundError } from "@/utils/errors.js";
import { UserGameStatsModel, type UserGameStatsRow } from "@/models/userGameStats.model.js";
import { GamesModel } from "@/models/games.model.js";

/**
 * GET   /api/game-stats?gameSlug=X  — lista stats utente loggato (filtro slug opzionale)
 * POST  /api/game-stats             — crea/upserta stats (idempotente su user_id+game_id)
 * PATCH /api/game-stats/:id         — aggiorna campi (IDOR check via user_id)
 *
 * Tutto richiede auth — user_id viene SEMPRE da req.user.userId, MAI dal body.
 */
export const gameStatsRouter = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  gameSlug: z.string().trim().min(1).max(255).optional(),
});

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// .strict() rifiuta campi extra (es: user_id, tier) → blocca privilege escalation.
const createBodySchema = z
  .object({
    gameSlug: z.string().trim().min(1).max(255).regex(slugRegex, "Slug non valido"),
    gameName: z.string().trim().min(1).max(500),
    totalPlaytime: z.number().int().nonnegative().optional(),
    bossesFelled: z.number().int().nonnegative().optional(),
    currentLevel: z.number().int().min(1).optional(),
    questsCompleted: z.number().int().nonnegative().optional(),
    progressionPercentage: z.number().int().min(0).max(100).optional(),
  })
  .strict();

const updateBodySchema = z
  .object({
    gameName: z.string().trim().min(1).max(500).optional(),
    totalPlaytime: z.number().int().nonnegative().optional(),
    bossesFelled: z.number().int().nonnegative().optional(),
    currentLevel: z.number().int().min(1).optional(),
    questsCompleted: z.number().int().nonnegative().optional(),
    progressionPercentage: z.number().int().min(0).max(100).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Almeno un campo richiesto",
  });

const uuidParamSchema = z.string().uuid();

// ── Serializer (snake_case DB → camelCase API) ────────────────────────────────

function serialize(row: UserGameStatsRow) {
  return {
    id: row.id,
    gameId: row.game_id,
    gameSlug: row.game_slug,
    gameName: row.game_name,
    totalPlaytime: row.total_playtime,
    bossesFelled: row.bosses_felled,
    currentLevel: row.current_level,
    questsCompleted: row.quests_completed,
    progressionPercentage: row.progression_percentage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

gameStatsRouter.get(
  "/",
  requireAuth,
  validate(listQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const { gameSlug } = req.query as unknown as z.infer<typeof listQuerySchema>;
    const userId = req.user!.userId;
    const rows = await UserGameStatsModel.findByUser(userId, gameSlug);
    res.json({ data: rows.map(serialize) });
  }),
);

gameStatsRouter.post(
  "/",
  requireAuth,
  validate(createBodySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const body = req.body as z.infer<typeof createBodySchema>;

    // Lookup game_id da slug — rifiuta giochi inesistenti.
    const game = await GamesModel.findBySlug(body.gameSlug);
    if (!game) throw new NotFoundError(`Gioco non trovato: ${body.gameSlug}`);

    const row = await UserGameStatsModel.upsert({
      user_id: userId,
      game_id: game.id,
      game_slug: body.gameSlug,
      game_name: body.gameName,
      ...(body.totalPlaytime !== undefined && { total_playtime: body.totalPlaytime }),
      ...(body.bossesFelled !== undefined && { bosses_felled: body.bossesFelled }),
      ...(body.currentLevel !== undefined && { current_level: body.currentLevel }),
      ...(body.questsCompleted !== undefined && { quests_completed: body.questsCompleted }),
      ...(body.progressionPercentage !== undefined && {
        progression_percentage: body.progressionPercentage,
      }),
    });

    res.status(201).json({ data: serialize(row) });
  }),
);

gameStatsRouter.patch(
  "/:id",
  requireAuth,
  validate(updateBodySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const idParse = uuidParamSchema.safeParse(req.params.id);
    if (!idParse.success) throw new NotFoundError("Stats non trovate");
    const userId = req.user!.userId;
    const body = req.body as z.infer<typeof updateBodySchema>;

    // snake_case mapping (solo campi forniti).
    const update: Record<string, unknown> = {};
    if (body.gameName !== undefined) update.game_name = body.gameName;
    if (body.totalPlaytime !== undefined) update.total_playtime = body.totalPlaytime;
    if (body.bossesFelled !== undefined) update.bosses_felled = body.bossesFelled;
    if (body.currentLevel !== undefined) update.current_level = body.currentLevel;
    if (body.questsCompleted !== undefined) update.quests_completed = body.questsCompleted;
    if (body.progressionPercentage !== undefined) {
      update.progression_percentage = body.progressionPercentage;
    }

    const row = await UserGameStatsModel.updateByIdAndUser(idParse.data, userId, update);
    if (!row) throw new NotFoundError("Stats non trovate");
    res.json({ data: serialize(row) });
  }),
);
