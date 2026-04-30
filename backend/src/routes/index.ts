import { Router } from "express";
import { healthRouter } from "./health.routes.js";
import { gamesRouter } from "./games.routes.js";
import { guidesRouter } from "./guides.routes.js";
import { guideRouter } from "./guide.routes.js";
import { ratingRouter } from "./rating.routes.js";
import { authRouter } from "./auth.routes.js";
import { draftRouter } from "./draft.routes.js";
import { guideRatingsRouter } from "./guideRatings.routes.js";
import { uploadsRouter } from "./uploads.routes.js";
import { gameStatsRouter } from "./gameStats.routes.js";

export const rootRouter = Router();

rootRouter.use("/health", healthRouter);
// Auth Fase 18 — register/login/refresh/logout/me. Le route cookie-based NON
// richiedono csrfProtection (exempted): il login stesso è l'emettitore del CSRF.
rootRouter.use("/api/auth", authRouter);
rootRouter.use("/api/games", gamesRouter);
rootRouter.use("/api/guides", guidesRouter);
// /api/guide (singolare) — orchestrator chat Fase 16, distinto dal CRUD /api/guides.
rootRouter.use("/api/guide", guideRouter);
// Rating Fase 17 — POST /api/guide/:id/rating + GET /api/guide/:id/ratings.
// Stesso prefisso di guideRouter: Express chaina i router, path non collidono.
rootRouter.use("/api/guide", ratingRouter);
// Draft Fase 23 — HITL self-learning RAG: get/revise/approve/reject/ingest.
rootRouter.use("/api/draft", draftRouter);
// Guide ratings (Fase 21.x — sblocco stub frontend listGuideRatings).
// Lista paginata dei rating dell'utente loggato. Path con trattino per non
// collidere con /api/guide (orchestrator) né /api/guides (CRUD).
rootRouter.use("/api/guide-ratings", guideRatingsRouter);
// Uploads (Fase 21.x — avatar utente). multer + magic-bytes validation.
rootRouter.use("/api/uploads", uploadsRouter);
// Game stats (Fase 21.x — sblocco stub gameStats.filter/create/update).
// IDOR check via user_id in WHERE su PATCH.
rootRouter.use("/api/game-stats", gameStatsRouter);
