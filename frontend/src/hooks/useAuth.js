// Auth state per Il Platinatore AI.
//
// AUDIT FIX FF-NEW-1: nessun accesso a localStorage/sessionStorage.
// Al mount: doRefresh() per ricostruire l'access token dal cookie HttpOnly del refresh.
// Se il cookie e' valido -> GET /api/auth/me -> stato autenticato.
// Se non lo e' -> stato anonimo.
//
// File in .js (no JSX) per rispettare il contratto; il Provider usa React.createElement.

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  api,
  clearAuthTokens,
  doRefresh,
  setAuthTokens,
} from "@/api/client";

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const login = useCallback(async (email, password) => {
    setError(null);
    const data = await api.post("/api/auth/login", { email, password });
    setAuthTokens({ access: data.accessToken, csrf: data.csrfToken });
    setUser(data.user ?? null);
    return data.user ?? null;
  }, []);

  const register = useCallback(async (email, password, name) => {
    setError(null);
    const data = await api.post("/api/auth/register", {
      email,
      password,
      displayName: name,
    });
    setAuthTokens({ access: data.accessToken, csrf: data.csrfToken });
    setUser(data.user ?? null);
    return data.user ?? null;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/api/auth/logout");
    } catch {
      // best-effort: se il backend fallisce svuotiamo comunque la memoria locale
    }
    clearAuthTokens();
    setUser(null);
  }, []);

  const refreshAuth = useCallback(async () => {
    const ok = await doRefresh();
    if (!ok) {
      setUser(null);
      return false;
    }
    try {
      const me = await api.get("/api/auth/me");
      setUser(me);
      return true;
    } catch {
      setUser(null);
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ok = await doRefresh();
        if (cancelled) return;
        if (ok) {
          try {
            const me = await api.get("/api/auth/me");
            if (!cancelled) setUser(me);
          } catch (err) {
            if (!cancelled) {
              setUser(null);
              if (err?.status && err.status !== 401 && err.status !== 403) {
                setError(err);
              }
            }
          }
        } else {
          setUser(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setUser(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Alias semantici per chi legge lo stato con naming legacy (App.jsx, ProtectedRoute.jsx):
  // solo rinomine di `loading`, `error`, etc. `navigateToLogin` e' utility per mandare
  // l'anonimo al landing.
  const navigateToLogin = useCallback((_fromUrl) => {
    if (typeof window !== "undefined") window.location.href = "/landing";
  }, []);

  const value = {
    user,
    loading,
    error,
    login,
    register,
    logout,
    refreshAuth,
    // backward-compat aliases
    isLoadingAuth: loading,
    isAuthenticated: user !== null,
    authChecked: !loading,
    authError: error,
    checkUserAuth: refreshAuth,
    navigateToLogin,
    isLoadingPublicSettings: false,
  };

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth deve essere usato dentro <AuthProvider>");
  }
  return ctx;
}
