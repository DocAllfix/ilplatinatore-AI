import React from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

/**
 * B5 — Beta gating UI.
 *
 * Logica:
 *   - Anonymous (!user)          → lascia passare (Landing/Login decideranno).
 *   - Authenticated && betaAccess → lascia passare alle route protette.
 *   - Authenticated && !betaAccess → redirect /beta-waitlist.
 *
 * Specchio del middleware backend `requireBetaAccess`. Se backend ha
 * `BETA_GATING_ENABLED=false`, ogni utente passa anche senza beta_access
 * (perché backend non emette 403). Per testare in dev: settare manualmente
 * `users.beta_access=true` per il proprio account o lasciare gating disabilitato.
 */
export default function BetaGate() {
  const { user, isLoadingAuth } = useAuth();

  if (isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  // Anonymous: lascia passare. La singola route può applicare ProtectedRoute
  // se richiede auth.
  if (!user) {
    return <Outlet />;
  }

  // Authenticated ma non whitelistato → waitlist.
  if (user.betaAccess === false) {
    return <Navigate to="/beta-waitlist" replace />;
  }

  // betaAccess === true (o undefined per backward-compat con backend pre-mig 031)
  return <Outlet />;
}
