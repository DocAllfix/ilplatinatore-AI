import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config/database.js", () => ({ query: vi.fn() }));
vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// node-cron non deve schedulare nulla nei test → mock vuoto
vi.mock("node-cron", () => ({ default: { schedule: vi.fn() } }));

import { query } from "@/config/database.js";
import { __cleanup } from "./cleanup.scheduler.js";

const mockQuery = vi.mocked(query);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── deleteOldQueryLog ─────────────────────────────────────────────────────

describe("cleanup.deleteOldQueryLog", () => {
  it("usa retention 90 giorni nel SQL", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await __cleanup.deleteOldQueryLog();
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain(`'${__cleanup.QUERY_LOG_RETENTION_DAYS} days'`);
    expect(sql).toContain("DELETE FROM query_log");
  });

  it("usa LIMIT batched per evitare lock prolungati", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await __cleanup.deleteOldQueryLog();
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toMatch(/LIMIT\s+\d+/);
  });

  it("itera finché ogni batch ritorna < limit", async () => {
    // 50_000, 50_000, 100 → totale 100_100 ma 3 iterazioni
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 50_000 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 50_000 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 100 } as never);
    const total = await __cleanup.deleteOldQueryLog();
    expect(total).toBe(100_100);
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it("interrompe al primo batch errore (fail-open, prossimo run riprova)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB lock timeout"));
    const total = await __cleanup.deleteOldQueryLog();
    expect(total).toBe(0);
  });

  it("safety cap MAX_BATCH_ITERATIONS (20 × 50_000 = 1M max per run)", async () => {
    // Simula return == limit per più di MAX_ITERATIONS
    mockQuery.mockResolvedValue({ rows: [], rowCount: 50_000 } as never);
    await __cleanup.deleteOldQueryLog();
    expect(mockQuery.mock.calls.length).toBeLessThanOrEqual(20);
  });
});

// ── deleteOldTerminalDrafts ───────────────────────────────────────────────

describe("cleanup.deleteOldTerminalDrafts", () => {
  it("filtra solo status terminali rejected/failed (NON published)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await __cleanup.deleteOldTerminalDrafts();
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("'rejected'");
    expect(sql).toContain("'failed'");
    // 'published' NON deve essere nella clausola IN (è linkato a guides via published_guide_id).
    // Il commento descrittivo SQL può menzionarla, quindi controlliamo solo l'IN clause.
    const inClause = sql.match(/IN\s*\(([^)]+)\)/);
    expect(inClause).not.toBeNull();
    expect(inClause![1]).not.toContain("published");
  });

  it("usa retention 30 giorni", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await __cleanup.deleteOldTerminalDrafts();
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain(`'${__cleanup.DRAFT_TERMINAL_RETENTION_DAYS} days'`);
  });

  it("usa updated_at (non created_at) — il draft può essere stato in 'pending_approval' a lungo", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await __cleanup.deleteOldTerminalDrafts();
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("updated_at");
  });
});
