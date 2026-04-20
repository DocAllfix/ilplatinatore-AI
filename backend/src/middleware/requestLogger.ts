import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = Date.now();
  req.requestId = randomUUID();
  res.setHeader("X-Request-ID", req.requestId);

  if (
    env.NODE_ENV !== "production" &&
    req.body != null &&
    Object.keys(req.body as object).length > 0
  ) {
    logger.debug(
      {
        requestId: req.requestId,
        method: req.method,
        url: req.originalUrl,
        body: JSON.stringify(req.body).slice(0, 500),
      },
      "→ %s %s",
      req.method,
      req.originalUrl,
    );
  }

  res.on("finish", () => {
    logger.info(
      {
        requestId: req.requestId,
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      },
      "%s %s %d",
      req.method,
      req.originalUrl,
      res.statusCode,
    );
  });

  next();
}
