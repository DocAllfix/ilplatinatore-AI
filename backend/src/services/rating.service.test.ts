import { describe, it, expect, vi, beforeEach } from "vitest";
import { RatingService } from "./rating.service.js";
import { RatingsModel } from "@/models/ratings.model.js";
import { GuidesModel } from "@/models/guides.model.js";
import { redis } from "@/config/redis.js";
import { NotFoundError, ValidationError } from "@/utils/errors.js";

// Mock di dipendenze esterne. Niente DB / Redis reali nei test unitari.
vi.mock("@/config/redis.js", () => ({
  redis: {
    exists: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock("@/models/ratings.model.js", () => ({
  RatingsModel: {
    createUserRating: vi.fn(),
    createSessionRating: vi.fn(),
    getSummary: vi.fn(),
    getLiveStats: vi.fn(),
    refreshSummary: vi.fn(),
  },
}));

vi.mock("@/models/guides.model.js", () => ({
  GuidesModel: {
    findById: vi.fn(),
    markAsVerified: vi.fn(),
  },
}));

const mockedRedis = vi.mocked(redis);
const mockedRatings = vi.mocked(RatingsModel);
const mockedGuides = vi.mocked(GuidesModel);

const SESSION = "11111111-1111-1111-1111-111111111111";

function stubGuide(overrides: Partial<{ id: number; verified: boolean }> = {}): unknown {
  return {
    id: overrides.id ?? 42,
    game_id: 1,
    trophy_id: null,
    title: "stub",
    slug: "stub",
    content: "",
    content_html: null,
    language: "en",
    guide_type: "trophy",
    source: "chatbot",
    quality_score: 0,
    verified: overrides.verified ?? false,
    view_count: 0,
    helpful_count: 0,
    report_count: 0,
    metadata: {},
    embedding_pending: false,
    confidence_level: "generated",
    topic: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: SET NX EX acquisisce il lock → refresh avviene.
  mockedRedis.set.mockResolvedValue("OK");
  mockedRatings.refreshSummary.mockResolvedValue(undefined);
  // Default getLiveStats: 0 voti (no promozione). I singoli test overridano.
  mockedRatings.getLiveStats.mockResolvedValue({
    guide_id: 42,
    total_ratings: 0,
    avg_stars: 0,
    total_suggestions: 0,
  });
});

describe("RatingService.submitRating — validazione", () => {
  it("rifiuta stars fuori range [1,5]", async () => {
    await expect(
      RatingService.submitRating({ guideId: 1, sessionId: SESSION, stars: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      RatingService.submitRating({ guideId: 1, sessionId: SESSION, stars: 6 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rifiuta stars non intero", async () => {
    await expect(
      RatingService.submitRating({ guideId: 1, sessionId: SESSION, stars: 3.5 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rifiuta richieste senza userId e senza sessionId", async () => {
    await expect(
      RatingService.submitRating({ guideId: 1, stars: 4 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rifiuta guideId inesistente con NotFoundError", async () => {
    mockedGuides.findById.mockResolvedValue(null);
    await expect(
      RatingService.submitRating({ guideId: 999, sessionId: SESSION, stars: 4 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("RatingService.submitRating — branch persistenza", () => {
  it("anonymous: invoca createSessionRating, non createUserRating", async () => {
    mockedGuides.findById.mockResolvedValue(stubGuide() as never);

    await RatingService.submitRating({
      guideId: 42,
      sessionId: SESSION,
      stars: 5,
      suggestion: "good",
      language: "it",
    });

    expect(mockedRatings.createSessionRating).toHaveBeenCalledWith({
      guide_id: 42,
      session_id: SESSION,
      stars: 5,
      suggestion: "good",
      language: "it",
    });
    expect(mockedRatings.createUserRating).not.toHaveBeenCalled();
  });

  it("autenticato: invoca createUserRating, non createSessionRating", async () => {
    mockedGuides.findById.mockResolvedValue(stubGuide() as never);

    await RatingService.submitRating({
      guideId: 42,
      userId: 7,
      stars: 4,
    });

    expect(mockedRatings.createUserRating).toHaveBeenCalled();
    expect(mockedRatings.createSessionRating).not.toHaveBeenCalled();
  });
});

describe("RatingService.checkAndPromoteGuide — soglie (via getLiveStats)", () => {
  it("promuove guida con avg≥3.5 e ratings≥3 quando non già verified", async () => {
    mockedGuides.findById.mockResolvedValue(stubGuide({ verified: false }) as never);
    mockedRatings.getLiveStats.mockResolvedValue({
      guide_id: 42,
      avg_stars: 4.2,
      total_ratings: 5,
      total_suggestions: 2,
    });

    const promoted = await RatingService.checkAndPromoteGuide(42);

    expect(promoted).toBe(true);
    expect(mockedGuides.markAsVerified).toHaveBeenCalledWith(42);
  });

  it("NON promuove se la guida è già verified", async () => {
    mockedGuides.findById.mockResolvedValue(stubGuide({ verified: true }) as never);
    mockedRatings.getLiveStats.mockResolvedValue({
      guide_id: 42,
      avg_stars: 4.8,
      total_ratings: 10,
      total_suggestions: 0,
    });

    const promoted = await RatingService.checkAndPromoteGuide(42);

    expect(promoted).toBe(false);
    expect(mockedGuides.markAsVerified).not.toHaveBeenCalled();
  });

  it("NON promuove sotto la soglia minima di ratings (<3)", async () => {
    mockedGuides.findById.mockResolvedValue(stubGuide({ verified: false }) as never);
    mockedRatings.getLiveStats.mockResolvedValue({
      guide_id: 42,
      avg_stars: 5,
      total_ratings: 2,
      total_suggestions: 0,
    });

    const promoted = await RatingService.checkAndPromoteGuide(42);

    expect(promoted).toBe(false);
    expect(mockedGuides.markAsVerified).not.toHaveBeenCalled();
  });

  it("su low-rating (<2.5, ratings≥3) ritorna false senza toccare markAsVerified", async () => {
    mockedGuides.findById.mockResolvedValue(stubGuide({ verified: false }) as never);
    mockedRatings.getLiveStats.mockResolvedValue({
      guide_id: 42,
      avg_stars: 1.8,
      total_ratings: 4,
      total_suggestions: 1,
    });

    const promoted = await RatingService.checkAndPromoteGuide(42);

    expect(promoted).toBe(false);
    expect(mockedGuides.markAsVerified).not.toHaveBeenCalled();
  });

  it("ritorna false quando nessun voto è presente (total_ratings=0)", async () => {
    // Default beforeEach già imposta getLiveStats a zero, ma esplicito qui.
    mockedGuides.findById.mockResolvedValue(stubGuide() as never);
    mockedRatings.getLiveStats.mockResolvedValue({
      guide_id: 42,
      avg_stars: 0,
      total_ratings: 0,
      total_suggestions: 0,
    });

    const promoted = await RatingService.checkAndPromoteGuide(42);

    expect(promoted).toBe(false);
    expect(mockedGuides.markAsVerified).not.toHaveBeenCalled();
  });
});

describe("RatingService.checkAndPromoteGuide — throttle Redis (lock atomico SET NX EX)", () => {
  it("salta refreshSummary se SET NX non acquisisce il lock (<60s)", async () => {
    // ioredis ritorna null quando NX fallisce perché la chiave esiste.
    mockedRedis.set.mockResolvedValue(null);
    mockedGuides.findById.mockResolvedValue(stubGuide() as never);
    // getLiveStats default a zero (beforeEach); throttle test non dipende dalle soglie.

    await RatingService.checkAndPromoteGuide(42);

    expect(mockedRatings.refreshSummary).not.toHaveBeenCalled();
    // SET viene comunque tentato (è il tentativo di acquisire il lock).
    expect(mockedRedis.set).toHaveBeenCalledOnce();
  });

  it("esegue refresh quando SET NX acquisisce il lock con TTL 60s", async () => {
    mockedRedis.set.mockResolvedValue("OK");
    mockedGuides.findById.mockResolvedValue(stubGuide() as never);
    // getLiveStats default a zero (beforeEach); throttle test non dipende dalle soglie.

    await RatingService.checkAndPromoteGuide(42);

    expect(mockedRatings.refreshSummary).toHaveBeenCalledOnce();
    expect(mockedRedis.set).toHaveBeenCalledWith(
      "rating_refresh_last:42",
      "1",
      "EX",
      60,
      "NX",
    );
  });

  it("sotto burst concorrente, solo il primo thread esegue REFRESH", async () => {
    // Simula 5 richieste simultanee: il primo SET NX vince ("OK"),
    // gli altri 4 ricevono null → nessun REFRESH duplicato.
    mockedRedis.set
      .mockResolvedValueOnce("OK")
      .mockResolvedValue(null);
    mockedGuides.findById.mockResolvedValue(stubGuide() as never);
    // getLiveStats default a zero (beforeEach); throttle test non dipende dalle soglie.

    await Promise.all(
      Array.from({ length: 5 }, () => RatingService.checkAndPromoteGuide(42)),
    );

    expect(mockedRatings.refreshSummary).toHaveBeenCalledOnce();
  });
});

describe("RatingService.getGuideRatings (live, no view stale)", () => {
  it("ritorna zeri quando non esistono ancora voti (getLiveStats default)", async () => {
    mockedGuides.findById.mockResolvedValue(stubGuide() as never);
    // Default beforeEach: getLiveStats ritorna zero → zero output.

    const summary = await RatingService.getGuideRatings(42);
    expect(summary).toEqual({ avgStars: 0, totalRatings: 0, totalSuggestions: 0 });
  });

  it("fa throw NotFoundError per guida inesistente", async () => {
    mockedGuides.findById.mockResolvedValue(null);
    await expect(RatingService.getGuideRatings(999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("proietta i campi live in camelCase", async () => {
    mockedGuides.findById.mockResolvedValue(stubGuide() as never);
    mockedRatings.getLiveStats.mockResolvedValue({
      guide_id: 42,
      avg_stars: 4.25,
      total_ratings: 8,
      total_suggestions: 3,
    });

    const summary = await RatingService.getGuideRatings(42);
    expect(summary).toEqual({ avgStars: 4.25, totalRatings: 8, totalSuggestions: 3 });
  });
});
