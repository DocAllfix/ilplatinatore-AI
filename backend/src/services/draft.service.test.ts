import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDraft,
  getDraft,
  reviseDraft,
  approveDraft,
  rejectDraft,
  getConvHistory,
  type DraftCreateParams,
} from "./draft.service.js";
import { NotFoundError, ValidationError } from "@/utils/errors.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/config/redis.js", () => ({
  redis: {
    get: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/config/env.js", () => ({
  env: { DRAFT_TTL_SECONDS: 1800 },
}));

vi.mock("@/models/guideDrafts.model.js", () => ({
  GuideDraftsModel: {
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    updateStatus: vi.fn(),
    markApproved: vi.fn(),
    incrementIteration: vi.fn(),
  },
}));

vi.mock("@/services/llm.service.js", () => ({
  generateGuide: vi.fn(),
}));

import { redis } from "@/config/redis.js";
import { GuideDraftsModel } from "@/models/guideDrafts.model.js";
import { generateGuide } from "@/services/llm.service.js";

const mockRedis = vi.mocked(redis);
const mockModel = vi.mocked(GuideDraftsModel);
const mockLlm = vi.mocked(generateGuide);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DRAFT_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeDraft(overrides = {}) {
  return {
    id: DRAFT_ID,
    session_id: "sess-1",
    user_id: null,
    game_id: 1,
    trophy_id: 10,
    title: "Test Guide",
    slug: null,
    content: "## Requisiti\nStep 1.\n## Passaggi\n1. Do this.",
    language: "en",
    guide_type: "trophy",
    topic: null,
    status: "draft",
    iteration_count: 0,
    original_query: "how to get trophy X",
    sources_json: [],
    search_metadata: { gameTitle: "Elden Ring", targetName: "Malenia Trophy" },
    quality_score: 0,
    validation_errors: [],
    created_at: new Date(),
    updated_at: new Date(),
    approved_at: null,
    published_at: null,
    published_guide_id: null,
    ...overrides,
  };
}

const CREATE_PARAMS: DraftCreateParams = {
  content: "## Requisiti\nStep 1.\n## Passaggi\n1. Do this.",
  sessionId: "sess-1",
  userId: null,
  gameId: 1,
  trophyId: 10,
  gameTitle: "Elden Ring",
  targetName: "Malenia Trophy",
  guideType: "trophy",
  topic: null,
  language: "en",
  originalQuery: "how to get trophy X",
  sources: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default Redis: no stored state
  mockRedis.get.mockResolvedValue(null);
  mockRedis.setex.mockResolvedValue("OK");
});

// ── createDraft ───────────────────────────────────────────────────────────────

describe("createDraft", () => {
  it("crea la riga DB con i parametri corretti e salva stato Redis", async () => {
    const draft = makeDraft();
    mockModel.create.mockResolvedValueOnce(draft as never);

    const result = await createDraft(CREATE_PARAMS);

    expect(result).toEqual(draft);
    expect(mockModel.create).toHaveBeenCalledOnce();
    const createArg = mockModel.create.mock.calls[0]![0];
    expect(createArg.content).toBe(CREATE_PARAMS.content);
    expect(createArg.session_id).toBe("sess-1");
    expect(createArg.game_id).toBe(1);
    expect((createArg.search_metadata as Record<string,unknown>).gameTitle).toBe("Elden Ring");

    // Redis setex chiamato per salvare stato conversazione iniziale
    expect(mockRedis.setex).toHaveBeenCalledOnce();
    const [key, ttl, value] = mockRedis.setex.mock.calls[0]!;
    expect(key).toContain(DRAFT_ID);
    expect(ttl).toBe(1800);
    const history = JSON.parse(value as string) as Array<{ role: string; text: string }>;
    expect(history[0]?.role).toBe("model");
    expect(history[0]?.text).toBe(CREATE_PARAMS.content);
  });

  it("propaga errore DB senza swallowing", async () => {
    mockModel.create.mockRejectedValueOnce(new Error("DB error"));
    await expect(createDraft(CREATE_PARAMS)).rejects.toThrow("DB error");
  });
});

// ── getDraft ──────────────────────────────────────────────────────────────────

describe("getDraft", () => {
  it("ritorna la bozza quando trovata", async () => {
    const draft = makeDraft();
    mockModel.findById.mockResolvedValueOnce(draft as never);
    const result = await getDraft(DRAFT_ID);
    expect(result).toEqual(draft);
    expect(mockModel.findById).toHaveBeenCalledWith(DRAFT_ID);
  });

  it("lancia NotFoundError quando la bozza non esiste", async () => {
    mockModel.findById.mockResolvedValueOnce(null);
    await expect(getDraft("ghost-id")).rejects.toThrow(NotFoundError);
  });
});

// ── reviseDraft ───────────────────────────────────────────────────────────────

describe("reviseDraft", () => {
  it("chiama LLM, aggiorna contenuto e imposta status=revision", async () => {
    const draft = makeDraft({ iteration_count: 0 });
    mockModel.findById.mockResolvedValueOnce(draft as never);
    mockLlm.mockResolvedValueOnce({ content: "revised content", templateId: "trophy", model: "gemini", finishReason: null, elapsedMs: 100 });
    mockModel.incrementIteration.mockResolvedValueOnce(makeDraft({ iteration_count: 1 }) as never);
    mockModel.update.mockResolvedValueOnce(makeDraft({ content: "revised content" }) as never);
    mockModel.updateStatus.mockResolvedValueOnce(makeDraft({ status: "revision" }) as never);

    const result = await reviseDraft(DRAFT_ID, "improve the steps");

    expect(result.content).toBe("revised content");
    expect(result.status).toBe("revision");
    expect(result.iterationCount).toBe(1);
    expect(mockLlm).toHaveBeenCalledOnce();

    // LLM prompt includes current guide as ragContext
    const promptCtx = mockLlm.mock.calls[0]![0];
    expect(promptCtx.ragContext).toContain("CURRENT GUIDE CONTENT:");
    expect(promptCtx.userQuery).toContain("improve the steps");
  });

  it("tronca il feedback a 500 caratteri (anti-injection)", async () => {
    const draft = makeDraft({ iteration_count: 0 });
    mockModel.findById.mockResolvedValueOnce(draft as never);
    mockLlm.mockResolvedValueOnce({ content: "r", templateId: "t", model: "m", finishReason: null, elapsedMs: 1 });
    mockModel.incrementIteration.mockResolvedValueOnce(makeDraft({ iteration_count: 1 }) as never);
    mockModel.update.mockResolvedValueOnce(makeDraft() as never);
    mockModel.updateStatus.mockResolvedValueOnce(makeDraft() as never);

    const longFeedback = "x".repeat(600);
    await reviseDraft(DRAFT_ID, longFeedback);

    const promptCtx = mockLlm.mock.calls[0]![0];
    expect(promptCtx.userQuery.length).toBeLessThanOrEqual(560); // prefix ~53 chars + 500 feedback
  });

  it("imposta status=pending_approval quando raggiunge MAX_ITERATIONS", async () => {
    const draft = makeDraft({ iteration_count: 4 });
    mockModel.findById.mockResolvedValueOnce(draft as never);
    mockLlm.mockResolvedValueOnce({ content: "last revision", templateId: "t", model: "m", finishReason: null, elapsedMs: 1 });
    mockModel.incrementIteration.mockResolvedValueOnce(makeDraft({ iteration_count: 5 }) as never);
    mockModel.update.mockResolvedValueOnce(makeDraft() as never);
    mockModel.updateStatus.mockResolvedValueOnce(makeDraft({ status: "pending_approval" }) as never);

    const result = await reviseDraft(DRAFT_ID, "final feedback");

    expect(result.status).toBe("pending_approval");
    expect(mockModel.updateStatus).toHaveBeenCalledWith(DRAFT_ID, "pending_approval");
  });

  it("lancia ValidationError se iteration_count è già >= 5", async () => {
    mockModel.findById.mockResolvedValueOnce(makeDraft({ iteration_count: 5 }) as never);
    await expect(reviseDraft(DRAFT_ID, "too late")).rejects.toThrow(ValidationError);
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it("propaga errore LLM senza modificare il draft", async () => {
    mockModel.findById.mockResolvedValueOnce(makeDraft({ iteration_count: 0 }) as never);
    mockLlm.mockRejectedValueOnce(new Error("LLM down"));
    await expect(reviseDraft(DRAFT_ID, "feedback")).rejects.toThrow("LLM down");
  });
});

// ── approveDraft ──────────────────────────────────────────────────────────────

describe("approveDraft", () => {
  it("approva una bozza in stato pending_approval", async () => {
    const draft = makeDraft({ status: "pending_approval" });
    const approved = makeDraft({ status: "approved", approved_at: new Date() });
    mockModel.findById.mockResolvedValueOnce(draft as never);
    mockModel.markApproved.mockResolvedValueOnce(approved as never);

    const result = await approveDraft(DRAFT_ID);

    expect(result.status).toBe("approved");
    expect(mockModel.markApproved).toHaveBeenCalledWith(DRAFT_ID);
  });

  it("lancia ValidationError se status non è pending_approval", async () => {
    mockModel.findById.mockResolvedValueOnce(makeDraft({ status: "draft" }) as never);
    await expect(approveDraft(DRAFT_ID)).rejects.toThrow(ValidationError);
    expect(mockModel.markApproved).not.toHaveBeenCalled();
  });
});

// ── rejectDraft ───────────────────────────────────────────────────────────────

describe("rejectDraft", () => {
  it("rifiuta una bozza in stato pending_approval", async () => {
    const draft = makeDraft({ status: "pending_approval" });
    const rejected = makeDraft({ status: "rejected" });
    mockModel.findById.mockResolvedValueOnce(draft as never);
    mockModel.updateStatus.mockResolvedValueOnce(rejected as never);

    const result = await rejectDraft(DRAFT_ID);

    expect(result.status).toBe("rejected");
    expect(mockModel.updateStatus).toHaveBeenCalledWith(DRAFT_ID, "rejected");
  });

  it("lancia ValidationError se status non è pending_approval", async () => {
    mockModel.findById.mockResolvedValueOnce(makeDraft({ status: "approved" }) as never);
    await expect(rejectDraft(DRAFT_ID)).rejects.toThrow(ValidationError);
    expect(mockModel.updateStatus).not.toHaveBeenCalled();
  });
});

// ── getConvHistory ────────────────────────────────────────────────────────────

describe("getConvHistory", () => {
  it("ritorna storia vuota quando Redis non ha la chiave", async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    const result = await getConvHistory(DRAFT_ID);
    expect(result).toEqual([]);
  });

  it("deserializza e ritorna la storia da Redis", async () => {
    const history = [{ role: "model", text: "guide content", timestamp: 1000 }];
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(history));
    const result = await getConvHistory(DRAFT_ID);
    expect(result).toEqual(history);
  });

  it("ritorna array vuoto su errore Redis (fail-open)", async () => {
    mockRedis.get.mockRejectedValueOnce(new Error("Redis down"));
    const result = await getConvHistory(DRAFT_ID);
    expect(result).toEqual([]);
  });
});
