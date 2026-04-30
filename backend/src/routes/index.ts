import { Router } from "express";
import { healthRouter } from "./health.routes.js";
import { gamesRouter } from "./games.routes.js";
import { guidesRouter } from "./guides.routes.js";
import { guideRouter } from "./guide.routes.js";
import { ratingRouter } from "./rating.routes.js";
import { authRouter } from "./auth.routes.js";
import { draftRouter } from "./draft.routes.js";

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
