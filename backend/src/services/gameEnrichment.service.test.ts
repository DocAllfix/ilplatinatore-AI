import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/config/env.js", () => ({
  env: { ON_DEMAND_HARVEST_ENABLED: false },
}));

vi.mock("@/models/games.model.js", () => ({
  GamesModel: {
    searchWithScores: vi.fn(),
    findByIgdbId: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("@/models/guideDrafts.model.js", () => ({
  GuideDraftsModel: {
    linkGame: vi.fn(),
  },
}));

vi.mock("@/services/igdb.client.js", () => ({
  IgdbClient: {
    searchByTitle: vi.fn(),
  },
}));

vi.mock("@/services/onDemandHarvest.service.js", () => ({
  OnDemandHarvestService: {
    triggerHarvest: vi.fn(),
  },
}));

vi.mock("@/services/guide.cache.js", () => ({
  slugify: (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120),
}));

import { GamesModel } from "@/models/games.model.js";
import { GuideDraftsModel } from "@/models/guideDrafts.model.js";
import { IgdbClient } from "@/services/igdb.client.js";
import { OnDemandHarvestService } from "@/services/onDemandHarvest.service.js";
import { env } from "@/config/env.js";
import { resolveOrCreateGame } from "./gameEnrichment.service.js";

const mockGames = vi.mocked(GamesModel);
const mockDrafts = vi.mocked(GuideDraftsModel);
const mockIgdb = vi.mocked(IgdbClient);
const mockHarvest = vi.mocked(OnDemandHarvestService);
const mockEnv = vi.mocked(env) as { ON_DEMAND_HARVEST_ENABLED: boolean };

const DRAFT_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeGameRow(overrides = {}) {
  return {
    id: 42,
    title: "Elden Ring",
    slug: "elden-ring",
    platform: ["PS5"],
    release_date: new Date("2022-02-25"),
    genre: [],
    cover_url: "https://cdn.igdb.com/covers/elden-ring.jpg",
    metadata: {},
    igdb_id: 119133,
    steam_appid: null,
    auto_created: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeIgdbResult(overrides = {}) {
  return {
    igdb_id: 119133,
    title: "Elden Ring",
    slug: "elden-ring",
    cover_url: "https://cdn.igdb.com/covers/elden-ring.jpg",
    platforms: ["PS5", "PS4"],
    genre: [],
    release_date: new Date("2022-02-25"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGames.searchWithScores.mockResolvedValue([]);
  mockGames.findByIgdbId.mockResolvedValue(null);
  mockGames.create.mockResolvedValue(makeGameRow() as never);
  mockIgdb.searchByTitle.mockResolvedValue([]);
  mockDrafts.linkGame.mockResolvedValue(makeGameRow() as never);
  mockEnv.ON_DEMAND_HARVEST_ENABLED = false;
});

// ── Path 1: riusa gioco esistente in DB ──────────────────────────────────────

describe("resolveOrCreateGame — riuso DB esistente", () => {
  it("ritorna il gioco esistente se similarity > 0.8 senza creare nulla", async () => {
    const existing = makeGameRow();
    mockGames.searchWithScores.mockResolvedValue([
      { game: existing as never, similarity: 0.9 },
    ]);

    const result = await resolveOrCreateGame(DRAFT_ID, "Elden Ring");

    expect(result.source).toBe("existing");
    expect(result.game.id).toBe(42);
    expect(mockGames.create).not.toHaveBeenCalled();
    expect(mockIgdb.searchByTitle).not.toHaveBeenCalled();
  });

  it("NON riusa se similarity <= 0.8", async () => {
    mockGames.searchWithScores.mockResolvedValue([
      { game: makeGameRow() as never, similarity: 0.75 },
    ]);
    mockIgdb.searchByTitle.mockResolvedValue([makeIgdbResult()]);
    mockGames.create.mockResolvedValue(makeGameRow() as never);

    const result = await resolveOrCreateGame(DRAFT_ID, "Eldin Ring");

    expect(result.source).not.toBe("existing");
    expect(mockGames.create).toHaveBeenCalled();
  });

  it("chiama linkGame su path existing", async () => {
    mockGames.searchWithScores.mockResolvedValue([
      { game: makeGameRow() as never, similarity: 0.95 },
    ]);

    await resolveOrCreateGame(DRAFT_ID, "Elden Ring");

    expect(mockDrafts.linkGame).toHaveBeenCalledWith(DRAFT_ID, 42);
  });
});

// ── Path 2: crea da IGDB ─────────────────────────────────────────────────────

describe("resolveOrCreateGame — creazione da IGDB", () => {
  it("crea il gioco da IGDB e ritorna source=igdb", async () => {
    mockIgdb.searchByTitle.mockResolvedValue([makeIgdbResult()]);
    mockGames.create.mockResolvedValue(makeGameRow({ igdb_id: 119133, auto_created: true }) as never);

    const result = await resolveOrCreateGame(DRAFT_ID, "Elden Ring");

    expect(result.source).toBe("igdb");
    expect(mockGames.create).toHaveBeenCalledWith(expect.objectContaining({
      igdb_id: 119133,
      auto_created: true,
    }));
  });

  it("idempotente: se igdb_id già in DB, usa il gioco esistente senza duplicare", async () => {
    mockIgdb.searchByTitle.mockResolvedValue([makeIgdbResult()]);
    mockGames.findByIgdbId.mockResolvedValue(makeGameRow({ igdb_id: 119133 }) as never);

    const result = await resolveOrCreateGame(DRAFT_ID, "Elden Ring");

    expect(result.source).toBe("igdb");
    expect(mockGames.create).not.toHaveBeenCalled();
    expect(mockDrafts.linkGame).toHaveBeenCalledWith(DRAFT_ID, 42);
  });

  it("chiama linkGame su path igdb", async () => {
    mockIgdb.searchByTitle.mockResolvedValue([makeIgdbResult()]);
    mockGames.create.mockResolvedValue(makeGameRow() as never);

    await resolveOrCreateGame(DRAFT_ID, "Elden Ring");

    expect(mockDrafts.linkGame).toHaveBeenCalledWith(DRAFT_ID, 42);
  });
});

// ── Path 3: fallback minimal ─────────────────────────────────────────────────

describe("resolveOrCreateGame — fallback minimal", () => {
  it("crea gioco minimale se IGDB ritorna array vuoto", async () => {
    mockIgdb.searchByTitle.mockResolvedValue([]);
    mockGames.create.mockResolvedValue(
      makeGameRow({ title: "Hollow Knight Silksong", igdb_id: null, auto_created: true }) as never,
    );

    const result = await resolveOrCreateGame(DRAFT_ID, "Hollow Knight Silksong");

    expect(result.source).toBe("minimal");
    expect(mockGames.create).toHaveBeenCalledWith(expect.objectContaining({
      title: "Hollow Knight Silksong",
      auto_created: true,
    }));
    expect(mockGames.create.mock.calls[0]![0]).not.toHaveProperty("igdb_id");
  });

  it("crea gioco minimale se IgdbClient ritorna [] (es. credenziali assenti o errore interno)", async () => {
    // IgdbClient.searchByTitle swallowa internamente le eccezioni e ritorna [].
    // Il service deve fare fallback minimal anche in quel caso.
    mockIgdb.searchByTitle.mockResolvedValue([]);

    const result = await resolveOrCreateGame(DRAFT_ID, "Crash Bandicoot");

    expect(result.source).toBe("minimal");
    expect(mockGames.create).toHaveBeenCalled();
  });

  it("chiama linkGame anche su path minimal", async () => {
    mockIgdb.searchByTitle.mockResolvedValue([]);
    mockGames.create.mockResolvedValue(makeGameRow() as never);

    await resolveOrCreateGame(DRAFT_ID, "Unknown Game");

    expect(mockDrafts.linkGame).toHaveBeenCalledWith(DRAFT_ID, 42);
  });
});

// ── On-demand harvest trigger ─────────────────────────────────────────────────

describe("resolveOrCreateGame — harvest trigger", () => {
  it("triggera harvest se ON_DEMAND_HARVEST_ENABLED e gioco creato da IGDB", async () => {
    mockEnv.ON_DEMAND_HARVEST_ENABLED = true;
    mockIgdb.searchByTitle.mockResolvedValue([makeIgdbResult()]);
    mockGames.create.mockResolvedValue(makeGameRow({ id: 55 }) as never);
    mockHarvest.triggerHarvest.mockResolvedValue(undefined as never);

    await resolveOrCreateGame(DRAFT_ID, "Elden Ring");

    // Aspettiamo che la promise del trigger (fire-and-forget) venga registrata
    await Promise.resolve();
    expect(mockHarvest.triggerHarvest).toHaveBeenCalledWith("Elden Ring", null, 55);
  });

  it("NON triggera harvest se ON_DEMAND_HARVEST_ENABLED è false", async () => {
    mockEnv.ON_DEMAND_HARVEST_ENABLED = false;
    mockIgdb.searchByTitle.mockResolvedValue([makeIgdbResult()]);
    mockGames.create.mockResolvedValue(makeGameRow() as never);

    await resolveOrCreateGame(DRAFT_ID, "Elden Ring");

    await Promise.resolve();
    expect(mockHarvest.triggerHarvest).not.toHaveBeenCalled();
  });
});

// ── Errori input ──────────────────────────────────────────────────────────────

describe("resolveOrCreateGame — errori input", () => {
  it("lancia se gameTitle è stringa vuota", async () => {
    await expect(resolveOrCreateGame(DRAFT_ID, "")).rejects.toThrow("gameTitle vuoto");
    await expect(resolveOrCreateGame(DRAFT_ID, "   ")).rejects.toThrow("gameTitle vuoto");
  });
});
