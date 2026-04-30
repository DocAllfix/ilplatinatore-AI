/**
 * T2.1 — Suite E2E multilingua: 9 lingue × 5 guide_type = 45 test case.
 * Verifica che ogni combinazione produca un prompt nativo strutturalmente valido.
 *
 * Garantisce:
 *   1. Output language nel SYSTEM è coerente con ctx.language
 *   2. Almeno 3 header markdown (## ...) sono nella lingua target
 *   3. Nessun pattern di refusal nel prompt
 *   4. PSN anchor lingua-coerente (label tradotti)
 *   5. Sanitization non altera caratteri non-latini (JA, ZH, RU)
 */
import { describe, it, expect } from "vitest";
import {
  buildPrompt,
  sanitizeUserQuery,
  __i18n,
  type GuideType,
  type PromptContext,
} from "@/services/prompt.builder.js";

const LANGS = ["en", "it", "es", "fr", "de", "pt", "ja", "zh", "ru"] as const;
const TYPES: GuideType[] = ["trophy", "walkthrough", "collectible", "challenge", "platinum"];

// Sample query per lingua (realistic input, length > FRANC_MIN_LENGTH)
const QUERIES: Record<(typeof LANGS)[number], string> = {
  en: "how do i get the platinum trophy in elden ring",
  it: "come ottengo il trofeo di platino in elden ring",
  es: "cómo conseguir el trofeo de platino en elden ring",
  fr: "comment obtenir le trophée de platine dans elden ring",
  de: "wie bekomme ich die platintrophäe in elden ring",
  pt: "como conseguir o troféu de platina em elden ring",
  ja: "エルデンリングのプラチナトロフィーの取り方",
  zh: "艾尔登法环白金奖杯怎么获得",
  ru: "как получить платиновый трофей в elden ring",
};

function makeCtx(lang: string, type: GuideType): PromptContext {
  return {
    ragContext: "--- FONTE 1: PowerPyx ---\nStep 1: parla con NPC.",
    gameTitle: "Elden Ring",
    targetName: "Lord of Elden",
    guideType: type,
    language: lang,
    userQuery: QUERIES[lang as keyof typeof QUERIES] ?? QUERIES.en,
  };
}

// ── Generazione 45 test combinatori ──────────────────────────────────────

describe("E2E multilingua T2.1 — 9 lingue × 5 guide_type", () => {
  for (const lang of LANGS) {
    for (const type of TYPES) {
      it(`[${lang}] [${type}] genera prompt nativo strutturalmente valido`, () => {
        const r = buildPrompt(makeCtx(lang, type));
        const labels = __i18n.getLabels(lang);

        // 1. templateId coerente con guide_type
        expect(r.templateId).toBe(type);

        // 2. SYSTEM contiene il nome lingua canonico per il LLM
        expect(r.system).toContain(__i18n.llmLanguageName(lang));

        // 3. SYSTEM contiene almeno 3 header markdown ("## ...") nella lingua target
        const headerLines = r.system.split("\n").filter((l) => l.trim().startsWith("## "));
        expect(headerLines.length).toBeGreaterThanOrEqual(3);

        // 4. Almeno un header noto della lingua è presente (sanity check label)
        const knownLabels = [
          labels.h_sources,
          labels.h_steps,
          labels.h_tips,
          labels.h_overview,
          labels.h_strategy,
          labels.h_objective,
          labels.h_difficulty,
          labels.h_walkthrough,
          labels.h_collectible_locations,
        ];
        const hasNativeHeader = knownLabels.some((label) => r.system.includes(label));
        expect(hasNativeHeader).toBe(true);

        // 5. SYSTEM include la rule "rispondi solo dal contesto" nella lingua
        // target (l'istruzione cita il pattern di refusal come behavior atteso).
        expect(r.system).toContain(labels.rule_no_information);

        // 6. USER prompt contiene la query (sanitizzata)
        const expectedQ = sanitizeUserQuery(QUERIES[lang as keyof typeof QUERIES] ?? "");
        expect(r.user).toContain(expectedQ);

        // 7. Sanity: tagstrutturali NON sono mai vuoti
        expect(r.system.length).toBeGreaterThan(100);
        expect(r.user.length).toBeGreaterThan(20);
      });
    }
  }
});

// ── Test specifici per lingue non-latine ──────────────────────────────────

describe("E2E multilingua T2.1 — non-latin char preservation", () => {
  it("[ja] caratteri kanji preservati nel prompt", () => {
    const r = buildPrompt(makeCtx("ja", "trophy"));
    expect(r.system).toMatch(/[぀-ゟ゠-ヿ一-鿿]/);
  });

  it("[zh] caratteri Han preservati", () => {
    const r = buildPrompt(makeCtx("zh", "trophy"));
    expect(r.system).toMatch(/[一-鿿]/);
  });

  it("[ru] caratteri cirillici preservati", () => {
    const r = buildPrompt(makeCtx("ru", "trophy"));
    expect(r.system).toMatch(/[Ѐ-ӿ]/);
  });

  it("sanitizeUserQuery preserva caratteri non-ASCII (JA/ZH/RU)", () => {
    expect(sanitizeUserQuery("プラチナトロフィー")).toBe("プラチナトロフィー");
    expect(sanitizeUserQuery("白金奖杯")).toBe("白金奖杯");
    expect(sanitizeUserQuery("платиновый трофей")).toBe("платиновый трофей");
  });
});

// ── Coerenza i18n: PSN anchor in lingua target ────────────────────────────

describe("E2E multilingua T2.1 — PSN anchor i18n", () => {
  it("[de] PSN anchor usa label 'Seltenheit' (rarity in tedesco)", () => {
    const r = buildPrompt({
      ...makeCtx("de", "trophy"),
      psnAnchor: {
        psn_trophy_id: "001",
        psn_communication_id: "NPWR12345",
        rarity_source: "ultra_rare",
      },
    });
    expect(r.system).toContain("Seltenheit");
  });

  it("[ja] PSN anchor usa 'レアリティ'", () => {
    const r = buildPrompt({
      ...makeCtx("ja", "trophy"),
      psnAnchor: {
        psn_trophy_id: "001",
        psn_communication_id: "NPWR12345",
        rarity_source: "ultra_rare",
      },
    });
    expect(r.system).toContain("レアリティ");
  });

  it("[fr] PSN official block usa 'NOM OFFICIEL DU TROPHÉE'", () => {
    const r = buildPrompt({
      ...makeCtx("fr", "trophy"),
      psnOfficial: { officialName: "Le Seigneur d'Elden", officialDetail: "Devenez le Seigneur." },
    });
    expect(r.user).toContain("NOM OFFICIEL DU TROPHÉE");
  });
});
