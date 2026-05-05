import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/config/env.js", () => ({
  env: {
    IGDB_CLIENT_ID: "test-client-id",
    IGDB_CLIENT_SECRET: "test-client-secret",
  },
}));

vi.mock("@/config/redis.js", () => ({
  redis: {
    get: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
  },
}));

import { redis } from "@/config/redis.js";
import { env } from "@/config/env.js";
import { IgdbClient } from "./igdb.client.js";

const mockRedis = vi.mocked(redis);
const mockEnv = vi.mocked(env) as { IGDB_CLIENT_ID: string; IGDB_CLIENT_SECRET: string };

// Helper: costruisce la risposta fetch() standard per /token
function makeFetchToken(token = "access_token_xyz") {
  return { ok: true, status: 200, json: async () => ({ access_token: token }) };
}

// Helper: costruisce un record IGDB games
function makeIgdbRecord(overrides = {}) {
  return {
    id: 1234,
    name: "Elden Ring",
    slug: "elden-ring",
    cover: null,
    platforms: [167, 48],
    first_release_date: 1645747200, // 2022-02-25
    genres: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.get.mockResolvedValue(null);
  mockRedis.setex.mockResolvedValue("OK" as never);
  mockRedis.del.mockResolvedValue(1 as never);
});

// ── Guard: credenziali vuote ──────────────────────────────────────────────────

describe("IgdbClient.searchByTitle — guard credenziali", () => {
  it("ritorna [] se IGDB_CLIENT_ID è stringa vuota", async () => {
    (mockEnv as Record<string, string>).IGDB_CLIENT_ID = "";
    const results = await IgdbClient.searchByTitle("Elden Ring");
    expect(results).toEqual([]);
    (mockEnv as Record<string, string>).IGDB_CLIENT_ID = "test-client-id";
  });

  it("ritorna [] se IGDB_CLIENT_SECRET è stringa vuota", async () => {
    (mockEnv as Record<string, string>).IGDB_CLIENT_SECRET = "";
    const results = await IgdbClient.searchByTitle("Elden Ring");
    expect(results).toEqual([]);
    (mockEnv as Record<string, string>).IGDB_CLIENT_SECRET = "test-client-secret";
  });
});

// ── Token caching ─────────────────────────────────────────────────────────────

describe("IgdbClient — token caching in Redis", () => {
  it("usa il token cachato senza chiamare Twitch", async () => {
    mockRedis.get.mockResolvedValue("cached-token-abc");

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response);

    await IgdbClient.searchByTitle("test");

    // fetch chiamato UNA volta sola per /games (non per /token)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toContain("/games");
    fetchSpy.mockRestore();
  });

  it("chiama Twitch e salva in Redis se cache miss", async () => {
    mockRedis.get.mockResolvedValue(null);

    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeFetchToken("new-token") as unknown as Response)
      .mockResolvedValue({ ok: true, status: 200, json: async () => [] } as Response);

    await IgdbClient.searchByTitle("test");

    expect(fetchSpy.mock.calls[0]![0]).toContain("oauth2/token");
    expect(mockRedis.setex).toHaveBeenCalledWith(
      "igdb:twitch_token",
      expect.any(Number),
      "new-token",
    );
    fetchSpy.mockRestore();
  });
});

// ── Parse risposta IGDB ───────────────────────────────────────────────────────

describe("IgdbClient.searchByTitle — parsing risposta", () => {
  it("mappa correttamente campi IGDB → IgdbGame", async () => {
    mockRedis.get.mockResolvedValue("tok");

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [makeIgdbRecord()],
    } as Response);

    const results = await IgdbClient.searchByTitle("Elden Ring");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      igdb_id: 1234,
      title: "Elden Ring",
      slug: "elden-ring",
      platforms: expect.arrayContaining(["PS5", "PS4"]),
    });
    expect(results[0]!.release_date).toBeInstanceOf(Date);
    fetchSpy.mockRestore();
  });

  it("scarta record senza id numerico", async () => {
    mockRedis.get.mockResolvedValue("tok");

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ name: "NoId", slug: "no-id" }],
    } as Response);

    const results = await IgdbClient.searchByTitle("NoId");
    expect(results).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  it("ritorna [] se IGDB risponde con array vuoto", async () => {
    mockRedis.get.mockResolvedValue("tok");

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response);

    const results = await IgdbClient.searchByTitle("Unknown Game XYZ");
    expect(results).toHaveLength(0);
    fetchSpy.mockRestore();
  });
});

// ── Retry su 401 ──────────────────────────────────────────────────────────────

describe("IgdbClient — retry su 401", () => {
  it("su 401 invalida cache Redis, refetcha token, e riprova la query", async () => {
    mockRedis.get
      .mockResolvedValueOnce("expired-token")
      .mockResolvedValueOnce(null);

    const fetchSpy = vi.spyOn(global, "fetch")
      // Prima chiamata /games → 401
      .mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" } as Response)
      // Seconda chiamata /token → nuovo token
      .mockResolvedValueOnce(makeFetchToken("fresh-token") as unknown as Response)
      // Terza chiamata /games → OK
      .mockResolvedValue({ ok: true, status: 200, json: async () => [makeIgdbRecord()] } as Response);

    const results = await IgdbClient.searchByTitle("Elden Ring");

    expect(mockRedis.del).toHaveBeenCalledWith("igdb:twitch_token");
    expect(results).toHaveLength(1);
    fetchSpy.mockRestore();
  });
});

// ── Comportamento su errore di fetch ─────────────────────────────────────────

describe("IgdbClient.searchByTitle — errori", () => {
  it("ritorna [] se fetch lancia eccezione (non propaga)", async () => {
    mockRedis.get.mockResolvedValue("tok");

    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("Network error"));

    const results = await IgdbClient.searchByTitle("crash");
    expect(results).toEqual([]);
    fetchSpy.mockRestore();
  });
});
