import { describe, it, expect } from "vitest";
import {
  reciprocalRankFusion,
  classifyMatch,
  assembleContext,
  type RagResult,
} from "@/services/rag.service.js";

// Builder minimi per mantenere i test leggibili. Usiamo cast leggero al tipo interno
// perché reciprocalRankFusion accetta solo i campi effettivamente usati dalla funzione.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const v = (guide_id: number, vector_score: number): any => ({
  guide_id,
  chunk_text: `chunk-${guide_id}`,
  chunk_index: 0,
  title: `Guide ${guide_id}`,
  slug: `guide-${guide_id}`,
  language: "it",
  quality_score: 80,
  verified: true,
  guide_type: "trophy",
  vector_score,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const f = (guide_id: number, fts_score: number): any => ({
  guide_id,
  title: `Guide ${guide_id}`,
  slug: `guide-${guide_id}`,
  content: `content of guide ${guide_id}`,
  language: "it",
  quality_score: 80,
  verified: true,
  guide_type: "trophy",
  fts_score,
});

describe("reciprocalRankFusion", () => {
  it("combina correttamente due ranking disgiunti (k=60)", () => {
    const vec = [v(1, 0.9), v(2, 0.8), v(3, 0.7)];
    const fts = [f(4, 0.5), f(2, 0.4), f(5, 0.3)];
    const fused = reciprocalRankFusion(vec, fts);

    // guide 1: solo vector rank 1 → 1/(60+1) = 0.01639...
    // guide 2: vector rank 2 + fts rank 2 → 1/62 + 1/62 = 0.03226...
    // guide 3: solo vector rank 3 → 1/63
    // guide 4: solo fts rank 1 → 1/61
    // guide 5: solo fts rank 3 → 1/63
    expect(fused.get(2)!.rrfScore).toBeCloseTo(1 / 62 + 1 / 62, 6);
    expect(fused.get(1)!.rrfScore).toBeCloseTo(1 / 61, 6);
    expect(fused.get(4)!.rrfScore).toBeCloseTo(1 / 61, 6);

    // guide 2 ha il miglior RRF perché è l'unico presente in entrambi i ranking.
    const sorted = [...fused.entries()].sort((a, b) => b[1].rrfScore - a[1].rrfScore);
    expect(sorted[0]![0]).toBe(2);
  });

  it("preserva lo score originale max per guideId presente in entrambi i ranking", () => {
    const vec = [v(1, 0.95)];
    const fts = [f(1, 0.42)];
    const fused = reciprocalRankFusion(vec, fts);
    const hit = fused.get(1)!;
    expect(hit.vectorScore).toBe(0.95);
    expect(hit.ftsScore).toBe(0.42);
    expect(hit.rrfScore).toBeCloseTo(1 / 61 + 1 / 61, 6);
  });

  it("dedup vector ranking: chunk multipli dello stesso guide → conta solo rank minimo", () => {
    // Guide 1 ha 3 chunk nel vector ranking ai rank 1, 2, 3. Conta solo rank=1.
    const vec = [v(1, 0.9), v(1, 0.85), v(1, 0.8), v(2, 0.7)];
    const fts: ReturnType<typeof f>[] = [];
    const fused = reciprocalRankFusion(vec, fts);
    expect(fused.get(1)!.rrfScore).toBeCloseTo(1 / 61, 6); // solo rank=1
    expect(fused.get(2)!.rrfScore).toBeCloseTo(1 / 62, 6); // rank=2 (era idx 3, ma guide 1 duplicati NON consumano rank)
  });

  it("ranking vuoti → mappa vuota", () => {
    expect(reciprocalRankFusion([], []).size).toBe(0);
  });

  it("k custom cambia la distribuzione degli score", () => {
    const vec = [v(1, 0.9), v(2, 0.8)];
    const fusedStd = reciprocalRankFusion(vec, [], 60);
    const fusedLowK = reciprocalRankFusion(vec, [], 10);
    // Con k minore lo score top e secondo sono più distanti (il primo pesa di più).
    const diffStd = fusedStd.get(1)!.rrfScore - fusedStd.get(2)!.rrfScore;
    const diffLowK = fusedLowK.get(1)!.rrfScore - fusedLowK.get(2)!.rrfScore;
    expect(diffLowK).toBeGreaterThan(diffStd);
  });
});

describe("classifyMatch", () => {
  const HIGH = 0.85;
  const LOW = 0.6;

  it("score > threshold_high → exact", () => {
    expect(classifyMatch(0.9, HIGH, LOW)).toBe("exact");
    expect(classifyMatch(0.851, HIGH, LOW)).toBe("exact");
  });

  it("low ≤ score ≤ threshold_high → partial", () => {
    expect(classifyMatch(0.75, HIGH, LOW)).toBe("partial");
    expect(classifyMatch(0.6, HIGH, LOW)).toBe("partial");
    expect(classifyMatch(0.85, HIGH, LOW)).toBe("partial"); // bordo alto incluso in partial
  });

  it("score < threshold_low → none", () => {
    expect(classifyMatch(0.5, HIGH, LOW)).toBe("none");
    expect(classifyMatch(0, HIGH, LOW)).toBe("none");
  });

  it("undefined (nessun risultato) → none", () => {
    expect(classifyMatch(undefined, HIGH, LOW)).toBe("none");
  });
});

describe("assembleContext", () => {
  const buildResult = (
    i: number,
    overrides: Partial<RagResult> = {},
  ): RagResult => ({
    guideId: i,
    title: `Titolo ${i}`,
    slug: `slug-${i}`,
    chunkText: `Testo del chunk ${i}. Contenuto utile.`,
    language: "it",
    qualityScore: 80,
    verified: true,
    guideType: "trophy",
    vectorScore: 0.8,
    ftsScore: 0.3,
    rrfScore: 1 / (60 + i),
    matchType: "partial",
    ...overrides,
  });

  it("concatena i blocchi in ordine di input con header e separatore ---", () => {
    const results = [buildResult(1), buildResult(2)];
    const ctx = assembleContext(results);
    expect(ctx).toContain("--- FONTE 1: Titolo 1 ");
    expect(ctx).toContain("--- FONTE 2: Titolo 2 ");
    expect(ctx.indexOf("FONTE 1")).toBeLessThan(ctx.indexOf("FONTE 2"));
  });

  it("fa fallback a content quando chunkText è assente", () => {
    const results = [
      buildResult(1, { chunkText: undefined, content: "contenuto full della guida" }),
    ];
    const ctx = assembleContext(results);
    expect(ctx).toContain("contenuto full della guida");
  });

  it("tronca al budget maxTokens (4 char/token)", () => {
    const longBody = "x".repeat(5000);
    const results = [
      buildResult(1, { chunkText: longBody }),
      buildResult(2, { chunkText: longBody }),
      buildResult(3, { chunkText: longBody }),
    ];
    // maxTokens=1000 → maxChars=4000. Solo parte del primo blocco entra.
    const ctx = assembleContext(results, 1000);
    expect(ctx.length).toBeLessThanOrEqual(4000);
    expect(ctx).toContain("FONTE 1");
    expect(ctx).not.toContain("FONTE 2");
  });

  it("include lo score RRF nell'header con 4 decimali", () => {
    const results = [buildResult(1, { rrfScore: 0.03278688 })];
    const ctx = assembleContext(results);
    expect(ctx).toContain("score: 0.0328");
  });

  it("salta blocchi con body vuoto", () => {
    const results = [
      buildResult(1, { chunkText: "", content: "" }),
      buildResult(2, { chunkText: "valido" }),
    ];
    const ctx = assembleContext(results);
    expect(ctx).not.toContain("FONTE 1");
    expect(ctx).toContain("FONTE 2");
  });

  it("input vuoto → stringa vuota", () => {
    expect(assembleContext([])).toBe("");
  });
});
