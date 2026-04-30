import { describe, it, expect, vi, beforeEach } from "vitest";

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

import {
  getConversation,
  appendTurn,
  clearConversation,
  __memory,
  type ConvTurn,
} from "./conversation.memory.js";
import { redis } from "@/config/redis.js";

const mockRedis = vi.mocked(redis);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeTurn(overrides: Partial<ConvTurn> = {}): ConvTurn {
  return {
    role: "user",
    text: "test",
    gameId: 1,
    ts: 1_000_000,
    ...overrides,
  };
}

// ── getConversation ─────────────────────────────────────────────────────

describe("getConversation", () => {
  it("ritorna previousTurns=[] e resetSuggested=false quando Redis vuoto", async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    const result = await getConversation("user:42", null);
    expect(result.previousTurns).toEqual([]);
    expect(result.resetSuggested).toBe(false);
  });

  it("ritorna empty su identifier vuoto (no Redis call)", async () => {
    const result = await getConversation("", null);
    expect(result.previousTurns).toEqual([]);
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it("deserializza i turn da JSON", async () => {
    const turns = [
      makeTurn({ role: "user", text: "ciao" }),
      makeTurn({ role: "assistant", text: "salve" }),
    ];
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(turns));
    const result = await getConversation("user:42", null);
    expect(result.previousTurns).toHaveLength(2);
    expect(result.previousTurns[0]!.text).toBe("ciao");
  });

  it("rileva cross-game contamination: gameId diverso → resetSuggested=true", async () => {
    const turns = [makeTurn({ gameId: 1 })];
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(turns));
    const result = await getConversation("user:42", 2); // game corrente diverso
    expect(result.resetSuggested).toBe(true);
  });

  it("NON suggerisce reset se gameId corrente è null (utente generico)", async () => {
    const turns = [makeTurn({ gameId: 1 })];
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(turns));
    const result = await getConversation("user:42", null);
    expect(result.resetSuggested).toBe(false);
  });

  it("NON suggerisce reset se ultimo turn ha gameId=null (no contamination definibile)", async () => {
    const turns = [makeTurn({ gameId: null })];
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(turns));
    const result = await getConversation("user:42", 1);
    expect(result.resetSuggested).toBe(false);
  });

  it("trim a MAX_TURNS (5) anche se Redis ha più turn salvati", async () => {
    const turns = Array.from({ length: 8 }, (_, i) => makeTurn({ ts: i }));
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(turns));
    const result = await getConversation("user:42", null);
    expect(result.previousTurns).toHaveLength(__memory.MAX_TURNS);
    // Devono essere gli ULTIMI 5 (FIFO eviction)
    expect(result.previousTurns[0]!.ts).toBe(3);
    expect(result.previousTurns[4]!.ts).toBe(7);
  });

  it("fail-open: errore Redis → previousTurns=[]", async () => {
    mockRedis.get.mockRejectedValueOnce(new Error("redis down"));
    const result = await getConversation("user:42", null);
    expect(result.previousTurns).toEqual([]);
    expect(result.resetSuggested).toBe(false);
  });

  it("JSON malformato → empty (no throw)", async () => {
    mockRedis.get.mockResolvedValueOnce("not-json");
    const result = await getConversation("user:42", null);
    expect(result.previousTurns).toEqual([]);
  });

  it("array non-array nel JSON → empty", async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ rogue: true }));
    const result = await getConversation("user:42", null);
    expect(result.previousTurns).toEqual([]);
  });
});

// ── appendTurn ──────────────────────────────────────────────────────────

describe("appendTurn", () => {
  it("setex Redis con TTL 1h", async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockRedis.setex.mockResolvedValueOnce("OK");
    await appendTurn("user:42", "user", "ciao", 1);
    const args = mockRedis.setex.mock.calls[0]!;
    expect(args[0]).toBe("conv:user:42");
    expect(args[1]).toBe(__memory.TTL_SECONDS);
  });

  it("appendi al payload esistente (preserva ordine)", async () => {
    const existing = [makeTurn({ text: "primo" })];
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(existing));
    mockRedis.setex.mockResolvedValueOnce("OK");
    await appendTurn("user:42", "assistant", "secondo", 1);
    const stored = JSON.parse(mockRedis.setex.mock.calls[0]![2] as string) as ConvTurn[];
    expect(stored).toHaveLength(2);
    expect(stored[1]!.text).toBe("secondo");
  });

  it("trim a MAX_MESSAGE_CHARS aggiungendo ellipsis se troppo lungo", async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockRedis.setex.mockResolvedValueOnce("OK");
    const long = "x".repeat(__memory.MAX_MESSAGE_CHARS + 100);
    await appendTurn("user:42", "user", long, null);
    const stored = JSON.parse(mockRedis.setex.mock.calls[0]![2] as string) as ConvTurn[];
    expect(stored[0]!.text.length).toBeLessThanOrEqual(__memory.MAX_MESSAGE_CHARS + 1);
    expect(stored[0]!.text).toContain("…");
  });

  it("noop su identifier vuoto", async () => {
    await appendTurn("", "user", "ciao", null);
    expect(mockRedis.setex).not.toHaveBeenCalled();
  });

  it("noop su text vuoto/whitespace", async () => {
    await appendTurn("user:42", "user", "   ", null);
    expect(mockRedis.setex).not.toHaveBeenCalled();
  });

  it("fail-open: errore Redis → log warn no throw", async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockRedis.setex.mockRejectedValueOnce(new Error("redis down"));
    await expect(appendTurn("user:42", "user", "ciao", null)).resolves.toBeUndefined();
  });
});

// ── clearConversation ───────────────────────────────────────────────────

describe("clearConversation", () => {
  it("chiama redis.del con la chiave corretta", async () => {
    mockRedis.del.mockResolvedValueOnce(1);
    await clearConversation("user:42");
    expect(mockRedis.del).toHaveBeenCalledWith("conv:user:42");
  });

  it("noop su identifier vuoto", async () => {
    await clearConversation("");
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it("fail-open: errore Redis → log warn no throw", async () => {
    mockRedis.del.mockRejectedValueOnce(new Error("redis down"));
    await expect(clearConversation("user:42")).resolves.toBeUndefined();
  });
});
