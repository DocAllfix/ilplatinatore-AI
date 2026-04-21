import { describe, it, expect } from "vitest";
import { detectLanguage } from "@/services/query.normalizer.js";

// NOTA: extractGame/extractTrophy richiedono DB + servizi — coperti da test
// integrazione in Fase 20+. Qui testiamo solo le funzioni pure/euristiche.

describe("detectLanguage", () => {
  it("riconosce italiano da marker tipici", () => {
    expect(detectLanguage("come ottengo il trofeo platino")).toBe("it");
    expect(detectLanguage("dove trovo la spada nella guida")).toBe("it");
  });

  it("riconosce inglese da marker tipici", () => {
    expect(detectLanguage("how do i get the trophy")).toBe("en");
    expect(detectLanguage("where to find the weapon")).toBe("en");
  });

  it("default prudente 'en' quando nessun marker hit", () => {
    expect(detectLanguage("elden ring")).toBe("en");
    expect(detectLanguage("XZY123")).toBe("en");
  });

  it("preferisce IT quando itHits == enHits (equità: scegliamo IT)", () => {
    // "come the" → come(IT) + the(EN) = pareggio → IT per tie-break
    expect(detectLanguage("come the")).toBe("it");
  });

  it("case-insensitive", () => {
    expect(detectLanguage("COME OTTENGO IL TROFEO")).toBe("it");
    expect(detectLanguage("HOW TO GET THE TROPHY")).toBe("en");
  });

  it("ignora punteggiatura e numeri", () => {
    expect(detectLanguage("come??? trofeo!!! 123 platinatore")).toBe("it");
  });
});
