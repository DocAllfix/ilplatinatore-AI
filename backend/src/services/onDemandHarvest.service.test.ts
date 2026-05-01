import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks PRIMA dell'import del modulo testato.
vi.mock("@/config/database.js", () => ({
  query: vi.fn(),
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/config/env.js", () => ({
  env: {
    ON_DEMAND_HARVEST_ENABLED: true,
    ON_DEMAND_HARVEST_TIMEOUT_MS: 200, // short timeout per test rapidi
  },
}));

import { OnDemandHarvestService } from "./onDemandHarvest.service.js";
import { query } from "@/config/database.js";

const mockedQuery = vi.mocked(query);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── triggerHarvest ───────────────────────────────────────────────────────────

describe("OnDemandHarvestService.triggerHarvest", () => {
  it("inserisce pending e ritorna requestId", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 } as never);
    const id = await OnDemandHarvestService.triggerHarvest("how to platinum elden ring", 7, null);
    expect(id).toBe(42);
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const sql = mockedQuery.mock.calls[0]![0] as string;
    expect(sql).toMatch(/INSERT INTO on_demand_requests/);
    expect(mockedQuery.mock.calls[0]![1]).toEqual([7, "how to platinum elden ring", null]);
  });

  it("rifiuta query vuota", async () => {
    await expect(
      OnDemandHarvestService.triggerHarvest("   ", null, null),
    ).rejects.toThrow(/empty query/);
  });

  it("trim della query prima dell'insert", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 } as never);
    await OnDemandHarvestService.triggerHarvest("  malenia boss  ", null, null);
    expect(mockedQuery.mock.calls[0]![1]).toEqual([null, "malenia boss", null]);
  });
});

// ── pollRequest ──────────────────────────────────────────────────────────────

describe("OnDemandHarvestService.pollRequest", () => {
  it("ritorna immediato se status già completed", async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ status: "completed", guide_id: 99, error_message: null }],
      rowCount: 1,
    } as never);
    const result = await OnDemandHarvestService.pollRequest(1, 1000, 50);
    expect(result.status).toBe("completed");
    expect(result.guideId).toBe(99);
  });

  it("ritorna failed con errorMessage", async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ status: "failed", guide_id: null, error_message: "scrape failed" }],
      rowCount: 1,
    } as never);
    const result = await OnDemandHarvestService.pollRequest(1, 1000, 50);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("scrape failed");
    expect(result.guideId).toBeNull();
  });

  it("dopo timeout marca status='timeout' e ritorna timeout", async () => {
    // SELECT iniziale ritorna pending; poi loop polla altre volte; poi UPDATE.
    mockedQuery
      .mockResolvedValueOnce({
        rows: [{ status: "pending", guide_id: null, error_message: null }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ status: "processing", guide_id: null, error_message: null }],
        rowCount: 1,
      } as never)
      // UPDATE marker
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await OnDemandHarvestService.pollRequest(1, 100, 60);
    expect(result.status).toBe("timeout");
    // Verifica che UPDATE timeout sia stato chiamato
    const sqlCalls = mockedQuery.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls.some((s) => s.includes("status = 'timeout'"))).toBe(true);
  });

  it("throw se requestId non trovata", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(
      OnDemandHarvestService.pollRequest(999, 100, 50),
    ).rejects.toThrow(/non trovata/);
  });

  it("transitiona da pending a completed durante poll", async () => {
    mockedQuery
      .mockResolvedValueOnce({
        rows: [{ status: "pending", guide_id: null, error_message: null }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ status: "completed", guide_id: 77, error_message: null }],
        rowCount: 1,
      } as never);
    const result = await OnDemandHarvestService.pollRequest(1, 1000, 30);
    expect(result.status).toBe("completed");
    expect(result.guideId).toBe(77);
  });
});

// ── feature flag check ───────────────────────────────────────────────────────

describe("OnDemandHarvestService — feature flag enforcement", () => {
  it("triggerHarvest lancia errore se ON_DEMAND_HARVEST_ENABLED=false", async () => {
    vi.resetModules();
    vi.doMock("@/config/env.js", () => ({
      env: { ON_DEMAND_HARVEST_ENABLED: false, ON_DEMAND_HARVEST_TIMEOUT_MS: 200 },
    }));
    vi.doMock("@/config/database.js", () => ({
      query: vi.fn(),
    }));
    vi.doMock("@/utils/logger.js", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const { OnDemandHarvestService: scoped } = await import("./onDemandHarvest.service.js");
    await expect(
      scoped.triggerHarvest("query", null, null),
    ).rejects.toThrow(/ON_DEMAND_HARVEST_ENABLED is false/);
    vi.doUnmock("@/config/env.js");
    vi.doUnmock("@/config/database.js");
    vi.doUnmock("@/utils/logger.js");
  });
});
