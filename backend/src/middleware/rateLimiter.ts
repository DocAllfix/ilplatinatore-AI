import type { NextFunction, Request, RequestHandler, Response } from "express";
import { redis } from "@/config/redis.js";
import { logger } from "@/utils/logger.js";

export interface RateLimiterOptions {
  windowMs: number;
  limit: number;
  keyPrefix?: string;
}

// Atomic sliding-window via Redis sorted set.
// Returns [allowed: 0|1, remaining: number]
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1}
else
  return {0, 0}
end
`;

// Priorità identità per rate limit composite key (Fase 18 alignment):
//   1. userId del JWT valido (Express.Request.user.userId, number)
//   2. sessionId del cookie anonimo (Express.Request.sessionId, UUID string)
//   3. IP come fallback (dietro trust proxy: X-Forwarded-For primo hop)
function getIdentifier(req: Request): string {
  if (req.user?.userId != null) return `user:${req.user.userId}`;
  if (req.sessionId) return `session:${req.sessionId}`;
  return `ip:${req.ip ?? "unknown"}`;
}

export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const { windowMs, limit, keyPrefix = "ratelimit" } = options;
  const windowLabel = Math.floor(windowMs / 1000);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identifier = getIdentifier(req);
    const key = `${keyPrefix}:${identifier}:${windowLabel}`;
    const now = Date.now();

    try {
      const result = (await redis.eval(
        SLIDING_WINDOW_SCRIPT,
        1,
        key,
        now.toString(),
        windowMs.toString(),
        limit.toString(),
      )) as [number, number];

      const [allowed, remaining] = result;

      res.setHeader("X-RateLimit-Limit", limit);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, remaining));
      res.setHeader("X-RateLimit-Window-Ms", windowMs);

      if (!allowed) {
        const retryAfterS = Math.ceil(windowMs / 1000);
        res.setHeader("Retry-After", retryAfterS);
        res.status(429).json({
          error: "Too many requests",
          retryAfterSeconds: retryAfterS,
        });
        return;
      }

      next();
    } catch (err) {
      // Fail open: un Redis down non blocca il traffico legittimo
      logger.warn({ key, error: String(err) }, "Rate limiter Redis error — failing open");
      next();
    }
  };
}

// ── T2.6 — Rate limit per-tier (free / registered / pro / platinum) ────────
// Frontend hot-path: /api/guide. La free tier è la più ristretta per evitare
// abuso anonymous; la platinum è ∞ (passa always-allowed). Il tier è letto da
// req.user.tier (popolato da requireAuth/optionalAuth) — se undefined ricade
// su 'free' (anonymous).

export interface TierLimits {
  /** Sub anonymous o tier non riconosciuto. */
  free: { windowMs: number; limit: number };
  registered: { windowMs: number; limit: number };
  pro: { windowMs: number; limit: number };
  /** platinum = bypass (no rate limit). */
  platinum: null;
}

const DEFAULT_TIER_LIMITS: TierLimits = {
  free:       { windowMs: 60_000, limit: 5 },
  registered: { windowMs: 60_000, limit: 10 },
  pro:        { windowMs: 60_000, limit: 30 },
  platinum:   null,
};

type TierName = "free" | "registered" | "pro" | "platinum";

function resolveTier(req: Request): TierName {
  // req.user.tier tipato come "free" | "pro" | "platinum" (vedi UserRow).
  // 'registered' è dedotto: utente loggato in tier='free' ma con userId noto.
  const u = req.user;
  if (!u || u.userId == null) return "free";
  const t = u.tier;
  if (t === "platinum") return "platinum";
  if (t === "pro") return "pro";
  // tier='free' MA con userId presente → 'registered' (limit più alto del puro
  // anonymous senza account). Coerente con la regola: "registered=10 vs free=5".
  return "registered";
}

/**
 * Rate limiter dinamico in base al req.user.tier. Da usare DOPO optionalAuth/
 * requireAuth perché ha bisogno di req.user.
 *
 * Esempio:
 *   router.post("/guide", optionalAuth, tierRateLimiter(), handler);
 */
export function tierRateLimiter(
  limits: TierLimits = DEFAULT_TIER_LIMITS,
  keyPrefix = "rl:tier",
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tier = resolveTier(req);
    const cfg = limits[tier];

    // platinum = bypass totale.
    if (cfg === null) {
      res.setHeader("X-RateLimit-Tier", tier);
      next();
      return;
    }

    const { windowMs, limit } = cfg;
    const windowLabel = Math.floor(windowMs / 1000);
    const identifier = getIdentifier(req);
    const key = `${keyPrefix}:${tier}:${identifier}:${windowLabel}`;
    const now = Date.now();

    try {
      const result = (await redis.eval(
        SLIDING_WINDOW_SCRIPT,
        1,
        key,
        now.toString(),
        windowMs.toString(),
        limit.toString(),
      )) as [number, number];

      const [allowed, remaining] = result;

      res.setHeader("X-RateLimit-Tier", tier);
      res.setHeader("X-RateLimit-Limit", limit);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, remaining));
      res.setHeader("X-RateLimit-Window-Ms", windowMs);

      if (!allowed) {
        const retryAfterS = Math.ceil(windowMs / 1000);
        res.setHeader("Retry-After", retryAfterS);
        res.status(429).json({
          error: "Too many requests",
          tier,
          retryAfterSeconds: retryAfterS,
        });
        return;
      }

      next();
    } catch (err) {
      // Fail open
      logger.warn(
        { key, tier, error: String(err) },
        "tierRateLimiter Redis error — failing open",
      );
      next();
    }
  };
}
