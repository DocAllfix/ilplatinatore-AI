import { describe, it, expect, vi, beforeEach } from "vitest";
import { GuideCache, slugify, computeKey } from "./guide.cache.js";
import { redis } from "@/config/redis.js";
import { env } from "@/config/env.js";

// Usiamo ioredis-mock (applicato dal setup globale) — niente Redis reale.

vi.mock("@/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

beforeEach(async () => {
  await redis.flushall();
  vi.clearAllMocks();
});

// ── slugify ──────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercase + sostituzione spazi e simboli con trattini", () => {
    expect(slugify("Elden Ring")).toBe("elden-ring");
    expect(slugify("Hollow Knight: Silksong")).toBe("hollow-knight-silksong");
  });

  it("rimuove accenti Unicode preservando il significato", () => {
    expect(slugify("Pokémon Légendes")).toBe("pokemon-legendes");
    expect(slugify("àéìòù")).toBe("aeiou");
  });

  it("collassa trattini ripetuti e trimma trattini iniziali/finali", () => {
    expect(slugify("--Test--Game--")).toBe("test-game");
    expect(slugify("multi   spaces!!!")).toBe("multi-spaces");
  });

  it("limita a 120 caratteri (safety cap)", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBe(120);
  });

  it("ritorna stringa vuota se input è solo simboli", () => {
    expect(slugify("!!!---")).toBe("");
    expect(slugify("   ")).toBe("");
  });
});

// ── computeKey ───────────────────────────────────────────────────────────────

describe("computeKey", () => {
  it("formato canonico guide:{game}:{target}:{lang}", () => {
    expect(
      computeKey({
        gameSlug: "elden-ring",
        trophySlug: "malenia-defeated",
        topic: null,
        guideType: "trophy",
        language: "it",
      }),
    ).toBe("guide:elden-ring:malenia-defeated:it");
  });

  it("usa 'unknown' come gameSlug quando null o stringa vuota/whitespace", () => {
    expect(
      computeKey({
        gameSlug: null,
        trophySlug: "x",
        topic: null,
        guideType: "trophy",
        language: "en",
      }),
    ).toBe("guide:unknown:x:en");

    expect(
      computeKey({
        gameSlug: "   ",
        trophySlug: "x",
        topic: null,
        guideType: "trophy",
        language: "en",
      }),
    ).toBe("guide:unknown:x:en");
  });

  it("precedenza target: trophySlug > topic > guideType", () => {
    const base = { gameSlug: "g", language: "en" } as const;

    expect(
      computeKey({ ...base, trophySlug: "t", topic: "topic", guideType: "trophy" }),
    ).toBe("guide:g:t:en");

    expect(
      computeKey({ ...base, trophySlug: null, topic: "topic", guideType: "trophy" }),
    ).toBe("guide:g:topic:en");

    expect(
      computeKey({ ...base, trophySlug: null, topic: null, guideType: "platinum" }),
    ).toBe("guide:g:platinum:en");
  });

  it("default 'en' per language vuoto/non-slugifiable", () => {
    expect(
      computeKey({
        gameSlug: "g",
        trophySlug: "t",
        topic: null,
        guideType: "trophy",
        language: "!!!",
      }),
    ).toBe("guide:g:t:en");
  });

  it("normalizza game e target via slugify (Unicode + simboli)", () => {
    expect(
      computeKey({
        gameSlug: "Pokémon Sword",
        trophySlug: "Boss Final!!!",
        topic: null,
        guideType: "trophy",
        language: "it",
      }),
    ).toBe("guide:pokemon-sword:boss-final:it");
  });
});

// ── GuideCache.get ───────────────────────────────────────────────────────────

describe("GuideCache.get", () => {
  const params = {
    gameSlug: "elden-ring",
    trophySlug: "malenia",
    topic: null,
    guideType: "trophy" as const,
    language: "it",
  };

  it("ritorna null quando la chiave non esiste in Redis (MISS)", async () => {
    const result = await GuideCache.get(params);
    expect(result).toBeNull();
  });

  it("deserializza il valore JSON quando presente (HIT)", async () => {
    const value = {
      content: "guide content",
      sources: [{ guideId: 1, title: "Source A" }],
      generatedAt: Date.now(),
      templateId: "trophy",
      model: "gemini-2.5-flash",
    };
    await redis.set("guide:elden-ring:malenia:it", JSON.stringify(value));

    const result = await GuideCache.get(params);
    expect(result).toEqual(value);
  });

  it("ritorna null e non lancia su errore Redis (degrada graceful)", async () => {
    const spy = vi.spyOn(redis, "get").mockRejectedValueOnce(new Error("redis down"));

    const result = await GuideCache.get(params);
    expect(result).toBeNull();
    spy.mockRestore();
  });

  it("ritorna null su JSON corrotto in cache (try/catch swallow)", async () => {
    await redis.set("guide:elden-ring:malenia:it", "not valid json {{{");

    const result = await GuideCache.get(params);
    expect(result).toBeNull();
  });
});

// ── GuideCache.set ───────────────────────────────────────────────────────────

describe("GuideCache.set", () => {
  const params = {
    gameSlug: "elden-ring",
    trophySlug: "malenia",
    topic: null,
    guideType: "trophy" as const,
    language: "it",
  };

  const value = {
    content: "x",
    sources: [],
    generatedAt: 1700000000000,
    templateId: "trophy",
    model: "gemini-2.5-flash",
  };

  it("scrive valore JSON-serializzato con TTL configurato", async () => {
    await GuideCache.set(params, value);

    const raw = await redis.get("guide:elden-ring:malenia:it");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual(value);

    const ttl = await redis.ttl("guide:elden-ring:malenia:it");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(env.GUIDE_CACHE_TTL_SECONDS);
  });

  it("non lancia su errore Redis (degrada non-fatal)", async () => {
    const spy = vi.spyOn(redis, "setex").mockRejectedValueOnce(new Error("redis down"));

    await expect(GuideCache.set(params, value)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("set + get ritornano lo stesso oggetto (round-trip)", async () => {
    await GuideCache.set(params, value);
    const got = await GuideCache.get(params);
    expect(got).toEqual(value);
  });
});
