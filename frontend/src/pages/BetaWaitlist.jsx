import React from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ShieldCheck, LogOut } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

export default function BetaWaitlist() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full bg-card border border-primary/20 rounded-2xl p-8 text-center"
      >
        <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
          <ShieldCheck className="w-7 h-7 text-primary" />
        </div>
        <h1 className="text-xl font-bold text-foreground mb-2">
          Beta closed
        </h1>
        <p className="text-sm text-muted-foreground mb-6">
          {user?.email
            ? `Ciao ${user.displayName || user.email}, il tuo account è registrato ma non hai ancora accesso alla beta privata. Ti contatteremo appena verrai abilitato.`
            : "L'accesso a Il Platinatore AI è attualmente in beta privata su invito."}
        </p>
        <div className="flex flex-col gap-2.5">
          <Link
            to="/landing"
            className="inline-block px-4 py-2.5 rounded-xl border border-primary/20 text-sm text-foreground hover:bg-primary/10 transition-colors"
          >
            Torna alla landing
          </Link>
          {user && (
            <button
              onClick={logout}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Esci
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
