import { describe, it, expect } from "vitest";
import { EmbeddingService } from "./embedding.service.js";

describe("EmbeddingService.chunkText", () => {
  it("ritorna array vuoto per testo vuoto o solo whitespace", () => {
    expect(EmbeddingService.chunkText("", 600, 100)).toEqual([]);
    expect(EmbeddingService.chunkText("   \n  \t  ", 600, 100)).toEqual([]);
  });

  it("ritorna un solo chunk per testo corto", () => {
    const text = "Questa è una frase breve. E questa è un'altra.";
    const chunks = EmbeddingService.chunkText(text, 600, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("rispetta il limite di caratteri del chunk (tokens*4 con tolleranza per overlap)", () => {
    // maxTokens=10 → maxChars=40. Testo molto più lungo.
    const sentences = Array.from({ length: 30 }, (_, i) => `Frase numero ${i}.`).join(" ");
    const chunks = EmbeddingService.chunkText(sentences, 10, 2);
    expect(chunks.length).toBeGreaterThan(1);
    // Tolleranza 2x per overlap + ultima frase completa.
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80);
    }
  });

  it("non taglia in mezzo a una frase (ogni chunk non-finale termina con . ! ?)", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Frase numero ${i}.`).join(" ");
    const chunks = EmbeddingService.chunkText(sentences, 15, 3);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]).toMatch(/[.!?]$/);
    }
  });

  it("applica overlap fra chunk consecutivi (almeno una parola in comune)", () => {
    const sentences = Array.from(
      { length: 15 },
      (_, i) => `Frase lunga numero ${i} con contenuto significativo leggibile.`,
    ).join(" ");
    const chunks = EmbeddingService.chunkText(sentences, 20, 5);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Coda del chunk N e testa del chunk N+1 devono condividere almeno una parola ≥3 char.
    const endOfFirst = chunks[0]!.slice(-30);
    const startOfSecond = chunks[1]!.slice(0, 40);
    const wordsInEnd = endOfFirst
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
      .filter((w) => w.length >= 3);
    const hasOverlap = wordsInEnd.some((w) => startOfSecond.includes(w));
    expect(hasOverlap).toBe(true);
  });

  it("spezza a forza una frase singola più lunga di maxChars", () => {
    // 'a' ripetuto 10_000 volte è una "frase" senza separatori, non divisibile in modo naturale.
    const monstrous = "a".repeat(10_000);
    const chunks = EmbeddingService.chunkText(monstrous, 100, 10); // maxChars=400
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(400);
    }
    // La concatenazione ricostruisce il testo originale.
    expect(chunks.join("")).toBe(monstrous);
  });
});
