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
