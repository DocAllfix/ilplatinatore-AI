import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GuideDraftsModel,
  type GuideDraftRow,
  type DraftCreate,
} from "./guideDrafts.model.js";

// ── Mock: intercetta query() senza toccare il DB reale ────────────────────────

vi.mock("@/config/database.js", () => ({
  query: vi.fn(),
}));

vi.mock("@/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { query } from "@/config/database.js";
const mockQuery = vi.mocked(query);

// ── Fixture ───────────────────────────────────────────────────────────────────

const DRAFT_ID = "550e8400-e29b-41d4-a716-446655440000";
const GUIDE_ID = 42;

function makeDraftRow(overrides: Partial<GuideDraftRow> = {}): GuideDraftRow {
  return {
    id: DRAFT_ID,
    session_id: "sess-abc",
    user_id: null,
    game_id: 1,
    trophy_id: null,
    title: "Test Trophy Guide",
    slug: "elden-ring-test-trophy",
    content: "Step 1: Do something. Step 2: Do another thing.",
    language: "en",
    guide_type: "trophy",
    topic: null,
    status: "draft",
    iteration_count: 0,
    original_query: "how to get the test trophy",
    sources_json: [],
    search_metadata: {},
    quality_score: 0,
    validation_errors: [],
    created_at: new Date("2026-04-30T00:00:00Z"),
    updated_at: new Date("2026-04-30T00:00:00Z"),
    approved_at: null,
    published_at: null,
    published_guide_id: null,
    ...overrides,
  };
}

function pgResult(rows: GuideDraftRow[]) {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── create ────────────────────────────────────────────────────────────────────

describe("GuideDraftsModel.create", () => {
  it("chiama INSERT e ritorna la riga creata", async () => {
    const row = makeDraftRow();
    mockQuery.mockResolvedValueOnce(pgResult([row]));

    const data: DraftCreate = {
      content: row.content,
      session_id: "sess-abc",
      game_id: 1,
      original_query: "how to get the test trophy",
      language: "en",
      guide_type: "trophy",
    };

    const result = await GuideDraftsModel.create(data);

    expect(result).toEqual(row);
    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO guide_drafts");
    expect(params).toContain("sess-abc");
    expect(params).toContain(row.content);
  });

  it("usa defaults per campi opzionali non forniti", async () => {
    mockQuery.mockResolvedValueOnce(pgResult([makeDraftRow()]));

    await GuideDraftsModel.create({ content: "minimal content" });

    const [, params] = mockQuery.mock.calls[0]!;
    // session_id null, user_id null, game_id null, trophy_id null
    expect(params![0]).toBeNull();
    expect(params![1]).toBeNull();
    expect(params![2]).toBeNull();
    expect(params![3]).toBeNull();
    // language default 'en'
    expect(params![7]).toBe("en");
    // quality_score default 0
    expect(params![13]).toBe(0);
  });

  it("propaga errore DB e logga", async () => {
    const dbErr = new Error("DB error");
    mockQuery.mockRejectedValueOnce(dbErr);
    await expect(GuideDraftsModel.create({ content: "x" })).rejects.toThrow("DB error");
  });
});

// ── findById ──────────────────────────────────────────────────────────────────

describe("GuideDraftsModel.findById", () => {
  it("ritorna la riga quando trovata", async () => {
    const row = makeDraftRow();
    mockQuery.mockResolvedValueOnce(pgResult([row]));

    const result = await GuideDraftsModel.findById(DRAFT_ID);

    expect(result).toEqual(row);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("WHERE id = $1");
    expect(params).toContain(DRAFT_ID);
  });

  it("ritorna null quando nessuna riga trovata", async () => {
    mockQuery.mockResolvedValueOnce(pgResult([]));
    const result = await GuideDraftsModel.findById("unknown-uuid");
    expect(result).toBeNull();
  });

  it("propaga errore DB", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB down"));
    await expect(GuideDraftsModel.findById(DRAFT_ID)).rejects.toThrow("DB down");
  });
});

// ── findBySession ─────────────────────────────────────────────────────────────

describe("GuideDraftsModel.findBySession", () => {
  it("ritorna array di bozze per session_id", async () => {
    const rows = [makeDraftRow(), makeDraftRow({ id: "other-uuid" })];
    mockQuery.mockResolvedValueOnce(pgResult(rows));

    const result = await GuideDraftsModel.findBySession("sess-abc");

    expect(result).toHaveLength(2);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("WHERE session_id = $1");
    expect(params![0]).toBe("sess-abc");
  });

  it("ritorna array vuoto quando nessuna bozza per la sessione", async () => {
    mockQuery.mockResolvedValueOnce(pgResult([]));
    const result = await GuideDraftsModel.findBySession("sess-unknown");
    expect(result).toEqual([]);
  });

  it("usa limit default 10", async () => {
    mockQuery.mockResolvedValueOnce(pgResult([]));
    await GuideDraftsModel.findBySession("sess-abc");
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params![1]).toBe(10);
  });

  it("accetta limit custom", async () => {
    mockQuery.mockResolvedValueOnce(pgResult([]));
    await GuideDraftsModel.findBySession("sess-abc", 5);
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params![1]).toBe(5);
  });
});

// ── update ────────────────────────────────────────────────────────────────────

describe("GuideDraftsModel.update", () => {
  it("aggiorna i campi forniti e ritorna riga aggiornata", async () => {
    const updated = makeDraftRow({ title: "New Title", content: "new content" });
    mockQuery.mockResolvedValueOnce(pgResult([updated]));

    const result = await GuideDraftsModel.update(DRAFT_ID, {
      title: "New Title",
      content: "new content",
    });

    expect(result?.title).toBe("New Title");
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("UPDATE guide_drafts");
    expect(sql).toContain("updated_at = NOW()");
    expect(params).toContain("New Title");
    expect(params).toContain("new content");
    // id è l'ultimo parametro
    expect(params![params!.length - 1]).toBe(DRAFT_ID);
  });

  it("ritorna null se la bozza non esiste", async () => {
    mockQuery.mockResolvedValueOnce(pgResult([]));
    const result = await GuideDraftsModel.update("non-existent", { title: "x" });
    expect(result).toBeNull();
  });

  it("lancia quando nessun campo aggiornabile è fornito", async () => {
    // DraftUpdate vuoto: nessun campo noto in UPDATABLE_COLS
    await expect(GuideDraftsModel.update(DRAFT_ID, {})).rejects.toThrow(
      "No updatable fields provided",
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("non permette di impostare status tramite update() generico", async () => {
    // status non è in UPDATABLE_COLS — passa come campo sconosciuto, viene ignorato
    mockQuery.mockResolvedValueOnce(pgResult([makeDraftRow({ content: "ok" })]));
    await GuideDraftsModel.update(DRAFT_ID, {
      content: "ok",
      // @ts-expect-error: status non deve essere in DraftUpdate
      status: "published",
    });
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).not.toContain("status = ");
  });
});

// ── updateStatus ──────────────────────────────────────────────────────────────

describe("GuideDraftsModel.updateStatus", () => {
  it("aggiorna solo il campo status", async () => {
    const updated = makeDraftRow({ status: "revision" });
    mockQuery.mockResolvedValueOnce(pgResult([updated]));

    const result = await GuideDraftsModel.updateStatus(DRAFT_ID, "revision");

    expect(result?.status).toBe("revision");
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("SET status = $1");
    expect(params![0]).toBe("revision");
    expect(params![1]).toBe(DRAFT_ID);
  });

  it("ritorna null se bozza non trovata", async () => {
    mockQuery.mockResolvedValueOnce(pgResult([]));
    const result = await GuideDraftsModel.updateStatus("ghost-id", "revision");
    expect(result).toBeNull();
  });
});

// ── markApproved ──────────────────────────────────────────────────────────────

describe("GuideDraftsModel.markApproved", () => {
  it("imposta status=approved e approved_at", async () => {
    const now = new Date();
    const updated = makeDraftRow({ status: "approved", approved_at: now });
    mockQuery.mockResolvedValueOnce(pgResult([updated]));

    const result = await GuideDraftsModel.markApproved(DRAFT_ID);

    expect(result?.status).toBe("approved");
    expect(result?.approved_at).toBe(now);
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain("approved_at = NOW()");
  });
});

// ── markPublished ─────────────────────────────────────────────────────────────

describe("GuideDraftsModel.markPublished", () => {
  it("imposta status=published, published_at, published_guide_id", async () => {
    const now = new Date();
    const updated = makeDraftRow({
      status: "published",
      published_at: now,
      published_guide_id: GUIDE_ID,
    });
    mockQuery.mockResolvedValueOnce(pgResult([updated]));

    const result = await GuideDraftsModel.markPublished(DRAFT_ID, GUIDE_ID);

    expect(result?.status).toBe("published");
    expect(result?.published_guide_id).toBe(GUIDE_ID);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("status = 'published'");
    expect(sql).toContain("published_guide_id = $1");
    expect(params![0]).toBe(GUIDE_ID);
    expect(params![1]).toBe(DRAFT_ID);
  });
});

// ── markFailed ────────────────────────────────────────────────────────────────

describe("GuideDraftsModel.markFailed", () => {
  it("imposta status=failed con array errori", async () => {
    const errors = [{ layer: 2, message: "Sezione mancante: ## Passaggi" }];
    const updated = makeDraftRow({ status: "failed", validation_errors: errors });
    mockQuery.mockResolvedValueOnce(pgResult([updated]));

    const result = await GuideDraftsModel.markFailed(DRAFT_ID, errors);

    expect(result?.status).toBe("failed");
    expect(result?.validation_errors).toEqual(errors);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("status = 'failed'");
    expect(params![0]).toEqual(errors);
    expect(params![1]).toBe(DRAFT_ID);
  });
});

// ── incrementIteration ────────────────────────────────────────────────────────

describe("GuideDraftsModel.incrementIteration", () => {
  it("usa increment SQL atomico e ritorna la riga aggiornata", async () => {
    const updated = makeDraftRow({ iteration_count: 1 });
    mockQuery.mockResolvedValueOnce(pgResult([updated]));

    const result = await GuideDraftsModel.incrementIteration(DRAFT_ID);

    expect(result?.iteration_count).toBe(1);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("iteration_count = iteration_count + 1");
    expect(params![0]).toBe(DRAFT_ID);
  });
});

// ── getPendingApproval ────────────────────────────────────────────────────────

describe("GuideDraftsModel.getPendingApproval", () => {
  it("filtra per status=pending_approval e usa FIFO (ASC)", async () => {
    const rows = [makeDraftRow({ status: "pending_approval" })];
    mockQuery.mockResolvedValueOnce(pgResult(rows));

    const result = await GuideDraftsModel.getPendingApproval();

    expect(result).toHaveLength(1);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("WHERE status = 'pending_approval'");
    expect(sql).toContain("ORDER BY created_at ASC");
    expect(params![0]).toBe(20);
    expect(params![1]).toBe(0);
  });

  it("applica limit e offset custom", async () => {
    mockQuery.mockResolvedValueOnce(pgResult([]));
    await GuideDraftsModel.getPendingApproval(5, 10);
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params![0]).toBe(5);
    expect(params![1]).toBe(10);
  });

  it("ritorna array vuoto quando nessuna bozza in coda", async () => {
    mockQuery.mockResolvedValueOnce(pgResult([]));
    const result = await GuideDraftsModel.getPendingApproval();
    expect(result).toEqual([]);
  });
});
