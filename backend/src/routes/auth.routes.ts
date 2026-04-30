import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "@/config/env.js";
import { validate } from "@/middleware/validate.js";
import { requireAuth } from "@/middleware/auth.middleware.js";
import { AuthService, type TokenPair } from "@/services/auth.service.js";
import { asyncHandler } from "@/utils/asyncHandler.js";
import { UsersModel } from "@/models/users.model.js";
import { AuthenticationError, NotFoundError } from "@/utils/errors.js";
import { createRateLimiter } from "@/middleware/rateLimiter.js";

const loginLimiter = createRateLimiter({ keyPrefix: "rl:login", windowMs: 15 * 60 * 1000, limit: 10 });
const registerLimiter = createRateLimiter({ keyPrefix: "rl:register", windowMs: 60 * 60 * 1000, limit: 5 });
const refreshLimiter = createRateLimiter({ keyPrefix: "rl:refresh", windowMs: 60 * 1000, limit: 20 });

export const authRouter = Router();

// ── Zod validation ───────────────────────────────────────────
const registerSchema = z.object({
  email: z.string().email("Email non valida"),
  password: z
    .string()
    .min(8, "Password minimo 8 caratteri")
    .regex(/[A-Za-z]/, "Password deve contenere almeno una lettera")
    .regex(/[0-9]/, "Password deve contenere almeno un numero"),
  displayName: z.string().min(2).max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// PATCH /me — solo campi che l'utente può modificare autonomamente.
// email/password/tier/avatar gestiti da endpoint dedicati con flussi separati.
const updateMeSchema = z
  .object({
    displayName: z.string().trim().min(2).max(100).nullable().optional(),
    language: z.string().trim().min(2).max(10).optional(),
  })
  .strict() // rifiuta chiavi sconosciute (anti privilege-escalation tier=platinum, etc.)
  .refine((d) => d.displayName !== undefined || d.language !== undefined, {
    message: "Almeno un campo richiesto (displayName, language)",
  });

// ── Cookie config (AUDIT FIX FF#3 + W-SEC-1) ──────────────────
const REFRESH_COOKIE = "refresh_token";
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isProd(): boolean {
  return env.NODE_ENV === "production";
}

function refreshCookieDomain(): string | undefined {
  // Subdomain specifico (NON `.ilplatinatore.it`) — se WP compromesso, cookie
  // non esposto a www.*.
  return isProd() ? "ai.ilplatinatore.it" : undefined;
}

function setRefreshCookie(res: Response, token: string): void {
  const domain = refreshCookieDomain();
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    // AUDIT FIX W-SEC-1: secure=true SOLO in prod; in dev su http il cookie
    // deve essere inviato dal browser, altrimenti loop di 401.
    secure: isProd(),
    sameSite: "strict",
    ...(domain ? { domain } : {}),
    path: "/",
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

function clearRefreshCookie(res: Response): void {
  const domain = refreshCookieDomain();
  res.cookie(REFRESH_COOKIE, "", {
    httpOnly: true,
    secure: isProd(),
    sameSite: "strict",
    ...(domain ? { domain } : {}),
    path: "/",
    maxAge: 0,
  });
}

function readRefreshCookie(req: Request): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> })
    .cookies ?? {};
  return cookies[REFRESH_COOKIE];
}

function respondWithTokens(
  res: Response,
  tokens: TokenPair,
  userPayload: unknown,
): void {
  setRefreshCookie(res, tokens.refreshToken);
  res.json({
    accessToken: tokens.accessToken,
    csrfToken: tokens.csrfToken,
    user: userPayload,
  });
}

// ── Routes ────────────────────────────────────────────────────
authRouter.post(
  "/register",
  registerLimiter,
  validate(registerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password, displayName } = req.body as z.infer<
      typeof registerSchema
    >;
    const { tokens, user } = await AuthService.register(
      email.toLowerCase(),
      password,
      displayName ?? null,
      req.ip ?? null,
    );
    respondWithTokens(res, tokens, user);
  }),
);

authRouter.post(
  "/login",
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;
    const { tokens, user } = await AuthService.login(
      email.toLowerCase(),
      password,
      req.ip ?? null,
    );
    respondWithTokens(res, tokens, user);
  }),
);

// AUDIT FIX FF-NEW-1: il refresh arriva SOLO dal cookie, MAI dal body.
authRouter.post(
  "/refresh",
  refreshLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const token = readRefreshCookie(req);
    if (!token) throw new AuthenticationError("Refresh cookie assente");
    const { tokens, user } = await AuthService.refresh(token, req.ip ?? null);
    respondWithTokens(res, tokens, user);
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req: Request, res: Response) => {
    const token = readRefreshCookie(req);
    if (token) await AuthService.revokeRefreshToken(token);
    clearRefreshCookie(res);
    res.status(204).end();
  }),
);

function serializeUser(row: NonNullable<Awaited<ReturnType<typeof UsersModel.findById>>>) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    tier: row.tier,
    language: row.language,
    avatarUrl: row.avatar_url,
  };
}

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    // requireAuth garantisce req.user non-null a questo punto.
    const userId = req.user!.userId;
    const row = await UsersModel.findById(userId);
    if (!row) throw new NotFoundError("Utente non trovato");
    res.json(serializeUser(row));
  }),
);

authRouter.patch(
  "/me",
  requireAuth,
  validate(updateMeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const body = req.body as z.infer<typeof updateMeSchema>;
    // Mappa naming camelCase frontend → snake_case DB. Solo campi forniti
    // sono passati al model (undefined != null per evitare wipe accidentali).
    const update: { display_name?: string | null; language?: string } = {};
    if (body.displayName !== undefined) update.display_name = body.displayName;
    if (body.language !== undefined) update.language = body.language;

    const updated = await UsersModel.updateProfile(userId, update);
    if (!updated) throw new NotFoundError("Utente non trovato");
    res.json(serializeUser(updated));
  }),
);
