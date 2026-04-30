import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import { asyncHandler } from "@/utils/asyncHandler.js";
import { requireAuth } from "@/middleware/auth.middleware.js";
import { createRateLimiter } from "@/middleware/rateLimiter.js";
import {
  uploadAvatar,
  MAX_AVATAR_SIZE_BYTES,
  ALLOWED_AVATAR_MIME_TYPES,
} from "@/services/avatar.service.js";

/**
 * POST /api/uploads/avatar — upload avatar dell'utente loggato.
 * Body: multipart/form-data con campo "avatar" (single file).
 */
export const uploadsRouter = Router();

// ── Multer config ─────────────────────────────────────────────────────────────

// memoryStorage: il buffer resta in RAM finché non valido + scritto manualmente
// dal service. Evita file orfani su disco se la validazione magic-bytes fallisce.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_AVATAR_SIZE_BYTES,
    files: 1,
    fields: 0, // niente campi extra accettati nel form
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_AVATAR_MIME_TYPES.includes(file.mimetype as never)) {
      cb(null, true);
      return;
    }
    cb(null, false); // rifiutato silenziosamente — il service riconsulta
  },
});

// ── Rate limit (anti-abuse) ───────────────────────────────────────────────────
// 10 upload/24h per utente — basta per cambiare avatar qualche volta al giorno,
// blocca attacchi che provano a riempire il disco.
const avatarLimiter = createRateLimiter({
  keyPrefix: "rl:avatar-upload",
  windowMs: 24 * 60 * 60 * 1000,
  limit: 10,
});

// ── Multer error handler (dimensione, MIME, etc.) ─────────────────────────────

function multerErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        error: `File troppo grande (max ${MAX_AVATAR_SIZE_BYTES / 1024 / 1024}MB).`,
      });
      return;
    }
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      res.status(400).json({ error: "Campo file non valido (atteso 'avatar')." });
      return;
    }
    res.status(400).json({ error: `Upload error: ${err.code}` });
    return;
  }
  next(err);
}

// ── Routes ────────────────────────────────────────────────────────────────────

uploadsRouter.post(
  "/avatar",
  requireAuth,
  avatarLimiter,
  upload.single("avatar"),
  multerErrorHandler,
  asyncHandler(async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: "File mancante o tipo non supportato (png/jpeg/webp).",
      });
      return;
    }

    const userId = req.user!.userId;
    const result = await uploadAvatar({
      userId,
      buffer: file.buffer,
      mimeType: file.mimetype,
    });

    res.status(201).json({ data: result });
  }),
);
