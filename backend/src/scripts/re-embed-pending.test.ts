import { describe, it, expect, vi, beforeEach } from "vitest";
import { enqueuePendingGuides } from "./re-embed-pending.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/config/database.js", () => ({
  query: vi.fn(),
  pool: { end: vi.fn() },
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/queues/embedding.queue.js", () => ({
  embeddingQueue: { add: vi.fn(), close: vi.fn() },
  bullmqConnection: { quit: vi.fn() },
}));

import { query } from "@/config/database.js";
import { embeddingQueue } from "@/queues/embedding.queue.js";

const mockedQuery = vi.mocked(query);
const mockedQueue = vi.mocked(embeddingQueue);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("enqueuePendingGuides — happy path", () => {
  it("accoda tutte le guide pending e ritorna stats corrette", async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockedQueue.add.mockResolvedValue(undefined as never);

    const stats = await enqueuePendingGuides(100);

    expect(stats.found).toBe(2);
    expect(stats.enqueued).toBe(2);
    expect(stats.skipped).toBe(0);
    expect(stats.failed).toBe(0);
    expect(mockedQueue.add).toHaveBeenCalledTimes(2);
  });

  it("usa jobId stabile embed-{id} e priority=10 (batch)", async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockedQueue.add.mockResolvedValue(undefined as never);

    await enqueuePendingGuides();

    const call = mockedQueue.add.mock.calls[0]!;
    expect(call[0]).toBe("embed");
    expect(call[1]).toEqual({ guideId: 7 });
    expect(call[2]).toMatchObject({ jobId: "embed-7", priority: 10 });
  });

  it("ritorna stats zeroed quando non ci sono guide pending", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const stats = await enqueuePendingGuides();

    expect(stats.found).toBe(0);
    expect(stats.enqueued).toBe(0);
    expect(mockedQueue.add).not.toHaveBeenCalled();
  });
});

describe("enqueuePendingGuides — paginazione cursor", () => {
  it("avanza il cursor lastId tra le pagine", async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 20 }], rowCount: 2 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 30 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockedQueue.add.mockResolvedValue(undefined as never);

    await enqueuePendingGuides(2);

    // Prima query: lastId=0
    expect((mockedQuery.mock.calls[0]![1] as number[])[0]).toBe(0);
    // Seconda query: lastId=20 (ultimo id della prima pagina)
    expect((mockedQuery.mock.calls[1]![1] as number[])[0]).toBe(20);
    // Terza query: lastId=30
    expect((mockedQuery.mock.calls[2]![1] as number[])[0]).toBe(30);
  });

  it("total found accumula correttamente tra più pagine", async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockedQueue.add.mockResolvedValue(undefined as never);

    const stats = await enqueuePendingGuides(2);

    expect(stats.found).toBe(3);
    expect(stats.enqueued).toBe(3);
  });
});

describe("enqueuePendingGuides — gestione errori", () => {
  it("conta skipped su errore duplicate job", async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockedQueue.add.mockRejectedValueOnce(new Error("duplicate job already exists"));

    const stats = await enqueuePendingGuides();

    expect(stats.skipped).toBe(1);
    expect(stats.enqueued).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it("conta failed su errore Redis generico e continua", async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockedQueue.add
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(undefined as never);

    const stats = await enqueuePendingGuides();

    expect(stats.failed).toBe(1);
    expect(stats.enqueued).toBe(1);
    expect(stats.found).toBe(2);
  });
});
