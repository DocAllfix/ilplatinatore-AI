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

  // Multipart POST (file upload). NON aggiunge Content-Type: il browser
  // lo setta automaticamente con il boundary corretto.
  postMultipart: async (endpoint, formData) => {
    const url = `${API_BASE}${endpoint}`;
    const send = async () => {
      const headers = {};
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
      return fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: formData,
      });
    };
    let response = await send();
    if (response.status === 401 && accessToken) {
      const ok = await doRefresh();
      if (ok) response = await send();
    }
    return parseOrThrow(response);
  },

  // SSE streaming Sprint 3+ (T3.4 stage events + T3.2 disambiguation):
  //
  // Signature ESTESA — accetta sia legacy (onChunk con raw text) che strutturata:
  //   guideStream({query, language, explicitGameId?}, {
  //     onEvent: ({type, data}) => void,  // 'stage'|'disambiguation'|'meta'|'delta'|'done'|'error'
  //     onDone:  () => void,
  //     onChunk?: (text) => void,         // legacy fallback: chiamato solo per delta
  //   })
  //
  // Backward-compat: se invocato con (query, language, onChunk, onDone) — vecchio stile —
  // funziona ancora: ogni delta evento → onChunk(text), altri eventi ignorati.
  guideStream: async (...args) => {
    let params, callbacks;
    if (typeof args[0] === "string") {
      // Legacy signature: (query, language, onChunk, onDone)
      params = { query: args[0], language: args[1] };
      callbacks = {
        onChunk: args[2],
        onDone: args[3],
        onEvent: null,
      };
    } else {
      // New signature: ({query, language, ...}, {onEvent, onDone, onChunk?})
      params = args[0];
      callbacks = args[1] ?? {};
    }

    const open = async () => {
      const headers = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
      const body = {
        query: params.query,
        ...(params.language && { language: params.language }),
        ...(params.explicitGameId !== undefined && { explicitGameId: params.explicitGameId }),
      };
      return fetch(`${API_BASE}/api/guide/stream`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body),
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

    // Parser SSE: buffer accumulator + split su "\n\n" (record separator).
    // Ogni record contiene linee tipo "event: X" + "data: <json>". Default
    // event type quando assente è "message".
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const dispatch = (rawRecord) => {
      const lines = rawRecord.split("\n");
      let eventType = "message";
      let dataStr = "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataStr += (dataStr ? "\n" : "") + line.slice(5).trim();
        }
      }
      if (!dataStr) return;
      let data;
      try {
        data = JSON.parse(dataStr);
      } catch {
        // Non-JSON data: passa raw string (fallback)
        data = dataStr;
      }
      // Strutturato: chiama onEvent
      if (callbacks.onEvent) callbacks.onEvent({ type: eventType, data });
      // Legacy: chiama onChunk solo per delta (text aggregation backward-compat)
      if (callbacks.onChunk && eventType === "delta" && data?.text) {
        callbacks.onChunk(data.text);
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const record = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (record.trim()) dispatch(record);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) dispatch(buffer);
    } finally {
      reader.releaseLock();
    }
    callbacks.onDone?.();
  },
};
