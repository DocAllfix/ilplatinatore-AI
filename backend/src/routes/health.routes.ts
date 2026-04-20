import { Router } from "express";
import { createRequire } from "module";
import { query } from "@/config/database.js";
import { redis } from "@/config/redis.js";
import { asyncHandler } from "@/utils/asyncHandler.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

export const healthRouter = Router();

healthRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [dbStatus, redisStatus] = await Promise.all([
      query("SELECT 1")
        .then(() => "connected" as const)
        .catch(() => "disconnected" as const),
      redis
        .ping()
        .then(() => "connected" as const)
        .catch(() => "disconnected" as const),
    ]);

    const status = dbStatus === "connected" && redisStatus === "connected"
      ? "ok"
      : "degraded";

    res.status(status === "ok" ? 200 : 503).json({
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbStatus,
      redis: redisStatus,
      version,
    });
  }),
);
