// Hook generazione guide con SSE streaming.
//
// Sprint 3+ updates:
//   - parsing strutturato eventi SSE: stage / disambiguation / meta / delta / done / error
//   - state esposti: stage (T3.4 fasi UI), disambiguation (T3.2 chip),
//     qualityScore + routeToHitl (T4.1), unverifiedPsnIds (T3.5),
//     draftId + canRevise (HITL Fase 23).
//
// API:
//   const { generate, guide, stage, disambiguation, meta, loading, error, rate } = useGuide();
//   await generate({ query, language?, explicitGameId? });
//
// Backward-compat: la signature è cambiata (oggetto invece di posizionale).
// Caller esistenti che chiamano `generateGuide(q, lang)` vanno aggiornati.

import { useCallback, useState } from "react";
import { api } from "@/api/client";

export function useGuide() {
  const [guide, setGuide] = useState("");
  const [stage, setStage] = useState(null); // { phase, detail }
  const [disambiguation, setDisambiguation] = useState(null); // { chosen, candidates[] }
  const [meta, setMeta] = useState(null); // {sourceUsed, gameDetected, ...}
  const [doneInfo, setDoneInfo] = useState(null); // {qualityScore, unverifiedPsnIds, draftId, ...}
  // Fase 25 On-Demand Live Harvesting: tracker eventi (started/completed/timeout/failed).
  const [onDemand, setOnDemand] = useState(null); // { phase, requestId, guideId?, message? }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const reset = useCallback(() => {
    setGuide("");
    setStage(null);
    setDisambiguation(null);
    setMeta(null);
    setDoneInfo(null);
    setOnDemand(null);
    setError(null);
  }, []);

  const generate = useCallback(async (params) => {
    if (typeof params === "string") {
      // Backward-compat con (query, language) posizionale.
      params = { query: params, language: arguments[1] };
    }
    reset();
    setLoading(true);
    try {
      await api.guideStream(
        {
          query: params.query,
          language: params.language ?? "it",
          ...(params.explicitGameId !== undefined && { explicitGameId: params.explicitGameId }),
        },
        {
          onEvent: ({ type, data }) => {
            switch (type) {
              case "stage":
                setStage(data);
                break;
              case "disambiguation":
                setDisambiguation(data);
                break;
              case "meta":
                setMeta((m) => ({ ...(m ?? {}), ...data }));
                break;
              case "delta":
                if (data?.text) setGuide((prev) => prev + data.text);
                break;
              case "done":
                setDoneInfo(data);
                break;
              case "ondemand":
                // Fase 25: started -> spinner; completed/timeout/failed -> toast finale.
                setOnDemand(data);
                break;
              case "error":
                setError(new Error(data?.message ?? "Errore stream"));
                break;
              default:
                break;
            }
          },
          onDone: () => setLoading(false),
        },
      );
    } catch (err) {
      setError(err);
      setLoading(false);
    }
  }, [reset]);

  // T3.2 — quando l'utente clicca un chip disambiguation, ri-genera la stessa
  // query con explicitGameId per bypassare l'extraction game.
  const pickGameCandidate = useCallback(
    async (gameId, originalQuery, language) => {
      await generate({ query: originalQuery, language, explicitGameId: gameId });
    },
    [generate],
  );

  const rate = useCallback(async (guideId, stars, suggestion) => {
    return api.post(`/api/guide/${encodeURIComponent(guideId)}/rating`, {
      stars,
      suggestion: suggestion?.trim() || undefined,
      language: "it",
    });
  }, []);

  // Derived state per UX semplificata.
  const qualityScore = doneInfo?.qualityScore ?? meta?.qualityScore ?? null;
  const routeToHitl = doneInfo?.routeToHitl ?? meta?.routeToHitl ?? false;
  const unverifiedPsnIds = doneInfo?.unverifiedPsnIds ?? meta?.unverifiedPsnIds ?? null;
  const draftId = doneInfo?.draftId ?? meta?.draftId ?? null;
  const canRevise = doneInfo?.canRevise ?? meta?.canRevise ?? false;
  const sourceUsed = meta?.sourceUsed ?? null;
  const gameDetected = meta?.gameDetected ?? null;
  const trophyDetected = meta?.trophyDetected ?? null;

  return {
    // streaming state
    guide,
    stage,
    disambiguation,
    meta,
    doneInfo,
    onDemand,
    loading,
    error,
    // derived (convenience)
    qualityScore,
    routeToHitl,
    unverifiedPsnIds,
    draftId,
    canRevise,
    sourceUsed,
    gameDetected,
    trophyDetected,
    // actions
    generate,
    pickGameCandidate,
    rate,
    reset,
    // legacy alias
    generateGuide: generate,
    rateGuide: rate,
  };
}
