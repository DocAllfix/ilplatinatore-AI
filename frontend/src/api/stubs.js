// Cabling layer per endpoint backend reali (post-Sprint 4).
//
// Tutti gli endpoint elencati sono ora cablati al backend (precedentemente
// erano stub locali console.warn). Il file mantiene il nome `stubs.js` per
// backward-compat con i caller, ma il contenuto è REAL implementation.
//
// Endpoint cablati:
// - PATCH /api/auth/me              → patchMe()           [Sprint 1 T1.4]
// - POST /api/uploads/avatar        → uploadAvatar()      [Fase 21 B1, multipart]
// - GET /api/guide-ratings          → listGuideRatings()  [Fase 21 A5]
// - GET/POST/PATCH /api/game-stats  → gameStats           [Fase 21 B2]
// - POST /api/guide/:id/rating      → createGuideRating() [Fase 17, già reale]

import { api } from "./client";

/**
 * PATCH /api/auth/me — aggiorna profilo utente.
 * Backend Zod schema strict: accetta SOLO {displayName?, language?}.
 * Filtriamo qui per evitare 400 da campi extra (email/tier/avatar gestiti altrove).
 */
export async function patchMe(payload) {
  const body = {};
  if (payload?.displayName !== undefined) body.displayName = payload.displayName;
  if (payload?.language !== undefined) body.language = payload.language;
  // Niente da aggiornare → no-op (backend ritornerebbe 400 su body vuoto post-strict).
  if (Object.keys(body).length === 0) return null;
  return api.patch("/api/auth/me", body);
}

/**
 * POST /api/uploads/avatar — upload avatar multipart/form-data.
 * Backend valida magic bytes PNG/JPG/WEBP server-side + cleanup file orfani.
 * Ritorna shape compatibile con il vecchio stub (file_url) per non rompere
 * i caller esistenti — il backend espone {data: {avatarUrl: "..."}}, qui rimappiamo.
 */
export async function uploadAvatar({ file }) {
  if (!file) throw new Error("uploadAvatar: file richiesto");
  const fd = new FormData();
  fd.append("avatar", file);
  const res = await api.postMultipart("/api/uploads/avatar", fd);
  // res = {data: {avatarUrl: "/uploads/avatars/123-...png"}}
  const url = res?.data?.avatarUrl ?? null;
  return { file_url: url, avatarUrl: url };
}

/**
 * GET /api/guide-ratings — lista ratings dell'utente loggato.
 * Backend ritorna {data: [...], meta: {limit, offset, total}}.
 * I caller storici si aspettano un array → unwrap.
 */
export async function listGuideRatings(params = {}) {
  const qs = new URLSearchParams();
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  try {
    const res = await api.get(`/api/guide-ratings${suffix}`);
    return res?.data ?? [];
  } catch (err) {
    if (err?.status === 401) return []; // anonymous → nessun rating
    throw err;
  }
}

// Rating creation REALE (cablato in Fase 17 — invariato).
export async function createGuideRating(payload) {
  if (payload?.guideId) {
    const { guideId, ...body } = payload;
    return api.post(`/api/guide/${encodeURIComponent(guideId)}/rating`, body);
  }
  throw new Error("createGuideRating: guideId richiesto");
}

/**
 * GET/POST/PATCH /api/game-stats — CRUD stats utente per gioco.
 * Backend richiede auth + IDOR check via WHERE user_id su PATCH.
 *
 * filter({gameSlug}): ritorna array (max 1 elemento per UNIQUE constraint).
 * create(data):       POST con gameSlug+gameName + numeri stats.
 * update(id, data):   PATCH con campi parziali (Zod strict).
 */
export const gameStats = {
  filter: async (params = {}) => {
    const qs = new URLSearchParams();
    if (params.gameSlug) qs.set("gameSlug", params.gameSlug);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    try {
      const res = await api.get(`/api/game-stats${suffix}`);
      return res?.data ?? [];
    } catch (err) {
      if (err?.status === 401) return []; // anonymous → no stats
      throw err;
    }
  },

  create: async (data) => {
    const res = await api.post("/api/game-stats", data);
    return res?.data ?? null;
  },

  update: async (id, data) => {
    if (!id) throw new Error("gameStats.update: id richiesto");
    const res = await api.patch(`/api/game-stats/${encodeURIComponent(id)}`, data);
    return res?.data ?? null;
  },
};
