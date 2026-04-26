import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { LogIn, User, LogOut, Settings } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

export default function ProfileButton() {
  const { user, loading, logout, navigateToLogin } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  if (loading) return null;

  if (!user) {
    return (
      <button
        onClick={() => navigateToLogin(window.location.href)}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
      >
        <LogIn className="w-3.5 h-3.5" />
        Accedi
      </button>
    );
  }

  const displayName = user.displayName || user.full_name || "Cacciatore";
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-8 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-primary hover:bg-primary/30 transition-all"
        title={displayName}
      >
        <span className="text-xs font-bold">{initial}</span>
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            className="absolute right-0 top-10 w-56 bg-card border border-border rounded-xl shadow-xl z-50 overflow-hidden"
          >
            {/* User info */}
            <div className="px-4 py-3 border-b border-border flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-primary shrink-0">
                <span className="text-sm font-bold">{initial}</span>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{displayName}</p>
                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
              </div>
            </div>

            {/* Actions */}
            <div className="py-1">
              <Link
                to="/impostazioni"
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
              >
                <Settings className="w-4 h-4 text-muted-foreground" />
                Impostazioni profilo
              </Link>
              <button
                onClick={async () => { await logout(); window.location.href = "/"; }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Esci
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}