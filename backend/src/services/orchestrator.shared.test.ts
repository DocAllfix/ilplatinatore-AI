import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildCacheKeyParams,
  buildPromptContext,
  logAndTrack,
} from "./orchestrator.shared.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/services/guide.cache.js", () => ({
  slugify: (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/models/queryLog.model.js", () => ({
  QueryLogModel: { create: vi.fn() },
}));

vi.mock("@/models/guideRequestTracker.model.js", () => ({
  GuideRequestTrackerModel: { upsertTrophyRequest: vi.fn() },
}));

import { QueryLogModel } from "@/models/queryLog.model.js";
import { GuideRequestTrackerModel } from "@/models/guideRequestTracker.model.js";

const mockLog = vi.mocked(QueryLogModel);
const mockTracker = vi.mocked(GuideRequestTrackerModel);

beforeEach(() => {
  vi.clearAllMocks();
  mockLog.create.mockResolvedValue(undefined as never);
  mockTracker.upsertTrophyRequest.mockResolvedValue(undefined as never);
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeNorm(overrides: Record<string, unknown> = {}) {
  return {
    query: "original query",
    language: "en",
    guideType: "trophy" as const,
    topic: null,
    game: { id: 1, title: "Elden Ring", slug: "elden-ring" },
    trophy: {
      id: 10,
      psn_trophy_id: 100,
      psn_communication_id: "NPWR12345",
      rarity_source: "psn" as const,
      name_en: "Malenia",
      name_it: "Malenia IT",
      detail_en: "Defeat Malenia.",
    },
    ...overrides,
  };
}

function makeBundle(overrides: Record<string, unknown> = {}) {
  return {
    ragContext: "RAG context text",
    scrapingContext: "Scraping context text",
    sources: [],
    sourceUsed: "rag" as const,
    ...overrides,
  };
}

// ── buildCacheKeyParams ───────────────────────────────────────────────────────

describe("buildCacheKeyParams", () => {
  it("restituisce trophySlug slugificato quando trophy è presente", () => {
    const norm = makeNorm();
    const result = buildCacheKeyParams(norm as never);
    expect(result.gameSlug).toBe("elden-ring");
    expect(result.trophySlug).toContain("malenia");
    expect(result.guideType).toBe("trophy");
  });

  it("restituisce trophySlug=null quando trophy è assente", () => {
    const norm = makeNorm({ trophy: null });
    const result = buildCacheKeyParams(norm as never);
    expect(result.trophySlug).toBeNull();
  });

  it("restituisce trophySlug=null quando slugify produce stringa vuota", () => {
    // Trophy con name_en e name_it entrambi vuoti → slugify("") = "" → || null
    const norm = makeNorm({
      trophy: {
        id: 10,
        psn_trophy_id: 100,
        psn_communication_id: "NPWR12345",
        rarity_source: "psn",
        name_en: "",
        name_it: "",
        detail_en: null,
      },
    });
    const result = buildCacheKeyParams(norm as never);
    expect(result.trophySlug).toBeNull();
  });

  it("restituisce gameSlug=null quando game è assente", () => {
    const norm = makeNorm({ game: null });
    const result = buildCacheKeyParams(norm as never);
    expect(result.gameSlug).toBeNull();
  });
});

// ── buildPromptContext ────────────────────────────────────────────────────────

describe("buildPromptContext", () => {
  it("include psnAnchor e psnOfficial quando trophy con name_en è presente", () => {
    const norm = makeNorm();
    const bundle = makeBundle();
    const ctx = buildPromptContext(norm as never, bundle as never, "query");

    expect(ctx.psnAnchor).toBeDefined();
    expect(ctx.psnAnchor!.psn_trophy_id).toBe(100);
    expect(ctx.psnOfficial).toBeDefined();
    expect(ctx.psnOfficial!.officialName).toBe("Malenia");
    expect(ctx.psnOfficial!.officialDetail).toBe("Defeat Malenia.");
  });

  it("omette psnAnchor e psnOfficial quando trophy è null", () => {
    const norm = makeNorm({ trophy: null });
    const bundle = makeBundle();
    const ctx = buildPromptContext(norm as never, bundle as never, "query");

    expect(ctx.psnAnchor).toBeUndefined();
    expect(ctx.psnOfficial).toBeUndefined();
  });

  it("omette psnOfficial quando name_en è null/empty anche con trophy presente", () => {
    const norm = makeNorm({
      trophy: {
        id: 10,
        psn_trophy_id: 100,
        psn_communication_id: "NPWR12345",
        rarity_source: "psn",
        name_en: null,
        name_it: "Malenia IT",
        detail_en: null,
      },
    });
    const bundle = makeBundle();
    const ctx = buildPromptContext(norm as never, bundle as never, "query");

    expect(ctx.psnAnchor).toBeDefined();
    expect(ctx.psnOfficial).toBeUndefined();
  });

  it("usa 'gioco non identificato' quando game è null", () => {
    const norm = makeNorm({ game: null });
    const bundle = makeBundle();
    const ctx = buildPromptContext(norm as never, bundle as never, "query");

    expect(ctx.gameTitle).toBe("gioco non identificato");
  });

  it("usa query come targetName quando trophy e topic sono null", () => {
    const norm = makeNorm({ trophy: null, topic: null });
    const bundle = makeBundle();
    const ctx = buildPromptContext(norm as never, bundle as never, "fallback query");

    expect(ctx.targetName).toBe("fallback query");
  });

  it("usa topic come targetName quando trophy è null ma topic è presente", () => {
    const norm = makeNorm({ trophy: null, topic: "platinum tips" });
    const bundle = makeBundle();
    const ctx = buildPromptContext(norm as never, bundle as never, "query");

    expect(ctx.targetName).toBe("platinum tips");
  });
});

// ── logAndTrack ───────────────────────────────────────────────────────────────

describe("logAndTrack", () => {
  it("crea query_log e aggiorna tracker quando game e trophy sono presenti", async () => {
    const norm = makeNorm();
    const params = { query: "q", userId: 1, sessionId: "sess-1" };

    await logAndTrack(params as never, norm as never, "rag", 100);

    expect(mockLog.create).toHaveBeenCalledOnce();
    const logArg = mockLog.create.mock.calls[0]![0];
    expect(logArg.user_id).toBe(1);
    expect(logArg.session_id).toBe("sess-1");
    expect(logArg.source_used).toBe("rag");
    expect(logArg.response_time_ms).toBe(100);
    expect(logArg.game_detected).toBe("Elden Ring");
    expect(logArg.trophy_detected).toBe("Malenia");
    expect(mockTracker.upsertTrophyRequest).toHaveBeenCalledOnce();
  });

  it("non chiama tracker quando game è null", async () => {
    const norm = makeNorm({ game: null });
    await logAndTrack({ query: "q" } as never, norm as never, "none", 50);

    expect(mockLog.create).toHaveBeenCalledOnce();
    expect(mockTracker.upsertTrophyRequest).not.toHaveBeenCalled();
  });

  it("non chiama tracker quando trophy è null", async () => {
    const norm = makeNorm({ trophy: null });
    await logAndTrack({ query: "q" } as never, norm as never, "none", 50);

    expect(mockLog.create).toHaveBeenCalledOnce();
    expect(mockTracker.upsertTrophyRequest).not.toHaveBeenCalled();
  });

  it("usa name_it come fallback per trophy_detected quando name_en è null", async () => {
    const norm = makeNorm({
      trophy: {
        id: 10,
        psn_trophy_id: 100,
        psn_communication_id: "X",
        rarity_source: "psn",
        name_en: null,
        name_it: "Malenia IT",
        detail_en: null,
      },
    });

    await logAndTrack({ query: "q" } as never, norm as never, "scraping", 80);

    const logArg = mockLog.create.mock.calls[0]![0];
    expect(logArg.trophy_detected).toBe("Malenia IT");
  });

  it("non blocca l'esecuzione se QueryLogModel.create fallisce (non-fatal)", async () => {
    mockLog.create.mockRejectedValueOnce(new Error("DB down"));
    const norm = makeNorm({ trophy: null });

    await expect(
      logAndTrack({ query: "q" } as never, norm as never, "rag", 10),
    ).resolves.toBeUndefined();

    expect(mockTracker.upsertTrophyRequest).not.toHaveBeenCalled();
  });

  it("usa il slug id- quando name_en e name_it sono entrambi vuoti", async () => {
    const norm = makeNorm({
      trophy: {
        id: 99,
        psn_trophy_id: 1,
        psn_communication_id: "X",
        rarity_source: "psn",
        name_en: "",
        name_it: "",
        detail_en: null,
      },
    });

    await logAndTrack({ query: "q" } as never, norm as never, "rag", 10);

    const trackerArg = mockTracker.upsertTrophyRequest.mock.calls[0]![0];
    expect(trackerArg.trophy_slug).toBe("id-99");
  });
});
