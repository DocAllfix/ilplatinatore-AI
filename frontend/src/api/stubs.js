// Stub layer per endpoint non ancora cablati nel backend.
//
// Questo file e' TEMPORANEO (Fase 21.x): contiene chiamate a endpoint che non
// esistono ancora lato server. Ogni funzione logga un warn esplicito cosi' il
// debito e' visibile in console; quando l'endpoint verra' implementato, basta
// sostituire il corpo con una chiamata api.get/post/patch/put.
//
// Endpoint REALI disponibili (via @/api/client direttamente, NON qui):
// - POST /api/auth/{login,register,logout,refresh}
// - GET  /api/auth/me
// - POST /api/guide/:guideId/rating
//
// Endpoint MANCANTI (serviti da questo file):
// - PATCH /api/auth/me                -> patchMe()
// - GET/POST/PATCH /api/game-stats    -> gameStats
// - GET /api/guide-ratings            -> listGuideRatings()
// - POST /api/uploads/avatar          -> uploadAvatar()

import { api } from "./client";

function warn(op) {
  // eslint-disable-next-line no-console
  console.warn(`[api-stub] ${op} — endpoint backend non ancora cablato (Fase 21.x)`);
}

export async function patchMe(payload) {
  warn("PATCH /api/auth/me");
  return payload;
}

export async function uploadAvatar({ file }) {
  warn("POST /api/uploads/avatar");
  return { file_url: URL.createObjectURL(file) };
}

export async function listGuideRatings(..._args) {
  warn("GET /api/guide-ratings");
  return [];
}

// Rating creation e' REALE quando c'e' guideId (endpoint /api/guide/:id/rating
// esiste nel backend). Se il chiamante non passa guideId -> stub.
export async function createGuideRating(payload) {
  if (payload?.guideId) {
    const { guideId, ...body } = payload;
    return api.post(`/api/guide/${encodeURIComponent(guideId)}/rating`, body);
  }
  warn("createGuideRating senza guideId");
  return { id: `stub-${Date.now()}`, ...payload };
}

export const gameStats = {
  filter: async (..._args) => {
    warn("GET /api/game-stats (filter)");
    return [];
  },
  create: async (data) => {
    warn("POST /api/game-stats");
    return { id: `stub-${Date.now()}`, ...data };
  },
  update: async (id, data) => {
    warn("PATCH /api/game-stats/:id");
    return { id, ...data };
  },
};
