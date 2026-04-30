import { describe, it, expect, vi, beforeEach } from "vitest";
import { UsersModel, type UserRow } from "./users.model.js";

vi.mock("@/config/database.js", () => ({ query: vi.fn() }));
vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { query } from "@/config/database.js";
const mockQuery = vi.mocked(query);

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 1,
    email: "test@example.com",
    password_hash: "hash",
    display_name: "Original Name",
    tier: "free",
    language: "it",
    total_queries: 0,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    avatar_url: null,
    beta_access: false,
    beta_access_granted_at: null,
    created_at: new Date(),
    last_active: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("UsersModel.updateProfile", () => {
  it("aggiorna solo display_name quando passato senza language", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeUser({ display_name: "New Name" })],
      rowCount: 1,
    } as never);

    const result = await UsersModel.updateProfile(42, { display_name: "New Name" });

    expect(result?.display_name).toBe("New Name");
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("display_name = $1");
    expect(sql).not.toContain("language = ");
    expect(params).toEqual(["New Name", 42]);
  });

  it("aggiorna solo language quando passato senza display_name", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeUser({ language: "en" })],
      rowCount: 1,
    } as never);

    await UsersModel.updateProfile(42, { language: "en" });

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("language = $1");
    expect(sql).not.toContain("display_name = ");
    expect(params).toEqual(["en", 42]);
  });

  it("aggiorna entrambi i campi quando entrambi passati (placeholder ordinati)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeUser({ display_name: "X", language: "fr" })],
      rowCount: 1,
    } as never);

    await UsersModel.updateProfile(42, { display_name: "X", language: "fr" });

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("display_name = $1");
    expect(sql).toContain("language = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(params).toEqual(["X", "fr", 42]);
  });

  it("permette display_name=null (rimuove il nome visualizzato)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeUser({ display_name: null })],
      rowCount: 1,
    } as never);

    await UsersModel.updateProfile(42, { display_name: null });

    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[0]).toBeNull();
  });

  it("ritorna findById quando il payload è vuoto (idempotente, no UPDATE)", async () => {
    // findById viene chiamato dal short-circuit
    mockQuery.mockResolvedValueOnce({ rows: [makeUser()], rowCount: 1 } as never);

    const result = await UsersModel.updateProfile(42, {});

    expect(result?.id).toBe(1);
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("SELECT");
    expect(sql).not.toContain("UPDATE");
  });

  it("ritorna null quando l'utente non esiste", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const result = await UsersModel.updateProfile(999, { language: "en" });
    expect(result).toBeNull();
  });

  it("propaga errori del DB", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection failed"));
    await expect(
      UsersModel.updateProfile(1, { language: "en" }),
    ).rejects.toThrow("connection failed");
  });

  it("non sovrascrive language quando solo display_name è passato (no full-row UPDATE)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeUser({ display_name: "A" })],
      rowCount: 1,
    } as never);

    await UsersModel.updateProfile(1, { display_name: "A" });

    const [sql] = mockQuery.mock.calls[0]!;
    // CRITICAL: senza questo controllo, un PATCH parziale resetterebbe language al valore default.
    // Match l'assignment letterale, non la parola "language" che appare nel commento SQL.
    expect(sql).not.toMatch(/language\s*=\s*\$/);
  });
});
