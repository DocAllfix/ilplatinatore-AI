import type { Request, RequestHandler } from "express";
import { env } from "@/config/env.js";
import { AuthService, type Tier } from "@/services/auth.service.js";
import { verifyCsrfToken } from "@/services/auth.csrf.js";
import { logger } from "@/utils/logger.js";

const TIER_ORDER: Record<Tier, number> = {
  free: 0,
  pro: 1,
  platinum: 2,
};

function extractBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== "string") return null;
  const [scheme, token] = h.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

// ── requireAuth ──────────────────────────────────────────────
export const requireAuth: RequestHandler = (req, res, next) => {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    req.user = AuthService.verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

// ── optionalAuth ─────────────────────────────────────────────
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = extractBearer(req);
  if (!token) {
    req.user = null;
    next();
    return;
  }
  try {
    req.user = AuthService.verifyAccessToken(token);
  } catch {
    req.user = null;
  }
  next();
};

// ── requireTier(min) ──────────────────────────────────────────
export function requireTier(minTier: Tier): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (TIER_ORDER[req.user.tier] < TIER_ORDER[minTier]) {
      res.status(403).json({ error: `Requires tier: ${minTier}` });
      return;
    }
    next();
  };
}

// ── requireBetaAccess (Sprint 4 final) ────────────────────────
// No-op se BETA_GATING_ENABLED=false (dev/staging). In prod (Beta closed),
// blocca utenti senza beta_access=true. Lookup DB con cache in-memory 60s
// per non hammerare il DB per ogni request hot-path.
//
// Cache strategy: in-memory Map → fail-open su miss. Singola replica
// (regola CLAUDE.md #11) → cache coerente. Se scali serve Redis cache.
import { UsersModel } from "@/models/users.model.js";

const BETA_CACHE_TTL_MS = 60_000;
const betaCache = new Map<number, { allowed: boolean; at: number }>();

function getCachedBetaStatus(userId: number): boolean | null {
  const entry = betaCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.at > BETA_CACHE_TTL_MS) {
    betaCache.delete(userId);
    return null;
  }
  return entry.allowed;
}

export const requireBetaAccess: RequestHandler = async (req, res, next) => {
  if (!env.BETA_GATING_ENABLED) {
    return next();
  }
  if (!req.user) {
    res.status(401).json({ error: "Authentication required for Beta access" });
    return;
  }

  const userId = req.user.userId;
  const cached = getCachedBetaStatus(userId);
  if (cached === true) return next();
  if (cached === false) {
    res.status(403).json({
      error: "Beta access required",
      message: "Closed Beta — request access via your account page",
    });
    return;
  }

  // Cache MISS → DB lookup (fail-open su error per non bloccare il sistema).
  try {
    const user = await UsersModel.findById(userId);
    const allowed = user?.beta_access === true;
    betaCache.set(userId, { allowed, at: Date.now() });
    if (allowed) return next();
    res.status(403).json({
      error: "Beta access required",
      message: "Closed Beta — request access via your account page",
    });
  } catch (err) {
    logger.warn({ err, userId }, "requireBetaAccess: DB error, fail-open");
    next();
  }
};

/** Espose per test: pulisce cache. */
export function __clearBetaCache(): void {
  betaCache.clear();
}

// ── sessionMiddleware ────────────────────────────────────────
// Cookie separato dal refresh_token. Scopo: tracciare utenti anonimi (free
// tier pre-login) via `sessions` table. Coesiste con req.user: se c'è JWT
// valido, il cookie anonimo resta ma la logica a valle preferisce req.user.
const SESSION_COOKIE = "session_id";
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isProd(): boolean {
  return env.NODE_ENV === "production";
}

// AUDIT FIX FF#3: subdomain specifico in prod, undefined in dev.
function cookieDomainOrUndef(): string | undefined {
  return isProd() ? "ai.ilplatinatore.it" : undefined;
}

export const sessionMiddleware: RequestHandler = async (req, res, next) => {
  try {
    if (req.user) return next();
    const cookies = (req as Request & { cookies?: Record<string, string> })
      .cookies ?? {};
    const existing = cookies[SESSION_COOKIE];
    if (existing) {
      req.sessionId = existing;
      return next();
    }
    const ip = req.ip ?? null;
    const uaHeader = req.headers["user-agent"];
    const ua = typeof uaHeader === "string" ? uaHeader : null;
    const sid = await AuthService.createAnonymousSession(ip, ua);
    req.sessionId = sid;
    const domain = cookieDomainOrUndef();
    res.cookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      // AUDIT FIX W-SEC-1: NON hardcoded true; dev su http deve ricevere il cookie.
      secure: isProd(),
      sameSite: "strict",
      ...(domain ? { domain } : {}),
      path: "/",
      maxAge: SESSION_MAX_AGE_MS,
    });
    next();
  } catch (err) {
    logger.error({ err }, "sessionMiddleware failed");
    next(err);
  }
};

// ── csrfProtection (AUDIT FIX FF#3 + R2) ──────────────────────
// Double-submit cookie classico è BYPASSABILE con Domain=.ilplatinatore.it
// (XSS su www.*  legge il cookie CSRF). Qui usiamo signed CSRF token
// in-memory: il client manda X-CSRF-Token, il server verifica HMAC + timestamp
// + userId match, tutto constant-time.
const CSRF_EXEMPT_PATHS = new Set<string>([
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/refresh",
  "/api/stripe/webhook",
]);

const CSRF_PROTECTED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function resolveRequestOrigin(req: Request): string | undefined {
  const originHeader = req.headers.origin;
  if (typeof originHeader === "string") return originHeader;
  const referer = req.headers.referer;
  if (typeof referer === "string") {
    try {
      return new URL(referer).origin;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  const allowed = env.CORS_ORIGINS.split(",").map((s) => s.trim());
  return allowed.includes(origin);
}

export const csrfProtection: RequestHandler = (req, res, next) => {
  if (!CSRF_PROTECTED_METHODS.has(req.method)) return next();
  if (CSRF_EXEMPT_PATHS.has(req.path)) return next();
  // Difesa in profondità: Origin/Referer check PRIMA del CSRF token.
  if (!isOriginAllowed(resolveRequestOrigin(req))) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const header = req.headers["x-csrf-token"];
  const token = typeof header === "string" ? header : undefined;
  if (!token || !verifyCsrfToken(token, req.user.userId)) {
    res.status(403).json({ error: "CSRF token invalid" });
    return;
  }
  next();
};
