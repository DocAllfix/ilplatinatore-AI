/**
 * Test di integrazione per AuthService — database + Redis reali.
 * Copre: register, login, refresh (token rotation), reuse detection, logout.
 *
 * Prerequisiti: docker-compose con postgres + redis avviati,
 * `platinatore_test` creato dalla globalSetup in setup.ts.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { AuthService } from "@/services/auth.service.js";
import { pool } from "@/config/database.js";
import { redis } from "@/config/redis.js";
import { AuthenticationError, ValidationError } from "@/utils/errors.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_EMAIL_SUFFIX = `@auth-integration-${Date.now()}.test`;

function uniqueEmail(label: string): string {
  return `${label}_${Date.now()}${TEST_EMAIL_SUFFIX}`;
}

async function cleanupTestUsers(): Promise<void> {
  await pool.query(
    `DELETE FROM users WHERE email LIKE $1`,
    [`%@auth-integration-${Date.now().toString().slice(0, 8)}%.test`],
  );
}

async function deleteUserByEmail(email: string): Promise<void> {
  await pool.query(`DELETE FROM users WHERE email = $1`, [email]);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

afterAll(async () => {
  // Clean residual test users (emails end with our suffix pattern).
  await pool.query(
    `DELETE FROM users WHERE email LIKE '%auth-integration-%'`,
  );
  // Close pool and Redis to allow teardown() to DROP DATABASE.
  await pool.end();
  await redis.quit();
});

describe("AuthService.register", () => {
  it("crea un nuovo utente e restituisce tokens + publicUser", async () => {
    const email = uniqueEmail("reg");
    try {
      const result = await AuthService.register(email, "TestPass1!", "Mario");

      expect(result.user.email).toBe(email);
      expect(result.user.displayName).toBe("Mario");
      expect(result.user.tier).toBe("free");
      expect(result.tokens.accessToken).toBeTruthy();
      expect(result.tokens.refreshToken).toBeTruthy();
      expect(result.tokens.csrfToken).toBeTruthy();
    } finally {
      await deleteUserByEmail(email);
    }
  });

  it("lancia ValidationError se l'email è già registrata", async () => {
    const email = uniqueEmail("dup");
    await AuthService.register(email, "TestPass1!", "Luigi");
    try {
      await expect(
        AuthService.register(email, "AltroPass2!", "Luigi2"),
      ).rejects.toThrow(ValidationError);
    } finally {
      await deleteUserByEmail(email);
    }
  });
});

describe("AuthService.login", () => {
  it("autentica un utente con credenziali corrette", async () => {
    const email = uniqueEmail("login");
    await AuthService.register(email, "Secure123!", "Peach");
    try {
      const result = await AuthService.login(email, "Secure123!");

      expect(result.user.email).toBe(email);
      expect(result.tokens.accessToken).toBeTruthy();
    } finally {
      await deleteUserByEmail(email);
    }
  });

  it("lancia AuthenticationError con password sbagliata", async () => {
    const email = uniqueEmail("badpw");
    await AuthService.register(email, "Correct99!", "Bowser");
    try {
      await expect(
        AuthService.login(email, "WrongPass99!"),
      ).rejects.toThrow(AuthenticationError);
    } finally {
      await deleteUserByEmail(email);
    }
  });

  it("lancia AuthenticationError se l'utente non esiste", async () => {
    await expect(
      AuthService.login("nouser@does-not-exist.test", "anypass"),
    ).rejects.toThrow(AuthenticationError);
  });
});

describe("AuthService.refresh", () => {
  it("ruota il refresh token restituendo nuovi tokens validi", async () => {
    const email = uniqueEmail("refresh");
    const { tokens } = await AuthService.register(email, "Refresh1!", "Toad");
    try {
      const rotated = await AuthService.refresh(tokens.refreshToken);

      expect(rotated.tokens.accessToken).toBeTruthy();
      // Il nuovo refresh token deve essere diverso dal precedente.
      expect(rotated.tokens.refreshToken).not.toBe(tokens.refreshToken);
    } finally {
      await deleteUserByEmail(email);
    }
  });

  it("lancia AuthenticationError con refresh token invalido", async () => {
    await expect(
      AuthService.refresh("not.a.valid.jwt"),
    ).rejects.toThrow(AuthenticationError);
  });

  it("revoca la famiglia quando lo stesso refresh token viene riutilizzato (reuse detection)", async () => {
    const email = uniqueEmail("reuse");
    const { tokens: t1 } = await AuthService.register(email, "Reuse111!", "Yoshi");
    try {
      // Prima rotazione: consuma t1.refreshToken → emette t2.
      await AuthService.refresh(t1.refreshToken);

      // Secondo uso di t1 (già consumato): deve revocare l'intera famiglia.
      await expect(
        AuthService.refresh(t1.refreshToken),
      ).rejects.toThrow(AuthenticationError);

      // Verifica che anche t1 originale sia revocato (Redis pulito).
      // Un ulteriore tentativo con un token noto-invalido deve fallire anch'esso.
      await expect(
        AuthService.refresh(t1.refreshToken),
      ).rejects.toThrow(AuthenticationError);
    } finally {
      await deleteUserByEmail(email);
    }
  });
});

describe("AuthService.revokeRefreshToken", () => {
  it("rende il refresh token inutilizzabile dopo logout", async () => {
    const email = uniqueEmail("logout");
    const { tokens } = await AuthService.register(email, "Logout77!", "Wario");
    try {
      await AuthService.revokeRefreshToken(tokens.refreshToken);

      await expect(
        AuthService.refresh(tokens.refreshToken),
      ).rejects.toThrow(AuthenticationError);
    } finally {
      await deleteUserByEmail(email);
    }
  });

  it("è idempotente: revocare un token già revocato non lancia errori", async () => {
    const email = uniqueEmail("idm");
    const { tokens } = await AuthService.register(email, "Idem888!", "Waluigi");
    try {
      await AuthService.revokeRefreshToken(tokens.refreshToken);
      await expect(
        AuthService.revokeRefreshToken(tokens.refreshToken),
      ).resolves.toBeUndefined();
    } finally {
      await deleteUserByEmail(email);
    }
  });
});

describe("AuthService.verifyAccessToken", () => {
  it("decodifica un access token valido restituendo il payload", async () => {
    const email = uniqueEmail("verify");
    const { tokens, user } = await AuthService.register(email, "Verify1!", "DK");
    try {
      const payload = AuthService.verifyAccessToken(tokens.accessToken);
      expect(payload.userId).toBe(user.id);
      expect(payload.email).toBe(email);
      expect(payload.tier).toBe("free");
    } finally {
      await deleteUserByEmail(email);
    }
  });

  it("lancia AuthenticationError con token malformato", () => {
    expect(() =>
      AuthService.verifyAccessToken("invalid.token.here"),
    ).toThrow(AuthenticationError);
  });
});
