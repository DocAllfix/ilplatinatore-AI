import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";

const app = express();

// AUDIT FIX (R6-1): Trust reverse proxy (nginx + Cloudflare).
// Il primo hop X-Forwarded-For viene accettato come IP reale del client.
// Senza questo, req.ip è sempre 127.0.0.1 in prod e il rate limiting collassa.
// Il valore 1 fida SOLO un hop (nginx locale). In dev è innocuo.
app.set("trust proxy", 1);

// ── Security & parsing ───────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGINS.split(","),
    credentials: true,
  }),
);
app.use(express.json());

// ── Health check ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Start ────────────────────────────────────────────────────
app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV },
    "Server avviato su porta %d",
    env.PORT,
  );
});
