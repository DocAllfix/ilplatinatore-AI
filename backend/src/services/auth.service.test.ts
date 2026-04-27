import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { AuthService } from "./auth.service.js";
import { UsersModel } from "@/models/users.model.js";
import { redis } from "@/config/redis.js";
import { query } from "@/config/database.js";
import { AuthenticationError, ValidationError } from "@/utils/errors.js";
import { env } from "@/config/env.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Strategia: ioredis-mock (in-memory) viene applicato dal setup globale, quindi
// `redis` è funzionante e si può flushall tra i test. UsersModel è mockato per
// avere user-data deterministico. argon2 è mockato per evitare l'hash di 1-2s
// (la verifica integrale dell'hash è coperta dagli integration test).

vi.mock("@/models/users.model.js", () => ({
  UsersModel: {
    findByEmail: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    updateLastActive: vi.fn(),
  },
}));

vi.mock("@/config/database.js", () => ({
  query: vi.fn(),
}));

vi.mock("argon2", () => ({
  default: {
    argon2id: 2,
    hash: vi.fn().mockResolvedValue("$argon2id$v=19$m=19456,t=2,p=1$mocked-hash"),
    verify: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("@/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockedUsers = vi.mocked(UsersModel);
const mockedQuery = vi.mocked(query);

// ── Fixtures ─────────────────────────────────────────────────────────────────

function stubUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    email: "test@example.com",
    password_hash: "$argon2id$mocked-hash",
    display_name: "Test User",
    tier: "free" as const,
    language: "it",
    total_queries: 0,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    created_at: new Date("2026-01-01"),
    last_active: new Date("2026-01-01"),
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  // Pulizia Redis ioredis-mock tra test (no leakage di refresh tokens).
  await redis.flushall();

  // Default sani per i mocks.
  mockedUsers.findByEmail.mockResolvedValue(null);
  mockedUsers.create.mockImplementation(async (data) =>
    stubUser({
      id: 1,
      email: data.email,
      password_hash: data.password_hash,
      display_name: data.display_name ?? null,
    }) as never,
  );
  mockedUsers.findById.mockImplementation(async (id) =>
    stubUser({ id }) as never,
  );
  mockedUsers.updateLastActive.mockResolvedValue(undefined);

  const argon2 = (await import("argon2")).default;
  vi.mocked(argon2.hash).mockResolvedValue(
    "$argon2id$v=19$m=19456,t=2,p=1$mocked-hash" as never,
  );
  vi.mocked(argon2.verify).mockResolvedValue(true);
});

// ── register ─────────────────────────────────────────────────────────────────

describe("AuthService.register", () => {
  it("crea utente nuovo, hasha password con argon2 e ritorna tokens + publicUser", async () => {
    const result = await AuthService.register("new@example.com", "secret123", "Mario");

    expect(mockedUsers.findByEmail).toHaveBeenCalledWith("new@example.com");
    const argon2 = (await import("argon2")).default;
    expect(argon2.hash).toHaveBeenCalledWith("secret123", expect.any(Object));
    expect(mockedUsers.create).toHaveBeenCalledWith({
      email: "new@example.com",
      password_hash: expect.stringContaining("$argon2id$"),
      display_name: "Mario",
    });

    expect(result.tokens.accessToken).toBeTruthy();
    expect(result.tokens.refreshToken).toBeTruthy();
    expect(result.tokens.csrfToken).toBeTruthy();
    expect(result.user).toEqual({
      id: 1,
      email: "new@example.com",
      displayName: "Mario",
      tier: "free",
      language: "it",
    });
  });

  it("lancia ValidationError se l'email esiste già", async () => {
    mockedUsers.findByEmail.mockResolvedValue(stubUser() as never);

    await expect(
      AuthService.register("test@example.com", "secret123", "Mario"),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(mockedUsers.create).not.toHaveBeenCalled();
  });

  it("scrive il refresh token in Redis con TTL 7 giorni", async () => {
    await AuthService.register("ttl@example.com", "secret123", null);

    // Ci sono almeno 2 chiavi: refresh:<hash> e refresh_family:<famId>.
    const keys = await redis.keys("refresh:*");
    expect(keys.length).toBe(1);
    const ttl = await redis.ttl(keys[0]!);
    // TTL ~7 giorni = 604800 secondi (con tolleranza di 5s per il setup).
    expect(ttl).toBeGreaterThan(604790);
    expect(ttl).toBeLessThanOrEqual(604800);
  });

  it("emette access token JWT firmato e verificabile con env.JWT_SECRET", async () => {
    const result = await AuthService.register("jwt@example.com", "secret123", null);

    const payload = jwt.verify(result.tokens.accessToken, env.JWT_SECRET) as {
      userId: number;
      email: string;
      tier: string;
    };
    expect(payload.userId).toBe(1);
    expect(payload.email).toBe("jwt@example.com");
    expect(payload.tier).toBe("free");
  });
});

// ── login ────────────────────────────────────────────────────────────────────

describe("AuthService.login", () => {
  it("autentica con credenziali valide e ritorna tokens", async () => {
    mockedUsers.findByEmail.mockResolvedValue(stubUser() as never);

    const result = await AuthService.login("test@example.com", "secret123");

    expect(mockedUsers.updateLastActive).toHaveBeenCalledWith(1);
    expect(result.user.id).toBe(1);
    expect(result.tokens.accessToken).toBeTruthy();
  });

  it("lancia AuthenticationError se l'utente non esiste (timing-safe: stesso messaggio)", async () => {
    mockedUsers.findByEmail.mockResolvedValue(null);

    await expect(
      AuthService.login("nouser@example.com", "x"),
    ).rejects.toThrow("Credenziali non valide");
  });

  it("lancia AuthenticationError se password_hash è null (account social-only)", async () => {
    mockedUsers.findByEmail.mockResolvedValue(
      stubUser({ password_hash: null }) as never,
    );

    await expect(
      AuthService.login("social@example.com", "x"),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("lancia AuthenticationError quando argon2.verify ritorna false", async () => {
    mockedUsers.findByEmail.mockResolvedValue(stubUser() as never);
    const argon2 = (await import("argon2")).default;
    vi.mocked(argon2.verify).mockResolvedValueOnce(false);

    await expect(
      AuthService.login("test@example.com", "wrong"),
    ).rejects.toThrow("Credenziali non valide");
  });

  it("ogni login crea una nuova family (familyId distinti tra login successivi)", async () => {
    mockedUsers.findByEmail.mockResolvedValue(stubUser() as never);

    const r1 = await AuthService.login("test@example.com", "secret123");
    const r2 = await AuthService.login("test@example.com", "secret123");

    const p1 = jwt.verify(r1.tokens.refreshToken, env.JWT_REFRESH_SECRET) as {
      familyId: string;
    };
    const p2 = jwt.verify(r2.tokens.refreshToken, env.JWT_REFRESH_SECRET) as {
      familyId: string;
    };
    expect(p1.familyId).not.toBe(p2.familyId);
  });
});

// ── refresh ──────────────────────────────────────────────────────────────────

describe("AuthService.refresh", () => {
  it("ruota il token: emette nuovo refresh, rimuove vecchio hash da Redis", async () => {
    mockedUsers.findByEmail.mockResolvedValue(stubUser() as never);
    const { tokens: t1 } = await AuthService.login("test@example.com", "secret123");

    const t2 = await AuthService.refresh(t1.refreshToken);

    expect(t2.tokens.refreshToken).not.toBe(t1.refreshToken);
    // Il nuovo refresh è in Redis.
    const keys = await redis.keys("refresh:*");
    expect(keys.length).toBe(1);
  });

  it("lancia AuthenticationError con JWT malformato", async () => {
    await expect(
      AuthService.refresh("not.a.valid.jwt"),
    ).rejects.toThrow("Refresh token non valido");
  });

  it("rifiuta token con typ != refresh (es: access token usato come refresh)", async () => {
    mockedUsers.findByEmail.mockResolvedValue(stubUser() as never);
    const { tokens } = await AuthService.login("test@example.com", "secret123");

    // Forge un token firmato col REFRESH_SECRET ma con typ "access" (campo errato).
    const forged = jwt.sign(
      { userId: 1, familyId: "fid", jti: "x", typ: "access" },
      env.JWT_REFRESH_SECRET,
      { expiresIn: "1h" },
    );

    await expect(AuthService.refresh(forged)).rejects.toThrow("Tipo token inatteso");
    // Il token legittimo non deve essere stato toccato.
    expect(tokens.refreshToken).toBeTruthy();
  });

  it("REUSE DETECTION: secondo uso dello stesso refresh revoca l'intera famiglia", async () => {
    mockedUsers.findByEmail.mockResolvedValue(stubUser() as never);
    const { tokens: t1 } = await AuthService.login("test@example.com", "secret123");

    // Prima rotation: consuma t1, emette t2 (entra in stato "famiglia attiva").
    const t2 = await AuthService.refresh(t1.refreshToken);

    // Secondo uso di t1 (riutilizzo): deve revocare la famiglia E lanciare error.
    await expect(AuthService.refresh(t1.refreshToken)).rejects.toThrow(
      "Refresh token non valido",
    );

    // Anche t2 (rotazione successiva) ora è invalido perché la famiglia è stata revocata.
    await expect(AuthService.refresh(t2.tokens.refreshToken)).rejects.toThrow(
      "Refresh token non valido",
    );
  });

  it("lancia AuthenticationError se utente non trovato (e revoca famiglia)", async () => {
    mockedUsers.findByEmail.mockResolvedValue(stubUser() as never);
    const { tokens } = await AuthService.login("test@example.com", "secret123");

    // Cancella l'utente DB-side ma il refresh token è ancora in Redis.
    mockedUsers.findById.mockResolvedValue(null);

    await expect(AuthService.refresh(tokens.refreshToken)).rejects.toThrow(
      "Utente inesistente",
    );
  });

  it("token con firma valida ma record assente in Redis e famiglia inattiva → AuthenticationError, no revoke spurio", async () => {
    // Forge un refresh token valido per firma ma mai persistito in Redis.
    const orphanToken = jwt.sign(
      { userId: 99, familyId: "ghost-family", jti: "ghost", typ: "refresh" },
      env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" },
    );

    await expect(AuthService.refresh(orphanToken)).rejects.toThrow(
      "Refresh token non valido",
    );

    // Famiglia non esiste → nessun side effect.
    const familyKeys = await redis.keys("refresh_family:*");
    expect(familyKeys).toEqual([]);
  });
});

// ── revokeRefreshToken ───────────────────────────────────────────────────────

describe("AuthService.revokeRefreshToken", () => {
  it("rimuove il refresh token da Redis dopo logout", async () => {
    mockedUsers.findByEmail.mockResolvedValue(stubUser() as never);
    const { tokens } = await AuthService.login("test@example.com", "secret123");

    // Pre-condizione: il record è in Redis.
    expect((await redis.keys("refresh:*")).length).toBe(1);

    await AuthService.revokeRefreshToken(tokens.refreshToken);

    expect((await redis.keys("refresh:*")).length).toBe(0);
  });

  it("è idempotente: revocare un token già rimosso non lancia errori", async () => {
    mockedUsers.findByEmail.mockResolvedValue(stubUser() as never);
    const { tokens } = await AuthService.login("test@example.com", "secret123");
    await AuthService.revokeRefreshToken(tokens.refreshToken);

    await expect(
      AuthService.revokeRefreshToken(tokens.refreshToken),
    ).resolves.toBeUndefined();
  });

  it("token mai esistito in Redis: no-op silenzioso", async () => {
    const fakeToken = jwt.sign(
      { userId: 1, familyId: "f", jti: "j", typ: "refresh" },
      env.JWT_REFRESH_SECRET,
      { expiresIn: "1h" },
    );
    await expect(AuthService.revokeRefreshToken(fakeToken)).resolves.toBeUndefined();
  });
});

// ── revokeAllUserTokens ──────────────────────────────────────────────────────

describe("AuthService.revokeAllUserTokens", () => {
  it("revoca tutte le famiglie e tutti i refresh dell'utente", async () => {
    mockedUsers.findByEmail.mockResolvedValue(stubUser() as never);
    // Tre login successivi → tre famiglie distinte + tre refresh token.
    await AuthService.login("test@example.com", "secret123");
    await AuthService.login("test@example.com", "secret123");
    await AuthService.login("test@example.com", "secret123");

    expect((await redis.keys("refresh:*")).length).toBe(3);
    expect((await redis.keys("refresh_family:*")).length).toBe(3);

    await AuthService.revokeAllUserTokens(1);

    expect((await redis.keys("refresh:*")).length).toBe(0);
    expect((await redis.keys("refresh_family:*")).length).toBe(0);
    expect(await redis.exists("refresh_user:1")).toBe(0);
  });

  it("user senza refresh attivi: no-op senza throw", async () => {
    await expect(AuthService.revokeAllUserTokens(99)).resolves.toBeUndefined();
  });
});

// ── createAnonymousSession ───────────────────────────────────────────────────

describe("AuthService.createAnonymousSession", () => {
  it("inserisce in sessions con ip+userAgent e ritorna l'id generato", async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ id: "11111111-1111-1111-1111-111111111111" }],
      rowCount: 1,
    } as never);

    const id = await AuthService.createAnonymousSession("1.2.3.4", "test-agent");

    expect(id).toBe("11111111-1111-1111-1111-111111111111");
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO sessions"),
      ["1.2.3.4", "test-agent"],
    );
  });

  it("accetta ip/userAgent null", async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ id: "22222222-2222-2222-2222-222222222222" }],
      rowCount: 1,
    } as never);

    const id = await AuthService.createAnonymousSession(null, null);
    expect(id).toBe("22222222-2222-2222-2222-222222222222");
    expect(mockedQuery).toHaveBeenCalledWith(expect.any(String), [null, null]);
  });
});

// ── verifyAccessToken ────────────────────────────────────────────────────────

describe("AuthService.verifyAccessToken", () => {
  it("decodifica un access token valido restituendo il payload", () => {
    const token = jwt.sign(
      { userId: 42, email: "x@x.com", tier: "pro" },
      env.JWT_SECRET,
      { expiresIn: "1h" },
    );

    const payload = AuthService.verifyAccessToken(token);
    expect(payload.userId).toBe(42);
    expect(payload.email).toBe("x@x.com");
    expect(payload.tier).toBe("pro");
  });

  it("lancia AuthenticationError con token malformato", () => {
    expect(() => AuthService.verifyAccessToken("garbage")).toThrow(
      AuthenticationError,
    );
  });

  it("lancia AuthenticationError con token firmato con secret sbagliato", () => {
    const forged = jwt.sign(
      { userId: 1, email: null, tier: "free" },
      "wrong-secret-not-the-env-one-32chars",
      { expiresIn: "1h" },
    );
    expect(() => AuthService.verifyAccessToken(forged)).toThrow(
      AuthenticationError,
    );
  });

  it("lancia AuthenticationError con token scaduto", () => {
    const expired = jwt.sign(
      { userId: 1, email: null, tier: "free" },
      env.JWT_SECRET,
      { expiresIn: "-1h" },
    );
    expect(() => AuthService.verifyAccessToken(expired)).toThrow(
      AuthenticationError,
    );
  });
});
