import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createRateLimiter, tierRateLimiter } from "./rateLimiter.js";
import { redis } from "@/config/redis.js";

// Il rateLimiter usa `redis.eval(SCRIPT, 1, key, now, window, limit)`.
// Mocchiamo direttamente @/config/redis.js per avere controllo fine sul return
// value dello script Lua (ioredis-mock non supporta EVAL custom).
vi.mock("@/config/redis.js", () => ({
  redis: { eval: vi.fn() },
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockedRedis = vi.mocked(redis);

// ── Helpers ─────────────────────────────────────────────────────────────────

interface MockRes {
  statusCode: number;
  headers: Record<string, string | number>;
  body: unknown;
  setHeader: (k: string, v: string | number) => void;
  status: (c: number) => MockRes;
  json: (b: unknown) => MockRes;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: "10.0.0.1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  } as Request;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("rateLimiter — happy path (allowed)", () => {
  it("next() chiamato e headers X-RateLimit-* settati correttamente", async () => {
    mockedRedis.eval.mockResolvedValue([1, 9]);
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 10 });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await limiter(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(res.headers["X-RateLimit-Limit"]).toBe(10);
    expect(res.headers["X-RateLimit-Remaining"]).toBe(9);
    expect(res.headers["X-RateLimit-Window-Ms"]).toBe(60_000);
  });
});

describe("rateLimiter — blocca dopo il limite", () => {
  it("restituisce 429 con Retry-After e NON chiama next()", async () => {
    mockedRedis.eval.mockResolvedValue([0, 0]);
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 10 });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await limiter(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe(60);
    expect(res.headers["X-RateLimit-Remaining"]).toBe(0);
    expect(res.body).toEqual({
      error: "Too many requests",
      retryAfterSeconds: 60,
    });
  });
});

describe("rateLimiter — sliding window TTL (script Lua contract)", () => {
  it("lo script rimuove gli score fuori finestra e imposta PEXPIRE sulla key", async () => {
    // Verifichiamo il contratto dello script Lua passato a EVAL:
    // deve contenere ZREMRANGEBYSCORE e PEXPIRE (sliding-window).
    mockedRedis.eval.mockResolvedValue([1, 9]);
    const limiter = createRateLimiter({ windowMs: 30_000, limit: 5 });
    await limiter(
      mockReq(),
      mockRes() as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );

    const script = mockedRedis.eval.mock.calls[0]![0] as string;
    expect(script).toContain("ZREMRANGEBYSCORE");
    expect(script).toContain("PEXPIRE");
    expect(script).toContain("ZCARD");
    // I parametri posizionali: numKeys=1, key, now, windowMs, limit
    const args = mockedRedis.eval.mock.calls[0]!;
    expect(args[1]).toBe(1);
    expect(args[3]).toMatch(/^\d+$/); // now (ms epoch) come string
    expect(args[4]).toBe("30000");
    expect(args[5]).toBe("5");
  });

  it("windowLabel differisce tra due finestre differenti → key distinte", async () => {
    mockedRedis.eval.mockResolvedValue([1, 9]);
    const limiter60 = createRateLimiter({ windowMs: 60_000, limit: 10 });
    const limiter30 = createRateLimiter({ windowMs: 30_000, limit: 10 });

    await limiter60(
      mockReq(),
      mockRes() as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );
    await limiter30(
      mockReq(),
      mockRes() as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );

    const key60 = mockedRedis.eval.mock.calls[0]![2] as string;
    const key30 = mockedRedis.eval.mock.calls[1]![2] as string;
    expect(key60).toContain(":60");
    expect(key30).toContain(":30");
    expect(key60).not.toBe(key30);
  });
});

describe("rateLimiter — fail-open su errore Redis", () => {
  it("Redis throw → next() viene chiamato comunque (no 429)", async () => {
    mockedRedis.eval.mockRejectedValue(new Error("ECONNREFUSED"));
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 10 });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await limiter(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200); // non settato a 429
  });
});

describe("rateLimiter — priorita' identifier (user > session > ip)", () => {
  it("userId presente → key contains 'user:<id>'", async () => {
    mockedRedis.eval.mockResolvedValue([1, 9]);
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 10 });
    const req = mockReq({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: { userId: 123 } as any,
      sessionId: "sess-abc",
    });
    await limiter(
      req,
      mockRes() as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );
    const key = mockedRedis.eval.mock.calls[0]![2] as string;
    expect(key).toContain("user:123");
    expect(key).not.toContain("session:");
  });

  it("solo sessionId → key contains 'session:<uuid>'", async () => {
    mockedRedis.eval.mockResolvedValue([1, 9]);
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 10 });
    const req = mockReq({ sessionId: "sess-xyz" });
    await limiter(
      req,
      mockRes() as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );
    const key = mockedRedis.eval.mock.calls[0]![2] as string;
    expect(key).toContain("session:sess-xyz");
    expect(key).not.toContain("ip:");
  });

  it("né user né session → fallback su ip", async () => {
    mockedRedis.eval.mockResolvedValue([1, 9]);
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 10 });
    const req = mockReq({ ip: "192.168.1.10" });
    await limiter(
      req,
      mockRes() as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );
    const key = mockedRedis.eval.mock.calls[0]![2] as string;
    expect(key).toContain("ip:192.168.1.10");
  });
});

describe("rateLimiter — custom keyPrefix", () => {
  it("keyPrefix custom e' applicato al prefisso della chiave", async () => {
    mockedRedis.eval.mockResolvedValue([1, 9]);
    const limiter = createRateLimiter({
      windowMs: 60_000,
      limit: 10,
      keyPrefix: "rl:login",
    });
    await limiter(
      mockReq(),
      mockRes() as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );
    const key = mockedRedis.eval.mock.calls[0]![2] as string;
    expect(key.startsWith("rl:login:")).toBe(true);
  });
});

// ── tierRateLimiter (T2.6) ─────────────────────────────────────────────────

describe("tierRateLimiter — per-tier (free/registered/pro/platinum)", () => {
  it("anonymous (no user) → tier=free, key contains 'free'", async () => {
    mockedRedis.eval.mockResolvedValue([1, 4]);
    const limiter = tierRateLimiter();
    const res = mockRes();
    await limiter(
      mockReq(),
      res as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );
    expect(res.headers["X-RateLimit-Tier"]).toBe("free");
    expect(res.headers["X-RateLimit-Limit"]).toBe(5);
    const key = mockedRedis.eval.mock.calls[0]![2] as string;
    expect(key).toContain(":free:");
  });

  it("user con tier='free' MA userId noto → tier='registered' (limit 10)", async () => {
    mockedRedis.eval.mockResolvedValue([1, 9]);
    const limiter = tierRateLimiter();
    const res = mockRes();
    const req = mockReq({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: { userId: 123, tier: "free" } as any,
    });
    await limiter(
      req,
      res as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );
    expect(res.headers["X-RateLimit-Tier"]).toBe("registered");
    expect(res.headers["X-RateLimit-Limit"]).toBe(10);
  });

  it("user pro → limit 30", async () => {
    mockedRedis.eval.mockResolvedValue([1, 29]);
    const limiter = tierRateLimiter();
    const res = mockRes();
    const req = mockReq({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: { userId: 5, tier: "pro" } as any,
    });
    await limiter(
      req,
      res as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );
    expect(res.headers["X-RateLimit-Tier"]).toBe("pro");
    expect(res.headers["X-RateLimit-Limit"]).toBe(30);
  });

  it("user platinum → bypass totale (no eval, X-RateLimit-Tier=platinum)", async () => {
    const limiter = tierRateLimiter();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    const req = mockReq({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: { userId: 99, tier: "platinum" } as any,
    });
    await limiter(req, res as unknown as Response, next);

    expect(res.headers["X-RateLimit-Tier"]).toBe("platinum");
    // platinum non chiama Redis eval
    expect(mockedRedis.eval).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("limit superato per tier free → 429 con tier nel body", async () => {
    mockedRedis.eval.mockResolvedValue([0, 0]);
    const limiter = tierRateLimiter();
    const res = mockRes();
    await limiter(
      mockReq(),
      res as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );
    expect(res.statusCode).toBe(429);
    expect((res.body as Record<string, unknown>).tier).toBe("free");
  });

  it("Redis error → fail-open (next chiamato)", async () => {
    mockedRedis.eval.mockRejectedValueOnce(new Error("redis down"));
    const limiter = tierRateLimiter();
    const next = vi.fn() as unknown as NextFunction;
    await limiter(
      mockReq(),
      mockRes() as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
