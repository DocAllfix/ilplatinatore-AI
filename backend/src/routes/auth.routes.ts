import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "@/config/env.js";
import { validate } from "@/middleware/validate.js";
import { requireAuth } from "@/middleware/auth.middleware.js";
import { AuthService, type TokenPair } from "@/services/auth.service.js";
import { asyncHandler } from "@/utils/asyncHandler.js";
import { UsersModel } from "@/models/users.model.js";
import { AuthenticationError, NotFoundError } from "@/utils/errors.js";

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

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    // requireAuth garantisce req.user non-null a questo punto.
    const userId = req.user!.userId;
    const row = await UsersModel.findById(userId);
    if (!row) throw new NotFoundError("Utente non trovato");
    res.json({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      tier: row.tier,
      language: row.language,
    });
  }),
);
