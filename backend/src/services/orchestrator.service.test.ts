import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleGuideRequest } from "./orchestrator.service.js";
import { normalizeQuery } from "@/services/query.normalizer.js";
import { GuideCache } from "@/services/guide.cache.js";
import { generateGuide, translateGuide } from "@/services/llm.service.js";
import {
  retrieveContext,
  enrichWithScraping,
  type RetrievalBundle,
} from "@/services/orchestrator.retrieval.js";

// ── Mock dependency tree ────────────────────────────────────────────────────
//
// Ogni edge esterno dell'orchestratore e' mockato. Il modulo .shared.js e'
// ri-esportato "as-is" tranne `logAndTrack` (che altrimenti farebbe INSERT
// reali su query_log / guide_request_tracker).

vi.mock("@/services/query.normalizer.js", () => ({
  normalizeQuery: vi.fn(),
}));

vi.mock("@/services/guide.cache.js", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/guide.cache.js")>(
      "@/services/guide.cache.js",
    );
  return {
    ...actual,
    GuideCache: {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
    },
  };
});

vi.mock("@/services/llm.service.js", () => ({
  generateGuide: vi.fn(),
  translateGuide: vi.fn(),
}));

vi.mock("@/services/orchestrator.retrieval.js", () => ({
  retrieveContext: vi.fn(),
  enrichWithScraping: vi.fn(),
}));

vi.mock("@/services/orchestrator.shared.js", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/orchestrator.shared.js")>(
      "@/services/orchestrator.shared.js",
    );
  return {
    ...actual,
    // evita ogni INSERT reale: e' fire-and-forget nell'orchestrator
    logAndTrack: vi.fn().mockResolvedValue(undefined),
  };
});

// Silenziamo il logger per mantenere l'output dei test pulito (errori loggati
// volutamente dall'orchestrator nei path di degradation non devono inquinare CI).
vi.mock("@/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Fixture helpers ─────────────────────────────────────────────────────────

const mockedNormalize = vi.mocked(normalizeQuery);
const mockedCache = vi.mocked(GuideCache);
const mockedGenerate = vi.mocked(generateGuide);
const mockedTranslate = vi.mocked(translateGuide);
const mockedRetrieve = vi.mocked(retrieveContext);
const mockedEnrich = vi.mocked(enrichWithScraping);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubNorm(overrides: Partial<any> = {}) {
  return {
    language: "en",
    game: null,
    trophy: null,
    topic: null,
    guideType: "walkthrough",
    rawQuery: "how do i beat the first boss in elden ring",
    ...overrides,
  };
}

function bundleEmpty(): RetrievalBundle {
  return {
    results: [],
    sourceUsed: "none",
    ragContext: "",
    scrapingContext: "",
    sources: [],
  };
}

function bundleRag(sourceUsed: "rag" | "scraping" = "rag"): RetrievalBundle {
  return {
    results: [],
    sourceUsed,
    ragContext: "--- FONTE 1: Elden Ring Boss Guide\nstrategia...",
    scrapingContext: sourceUsed === "scraping" ? "scraped context blob" : "",
    sources: [{ guideId: 1, title: "Elden Ring Boss Guide" }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default safe: normalize ritorna un norm minimo in inglese senza game.
  mockedNormalize.mockResolvedValue(stubNorm());
  // Default: cache MISS. Test1 override a HIT.
  mockedCache.get.mockResolvedValue(null);
  mockedCache.set.mockResolvedValue(undefined);
  // Default retrieve: bundle vuoto, sourceUsed "none".
  mockedRetrieve.mockResolvedValue(bundleEmpty());
  // Default enrich: passthrough (bundle invariato).
  mockedEnrich.mockImplementation(async (b: RetrievalBundle) => b);
  // Default LLM: ritorna testo stub.
  mockedGenerate.mockResolvedValue({
    content: "Step-by-step walkthrough for the boss fight...",
    templateId: "walkthrough",
    model: "gemini-2.5-flash",
    finishReason: "STOP",
    elapsedMs: 42,
  });
  mockedTranslate.mockImplementation(async (text: string) => text);
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("handleGuideRequest — Test 1: cache HIT", () => {
  it("retorna dalla cache senza invocare retrieve / enrich / LLM", async () => {
    mockedCache.get.mockResolvedValue({
      content: "cached walkthrough content",
      sources: [{ guideId: 7, title: "Cached Guide" }],
      generatedAt: Date.now(),
      templateId: "walkthrough",
      model: "gemini-2.5-flash",
    });

    const res = await handleGuideRequest({
      query: "how do i beat the boss",
      language: "en",
    });

    expect(res.meta.cached).toBe(true);
    expect(res.meta.sourceUsed).toBe("cache");
    expect(res.content).toBe("cached walkthrough content");
    expect(res.sources).toHaveLength(1);

    // side-effect negativi: nessuna pipeline downstream
    expect(mockedRetrieve).not.toHaveBeenCalled();
    expect(mockedEnrich).not.toHaveBeenCalled();
    expect(mockedGenerate).not.toHaveBeenCalled();
    expect(mockedTranslate).not.toHaveBeenCalled();
    expect(mockedCache.set).not.toHaveBeenCalled();
  });
});

describe("handleGuideRequest — Test 2: RAG exact match (sourceUsed=rag)", () => {
  it("usa il ragContext del bundle, invoca enrichScraping (contratto) e passa al LLM", async () => {
    // norm con game → enrichWithScraping VERRA' chiamato (gestione skip/no-op e' in enrich)
    mockedNormalize.mockResolvedValue(
      stubNorm({ game: { id: 1, title: "Elden Ring", slug: "elden-ring" } }),
    );
    mockedRetrieve.mockResolvedValue(bundleRag("rag"));
    // enrich passthrough di default → sourceUsed rimane "rag"

    const res = await handleGuideRequest({
      query: "how to beat malenia in elden ring",
      language: "en",
    });

    expect(res.meta.sourceUsed).toBe("rag");
    expect(mockedRetrieve).toHaveBeenCalledTimes(1);
    expect(mockedEnrich).toHaveBeenCalledTimes(1);
    expect(mockedGenerate).toHaveBeenCalledTimes(1);

    // Il prompt passato al LLM deve includere il ragContext reale
    const promptCtx = mockedGenerate.mock.calls[0]![0];
    expect(promptCtx.ragContext).toContain("Elden Ring Boss Guide");
    expect(promptCtx.scrapingContext).toBe("");
  });
});

describe("handleGuideRequest — Test 3: RAG partial match → scraping arricchisce", () => {
  it("combina ragContext + scrapingContext quando enrich eleva il bundle", async () => {
    mockedNormalize.mockResolvedValue(
      stubNorm({ game: { id: 1, title: "Elden Ring", slug: "elden-ring" } }),
    );
    const baseBundle = bundleRag("rag");
    mockedRetrieve.mockResolvedValue(baseBundle);
    // Enrich aggiunge scraping → sourceUsed cambia a "scraping"
    mockedEnrich.mockResolvedValue(bundleRag("scraping"));

    const res = await handleGuideRequest({
      query: "fringefolk hero's grave puzzle",
      language: "en",
    });

    expect(res.meta.sourceUsed).toBe("scraping");
    expect(mockedEnrich).toHaveBeenCalledTimes(1);

    const promptCtx = mockedGenerate.mock.calls[0]![0];
    expect(promptCtx.ragContext).toContain("Elden Ring Boss Guide");
    expect(promptCtx.scrapingContext).toBe("scraped context blob");
  });
});

describe("handleGuideRequest — Test 4: full pipeline no-cache", () => {
  it("esegue tutti gli step in ordine e scrive in cache", async () => {
    mockedNormalize.mockResolvedValue(
      stubNorm({
        game: { id: 1, title: "Elden Ring", slug: "elden-ring" },
        guideType: "walkthrough",
      }),
    );
    mockedRetrieve.mockResolvedValue(bundleRag("rag"));

    const res = await handleGuideRequest({
      query: "walkthrough caelid starting area",
      language: "en",
    });

    // Ordine di invocazione via `.mock.invocationCallOrder`
    const order = [
      mockedNormalize.mock.invocationCallOrder[0]!,
      mockedCache.get.mock.invocationCallOrder[0]!,
      mockedRetrieve.mock.invocationCallOrder[0]!,
      mockedEnrich.mock.invocationCallOrder[0]!,
      mockedGenerate.mock.invocationCallOrder[0]!,
      mockedCache.set.mock.invocationCallOrder[0]!,
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]!);
    }

    expect(res.meta.cached).toBe(false);
    expect(res.meta.gameDetected).toBe("Elden Ring");
    expect(res.meta.templateId).toBe("walkthrough");
    expect(res.content).toContain("Step-by-step walkthrough");
    expect(res.sources).toHaveLength(1);
    // translate skipped perche' language === "en" (DB_CANONICAL_LANGUAGE)
    expect(mockedTranslate).not.toHaveBeenCalled();
  });

  it("invoca translateGuide quando language !== en", async () => {
    mockedNormalize.mockResolvedValue(
      stubNorm({
        language: "it",
        game: { id: 1, title: "Elden Ring", slug: "elden-ring" },
      }),
    );
    mockedRetrieve.mockResolvedValue(bundleRag("rag"));
    mockedTranslate.mockResolvedValue("Guida passo-passo per il boss...");

    const res = await handleGuideRequest({
      query: "come battere il boss",
      language: "it",
    });

    expect(mockedTranslate).toHaveBeenCalledOnce();
    expect(res.content).toBe("Guida passo-passo per il boss...");
    expect(res.meta.language).toBe("it");
  });
});

describe("handleGuideRequest — Test 5: circuit breaker LLM error", () => {
  it("LLM throw → content di degradation, nessun crash, cache.set comunque tentato", async () => {
    mockedNormalize.mockResolvedValue(
      stubNorm({ game: { id: 1, title: "Elden Ring", slug: "elden-ring" } }),
    );
    mockedRetrieve.mockResolvedValue(bundleRag("rag"));
    mockedGenerate.mockRejectedValue(new Error("circuit OPEN — gemini down"));

    const res = await handleGuideRequest({
      query: "tutorial",
      language: "en",
    });

    expect(res.content).toContain("temporaneamente indisponibile");
    expect(res.meta.sourceUsed).toBe("rag"); // il bundle aveva rag
    // cache.set viene tentato comunque (il content di degradation e' valido da cachare
    // brevemente per evitare thundering herd — TTL e' gestito dalla cache layer)
    expect(mockedCache.set).toHaveBeenCalledTimes(1);
  });
});

describe("handleGuideRequest — Test 6: tutti gli step falliscono", () => {
  it("normalize+retrieve+LLM crashano → ritorna comunque un result valido", async () => {
    mockedNormalize.mockRejectedValue(new Error("normalizer down"));
    mockedRetrieve.mockRejectedValue(new Error("db down"));
    mockedGenerate.mockRejectedValue(new Error("llm down"));
    mockedCache.set.mockRejectedValue(new Error("redis down"));

    const res = await handleGuideRequest({
      query: "random query with no game",
      language: "en",
    });

    // Fallback norm ha game=null → enrich non chiamato
    expect(mockedEnrich).not.toHaveBeenCalled();
    // Il content e' il messaggio di degradation
    expect(res.content).toContain("temporaneamente indisponibile");
    // Meta valido e non-null in tutti i campi obbligatori
    expect(res.meta.cached).toBe(false);
    expect(res.meta.sourceUsed).toBe("none");
    expect(res.meta.gameDetected).toBeNull();
    expect(res.meta.trophyDetected).toBeNull();
    expect(res.meta.language).toBe("en");
    expect(typeof res.meta.elapsedMs).toBe("number");
    expect(res.sources).toEqual([]);
  });
});
