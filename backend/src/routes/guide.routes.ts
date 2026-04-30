import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "@/utils/asyncHandler.js";
import { validate } from "@/middleware/validate.js";
import { optionalAuth } from "@/middleware/auth.middleware.js";
import {
  handleGuideRequest,
  handleGuideStream,
  tryCacheHit,
} from "@/services/orchestrator.service.js";
import { logger } from "@/utils/logger.js";

export const guideRouter = Router();

// NOTA: singolare /api/guide — distinto da /api/guides (CRUD su tabella guides).
//  - POST /api/guide         → risposta JSON completa (non-streaming)
//  - GET  /api/guide/stream  → dual-response: JSON su cache HIT, SSE su MISS

// language: whitelist semplice su prefisso ISO639 (2-8 char). Il middleware
// validate() normalizza a lowercase già nel parse.
const languageField = z.string().trim().min(2).max(8).toLowerCase().optional();

const guideRequestSchema = z.object({
  query: z.string().trim().min(3).max(500),
  sessionId: z.string().uuid().optional(),
  language: languageField,
});

const guideStreamQuerySchema = z.object({
  query: z.string().trim().min(3).max(500),
  sessionId: z.string().uuid().optional(),
  language: languageField,
});

// ── POST /api/guide — risposta JSON ────────────────────────────────────────
guideRouter.post(
  "/",
  optionalAuth,
  validate(guideRequestSchema, "body"),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof guideRequestSchema>;
    const result = await handleGuideRequest({
      query: body.query,
      userId: req.user?.userId ?? null,
      sessionId: body.sessionId ?? null,
      ...(body.language && { language: body.language }),
    });
    res.json({ data: result });
  }),
);

// ── GET /api/guide/stream — SSE ────────────────────────────────────────────
/**
 * Server-Sent Events endpoint. Formato standard SSE:
 *   event: meta | delta | done | error
 *   data: <JSON>
 *
 * Il client deve ascoltare con EventSource. Nginx/caddy davanti deve avere
 * buffering disabilitato per `/api/guide/stream` altrimenti i chunk arrivano
 * tutti insieme a fine risposta.
 */
guideRouter.get(
  "/stream",
  optionalAuth,
  validate(guideStreamQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof guideStreamQuerySchema>;
    const params = {
      query: q.query,
      userId: req.user?.userId ?? null,
      sessionId: q.sessionId ?? null,
      ...(q.language && { language: q.language }),
    };

    // DUAL-RESPONSE (checklist 6.1 #7): cache HIT → JSON, MISS → SSE.
    // Tentiamo la cache PRIMA di mandare headers SSE, altrimenti non
    // possiamo più switchare a Content-Type: application/json.
    const cached = await tryCacheHit(params);
    if (cached) {
      res.json({ data: cached });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disabilita buffering nginx
    res.flushHeaders();

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Detect disconnect — il client può chiudere EventSource in qualsiasi momento.
    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });

    try {
      const stream = handleGuideStream(params);
      for await (const ev of stream) {
        if (aborted) break;
        send(ev.type, ev.data);
      }
    } catch (err) {
      logger.error({ err }, "guide.stream: errore non intercettato dall'orchestrator");
      send("error", { message: "Errore stream" });
    } finally {
      res.end();
    }
  }),
);
