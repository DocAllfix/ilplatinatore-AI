import { describe, it, expect, vi, beforeEach } from "vitest";
import { RatingsModel } from "./ratings.model.js";

vi.mock("@/config/database.js", () => ({ query: vi.fn() }));
vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { query } from "@/config/database.js";
const mockQuery = vi.mocked(query);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── findByUser ────────────────────────────────────────────────────────────────

describe("RatingsModel.findByUser", () => {
  it("filtra per user_id e fa LEFT JOIN su guides", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1, guide_id: 10, user_id: 42, session_id: null,
          stars: 5, suggestion: "great", language: "en",
          created_at: new Date(),
          guide_title: "Elden Ring Platinum", guide_slug: "elden-ring-platinum",
        },
      ],
      rowCount: 1,
    } as never);

    const rows = await RatingsModel.findByUser(42, 5, 10);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.guide_title).toBe("Elden Ring Platinum");
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("LEFT JOIN guides g");
    expect(sql).toContain("WHERE gr.user_id = $1");
    expect(sql).toContain("ORDER BY gr.created_at DESC");
    expect(params).toEqual([42, 5, 10]);
  });

  it("default limit=20 offset=0", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await RatingsModel.findByUser(42);
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params).toEqual([42, 20, 0]);
  });

  it("ritorna array vuoto quando l'utente non ha ratings", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const rows = await RatingsModel.findByUser(99);
    expect(rows).toEqual([]);
  });

  it("conserva il rating anche se la guida è stata cancellata (guide_title=null)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1, guide_id: 999, user_id: 42, session_id: null,
          stars: 3, suggestion: null, language: null,
          created_at: new Date(),
          guide_title: null, guide_slug: null,
        },
      ],
      rowCount: 1,
    } as never);

    const rows = await RatingsModel.findByUser(42);
    expect(rows[0]!.guide_id).toBe(999);
    expect(rows[0]!.guide_title).toBeNull();
  });

  it("propaga errori del DB", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection lost"));
    await expect(RatingsModel.findByUser(1)).rejects.toThrow("connection lost");
  });
});

// ── countByUser ───────────────────────────────────────────────────────────────

describe("RatingsModel.countByUser", () => {
  it("ritorna numero parsato", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "7" }], rowCount: 1 } as never);
    const n = await RatingsModel.countByUser(42);
    expect(n).toBe(7);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("COUNT(*)::text");
    expect(sql).toContain("WHERE user_id = $1");
    expect(params).toEqual([42]);
  });

  it("ritorna 0 quando nessun rating", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await RatingsModel.countByUser(99)).toBe(0);
  });
});
