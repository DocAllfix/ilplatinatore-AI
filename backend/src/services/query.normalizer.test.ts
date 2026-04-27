import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectLanguage, extractGame, extractTrophy, normalizeQuery } from "@/services/query.normalizer.js";

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/models/games.model.js", () => ({
  GamesModel: { search: vi.fn() },
}));

vi.mock("@/services/trophyLookup.service.js", () => ({
  TrophyLookupService: { findTrophyByName: vi.fn() },
  isAllowedLang: vi.fn(),
}));

import { GamesModel } from "@/models/games.model.js";
import { TrophyLookupService, isAllowedLang } from "@/services/trophyLookup.service.js";

const mockGame = {
  id: 1,
  title: "Elden Ring",
  slug: "elden-ring",
  psn_title_id: null,
  igdb_id: null,
  cover_url: null,
  created_at: new Date(),
};

const mockTrophy = {
  id: 10,
  game_id: 1,
  trophy_type: "gold",
  name_en: "Malenia Defeated",
  name_it: "Malenia Sconfitta",
  detail_en: "Defeat Malenia.",
  detail_it: "Sconfiggi Malenia.",
  psn_trophy_id: "001",
  psn_communication_id: "NPWR12345",
  rarity_source: "very_rare",
  match: "fuzzy_lang" as const,
  similarity: 0.9,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAllowedLang).mockReturnValue(true);
});

// ── detectLanguage ─────────────────────────────────────────────────────────

describe("detectLanguage", () => {
  it("riconosce italiano da marker tipici", () => {
    expect(detectLanguage("come ottengo il trofeo platino")).toBe("it");
    expect(detectLanguage("dove trovo la spada nella guida")).toBe("it");
  });

  it("riconosce inglese da marker tipici", () => {
    expect(detectLanguage("how do i get the trophy")).toBe("en");
    expect(detectLanguage("where to find the weapon")).toBe("en");
  });

  it("default prudente 'en' quando nessun marker hit", () => {
    expect(detectLanguage("elden ring")).toBe("en");
    expect(detectLanguage("XZY123")).toBe("en");
  });

  it("preferisce IT quando itHits == enHits (equità: scegliamo IT)", () => {
    expect(detectLanguage("come the")).toBe("it");
  });

  it("case-insensitive", () => {
    expect(detectLanguage("COME OTTENGO IL TROFEO")).toBe("it");
    expect(detectLanguage("HOW TO GET THE TROPHY")).toBe("en");
  });

  it("ignora punteggiatura e numeri", () => {
    expect(detectLanguage("come??? trofeo!!! 123 platinatore")).toBe("it");
  });
});

// ── extractGame ────────────────────────────────────────────────────────────

describe("extractGame", () => {
  it("ritorna il primo match da GamesModel.search", async () => {
    vi.mocked(GamesModel.search).mockResolvedValue([mockGame]);

    const result = await extractGame("elden ring boss fight");

    expect(GamesModel.search).toHaveBeenCalled();
    expect(result).toEqual(mockGame);
  });

  it("ritorna null se GamesModel.search non trova nulla", async () => {
    vi.mocked(GamesModel.search).mockResolvedValue([]);

    const result = await extractGame("xyzzy unknown game here");
    expect(result).toBeNull();
  });

  it("ritorna null se la query dopo filtraggio token è vuota", async () => {
    // "come il la" are all filter tokens → empty candidates
    const result = await extractGame("come il la");
    expect(GamesModel.search).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("ritorna null e non lancia su errore DB (degrada graceful)", async () => {
    vi.mocked(GamesModel.search).mockRejectedValue(new Error("db down"));

    const result = await extractGame("elden ring");
    expect(result).toBeNull();
  });

  it("prova strategie n-gram multiple fino al primo match", async () => {
    // Prima chiamata fallisce (3-gram), seconda fallisce (2-gram), terza ha successo (1-gram)
    vi.mocked(GamesModel.search)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([mockGame]);

    const result = await extractGame("ring mystic");
    expect(result).toEqual(mockGame);
    expect(GamesModel.search).toHaveBeenCalledTimes(3);
  });
});

// ── extractTrophy ──────────────────────────────────────────────────────────

describe("extractTrophy", () => {
  it("ritorna null se gameId è null", async () => {
    const result = await extractTrophy("come sbloccare il trofeo malenia", null, "it");
    expect(result).toBeNull();
    expect(TrophyLookupService.findTrophyByName).not.toHaveBeenCalled();
  });

  it("ritorna null se la query non sembra trophy-centric", async () => {
    const result = await extractTrophy("come sconfiggere malenia boss", 1, "it");
    expect(result).toBeNull();
    expect(TrophyLookupService.findTrophyByName).not.toHaveBeenCalled();
  });

  it("ritorna null se la lingua non è supportata", async () => {
    vi.mocked(isAllowedLang).mockReturnValue(false);
    const result = await extractTrophy("come ottenere il trophy malenia", 1, "xx");
    expect(result).toBeNull();
  });

  it("ritorna null se il candidato nome trofeo è troppo corto dopo il filtro", async () => {
    // "trophy" è hint, ma dopo stripping rimane stringa <3 chars
    const result = await extractTrophy("trophy", 1, "en");
    expect(result).toBeNull();
  });

  it("invoca TrophyLookupService con il candidato pulito e ritorna il match", async () => {
    vi.mocked(TrophyLookupService.findTrophyByName).mockResolvedValue(mockTrophy);

    const result = await extractTrophy("come sbloccare il trophy malenia defeated", 1, "en");

    expect(TrophyLookupService.findTrophyByName).toHaveBeenCalled();
    expect(result).toEqual(mockTrophy);
  });

  it("ritorna null e non lancia su errore del servizio (degrada graceful)", async () => {
    vi.mocked(TrophyLookupService.findTrophyByName).mockRejectedValue(new Error("service down"));

    const result = await extractTrophy("come ottenere il trophy malenia", 1, "en");
    expect(result).toBeNull();
  });
});

// ── normalizeQuery ─────────────────────────────────────────────────────────

describe("normalizeQuery", () => {
  it("path trophy: guideType=trophy, invoca extractTrophy", async () => {
    vi.mocked(GamesModel.search).mockResolvedValue([mockGame]);
    vi.mocked(TrophyLookupService.findTrophyByName).mockResolvedValue(mockTrophy);

    const result = await normalizeQuery("how to unlock trophy malenia in elden ring");

    expect(result.guideType).toBe("trophy");
    expect(result.game).toEqual(mockGame);
    expect(result.trophy).toEqual(mockTrophy);
    expect(result.rawQuery).toBe("how to unlock trophy malenia in elden ring");
  });

  it("path topic keyword: guideType da TOPIC_KEYWORDS, topic valorizzato", async () => {
    vi.mocked(GamesModel.search).mockResolvedValue([mockGame]);

    const result = await normalizeQuery("where to find all missable items in elden ring");

    expect(result.guideType).toBe("collectible");
    expect(result.topic).toBe("missables");
    expect(result.trophy).toBeNull();
  });

  it("path platinum keyword: guideType=platinum", async () => {
    vi.mocked(GamesModel.search).mockResolvedValue([mockGame]);

    const result = await normalizeQuery("guide for platinum in elden ring");

    expect(result.guideType).toBe("platinum");
  });

  it("fallback walkthrough quando nessuna keyword riconosciuta", async () => {
    vi.mocked(GamesModel.search).mockResolvedValue([]);

    const result = await normalizeQuery("elden ring generic question");

    expect(result.guideType).toBe("walkthrough");
    expect(result.game).toBeNull();
    expect(result.topic).toBeNull();
  });

  it("usa explicitLanguage quando fornita, bypassa detectLanguage", async () => {
    vi.mocked(GamesModel.search).mockResolvedValue([]);

    const result = await normalizeQuery("how to get trophy", "it");

    expect(result.language).toBe("it");
  });

  it("ignora explicitLanguage vuota/whitespace e usa detectLanguage", async () => {
    vi.mocked(GamesModel.search).mockResolvedValue([]);

    const result = await normalizeQuery("come ottengo il trofeo", "   ");

    expect(result.language).toBe("it");
  });

  it("topic=build per keyword build/equipaggiamento", async () => {
    vi.mocked(GamesModel.search).mockResolvedValue([]);

    const result = await normalizeQuery("best build for elden ring");

    expect(result.guideType).toBe("challenge");
    expect(result.topic).toBe("build");
  });

  it("topic=lore per keyword lore/trama/storia", async () => {
    vi.mocked(GamesModel.search).mockResolvedValue([]);

    const result = await normalizeQuery("lore and storia di elden ring");

    expect(result.guideType).toBe("walkthrough");
    expect(result.topic).toBe("lore");
  });
});
