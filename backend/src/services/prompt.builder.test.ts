import { describe, it, expect } from "vitest";
import { buildPrompt, type PromptContext, type GuideType } from "@/services/prompt.builder.js";

const baseCtx: PromptContext = {
  ragContext: "--- FONTE 1: PowerPyx Guide (score: 0.92) ---\nStep 1: parla con NPC. Step 2: uccidi boss.",
  gameTitle: "Elden Ring",
  targetName: "Signore di Elden",
  guideType: "trophy",
  language: "it",
  userQuery: "come ottengo il trofeo signore di elden?",
};

describe("buildPrompt — dispatcher guide_type", () => {
  const allTypes: GuideType[] = ["trophy", "walkthrough", "collectible", "challenge", "platinum"];

  it.each(allTypes)("ritorna templateId=%s per guide_type='%s'", (type) => {
    const result = buildPrompt({ ...baseCtx, guideType: type });
    expect(result.templateId).toBe(type);
    expect(result.system.length).toBeGreaterThan(0);
    expect(result.user.length).toBeGreaterThan(0);
  });

  it("include il gameTitle e targetName nel system prompt", () => {
    const r = buildPrompt({ ...baseCtx, gameTitle: "Bloodborne", targetName: "Caccia concluso" });
    expect(r.system).toContain("Bloodborne");
    expect(r.system).toContain("Caccia concluso");
  });

  it("propaga la lingua richiesta nel system prompt", () => {
    const r = buildPrompt({ ...baseCtx, language: "en" });
    expect(r.system).toContain("Rispondi in lingua: en");
  });

  it("lancia per guide_type non supportato (5 fissi da migration 004)", () => {
    expect(() =>
      buildPrompt({ ...baseCtx, guideType: "boss" as GuideType }),
    ).toThrow(/non supportato/);
  });

  it("usa ragContext se presente (sorgente verificata)", () => {
    const r = buildPrompt(baseCtx);
    expect(r.user).toContain("fonti verificate");
    expect(r.user).toContain("PowerPyx Guide");
  });

  it("cade su scrapingContext se ragContext è vuoto (fallback live)", () => {
    const r = buildPrompt({
      ...baseCtx,
      ragContext: "",
      scrapingContext: "=== FONTE: powerpyx.com (affidabilità: 0.95) ===\nDati scraping live.",
    });
    expect(r.user).toContain("scraping live");
    expect(r.user).toContain("powerpyx.com");
  });

  it("mostra 'CONTESTO: (vuoto ...)' quando nessuna fonte disponibile", () => {
    const r = buildPrompt({ ...baseCtx, ragContext: "", scrapingContext: "" });
    expect(r.user).toContain("CONTESTO: (vuoto");
  });

  it("include PSN anchor SOLO per guide_type='trophy' con metadati validi", () => {
    const r = buildPrompt({
      ...baseCtx,
      psnAnchor: {
        psn_trophy_id: "abc123",
        psn_communication_id: "NPWR00000_00",
        rarity_source: "ultra_rare",
      },
    });
    expect(r.system).toContain("psn_trophy_id: abc123");
    expect(r.system).toContain("psn_communication_id: NPWR00000_00");
    expect(r.system).toContain("ultra_rare");
  });

  it("non aggiunge sezione PSN se l'anchor ha tutti i campi null", () => {
    const r = buildPrompt({
      ...baseCtx,
      psnAnchor: {
        psn_trophy_id: null,
        psn_communication_id: null,
        rarity_source: null,
      },
    });
    expect(r.system).not.toContain("IDENTIFICATIVI PSN");
  });

  it("include NOME UFFICIALE + DESCRIZIONE UFFICIALE (Fase 16.1) quando psnOfficial presente", () => {
    const r = buildPrompt({
      ...baseCtx,
      psnOfficial: {
        officialName: "Lord of Elden",
        officialDetail: "Raise yourself to become Lord of Elden.",
      },
    });
    expect(r.user).toContain("NOME UFFICIALE TROFEO (Sony): Lord of Elden");
    expect(r.user).toContain("DESCRIZIONE UFFICIALE: Raise yourself to become Lord of Elden.");
  });

  it("il blocco NOME UFFICIALE precede il CONTESTO nel user prompt", () => {
    const r = buildPrompt({
      ...baseCtx,
      psnOfficial: { officialName: "Lord of Elden", officialDetail: "desc" },
    });
    const idxOfficial = r.user.indexOf("NOME UFFICIALE");
    const idxContext = r.user.indexOf("CONTESTO");
    expect(idxOfficial).toBeGreaterThanOrEqual(0);
    expect(idxContext).toBeGreaterThanOrEqual(0);
    expect(idxOfficial).toBeLessThan(idxContext);
  });

  it("omette DESCRIZIONE UFFICIALE se detail è null (name_en sempre presente, detail_en no)", () => {
    const r = buildPrompt({
      ...baseCtx,
      psnOfficial: { officialName: "Lord of Elden", officialDetail: null },
    });
    expect(r.user).toContain("NOME UFFICIALE TROFEO (Sony): Lord of Elden");
    expect(r.user).not.toContain("DESCRIZIONE UFFICIALE");
  });

  it("non aggiunge il blocco NOME UFFICIALE se psnOfficial undefined", () => {
    const r = buildPrompt(baseCtx);
    expect(r.user).not.toContain("NOME UFFICIALE TROFEO");
    expect(r.user).not.toContain("DESCRIZIONE UFFICIALE");
  });

  it("user prompt preserva la DOMANDA UTENTE originale", () => {
    const r = buildPrompt({ ...baseCtx, userQuery: "come faccio il plat?" });
    expect(r.user).toContain("DOMANDA UTENTE: come faccio il plat?");
  });

  it("platinum template include sezione 'Playthrough'", () => {
    const r = buildPrompt({ ...baseCtx, guideType: "platinum" });
    expect(r.system).toContain("Playthrough");
  });

  it("collectible template include 'Missable'", () => {
    const r = buildPrompt({ ...baseCtx, guideType: "collectible" });
    expect(r.system).toContain("Missable");
  });
});
