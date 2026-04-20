import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "@/config/env.js";
import { AppError } from "@/utils/errors.js";
import { logger } from "@/utils/logger.js";

// body-parser usa http-errors (non SyntaxError) — discriminante affidabile: .type
type HttpError = Error & { status?: number; type?: string };

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = req.requestId ?? randomUUID();

  // Assicura che X-Request-ID sia sempre presente, anche se requestLogger
  // è stato byppassato (es. errore in middleware precedente a requestLogger).
  if (!res.headersSent) {
    res.setHeader("X-Request-ID", requestId);
  }

  logger.error(
    {
      requestId,
      message: err.message,
      stack: err.stack,
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
    },
    "Request error",
  );

  // JSON malformato da express.json() → 400, non 500.
  // body-parser emette HttpError con type='entity.parse.failed', non SyntaxError.
  const httpErr = err as HttpError;
  if (httpErr.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid request body: malformed JSON", requestId });
    return;
  }

  if (err instanceof AppError && err.isOperational) {
    res.status(err.statusCode).json({ error: err.message, requestId });
    return;
  }

  res.status(500).json({
    error: "Internal Server Error",
    requestId,
    ...(env.NODE_ENV !== "production" && { detail: err.message }),
  });
}
