import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  UserGameStatsModel,
  type UserGameStatsRow,
} from "./userGameStats.model.js";

vi.mock("@/config/database.js", () => ({ query: vi.fn() }));
vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { query } from "@/config/database.js";
const mockQuery = vi.mocked(query);

const STAT_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeRow(overrides: Partial<UserGameStatsRow> = {}): UserGameStatsRow {
  return {
    id: STAT_ID,
    user_id: 42,
    game_id: 1,
    game_slug: "elden-ring",
    game_name: "Elden Ring",
    total_playtime: 0,
    bosses_felled: 0,
    current_level: 1,
    quests_completed: 0,
    progression_percentage: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── findByUser ────────────────────────────────────────────────────────────────

describe("UserGameStatsModel.findByUser", () => {
  it("filtra per user_id + game_slug quando slug fornito", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never);
    await UserGameStatsModel.findByUser(42, "elden-ring");
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("WHERE user_id = $1 AND game_slug = $2");
    expect(params).toEqual([42, "elden-ring"]);
  });

  it("ritorna tutte le stats utente quando slug omesso", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await UserGameStatsModel.findByUser(42);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("WHERE user_id = $1");
    // game_slug appare nella SELECT list (è una colonna ritornata),
    // ma NON deve essere nel WHERE quando il filtro è omesso.
    expect(sql).not.toMatch(/WHERE[^;]*game_slug/);
    expect(params).toEqual([42]);
  });

  it("ritorna array vuoto quando nessun match", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await UserGameStatsModel.findByUser(42, "ghost-game")).toEqual([]);
  });

  it("propaga errori del DB", async () => {
    mockQuery.mockRejectedValueOnce(new Error("conn refused"));
    await expect(UserGameStatsModel.findByUser(1)).rejects.toThrow("conn refused");
  });
});

// ── upsert ────────────────────────────────────────────────────────────────────

describe("UserGameStatsModel.upsert", () => {
  it("usa ON CONFLICT su user_game_stats_uniq (idempotente)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never);
    await UserGameStatsModel.upsert({
      user_id: 42, game_id: 1, game_slug: "elden-ring", game_name: "Elden Ring",
    });
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("ON CONFLICT ON CONSTRAINT user_game_stats_uniq");
    expect(sql).toContain("DO UPDATE SET");
  });

  it("applica COALESCE sui default numerici (totalPlaytime omesso = 0)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never);
    await UserGameStatsModel.upsert({
      user_id: 42, game_id: 1, game_slug: "x", game_name: "X",
    });
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    // 4 obbligatori + 5 opzionali (passati come null per innescare COALESCE).
    expect(params[4]).toBeNull(); // total_playtime → COALESCE → 0 nel SQL
    expect(params[5]).toBeNull();
    expect(params[6]).toBeNull(); // current_level → COALESCE → 1
  });

  it("passa current_level=1 di default (frontend lo vuole non-zero)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never);
    await UserGameStatsModel.upsert({
      user_id: 42, game_id: 1, game_slug: "x", game_name: "X",
    });
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("COALESCE($7, 1)"); // current_level
  });
});

// ── updateByIdAndUser — IDOR ─────────────────────────────────────────────────

describe("UserGameStatsModel.updateByIdAndUser — IDOR check", () => {
  it("WHERE include sempre user_id (no leakage di stats altrui)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never);
    await UserGameStatsModel.updateByIdAndUser(STAT_ID, 42, { total_playtime: 100 });
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toMatch(/WHERE id = \$\d+ AND user_id = \$\d+/);
    expect(params).toEqual([100, STAT_ID, 42]);
  });

  it("ritorna null quando id appartiene ad altro utente (rowCount=0)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const result = await UserGameStatsModel.updateByIdAndUser(
      STAT_ID, 999, { current_level: 50 },
    );
    expect(result).toBeNull();
  });

  it("ritorna null quando id non esiste affatto", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const result = await UserGameStatsModel.updateByIdAndUser(
      STAT_ID, 42, { bosses_felled: 5 },
    );
    expect(result).toBeNull();
  });

  it("aggiorna solo i campi forniti (no overwrite a default)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never);
    await UserGameStatsModel.updateByIdAndUser(STAT_ID, 42, {
      total_playtime: 50, bosses_felled: 3,
    });
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("total_playtime = $1");
    expect(sql).toContain("bosses_felled = $2");
    expect(sql).not.toMatch(/current_level\s*=\s*\$/);
    expect(sql).not.toMatch(/quests_completed\s*=\s*\$/);
  });

  it("payload vuoto → SELECT current row CON user_id check (no UPDATE)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never);
    await UserGameStatsModel.updateByIdAndUser(STAT_ID, 42, {});
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("SELECT");
    expect(sql).not.toContain("UPDATE");
    expect(sql).toContain("WHERE id = $1 AND user_id = $2");
    expect(params).toEqual([STAT_ID, 42]);
  });

  it("permette di aggiornare game_name (cache denormalizzata)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never);
    await UserGameStatsModel.updateByIdAndUser(STAT_ID, 42, {
      game_name: "Elden Ring (Updated Display)",
    });
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("game_name = $1");
    expect(params![0]).toBe("Elden Ring (Updated Display)");
  });

  it("propaga errori del DB", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB error"));
    await expect(
      UserGameStatsModel.updateByIdAndUser(STAT_ID, 42, { total_playtime: 1 }),
    ).rejects.toThrow("DB error");
  });
});
