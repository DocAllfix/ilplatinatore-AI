import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { createHash, randomUUID } from "node:crypto";
import { env } from "@/config/env.js";
import { redis } from "@/config/redis.js";
import { logger } from "@/utils/logger.js";
import { query } from "@/config/database.js";
import { UsersModel, type UserRow } from "@/models/users.model.js";
import { AuthenticationError, ValidationError } from "@/utils/errors.js";
import { makeCsrfToken } from "@/services/auth.csrf.js";

/**
 * AUDIT FIX Warning #1 — argon2id config (OWASP 2024+).
 * memoryCost in KiB: 19456 = 19 MiB. timeCost=2, parallelism=1.
 * bcrypt sostituito: limite 72 byte password + trade-off tempo/memoria peggiore.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

const ACCESS_TTL = "1h" as const;
const REFRESH_TTL_SEC = 7 * 24 * 60 * 60;

export type Tier = UserRow["tier"];

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
}

export interface PublicUser {
  id: number;
  email: string | null;
  displayName: string | null;
  tier: Tier;
  language: string;
}

export interface AccessPayload {
  userId: number;
  email: string | null;
  tier: Tier;
  iat?: number;
  exp?: number;
}

export interface RefreshPayload {
  userId: number;
  familyId: string;
  jti: string;
  typ: "refresh";
  iat?: number;
  exp?: number;
}

interface RedisRefreshRecord {
  userId: number;
  familyId: string;
  createdAt: number;
  ip: string | null;
}

// ── Helpers locali ────────────────────────────────────────────
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    tier: u.tier,
    language: u.language,
  };
}

// ── Redis token writer — indici O(K) per reuse detection (FF-NEW-2 / R1 / W1)
async function writeRefreshPair(params: {
  refreshToken: string;
  userId: number;
  familyId: string;
  ip: string | null;
  oldHash?: string;
}): Promise<void> {
  const newHash = sha256(params.refreshToken);
  const record: RedisRefreshRecord = {
    userId: params.userId,
    familyId: params.familyId,
    createdAt: Date.now(),
    ip: params.ip,
  };
  const pipe = redis.multi();
  if (params.oldHash) {
    // Rotation: rimuovi il vecchio PRIMA di pubblicare il nuovo (atomico nel MULTI).
    pipe.del(`refresh:${params.oldHash}`);
    pipe.srem(`refresh_family:${params.familyId}`, params.oldHash);
  }
  pipe.set(
    `refresh:${newHash}`,
    JSON.stringify(record),
    "EX",
    REFRESH_TTL_SEC,
  );
  pipe.sadd(`refresh_family:${params.familyId}`, newHash);
  pipe.expire(`refresh_family:${params.familyId}`, REFRESH_TTL_SEC);
  pipe.sadd(`refresh_user:${params.userId}`, params.familyId);
  pipe.expire(`refresh_user:${params.userId}`, REFRESH_TTL_SEC);
  await pipe.exec();
}

async function buildTokenPair(
  user: UserRow,
  familyId: string,
  ip: string | null,
  oldHash?: string,
): Promise<TokenPair> {
  const accessPayload: AccessPayload = {
    userId: user.id,
    email: user.email,
    tier: user.tier,
  };
  const accessToken = jwt.sign(accessPayload, env.JWT_SECRET, {
    expiresIn: ACCESS_TTL,
  });
  const refreshPayload: RefreshPayload = {
    userId: user.id,
    familyId,
    jti: randomUUID(),
    typ: "refresh",
  };
  const refreshToken = jwt.sign(refreshPayload, env.JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TTL_SEC,
  });
  await writeRefreshPair({
    refreshToken,
    userId: user.id,
    familyId,
    ip,
    ...(oldHash ? { oldHash } : {}),
  });
  return {
    accessToken,
    refreshToken,
    csrfToken: makeCsrfToken(user.id),
  };
}

// ── Revoca famiglia (reuse detection + revokeAllUserTokens) ───
async function revokeFamily(familyId: string, userId: number): Promise<void> {
  const familyKey = `refresh_family:${familyId}`;
  const members = await redis.smembers(familyKey);
  const pipe = redis.multi();
  for (const h of members) pipe.del(`refresh:${h}`);
  pipe.del(familyKey);
  pipe.srem(`refresh_user:${userId}`, familyId);
  await pipe.exec();
}

// ── AuthService API pubblica ─────────────────────────────────
export const AuthService = {
  async register(
    email: string,
    password: string,
    displayName: string | null,
    ip: string | null = null,
  ): Promise<{ tokens: TokenPair; user: PublicUser }> {
    const existing = await UsersModel.findByEmail(email);
    if (existing) throw new ValidationError("Email già registrata");
    const hash = await argon2.hash(password, ARGON2_OPTIONS);
    const user = await UsersModel.create({
      email,
      password_hash: hash,
      display_name: displayName,
    });
    const tokens = await buildTokenPair(user, randomUUID(), ip);
    logger.info({ userId: user.id }, "auth: user registered");
    return { tokens, user: toPublicUser(user) };
  },

  async login(
    email: string,
    password: string,
    ip: string | null = null,
  ): Promise<{ tokens: TokenPair; user: PublicUser }> {
    const user = await UsersModel.findByEmail(email);
    // Timing-safe: l'errore non distingue user-absent da password-wrong.
    if (!user || !user.password_hash) {
      throw new AuthenticationError("Credenziali non valide");
    }
    const ok = await argon2.verify(user.password_hash, password);
    if (!ok) throw new AuthenticationError("Credenziali non valide");
    await UsersModel.updateLastActive(user.id);
    const tokens = await buildTokenPair(user, randomUUID(), ip);
    logger.info({ userId: user.id }, "auth: user logged in");
    return { tokens, user: toPublicUser(user) };
  },

  async refresh(
    refreshJwt: string,
    ip: string | null = null,
  ): Promise<{ tokens: TokenPair; user: PublicUser }> {
    let payload: RefreshPayload;
    try {
      payload = jwt.verify(refreshJwt, env.JWT_REFRESH_SECRET) as RefreshPayload;
    } catch {
      throw new AuthenticationError("Refresh token non valido");
    }
    if (payload.typ !== "refresh") {
      throw new AuthenticationError("Tipo token inatteso");
    }
    const oldHash = sha256(refreshJwt);
    const storedRaw = await redis.get(`refresh:${oldHash}`);
    if (!storedRaw) {
      // Firma valida + record assente + famiglia ancora viva ⇒ replay detected.
      const familyActive = await redis.exists(
        `refresh_family:${payload.familyId}`,
      );
      if (familyActive) {
        await revokeFamily(payload.familyId, payload.userId);
        logger.warn(
          { userId: payload.userId, familyId: payload.familyId, ip },
          "auth: refresh token reuse detected — family revoked",
        );
      }
      throw new AuthenticationError("Refresh token non valido");
    }
    const user = await UsersModel.findById(payload.userId);
    if (!user) {
      await revokeFamily(payload.familyId, payload.userId);
      throw new AuthenticationError("Utente inesistente");
    }
    const tokens = await buildTokenPair(user, payload.familyId, ip, oldHash);
    return { tokens, user: toPublicUser(user) };
  },

  async revokeRefreshToken(refreshJwt: string): Promise<void> {
    const hash = sha256(refreshJwt);
    const raw = await redis.get(`refresh:${hash}`);
    if (!raw) return;
    const rec = JSON.parse(raw) as RedisRefreshRecord;
    const pipe = redis.multi();
    pipe.del(`refresh:${hash}`);
    pipe.srem(`refresh_family:${rec.familyId}`, hash);
    await pipe.exec();
  },

  async revokeAllUserTokens(userId: number): Promise<void> {
    const families = await redis.smembers(`refresh_user:${userId}`);
    for (const familyId of families) {
      const members = await redis.smembers(`refresh_family:${familyId}`);
      const pipe = redis.multi();
      for (const h of members) pipe.del(`refresh:${h}`);
      pipe.del(`refresh_family:${familyId}`);
      await pipe.exec();
    }
    await redis.del(`refresh_user:${userId}`);
    logger.info(
      { userId, families: families.length },
      "auth: all user tokens revoked",
    );
  },

  async createAnonymousSession(
    ip: string | null,
    userAgent: string | null,
  ): Promise<string> {
    const res = await query<{ id: string }>(
      `-- Crea sessione anonima per tracking free-tier pre-registrazione.
       -- TTL 24h gestito a DB dalla default expires_at (migration 007).
       INSERT INTO sessions (ip_address, user_agent)
       VALUES ($1, $2)
       RETURNING id`,
      [ip, userAgent],
    );
    return res.rows[0]!.id;
  },

  verifyAccessToken(token: string): AccessPayload {
    try {
      return jwt.verify(token, env.JWT_SECRET) as AccessPayload;
    } catch {
      throw new AuthenticationError("Access token non valido");
    }
  },
};
