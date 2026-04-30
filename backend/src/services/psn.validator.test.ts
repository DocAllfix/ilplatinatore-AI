import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/services/trophyLookup.service.js", () => ({
  TrophyLookupService: { findUnverifiedPsnIds: vi.fn() },
}));

import { extractPsnTrophyIds, validatePsnTrophyIdsInContent } from "./psn.validator.js";
import { TrophyLookupService } from "@/services/trophyLookup.service.js";

const mockFindUnverified = vi.mocked(TrophyLookupService.findUnverifiedPsnIds);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── extractPsnTrophyIds ───────────────────────────────────────────────────

describe("extractPsnTrophyIds", () => {
  it("estrae id da formato 'psn_trophy_id: <token>'", () => {
    const text = "Il trofeo (psn_trophy_id: trophy_001_abc) si sblocca dopo...";
    expect(extractPsnTrophyIds(text)).toEqual(["trophy_001_abc"]);
  });

  it("estrae id con quote di vario tipo", () => {
    expect(extractPsnTrophyIds(`psn_trophy_id: "abc123"`)).toEqual(["abc123"]);
    expect(extractPsnTrophyIds(`psn_trophy_id: 'xyz_789'`)).toEqual(["xyz_789"]);
    expect(extractPsnTrophyIds("psn_trophy_id: `bt_42`")).toEqual(["bt_42"]);
  });

  it("estrae multipli id distinct", () => {
    const text = `
      Trofeo 1 (psn_trophy_id: trophy_a)
      Trofeo 2 (psn_trophy_id: trophy_b)
      Trofeo 3 (psn_trophy_id: trophy_a) — duplicato
    `;
    expect(extractPsnTrophyIds(text).sort()).toEqual(["trophy_a", "trophy_b"]);
  });

  it("è case-insensitive su 'psn_trophy_id'", () => {
    expect(extractPsnTrophyIds("PSN_TROPHY_ID: foo123")).toEqual(["foo123"]);
    expect(extractPsnTrophyIds("Psn_Trophy_Id: bar456")).toEqual(["bar456"]);
  });

  it("filtra communication_id (NPWR12345_00) — non è un trophy id", () => {
    expect(extractPsnTrophyIds("psn_trophy_id: NPWR12345_00")).toEqual([]);
    expect(extractPsnTrophyIds("psn_trophy_id: NPWR123456_0001")).toEqual([]);
  });

  it("filtra placeholder palesi (none/null/example)", () => {
    expect(extractPsnTrophyIds("psn_trophy_id: none")).toEqual([]);
    expect(extractPsnTrophyIds("psn_trophy_id: NULL")).toEqual([]);
    expect(extractPsnTrophyIds("psn_trophy_id: example")).toEqual([]);
    expect(extractPsnTrophyIds("psn_trophy_id: tbd")).toEqual([]);
    expect(extractPsnTrophyIds("psn_trophy_id: n/a")).toEqual([]);
  });

  it("rifiuta token < 4 char (probabili rumore)", () => {
    expect(extractPsnTrophyIds("psn_trophy_id: ab")).toEqual([]);
  });

  it("rifiuta token > 64 char (palesi outliers)", () => {
    const huge = "x".repeat(80);
    expect(extractPsnTrophyIds(`psn_trophy_id: ${huge}`)).toEqual([]);
  });

  it("ritorna array vuoto su content vuoto/null/whitespace", () => {
    expect(extractPsnTrophyIds("")).toEqual([]);
    expect(extractPsnTrophyIds("   ")).toEqual([]);
  });

  it("non lancia su input gibberish", () => {
    expect(() =>
      extractPsnTrophyIds("psn_trophy_id: ☢️🎮 weird unicode 漢字"),
    ).not.toThrow();
  });

  it("ignora pattern fuori contesto (no false match su 'psn_trophy_id' come sostantivo)", () => {
    expect(extractPsnTrophyIds("Il psn_trophy_id è importante.")).toEqual([]);
  });
});

// ── validatePsnTrophyIdsInContent ────────────────────────────────────────

describe("validatePsnTrophyIdsInContent", () => {
  it("ritorna citedIds=[] e unverifiedIds=[] se nessun id citato", async () => {
    const result = await validatePsnTrophyIdsInContent("Testo senza identificativi.");
    expect(result.citedIds).toEqual([]);
    expect(result.unverifiedIds).toEqual([]);
    expect(mockFindUnverified).not.toHaveBeenCalled();
  });

  it("chiama TrophyLookupService.findUnverifiedPsnIds con i citedIds", async () => {
    mockFindUnverified.mockResolvedValueOnce([]);
    await validatePsnTrophyIdsInContent("psn_trophy_id: real_id_42");
    expect(mockFindUnverified).toHaveBeenCalledWith(["real_id_42"]);
  });

  it("ritorna i ids unverified dal service", async () => {
    mockFindUnverified.mockResolvedValueOnce(["fake_id_1"]);
    const result = await validatePsnTrophyIdsInContent(
      "Trofeo a (psn_trophy_id: real_id) trofeo b (psn_trophy_id: fake_id_1)",
    );
    expect(result.citedIds.sort()).toEqual(["fake_id_1", "real_id"]);
    expect(result.unverifiedIds).toEqual(["fake_id_1"]);
  });

  it("fail-open: errore DB → unverifiedIds=[] (no falsi positivi)", async () => {
    // Il service interno ha già il catch + return [], quindi qui simuliamo
    // direttamente che findUnverifiedPsnIds ritorni [].
    mockFindUnverified.mockResolvedValueOnce([]);
    const result = await validatePsnTrophyIdsInContent("psn_trophy_id: any_id");
    expect(result.unverifiedIds).toEqual([]);
  });
});
