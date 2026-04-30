import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateDraft,
  ingestApprovedDraft,
} from "./ingestion.service.js";
import { NotFoundError, ValidationError } from "@/utils/errors.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/models/guideDrafts.model.js", () => ({
  GuideDraftsModel: {
    findById: vi.fn(),
    markPublished: vi.fn(),
    markFailed: vi.fn(),
  },
}));

vi.mock("@/models/guides.model.js", () => ({
  GuidesModel: {
    create: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock("@/queues/embedding.queue.js", () => ({
  enqueueLiveEmbedding: vi.fn(),
}));

// guide.cache.js slugify is imported directly — mock only the module export
vi.mock("@/services/guide.cache.js", () => ({
  slugify: (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120),
}));

import { GuideDraftsModel } from "@/models/guideDrafts.model.js";
import { GuidesModel } from "@/models/guides.model.js";
import { enqueueLiveEmbedding } from "@/queues/embedding.queue.js";

const mockDraftsModel = vi.mocked(GuideDraftsModel);
const mockGuidesModel = vi.mocked(GuidesModel);
const mockEnqueue = vi.mocked(enqueueLiveEmbedding);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DRAFT_ID = "550e8400-e29b-41d4-a716-446655440000";
const GUIDE_ID = 99;

const VALID_CONTENT =
  "## Requisiti\n" +
  "Per ottenere questo trofeo devi completare una serie di passaggi molto specifici.\n" +
  "## Passaggi\n" +
  "1. Primo passaggio: avvia il gioco e raggiungi la zona indicata.\n" +
  "2. Secondo passaggio: interagisci con l'oggetto per completare l'obiettivo.\n" +
  "3. Terzo passaggio: confirma il completamento nel menu trofei.";

function makeDraft(overrides = {}) {
  return {
    id: DRAFT_ID,
    session_id: "sess-1",
    user_id: null,
    game_id: 1,
    trophy_id: 10,
    title: "Test Trophy Guide",
    slug: null,
    content: VALID_CONTENT,
    language: "en",
    guide_type: "trophy",
    topic: null,
    status: "approved",
    iteration_count: 3,
    original_query: "how to get trophy",
    sources_json: [],
    search_metadata: { gameTitle: "Elden Ring", targetName: "Malenia Trophy" },
    quality_score: 0.75,
    validation_errors: [],
    created_at: new Date(),
    updated_at: new Date(),
    approved_at: new Date(),
    published_at: null,
    published_guide_id: null,
    ...overrides,
  };
}

function makeGuideRow(overrides = {}) {
  return {
    id: GUIDE_ID,
    game_id: 1,
    trophy_id: 10,
    title: "Test Trophy Guide",
    slug: "test-trophy-guide-550e8400",
    content: VALID_CONTENT,
    content_html: null,
    language: "en",
    guide_type: "trophy",
    source: "chatbot",
    quality_score: 0.75,
    verified: false,
    view_count: 0,
    helpful_count: 0,
    report_count: 0,
    metadata: {},
    embedding_pending: true,
    confidence_level: "generated",
    topic: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDraftsModel.markPublished.mockResolvedValue(makeDraft({ status: "published" }) as never);
  mockDraftsModel.markFailed.mockResolvedValue(makeDraft({ status: "failed" }) as never);
  mockEnqueue.mockResolvedValue(undefined);
});

// ── validateDraft ─────────────────────────────────────────────────────────────

describe("validateDraft", () => {
  it("ritorna valid=true per una bozza completa e corretta", () => {
    const result = validateDraft(makeDraft() as never);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("Layer 1: fallisce se il contenuto è troppo corto", () => {
    const result = validateDraft(makeDraft({ content: "short" }) as never);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.layer === 1)).toBe(true);
  });

  it("Layer 2: fallisce se manca una sezione richiesta (## Passaggi)", () => {
    const noPassaggi = VALID_CONTENT.replace("## Passaggi", "## Steps");
    const result = validateDraft(makeDraft({ content: noPassaggi }) as never);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.layer === 2 && e.message.includes("Passaggi"))).toBe(true);
  });

  it("Layer 3: fallisce se game_id è null", () => {
    const result = validateDraft(makeDraft({ game_id: null }) as never);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.layer === 3)).toBe(true);
  });

  it("Layer 4: fallisce per guide_type=trophy senza trophy_id", () => {
    const result = validateDraft(makeDraft({ guide_type: "trophy", trophy_id: null }) as never);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.layer === 4)).toBe(true);
  });

  it("Layer 4: non fallisce per guide_type=walkthrough senza trophy_id", () => {
    const content =
      "## Panoramica\nQuesta è la panoramica dettagliata.\n## Walkthrough\n1. Primo step lungo e importante.";
    const result = validateDraft(makeDraft({ guide_type: "walkthrough", trophy_id: null, content }) as never);
    expect(result.errors.some((e) => e.layer === 4)).toBe(false);
  });

  it("Layer 5: fallisce su marker di rifiuto LLM", () => {
    const refusalContent =
      VALID_CONTENT + "\nnon ho informazioni sufficienti per questa guida.";
    const result = validateDraft(makeDraft({ content: refusalContent }) as never);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.layer === 5)).toBe(true);
  });

  it("accumula errori multipli da layer diversi", () => {
    const result = validateDraft(
      makeDraft({ content: "x", game_id: null, guide_type: "trophy", trophy_id: null }) as never,
    );
    expect(result.valid).toBe(false);
    // Layer 1 (troppo corto), Layer 2 (sezioni mancanti), Layer 3 (no game), Layer 4 (no trophy)
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ── ingestApprovedDraft ───────────────────────────────────────────────────────

describe("ingestApprovedDraft", () => {
  it("happy path: crea guida, marca pubblicata, accoda embedding", async () => {
    mockDraftsModel.findById.mockResolvedValueOnce(makeDraft() as never);
    mockGuidesModel.create.mockResolvedValueOnce(makeGuideRow() as never);

    const guide = await ingestApprovedDraft(DRAFT_ID);

    expect(guide.id).toBe(GUIDE_ID);
    expect(mockGuidesModel.create).toHaveBeenCalledOnce();
    const createArg = mockGuidesModel.create.mock.calls[0]![0];
    expect(createArg.source).toBe("chatbot");
    expect(createArg.confidence_level).toBe("generated");
    expect(createArg.embedding_pending).toBe(true);
    expect(createArg.game_id).toBe(1);

    expect(mockDraftsModel.markPublished).toHaveBeenCalledWith(DRAFT_ID, GUIDE_ID);
    expect(mockEnqueue).toHaveBeenCalledWith(GUIDE_ID);
  });

  it("lo slug generato include l'UUID della bozza come suffix", async () => {
    mockDraftsModel.findById.mockResolvedValueOnce(makeDraft() as never);
    mockGuidesModel.create.mockResolvedValueOnce(makeGuideRow() as never);

    await ingestApprovedDraft(DRAFT_ID);

    const slug = mockGuidesModel.create.mock.calls[0]![0].slug;
    // Il suffix sono i primi 8 char dell'UUID senza trattini: 550e8400
    expect(slug).toContain("550e8400");
  });

  it("lancia NotFoundError se la bozza non esiste", async () => {
    mockDraftsModel.findById.mockResolvedValueOnce(null);
    await expect(ingestApprovedDraft("ghost")).rejects.toThrow(NotFoundError);
  });

  it("lancia ValidationError se status non è approved", async () => {
    mockDraftsModel.findById.mockResolvedValueOnce(
      makeDraft({ status: "pending_approval" }) as never,
    );
    await expect(ingestApprovedDraft(DRAFT_ID)).rejects.toThrow(ValidationError);
    expect(mockGuidesModel.create).not.toHaveBeenCalled();
  });

  it("idempotenza: ritorna la guida esistente se già pubblicata", async () => {
    const alreadyPublished = makeDraft({ status: "published", published_guide_id: GUIDE_ID });
    mockDraftsModel.findById.mockResolvedValueOnce(alreadyPublished as never);
    mockGuidesModel.findById.mockResolvedValueOnce(makeGuideRow() as never);

    const guide = await ingestApprovedDraft(DRAFT_ID);

    expect(guide.id).toBe(GUIDE_ID);
    expect(mockGuidesModel.create).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("chiama markFailed e lancia ValidationError su validazione fallita", async () => {
    mockDraftsModel.findById.mockResolvedValueOnce(
      makeDraft({ content: "troppo corto", game_id: null }) as never,
    );

    await expect(ingestApprovedDraft(DRAFT_ID)).rejects.toThrow(ValidationError);
    expect(mockDraftsModel.markFailed).toHaveBeenCalledOnce();
    const errorsArg = mockDraftsModel.markFailed.mock.calls[0]![1];
    expect(errorsArg.length).toBeGreaterThan(0);
    expect(mockGuidesModel.create).not.toHaveBeenCalled();
  });

  it("usa title generato se draft.title è null", async () => {
    const draftNoTitle = makeDraft({ title: null });
    mockDraftsModel.findById.mockResolvedValueOnce(draftNoTitle as never);
    mockGuidesModel.create.mockResolvedValueOnce(makeGuideRow() as never);

    await ingestApprovedDraft(DRAFT_ID);

    const createArg = mockGuidesModel.create.mock.calls[0]![0];
    expect(createArg.title).toBe("Guide: Malenia Trophy");
  });

  it("non lancia se markPublished fallisce (log critical, guida creata)", async () => {
    mockDraftsModel.findById.mockResolvedValueOnce(makeDraft() as never);
    mockGuidesModel.create.mockResolvedValueOnce(makeGuideRow() as never);
    mockDraftsModel.markPublished.mockRejectedValueOnce(new Error("DB error"));

    // Deve risolvere senza lanciare — la guida esiste ma il link è broken
    await expect(ingestApprovedDraft(DRAFT_ID)).resolves.toBeDefined();
    expect(mockEnqueue).toHaveBeenCalled();
  });
});
