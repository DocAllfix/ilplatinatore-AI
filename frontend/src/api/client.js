// Client HTTP — Il Platinatore AI
//
// AUDIT FIX FF-NEW-1 — token policy (VINCOLANTE):
// - access token (JWT 1h): SOLO in memoria di questo modulo
// - refresh token (JWT 7gg): SOLO cookie HttpOnly+Secure+SameSite=Strict settato dal backend
// - csrf token (HMAC firmato): SOLO in memoria di questo modulo
//
// VIETATO: localStorage.*/sessionStorage.* per uno qualunque dei tre token.
// Violare questa regola reintroduce il Fatal Flaw: XSS -> exfiltration.
//
// Flusso dopo reload: access perso in memoria, il cookie HttpOnly del refresh sopravvive.
// Al mount useAuth chiama doRefresh() -> nuovo access token ricreato in RAM.

const API_BASE = import.meta.env.VITE_API_URL || "";

let accessToken = null;
let csrfToken = null;

export function setAuthTokens({ access, csrf }) {
  accessToken = access ?? null;
  csrfToken = csrf ?? null;
}

export function clearAuthTokens() {
  accessToken = null;
  csrfToken = null;
}

export function hasAccessToken() {
  return accessToken !== null;
}

// Deduplica refresh concorrenti: più 401 in volo condividono la stessa promise.
let refreshInFlight = null;

export async function doRefresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        clearAuthTokens();
        return false;
      }
      const { accessToken: newAccess, csrfToken: newCsrf } = await res.json();
      setAuthTokens({ access: newAccess, csrf: newCsrf });
      return true;
    } catch {
      clearAuthTokens();
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const method = (options.method || "GET").toUpperCase();
  const isMutating = MUTATING.has(method);

  const config = {
    ...options,
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  };

  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  // AUDIT FIX R2: CSRF HMAC firmato solo su mutating methods.
  if (isMutating && csrfToken) config.headers["X-CSRF-Token"] = csrfToken;

  let response = await fetch(url, config);

  // 401 -> refresh dedup, poi retry UNA sola volta.
  if (response.status === 401 && accessToken) {
    const ok = await doRefresh();
    if (ok) {
      config.headers.Authorization = `Bearer ${accessToken}`;
      if (isMutating) config.headers["X-CSRF-Token"] = csrfToken;
      response = await fetch(url, config);
    }
  }

  return response;
}

async function parseOrThrow(response) {
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status}`);
    err.status = response.status;
    try {
      err.data = await response.json();
    } catch {
      err.data = null;
    }
    throw err;
  }
  if (response.status === 204) return null;
  const ct = response.headers.get("content-type") || "";
  return ct.includes("application/json") ? response.json() : response.text();
}

export const api = {
  get: (endpoint) => request(endpoint).then(parseOrThrow),

  post: (endpoint, body) =>
    request(endpoint, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(parseOrThrow),

  put: (endpoint, body) =>
    request(endpoint, {
      method: "PUT",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(parseOrThrow),

  patch: (endpoint, body) =>
    request(endpoint, {
      method: "PATCH",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(parseOrThrow),

  delete: (endpoint) => request(endpoint, { method: "DELETE" }).then(parseOrThrow),

  // SSE streaming: fetch con ReadableStream, UN refresh al massimo su 401 pre-stream.
  guideStream: async (query, language, onChunk, onDone) => {
    const open = async () => {
      const headers = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
      return fetch(`${API_BASE}/api/guide/stream`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ query, language }),
      });
    };

    let res = await open();
    if (res.status === 401 && accessToken) {
      const ok = await doRefresh();
      if (ok) res = await open();
    }
    if (!res.ok || !res.body) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      try {
        err.data = await res.json();
      } catch {
        err.data = null;
      }
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) onChunk(chunk);
      }
      const tail = decoder.decode();
      if (tail) onChunk(tail);
    } finally {
      reader.releaseLock();
    }
    onDone?.();
  },
};
