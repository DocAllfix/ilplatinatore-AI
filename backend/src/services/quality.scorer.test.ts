import { describe, it, expect, vi } from "vitest";

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { scoreGuideContent, __quality, type QualityInputs } from "./quality.scorer.js";

const longContent = `## Requirements
You need to be at level 50.

## Steps
1. Talk to the NPC.
2. Defeat the boss.
3. Collect the reward.

## Tips
- Bring potions.
- Use heavy attacks.

## Sources
[1] PowerPyx — verified guide.`.repeat(3);

function makeInputs(overrides: Partial<QualityInputs> = {}): QualityInputs {
  return {
    content: longContent,
    guideType: "trophy",
    language: "en",
    sources: [
      { verified: true },
      { verified: false },
    ],
    ...overrides,
  };
}

// ── Score perfect path ──────────────────────────────────────────────────

describe("scoreGuideContent — happy path (score≥60)", () => {
  it("guida completa trophy → score=100, no routeToHitl", () => {
    const r = scoreGuideContent(makeInputs());
    expect(r.score).toBe(100);
    expect(r.routeToHitl).toBe(false);
    expect(r.breakdown).toHaveLength(6);
    expect(r.breakdown.every((b) => b.passed)).toBe(true);
  });

  it("4 metriche su 6 ok → score ~70, no routeToHitl", () => {
    const r = scoreGuideContent({
      ...makeInputs(),
      sources: [{ verified: false }], // sources_count fail (1<2), sources_verified fail
    });
    // length(15) + headers(20) + sources_count(7-ish parziale) + no_refusal(15) +
    // psn_verified(20) = 77, + sources_verified(0) = 77
    expect(r.score).toBeGreaterThanOrEqual(__quality.QUALITY_THRESHOLD);
  });
});

// ── Singole metriche ────────────────────────────────────────────────────

describe("scoreGuideContent — metriche individuali", () => {
  it("length: penalizza content < 200 char", () => {
    const r = scoreGuideContent({ ...makeInputs(), content: "## Steps\nstep 1" });
    const m = r.breakdown.find((b) => b.metric === "length")!;
    expect(m.passed).toBe(false);
    expect(m.awarded).toBe(0);
  });

  it("headers: parziale → fraction-based award", () => {
    // Solo "## Requirements", manca Steps/Tips/Sources
    const r = scoreGuideContent({
      ...makeInputs(),
      content: `## Requirements\n${"x".repeat(300)}`,
    });
    const m = r.breakdown.find((b) => b.metric === "headers")!;
    expect(m.passed).toBe(false);
    // 1/4 headers → 5 punti (round(20*0.25))
    expect(m.awarded).toBe(5);
  });

  it("headers: dispatch per guide_type=walkthrough", () => {
    const r = scoreGuideContent({
      ...makeInputs(),
      guideType: "walkthrough",
      content: `## Overview\n${"x".repeat(150)}\n## Walkthrough\nsteps...\n## Sources\n[1]`,
    });
    const m = r.breakdown.find((b) => b.metric === "headers")!;
    expect(m.passed).toBe(true);
  });

  it("headers: multilingua — stesso content in giapponese passa", () => {
    const r = scoreGuideContent({
      ...makeInputs(),
      language: "ja",
      content: `## 要件\n要件 dettagli.\n## 手順\n1. fai questo.\n## ヒント\nconsigli.\n## 出典\n[1] fonte ${"x".repeat(150)}`,
    });
    const m = r.breakdown.find((b) => b.metric === "headers")!;
    expect(m.passed).toBe(true);
  });

  it("sources_count: ≥2 → 15, =1 → fraction, =0 → 0", () => {
    const r0 = scoreGuideContent({ ...makeInputs(), sources: [] });
    const r1 = scoreGuideContent({ ...makeInputs(), sources: [{ verified: false }] });
    const r2 = scoreGuideContent({ ...makeInputs(), sources: [{ verified: false }, { verified: false }] });

    expect(r0.breakdown.find((b) => b.metric === "sources_count")!.awarded).toBe(0);
    expect(r1.breakdown.find((b) => b.metric === "sources_count")!.awarded).toBe(8); // round(15/2)
    expect(r2.breakdown.find((b) => b.metric === "sources_count")!.awarded).toBe(15);
  });

  it("no_refusal: pattern italiano scattante → fail", () => {
    const r = scoreGuideContent({
      ...makeInputs(),
      content: `## Requirements\n${"x".repeat(200)}\nNon ho informazioni sufficienti per questa guida.`,
    });
    const m = r.breakdown.find((b) => b.metric === "no_refusal")!;
    expect(m.passed).toBe(false);
    expect(m.awarded).toBe(0);
  });

  it("no_refusal: pattern inglese scattante → fail", () => {
    const r = scoreGuideContent({
      ...makeInputs(),
      content: `## Requirements\n${"x".repeat(200)}\nI don't have enough information for this guide.`,
    });
    expect(r.breakdown.find((b) => b.metric === "no_refusal")!.passed).toBe(false);
  });

  it("no_refusal: pattern multilingua (de/ja/zh/ru) tutti rilevati", () => {
    const cases = [
      "Ich habe nicht genug informationen für diese Anleitung.",
      "情報が不足しています。",
      "没有足够的信息。",
      "У меня недостаточно информации.",
    ];
    for (const c of cases) {
      const r = scoreGuideContent({ ...makeInputs(), content: `${"x".repeat(200)}\n${c}` });
      expect(r.breakdown.find((b) => b.metric === "no_refusal")!.passed).toBe(false);
    }
  });

  it("psn_verified: unverifiedPsnIds vuoto → 20, presente → 0", () => {
    const ok = scoreGuideContent(makeInputs());
    const ko = scoreGuideContent({ ...makeInputs(), unverifiedPsnIds: ["fake_id_1", "fake_id_2"] });

    expect(ok.breakdown.find((b) => b.metric === "psn_verified")!.awarded).toBe(20);
    expect(ko.breakdown.find((b) => b.metric === "psn_verified")!.awarded).toBe(0);
  });

  it("sources_verified: nessuna verified=true → 0", () => {
    const r = scoreGuideContent({
      ...makeInputs(),
      sources: [{ verified: false }, { verified: false }],
    });
    expect(r.breakdown.find((b) => b.metric === "sources_verified")!.passed).toBe(false);
  });
});

// ── routeToHitl threshold ──────────────────────────────────────────────

describe("scoreGuideContent — routeToHitl threshold", () => {
  it("score < 60 → routeToHitl=true", () => {
    // Content corto + no sources + refusal + PSN unverified = score molto basso
    const r = scoreGuideContent({
      content: "Non ho informazioni sufficienti.",
      guideType: "trophy",
      language: "it",
      sources: [],
      unverifiedPsnIds: ["fake_id"],
    });
    expect(r.score).toBeLessThan(__quality.QUALITY_THRESHOLD);
    expect(r.routeToHitl).toBe(true);
  });

  it("score esattamente 60 → routeToHitl=false (boundary inclusivo)", () => {
    // Costruisco un caso a 60 esatti: length(15)+headers(0)+sources(15)+no_refusal(15)+psn(0)+sources_verified(15)
    // = length OK, NO headers, sources≥2, no refusal, PSN issues, ≥1 verified
    const r = scoreGuideContent({
      content: `${"x".repeat(250)} no headers here just text for length`,
      guideType: "trophy",
      language: "en",
      sources: [{ verified: true }, { verified: false }],
      unverifiedPsnIds: ["fake_id"],
    });
    // length(15) + headers(0) + sources_count(15) + no_refusal(15) + psn(0) + sources_verified(15) = 60
    expect(r.score).toBe(60);
    expect(r.routeToHitl).toBe(false);
  });
});

// ── Robustness ──────────────────────────────────────────────────────────

describe("scoreGuideContent — edge cases", () => {
  it("content vuoto + no sources → score basso e routeToHitl=true", () => {
    const r = scoreGuideContent({
      content: "",
      guideType: "trophy",
      language: "en",
      sources: [],
    });
    // Note: content vuoto NON matcha refusal pattern (default "passed") e
    // unverifiedPsnIds undefined = passed → ~35 punti residui. Comunque
    // < 60 quindi routeToHitl=true correttamente.
    expect(r.score).toBeLessThan(__quality.QUALITY_THRESHOLD);
    expect(r.routeToHitl).toBe(true);
    expect(r.breakdown.find((b) => b.metric === "length")!.passed).toBe(false);
    expect(r.breakdown.find((b) => b.metric === "sources_count")!.passed).toBe(false);
  });

  it("guide_type sconosciuto → headers fraction=1 (no headers required)", () => {
    const r = scoreGuideContent({
      content: longContent,
      guideType: "unknown_type",
      language: "en",
      sources: [{ verified: true }, { verified: true }],
    });
    expect(r.breakdown.find((b) => b.metric === "headers")!.awarded).toBe(20);
    expect(r.score).toBe(100);
  });

  it("breakdown contiene sempre 6 metriche con weight definito", () => {
    const r = scoreGuideContent(makeInputs());
    expect(r.breakdown).toHaveLength(6);
    const totalWeight = r.breakdown.reduce((s, b) => s + b.weight, 0);
    expect(totalWeight).toBe(100);
  });
});
