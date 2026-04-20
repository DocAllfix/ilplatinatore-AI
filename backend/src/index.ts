import "dotenv/config";
import cookieParser from "cookie-parser";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";
import { requestLogger } from "@/middleware/requestLogger.js";
import { errorHandler } from "@/middleware/errorHandler.js";
import { rootRouter } from "@/routes/index.js";
import { startEmbeddingWorker } from "@/workers/embedding.worker.js";
import { startEmbeddingScheduler } from "@/schedulers/embedding.scheduler.js";

const app = express();

// AUDIT FIX (R6-1): Trust reverse proxy (nginx + Cloudflare).
// Il primo hop X-Forwarded-For viene accettato come IP reale del client.
// Senza questo, req.ip è sempre 127.0.0.1 in prod e il rate limiting collassa.
app.set("trust proxy", 1);

// ── Security & parsing ───────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS.split(","), credentials: true }));
// requestLogger PRIMA di express.json: garantisce che req.requestId sia assegnato
// anche quando il parsing JSON fallisce e Express salta direttamente all'errorHandler.
app.use(requestLogger);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ── Routes ───────────────────────────────────────────────────
app.use(rootRouter);

// ── 404 handler ──────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not Found" });
});

// ── Global error handler (DEVE essere l'ultimo middleware) ────
app.use(errorHandler);

// ── Start ────────────────────────────────────────────────────
app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV },
    "Server avviato su porta %d",
    env.PORT,
  );
});

// ── Background workers & scheduler (stesso processo, 1 replica — regola #11 CLAUDE.md)
startEmbeddingWorker();
startEmbeddingScheduler();
