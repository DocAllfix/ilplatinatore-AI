// Hook generazione guide con SSE streaming.
//
// - generateGuide(query, language): streaming via api.guideStream, aggiorna
//   progressivamente la markdown della guida.
// - rateGuide(guideId, stars, suggestion): POST /api/guide/:id/rating
//   (client.js inserisce X-CSRF-Token automaticamente sui mutating methods).

import { useCallback, useState } from "react";
import { api } from "@/api/client";

export function useGuide() {
  const [guide, setGuide] = useState("");
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState(null);
  const [confidence, setConfidence] = useState(null);
  const [error, setError] = useState(null);

  const generateGuide = useCallback(async (query, language = "it") => {
    setGuide("");
    setSource(null);
    setConfidence(null);
    setError(null);
    setLoading(true);
    try {
      await api.guideStream(
        query,
        language,
        (chunk) => {
          // Metadata SSE opzionali (source/confidence) TODO: cablaggio reale con
          // contratto backend Fase 22. Per ora trattiamo tutto come testo markdown.
          setGuide((prev) => prev + chunk);
        },
        () => {
          setLoading(false);
        },
      );
    } catch (err) {
      setError(err);
      setLoading(false);
    }
  }, []);

  const rateGuide = useCallback(async (guideId, stars, suggestion) => {
    return api.post(`/api/guide/${encodeURIComponent(guideId)}/rating`, {
      stars,
      suggestion: suggestion?.trim() || undefined,
      language: "it",
    });
  }, []);

  return {
    guide,
    loading,
    source,
    confidence,
    error,
    generateGuide,
    rateGuide,
  };
}
