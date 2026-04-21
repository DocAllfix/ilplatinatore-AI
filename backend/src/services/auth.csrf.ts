import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/config/env.js";

/**
 * AUDIT FIX FF#3 + R2 — Signed CSRF token in-memory.
 *
 * Formato: base64url( userId:timestamp:hmac_sha256(CSRF_SECRET, userId:timestamp) )
 *
 * Perché NON double-submit cookie: con Domain=.ilplatinatore.it il cookie
 * csrf_token è leggibile da document.cookie su qualsiasi subdomain. XSS su
 * www.* → attaccante replica. Il token in-memory SPA è same-origin-protected.
 *
 * CSRF_SECRET: variabile DEDICATA in env (diversa da JWT_SECRET). Validata
 * min(32) in config/env.ts.
 */

const CSRF_TTL_MS = 24 * 60 * 60 * 1000;

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function makeCsrfToken(userId: number): string {
  const ts = Date.now();
  const payload = `${userId}:${ts}`;
  const sig = hmacHex(env.CSRF_SECRET, payload);
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

export function verifyCsrfToken(token: string, userId: number): boolean {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 3) return false;
    const [uidStr, tsStr, sig] = parts as [string, string, string];
    const parsedUid = Number.parseInt(uidStr, 10);
    const parsedTs = Number.parseInt(tsStr, 10);
    if (!Number.isFinite(parsedUid) || !Number.isFinite(parsedTs)) return false;
    if (parsedUid !== userId) return false;
    if (Date.now() - parsedTs > CSRF_TTL_MS) return false;
    const expected = hmacHex(env.CSRF_SECRET, `${uidStr}:${tsStr}`);
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(sig, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
