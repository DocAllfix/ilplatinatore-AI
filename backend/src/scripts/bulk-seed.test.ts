import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  guideRecordSchema,
  buildSlug,
  insertGuideOrSkip,
  seedBatch,
  parseArgs,
  type GuideRecord,
} from "./bulk-seed.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/config/database.js", () => ({
  query: vi.fn(),
  pool: { end: vi.fn() },
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { query } from "@/config/database.js";

const mockedQuery = vi.mocked(query);

// ── Fixture ───────────────────────────────────────────────────────────────────

const validRecord: GuideRecord = {
  game_id: 1,
  title: "Guida Malenia",
  content: "Passo 1: vai nella zona. Passo 2: attacca il boss.",
  language: "en",
  source: "chatbot",
  quality_score: 0,
  verified: false,
  confidence_level: "generated",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── guideRecordSchema ─────────────────────────────────────────────────────────

describe("guideRecordSchema", () => {
  it("accetta record minimo valido", () => {
    const r = guideRecordSchema.safeParse({
      game_id: 1,
      title: "Test Guide",
      content: "contenuto lungo abbastanza",
    });
    expect(r.success).toBe(true);
  });

  it("applica default: language=en, source=chatbot, confidence_level=generated", () => {
    const r = guideRecordSchema.parse({ game_id: 1, title: "T", content: "contenuto lungo" });
    expect(r.language).toBe("en");
    expect(r.source).toBe("chatbot");
    expect(r.confidence_level).toBe("generated");
    expect(r.verified).toBe(false);
    expect(r.quality_score).toBe(0);
  });

  it("fallisce senza game_id", () => {
    expect(guideRecordSchema.safeParse({ title: "T", content: "c lungo" }).success).toBe(false);
  });

  it("fallisce senza title", () => {
    expect(guideRecordSchema.safeParse({ game_id: 1, content: "c lungo" }).success).toBe(false);
  });

  it("fallisce con content troppo corto (< 10 chars)", () => {
    expect(
      guideRecordSchema.safeParse({ game_id: 1, title: "T", content: "short" }).success,
    ).toBe(false);
  });

  it("fallisce con guide_type non valido", () => {
    expect(
      guideRecordSchema.safeParse({ game_id: 1, title: "T", content: "contenuto lungo", guide_type: "boss" }).success,
    ).toBe(false);
  });

  it("accetta tutti i guide_type validi", () => {
    const types = ["trophy", "walkthrough", "collectible", "challenge", "platinum"] as const;
    for (const t of types) {
      expect(
        guideRecordSchema.safeParse({ game_id: 1, title: "T", content: "contenuto lungo", guide_type: t }).success,
      ).toBe(true);
    }
  });

  it("accetta tutti i confidence_level validi", () => {
    const levels = ["verified", "harvested", "generated", "unverified"] as const;
    for (const l of levels) {
      expect(
        guideRecordSchema.safeParse({ game_id: 1, title: "T", content: "contenuto lungo", confidence_level: l }).success,
      ).toBe(true);
    }
  });
});

// ── buildSlug ─────────────────────────────────────────────────────────────────

describe("buildSlug", () => {
  it("usa slug fornito se presente", () => {
    expect(buildSlug({ ...validRecord, slug: "my-custom-slug" })).toBe("my-custom-slug");
  });

  it("genera slug da title+game_id se slug assente", () => {
    const s = buildSlug({ ...validRecord, title: "Guida Malenia", game_id: 5 });
    expect(s).toContain("guida");
    expect(s).toContain("malenia");
    expect(s).toMatch(/-g5$/);
  });

  it("due record con stesso title+game_id generano slug identici (idempotenza ON CONFLICT)", () => {
    const r1 = buildSlug({ ...validRecord });
    const r2 = buildSlug({ ...validRecord });
    expect(r1).toBe(r2);
  });

  it("normalizza accenti e caratteri speciali", () => {
    const s = buildSlug({ ...validRecord, title: "Guida Élite Ænima", slug: undefined });
    expect(s).not.toContain("É");
    expect(s).not.toContain("Æ");
  });
});

// ── insertGuideOrSkip ─────────────────────────────────────────────────────────

describe("insertGuideOrSkip", () => {
  it("inserisce correttamente e ritorna inserted=true con id", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 } as never);
    const r = await insertGuideOrSkip(validRecord, "guida-malenia-g1");
    expect(r.inserted).toBe(true);
    expect(r.id).toBe(42);
  });

  it("la query contiene ON CONFLICT (slug) DO NOTHING", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 } as never);
    await insertGuideOrSkip(validRecord, "test-slug");
    const sql = mockedQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("ON CONFLICT (slug) DO NOTHING");
  });

  it("ON CONFLICT (0 rows): ritorna inserted=false senza id", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const r = await insertGuideOrSkip(validRecord, "slug-esistente");
    expect(r.inserted).toBe(false);
    expect(r.id).toBeUndefined();
  });

  it("passa embedding_pending=true per accodamento futuro", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 } as never);
    await insertGuideOrSkip(validRecord, "slug");
    const params = mockedQuery.mock.calls[0]![1] as unknown[];
    // embedding_pending è il 13° parametro ($13)
    expect(params[12]).toBe(true);
  });
});

// ── seedBatch ─────────────────────────────────────────────────────────────────

describe("seedBatch", () => {
  it("dry-run NON chiama query DB", async () => {
    const stats = await seedBatch([validRecord, validRecord], true);
    expect(mockedQuery).not.toHaveBeenCalled();
    expect(stats.inserted).toBe(2);
    expect(stats.total).toBe(2);
    expect(stats.skipped).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it("inserisce batch correttamente", async () => {
    mockedQuery.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 } as never);
    const stats = await seedBatch([validRecord, validRecord], false);
    expect(stats.inserted).toBe(2);
    expect(stats.skipped).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.total).toBe(2);
  });

  it("conta skipped quando ON CONFLICT (rows vuoti)", async () => {
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    const stats = await seedBatch([validRecord], false);
    expect(stats.skipped).toBe(1);
    expect(stats.inserted).toBe(0);
  });

  it("fail-open: DB error → stats.failed++, continua sul record successivo", async () => {
    mockedQuery
      .mockRejectedValueOnce(new Error("DB timeout"))
      .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 } as never);
    const stats = await seedBatch([validRecord, validRecord], false);
    expect(stats.failed).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.total).toBe(2);
  });

  it("batch vuoto ritorna stats zeroed", async () => {
    const stats = await seedBatch([], false);
    expect(stats.total).toBe(0);
    expect(stats.inserted).toBe(0);
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("parsa --file obbligatorio", () => {
    const args = parseArgs(["--file", "/tmp/data.jsonl"]);
    expect(args.file).toContain("data.jsonl");
  });

  it("parsa --batch-size e --delay-ms", () => {
    const args = parseArgs(["--file", "/tmp/f.jsonl", "--batch-size", "100", "--delay-ms", "200"]);
    expect(args.batchSize).toBe(100);
    expect(args.delayMs).toBe(200);
  });

  it("parsa --dry-run e --resume come boolean", () => {
    const args = parseArgs(["--file", "/tmp/f.jsonl", "--dry-run", "--resume"]);
    expect(args.dryRun).toBe(true);
    expect(args.resume).toBe(true);
  });

  it("default batchSize=50, delayMs=0, dryRun=false, resume=false", () => {
    const args = parseArgs(["--file", "/tmp/f.jsonl"]);
    expect(args.batchSize).toBe(50);
    expect(args.delayMs).toBe(0);
    expect(args.dryRun).toBe(false);
    expect(args.resume).toBe(false);
  });
});
