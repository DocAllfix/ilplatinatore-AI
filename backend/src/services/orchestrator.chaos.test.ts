/**
 * T4.3 — Chaos test: failure injection per validare il fail-open + degradation
 * graceful dell'orchestrator quando i servizi esterni vanno giù.
 *
 * Scenari testati:
 *   - Redis down → cache MISS, conversation memory disabled, no crash
 *   - Tavily down → solo RAG/LLM, no scraping fallback, no crash
 *   - Gemini chat down → circuit breaker apre, content di degradation
 *   - DB down → orchestrator usa safe-default, sources=[], no crash
 *   - Multipli simultanei → la response non crasha mai
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/services/query.normalizer.js", () => ({
  normalizeQuery: vi.fn(),
}));

vi.mock("@/services/guide.cache.js", () => ({
  GuideCache: { get: vi.fn(), set: vi.fn(), computeKey: vi.fn() },
  slugify: (s: string) => s.toLowerCase().replace(/\s/g, "-"),
}));

vi.mock("@/services/llm.service.js", () => ({
  generateGuide: vi.fn(),
  translateGuide: vi.fn(),
}));

vi.mock("@/services/orchestrator.retrieval.js", () => ({
  retrieveContext: vi.fn(),
  enrichWithScraping: vi.fn(),
}));

vi.mock("@/services/orchestrator.shared.js", async () => {
  const actual = await vi.importActual<typeof import("@/services/orchestrator.shared.js")>(
    "@/services/orchestrator.shared.js",
  );
  return {
    ...actual,
    logAndTrack: vi.fn(),
  };
});

vi.mock("@/services/draft.service.js", () => ({
  createDraft: vi.fn(),
}));

vi.mock("@/services/psn.validator.js", () => ({
  validatePsnTrophyIdsInContent: vi.fn(),
}));

vi.mock("@/services/conversation.memory.js", () => ({
  getConversation: vi.fn(),
  appendTurn: vi.fn(),
  clearConversation: vi.fn(),
}));

import { handleGuideRequest } from "@/services/orchestrator.service.js";
import { normalizeQuery } from "@/services/query.normalizer.js";
import { GuideCache } from "@/services/guide.cache.js";
import { generateGuide } from "@/services/llm.service.js";
import { retrieveContext, enrichWithScraping } from "@/services/orchestrator.retrieval.js";
import { createDraft } from "@/services/draft.service.js";
import { validatePsnTrophyIdsInContent } from "@/services/psn.validator.js";
import { getConversation, appendTurn } from "@/services/conversation.memory.js";

const mockNorm = vi.mocked(normalizeQuery);
const mockCache = vi.mocked(GuideCache);
const mockLLM = vi.mocked(generateGuide);
const mockRetrieve = vi.mocked(retrieveContext);
const mockScrape = vi.mocked(enrichWithScraping);
const mockDraft = vi.mocked(createDraft);
const mockPsn = vi.mocked(validatePsnTrophyIdsInContent);
const mockGetConv = vi.mocked(getConversation);
const mockAppendTurn = vi.mocked(appendTurn);

const happyNorm = {
  language: "en",
  game: { id: 1, title: "Elden Ring", slug: "elden-ring" } as never,
  trophy: null,
  topic: null,
  guideType: "walkthrough" as const,
  rawQuery: "elden ring boss",
};

const happyBundle = {
  results: [],
  sourceUsed: "rag" as const,
  ragContext: "context",
  scrapingContext: "",
  sources: [],
};

const happyLLM = {
  content: "## Steps\nStep 1.\n## Sources\n[1] PowerPyx.",
  templateId: "walkthrough",
  model: "gemini-2.5-flash",
  finishReason: "STOP" as string | null,
  elapsedMs: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults happy-path
  mockNorm.mockResolvedValue(happyNorm);
  mockCache.get.mockResolvedValue(null);
  mockCache.set.mockResolvedValue(undefined);
  mockRetrieve.mockResolvedValue(happyBundle);
  mockScrape.mockImplementation((b) => Promise.resolve(b));
  mockLLM.mockResolvedValue(happyLLM);
  mockDraft.mockResolvedValue({ id: "draft-uuid" } as never);
  mockPsn.mockResolvedValue({ citedIds: [], unverifiedIds: [] });
  mockGetConv.mockResolvedValue({ previousTurns: [], resetSuggested: false });
  mockAppendTurn.mockResolvedValue(undefined);
});

// ── 1. Redis down ──────────────────────────────────────────────────────

describe("T4.3 chaos: Redis (cache + memory) down", () => {
  it("cache.get returns null on Redis fail (internal try/catch) → MISS path", async () => {
    // GuideCache.get ha try/catch interno: ritorna null su Redis error.
    // Quindi dall'orchestrator-pov si vede solo null = MISS.
    mockCache.get.mockResolvedValueOnce(null);

    const result = await handleGuideRequest({ query: "elden ring boss" });
    expect(result.content).toBe(happyLLM.content);
    expect(result.meta.cached).toBe(false);
  });

  it("conversation.memory.get returns empty on Redis fail → fail-open", async () => {
    // Stesso pattern: il service ha try/catch interno → ritorna empty.
    mockGetConv.mockResolvedValueOnce({ previousTurns: [], resetSuggested: false });

    const result = await handleGuideRequest({
      query: "elden ring boss",
      userId: 42,
    });
    expect(result.meta.cached).toBe(false);
    expect(result.content).toBeDefined();
  });

  it("cache.set fail dopo LLM → response NON cambia (fail-open)", async () => {
    mockCache.set.mockRejectedValueOnce(new Error("Redis full"));

    const result = await handleGuideRequest({ query: "elden ring" });
    expect(result.content).toBe(happyLLM.content);
    expect(result.meta.cached).toBe(false);
  });
});

// ── 2. Tavily / scraping down ──────────────────────────────────────────

describe("T4.3 chaos: scraping (Tavily) down", () => {
  it("enrichWithScraping reject → continua con solo RAG", async () => {
    mockScrape.mockRejectedValueOnce(new Error("Tavily 503"));

    const result = await handleGuideRequest({ query: "elden ring" });
    expect(result.content).toBe(happyLLM.content);
    expect(result.meta.sourceUsed).toBe("rag");
  });

  it("scraping ritorna bundle vuoto → orchestrator usa quello che ha (RAG)", async () => {
    mockScrape.mockResolvedValueOnce({
      ...happyBundle,
      sourceUsed: "none",
      ragContext: "",
    });

    const result = await handleGuideRequest({ query: "unknown game xyz" });
    expect(result.meta.sourceUsed).toBe("none");
  });
});

// ── 3. Gemini (LLM chat) down ──────────────────────────────────────────

describe("T4.3 chaos: Gemini chat down", () => {
  it("generateGuide reject (circuit OPEN) → content di degradation", async () => {
    mockLLM.mockRejectedValueOnce(new Error("circuit OPEN — gemini down"));

    const result = await handleGuideRequest({ query: "elden ring" });
    expect(result.content).toContain("temporaneamente indisponibile");
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("generateGuide reject NON crea draft HITL (llmSucceeded=false)", async () => {
    mockLLM.mockRejectedValueOnce(new Error("rate limit exceeded"));

    const result = await handleGuideRequest({ query: "elden ring" });
    expect(mockDraft).not.toHaveBeenCalled();
    expect(result.meta.draftId).toBeUndefined();
  });
});

// ── 4. DB down (retrieve) ──────────────────────────────────────────────

describe("T4.3 chaos: DB (PostgreSQL) down", () => {
  it("retrieveContext reject → bundle vuoto, LLM viene chiamato comunque", async () => {
    mockRetrieve.mockRejectedValueOnce(new Error("db connection refused"));
    // Orchestrator imposta bundle vuoto e prosegue al STEP 4 + 5
    mockScrape.mockResolvedValueOnce({
      results: [], sourceUsed: "none" as const,
      ragContext: "", scrapingContext: "", sources: [],
    });

    const result = await handleGuideRequest({ query: "elden ring" });
    expect(result.content).toBeDefined();
    expect(result.meta.sourceUsed).toBe("none");
  });
});

// ── 5. PSN validator down ──────────────────────────────────────────────

describe("T4.3 chaos: PSN validator (DB lookup) down", () => {
  it("validatePsnTrophyIdsInContent reject → meta no unverified, no crash", async () => {
    mockPsn.mockRejectedValueOnce(new Error("trophies table locked"));

    const result = await handleGuideRequest({ query: "elden ring" });
    expect(result.meta.unverifiedPsnIds).toBeUndefined();
    expect(result.content).toBe(happyLLM.content);
  });
});

// ── 6. Multiple failures ───────────────────────────────────────────────

describe("T4.3 chaos: cascading failures (worst case)", () => {
  it("Redis + Tavily + DB tutti giù → solo LLM con bundle vuoto, response degradata ma esiste", async () => {
    mockCache.get.mockResolvedValueOnce(null); // cache miss
    mockRetrieve.mockRejectedValueOnce(new Error("db down"));
    mockScrape.mockRejectedValueOnce(new Error("tavily down"));
    mockGetConv.mockResolvedValueOnce({ previousTurns: [], resetSuggested: false });
    mockCache.set.mockRejectedValueOnce(new Error("redis down"));

    const result = await handleGuideRequest({ query: "elden ring" });
    expect(result.content).toBeDefined();
    // L'unico componente vivo è il LLM stesso → il prompt avrà ragContext vuoto
    // ma la response viene comunque prodotta.
    expect(result.content).toBe(happyLLM.content);
  });

  it("TUTTO down (incluso LLM) → degradation message, no crash", async () => {
    mockCache.get.mockResolvedValueOnce(null);
    mockRetrieve.mockRejectedValueOnce(new Error("db"));
    mockScrape.mockRejectedValueOnce(new Error("tavily"));
    mockLLM.mockRejectedValueOnce(new Error("circuit OPEN"));
    mockCache.set.mockRejectedValueOnce(new Error("redis"));

    const result = await handleGuideRequest({ query: "elden ring" });
    expect(result.content).toContain("temporaneamente indisponibile");
  });
});

// ── 7. Normalize fallisce (tutta la pipeline avvelenata) ──────────────

describe("T4.3 chaos: normalize fallisce (input avvelenato)", () => {
  it("normalize reject → fallback minimo norm (en/walkthrough), prosegue", async () => {
    mockNorm.mockRejectedValueOnce(new Error("normalize crash"));

    const result = await handleGuideRequest({ query: "elden ring" });
    // Il fallback in orchestrator imposta language='en', game=null, etc.
    expect(result.meta.language).toBe("en");
    expect(result.content).toBeDefined();
  });
});
