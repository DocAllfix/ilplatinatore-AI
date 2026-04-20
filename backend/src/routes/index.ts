import { Router } from "express";
import { healthRouter } from "./health.routes.js";
import { gamesRouter } from "./games.routes.js";
import { guidesRouter } from "./guides.routes.js";

export const rootRouter = Router();

rootRouter.use("/health", healthRouter);
rootRouter.use("/api/games", gamesRouter);
rootRouter.use("/api/guides", guidesRouter);
