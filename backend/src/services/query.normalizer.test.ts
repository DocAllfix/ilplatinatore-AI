import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectLanguage, extractGame, extractTrophy, normalizeQuery } from "@/services/query.normalizer.js";

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/models/games.model.js", () => ({
  GamesModel: {
    search: vi.fn(),
    searchWithScores: vi.fn(),
    findById: vi.fn(),
  },
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
  platform: [] as string[],
  release_date: null,
  genre: [] as string[],
  cover_url: null,
  metadata: {} as Record<string, unknown>,
  created_at: new Date(),
  updated_at: new Date(),
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

// ── detectLanguage (T1.1 — multilingua reale via franc-min) ──────────────

describe("detectLanguage — Tier 1 multilingua", () => {
  it("riconosce italiano su frasi pure", () => {
    expect(detectLanguage("voglio sapere come ottenere il trofeo di platino della guida")).toBe("it");
    expect(detectLanguage("dove posso trovare la spada nella zona iniziale del gioco")).toBe("it");
  });

  it("riconosce inglese su frasi pure", () => {
    expect(detectLanguage("i want to know how to get the platinum trophy from the guide")).toBe("en");
    expect(detectLanguage("where can i find the legendary weapon in this game")).toBe("en");
  });

  it("riconosce spagnolo", () => {
    expect(detectLanguage("quisiera saber cuál es la mejor estrategia para conseguir todos los logros del juego")).toBe("es");
  });

  it("riconosce francese", () => {
    expect(detectLanguage("je veux savoir comment obtenir le trophée de platine dans ce jeu")).toBe("fr");
  });

  it("riconosce tedesco", () => {
    expect(detectLanguage("ich möchte wissen wie man die platintrophäe in diesem spiel bekommt")).toBe("de");
  });

  it("riconosce portoghese", () => {
    expect(detectLanguage("eu quero saber como conseguir o troféu de platina deste jogo")).toBe("pt");
  });

  it("riconosce giapponese", () => {
    expect(detectLanguage("エルデンリングのプラチナトロフィーの取り方を教えて")).toBe("ja");
  });

  it("riconosce cinese", () => {
    expect(detectLanguage("艾尔登法环白金奖杯怎么获得指南")).toBe("zh");
  });

  it("riconosce russo", () => {
    expect(detectLanguage("как получить платиновый трофей в elden ring")).toBe("ru");
  });

  it("query troppo corte (< 10 char) → fallback 'en'", () => {
    expect(detectLanguage("ciao")).toBe("en");
    expect(detectLanguage("XZY")).toBe("en");
  });

  it("lingue non whitelistate (es. arabo) → fallback 'en'", () => {
    // L'arabo non è in Tier 1 ('only' di franc esclude arb): franc returns 'und'
    // o una lingua non in mapping → fallback "en".
    expect(detectLanguage("كيف أحصل على جائزة البلاتين في إلدن رينغ")).toBe("en");
  });

  it("undetermined / gibberish → fallback 'en'", () => {
    expect(detectLanguage("XZY123 ?@# ABC")).toBe("en");
  });
});

// ── extractGame ────────────────────────────────────────────────────────────

describe("extractGame", () => {
  it("ritorna il primo match da searchWithScores (top1)", async () => {
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([
      { game: mockGame, similarity: 0.95 },
    ]);

    const result = await extractGame("elden ring boss fight");

    expect(GamesModel.searchWithScores).toHaveBeenCalled();
    expect(result).toEqual(mockGame);
  });

  it("ritorna null se searchWithScores non trova nulla", async () => {
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([]);

    const result = await extractGame("xyzzy unknown game here");
    expect(result).toBeNull();
  });

  it("ritorna null se la query dopo filtraggio token è vuota", async () => {
    // "come il la" are all filter tokens → empty candidates
    const result = await extractGame("come il la");
    expect(GamesModel.searchWithScores).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("ritorna null e non lancia su errore DB (degrada graceful)", async () => {
    vi.mocked(GamesModel.searchWithScores).mockRejectedValue(new Error("db down"));

    const result = await extractGame("elden ring");
    expect(result).toBeNull();
  });

  it("prova strategie n-gram multiple fino al primo match", async () => {
    // Prima chiamata fallisce (3-gram), seconda fallisce (2-gram), terza ha successo (1-gram)
    vi.mocked(GamesModel.searchWithScores)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ game: mockGame, similarity: 0.9 }]);

    const result = await extractGame("ring mystic");
    expect(result).toEqual(mockGame);
    expect(GamesModel.searchWithScores).toHaveBeenCalledTimes(3);
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
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([{ game: mockGame, similarity: 0.9 }]);
    vi.mocked(TrophyLookupService.findTrophyByName).mockResolvedValue(mockTrophy);

    const result = await normalizeQuery("how to unlock trophy malenia in elden ring");

    expect(result.guideType).toBe("trophy");
    expect(result.game).toEqual(mockGame);
    expect(result.trophy).toEqual(mockTrophy);
    expect(result.rawQuery).toBe("how to unlock trophy malenia in elden ring");
  });

  it("path topic keyword: guideType da TOPIC_KEYWORDS, topic valorizzato", async () => {
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([{ game: mockGame, similarity: 0.9 }]);

    const result = await normalizeQuery("where to find all missable items in elden ring");

    expect(result.guideType).toBe("collectible");
    expect(result.topic).toBe("missables");
    expect(result.trophy).toBeNull();
  });

  it("path platinum keyword: guideType=platinum", async () => {
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([{ game: mockGame, similarity: 0.9 }]);

    const result = await normalizeQuery("guide for platinum in elden ring");

    expect(result.guideType).toBe("platinum");
  });

  it("fallback walkthrough quando nessuna keyword riconosciuta", async () => {
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([]);

    const result = await normalizeQuery("elden ring generic question");

    expect(result.guideType).toBe("walkthrough");
    expect(result.game).toBeNull();
    expect(result.topic).toBeNull();
  });

  it("usa explicitLanguage quando fornita, bypassa detectLanguage", async () => {
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([]);

    const result = await normalizeQuery("how to get trophy", "it");

    expect(result.language).toBe("it");
  });

  it("ignora explicitLanguage vuota/whitespace e usa detectLanguage", async () => {
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([]);

    const result = await normalizeQuery("come ottengo il trofeo", "   ");

    expect(result.language).toBe("it");
  });

  it("topic=build per keyword build/equipaggiamento", async () => {
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([]);

    const result = await normalizeQuery("best build for elden ring");

    expect(result.guideType).toBe("challenge");
    expect(result.topic).toBe("build");
  });

  it("topic=lore per keyword lore/trama/storia", async () => {
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([]);

    const result = await normalizeQuery("lore and storia di elden ring");

    expect(result.guideType).toBe("walkthrough");
    expect(result.topic).toBe("lore");
  });
});

// ── T3.2 — Game disambiguation ─────────────────────────────────────────────

describe("normalizeQuery — T3.2 game disambiguation", () => {
  const mockGame2 = {
    ...mockGame,
    id: 2,
    title: "Elden Ring Shadow of the Erdtree",
    slug: "elden-ring-shadow",
  };

  it("expone gameCandidates quando top1>0.7 AND top2/top1>0.8 (ambigui)", async () => {
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([
      { game: mockGame, similarity: 0.95 },
      { game: mockGame2, similarity: 0.85 }, // 0.85/0.95 = 0.89 > 0.8 → ambigui
    ]);

    const result = await normalizeQuery("elden ring guida");

    expect(result.gameCandidates).toBeDefined();
    expect(result.gameCandidates).toHaveLength(2);
    expect(result.gameCandidates![0]).toMatchObject({
      id: 1, title: "Elden Ring", slug: "elden-ring", similarity: 0.95,
    });
    expect(result.game?.id).toBe(1); // top1 viene sempre scelto
  });

  it("NON espone gameCandidates quando top2 troppo distante da top1", async () => {
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([
      { game: mockGame, similarity: 0.95 },
      { game: mockGame2, similarity: 0.4 }, // 0.4/0.95 = 0.42 < 0.8 → non ambigui
    ]);

    const result = await normalizeQuery("elden ring boss");

    expect(result.gameCandidates).toBeUndefined();
    expect(result.game?.id).toBe(1);
  });

  it("NON espone gameCandidates quando solo 1 match (sotto-soglia o unico)", async () => {
    vi.mocked(GamesModel.searchWithScores).mockResolvedValue([
      { game: mockGame, similarity: 0.95 },
    ]);

    const result = await normalizeQuery("elden ring boss");

    expect(result.gameCandidates).toBeUndefined();
    expect(result.game?.id).toBe(1);
  });

  it("explicitGameId bypassa extraction e usa findById", async () => {
    vi.mocked(GamesModel.findById).mockResolvedValue(mockGame);

    const result = await normalizeQuery("malenia trophy", undefined, 1);

    expect(GamesModel.findById).toHaveBeenCalledWith(1);
    expect(GamesModel.searchWithScores).not.toHaveBeenCalled();
    expect(result.game).toEqual(mockGame);
    expect(result.gameCandidates).toBeUndefined();
  });

  it("explicitGameId inesistente → game=null + warning (no crash)", async () => {
    vi.mocked(GamesModel.findById).mockResolvedValue(null);

    const result = await normalizeQuery("malenia trophy", undefined, 99999);

    expect(result.game).toBeNull();
    expect(result.gameCandidates).toBeUndefined();
  });
});
