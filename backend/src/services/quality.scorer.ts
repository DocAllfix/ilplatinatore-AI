import { logger } from "@/utils/logger.js";

/**
 * T4.1 — KF-6 Auto-quality scoring.
 *
 * Score 0-100 calcolato a partire dal content LLM + metadata di contesto.
 * 6 metriche pesate:
 *   - length          (15 pts) ≥ 200 char
 *   - headers         (20 pts) tutti gli header attesi presenti per guide_type
 *   - sources         (15 pts) ≥ 2 fonti (RAG verified prefer)
 *   - no_refusal      (15 pts) nessun pattern di "I don't have enough info"
 *   - psn_verified    (20 pts) zero unverified psn_trophy_id
 *   - sources_verified (15 pts) almeno 1 source con verified=true
 *
 * Threshold: score < 60 → `routeToHitl: true` (UI mostra warning + bozza HITL).
 *
 * Design: NON blocca la response. Esponiamo `qualityScore` + `routeToHitl`
 * nel meta — il frontend decide se mostrare la guida con un banner di warning
 * oppure rifiutarla. UX-first: blocco hard solo per content vuoto/errore.
 */

const QUALITY_THRESHOLD = 60;
const MIN_CONTENT_CHARS = 200;
const MIN_SOURCES = 2;

// Header attesi per guide_type — coerenti con prompt.builder.ts (template).
// Match flessibile: il LLM può scrivere "## Requisiti" oppure "**Requisiti**"
// in alcune lingue, quindi controlliamo solo la presenza della label H2/inline.
const REQUIRED_HEADERS_BY_TYPE: Record<string, RegExp[]> = {
  trophy: [
    /requirements|requisiti|requisitos|prérequis|voraussetzungen|要件|要求|требования/i,
    /steps|passaggi|pasos|étapes|schritte|手順|步骤|шаги/i,
    /tips|suggerimenti|consejos|conseils|tipps|ヒント|提示|советы/i,
    /sources|fonti|fuentes|sources|quellen|出典|来源|источники/i,
  ],
  walkthrough: [
    /overview|panoramica|resumen|aperçu|übersicht|概要|概述|обзор/i,
    /walkthrough|guida|guía|guide|攻略|prохождение/i,
    /sources|fonti|fuentes|sources|quellen|出典|来源|источники/i,
  ],
  collectible: [
    /total|totale|cantidad|nombre|gesamt|総数|总数|количество/i,
    /locations|posizioni|ubicaciones|emplacements|orte|場所|位置|локации/i,
    /sources|fonti|fuentes|sources|quellen|出典|来源|источники/i,
  ],
  challenge: [
    /objective|obiettivo|objetivo|objectif|ziel|目的|目标|цель/i,
    /strategy|strategia|estrategia|stratégie|strategie|戦略|策略|стратегия/i,
    /sources|fonti|fuentes|sources|quellen|出典|来源|источники/i,
  ],
  platinum: [
    /difficulty|difficoltà|dificultad|difficulté|schwierigkeit|難易度|难度|сложность/i,
    /phase 1|fase 1|フェーズ1|阶段1|фаза 1/i,
    /sources|fonti|fuentes|sources|quellen|出典|来源|источники/i,
  ],
};

// Pattern di refusal LLM — multilingua (ripreso da ingestion.service ma esteso).
const REFUSAL_PATTERNS = [
  /non ho informazioni sufficienti/i,
  /i don'?t have enough information/i,
  /no tengo (información|informacion) suficiente/i,
  /je n'?ai pas assez d'informations/i,
  /ich habe nicht genug informationen/i,
  /não tenho informações suficientes/i,
  /情報が(不足|十分でない|足りない)/,
  /没有足够的信息/,
  /у меня недостаточно информации/i,
];

export interface QualityBreakdown {
  metric: string;
  passed: boolean;
  weight: number;
  awarded: number;
  note?: string;
}

export interface QualityScoreResult {
  /** 0..100 (intero, sum delle award delle 6 metriche). */
  score: number;
  /** Breakdown per debugging/dashboard. */
  breakdown: QualityBreakdown[];
  /** True se score < 60 → frontend deve mostrare warning + draft HITL. */
  routeToHitl: boolean;
}

export interface QualityInputs {
  content: string;
  guideType: string;
  language: string;
  sources: Array<{ verified?: boolean }>;
  /** Da PSN cross-check T3.5 — se non vuoto, penalty massima. */
  unverifiedPsnIds?: string[];
}

export function scoreGuideContent(inputs: QualityInputs): QualityScoreResult {
  const breakdown: QualityBreakdown[] = [];

  // 1. Length
  const lengthOk = inputs.content.length >= MIN_CONTENT_CHARS;
  breakdown.push({
    metric: "length",
    passed: lengthOk,
    weight: 15,
    awarded: lengthOk ? 15 : 0,
    note: `${inputs.content.length} chars (min ${MIN_CONTENT_CHARS})`,
  });

  // 2. Required headers
  const requiredHeaders = REQUIRED_HEADERS_BY_TYPE[inputs.guideType] ?? [];
  const headersPresent = requiredHeaders.filter((re) => re.test(inputs.content)).length;
  const headersFraction = requiredHeaders.length > 0
    ? headersPresent / requiredHeaders.length
    : 1;
  const headersAward = Math.round(20 * headersFraction);
  breakdown.push({
    metric: "headers",
    passed: headersFraction === 1,
    weight: 20,
    awarded: headersAward,
    note: `${headersPresent}/${requiredHeaders.length} required headers detected`,
  });

  // 3. Number of sources
  const sourcesOk = inputs.sources.length >= MIN_SOURCES;
  breakdown.push({
    metric: "sources_count",
    passed: sourcesOk,
    weight: 15,
    awarded: sourcesOk ? 15 : Math.round((inputs.sources.length / MIN_SOURCES) * 15),
    note: `${inputs.sources.length} sources (min ${MIN_SOURCES})`,
  });

  // 4. No refusal pattern
  const hasRefusal = REFUSAL_PATTERNS.some((re) => re.test(inputs.content));
  breakdown.push({
    metric: "no_refusal",
    passed: !hasRefusal,
    weight: 15,
    awarded: hasRefusal ? 0 : 15,
    note: hasRefusal ? "LLM refusal pattern detected" : "no refusal",
  });

  // 5. PSN verified (no hallucinated ids)
  const unverifiedCount = inputs.unverifiedPsnIds?.length ?? 0;
  const psnPassed = unverifiedCount === 0;
  breakdown.push({
    metric: "psn_verified",
    passed: psnPassed,
    weight: 20,
    awarded: psnPassed ? 20 : 0,
    note: psnPassed ? "all PSN ids verified" : `${unverifiedCount} unverified PSN id(s)`,
  });

  // 6. Sources verified (at least one verified=true)
  const anyVerified = inputs.sources.some((s) => s.verified === true);
  breakdown.push({
    metric: "sources_verified",
    passed: anyVerified,
    weight: 15,
    awarded: anyVerified ? 15 : 0,
    note: anyVerified ? "≥1 verified source" : "no verified sources",
  });

  const score = breakdown.reduce((sum, b) => sum + b.awarded, 0);
  const result: QualityScoreResult = {
    score,
    breakdown,
    routeToHitl: score < QUALITY_THRESHOLD,
  };

  if (result.routeToHitl) {
    logger.info(
      { score, threshold: QUALITY_THRESHOLD, breakdown },
      "quality.scorer: score sotto soglia → routeToHitl",
    );
  }

  return result;
}

// Esposto per test
export const __quality = {
  QUALITY_THRESHOLD,
  MIN_CONTENT_CHARS,
  MIN_SOURCES,
};
